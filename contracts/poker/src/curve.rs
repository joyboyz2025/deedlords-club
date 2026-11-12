//! BN254 G1 through the NEAR host functions, and the two proofs the table checks.
//!
//! A point is 64 bytes (x then y, 32 bytes little-endian each; all zeros is the point at infinity) and a scalar is 32
//! bytes little-endian below the group order: exactly what `alt_bn128_g1_multiexp` and `alt_bn128_g1_sum` take. The
//! host refuses bytes that are not a point of the curve or a scalar in range, which fails the call.

use near_sdk::env;

pub const POINT: usize = 64;
pub const SCALAR: usize = 32;

/// The generator (1, 2).
pub fn generator() -> [u8; POINT] {
    let mut g = [0u8; POINT];
    g[0] = 1;
    g[32] = 2;
    g
}

/// `scalar * point`.
pub fn mul(point: &[u8], scalar: &[u8]) -> Vec<u8> {
    env::alt_bn128_g1_multiexp([point, scalar].concat())
}

/// The sum of the points, each one subtracted instead when its flag is set.
pub fn sum(terms: &[(bool, &[u8])]) -> Vec<u8> {
    let mut input = Vec::with_capacity(terms.len() * (POINT + 1));
    for (negative, point) in terms {
        input.push(u8::from(*negative));
        input.extend_from_slice(point);
    }
    env::alt_bn128_g1_sum(input)
}

pub fn add(a: &[u8], b: &[u8]) -> Vec<u8> {
    sum(&[(false, a), (false, b)])
}

/// The challenge of a proof made non-interactive: sha256 over the parts with the top byte cleared, read as a
/// little-endian scalar. 248 bits, so it is always below the group order.
pub fn challenge(parts: &[&[u8]]) -> [u8; SCALAR] {
    let mut c = env::sha256_array(parts.concat());
    c[SCALAR - 1] = 0;
    c
}

/// Schnorr proof that whoever sent it knows the secret key of `key`. `proof` is R ‖ z with z·G = R + c·key. The
/// challenge covers the account, so a proof copied from another account is refused.
pub fn knows_key(account: &str, key: &[u8], proof: &[u8]) -> bool {
    let (r, z) = proof.split_at(POINT);
    let c = challenge(&[b"deedlords-poker/key", account.as_bytes(), key, r]);
    mul(&generator(), z) == add(r, &mul(key, &c))
}

/// Chaum-Pedersen proof that `token` is `sk·c1` for the secret key of `key`, which shows nothing else about `sk`.
/// `proof` is A ‖ B ‖ z with z·G = A + c·key and z·c1 = B + c·token.
pub fn same_key(key: &[u8], c1: &[u8], token: &[u8], proof: &[u8]) -> bool {
    let (a, rest) = proof.split_at(POINT);
    let (b, z) = rest.split_at(POINT);
    let c = challenge(&[b"deedlords-poker/token", key, c1, token, a, b]);
    mul(&generator(), z) == add(a, &mul(key, &c)) && mul(c1, z) == add(b, &mul(token, &c))
}
