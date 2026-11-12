//! The check that a deck is an honest shuffle of the deck before it: the same cards in another order, each
//! re-encrypted under the table key. The seat proves it without showing the order or its randomness, and the contract
//! takes no deck whose proof fails, so a seat cannot put a deck on the table that it can read.
//!
//! This is the verifier of the Terelius-Wikström proof of a shuffle as the CHVote specification gives it
//! (CheckShuffleProof), made non-interactive with sha256, over BN254 G1 written additively. For input cards
//! (a_j, b_j) = (C2, C1), output cards (a'_i, b'_i), the table key PK, the generator G and 53 more generators h,
//! h_0..h_51 that nobody knows a relation between, the proof is
//!
//!   c (52 points) ‖ ĉ (52 points) ‖ x ‖ s1 ‖ s2 ‖ s3 ‖ s4 ‖ ŝ (52 scalars) ‖ s̃ (52 scalars)
//!
//! and with seed = H(PK, input, output, c), u_j = H(seed, j), ĉ_(-1) = h, the verifier computes
//!
//!   t1  = s1·G − x·(Σ c_j − Σ h_i)
//!   t2  = s2·G − x·(ĉ_51 − (Π u_j)·h)
//!   t3  = s3·G + Σ s̃_i·h_i − x·Σ u_j·c_j
//!   t41 = Σ s̃_i·a'_i − s4·PK − x·Σ u_j·a_j
//!   t42 = Σ s̃_i·b'_i − s4·G  − x·Σ u_j·b_j
//!   t̂_i = ŝ_i·G + s̃_i·ĉ_(i-1) − x·ĉ_i
//!
//! and accepts when x = H(seed, ĉ, t1, t2, t3, t41, t42, t̂_0..t̂_51). The first two lines and the last show that c
//! commits to a permutation; the third ties s̃ to that permutation; the fourth and fifth show that the output is the
//! input permuted that way and re-encrypted under PK.
//!
//! The generators are hashed to the curve from fixed text (games/poker/shuffle.ts makes `generators.bin`; a test here
//! checks every x against the hash), so no one, the deployer included, knows a relation between them.

use near_sdk::env;

use crate::curve::{challenge, generator, mul, sum, POINT, SCALAR};
use crate::{fr, CARD_BYTES, DECK};

pub const PROOF_BYTES: usize = 2 * DECK * POINT + 5 * SCALAR + 2 * DECK * SCALAR;

/// h, then h_0..h_51.
pub static GENERATORS: &[u8] = include_bytes!("generators.bin");

fn at(bytes: &[u8], index: usize, size: usize) -> &[u8] {
    &bytes[index * size..(index + 1) * size]
}

/// Σ scalar·point over the terms.
fn combine(terms: &[(&[u8], &[u8])]) -> Vec<u8> {
    let mut input = Vec::with_capacity(terms.len() * (POINT + SCALAR));
    for (point, scalar) in terms {
        input.extend_from_slice(point);
        input.extend_from_slice(scalar);
    }
    env::alt_bn128_g1_multiexp(input)
}

fn negative(point: &[u8]) -> Vec<u8> {
    sum(&[(true, point)])
}

/// Two terms, then the i-th of `points` times the i-th of `scalars`.
fn combine_with<'a>(first: (&'a [u8], &'a [u8]), second: (&'a [u8], &'a [u8]), points: impl Iterator<Item = &'a [u8]>, scalars: &'a [u8]) -> Vec<u8> {
    let mut terms = vec![first, second];
    terms.extend(points.enumerate().map(|(i, point)| (point, at(scalars, i, SCALAR))));
    combine(&terms)
}

/// Whether `proof` shows that `after` is a shuffle of `before` under `key`. `before` and `after` are decks of 52 cards
/// (C1 ‖ C2 each) and `proof` is [`PROOF_BYTES`] long; the caller checks the lengths. Bytes that are not points of
/// the curve, or scalars not below the group order, fail the call in the host functions.
pub fn holds(key: &[u8], before: &[u8], after: &[u8], proof: &[u8]) -> bool {
    let (seed, announcements) = recomputed(key, before, after, proof);
    let chain = &proof[DECK * POINT..2 * DECK * POINT];
    let x = &proof[2 * DECK * POINT..][..SCALAR];
    challenge(&[b"deedlords-poker/shuffle/proof", &seed, chain, &announcements])[..] == *x
}

/// The seed, and the announcements the proof's answers lead back to: t1, t2, t3, t41, t42, then t̂_0..t̂_51.
pub fn recomputed(key: &[u8], before: &[u8], after: &[u8], proof: &[u8]) -> ([u8; SCALAR], Vec<u8>) {
    let (c, rest) = proof.split_at(DECK * POINT);
    let (chain, rest) = rest.split_at(DECK * POINT);
    let (x, rest) = rest.split_at(SCALAR);
    let (s, rest) = rest.split_at(4 * SCALAR);
    let (s_hat, s_tilde) = rest.split_at(DECK * SCALAR);
    let (h, hs) = GENERATORS.split_at(POINT);
    let g = generator();

    let seed = env::sha256_array([b"deedlords-poker/shuffle", key, before, after, c].concat());
    let u: Vec<[u8; SCALAR]> = (0..DECK).map(|j| challenge(&[b"deedlords-poker/shuffle/u", &seed, &[j as u8]])).collect();

    // Σ c_j − Σ h_i
    let mut terms: Vec<(bool, &[u8])> = (0..DECK).map(|j| (false, at(c, j, POINT))).collect();
    terms.extend((0..DECK).map(|i| (true, at(hs, i, POINT))));
    let c_bar = sum(&terms);
    // ĉ_51 − (Π u_j)·h
    let product = u.iter().fold(fr::ONE, |product, u| fr::mul(&product, &fr::from_bytes(u)));
    let c_hat = sum(&[(false, at(chain, DECK - 1, POINT)), (true, &mul(h, &fr::to_bytes(&product)))]);
    // Σ u_j·c_j, Σ u_j·a_j, Σ u_j·b_j
    let c_tilde = combine(&(0..DECK).map(|j| (at(c, j, POINT), &u[j][..])).collect::<Vec<_>>());
    let a = combine(&(0..DECK).map(|j| (&at(before, j, CARD_BYTES)[POINT..], &u[j][..])).collect::<Vec<_>>());
    let b = combine(&(0..DECK).map(|j| (&at(before, j, CARD_BYTES)[..POINT], &u[j][..])).collect::<Vec<_>>());

    let (c_bar, c_hat, c_tilde, a, b) = (negative(&c_bar), negative(&c_hat), negative(&c_tilde), negative(&a), negative(&b));
    let (key_negative, g_negative) = (negative(key), negative(&g));
    let (s1, s2, s3, s4) = (at(s, 0, SCALAR), at(s, 1, SCALAR), at(s, 2, SCALAR), at(s, 3, SCALAR));
    let t1 = combine(&[(&c_bar, x), (&g, s1)]);
    let t2 = combine(&[(&c_hat, x), (&g, s2)]);
    let t3 = combine_with((&c_tilde, x), (&g, s3), hs.chunks(POINT), s_tilde);
    let t41 = combine_with((&a, x), (&key_negative, s4), after.chunks(CARD_BYTES).map(|card| &card[POINT..]), s_tilde);
    let t42 = combine_with((&b, x), (&g_negative, s4), after.chunks(CARD_BYTES).map(|card| &card[..POINT]), s_tilde);

    let mut announcements = [t1, t2, t3, t41, t42].concat();
    for i in 0..DECK {
        let before_it = if i == 0 { h } else { at(chain, i - 1, POINT) };
        announcements.extend(combine(&[(&negative(at(chain, i, POINT)), x), (&g, at(s_hat, i, SCALAR)), (before_it, at(s_tilde, i, SCALAR))]));
    }
    (seed, announcements)
}
