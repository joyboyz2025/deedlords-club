//! Unit tests: whole hands through the contract's methods under `testing_env!`, and the shuffle proof against the
//! ways a seat could try to cheat with it. Proofs are made here with the same host functions the contract checks them
//! with; this prover is written apart from the browser's (games/poker/shuffle.ts), which
//! `contracts/sandbox/poker-run.js` checks against the contract as well.

use std::collections::HashSet;
use std::panic::{catch_unwind, AssertUnwindSafe};

use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::serde_json::{json, Value};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{env, testing_env, AccountId, Gas, NearToken};

use crate::cards::{rank5, rank7};
use crate::curve::{add, challenge, generator, mul, sum, POINT, SCALAR};
use crate::fr::{self, Fr};
use crate::shuffle::{holds, recomputed, GENERATORS, PROOF_BYTES};
use crate::{card_points, open_deck, Contract, CARD_BYTES, DECK, MIN_STAKE, RECORD_FEE};

const STAKE: u128 = 10u128.pow(24);
/// What a seat attaches: its stake and the record fee.
const SEAT: u128 = STAKE + RECORD_FEE;
const SECOND: u64 = 1_000_000_000;
const NAMES: [&str; 2] = ["p1.test", "p2.test"];
const SECRETS: [u64; 2] = [7, 11];

fn scalar(n: u64) -> Vec<u8> {
    let mut out = vec![0u8; SCALAR];
    out[..8].copy_from_slice(&n.to_le_bytes());
    out
}

/// `nonce + c·secret` for a 248-bit challenge and small numbers: it stays below the group order.
fn response(c: &[u8; SCALAR], secret: u64, nonce: u64) -> Vec<u8> {
    let mut out = vec![0u8; SCALAR];
    let mut carry = u128::from(nonce);
    for (index, byte) in out.iter_mut().enumerate() {
        let value = u128::from(c[index]) * u128::from(secret) + carry;
        *byte = value as u8;
        carry = value >> 8;
    }
    assert_eq!(carry, 0);
    out
}

fn key_of(seat: usize) -> Vec<u8> {
    mul(&generator(), &scalar(SECRETS[seat]))
}

fn table_key() -> Vec<u8> {
    add(&key_of(0), &key_of(1))
}

/// What `seat` sends to sit down as `account`: its key and the proof that it knows the secret.
fn key_proof(seat: usize, account: &str) -> Base64VecU8 {
    let (key, nonce) = (key_of(seat), 1_000 + seat as u64);
    let r = mul(&generator(), &scalar(nonce));
    let c = challenge(&[b"deedlords-poker/key", account.as_bytes(), &key, &r]);
    Base64VecU8([key, r, response(&c, SECRETS[seat], nonce)].concat())
}

/// A decryption share of the card whose first half is `c1`, made with `secret` and proved against `key`.
fn share(secret: u64, key: &[u8], c1: &[u8]) -> Vec<u8> {
    let nonce = 2_000 + secret;
    let (token, a, b) = (mul(c1, &scalar(secret)), mul(&generator(), &scalar(nonce)), mul(c1, &scalar(nonce)));
    let c = challenge(&[b"deedlords-poker/token", key, c1, &token, &a, &b]);
    [token, a, b, response(&c, secret, nonce)].concat()
}

/// Scalars for the tests: sha256 of a counter with the top byte cleared.
struct Scalars(u64);

impl Scalars {
    fn next(&mut self) -> Fr {
        self.0 += 1;
        let mut hash = env::sha256_array(self.0.to_le_bytes());
        hash[SCALAR - 1] = 0;
        fr::from_bytes(&hash)
    }

    fn many(&mut self) -> Vec<Fr> {
        (0..DECK).map(|_| self.next()).collect()
    }
}

fn times(point: &[u8], scalar: &Fr) -> Vec<u8> {
    mul(point, &fr::to_bytes(scalar))
}

fn dot(left: &[Fr], right: &[Fr]) -> Fr {
    left.iter().zip(right).fold([0; 4], |total, (a, b)| fr::add(&total, &fr::mul(a, b)))
}

/// Dice for the tests: sha256 of a counter.
struct Dice(u64);

impl Dice {
    fn below(&mut self, n: u32) -> u32 {
        self.0 += 1;
        u32::from_le_bytes(env::sha256_array(self.0.to_le_bytes())[..4].try_into().unwrap()) % n
    }

    fn order(&mut self) -> Vec<u8> {
        let mut order: Vec<u8> = (0..DECK as u8).collect();
        for i in (1..DECK).rev() {
            order.swap(i, self.below(i as u32 + 1) as usize);
        }
        order
    }
}

/// A small whole number as a scalar; a negative one is the order minus it.
fn whole(value: i64) -> Fr {
    let mut scalar = if value < 0 { fr::ORDER } else { [0; 4] };
    if value < 0 {
        scalar[0] -= value.unsigned_abs();
    } else {
        scalar[0] = value as u64;
    }
    scalar
}

/// 1/x, as x to the power (order − 2).
fn inverse(x: &Fr) -> Fr {
    let mut exponent = fr::ORDER;
    exponent[0] -= 2;
    let mut result = fr::ONE;
    for bit in (0..254).rev() {
        result = fr::mul(&result, &result);
        if exponent[bit / 64] >> (bit % 64) & 1 == 1 {
            result = fr::mul(&result, x);
        }
    }
    result
}

/// A matrix by rows: row `i` lists (column, entry) for its entries that are not zero.
type Rows = Vec<Vec<(usize, Fr)>>;

/// The matrix of a shuffle that puts card `order[i]` at place `i`.
fn rows_of(order: &[u8]) -> Rows {
    order.iter().map(|&from| vec![(usize::from(from), fr::ONE)]).collect()
}

/// A deck, its proof, and the announcements the prover hashed: t1, t2, t3, t41, t42, then t̂_0..t̂_51.
struct Made {
    deck: Vec<u8>,
    proof: Vec<u8>,
    announced: Vec<u8>,
}

/// The prover's steps (as games/poker/shuffle.ts takes them) for any two matrices, so that a test can also play a
/// prover who cheats with care. Output card `i` is the combination `output[i]` of the cards of `before`, re-encrypted
/// under `key`; the commitment commits to the matrix `committed`, whose row `i` also gives ũ_i from the challenges.
/// An honest shuffle uses the same permutation matrix for both.
fn made(before: &[u8], key: &[u8], output: &Rows, committed: &Rows, salt: u64) -> Made {
    workbench();
    let g = generator();
    let (h, hs) = GENERATORS.split_at(POINT);
    let h_of = |i: usize| &hs[i * POINT..(i + 1) * POINT];
    let mut random = Scalars(salt << 32);

    let randomness = random.many();
    let mut deck = vec![];
    for (i, row) in output.iter().enumerate() {
        let (mut c1, mut c2) = (times(&g, &randomness[i]), times(key, &randomness[i]));
        for (from, entry) in row {
            let card = &before[from * CARD_BYTES..][..CARD_BYTES];
            c1 = add(&c1, &times(&card[..POINT], entry));
            c2 = add(&c2, &times(&card[POINT..], entry));
        }
        deck.extend(c1);
        deck.extend(c2);
    }
    let card = |i: usize| &deck[i * CARD_BYTES..(i + 1) * CARD_BYTES];

    let rc = random.many();
    let mut c: Vec<Vec<u8>> = rc.iter().map(|r| times(&g, r)).collect();
    for (i, row) in committed.iter().enumerate() {
        for (column, entry) in row {
            c[*column] = add(&c[*column], &times(h_of(i), entry));
        }
    }
    let c = c.concat();
    let seed = env::sha256_array([b"deedlords-poker/shuffle", key, before, &deck[..], &c[..]].concat());
    let u: Vec<Fr> = (0..DECK).map(|j| fr::from_bytes(&challenge(&[b"deedlords-poker/shuffle/u", &seed, &[j as u8]]))).collect();
    let ut: Vec<Fr> = committed.iter().map(|row| row.iter().fold([0; 4], |total, (column, entry)| fr::add(&total, &fr::mul(entry, &u[*column])))).collect();

    let rh = random.many();
    let mut chain: Vec<Vec<u8>> = vec![];
    for i in 0..DECK {
        let link = add(&times(&g, &rh[i]), &times(if i == 0 { h } else { &chain[i - 1] }, &ut[i]));
        chain.push(link);
    }

    let (w, wh, wt) = ([random.next(), random.next(), random.next(), random.next()], random.many(), random.many());
    let negative = |point: &[u8]| sum(&[(true, point)]);
    let t1 = times(&g, &w[0]);
    let t2 = times(&g, &w[1]);
    let t3 = (0..DECK).fold(times(&g, &w[2]), |total, i| add(&total, &times(h_of(i), &wt[i])));
    let t41 = (0..DECK).fold(negative(&times(key, &w[3])), |total, i| add(&total, &times(&card(i)[POINT..], &wt[i])));
    let t42 = (0..DECK).fold(negative(&times(&g, &w[3])), |total, i| add(&total, &times(&card(i)[..POINT], &wt[i])));
    let th: Vec<Vec<u8>> = (0..DECK).map(|i| add(&times(&g, &wh[i]), &times(if i == 0 { h } else { &chain[i - 1] }, &wt[i]))).collect();
    let chain = chain.concat();
    let announced = [t1, t2, t3, t41, t42, th.concat()].concat();
    let x = challenge(&[b"deedlords-poker/shuffle/proof", &seed, &chain, &announced]);
    let x_fr = fr::from_bytes(&x);

    let mut v = vec![fr::ONE; DECK];
    for i in (1..DECK).rev() {
        v[i - 1] = fr::mul(&ut[i], &v[i]);
    }
    let answer = |w: &Fr, secret: &Fr| fr::to_bytes(&fr::add(w, &fr::mul(&x_fr, secret))).to_vec();
    let total = rc.iter().fold([0; 4], |total, r| fr::add(&total, r));
    let mut proof = [c, chain, x.to_vec(), answer(&w[0], &total), answer(&w[1], &dot(&rh, &v)), answer(&w[2], &dot(&rc, &u)), answer(&w[3], &dot(&randomness, &ut))].concat();
    proof.extend((0..DECK).flat_map(|i| answer(&wh[i], &rh[i])));
    proof.extend((0..DECK).flat_map(|i| answer(&wt[i], &ut[i])));
    assert_eq!(proof.len(), PROOF_BYTES);
    Made { deck, proof, announced }
}

/// An honest shuffle: card `i` of the result is card `order[i]` of `before`. Returns the deck and its proof.
fn shuffled(before: &[u8], key: &[u8], order: &[u8], salt: u64) -> (Vec<u8>, Vec<u8>) {
    let rows = rows_of(order);
    let made = made(before, key, &rows, &rows, salt);
    (made.deck, made.proof)
}

/// Two orders after which the deck starts with the cards `wanted` (positions 0-1 seat 0, 2-3 seat 1, 4-8 the board).
/// The second shuffle reverses the deck, so the first one is the wanted deck reversed.
fn orders_for(wanted: &[u8]) -> [Vec<u8>; 2] {
    let mut deck = wanted.to_vec();
    deck.extend((0..DECK as u8).filter(|card| !wanted.contains(card)));
    let reverse: Vec<u8> = (0..DECK as u8).rev().collect();
    [reverse.iter().map(|&at| deck[usize::from(at)]).collect(), reverse]
}

fn card(rank: u8, suit: u8) -> u8 {
    suit * 13 + rank
}

/// Aces for seat 0, kings for seat 1, and a board that helps neither.
fn aces_against_kings() -> Vec<u8> {
    vec![card(12, 0), card(12, 1), card(11, 0), card(11, 1), card(0, 0), card(5, 1), card(7, 2), card(9, 3), card(1, 0)]
}

fn context(who: &str, deposit: u128, now: u64) {
    let mut builder = VMContextBuilder::new();
    let name = |text: &str| text.parse::<AccountId>().unwrap();
    builder
        .current_account_id(name("poker.test"))
        .predecessor_account_id(name(who))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(now)
        .prepaid_gas(Gas::from_tgas(300));
    testing_env!(builder.build());
}

/// A context with gas to spare, for making proofs: the mocked host meters its curve functions as the chain does, and
/// a prover does several times the work of the verifier. Calls to the contract get 300 Tgas (`context`).
fn workbench() {
    let mut builder = VMContextBuilder::new();
    builder.current_account_id("poker.test".parse().unwrap()).prepaid_gas(Gas::from_tgas(100_000));
    testing_env!(builder.build());
}

/// Whether what `call` does is refused: by a `require!`, or by a host function that was given bad bytes.
fn refused(call: impl FnOnce()) -> bool {
    catch_unwind(AssertUnwindSafe(call)).is_err()
}

struct T {
    c: Contract,
    now: u64,
}

impl T {
    fn new() -> T {
        let now = 1_000 * SECOND;
        context("poker.test", 0, now);
        T { c: Contract::new(), now }
    }

    /// The next call comes from `seat`, a second later, with a fresh gas meter.
    fn as_seat(&mut self, seat: usize, deposit: u128) {
        self.now += SECOND;
        context(NAMES[seat], deposit, self.now);
    }

    fn start(&mut self, id: &str) {
        self.as_seat(0, SEAT);
        self.c.create_match(id.into(), U128(STAKE), key_proof(0, NAMES[0]), None);
        self.as_seat(1, SEAT);
        self.c.join(id.into(), key_proof(1, NAMES[1]));
    }

    fn game(&self, id: &str) -> Value {
        self.c.get_match(id.into()).expect("the match is open")
    }

    fn deck(&self, id: &str, step: u8) -> Vec<u8> {
        let hand = self.game(id)["hand"].as_u64().unwrap() as u32;
        self.c.get_deck(id.into(), hand, step).expect("the deck is stored").0
    }

    /// `seat` sends `deck` with `proof`.
    fn send_shuffle(&mut self, id: &str, seat: usize, deck: Vec<u8>, proof: Vec<u8>) {
        self.as_seat(seat, 0);
        self.c.shuffle(id.into(), seat as u8, Base64VecU8(deck), Base64VecU8(proof));
    }

    /// Both seats shuffle honestly, the button first with `orders[0]`.
    fn shuffle(&mut self, id: &str, orders: &[Vec<u8>; 2]) {
        let button = self.game(id)["button"].as_u64().unwrap() as usize;
        for (step, seat) in [button, 1 - button].into_iter().enumerate() {
            self.as_seat(seat, 0);
            let before = if step == 0 { open_deck() } else { self.deck(id, 0) };
            let (deck, proof) = shuffled(&before, &table_key(), &orders[step], 100 * (seat as u64 + 1));
            self.send_shuffle(id, seat, deck, proof);
        }
    }

    fn shares(&mut self, id: &str, seat: usize, at: &[usize]) -> Base64VecU8 {
        let deck = self.deck(id, 1);
        self.as_seat(seat, 0);
        Base64VecU8(at.iter().flat_map(|&at| share(SECRETS[seat], &key_of(seat), &deck[at * CARD_BYTES..][..POINT])).collect())
    }

    fn deal_one(&mut self, id: &str, seat: usize) {
        let other = 1 - seat;
        let tokens = self.shares(id, seat, &[2 * other, 2 * other + 1]);
        self.c.deal(id.into(), seat as u8, tokens);
    }

    fn deal(&mut self, id: &str) {
        self.deal_one(id, 0);
        self.deal_one(id, 1);
    }

    fn open_one(&mut self, id: &str, seat: usize) {
        let at: &[usize] = match self.game(id)["street"].as_u64().unwrap() {
            1 => &[4, 5, 6],
            2 => &[7],
            _ => &[8],
        };
        let tokens = self.shares(id, seat, at);
        self.c.open(id.into(), seat as u8, tokens);
    }

    fn open(&mut self, id: &str) {
        self.open_one(id, 0);
        self.open_one(id, 1);
    }

    fn show_one(&mut self, id: &str, seat: usize) {
        let tokens = self.shares(id, seat, &[2 * seat, 2 * seat + 1]);
        self.c.show(id.into(), seat as u8, tokens);
    }

    fn show(&mut self, id: &str) {
        self.show_one(id, 0);
        self.show_one(id, 1);
    }

    /// The deadline passes and `seat` asks for the timeout. Returns the chips the match settled with.
    fn time_out(&mut self, id: &str, seat: usize) -> Value {
        self.now += 200 * SECOND;
        self.as_seat(seat, 0);
        self.c.timeout(id.into());
        let result = self.c.get_result(id.into()).expect("a timeout settles the match");
        assert_eq!(result["reason"], "timeout");
        result["chips"].clone()
    }

    fn act(&mut self, id: &str, seat: usize, action: &str, amount: Option<u32>) {
        self.as_seat(seat, 0);
        self.c.act(id.into(), seat as u8, action.into(), amount);
    }
}

#[test]
fn hands_rank_in_the_order_of_poker() {
    let hands = [
        [card(12, 0), card(10, 1), card(7, 2), card(4, 3), card(2, 0)], // ace high
        [card(3, 0), card(3, 1), card(12, 2), card(9, 3), card(5, 0)],  // a pair
        [card(9, 0), card(9, 1), card(4, 2), card(4, 3), card(12, 0)],  // two pair
        [card(6, 0), card(6, 1), card(6, 2), card(12, 3), card(2, 0)],  // three of a kind
        [card(12, 0), card(0, 1), card(1, 2), card(2, 3), card(3, 0)],  // the wheel: a straight to the five
        [card(0, 0), card(1, 1), card(2, 2), card(3, 3), card(4, 0)],   // a straight to the six
        [card(0, 2), card(5, 2), card(7, 2), card(9, 2), card(11, 2)],  // a flush
        [card(8, 0), card(8, 1), card(8, 2), card(1, 3), card(1, 0)],   // a full house
        [card(5, 0), card(5, 1), card(5, 2), card(5, 3), card(12, 0)],  // four of a kind
        [card(4, 3), card(5, 3), card(6, 3), card(7, 3), card(8, 3)],   // a straight flush
    ];
    let scores: Vec<u32> = hands.iter().map(|&hand| rank5(hand)).collect();
    assert!(scores.windows(2).all(|pair| pair[0] < pair[1]), "{scores:?}");
    assert_eq!(scores.iter().map(|score| score >> 20).collect::<Vec<_>>(), [0, 1, 2, 3, 4, 4, 5, 6, 7, 8]);
    // The kicker decides between equal pairs, and suits never do.
    assert!(rank5([card(3, 0), card(3, 1), card(12, 2), card(9, 3), card(5, 0)]) > rank5([card(3, 2), card(3, 3), card(11, 2), card(9, 0), card(5, 1)]));
    assert_eq!(rank5([card(3, 0), card(3, 1), card(12, 2), card(9, 3), card(5, 0)]), rank5([card(3, 2), card(3, 3), card(12, 0), card(9, 1), card(5, 2)]));
    // Seven cards: the best five count.
    assert_eq!(rank7([card(8, 0), card(8, 1), card(8, 2), card(1, 3), card(1, 0), card(12, 1), card(11, 2)]) >> 20, 6);
}

#[test]
fn scalars_multiply_as_the_curve_does() {
    workbench();
    let g = generator();
    let mut random = Scalars(7);
    for _ in 0..8 {
        let (a, b) = (random.next(), random.next());
        assert_eq!(times(&g, &fr::mul(&a, &b)), times(&times(&g, &a), &b), "a·b");
        assert_eq!(times(&g, &fr::add(&a, &b)), add(&times(&g, &a), &times(&g, &b)), "a + b");
    }
    // At the edge: (order − 1)² is 1, and (order − 1) + 1 is 0.
    let mut last = fr::ORDER;
    last[0] -= 1;
    assert_eq!(fr::mul(&last, &last), fr::ONE);
    assert_eq!(fr::add(&last, &fr::ONE), [0; 4]);
    assert_eq!(fr::from_bytes(&fr::to_bytes(&last)), last);
}

#[test]
fn the_generators_were_hashed_and_not_chosen() {
    context("poker.test", 0, 0);
    assert_eq!(GENERATORS.len(), (DECK + 1) * POINT);
    let points: Vec<&[u8]> = GENERATORS.chunks(POINT).collect();
    for (index, point) in points.iter().enumerate() {
        // Its x is sha256("deedlords-poker/generator" ‖ index ‖ counter) with the top three bits cleared, for a small counter.
        let hashed = (0u32..64).any(|counter| {
            let mut hash = env::sha256_array([&b"deedlords-poker/generator"[..], &(index as u32).to_le_bytes(), &counter.to_le_bytes()].concat());
            hash[31] &= 0x1f;
            hash[..] == point[..SCALAR]
        });
        assert!(hashed, "generator {index} does not come from the hash");
        assert!(!points[..index].contains(point), "generator {index} repeats an earlier one");
        assert_ne!(*point, &generator()[..]);
    }
    // The host refuses bytes that are not a point of the curve.
    sum(&points.iter().map(|point| (false, *point)).collect::<Vec<_>>());
}

#[test]
fn a_shuffle_proof_holds_only_for_an_honest_shuffle() {
    context("poker.test", 0, 0);
    let key = table_key();
    let order = &orders_for(&aces_against_kings())[0];
    let first = open_deck();
    let (second, proof) = shuffled(&first, &key, order, 1);
    // `Some(answer)` of the verifier within the gas of one call, or `None` if it did not get to answer.
    let check = |key: &[u8], before: &[u8], after: &[u8], proof: &[u8]| {
        context("poker.test", 0, 0);
        catch_unwind(AssertUnwindSafe(|| holds(key, before, after, proof))).ok()
    };
    assert_eq!(check(&key, &first, &second, &proof), Some(true), "an honest shuffle of the open deck");
    // A shuffle of a deck that is already encrypted, as the second seat makes it.
    let reverse: Vec<u8> = (0..DECK as u8).rev().collect();
    let (third, proof_of_third) = shuffled(&second, &key, &reverse, 2);
    assert_eq!(check(&key, &second, &third, &proof_of_third), Some(true), "an honest shuffle of a shuffled deck");

    // Everything below is made of valid points and scalars, so the verifier answers, and must answer no.
    // The proof speaks of one input deck, one output deck and one key.
    assert_eq!(check(&key, &first, &third, &proof_of_third), Some(false), "the proof of another input deck");
    assert_eq!(check(&key, &first, &third, &proof), Some(false), "the proof of another output deck");
    assert_eq!(check(&key_of(0), &first, &second, &proof), Some(false), "another key");

    // A deck made under a key the seat knows the secret of, proved as if it were the table key.
    let (own, proof_of_own) = shuffled(&first, &key_of(1), order, 3);
    assert_eq!(check(&key, &first, &own, &proof_of_own), Some(false), "re-encrypted under the wrong key");

    // Decks that are not the same 52 cards.
    let card = |deck: &[u8], i: usize| deck[i * CARD_BYTES..(i + 1) * CARD_BYTES].to_vec();
    let mut swapped = second.clone();
    swapped[..CARD_BYTES].copy_from_slice(&card(&second, 1));
    swapped[CARD_BYTES..2 * CARD_BYTES].copy_from_slice(&card(&second, 0));
    assert_eq!(check(&key, &first, &swapped, &proof), Some(false), "two cards swapped after the proof was made");
    let mut repeated = second.clone();
    repeated[..CARD_BYTES].copy_from_slice(&card(&second, 1));
    assert_eq!(check(&key, &first, &repeated, &proof), Some(false), "a card copied over another");
    workbench();
    let moved = add(&second[POINT..CARD_BYTES], &generator());
    let mut another = second.clone();
    another[POINT..CARD_BYTES].copy_from_slice(&moved);
    assert_eq!(check(&key, &first, &another, &proof), Some(false), "a card turned into the next card");

    // A deck that repeats one card and drops another, with the proof an honest prover's steps give for it.
    let mut twice = order.clone();
    twice[1] = twice[0];
    let (stacked, proof_of_stacked) = shuffled(&first, &key, &twice, 4);
    assert_eq!(check(&key, &first, &stacked, &proof_of_stacked), Some(false), "an order that is not a permutation");

    // No part of the proof can be changed: one point or one scalar of each part replaced by its neighbour.
    let parts = [(0, POINT), (DECK * POINT, POINT), (2 * DECK * POINT, SCALAR), (2 * DECK * POINT + SCALAR, SCALAR), (2 * DECK * POINT + 4 * SCALAR, SCALAR), (2 * DECK * POINT + 5 * SCALAR, SCALAR), (PROOF_BYTES - 2 * SCALAR, SCALAR)];
    for (start, size) in parts {
        let mut changed = proof.clone();
        let neighbour = proof[start + size..start + 2 * size].to_vec();
        changed[start..start + size].copy_from_slice(&neighbour);
        assert_eq!(check(&key, &first, &second, &changed), Some(false), "the proof with the {size} bytes at {start} replaced");
    }
    // All zeros: the point at infinity everywhere and every answer zero.
    assert_eq!(check(&key, &first, &second, &vec![0; PROOF_BYTES]), Some(false), "an empty proof");
    // Bytes that are no point of the curve stop the call in the host function.
    let mut broken = proof.clone();
    broken[0] ^= 1;
    assert_eq!(check(&key, &first, &second, &broken), None, "a commitment that is not a point");
}

#[test]
fn a_hand_to_the_showdown_pays_the_better_hand() {
    let mut t = T::new();
    t.start("m");
    t.shuffle("m", &orders_for(&aces_against_kings()));
    assert!(t.c.get_deck("m".into(), 0, 0).is_none(), "only the deck dealt is kept");
    t.deal("m");
    assert_eq!(t.game("m")["put"], json!([1, 2]), "seat 0 has the button and the small blind");
    t.act("m", 0, "raise", Some(6));
    t.act("m", 1, "call", None);
    t.open("m");
    assert_eq!(t.game("m")["board"], json!([card(0, 0), card(5, 1), card(7, 2)]));
    t.act("m", 1, "call", None);
    t.act("m", 0, "raise", Some(10));
    t.act("m", 1, "call", None);
    t.open("m");
    t.act("m", 1, "call", None);
    t.act("m", 0, "call", None);
    t.open("m");
    t.act("m", 1, "raise", Some(20));
    t.act("m", 0, "call", None);
    let game = t.game("m");
    assert_eq!((&game["phase"], &game["chips"]), (&json!("showdown"), &json!([64, 64])));
    t.show("m");
    let game = t.game("m");
    assert_eq!(game["chips"], json!([136, 64]));
    assert_eq!((&game["hand"], &game["button"], &game["phase"]), (&json!(1), &json!(1), &json!("shuffle")));
    assert_eq!(game["last"], json!({ "number": 0, "board": [card(0, 0), card(5, 1), card(7, 2), card(9, 3), card(1, 0)], "hole": [[card(12, 0), card(12, 1)], [card(11, 0), card(11, 1)]], "outcome": { "won": 0 }, "pot": 72 }));
    assert!(t.c.get_deck("m".into(), 0, 1).is_none(), "the deck of a finished hand is deleted");

    // The next hand: seat 1 has the button, shuffles first and folds its small blind. Nobody sees a folded card.
    t.shuffle("m", &orders_for(&aces_against_kings()));
    t.deal("m");
    assert_eq!(t.game("m")["put"], json!([2, 1]));
    t.act("m", 1, "fold", None);
    let game = t.game("m");
    assert_eq!((&game["chips"], &game["hand"]), (&json!([137, 63]), &json!(2)));
    assert_eq!(game["last"], json!({ "number": 1, "board": [], "hole": [[], []], "outcome": { "won": 0 }, "pot": 3 }));
}

#[test]
fn all_in_before_the_flop_runs_out_the_board_and_settles() {
    let mut t = T::new();
    t.start("m");
    t.shuffle("m", &orders_for(&aces_against_kings()));
    t.deal("m");
    assert!(refused(|| t.act("m", 0, "raise", Some(3))), "a raise is at least the big blind");
    assert!(refused(|| t.act("m", 0, "raise", Some(101))), "nobody can bet more than they have");
    assert!(refused(|| t.act("m", 1, "call", None)), "it is seat 0's turn");
    t.act("m", 0, "raise", Some(100));
    t.act("m", 1, "call", None);
    for _ in 0..3 {
        assert_eq!(t.game("m")["phase"], "open", "with a seat all in there is nothing left to bet");
        t.open("m");
    }
    t.show("m");
    assert!(t.c.get_match("m".into()).is_none(), "a settled match is deleted");
    let result = t.c.get_result("m".into()).unwrap();
    assert_eq!(result["payouts"], json!([(2 * STAKE).to_string(), "0"]));
    assert_eq!((&result["reason"], &result["hands"]), (&json!("busted"), &json!(1)));
}

#[test]
fn a_share_made_with_another_key_is_refused() {
    let mut t = T::new();
    t.start("m");
    t.shuffle("m", &orders_for(&aces_against_kings()));
    let deck = t.deck("m", 1);
    t.as_seat(0, 0);
    let wrong: Vec<u8> = [2, 3].iter().flat_map(|&at: &usize| share(SECRETS[1], &key_of(0), &deck[at * CARD_BYTES..][..POINT])).collect();
    assert!(refused(|| t.c.deal("m".into(), 0, Base64VecU8(wrong))));
    // A valid share for the wrong card is refused too.
    let other: Vec<u8> = [0, 1].iter().flat_map(|&at: &usize| share(SECRETS[0], &key_of(0), &deck[at * CARD_BYTES..][..POINT])).collect();
    t.as_seat(0, 0);
    assert!(refused(|| t.c.deal("m".into(), 0, Base64VecU8(other))));
    t.deal("m");
    assert_eq!(t.game("m")["phase"], "bet");
}

#[test]
fn a_deck_that_is_not_a_shuffle_never_reaches_the_table() {
    let mut t = T::new();
    t.start("m");
    let orders = orders_for(&aces_against_kings());
    t.as_seat(0, 0);
    let (first, proof) = shuffled(&open_deck(), &table_key(), &orders[0], 1);
    t.send_shuffle("m", 0, first.clone(), proof);

    // Seat 1 throws seat 0's shuffle away and shuffles the open deck instead: an honest proof, of the wrong deck.
    t.as_seat(1, 0);
    let (own, proof_of_own) = shuffled(&open_deck(), &table_key(), &orders[1], 2);
    assert!(refused(|| t.send_shuffle("m", 1, own, proof_of_own)), "a deck that does not come from seat 0's");
    // Or shuffles honestly and then puts one card in another's place.
    t.as_seat(1, 0);
    let (mut deck, proof) = shuffled(&first, &table_key(), &orders[1], 2);
    assert!(refused(|| t.send_shuffle("m", 1, [&deck[CARD_BYTES..2 * CARD_BYTES], &deck[CARD_BYTES..]].concat(), proof.clone())), "a deck with a card repeated");
    deck.truncate(DECK * CARD_BYTES - 1);
    assert!(refused(|| t.send_shuffle("m", 1, deck, proof)), "a deck of the wrong length");
    assert_eq!(t.game("m")["shuffled"], 1, "nothing of that was stored");

    // It has no deck the table takes, so it runs out of time and forfeits.
    t.as_seat(0, 0);
    assert!(refused(|| t.c.timeout("m".into())), "the deadline has not passed");
    t.now += 200 * SECOND;
    t.as_seat(0, 0);
    t.c.timeout("m".into());
    let result = t.c.get_result("m".into()).unwrap();
    assert_eq!((&result["payouts"], &result["reason"]), (&json!([(2 * STAKE).to_string(), "0"]), &json!("timeout")));
}

#[test]
fn a_seat_that_does_not_bet_in_time_forfeits() {
    let mut t = T::new();
    t.start("m");
    t.shuffle("m", &orders_for(&aces_against_kings()));
    t.deal("m");
    t.act("m", 0, "call", None);
    t.now += 200 * SECOND;
    t.as_seat(0, 0);
    t.c.timeout("m".into());
    assert_eq!(t.c.get_result("m".into()).unwrap()["chips"], json!([200, 0]));
}

#[test]
fn a_key_proof_belongs_to_one_account() {
    let mut t = T::new();
    t.as_seat(0, SEAT);
    t.c.create_match("m".into(), U128(STAKE), key_proof(0, NAMES[0]), None);
    t.as_seat(1, SEAT);
    assert!(refused(|| t.c.join("m".into(), key_proof(0, NAMES[0]))), "seat 0's proof was made for seat 0's account");
    t.as_seat(1, SEAT);
    t.c.join("m".into(), key_proof(1, NAMES[1]));
}

#[test]
fn leaving_pays_what_each_seat_holds() {
    let mut t = T::new();
    t.as_seat(0, SEAT);
    t.c.create_match("lobby".into(), U128(STAKE), key_proof(0, NAMES[0]), None);
    t.as_seat(0, 0);
    t.c.leave("lobby".into());
    assert!(t.c.get_match("lobby".into()).is_none());

    t.start("m");
    t.shuffle("m", &orders_for(&aces_against_kings()));
    t.as_seat(1, 0);
    assert!(refused(|| t.c.leave("m".into())), "a hand is under way");
    t.deal("m");
    t.act("m", 0, "fold", None);
    t.as_seat(1, 0);
    t.c.leave("m".into());
    let result = t.c.get_result("m".into()).unwrap();
    assert_eq!((&result["chips"], &result["reason"]), (&json!([99, 101]), &json!("left")));
    assert_eq!(result["payouts"], json!([(STAKE / 100 * 99).to_string(), (STAKE / 100 * 101).to_string()]));
}

#[test]
fn every_five_card_hand_is_ranked_as_poker_ranks_it() {
    // All 2,598,960 hands: how many fall in each category, and how many different strengths each category has.
    let mut hands = [0u32; 9];
    let mut strengths: Vec<HashSet<u32>> = vec![HashSet::new(); 9];
    for a in 0..52u8 {
        for b in a + 1..52 {
            for c in b + 1..52 {
                for d in c + 1..52 {
                    for e in d + 1..52 {
                        let score = rank5([a, b, c, d, e]);
                        hands[(score >> 20) as usize] += 1;
                        strengths[(score >> 20) as usize].insert(score);
                    }
                }
            }
        }
    }
    // High card, pair, two pair, three of a kind, straight, flush, full house, four of a kind, straight flush.
    assert_eq!(hands, [1_302_540, 1_098_240, 123_552, 54_912, 10_200, 5_108, 3_744, 624, 40]);
    // 7,462 different strengths in all: suits never decide, and every difference in ranks that matters does.
    assert_eq!(strengths.iter().map(HashSet::len).collect::<Vec<_>>(), [1_277, 2_860, 858, 858, 10, 1_277, 156, 156, 10]);

    // Inside a category the right cards decide, in the right order.
    let beats = |better: [u8; 5], worse: [u8; 5]| assert!(rank5(better) > rank5(worse), "{better:?} should beat {worse:?}");
    beats([card(11, 0), card(11, 1), card(0, 2), card(0, 3), card(1, 0)], [card(10, 0), card(10, 1), card(9, 2), card(9, 3), card(12, 0)]); // kings up beat queens up, whatever the second pair
    beats([card(5, 0), card(5, 1), card(3, 2), card(3, 3), card(12, 0)], [card(5, 2), card(5, 3), card(3, 0), card(3, 1), card(11, 0)]); // same two pair: the kicker
    beats([card(1, 0), card(1, 1), card(1, 2), card(0, 3), card(0, 0)], [card(0, 1), card(0, 2), card(0, 3), card(12, 0), card(12, 1)]); // a full house goes by its three
    beats([card(4, 0), card(4, 1), card(4, 2), card(4, 3), card(1, 0)], [card(4, 0), card(4, 1), card(4, 2), card(4, 3), card(0, 0)]); // four of a kind: the kicker
    beats([card(12, 1), card(10, 1), card(4, 1), card(2, 1), card(1, 1)], [card(12, 2), card(10, 2), card(4, 2), card(2, 2), card(0, 2)]); // a flush down to its fifth card
    beats([card(12, 0), card(11, 1), card(10, 2), card(9, 3), card(8, 0)], [card(11, 0), card(10, 1), card(9, 2), card(8, 3), card(7, 0)]); // the ace-high straight is the best
    beats([card(0, 0), card(1, 1), card(2, 2), card(3, 3), card(4, 0)], [card(12, 0), card(0, 1), card(1, 2), card(2, 3), card(3, 0)]); // and the wheel the worst
    beats([card(7, 0), card(7, 1), card(12, 2), card(5, 3), card(3, 0)], [card(7, 2), card(7, 3), card(12, 0), card(5, 1), card(2, 0)]); // a pair down to its last kicker
}

#[test]
fn a_careful_cheater_is_stopped_by_the_product_check() {
    // The strongest cheats known against this kind of proof: the output deck is not a reordering of the input but a
    // mix of it (each new card a combination of old ones), chosen so that every check passes except the one that
    // says the committed matrix is a permutation. Mixing turns cards into other cards: on the open deck, 2·(card 5)
    // − (card 3) is card 7. These tests show the verifier refuses them, and that it is the product check (t2) alone
    // that does: without it both decks would be taken.
    context("poker.test", 0, 0);
    let key = table_key();
    let (deck, _) = shuffled(&open_deck(), &key, &orders_for(&aces_against_kings())[0], 1);
    let identity: Vec<u8> = (0..DECK as u8).collect();
    let (half, third) = (inverse(&whole(2)), inverse(&whole(3)));
    let (two, one, minus) = (whole(2), whole(1), whole(-1));
    let two_thirds = fr::mul(&two, &third);

    // Two cards: (2a − b, 2b − a). The matrix to commit to is the inverse transpose, (2a + b)/3 and (a + 2b)/3.
    let mut pair = (rows_of(&identity), rows_of(&identity));
    pair.0[0] = vec![(0, two), (1, minus)];
    pair.0[1] = vec![(0, minus), (1, two)];
    pair.1[0] = vec![(0, two_thirds), (1, third)];
    pair.1[1] = vec![(0, third), (1, two_thirds)];
    // Three cards: (a + b − c, a − b + c, −a + b + c), committed as ((a + b)/2, (a + c)/2, (b + c)/2).
    let mut triple = (rows_of(&identity), rows_of(&identity));
    triple.0[0] = vec![(0, one), (1, one), (2, minus)];
    triple.0[1] = vec![(0, one), (1, minus), (2, one)];
    triple.0[2] = vec![(0, minus), (1, one), (2, one)];
    triple.1[0] = vec![(0, half), (1, half)];
    triple.1[1] = vec![(0, half), (2, half)];
    triple.1[2] = vec![(1, half), (2, half)];

    for (name, (output, committed)) in [("two cards mixed", pair), ("three cards mixed", triple)] {
        let cheat = made(&deck, &key, &output, &committed, 5);
        context("poker.test", 0, 0);
        assert!(!holds(&key, &deck, &cheat.deck, &cheat.proof), "{name}: the proof must not hold");
        context("poker.test", 0, 0);
        let (_, recomputed) = recomputed(&key, &deck, &cheat.deck, &cheat.proof);
        let same: Vec<bool> = cheat.announced.chunks(POINT).zip(recomputed.chunks(POINT)).map(|(said, found)| said == found).collect();
        assert!(!same[1], "{name}: t2, the product of the challenges, is what gives it away");
        assert!(same[0] && same[2..].iter().all(|&same| same), "{name}: every other check passes, so t2 is the one that matters");
    }

    // For an honest shuffle the verifier finds exactly the announcements the prover made.
    let rows = rows_of(&(0..DECK as u8).rev().collect::<Vec<_>>());
    let honest = made(&deck, &key, &rows, &rows, 6);
    context("poker.test", 0, 0);
    assert_eq!(recomputed(&key, &deck, &honest.deck, &honest.proof).1, honest.announced);
    context("poker.test", 0, 0);
    assert!(holds(&key, &deck, &honest.deck, &honest.proof));
}

#[test]
fn many_shuffles_in_a_row_keep_the_same_52_cards() {
    context("poker.test", 0, 0);
    let mut dice = Dice(11);
    let key = table_key();
    let mut deck = open_deck();
    let mut cards: Vec<u8> = (0..DECK as u8).collect();
    for round in 0..8 {
        let order = dice.order();
        let (next, proof) = shuffled(&deck, &key, &order, 40 + round);
        context("poker.test", 0, 0);
        assert!(holds(&key, &deck, &next, &proof), "shuffle {round}");
        cards = order.iter().map(|&from| cards[usize::from(from)]).collect();
        deck = next;
    }
    // Decrypted with both seats' secrets, every place holds the card the orders say, and so each card once.
    workbench();
    let points = card_points();
    let secret = scalar(SECRETS[0] + SECRETS[1]);
    let found: Vec<u8> = deck
        .chunks(CARD_BYTES)
        .map(|card| {
            let open = sum(&[(false, &card[POINT..]), (true, &mul(&card[..POINT], &secret))]);
            points.iter().position(|point| *point == open).expect("a card") as u8
        })
        .collect();
    assert_eq!(found, cards);
    assert_eq!(found.iter().collect::<HashSet<_>>().len(), DECK);
}

#[test]
fn no_changed_byte_gets_a_deck_or_a_proof_through() {
    context("poker.test", 0, 0);
    let key = table_key();
    let before = open_deck();
    let (deck, proof) = shuffled(&before, &key, &orders_for(&aces_against_kings())[0], 1);
    let mut dice = Dice(77);
    for round in 0..160 {
        let (mut deck, mut proof) = (deck.clone(), proof.clone());
        let flip = 1 + dice.below(255) as u8;
        // One round in four changes the deck, the others the proof; scalars get most of the changes, since a changed
        // point is nearly always off the curve and stopped by the host.
        let at = match round % 4 {
            0 => {
                let at = dice.below(deck.len() as u32) as usize;
                deck[at] ^= flip;
                at
            }
            1 => dice.below(2 * (DECK * POINT) as u32) as usize,
            _ => 2 * DECK * POINT + dice.below((PROOF_BYTES - 2 * DECK * POINT) as u32) as usize,
        };
        if round % 4 != 0 {
            proof[at] ^= flip;
        }
        context("poker.test", 0, 0);
        let answer = catch_unwind(AssertUnwindSafe(|| holds(&key, &before, &deck, &proof))).ok();
        assert_ne!(answer, Some(true), "round {round}: byte {at} changed by {flip}");
    }
    // A scalar that is not below the group order is stopped by the host.
    let mut large = proof.clone();
    large[2 * DECK * POINT + SCALAR..][..SCALAR].copy_from_slice(&fr::to_bytes(&fr::ORDER));
    context("poker.test", 0, 0);
    assert!(refused(|| {
        holds(&key, &before, &deck, &large);
    }));
}

#[test]
fn no_changed_byte_gets_a_share_or_a_key_through() {
    workbench();
    let (deck, _) = shuffled(&open_deck(), &table_key(), &orders_for(&aces_against_kings())[0], 1);
    let (key, c1) = (key_of(0), &deck[5 * CARD_BYTES..][..POINT]);
    let honest = share(SECRETS[0], &key, c1);
    workbench();
    assert!(crate::curve::same_key(&key, c1, &honest[..POINT], &honest[POINT..]));
    let sat = key_proof(1, NAMES[1]).0;
    assert!(crate::curve::knows_key(NAMES[1], &sat[..POINT], &sat[POINT..]));
    let mut dice = Dice(5);
    for round in 0..200 {
        workbench();
        let flip = 1 + dice.below(255) as u8;
        let mut changed = honest.clone();
        // Mostly the answer z: a changed point is nearly always off the curve.
        let at = if round % 3 == 0 { dice.below(3 * POINT as u32) as usize } else { 3 * POINT + dice.below(SCALAR as u32) as usize };
        changed[at] ^= flip;
        let answer = catch_unwind(AssertUnwindSafe(|| crate::curve::same_key(&key, c1, &changed[..POINT], &changed[POINT..]))).ok();
        assert_ne!(answer, Some(true), "share, round {round}: byte {at} changed by {flip}");
        let mut changed = sat.clone();
        let at = if round % 3 == 0 { dice.below(2 * POINT as u32) as usize } else { 2 * POINT + dice.below(SCALAR as u32) as usize };
        changed[at] ^= flip;
        let answer = catch_unwind(AssertUnwindSafe(|| crate::curve::knows_key(NAMES[1], &changed[..POINT], &changed[POINT..]))).ok();
        assert_ne!(answer, Some(true), "key, round {round}: byte {at} changed by {flip}");
    }
    // A true share of another card, or of this card under the other key, says nothing about this one.
    workbench();
    let other = share(SECRETS[0], &key, &deck[6 * CARD_BYTES..][..POINT]);
    assert!(!crate::curve::same_key(&key, c1, &other[..POINT], &other[POINT..]));
    assert!(!crate::curve::same_key(&key_of(1), c1, &honest[..POINT], &honest[POINT..]));
    assert!(!crate::curve::knows_key(NAMES[0], &sat[..POINT], &sat[POINT..]));
}

#[test]
fn random_play_keeps_every_chip_accounted_for() {
    let mut dice = Dice(2026);
    let mut t = T::new();
    for game in 0..4 {
        let id = format!("g{game}");
        t.start(&id);
        // What this test reckons each seat holds, worked out from the actions alone and compared with the contract.
        let mut chips = [100u32, 100];
        let mut settled = false;
        for hand in 0..10u32 {
            let button = (hand % 2) as usize;
            let orders = [dice.order(), dice.order()];
            let dealt: Vec<u8> = (0..9).map(|at| orders[0][usize::from(orders[1][at])]).collect();
            t.shuffle(&id, &orders);
            t.deal(&id);
            let mut put = [0u32; 2];
            put[button] = 1;
            put[1 - button] = 2;
            let (mut bet, mut street, mut folded) = (put, 0, None);
            loop {
                let Some(game) = t.c.get_match(id.clone()) else {
                    settled = true;
                    break;
                };
                if game["hand"] != json!(hand) {
                    break;
                }
                assert_eq!(game["put"], json!(put), "{id}, hand {hand}");
                assert_eq!(game["chips"], json!([chips[0] - put[0], chips[1] - put[1]]), "{id}, hand {hand}");
                if game["street"] != json!(street) {
                    street = game["street"].as_u64().unwrap();
                    bet = [0; 2];
                }
                match game["phase"].as_str().unwrap() {
                    "open" => t.open(&id),
                    "showdown" => t.show(&id),
                    "bet" => {
                        assert_eq!(game["bet"], json!(bet));
                        let me = game["toAct"].as_u64().unwrap() as usize;
                        let other = 1 - me;
                        let stack = |seat: usize| chips[seat] - put[seat];
                        let most = (bet[me] + stack(me)).min(bet[other] + stack(other));
                        // What the table must refuse leaves no trace.
                        assert!(refused(|| t.act(&id, other, "call", None)), "out of turn");
                        assert!(refused(|| t.act(&id, me, "raise", Some(most + 1))), "more than a seat can pay");
                        assert!(refused(|| t.act(&id, me, "raise", Some(bet[other]))), "a raise that raises nothing");
                        if bet[other] + 1 < most {
                            assert!(refused(|| t.act(&id, me, "raise", Some(bet[other] + 1))), "a raise under the big blind that is not all in");
                        }
                        assert_eq!(t.game(&id)["seq"], game["seq"], "a refused call changes nothing");
                        match dice.below(10) {
                            0 => {
                                t.act(&id, me, "fold", None);
                                folded = Some(me);
                            }
                            7..=9 if most > bet[other] => {
                                let least = (bet[other] + 2).min(most);
                                let to = least + dice.below(most - least + 1);
                                t.act(&id, me, "raise", Some(to));
                                put[me] += to - bet[me];
                                bet[me] = to;
                            }
                            _ => {
                                t.act(&id, me, "call", None);
                                put[me] += bet[other] - bet[me];
                                bet[me] = bet[other];
                            }
                        }
                    }
                    phase => panic!("a hand under way cannot be at {phase}"),
                }
            }
            // The hand is over: the pot goes where the cards, or the fold, say.
            let score = |seat: usize| rank7([dealt[2 * seat], dealt[2 * seat + 1], dealt[4], dealt[5], dealt[6], dealt[7], dealt[8]]);
            let winner = match folded {
                Some(seat) => Some(1 - seat),
                None if score(0) == score(1) => None,
                None => Some(usize::from(score(1) > score(0))),
            };
            if let Some(winner) = winner {
                let pot = put[0] + put[1];
                chips = [chips[0] - put[0], chips[1] - put[1]];
                chips[winner] += pot;
            }
            assert_eq!(chips[0] + chips[1], 200);
            if settled {
                break;
            }
            let game = t.game(&id);
            assert_eq!(game["chips"], json!(chips), "{id}, after hand {hand}");
            let shown = if folded.is_some() { json!([[], []]) } else { json!([[dealt[0], dealt[1]], [dealt[2], dealt[3]]]) };
            assert_eq!(game["last"]["hole"], shown, "a folded hand shows no cards, a showdown shows the cards dealt");
            assert_eq!(game["last"]["outcome"], winner.map_or(json!("split"), |seat| json!({ "won": seat })));
        }
        if !settled {
            t.as_seat(0, 0);
            t.c.leave(id.clone());
        }
        let result = t.c.get_result(id.clone()).expect("every match ends with a result");
        assert_eq!(result["chips"], json!(chips), "{id}");
        assert_eq!(result["reason"], if settled { "busted" } else { "left" });
        assert_eq!(settled, chips.iter().any(|&chips| chips < 2), "a match settles by itself exactly when a seat cannot post the big blind");
        assert_eq!(result["payouts"], json!([(STAKE / 100 * u128::from(chips[0])).to_string(), (STAKE / 100 * u128::from(chips[1])).to_string()]));
    }
}

#[test]
fn whoever_the_table_waits_for_past_the_deadline_forfeits() {
    let orders = orders_for(&aces_against_kings());
    let first_shuffle = |t: &mut T, id: &str| {
        t.as_seat(0, 0);
        let (deck, proof) = shuffled(&open_deck(), &table_key(), &orders[0], 1);
        t.send_shuffle(id, 0, deck, proof);
    };
    // The street is bet out with no raise: the button calls, the other seat checks.
    let to_the_flop = |t: &mut T, id: &str| {
        t.shuffle(id, &orders);
        t.deal(id);
        t.act(id, 0, "call", None);
        t.act(id, 1, "call", None);
    };
    let to_the_showdown = |t: &mut T, id: &str| {
        to_the_flop(t, id);
        for _ in 0..3 {
            t.open(id);
            t.act(id, 1, "call", None);
            t.act(id, 0, "call", None);
        }
        assert_eq!(t.game(id)["phase"], "showdown");
    };

    // How far the hand gets, and the chips after the timeout.
    type Reach<'a> = Box<dyn Fn(&mut T, &str) + 'a>;
    let cases: Vec<(Reach, [u32; 2])> = vec![
        (Box::new(|_, _| ()), [0, 200]),     // the button never shuffles
        (Box::new(first_shuffle), [200, 0]), // the other seat never shuffles
        (
            Box::new(|t, id| {
                t.shuffle(id, &orders);
                t.deal_one(id, 0)
            }),
            [200, 0], // seat 1 never deals
        ),
        (Box::new(|t, id| t.shuffle(id, &orders)), [100, 100]), // nobody deals: nothing was put in
        (
            Box::new(|t, id| {
                to_the_flop(t, id);
                t.open_one(id, 1)
            }),
            [0, 200], // seat 0 never opens the flop
        ),
        (Box::new(to_the_flop), [100, 100]), // nobody opens: each takes back its 2
        (
            Box::new(|t, id| {
                to_the_showdown(t, id);
                t.show_one(id, 1)
            }),
            [0, 200], // seat 0 will not show
        ),
    ];
    let mut t = T::new();
    for (index, (reach, chips)) in cases.iter().enumerate() {
        let id = format!("m{index}");
        t.start(&id);
        reach(&mut t, &id);
        t.as_seat(0, 0);
        assert!(refused(|| t.c.timeout(id.clone())), "case {index}: the deadline has not passed");
        assert_eq!(t.time_out(&id, 1), json!(chips), "case {index}");
    }
}

#[test]
fn the_table_refuses_whoever_has_no_business_there() {
    let mut t = T::new();
    let key = || key_proof(0, NAMES[0]);
    t.as_seat(0, SEAT);
    assert!(refused(|| t.c.create_match("bad id!".into(), U128(STAKE), key(), None)), "an id with other characters");
    assert!(refused(|| t.c.create_match("m".into(), U128(MIN_STAKE - 100), key(), None)), "a stake under the minimum");
    assert!(refused(|| t.c.create_match("m".into(), U128(STAKE + 1), key(), None)), "a stake that is not 100 equal chips");
    assert!(refused(|| t.c.create_match("m".into(), U128(2 * STAKE), key(), None)), "a deposit that is not the stake and the fee");
    context(NAMES[0], STAKE, t.now);
    assert!(refused(|| t.c.create_match("m".into(), U128(STAKE), key(), None)), "the stake without the record fee");
    t.as_seat(0, STAKE + RECORD_FEE);
    assert!(refused(|| t.c.create_match("m".into(), U128(STAKE), key(), Some(1))), "a turn of one second");
    t.c.create_match("m".into(), U128(STAKE), key(), None);
    t.as_seat(0, SEAT);
    assert!(refused(|| t.c.create_match("m".into(), U128(STAKE), key(), None)), "an id in use");
    t.as_seat(1, 0);
    assert!(refused(|| t.c.leave("m".into())), "only who sits there may close a table");
    context(NAMES[1], STAKE, t.now);
    assert!(refused(|| t.c.join("m".into(), key_proof(1, NAMES[1]))), "the stake without the record fee");
    t.as_seat(1, SEAT);
    t.c.join("m".into(), key_proof(1, NAMES[1]));
    t.as_seat(1, SEAT);
    assert!(refused(|| t.c.join("m".into(), key_proof(1, NAMES[1]))), "a table that is full");

    // A third account cannot play a seat, and a seat cannot play the other.
    let (deck, proof) = shuffled(&open_deck(), &table_key(), &orders_for(&aces_against_kings())[0], 1);
    context("p3.test", 0, t.now);
    assert!(refused(|| t.c.shuffle("m".into(), 0, Base64VecU8(deck.clone()), Base64VecU8(proof.clone()))), "a stranger");
    t.as_seat(1, 0);
    assert!(refused(|| t.c.shuffle("m".into(), 0, Base64VecU8(deck.clone()), Base64VecU8(proof.clone()))), "seat 1 as seat 0");
    assert!(refused(|| t.c.shuffle("m".into(), 1, Base64VecU8(deck.clone()), Base64VecU8(proof.clone()))), "seat 1 before its turn");
    assert!(refused(|| t.act("m", 0, "call", None)), "a bet while the deck is being shuffled");
    assert!(refused(|| t.deal_one("m", 0)), "shares of a deck that is not there yet");
    t.send_shuffle("m", 0, deck.clone(), proof.clone());
    assert!(refused(|| t.send_shuffle("m", 0, deck, proof)), "the same seat twice");
    assert_eq!(t.c.get_result("m".into()), None);
    // The id of a settled match stays taken.
    assert_eq!(t.time_out("m", 0), json!([200, 0]));
    t.as_seat(0, SEAT);
    assert!(refused(|| t.c.create_match("m".into(), U128(STAKE), key(), None)), "the id of a settled match");
}
