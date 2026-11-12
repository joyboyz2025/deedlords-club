//! Unit tests: whole hands through the contract's methods under `testing_env!`.
//!
//! The shuffle proof itself is tested where it lives (contracts/poker/src/tests.rs). Here one hand of nine seats is
//! played with real proofs; the other tests switch the proof off (`trust`) and put a deck of their choosing on the
//! table, so that they can play thousands of hands and say which cards fall. Shares are always real and always
//! checked.

use std::cell::Cell;
use std::panic::{catch_unwind, AssertUnwindSafe};

use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::serde_json::Value;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{env, testing_env, AccountId, Gas, NearToken};

use crate::curve::{add, challenge, generator, mul, sum, POINT, SCALAR};
use crate::fr::{self, Fr};
use crate::shuffle::{GENERATORS, PROOF_BYTES};
use crate::cards::rank7;
use crate::{card_points, open_deck, pots, Contract, CARD_BYTES, DECK, FREE_TABLE_DEPOSIT, MAX_FREE_SITTINGS, RECORD_FEE};

thread_local! {
    static TRUSTING: Cell<bool> = const { Cell::new(false) };
    /// The fee the next contract a test makes starts with, in basis points.
    static FEE: Cell<u16> = const { Cell::new(0) };
}

const OWNER: &str = "owner.test";

/// Whether this test put its decks on the table without a proof.
pub fn trusting() -> bool {
    TRUSTING.with(Cell::get)
}

const STAKE: u128 = 10u128.pow(24);
/// What a seat attaches: its stake and the record fee.
const SEAT: u128 = STAKE + RECORD_FEE;
const SECOND: u64 = 1_000_000_000;

fn name(who: usize) -> String {
    format!("p{who}.test")
}

fn secret(who: usize) -> u64 {
    7 + 4 * who as u64
}

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

fn key_of(who: usize) -> Vec<u8> {
    mul(&generator(), &scalar(secret(who)))
}

/// What `who` sends to sit down: its key and the proof that it knows the secret.
fn key_proof(who: usize) -> Base64VecU8 {
    key_proof_as(&name(who), who)
}

/// The same for an account of any name, with the key of `who`.
fn key_proof_as(account: &str, who: usize) -> Base64VecU8 {
    let (key, nonce) = (key_of(who), 1_000 + who as u64);
    let r = mul(&generator(), &scalar(nonce));
    let c = challenge(&[b"deedlords-poker/key", account.as_bytes(), &key, &r]);
    Base64VecU8([key, r, response(&c, secret(who), nonce)].concat())
}

/// A decryption share of the card whose first half is `c1`, made with `secret` and proved against `key`.
fn share(secret: u64, key: &[u8], c1: &[u8]) -> Vec<u8> {
    let nonce = 2_000 + secret;
    let (token, a, b) = (mul(c1, &scalar(secret)), mul(&generator(), &scalar(nonce)), mul(c1, &scalar(nonce)));
    let c = challenge(&[b"deedlords-poker/token", key, c1, &token, &a, &b]);
    [token, a, b, response(&c, secret, nonce)].concat()
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

/// Scalars for the prover: sha256 of a counter with the top byte cleared.
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

/// An honest shuffle with its proof, as games/poker/shuffle.ts makes it: card `i` of the result is card `order[i]` of
/// `before`, re-encrypted under `key`.
fn shuffled(before: &[u8], key: &[u8], order: &[u8], salt: u64) -> (Vec<u8>, Vec<u8>) {
    workbench();
    let g = generator();
    let (h, hs) = GENERATORS.split_at(POINT);
    let h_of = |i: usize| &hs[i * POINT..(i + 1) * POINT];
    let mut random = Scalars(salt << 32);

    let randomness = random.many();
    let mut deck = vec![];
    for (i, &from) in order.iter().enumerate() {
        let card = &before[usize::from(from) * CARD_BYTES..][..CARD_BYTES];
        deck.extend(add(&times(&g, &randomness[i]), &card[..POINT]));
        deck.extend(add(&times(key, &randomness[i]), &card[POINT..]));
    }
    let card = |i: usize| &deck[i * CARD_BYTES..(i + 1) * CARD_BYTES];

    let rc = random.many();
    let mut c: Vec<Vec<u8>> = rc.iter().map(|r| times(&g, r)).collect();
    for (i, &from) in order.iter().enumerate() {
        c[usize::from(from)] = add(&c[usize::from(from)], h_of(i));
    }
    let c = c.concat();
    let seed = env::sha256_array([b"deedlords-poker/shuffle", key, before, &deck[..], &c[..]].concat());
    let u: Vec<Fr> = (0..DECK).map(|j| fr::from_bytes(&challenge(&[b"deedlords-poker/shuffle/u", &seed, &[j as u8]]))).collect();
    let ut: Vec<Fr> = order.iter().map(|&from| u[usize::from(from)]).collect();

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
    (deck, proof)
}

fn card(rank: u8, suit: u8) -> u8 {
    suit * 13 + rank
}

fn context(who: &str, deposit: u128, now: u64) {
    let mut builder = VMContextBuilder::new();
    let account = |text: &str| text.parse::<AccountId>().unwrap();
    builder
        .current_account_id(account("poker.test"))
        .predecessor_account_id(account(who))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(now)
        .prepaid_gas(Gas::from_tgas(300));
    testing_env!(builder.build());
}

/// A context with gas to spare, for making proofs and decks: the mocked host meters its curve functions as the chain
/// does. Calls to the contract get 300 Tgas (`context`).
fn workbench() {
    let mut builder = VMContextBuilder::new();
    builder.current_account_id("poker.test".parse().unwrap()).prepaid_gas(Gas::from_tgas(100_000));
    testing_env!(builder.build());
}

/// Whether what `call` does is refused: by a `require!`, or by a host function that was given bad bytes.
fn refused(call: impl FnOnce()) -> bool {
    catch_unwind(AssertUnwindSafe(call)).is_err()
}

/// One table. Accounts are numbered (`p3.test` is account 3); seats are the table's.
struct T {
    c: Contract,
    now: u64,
    id: String,
    /// Seats bought and not refunded: each is 100 chips that must be somewhere.
    bought: u32,
}

impl T {
    /// A table of `seats` seats opened by account 0, with a deck taken on trust unless a test says otherwise.
    fn new(id: &str, seats: u8) -> T {
        TRUSTING.with(|trusting| trusting.set(true));
        let now = 1_000 * SECOND;
        context("poker.test", 0, now);
        let mut t = T { c: Contract::new(OWNER.parse().unwrap(), FEE.with(Cell::get)), now, id: id.into(), bought: 1 };
        t.as_who(0, SEAT);
        t.c.create_match(id.into(), U128(STAKE), key_proof(0), Some(seats), None);
        t
    }

    /// A table of `seats` seats, all taken by accounts 0.., which starts it.
    fn full(id: &str, seats: u8) -> T {
        let mut t = T::new(id, seats);
        for who in 1..usize::from(seats) {
            t.join(who);
        }
        t
    }

    /// The next call comes from account `who`, a second later, with a fresh gas meter.
    fn as_who(&mut self, who: usize, deposit: u128) {
        self.now += SECOND;
        context(&name(who), deposit, self.now);
    }

    fn as_seat(&mut self, seat: usize) {
        self.as_who(self.who(seat), 0);
    }

    fn join(&mut self, who: usize) {
        self.as_who(who, SEAT);
        self.c.join(self.id.clone(), key_proof(who));
        self.bought += 1;
    }

    fn leave(&mut self, who: usize) {
        self.as_who(who, 0);
        self.c.leave(self.id.clone());
    }

    fn game(&self) -> Value {
        self.c.get_match(self.id.clone()).expect("the table is open")
    }

    fn settled(&self) -> bool {
        self.c.get_match(self.id.clone()).is_none()
    }

    fn list(&self, field: &str) -> Vec<usize> {
        self.game()[field].as_array().unwrap().iter().map(|value| value.as_u64().unwrap() as usize).collect()
    }

    fn number(&self, field: &str) -> usize {
        self.game()[field].as_u64().unwrap() as usize
    }

    fn phase(&self) -> String {
        self.game()["phase"].as_str().unwrap().into()
    }

    fn chips(&self) -> Vec<usize> {
        self.list("chips")
    }

    fn awaited(&self) -> Vec<usize> {
        self.list("awaited")
    }

    /// The account in each seat.
    fn players(&self) -> Vec<Option<usize>> {
        self.game()["players"].as_array().unwrap().iter().map(|player| player.as_str().map(|text| text[1..text.len() - 5].parse().unwrap())).collect()
    }

    fn who(&self, seat: usize) -> usize {
        self.players()[seat].expect("the seat is taken")
    }

    /// The chips paid to the accounts whose seats were given up, in the order they were.
    fn cashed(&self) -> Vec<(usize, usize)> {
        let value = match self.c.get_match(self.id.clone()) {
            Some(game) => game["cashed"].clone(),
            None => self.c.get_result(self.id.clone()).expect("a table that is gone was settled")["cashed"].clone(),
        };
        value.as_array().unwrap().iter().map(|cashed| (cashed["account"].as_str().map(|text| text[1..text.len() - 5].parse().unwrap()).unwrap(), cashed["chips"].as_u64().unwrap() as usize)).collect()
    }

    /// Every chip bought is behind a seat, in the middle, or was paid out.
    fn check(&self) {
        let paid: usize = self.cashed().iter().map(|cashed| cashed.1).sum();
        let held: usize = if self.settled() { 0 } else { self.chips().iter().sum::<usize>() + self.list("put").iter().sum::<usize>() };
        assert_eq!(paid + held, 100 * self.bought as usize, "chips were made or lost");
    }

    /// The deck dealt when `top` are the cards at its first positions (the hole cards of the button, of the seat after
    /// it and so on, then the board), encrypted under the keys of the seats taken now.
    fn deck_with(&self, top: &[u8]) -> Vec<u8> {
        // Once the button has shuffled, the seats dealt in are fixed, whoever sits down or leaves after that.
        let dealt = self.list("dealt");
        let players = self.players();
        let keyed: Vec<usize> = if dealt.is_empty() { players.iter().flatten().copied().collect() } else { dealt.iter().map(|&seat| players[seat].unwrap()).collect() };
        workbench();
        let key = keyed.iter().fold(vec![0; POINT], |total, &who| add(&total, &key_of(who)));
        let points = card_points();
        let mut order = top.to_vec();
        order.extend((0..DECK as u8).filter(|card| !top.contains(card)));
        let g = generator();
        order.iter().enumerate().flat_map(|(at, &card)| [mul(&g, &scalar(at as u64 + 1)), add(&points[usize::from(card)], &mul(&key, &scalar(at as u64 + 1)))].concat()).collect()
    }

    /// Every seat puts `deck` on the table in its turn, on trust.
    fn shuffle(&mut self, deck: &[u8]) {
        while !self.settled() && self.phase() == "shuffle" {
            let seat = self.awaited()[0];
            self.as_seat(seat);
            self.c.shuffle(self.id.clone(), seat as u8, Base64VecU8(deck.to_vec()), Base64VecU8(vec![0; PROOF_BYTES]), None);
        }
    }

    fn place(&self, seat: usize) -> usize {
        self.list("dealt").iter().position(|&dealt| dealt == seat).unwrap()
    }

    /// `seat`'s shares for the deck positions `at`.
    fn shares(&mut self, seat: usize, at: &[usize]) -> Base64VecU8 {
        let (hand, step) = (self.number("hand") as u32, self.number("shuffled") as u8 - 1);
        let deck = self.c.get_deck(self.id.clone(), hand, step).expect("the deck is stored").0;
        let who = self.who(seat);
        workbench();
        let tokens = at.iter().flat_map(|&at| share(secret(who), &key_of(who), &deck[at * CARD_BYTES..][..POINT])).collect();
        self.as_seat(seat);
        Base64VecU8(tokens)
    }

    fn deal_one(&mut self, seat: usize) {
        let (own, n) = (self.place(seat), self.list("dealt").len());
        let at: Vec<usize> = (0..n).filter(|&place| place != own).flat_map(|place| [2 * place, 2 * place + 1]).collect();
        let tokens = self.shares(seat, &at);
        self.c.deal(self.id.clone(), seat as u8, tokens);
    }

    fn board_at(&self, cards: std::ops::Range<usize>) -> Vec<usize> {
        let n = self.list("dealt").len();
        cards.map(|index| 2 * n + index).collect()
    }

    fn open_one(&mut self, seat: usize) {
        let at = self.board_at(match self.number("street") {
            1 => 0..3,
            2 => 3..4,
            _ => 4..5,
        });
        let tokens = self.shares(seat, &at);
        self.c.open(self.id.clone(), seat as u8, tokens);
    }

    fn show_one(&mut self, seat: usize) {
        let place = self.place(seat);
        let tokens = self.shares(seat, &[2 * place, 2 * place + 1]);
        self.c.show(self.id.clone(), seat as u8, tokens);
    }

    /// A bet; a fold carries the shares for the board cards not yet open.
    fn act(&mut self, seat: usize, action: &str, amount: Option<u32>) {
        let tokens = (action == "fold").then(|| {
            let at = self.board_at(self.list("board").len()..5);
            self.shares(seat, &at)
        });
        self.as_seat(seat);
        self.c.act(self.id.clone(), seat as u8, action.into(), amount, tokens, None);
    }

    /// One awaited seat does what the table waits for, when that is not a bet.
    fn duty(&mut self, seat: usize) {
        match self.phase().as_str() {
            "deal" => self.deal_one(seat),
            "open" => self.open_one(seat),
            "showdown" => self.show_one(seat),
            phase => panic!("no duty in {phase}"),
        }
    }

    /// Every seat does what the table waits for, until it waits for a bet or for a new hand.
    fn duties(&mut self) {
        while !self.settled() && ["deal", "open", "showdown"].contains(&self.phase().as_str()) {
            let seat = self.awaited()[0];
            self.duty(seat);
        }
    }

    /// A hand is dealt with `top` as its first cards, up to the first bet.
    fn hand(&mut self, top: &[u8]) {
        let deck = self.deck_with(top);
        self.shuffle(&deck);
        self.duties();
    }

    /// Everyone checks or calls, and gives the shares owed, until the hand is over.
    fn check_down(&mut self) {
        let hand = self.number("hand");
        while !self.settled() && self.number("hand") == hand {
            if self.phase() == "bet" {
                self.act(self.number("toAct"), "call", None);
            } else {
                self.duties();
            }
        }
    }

    /// The deadline passes and somebody asks for the timeout.
    fn time_out(&mut self) {
        self.now += 200 * SECOND;
        self.as_who(11, 0);
        self.c.timeout(self.id.clone());
    }

    fn last(&self) -> Value {
        self.game()["last"].clone()
    }
}

/// Hole cards for three seats and a board on which the first beats the second beats the third: aces, kings, queens.
fn aces_kings_queens() -> Vec<u8> {
    vec![card(12, 0), card(12, 1), card(11, 0), card(11, 1), card(10, 0), card(10, 1), card(0, 2), card(5, 3), card(7, 2), card(2, 3), card(3, 0)]
}

#[test]
fn layers_go_to_the_best_hand_that_reached_them() {
    // One pot: the best hand takes it, the folded seat's chips too.
    assert_eq!(pots::share(&[10, 10, 4], &[Some(5), Some(9), None], &[0, 1]), [0, 24, 0]);
    // A short all-in with the best hand takes its layer from everyone; the rest goes to the next best.
    assert_eq!(pots::share(&[30, 100, 100], &[Some(9), Some(5), Some(7)], &[0, 1, 2]), [90, 0, 140]);
    // What nobody called comes back.
    assert_eq!(pots::share(&[30, 100], &[Some(9), Some(5)], &[0, 1]), [60, 70]);
    // A tie splits; the odd chip goes to the first in the order.
    assert_eq!(pots::share(&[5, 5, 5], &[Some(7), Some(7), None], &[1, 0]), [7, 8, 0]);
    // Three layers, a tie in the middle one.
    assert_eq!(pots::share(&[10, 40, 40, 90, 90], &[Some(9), Some(8), Some(8), Some(1), Some(2)], &[0, 1, 2, 3, 4]), [50, 60, 60, 0, 100]);
    // Nobody left: everyone takes back their own.
    assert_eq!(pots::share(&[3, 8], &[None, None], &[]), [3, 8]);
    // A seat that folded after putting in more than anyone still in: its chips stay in the middle.
    assert_eq!(pots::share(&[50, 20, 20], &[None, Some(1), Some(2)], &[1, 2]), [0, 0, 90]);
}

/// Side pots worked out another way: the smallest stake still in is matched by everyone and played for, again and
/// again until no stake is left.
fn peeled(put: &[u32], score: &[Option<u32>], order: &[usize]) -> Vec<u32> {
    let mut left = put.to_vec();
    let mut won = vec![0; put.len()];
    let mut live: Vec<usize> = order.to_vec();
    let mut last: Vec<usize> = vec![];
    while !live.is_empty() {
        let least = live.iter().map(|&seat| left[seat]).min().unwrap();
        let mut pot = 0;
        for chips in left.iter_mut() {
            let part = (*chips).min(least);
            *chips -= part;
            pot += part;
        }
        let best = live.iter().filter_map(|&seat| score[seat]).max();
        last = live.iter().copied().filter(|&seat| score[seat] == best).collect();
        // What the folded seats put in above the last stake goes with the last pot.
        if live.iter().all(|&seat| left[seat] == 0) {
            pot += left.iter().sum::<u32>();
        }
        for (place, &seat) in last.iter().enumerate() {
            won[seat] += pot / last.len() as u32 + u32::from(place < pot as usize % last.len());
        }
        live.retain(|&seat| left[seat] > 0);
    }
    let _ = last;
    won
}

#[test]
fn side_pots_never_make_or_lose_a_chip() {
    // Plain dice: the host's hash is metered, and this test throws them a million times.
    struct Plain(u64);
    impl Plain {
        fn below(&mut self, n: u32) -> u32 {
            self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
            ((self.0 >> 33) % u64::from(n)) as u32
        }
    }
    let mut dice = Plain(77);
    for _ in 0..200_000 {
        let seats = 2 + dice.below(8) as usize;
        let put: Vec<u32> = (0..seats).map(|_| if dice.below(4) == 0 { 100 } else { 1 + dice.below(300) }).collect();
        let score: Vec<Option<u32>> = (0..seats).map(|_| (dice.below(3) > 0).then(|| dice.below(4))).collect();
        let mut order: Vec<usize> = (0..seats).filter(|&seat| score[seat].is_some()).collect();
        let turn = dice.below(seats as u32) as usize;
        let turn = turn % order.len().max(1);
        order.rotate_left(turn);
        let won = pots::share(&put, &score, &order);
        assert_eq!(won.iter().sum::<u32>(), put.iter().sum::<u32>(), "{put:?} {score:?}");
        for seat in 0..seats {
            // A folded seat takes nothing (unless everyone folded); nobody takes more from a seat than they put in themselves.
            if !order.is_empty() {
                assert!(score[seat].is_some() || won[seat] == 0);
            }
            let folded_above: u32 = if order.is_empty() { 0 } else { (0..seats).filter(|&other| score[other].is_none()).map(|other| put[other]).sum() };
            assert!(won[seat] <= put.iter().map(|&chips| chips.min(put[seat])).sum::<u32>() + folded_above, "{put:?} {score:?} {won:?}");
        }
        if !order.is_empty() {
            assert_eq!(won, peeled(&put, &score, &order), "{put:?} {score:?} {order:?}");
        }
    }
}

#[test]
fn nine_seats_play_a_hand_with_every_shuffle_proved() {
    let mut t = T::full("nine", 9);
    TRUSTING.with(|trusting| trusting.set(false));
    workbench();
    let key = (0..9).fold(vec![0; POINT], |total, who| add(&total, &key_of(who)));
    let mut dice = Dice(5);
    let mut deck = open_deck();
    for step in 0..9u8 {
        // A deck without its proof, or with the proof of another deck, is refused.
        let (next, proof) = shuffled(&deck, &key, &dice.order(), u64::from(step) + 1);
        let seat = t.awaited()[0];
        assert_eq!(seat, usize::from(step));
        t.as_seat(seat);
        assert!(refused(|| t.c.shuffle(t.id.clone(), seat as u8, Base64VecU8(next.clone()), Base64VecU8(vec![0; PROOF_BYTES]), None)));
        t.as_seat(seat);
        assert!(refused(|| t.c.shuffle(t.id.clone(), seat as u8, Base64VecU8(deck.clone()), Base64VecU8(proof.clone()), None)));
        t.as_seat(seat);
        t.c.shuffle(t.id.clone(), seat as u8, Base64VecU8(next.clone()), Base64VecU8(proof), None);
        // Only the newest deck is kept.
        assert!(step == 0 || t.c.get_deck(t.id.clone(), 0, step - 1).is_none());
        deck = next;
    }
    assert_eq!(t.phase(), "deal");
    assert_eq!(t.game()["key"].as_str().unwrap(), near_sdk::serde_json::to_value(Base64VecU8(key)).unwrap().as_str().unwrap());
    t.check_down();
    let last = t.last();
    assert_eq!(last["ending"], "showdown");
    assert_eq!(last["board"].as_array().unwrap().len(), 5);
    // Every card on the table is a different card of the deck.
    let mut seen: Vec<u64> = last["board"].as_array().unwrap().iter().map(|card| card.as_u64().unwrap()).collect();
    for hole in last["hole"].as_array().unwrap() {
        assert_eq!(hole.as_array().unwrap().len(), 2);
        seen.extend(hole.as_array().unwrap().iter().map(|card| card.as_u64().unwrap()));
    }
    seen.sort_unstable();
    seen.dedup();
    assert_eq!(seen.len(), 23);
    assert_eq!(last["won"].as_array().unwrap().iter().map(|chips| chips.as_u64().unwrap()).sum::<u64>(), 18);
    t.check();
}

#[test]
fn the_blinds_and_the_turns_go_round_the_table() {
    let mut t = T::full("round", 4);
    t.hand(&[]);
    // Seat 0 has the button: 1 and 2 post, 3 acts first.
    assert_eq!(t.list("bet"), [0, 1, 2, 0]);
    assert_eq!(t.number("toAct"), 3);
    t.act(3, "call", None);
    t.act(0, "raise", Some(6));
    t.act(1, "fold", None);
    // The big blind and the caller answer the raise.
    assert_eq!(t.number("toAct"), 2);
    t.act(2, "call", None);
    assert_eq!(t.number("toAct"), 3);
    assert!(refused(|| t.act(3, "raise", Some(7))), "a raise is at least the big blind");
    t.act(3, "call", None);
    assert_eq!(t.phase(), "open");
    // The seat that folded gave its shares with the fold: only the three still in are awaited.
    assert_eq!(t.awaited(), [0, 2, 3]);
    t.duties();
    assert_eq!(t.list("board").len(), 3);
    // After the flop the first seat after the button that is still in acts first.
    assert_eq!(t.number("toAct"), 2);
    t.act(2, "call", None);
    t.act(3, "raise", Some(10));
    t.act(0, "fold", None);
    t.act(2, "fold", None);
    assert_eq!(t.last()["ending"], "fold");
    assert_eq!(t.chips(), [94, 99, 94, 113]);
    // The button moved on; the next hand's blinds follow it.
    assert_eq!(t.number("button"), 1);
    t.hand(&[]);
    assert_eq!(t.list("dealt"), [1, 2, 3, 0]);
    assert_eq!(t.list("bet"), [0, 0, 1, 2]);
    assert_eq!(t.number("toAct"), 0);
    t.check();
}

#[test]
fn two_seats_play_as_heads_up() {
    let mut t = T::full("two", 2);
    t.hand(&[card(12, 0), card(12, 1), card(11, 0), card(11, 1), card(0, 2), card(5, 3), card(7, 2), card(2, 3), card(3, 0)]);
    // The button posts the small blind and acts first before the flop, last after it.
    assert_eq!(t.list("bet"), [1, 2]);
    assert_eq!(t.number("toAct"), 0);
    t.act(0, "raise", Some(10));
    t.act(1, "call", None);
    t.duties();
    assert_eq!(t.number("toAct"), 1);
    t.act(1, "call", None);
    t.act(0, "raise", Some(90));
    t.act(1, "call", None);
    t.duties();
    // The kings are out of chips: the table is settled, and the aces hold everything.
    assert!(t.settled());
    assert_eq!(t.cashed(), [(1, 0), (0, 200)]);
    t.check();
}

#[test]
fn a_short_all_in_wins_only_what_it_matched() {
    let mut t = T::full("side", 3);
    // First the queens (seat 2) lose 60 to the aces (seat 0), so that seat 2 is short.
    t.hand(&aces_kings_queens());
    t.act(0, "raise", Some(60));
    t.act(1, "fold", None);
    t.act(2, "call", None);
    t.check_down();
    assert_eq!(t.chips(), [161, 99, 40]);
    // Now the button is seat 1: the first hole cards (aces) go to seat 1, kings to seat 2, queens to seat 0. Give the
    // short seat the best hand instead: aces to seat 2.
    let cards = aces_kings_queens();
    let top = [&cards[2..4], &cards[0..2], &cards[4..]].concat();
    t.hand(&top);
    assert_eq!(t.list("dealt"), [1, 2, 0]);
    // Seat 1 (kings) acts first, seat 2 is the small blind, seat 0 the big blind.
    t.act(1, "raise", Some(99));
    t.act(2, "call", None);
    assert_eq!(t.list("bet")[2], 40);
    t.act(0, "call", None);
    t.check_down();
    // Seat 2 takes 40 from each; the other 59 each are played for by the kings and the queens.
    let last = t.last();
    assert_eq!(last["won"].as_array().unwrap().iter().map(|chips| chips.as_u64().unwrap()).collect::<Vec<_>>(), [0, 118, 120]);
    assert_eq!(t.chips(), [62, 118, 120]);
    t.check();
}

#[test]
fn a_bet_nobody_can_call_comes_back() {
    let mut t = T::full("back", 3);
    t.hand(&aces_kings_queens());
    t.act(0, "raise", Some(60));
    t.act(1, "fold", None);
    t.act(2, "call", None);
    t.check_down();
    assert_eq!(t.chips(), [161, 99, 40]);
    t.hand(&[]);
    // Seat 1 folds, seat 2 goes all in for 40 and seat 0 puts in all its 161.
    t.act(1, "fold", None);
    t.act(2, "raise", Some(40));
    t.act(0, "raise", Some(161));
    t.check_down();
    let last = t.last();
    let won: Vec<u64> = last["won"].as_array().unwrap().iter().map(|chips| chips.as_u64().unwrap()).collect();
    // 121 of seat 0's bet met nobody: whatever the cards, it has them back.
    assert!(won[0] >= 121, "{won:?}");
    t.check();
}

#[test]
fn a_fold_must_carry_the_shares_for_the_board() {
    let mut t = T::full("fold", 3);
    t.hand(&aces_kings_queens());
    t.as_seat(0);
    assert!(refused(|| t.c.act(t.id.clone(), 0, "fold".into(), None, None, None)), "a fold before the river owes five shares");
    // Shares for the wrong cards (its own hole cards) are refused too.
    let wrong = t.shares(0, &[0, 1, 2, 3, 4]);
    assert!(refused(|| t.c.act(t.id.clone(), 0, "fold".into(), None, Some(wrong), None)));
    t.act(0, "fold", None);
    t.act(1, "call", None);
    t.act(2, "call", None);
    // The two seats left open every street without the seat that folded, to a showdown the kings win.
    assert_eq!(t.awaited(), [1, 2]);
    t.check_down();
    let last = t.last();
    assert_eq!(last["ending"], "showdown");
    assert_eq!(last["board"].as_array().unwrap().len(), 5);
    assert_eq!(last["hole"][0].as_array().unwrap().len(), 0, "the folded cards stay hidden");
    assert_eq!(t.chips(), [100, 102, 98]);
    // On the river a fold owes nothing.
    t.hand(&aces_kings_queens());
    while t.number("street") < 3 || t.phase() != "bet" {
        if t.phase() == "bet" {
            t.act(t.number("toAct"), "call", None);
        } else {
            t.duties();
        }
    }
    let seat = t.number("toAct");
    t.as_seat(seat);
    t.c.act(t.id.clone(), seat as u8, "fold".into(), None, None, None);
    t.check();
}

#[test]
fn a_seat_that_does_not_start_or_shuffle_is_only_given_up() {
    let mut t = T::full("idle", 4);
    // The button never starts the hand: it is paid its chips, the button moves on.
    t.time_out();
    assert_eq!(t.cashed(), [(0, 100)]);
    assert_eq!(t.number("button"), 1);
    assert_eq!(t.players(), [None, Some(1), Some(2), Some(3)]);
    // The second seat to shuffle never does: nobody has seen a card, so nobody loses a chip.
    let deck = t.deck_with(&[]);
    t.as_seat(1);
    t.c.shuffle(t.id.clone(), 1, Base64VecU8(deck), Base64VecU8(vec![0; PROOF_BYTES]), None);
    assert_eq!(t.awaited(), [2]);
    t.as_who(11, 0);
    assert!(refused(|| t.c.timeout(t.id.clone())), "not before the deadline");
    t.time_out();
    assert_eq!(t.last()["ending"], "cancelled");
    assert_eq!(t.cashed(), [(0, 100), (2, 100)]);
    assert_eq!(t.chips(), [0, 100, 0, 100]);
    assert_eq!(t.c.get_deck(t.id.clone(), 0, 0), None);
    t.check();
}

#[test]
fn a_seat_whose_shares_are_missing_loses_all_it_has_to_the_seats_still_in() {
    // The hole cards: seat 2 does not give its shares.
    let mut t = T::full("late-deal", 3);
    let deck = t.deck_with(&[]);
    t.shuffle(&deck);
    t.deal_one(0);
    t.deal_one(1);
    t.time_out();
    assert_eq!(t.last()["ending"], "cancelled");
    assert_eq!(t.last()["late"].as_array().unwrap().len(), 1);
    assert_eq!(t.chips(), [150, 150, 0]);
    assert_eq!(t.cashed(), [(2, 0)]);
    t.check();

    // A bet before the river: the seat owes a call or a fold, and a fold owes shares.
    let mut t = T::full("late-bet", 4);
    t.hand(&[]);
    t.act(3, "raise", Some(10));
    t.act(0, "fold", None);
    t.act(1, "call", None);
    // Seat 2 (the big blind, 2 in) never answers. Seats 1 and 3 take back their 10 and share the 100 of seat 2; seat 0
    // folded with nothing in.
    t.time_out();
    assert_eq!(t.chips(), [100, 150, 0, 150]);
    assert_eq!(t.cashed(), [(2, 0)]);
    t.check();

    // A street: one of three still in does not open the flop. The seat that folded takes back what it put in and
    // no more.
    let mut t = T::full("late-open", 4);
    t.hand(&[]);
    t.act(3, "raise", Some(5));
    t.act(0, "call", None);
    t.act(1, "call", None);
    t.act(2, "fold", None);
    assert_eq!(t.phase(), "open");
    t.open_one(0);
    t.open_one(1);
    t.time_out();
    assert_eq!(t.last()["late"][0], 3);
    assert_eq!(t.chips(), [150, 150, 100, 0]);
    t.check();

    // Nobody still in answers: there is nobody to pay, so nobody loses anything; the late seats are given up.
    let mut t = T::full("late-all", 3);
    t.hand(&[]);
    t.act(0, "call", None);
    t.act(1, "fold", None);
    t.act(2, "call", None);
    t.time_out();
    assert_eq!(t.cashed(), [(0, 100), (2, 100), (1, 100)]);
    assert!(t.settled());
    t.check();
}

impl T {
    fn flags(&self, field: &str) -> Vec<bool> {
        self.game()[field].as_array().unwrap().iter().map(|value| value.as_bool().unwrap()).collect()
    }

    /// Checks and calls, and the shares owed, up to the bets on the river.
    fn play_to_the_river(&mut self) {
        while self.number("street") < 3 || self.phase() != "bet" {
            if self.phase() == "bet" {
                self.act(self.number("toAct"), "call", None);
            } else {
                self.duties();
            }
        }
    }

    /// Everyone calls before the flop, then checks, up to the showdown.
    fn play_to_the_showdown(&mut self) {
        while self.phase() != "showdown" {
            if self.phase() == "bet" {
                self.act(self.number("toAct"), "call", None);
            } else {
                self.duties();
            }
        }
    }
}

#[test]
fn a_seat_the_hand_can_do_without_is_folded() {
    // A bet on the river: every card is open, so the hand goes on without the seat.
    let mut t = T::full("river", 3);
    t.hand(&aces_kings_queens());
    t.act(0, "raise", Some(10));
    t.act(1, "call", None);
    t.act(2, "call", None);
    t.play_to_the_river();
    assert_eq!(t.number("toAct"), 1);
    t.time_out();
    assert_eq!(t.flags("folded"), [false, true, false]);
    assert_eq!(t.number("toAct"), 2);
    t.check_down();
    assert_eq!(t.last()["ending"], "showdown");
    assert_eq!(t.chips(), [120, 0, 90]);
    assert_eq!(t.cashed(), [(1, 90)]);
    t.check();

    // The showdown: the aces never show, so the kings take the pot.
    let mut t = T::full("muck", 3);
    t.hand(&aces_kings_queens());
    t.play_to_the_showdown();
    t.show_one(1);
    t.show_one(2);
    t.time_out();
    assert_eq!(t.last()["ending"], "showdown");
    assert_eq!(t.last()["late"][0], 0);
    assert_eq!(t.chips(), [0, 104, 98]);
    assert_eq!(t.cashed(), [(0, 98)]);
    t.check();

    // Nobody shows: everyone takes back their own.
    let mut t = T::full("nobody", 2);
    t.hand(&[]);
    t.play_to_the_showdown();
    t.time_out();
    assert!(t.settled());
    assert_eq!(t.cashed(), [(0, 100), (1, 100)]);
    t.check();
}

#[test]
fn with_two_seats_the_late_one_loses_everything_as_in_heads_up() {
    let mut t = T::full("duel", 2);
    t.hand(&[]);
    t.act(0, "raise", Some(20));
    t.time_out();
    assert!(t.settled());
    assert_eq!(t.cashed(), [(1, 0), (0, 200)]);
    t.check();
}

#[test]
fn seats_are_taken_and_given_up_around_the_hands() {
    let mut t = T::new("lobby", 4);
    t.join(1);
    t.join(2);
    assert_eq!(t.phase(), "lobby");
    t.as_who(1, SEAT);
    assert!(refused(|| t.c.join(t.id.clone(), key_proof(1))), "one seat an account");
    t.as_who(1, 0);
    assert!(refused(|| t.c.start(t.id.clone())), "only the host starts");
    // In the lobby a seat that leaves gets its stake back and the seat is free again.
    t.leave(2);
    t.bought -= 1;
    assert_eq!(t.players(), [Some(0), Some(1), None, None]);
    assert!(t.cashed().is_empty());
    t.as_who(0, 0);
    t.c.start(t.id.clone());
    assert_eq!(t.phase(), "shuffle");

    // A seat taken while a hand is played is dealt in from the next hand.
    t.hand(&[]);
    assert_eq!(t.list("dealt"), [0, 1]);
    t.join(5);
    assert_eq!(t.players(), [Some(0), Some(1), Some(5), None]);
    assert_eq!(t.list("dealt"), [0, 1]);
    // A seat in the hand that leaves still plays the hand, and is paid when it is over.
    t.leave(1);
    assert_eq!(t.flags("leaving"), [false, true, false, false]);
    t.join(6);
    // A seat that is not in the hand is paid at once.
    t.leave(6);
    assert_eq!(t.cashed(), [(6, 100)]);
    t.act(0, "raise", Some(8));
    t.act(1, "fold", None);
    assert_eq!(t.cashed(), [(6, 100), (1, 98)]);
    assert_eq!(t.players(), [Some(0), None, Some(5), None]);
    assert_eq!(t.number("button"), 2);
    t.hand(&[]);
    assert_eq!(t.list("dealt"), [2, 0]);
    t.check_down();
    // Between hands a seat leaves at once; one seat is no table, so it is settled.
    t.join(7);
    t.leave(0);
    t.leave(5);
    assert!(t.settled());
    assert_eq!(t.cashed().len(), 5);
    t.check();

    // The host leaves the lobby: the table is gone and nothing is kept of it.
    let mut t = T::new("closed", 3);
    t.join(1);
    t.leave(0);
    assert!(t.settled());
    assert_eq!(t.c.get_result(t.id.clone()), None);

    // A full table starts by itself and takes nobody else until a seat is free.
    let mut t = T::full("full", 3);
    assert_eq!(t.phase(), "shuffle");
    t.as_who(8, SEAT);
    assert!(refused(|| t.c.join(t.id.clone(), key_proof(8))));
}

#[test]
fn the_table_refuses_whoever_has_no_business_there() {
    let mut t = T::full("strict", 3);
    t.as_who(11, 0);
    assert!(refused(|| t.c.timeout(t.id.clone())), "the deadline has not passed");
    let deck = t.deck_with(&[]);
    // Only the button starts a hand, and only the account in the seat plays it.
    t.as_seat(1);
    assert!(refused(|| t.c.shuffle(t.id.clone(), 1, Base64VecU8(deck.clone()), Base64VecU8(vec![0; PROOF_BYTES]), None)));
    t.as_who(1, 0);
    assert!(refused(|| t.c.shuffle(t.id.clone(), 0, Base64VecU8(deck.clone()), Base64VecU8(vec![0; PROOF_BYTES]), None)));
    // A deck shuffled under another key than the hand's is refused before its proof is looked at.
    t.as_seat(0);
    assert!(refused(|| t.c.shuffle(t.id.clone(), 0, Base64VecU8(deck.clone()), Base64VecU8(vec![0; PROOF_BYTES]), Some(Base64VecU8(key_of(0))))));
    t.shuffle(&deck);
    // A share made with another seat's key, or given twice, is refused.
    let (who, at) = (t.who(1), [0usize, 1, 4, 5]);
    workbench();
    let stored = t.c.get_deck(t.id.clone(), 0, 2).unwrap().0;
    let forged: Vec<u8> = at.iter().flat_map(|&at| share(secret(who), &key_of(who), &stored[at * CARD_BYTES..][..POINT])).collect();
    t.as_seat(0);
    assert!(refused(|| t.c.deal(t.id.clone(), 0, Base64VecU8(forged))));
    t.deal_one(0);
    assert!(refused(|| t.deal_one(0)));
    t.duties();
    // Bets: in turn, within the seat's chips, and nothing but the three words.
    assert_eq!(t.number("toAct"), 0);
    assert!(refused(|| t.act(1, "call", None)));
    assert!(refused(|| t.act(0, "raise", Some(101))));
    assert!(refused(|| t.act(0, "raise", Some(2))));
    assert!(refused(|| t.act(0, "raise", None)));
    assert!(refused(|| t.act(0, "bet", Some(10))));
    t.as_seat(0);
    assert!(refused(|| t.c.open(t.id.clone(), 0, Base64VecU8(vec![]))), "not while bets are open");
    t.act(0, "raise", Some(100));
    t.check();
    // A table id is used once.
    t.as_who(3, SEAT);
    assert!(refused(|| t.c.create_match(t.id.clone(), U128(STAKE), key_proof(3), Some(2), None)));
    t.as_who(3, SEAT);
    assert!(refused(|| t.c.create_match("ten".into(), U128(STAKE), key_proof(3), Some(10), None)), "nine seats at most");
    t.as_who(3, SEAT - 1);
    assert!(refused(|| t.c.create_match("cheap".into(), U128(STAKE), key_proof(3), Some(2), None)));
    // A key proved for another account does not seat this one.
    t.as_who(3, SEAT);
    assert!(refused(|| t.c.create_match("stolen".into(), U128(STAKE), key_proof(4), Some(2), None)));
}

#[test]
fn random_tables_keep_every_chip_accounted_for() {
    workbench();
    let mut dice = Dice(2026);
    let mut endings = std::collections::BTreeMap::<String, u32>::new();
    let (mut side_pots, mut biggest) = (0, 0);
    for round in 0..120 {
        let seats = 2 + dice.below(8) as u8;
        let mut t = T::new(&format!("r{round}"), seats);
        for who in 1..=1 + dice.below(u32::from(seats) - 1) as usize {
            t.join(who);
        }
        if t.phase() == "lobby" {
            t.as_who(0, 0);
            t.c.start(t.id.clone());
        }
        let mut hand = 0;
        for step in 0..4_000 {
            if t.settled() {
                break;
            }
            // After a while everyone asks to leave, so that the table closes.
            let closing = step > 3_000;
            let players = t.players();
            let roll = dice.below(2_000);
            if roll < 10 && !closing {
                if let (Some(who), true) = ((0..11).find(|who| !players.contains(&Some(*who))), players.contains(&None)) {
                    t.join(who);
                }
            } else if roll < 20 || (closing && roll < 300) {
                let seated: Vec<usize> = players.iter().flatten().copied().collect();
                t.leave(seated[dice.below(seated.len() as u32) as usize]);
            } else if roll < 35 {
                t.time_out();
            } else {
                let awaited = t.awaited();
                assert!(!awaited.is_empty(), "a table under way always waits for somebody");
                let seat = awaited[dice.below(awaited.len() as u32) as usize];
                match t.phase().as_str() {
                    "shuffle" => {
                        // Only the last deck is dealt from; the ones before it need only be decks.
                        let taken = if t.number("shuffled") == 0 { players.iter().flatten().count() } else { t.list("dealt").len() };
                        let deck = if t.number("shuffled") + 1 == taken { t.deck_with(&dice.order()[..23]) } else { open_deck() };
                        t.as_seat(seat);
                        t.c.shuffle(t.id.clone(), seat as u8, Base64VecU8(deck), Base64VecU8(vec![0; PROOF_BYTES]), None);
                    }
                    "bet" => {
                        let (bets, chips) = (t.list("bet"), t.chips());
                        assert!(!t.flags("folded")[seat] && chips[seat] > 0, "the seat to act can act");
                        let (top, all) = (*bets.iter().max().unwrap(), bets[seat] + chips[seat]);
                        let roll = dice.below(100);
                        if roll < 15 {
                            t.act(seat, "fold", None);
                        } else if roll < 65 || all <= top {
                            t.act(seat, "call", None);
                        } else {
                            let to = if dice.below(4) == 0 || all - top < 2 { all } else { all.min(top + 2 + dice.below(40) as usize) };
                            t.act(seat, "raise", Some(to as u32));
                        }
                    }
                    _ => t.duty(seat),
                }
            }
            t.check();
            if !t.settled() && t.number("hand") > hand {
                hand = t.number("hand");
                let last = t.last();
                let list = |field: &str| last[field].as_array().unwrap().iter().map(|chips| chips.as_u64().unwrap()).collect::<Vec<_>>();
                let (put, won) = (list("put"), list("won"));
                let ending = last["ending"].as_str().unwrap().to_string();
                assert_ne!(ending, "void");
                if ending != "cancelled" {
                    assert_eq!(put.iter().sum::<u64>(), won.iter().sum::<u64>());
                }
                if ending == "showdown" {
                    // The pots again, by the other way of working them out, from the cards the table shows.
                    let cards = |value: &Value| value.as_array().unwrap().iter().map(|card| card.as_u64().unwrap() as u8).collect::<Vec<_>>();
                    let (board, folded) = (cards(&last["board"]), last["folded"].as_array().unwrap());
                    let dealt = list("dealt");
                    let score: Vec<Option<u32>> = (0..put.len())
                        .map(|seat| {
                            let hole = cards(&last["hole"][seat]);
                            (dealt.contains(&(seat as u64)) && !folded[seat].as_bool().unwrap()).then(|| rank7([hole[0], hole[1], board[0], board[1], board[2], board[3], board[4]]))
                        })
                        .collect();
                    let order: Vec<usize> = (1..=dealt.len()).map(|place| dealt[place % dealt.len()] as usize).filter(|&seat| score[seat].is_some()).collect();
                    let stakes: Vec<u32> = put.iter().map(|&chips| chips as u32).collect();
                    assert_eq!(won.iter().map(|&chips| chips as u32).collect::<Vec<_>>(), peeled(&stakes, &score, &order));
                    if won.iter().filter(|&&chips| chips > 0).count() > 1 {
                        side_pots += 1;
                    }
                }
                biggest = biggest.max(put.iter().sum::<u64>());
                *endings.entry(ending).or_default() += 1;
            }
        }
        assert!(t.settled(), "table {round} never closed");
        t.check();
    }
    // The dice did reach every way a hand can end.
    eprintln!("hands by ending: {endings:?}; showdowns paying more than one seat: {side_pots}; biggest pot: {biggest}");
    assert!(endings["fold"] > 100 && endings["showdown"] > 100 && endings["cancelled"] > 10 && side_pots > 30);
}

#[test]
fn the_owner_s_fee_is_a_part_of_what_a_seat_won_and_a_table_keeps_the_fee_it_was_opened_with() {
    let yocto = |value: &Value| value.as_str().unwrap().parse::<u128>().unwrap();
    // No fee to start with: the aces take both stakes whole.
    let aces_win_all = |t: &mut T| {
        t.hand(&[card(12, 0), card(12, 1), card(11, 0), card(11, 1), card(0, 2), card(5, 3), card(7, 2), card(2, 3), card(3, 0)]);
        t.act(0, "raise", Some(100));
        t.act(1, "call", None);
        t.duties();
        assert!(t.settled());
    };
    let mut t = T::full("free", 2);
    assert_eq!(t.game()["feeBps"], 0);
    aces_win_all(&mut t);
    let result = t.c.get_result(t.id.clone()).unwrap();
    assert_eq!(yocto(&result["cashed"][1]["payout"]), 2 * STAKE);
    assert_eq!(yocto(&t.c.get_config()["fees"]), 0);
    t.as_who(9, 1);
    assert!(refused(|| {
        let _ = t.c.withdraw_fees();
    }), "nothing to withdraw, and not for anybody");

    // Only the owner sets the fee, with one yoctoNEAR, and not above 5%.
    t.as_who(3, 1);
    assert!(refused(|| t.c.set_fee(250)));
    context(OWNER, 0, t.now);
    assert!(refused(|| t.c.set_fee(250)));
    context(OWNER, 1, t.now);
    assert!(refused(|| t.c.set_fee(501)));
    // A table opened before the change keeps its fee; one opened after has the new one.
    t.id = "before".into();
    t.as_who(0, SEAT);
    t.c.create_match("before".into(), U128(STAKE), key_proof(0), Some(2), None);
    context(OWNER, 1, t.now);
    t.c.set_fee(250);
    t.join(1);
    assert_eq!(t.game()["feeBps"], 0);
    aces_win_all(&mut t);
    assert_eq!(yocto(&t.c.get_config()["fees"]), 0);
    t.id = "after".into();
    t.as_who(0, SEAT);
    t.c.create_match("after".into(), U128(STAKE), key_proof(0), Some(2), None);
    t.join(1);
    assert_eq!(t.game()["feeBps"], 250);
    aces_win_all(&mut t);
    // The winner leaves with 200 chips: 100 of them won, 2.5% of which is the fee. The loser pays nothing.
    let result = t.c.get_result(t.id.clone()).unwrap();
    let fee = STAKE / 40;
    assert_eq!(result["cashed"][0]["chips"], 0);
    assert_eq!((yocto(&result["cashed"][0]["payout"]), yocto(&result["cashed"][0]["fee"])), (0, 0));
    assert_eq!((yocto(&result["cashed"][1]["payout"]), yocto(&result["cashed"][1]["fee"])), (2 * STAKE - fee, fee));
    assert_eq!(yocto(&t.c.get_config()["fees"]), fee);
    // The owner withdraws exactly the fees, once.
    t.as_who(1, 1);
    assert!(refused(|| {
        let _ = t.c.withdraw_fees();
    }));
    context(OWNER, 1, t.now);
    assert_eq!(t.c.withdraw_fees().0, fee);
    assert_eq!(yocto(&t.c.get_config()["fees"]), 0);
    context(OWNER, 1, t.now);
    assert!(refused(|| {
        let _ = t.c.withdraw_fees();
    }));
    // A seat that leaves with what it bought, or less, pays no fee; a contract cannot start above 5%.
    assert_eq!(crate::fee_of(NearToken::from_yoctonear(STAKE), 100, 500), (STAKE, 0));
    assert_eq!(crate::fee_of(NearToken::from_yoctonear(STAKE), 37, 500), (STAKE / 100 * 37, 0));
    assert_eq!(crate::fee_of(NearToken::from_yoctonear(STAKE), 900, 500), (9 * STAKE - STAKE * 8 / 20, STAKE * 8 / 20));
    assert!(refused(|| {
        let _ = Contract::new(OWNER.parse().unwrap(), 501);
    }));
}

#[test]
fn with_a_fee_every_yocto_is_paid_out_or_is_the_owner_s() {
    FEE.with(|fee| fee.set(500));
    let mut dice = Dice(99);
    let mut t = T::full("fees", 6);
    for _ in 0..600 {
        if t.settled() {
            break;
        }
        let awaited = t.awaited();
        let seat = awaited[dice.below(awaited.len() as u32) as usize];
        match t.phase().as_str() {
            "shuffle" => {
                let deck = t.deck_with(&dice.order()[..17]);
                t.shuffle(&deck);
            }
            "bet" => {
                let (bets, chips) = (t.list("bet"), t.chips());
                let (top, all) = (*bets.iter().max().unwrap(), bets[seat] + chips[seat]);
                if dice.below(3) == 0 && all > top {
                    t.act(seat, "raise", Some(all as u32));
                } else {
                    t.act(seat, "call", None);
                }
            }
            _ => t.duty(seat),
        }
    }
    assert!(t.settled(), "all-ins end a table soon");
    let result = t.c.get_result(t.id.clone()).unwrap();
    let yocto = |value: &Value| value.as_str().unwrap().parse::<u128>().unwrap();
    let lines = result["cashed"].as_array().unwrap();
    let (paid, fees): (u128, u128) = lines.iter().fold((0, 0), |(paid, fees), line| (paid + yocto(&line["payout"]), fees + yocto(&line["fee"])));
    assert_eq!(paid + fees, 6 * STAKE);
    assert_eq!(yocto(&t.c.get_config()["fees"]), fees);
    assert!(fees > 0 && fees <= 5 * STAKE / 20);
    t.check();
}

#[test]
fn a_bet_sent_twice_is_made_once() {
    // Three seats: seat 0 has the button and acts first before the flop.
    let mut t = T::full("twice", 3);
    t.hand(&[]);
    let chosen = t.number("bets") as u32;
    t.as_seat(0);
    t.c.act(t.id.clone(), 0, "call".into(), None, None, Some(chosen));
    // The node did not answer and the page sent the same call again; meanwhile the small blind raised.
    t.act(1, "raise", Some(10));
    t.act(2, "call", None);
    assert_eq!(t.number("toAct"), 0);
    t.as_seat(0);
    assert!(refused(|| t.c.act(t.id.clone(), 0, "call".into(), None, None, Some(chosen))), "the second copy must not call a raise its seat never saw");
    // Sent without the count, the same copy would have been taken as a call of the raise: that is what the count is for.
    assert_eq!(t.list("bet"), [2, 10, 10]);
    // The seat's own answer to the raise, chosen now, goes through.
    let now = t.number("bets") as u32;
    t.as_seat(0);
    t.c.act(t.id.clone(), 0, "call".into(), None, None, Some(now));
    assert_eq!(t.phase(), "open");
    t.check();
}

impl T {
    /// One thing the table waits for, done by the seat it waits for: a deck, a share, or a check or call.
    fn step_once(&mut self) {
        let seat = self.awaited()[0];
        match self.phase().as_str() {
            "shuffle" => {
                let deck = self.deck_with(&[]);
                self.as_seat(seat);
                self.c.shuffle(self.id.clone(), seat as u8, Base64VecU8(deck), Base64VecU8(vec![0; PROOF_BYTES]), None);
            }
            "bet" => {
                let seat = self.number("toAct");
                self.act(seat, "call", None);
            }
            _ => self.duty(seat),
        }
    }

    fn done_count(&self) -> usize {
        self.flags("done").iter().filter(|&&done| done).count()
    }
}

#[test]
fn a_seat_that_stops_anywhere_never_leaves_money_stuck() {
    let yocto = |value: &Value| value.as_str().unwrap().parse::<u128>().unwrap();
    type Reached = fn(&T) -> bool;
    let states: [(&str, Reached); 9] = [
        ("the first shuffle of the table", |t| t.phase() == "shuffle" && t.number("shuffled") == 0),
        ("a later shuffle", |t| t.phase() == "shuffle" && t.number("shuffled") == 1),
        ("the deal", |t| t.phase() == "deal" && t.done_count() >= 1),
        ("a bet before the flop", |t| t.phase() == "bet" && t.number("street") == 0),
        ("opening the flop", |t| t.phase() == "open" && t.number("street") == 1 && t.done_count() >= 1),
        ("a bet on the turn", |t| t.phase() == "bet" && t.number("street") == 2),
        ("a bet on the river", |t| t.phase() == "bet" && t.number("street") == 3),
        ("the showdown", |t| t.phase() == "showdown" && t.done_count() >= 1),
        ("between two hands", |t| t.phase() == "shuffle" && t.number("shuffled") == 0 && t.number("hand") == 1),
    ];
    FEE.with(|fee| fee.set(250));
    for seats in [2u8, 3, 9] {
        for (index, (name, reached)) in states.into_iter().enumerate() {
            let mut t = T::full(&format!("stop-{seats}-{index}"), seats);
            let mut steps = 0;
            while !reached(&t) {
                t.step_once();
                steps += 1;
                assert!(steps < 500 && !t.settled(), "{seats} seats never reached {name}");
            }
            // The seat the table waits for stops answering. Before the deadline nobody can do anything about it.
            let (late, seq, hand) = (t.awaited()[0], t.number("seq"), t.number("hand"));
            let late_account = t.who(late);
            t.as_who(11, 0);
            assert!(refused(|| t.c.timeout(t.id.clone())), "{seats} seats, {name}: time called too early");
            // After it, anybody can, and the table moves on.
            t.time_out();
            t.check();
            assert!(t.settled() || t.number("seq") > seq, "{seats} seats, {name}: calling time changed nothing");
            assert!(t.settled() || t.number("hand") > hand || !t.awaited().contains(&late), "{seats} seats, {name}: the table still waits for the late seat");
            // Everyone else plays on and leaves; the late seat never answers again.
            for _ in 0..3_000 {
                if t.settled() {
                    break;
                }
                let players = t.players();
                if t.phase() == "shuffle" && t.number("shuffled") == 0 {
                    for who in players.iter().flatten().copied().filter(|&who| who != late_account) {
                        if !t.settled() && t.players().contains(&Some(who)) {
                            t.leave(who);
                        }
                    }
                    continue;
                }
                let waiting = t.awaited();
                if waiting.iter().any(|&seat| players[seat] == Some(late_account)) {
                    t.time_out();
                } else {
                    t.step_once();
                }
                t.check();
            }
            assert!(t.settled(), "{seats} seats, {name}: the table never closed");
            // Every yoctoNEAR staked was paid out, or is the owner's fee, and the contract counts exactly that fee.
            let result = t.c.get_result(t.id.clone()).unwrap();
            let lines = result["cashed"].as_array().unwrap();
            let (paid, fees) = lines.iter().fold((0u128, 0u128), |(paid, fees), line| (paid + yocto(&line["payout"]), fees + yocto(&line["fee"])));
            assert_eq!(paid + fees, u128::from(t.bought) * STAKE, "{seats} seats, {name}");
            assert_eq!(yocto(&t.c.get_config()["fees"]), fees, "{seats} seats, {name}");
            assert_eq!(lines.len() as u32, t.bought, "{seats} seats, {name}: every seat was paid once");
            assert!(lines.iter().any(|line| line["account"] == name_of(late_account)), "{seats} seats, {name}: the late seat was given up");
        }
    }
    FEE.with(|fee| fee.set(0));
}

fn name_of(who: usize) -> String {
    name(who)
}

#[test]
fn whatever_the_stacks_the_hand_always_has_a_seat_to_wait_for() {
    // Short stacks put the blinds all in at once, and seats all in leave fewer to bet: the two places that pick the
    // next seat to bet (after the deal, after a bet) must always find one. The stacks are set by hand here, so chips
    // are not counted: only that no call fails and the table always waits for somebody until it closes.
    let mut dice = Dice(4242);
    for round in 0..150 {
        let seats = 2 + dice.below(8) as u8;
        let mut t = T::full(&format!("short-{round}"), seats);
        let stacks = [2u32, 3, 4, 5, 100];
        let mut m = t.c.matches.get(&t.id).cloned().unwrap();
        for seat in 0..usize::from(seats) {
            m.chips[seat] = stacks[dice.below(stacks.len() as u32) as usize];
        }
        t.c.matches.insert(t.id.clone(), m);
        for _ in 0..400 {
            if t.settled() {
                break;
            }
            let awaited = t.awaited();
            assert!(!awaited.is_empty(), "round {round}: a table under way waits for nobody");
            let seat = awaited[dice.below(awaited.len() as u32) as usize];
            match t.phase().as_str() {
                "shuffle" => t.step_once(),
                "bet" => {
                    let (bets, chips) = (t.list("bet"), t.chips());
                    let (top, all) = (*bets.iter().max().unwrap(), bets[seat] + chips[seat]);
                    match dice.below(4) {
                        0 => t.act(seat, "fold", None),
                        1 if all > top => t.act(seat, "raise", Some(all as u32)),
                        2 if all > top + 2 => t.act(seat, "raise", Some(top as u32 + 2)),
                        _ => t.act(seat, "call", None),
                    }
                }
                _ => t.duty(seat),
            }
        }
        assert!(t.settled() || t.number("hand") > 0, "round {round}: no hand was ever finished");
    }
}

// ----- Free tables ---------------------------------------------------------------------------------------------------

/// What the contract's last call sent, and to whom, in yoctoNEAR.
fn transfers() -> Vec<(String, u128)> {
    near_sdk::test_utils::get_created_receipts()
        .iter()
        .flat_map(|receipt| {
            receipt.actions.iter().filter_map(move |action| match action {
                near_sdk::mock::MockAction::Transfer { deposit, .. } => Some((receipt.receiver_id.to_string(), deposit.as_yoctonear())),
                _ => None,
            })
        })
        .collect()
}

impl T {
    /// A free table of `seats` seats, opened by account 0, which owns the contract.
    fn free(id: &str, seats: u8) -> T {
        TRUSTING.with(|trusting| trusting.set(true));
        let now = 1_000 * SECOND;
        context("poker.test", 0, now);
        let mut t = T { c: Contract::new(name(0).parse().unwrap(), 0), now, id: id.into(), bought: 1 };
        t.as_who(0, FREE_TABLE_DEPOSIT);
        t.c.create_match(id.into(), U128(0), key_proof(0), Some(seats), None);
        t
    }

    /// Account `who` takes a seat of a free table: nothing is attached.
    fn sit(&mut self, who: usize) {
        self.as_who(who, 0);
        self.c.join(self.id.clone(), key_proof(who));
        self.bought += 1;
    }
}

#[test]
fn only_the_owner_s_own_accounts_open_a_free_table_and_they_leave_a_deposit() {
    let mut t = T::free("free", 2);
    assert_eq!(t.game()["stake"], "0");
    assert_eq!(t.game()["deposit"], "0", "a seat costs nothing");
    // Anybody else is refused a stake of nothing, whatever they attach; a stake is still 0.1 NEAR at least.
    for deposit in [0, RECORD_FEE, FREE_TABLE_DEPOSIT] {
        t.as_who(1, deposit);
        assert!(refused(|| t.c.create_match("mine".into(), U128(0), key_proof(1), Some(2), None)));
    }
    t.as_who(1, 1 + RECORD_FEE);
    assert!(refused(|| t.c.create_match("mine".into(), U128(1), key_proof(1), Some(2), None)));
    // The owner leaves the deposit: no less, no more.
    for deposit in [0, RECORD_FEE, FREE_TABLE_DEPOSIT - 1, FREE_TABLE_DEPOSIT + 1] {
        t.as_who(0, deposit);
        assert!(refused(|| t.c.create_match("again".into(), U128(0), key_proof(0), Some(2), None)));
    }
    // An account named under the owner is the owner's too. One whose name only ends like the owner's is not.
    context("house.p0.test", FREE_TABLE_DEPOSIT, t.now + SECOND);
    t.c.create_match("house".into(), U128(0), key_proof_as("house.p0.test", 5), Some(3), None);
    assert_eq!(t.c.get_match("house".into()).unwrap()["host"], "house.p0.test");
    context("xp0.test", FREE_TABLE_DEPOSIT, t.now + 2 * SECOND);
    assert!(refused(|| t.c.create_match("fake".into(), U128(0), key_proof_as("xp0.test", 6), Some(2), None)));
    // The owner's paid tables are tables like any other.
    t.as_who(0, SEAT);
    t.c.create_match("paid".into(), U128(STAKE), key_proof(0), Some(2), None);
    assert_eq!(t.c.get_match("paid".into()).unwrap()["deposit"], SEAT.to_string());
}

#[test]
fn a_free_table_costs_its_seats_nothing_and_pays_them_nothing() {
    let mut t = T::free("free", 2);
    // A seat attaches nothing: a yocto, or the price of a paid seat, is refused.
    for deposit in [1, RECORD_FEE, SEAT] {
        t.as_who(1, deposit);
        assert!(refused(|| t.c.join(t.id.clone(), key_proof(1))));
    }
    t.sit(1);
    assert_eq!(t.phase(), "shuffle", "the last seat taken starts the table");
    assert!(transfers().is_empty());
    // The hand of `two_seats_play_as_heads_up`: the kings lose every chip to the aces.
    t.hand(&[card(12, 0), card(12, 1), card(11, 0), card(11, 1), card(0, 2), card(5, 3), card(7, 2), card(2, 3), card(3, 0)]);
    t.act(0, "raise", Some(10));
    t.act(1, "call", None);
    t.duties();
    t.act(1, "call", None);
    t.act(0, "raise", Some(90));
    t.act(1, "call", None);
    t.duties();
    assert!(t.settled());
    // Chips were only chips: nobody is paid for them. The host's deposit comes back, less the two lines of the summary.
    assert_eq!(transfers(), [(name(0), FREE_TABLE_DEPOSIT - 2 * RECORD_FEE)]);
    assert_eq!(t.cashed(), [(1, 0), (0, 200)]);
    let result = t.c.get_result(t.id.clone()).unwrap();
    assert_eq!(result["stake"], "0");
    assert!(result["cashed"].as_array().unwrap().iter().all(|line| line["payout"] == "0" && line["fee"] == "0"));
    assert_eq!(t.c.get_config()["fees"], "0");
    t.check();
}

#[test]
fn a_free_table_that_never_starts_gives_the_host_all_of_its_deposit_back() {
    let mut t = T::free("lobby", 3);
    t.sit(1);
    // A guest that leaves the lobby paid nothing and gets nothing.
    t.leave(1);
    t.bought -= 1;
    assert!(transfers().is_empty());
    assert_eq!(t.players(), [Some(0), None, None]);
    t.sit(2);
    // The host closes the table: nothing is kept of it, and nobody else is sent anything.
    t.leave(0);
    assert_eq!(transfers(), [(name(0), FREE_TABLE_DEPOSIT)]);
    assert!(t.settled());
    assert!(t.c.get_result(t.id.clone()).is_none());
}

#[test]
fn a_free_table_seats_only_as_many_as_its_deposit_can_record() {
    let mut t = T::free("busy", 3);
    t.sit(1);
    t.as_who(0, 0);
    t.c.start(t.id.clone());
    // Accounts come and go between hands: each leaves a line in the summary, which the host's deposit pays for.
    // The same few accounts, again and again: a sitting counts, whoever it is.
    for sitting in 2..MAX_FREE_SITTINGS {
        let who = 2 + sitting % 5;
        t.sit(who);
        t.leave(who);
        assert!(transfers().is_empty(), "100 chips of a free table are worth nothing");
    }
    assert_eq!(t.cashed().len(), MAX_FREE_SITTINGS - 2);
    t.as_who(2, 0);
    assert!(refused(|| t.c.join(t.id.clone(), key_proof(2))), "the table has seated all it can");
    // The table ends: every line is paid for, and what is left still covers what the table stored while it was open.
    t.leave(1);
    assert!(t.settled());
    let back = FREE_TABLE_DEPOSIT - MAX_FREE_SITTINGS as u128 * RECORD_FEE;
    assert_eq!(transfers(), [(name(0), back)]);
    assert!(back >= 16_000 * 10u128.pow(19), "16 KB of storage at 1 NEAR per 100 KB");
    t.check();
}

