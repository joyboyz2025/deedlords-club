//! Unit tests: whole hands through the contract's methods under `testing_env!`. The seats' secrets and nonces are
//! small numbers, so the proofs can be made here with the same host functions the contract checks them with (a
//! response `nonce + challenge·secret` then needs no reduction). The browser's own prover is checked against the
//! contract by `contracts/sandbox/poker-run.js`.

use std::panic::{catch_unwind, AssertUnwindSafe};

use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::serde_json::{json, Value};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, AccountId, Gas, NearToken};

use crate::cards::{rank5, rank7};
use crate::curve::{add, challenge, generator, mul, POINT, SCALAR};
use crate::{open_deck, Contract, CARD_BYTES, DECK};

const STAKE: u128 = 10u128.pow(24);
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

/// `before` shuffled: card `i` of the result is card `order[i]` of `before`, re-encrypted under `key` with the scalar
/// `salt + i²` (not `salt + i`: two such shuffles, the second reversing the first, would give every card the same C1).
/// Returns the deck and its opening.
fn shuffled(before: &[u8], order: &[u8], key: &[u8], salt: u64) -> (Vec<u8>, Vec<u8>) {
    let (mut deck, mut opening) = (vec![], order.to_vec());
    for (to, &from) in order.iter().enumerate() {
        let s = scalar(salt + (to * to) as u64);
        let from = &before[usize::from(from) * CARD_BYTES..][..CARD_BYTES];
        deck.extend(add(&from[..POINT], &mul(&generator(), &s)));
        deck.extend(add(&from[POINT..], &mul(key, &s)));
        opening.extend(s);
    }
    (deck, opening)
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
        self.as_seat(0, STAKE);
        self.c.create_match(id.into(), U128(STAKE), key_proof(0, NAMES[0]), None);
        self.as_seat(1, STAKE);
        self.c.join(id.into(), key_proof(1, NAMES[1]));
    }

    fn game(&self, id: &str) -> Value {
        self.c.get_match(id.into()).expect("the match is open")
    }

    fn deck(&self, id: &str, step: u8) -> Vec<u8> {
        let hand = self.game(id)["hand"].as_u64().unwrap() as u32;
        self.c.get_deck(id.into(), hand, step).expect("the deck is stored").0
    }

    /// `seat` sends its shuffle of `before`; returns the opening.
    fn shuffle_one(&mut self, id: &str, seat: usize, before: &[u8], order: &[u8]) -> Base64VecU8 {
        self.as_seat(seat, 0);
        let (deck, opening) = shuffled(before, order, &add(&key_of(0), &key_of(1)), 100 * (seat as u64 + 1));
        self.as_seat(seat, 0);
        self.c.shuffle(id.into(), seat as u8, Base64VecU8(deck));
        Base64VecU8(opening)
    }

    /// Both seats shuffle honestly, the button first with `orders[0]`. Returns each seat's opening.
    fn shuffle(&mut self, id: &str, orders: &[Vec<u8>; 2]) -> [Base64VecU8; 2] {
        let button = self.game(id)["button"].as_u64().unwrap() as usize;
        let first = self.shuffle_one(id, button, &open_deck(), &orders[0]);
        let second = self.shuffle_one(id, 1 - button, &self.deck(id, 0), &orders[1]);
        if button == 0 {
            [first, second]
        } else {
            [second, first]
        }
    }

    fn shares(&mut self, id: &str, seat: usize, at: &[usize]) -> Base64VecU8 {
        let deck = self.deck(id, 1);
        self.as_seat(seat, 0);
        Base64VecU8(at.iter().flat_map(|&at| share(SECRETS[seat], &key_of(seat), &deck[at * CARD_BYTES..][..POINT])).collect())
    }

    fn deal(&mut self, id: &str) {
        for seat in 0..2 {
            let other = 1 - seat;
            let tokens = self.shares(id, seat, &[2 * other, 2 * other + 1]);
            self.c.deal(id.into(), seat as u8, tokens);
        }
    }

    fn open(&mut self, id: &str) {
        let at: &[usize] = match self.game(id)["street"].as_u64().unwrap() {
            1 => &[4, 5, 6],
            2 => &[7],
            _ => &[8],
        };
        for seat in 0..2 {
            let tokens = self.shares(id, seat, at);
            self.c.open(id.into(), seat as u8, tokens);
        }
    }

    fn show(&mut self, id: &str) {
        for seat in 0..2 {
            let tokens = self.shares(id, seat, &[2 * seat, 2 * seat + 1]);
            self.c.show(id.into(), seat as u8, tokens);
        }
    }

    fn audit(&mut self, id: &str, openings: &[Base64VecU8; 2]) {
        for seat in 0..2 {
            self.as_seat(seat, 0);
            self.c.audit(id.into(), seat as u8, openings[seat].clone());
        }
    }

    fn act(&mut self, id: &str, seat: usize, action: &str, amount: Option<u32>) {
        self.as_seat(seat, 0);
        self.c.act(id.into(), seat as u8, action.into(), amount);
    }

    /// Whether the contract refuses what `call` does.
    fn refuses(&mut self, call: impl FnOnce(&mut T)) -> bool {
        catch_unwind(AssertUnwindSafe(|| call(self))).is_err()
    }
}

#[test]
fn hands_rank_in_the_order_of_poker() {
    let hands = [
        [card(12, 0), card(10, 1), card(7, 2), card(4, 3), card(2, 0)],   // ace high
        [card(3, 0), card(3, 1), card(12, 2), card(9, 3), card(5, 0)],    // a pair
        [card(9, 0), card(9, 1), card(4, 2), card(4, 3), card(12, 0)],    // two pair
        [card(6, 0), card(6, 1), card(6, 2), card(12, 3), card(2, 0)],    // three of a kind
        [card(12, 0), card(0, 1), card(1, 2), card(2, 3), card(3, 0)],    // the wheel: a straight to the five
        [card(0, 0), card(1, 1), card(2, 2), card(3, 3), card(4, 0)],     // a straight to the six
        [card(0, 2), card(5, 2), card(7, 2), card(9, 2), card(11, 2)],    // a flush
        [card(8, 0), card(8, 1), card(8, 2), card(1, 3), card(1, 0)],     // a full house
        [card(5, 0), card(5, 1), card(5, 2), card(5, 3), card(12, 0)],    // four of a kind
        [card(4, 3), card(5, 3), card(6, 3), card(7, 3), card(8, 3)],     // a straight flush
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
fn a_hand_to_the_showdown_pays_the_better_hand() {
    let mut t = T::new();
    t.start("m");
    let openings = t.shuffle("m", &orders_for(&aces_against_kings()));
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
    assert_eq!(t.game("m")["phase"], "showdown");
    t.show("m");
    let game = t.game("m");
    assert_eq!((&game["phase"], &game["outcome"]), (&json!("audit"), &json!({ "won": 0 })));
    assert_eq!(game["hole"], json!([[card(12, 0), card(12, 1)], [card(11, 0), card(11, 1)]]));
    assert_eq!(game["chips"], json!([64, 64]), "nothing is paid before the shuffles are opened");
    t.audit("m", &openings);
    let game = t.game("m");
    assert_eq!(game["chips"], json!([136, 64]));
    assert_eq!((&game["hand"], &game["button"], &game["phase"]), (&json!(1), &json!(1), &json!("shuffle")));
    assert_eq!(game["last"]["pot"], 72);
    assert!(t.c.get_deck("m".into(), 0, 1).is_none(), "the decks of a finished hand are deleted");

    // The next hand: seat 1 has the button, shuffles first and folds its small blind.
    let openings = t.shuffle("m", &orders_for(&aces_against_kings()));
    t.deal("m");
    assert_eq!(t.game("m")["put"], json!([2, 1]));
    t.act("m", 1, "fold", None);
    t.audit("m", &openings);
    assert_eq!(t.game("m")["chips"], json!([137, 63]));
}

#[test]
fn all_in_before_the_flop_runs_out_the_board_and_settles() {
    let mut t = T::new();
    t.start("m");
    let openings = t.shuffle("m", &orders_for(&aces_against_kings()));
    t.deal("m");
    assert!(t.refuses(|t| t.act("m", 0, "raise", Some(3))), "a raise is at least the big blind");
    assert!(t.refuses(|t| t.act("m", 0, "raise", Some(101))), "nobody can bet more than they have");
    assert!(t.refuses(|t| t.act("m", 1, "call", None)), "it is seat 0's turn");
    t.act("m", 0, "raise", Some(100));
    t.act("m", 1, "call", None);
    for _ in 0..3 {
        assert_eq!(t.game("m")["phase"], "open", "with a seat all in there is nothing left to bet");
        t.open("m");
    }
    t.show("m");
    t.audit("m", &openings);
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
    assert!(t.refuses(|t| t.c.deal("m".into(), 0, Base64VecU8(wrong))));
    // A valid share for the wrong card is refused too.
    let other: Vec<u8> = [0, 1].iter().flat_map(|&at: &usize| share(SECRETS[0], &key_of(0), &deck[at * CARD_BYTES..][..POINT])).collect();
    t.as_seat(0, 0);
    assert!(t.refuses(|t| t.c.deal("m".into(), 0, Base64VecU8(other))));
    t.deal("m");
    assert_eq!(t.game("m")["phase"], "bet");
}

#[test]
fn a_false_shuffle_cannot_be_opened_and_forfeits_the_match() {
    let mut t = T::new();
    t.start("m");
    let orders = orders_for(&aces_against_kings());
    let honest = t.shuffle_one("m", 0, &open_deck(), &orders[0]);
    // Seat 1 throws seat 0's shuffle away and encrypts a deck whose order it knows.
    let cheat = t.shuffle_one("m", 1, &open_deck(), &orders[1]);
    t.deal("m");
    t.act("m", 0, "fold", None);
    t.as_seat(1, 0);
    assert!(t.refuses(|t| t.c.audit("m".into(), 1, cheat)), "the opening does not lead from seat 0's deck to seat 1's");
    t.as_seat(0, 0);
    t.c.audit("m".into(), 0, honest);
    t.as_seat(0, 0);
    assert!(t.refuses(|t| t.c.timeout("m".into())), "the deadline has not passed");
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
    t.as_seat(0, STAKE);
    t.c.create_match("m".into(), U128(STAKE), key_proof(0, NAMES[0]), None);
    t.as_seat(1, STAKE);
    assert!(t.refuses(|t| t.c.join("m".into(), key_proof(0, NAMES[0]))), "seat 0's proof was made for seat 0's account");
    t.as_seat(1, STAKE);
    t.c.join("m".into(), key_proof(1, NAMES[1]));
}

#[test]
fn leaving_pays_what_each_seat_holds() {
    let mut t = T::new();
    t.as_seat(0, STAKE);
    t.c.create_match("lobby".into(), U128(STAKE), key_proof(0, NAMES[0]), None);
    t.as_seat(0, 0);
    t.c.leave("lobby".into());
    assert!(t.c.get_match("lobby".into()).is_none());

    t.start("m");
    let openings = t.shuffle("m", &orders_for(&aces_against_kings()));
    t.as_seat(1, 0);
    assert!(t.refuses(|t| t.c.leave("m".into())), "a hand is under way");
    t.deal("m");
    t.act("m", 0, "fold", None);
    t.audit("m", &openings);
    t.as_seat(1, 0);
    t.c.leave("m".into());
    let result = t.c.get_result("m".into()).unwrap();
    assert_eq!((&result["chips"], &result["reason"]), (&json!([99, 101]), &json!("left")));
    assert_eq!(result["payouts"], json!([(STAKE / 100 * 99).to_string(), (STAKE / 100 * 101).to_string()]));
}
