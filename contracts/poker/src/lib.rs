//! Deedlords Poker NEAR contract: heads-up Texas Hold'em with no dealer. The contract is the referee, the bank and the
//! public notice board; it never sees a secret.
//!
//! * A match is two seats with the same stake, 100 chips each, blinds 1 and 2, played hand after hand until a seat
//!   cannot post the big blind, leaves between hands, or runs out of time.
//! * Cards are ElGamal ciphertexts over BN254 G1 under the sum of both seats' keys (card `i` is the point `(i+1)·G`).
//!   Each seat proves it knows its key when it sits down (Schnorr), so the summed key belongs to nobody alone.
//! * A hand: each seat shuffles and re-encrypts the deck in turn (`shuffle`); each gives the other its share of the
//!   decryption of the other's two hole cards (`deal`); bets (`act`); both give their shares for the board cards of a
//!   street (`open`), and for their own hole cards at the end (`show`). Every share comes with a Chaum-Pedersen proof
//!   checked here with the chain's curve functions, so a wrong share is refused on the spot.
//! * Shuffles are checked after the hand, before any chip moves: each seat opens its order and its randomness
//!   (`audit`) and the contract recomputes its deck. A seat that cannot open an honest shuffle runs out of time and
//!   forfeits the whole match. This shows every card of a finished hand, folded ones too.
//! * Each step has a deadline. After it anyone may call `timeout`: the seat that was awaited loses everything on the
//!   table, so nobody gains by stalling.

mod cards;
mod curve;
#[cfg(test)]
mod tests;

use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise};

use curve::{add, generator, mul, sum, POINT, SCALAR};

pub const CHIPS: u32 = 100;
pub const SMALL_BLIND: u32 = 1;
pub const BIG_BLIND: u32 = 2;
pub const DEFAULT_TURN_SECONDS: u32 = 120;
pub const MAX_TURN_SECONDS: u32 = 86_400;
pub const MAX_ID_LEN: usize = 32;
pub const DECK: usize = 52;
/// A card in a deck: C1 ‖ C2.
const CARD_BYTES: usize = 2 * POINT;
pub const DECK_BYTES: usize = DECK * CARD_BYTES;
/// What a seat sends to sit down: key ‖ R ‖ z.
pub const KEY_BYTES: usize = 2 * POINT + SCALAR;
/// A decryption share: token ‖ A ‖ B ‖ z.
pub const TOKEN_BYTES: usize = 3 * POINT + SCALAR;
/// A shuffle opened: where each of the 52 cards came from, then the 52 scalars it was re-encrypted with.
pub const OPENING_BYTES: usize = DECK * (1 + SCALAR);
/// Deck positions used by a hand: 0-1 are seat 0's hole cards, 2-3 seat 1's, 4-8 the board.
const DEALT: usize = 9;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Lobby,
    Shuffle,
    Deal,
    Bet,
    Open,
    Showdown,
    Audit,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    /// The seat that takes the pot, by a fold or at the showdown.
    Won(u8),
    Split,
    /// A position did not decrypt to a card: every chip put in goes back, and the audit finds who shuffled falsely.
    Void,
}

/// The hand before this one, kept so both seats can see how it ended.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Hand {
    pub number: u32,
    pub board: Vec<u8>,
    pub hole: Vec<Vec<u8>>,
    pub outcome: Outcome,
    pub pot: u32,
}

/// Full state of an unfinished match. Deleted when the match is settled.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Match {
    pub stake: NearToken,
    pub players: Vec<AccountId>,
    /// Each seat's ElGamal public key.
    pub keys: Vec<Vec<u8>>,
    pub turn_seconds: u32,
    /// Nanoseconds; 0 in the lobby.
    pub deadline: u64,
    /// Chips behind each seat, not counting what it put into this hand.
    pub chips: [u32; 2],
    /// Hands finished so far. Seat `hand % 2` has the button: it shuffles first, posts the small blind and acts
    /// first before the flop; the other seat acts first after it.
    pub hand: u32,
    pub phase: Phase,
    /// Shuffles stored for this hand (0..=2).
    pub shuffled: u8,
    /// 0 before the flop, 1 flop, 2 turn, 3 river.
    pub street: u8,
    pub to_act: u8,
    /// Chips each seat put into this hand, and how many of them on this street.
    pub put: [u32; 2],
    pub bet: [u32; 2],
    /// In `Bet`: the seat has acted since the last raise. In the two-sided phases: the seat has done its part.
    pub done: [bool; 2],
    /// Decryption shares, at `seat * 9 + position`; empty until given.
    pub tokens: Vec<Vec<u8>>,
    pub board: Vec<u8>,
    /// Hole cards shown at the showdown.
    pub hole: Vec<Vec<u8>>,
    pub outcome: Option<Outcome>,
    pub last: Option<Hand>,
    /// Counts the changes stored for this match. A public RPC may answer from a node that is a block behind, so a
    /// reader keeps the view with the highest number.
    pub seq: u32,
}

/// Permanent summary of a settled match.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct MatchResult {
    pub stake: NearToken,
    pub players: Vec<AccountId>,
    pub chips: [u32; 2],
    pub payouts: Vec<NearToken>,
    pub hands: u32,
    pub reason: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    /// Unfinished matches (lobby or playing).
    matches: IterableMap<String, Match>,
    /// The deck after each shuffle of the hand under way, under `<match id>/<hand>/<0|1>`. The second one is the deck
    /// dealt. The hand is in the key so that a reader a block behind gets no deck rather than the last hand's.
    decks: LookupMap<String, Vec<u8>>,
    results: LookupMap<String, MatchResult>,
}

fn deck_key(id: &str, hand: u32, step: u8) -> String {
    format!("{id}/{hand}/{step}")
}

/// The 52 card points: card `i` is `(i + 1)·G`.
fn card_points() -> Vec<Vec<u8>> {
    let g = generator();
    let mut points = vec![g.to_vec()];
    for i in 1..DECK {
        points.push(add(&points[i - 1], &g));
    }
    points
}

/// The deck nobody has shuffled yet: every card in order, in the clear (C1 is the point at infinity).
fn open_deck() -> Vec<u8> {
    card_points().iter().flat_map(|point| [&[0u8; POINT][..], point.as_slice()].concat()).collect()
}

/// The key a seat sits down with, once its proof of knowing the secret key holds.
fn checked_key(key: &[u8]) -> Vec<u8> {
    require!(key.len() == KEY_BYTES, "key must be 160 bytes: the key, then the proof");
    let (key, proof) = key.split_at(POINT);
    require!(curve::knows_key(env::predecessor_account_id().as_str(), key, proof), "the proof does not show that you know this key");
    key.to_vec()
}

impl Match {
    fn button(&self) -> usize {
        (self.hand % 2) as usize
    }

    fn restart_clock(&mut self) {
        self.deadline = env::block_timestamp() + u64::from(self.turn_seconds) * 1_000_000_000;
    }

    fn new_hand(&mut self) {
        self.phase = Phase::Shuffle;
        self.shuffled = 0;
        self.street = 0;
        self.put = [0; 2];
        self.bet = [0; 2];
        self.done = [false; 2];
        self.tokens = vec![vec![]; 2 * DEALT];
        self.board = vec![];
        self.hole = vec![vec![], vec![]];
        self.outcome = None;
    }

    fn pay(&mut self, seat: usize, chips: u32) {
        self.chips[seat] -= chips;
        self.bet[seat] += chips;
        self.put[seat] += chips;
    }

    /// A street's bets are matched: the next board cards, or the showdown after the river.
    fn after_bets(&mut self) {
        self.bet = [0; 2];
        self.done = [false; 2];
        if self.street == 3 {
            self.phase = Phase::Showdown;
        } else {
            self.street += 1;
            self.phase = Phase::Open;
        }
    }

    /// A street's cards are on the board: bets, unless a seat is all in and there is nothing left to bet.
    fn after_open(&mut self) {
        if self.chips.contains(&0) {
            self.after_bets();
        } else {
            self.done = [false; 2];
            self.phase = Phase::Bet;
            self.to_act = 1 - self.button() as u8;
        }
    }

    fn end_hand(&mut self, outcome: Outcome) {
        self.outcome = Some(outcome);
        self.phase = Phase::Audit;
        self.done = [false; 2];
    }

    /// The seats the match is waiting for.
    fn awaited(&self) -> Vec<usize> {
        match self.phase {
            Phase::Lobby => vec![],
            Phase::Shuffle => vec![(self.button() + usize::from(self.shuffled)) % 2],
            Phase::Bet => vec![usize::from(self.to_act)],
            _ => (0..2).filter(|&seat| !self.done[seat]).collect(),
        }
    }

    /// The card at deck position `at`, from both seats' shares: C2 − T0 − T1, looked up among the card points. `None`
    /// when that is no card at all, which only a false shuffle can cause.
    fn card_at(&self, deck: &[u8], points: &[Vec<u8>], at: usize) -> Option<u8> {
        let c2 = &deck[at * CARD_BYTES + POINT..(at + 1) * CARD_BYTES];
        let point = sum(&[(false, c2), (true, &self.tokens[at]), (true, &self.tokens[DEALT + at])]);
        points.iter().position(|card| *card == point).map(|card| card as u8)
    }

    /// Stores `seat`'s shares for the deck positions `at`, each checked against the seat's key.
    fn take_tokens(&mut self, deck: &[u8], seat: usize, at: &[usize], tokens: &[u8]) {
        require!(tokens.len() == at.len() * TOKEN_BYTES, "send one 224-byte share (token, then its proof) per card");
        for (share, &at) in tokens.chunks(TOKEN_BYTES).zip(at) {
            let (token, proof) = share.split_at(POINT);
            let c1 = &deck[at * CARD_BYTES..at * CARD_BYTES + POINT];
            require!(curve::same_key(&self.keys[seat], c1, token, proof), "a share was not made with this seat's key");
            self.tokens[seat * DEALT + at] = token.to_vec();
        }
    }

    fn view(&self, id: &str) -> Value {
        let bytes = |list: &[Vec<u8>]| list.iter().map(|item| Base64VecU8(item.clone())).collect::<Vec<_>>();
        json!({
            "id": id,
            "phase": self.phase,
            "stake": U128(self.stake.as_yoctonear()),
            "players": self.players,
            "keys": bytes(&self.keys),
            "turnSeconds": self.turn_seconds,
            "deadline": U64(self.deadline),
            "chips": self.chips,
            "hand": self.hand,
            "button": self.button(),
            "shuffled": self.shuffled,
            "street": self.street,
            "toAct": self.to_act,
            "awaited": self.awaited(),
            "put": self.put,
            "bet": self.bet,
            "done": self.done,
            "tokens": bytes(&self.tokens),
            "board": self.board,
            "hole": self.hole,
            "outcome": self.outcome,
            "last": self.last,
            "seq": self.seq,
        })
    }
}

#[near]
impl Contract {
    #[init]
    #[private]
    pub fn new() -> Self {
        Contract { matches: IterableMap::new(b"m"), decks: LookupMap::new(b"d"), results: LookupMap::new(b"r") }
    }

    /// Opens a match and takes seat 0. The attached deposit is the stake, worth 100 chips.
    #[payable]
    pub fn create_match(&mut self, id: String, stake: U128, key: Base64VecU8, turn_seconds: Option<u32>) {
        require!(!id.is_empty() && id.len() <= MAX_ID_LEN, "match id must be 1..=32 characters");
        require!(id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'), "match id may only contain ASCII letters, digits, '-' and '_'");
        require!(!self.matches.contains_key(&id) && !self.results.contains_key(&id), "this match id was already used");
        let turn_seconds = turn_seconds.unwrap_or(DEFAULT_TURN_SECONDS);
        require!((5..=MAX_TURN_SECONDS).contains(&turn_seconds), "turn_seconds must be 5..=86400");
        require!(stake.0 > 0 && stake.0 % u128::from(CHIPS) == 0, "the stake must be a positive multiple of 100 yoctoNEAR");
        let stake = NearToken::from_yoctonear(stake.0);
        require!(env::attached_deposit() == stake, "attach exactly the stake");
        let mut m = Match {
            stake,
            players: vec![env::predecessor_account_id()],
            keys: vec![checked_key(&key.0)],
            turn_seconds,
            deadline: 0,
            chips: [CHIPS; 2],
            hand: 0,
            phase: Phase::Lobby,
            shuffled: 0,
            street: 0,
            to_act: 0,
            put: [0; 2],
            bet: [0; 2],
            done: [false; 2],
            tokens: vec![],
            board: vec![],
            hole: vec![],
            outcome: None,
            last: None,
            seq: 0,
        };
        m.new_hand();
        m.phase = Phase::Lobby;
        self.save(id, m);
    }

    /// Takes seat 1 with the same stake; the first hand starts.
    #[payable]
    pub fn join(&mut self, id: String, key: Base64VecU8) {
        let mut m = self.matches.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such match"));
        require!(m.phase == Phase::Lobby, "the match has started");
        require!(env::attached_deposit() == m.stake, "attach exactly the stake");
        m.players.push(env::predecessor_account_id());
        m.keys.push(checked_key(&key.0));
        m.phase = Phase::Shuffle;
        m.restart_clock();
        self.save(id, m);
    }

    /// In the lobby the creator takes the stake back. Between hands (before the first shuffle of a hand) either seat
    /// may end the match: both are paid the chips they hold.
    pub fn leave(&mut self, id: String) {
        let m = self.matches.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such match"));
        require!(m.players.contains(&env::predecessor_account_id()), "only an account in a seat may leave");
        if m.phase == Phase::Lobby {
            self.matches.remove(&id);
            Promise::new(m.players[0].clone()).transfer(m.stake).detach();
        } else {
            require!(m.phase == Phase::Shuffle && m.shuffled == 0, "a hand is under way: finish it first");
            self.settle(id, m, "left");
        }
    }

    /// The seat whose turn it is replaces the deck with its own shuffle of it: 52 cards, C1 ‖ C2 each.
    pub fn shuffle(&mut self, id: String, seat: u8, deck: Base64VecU8) {
        let (mut m, _) = self.turn(&id, seat, Phase::Shuffle);
        require!(deck.0.len() == DECK_BYTES, "a deck is 52 cards of 128 bytes");
        curve::check_points(&deck.0);
        self.decks.insert(deck_key(&id, m.hand, m.shuffled), deck.0);
        m.shuffled += 1;
        if m.shuffled == 2 {
            m.phase = Phase::Deal;
        }
        m.restart_clock();
        self.save(id, m);
    }

    /// The seat's shares for the other seat's two hole cards. When both are in, the blinds are posted and bets open.
    pub fn deal(&mut self, id: String, seat: u8, tokens: Base64VecU8) {
        let (mut m, seat) = self.turn(&id, seat, Phase::Deal);
        let other = 1 - seat;
        m.take_tokens(&self.deck(&id, m.hand, 1), seat, &[2 * other, 2 * other + 1], &tokens.0);
        m.done[seat] = true;
        if m.done == [true; 2] {
            let button = m.button();
            m.pay(button, SMALL_BLIND);
            m.pay(1 - button, BIG_BLIND);
            m.done = [false; 2];
            m.phase = Phase::Bet;
            m.to_act = button as u8;
            m.restart_clock();
        }
        self.save(id, m);
    }

    /// A bet: `"fold"`, `"call"` (a check when nothing is owed) or `"raise"` with `amount`, the seat's whole bet on
    /// this street after the raise. A raise is at least the big blind more than the bet it answers, unless it is all
    /// in, and never more than the other seat can call, so there is never a side pot.
    pub fn act(&mut self, id: String, seat: u8, action: String, amount: Option<u32>) {
        let (mut m, me) = self.turn(&id, seat, Phase::Bet);
        let other = 1 - me;
        match action.as_str() {
            "fold" => m.end_hand(Outcome::Won(other as u8)),
            "call" => {
                m.pay(me, m.bet[other] - m.bet[me]);
                m.done[me] = true;
            }
            "raise" => {
                let to = amount.unwrap_or_else(|| env::panic_str("a raise needs an amount"));
                let (mine, theirs) = (m.bet[me] + m.chips[me], m.bet[other] + m.chips[other]);
                require!(to > m.bet[other], "a raise must be more than the bet it answers");
                require!(to <= mine, "you do not have that many chips");
                require!(to <= theirs, "the other seat cannot call that much");
                require!(to - m.bet[other] >= BIG_BLIND || to == mine || to == theirs, "raise by at least the big blind, or go all in");
                m.pay(me, to - m.bet[me]);
                m.done = [false; 2];
                m.done[me] = true;
            }
            _ => env::panic_str("action must be fold, call or raise"),
        }
        if m.phase == Phase::Bet {
            // Matched bets close the street once both seats have acted, or at once when a seat is all in.
            if m.bet[0] == m.bet[1] && (m.done == [true; 2] || m.chips.contains(&0)) {
                m.after_bets();
            } else {
                m.to_act = other as u8;
            }
        }
        m.restart_clock();
        self.save(id, m);
    }

    /// The seat's shares for this street's board cards (three on the flop, then one). When both are in, the cards are
    /// decrypted onto the board.
    pub fn open(&mut self, id: String, seat: u8, tokens: Base64VecU8) {
        let (mut m, seat) = self.turn(&id, seat, Phase::Open);
        let at: &[usize] = match m.street {
            1 => &[4, 5, 6],
            2 => &[7],
            _ => &[8],
        };
        let deck = self.deck(&id, m.hand, 1);
        m.take_tokens(&deck, seat, at, &tokens.0);
        m.done[seat] = true;
        if m.done == [true; 2] {
            let points = card_points();
            let cards: Vec<u8> = at.iter().filter_map(|&at| m.card_at(&deck, &points, at)).collect();
            if cards.len() == at.len() {
                m.board.extend(cards);
                m.after_open();
            } else {
                m.end_hand(Outcome::Void);
            }
            m.restart_clock();
        }
        self.save(id, m);
    }

    /// The seat's shares for its own two hole cards, which shows them. When both seats have, the better hand wins.
    pub fn show(&mut self, id: String, seat: u8, tokens: Base64VecU8) {
        let (mut m, seat) = self.turn(&id, seat, Phase::Showdown);
        let at = [2 * seat, 2 * seat + 1];
        let deck = self.deck(&id, m.hand, 1);
        m.take_tokens(&deck, seat, &at, &tokens.0);
        let points = card_points();
        m.hole[seat] = at.iter().filter_map(|&at| m.card_at(&deck, &points, at)).collect();
        m.done[seat] = true;
        if m.done == [true; 2] {
            let outcome = if m.hole.iter().any(|hole| hole.len() != 2) {
                Outcome::Void
            } else {
                let score = |seat: usize| cards::rank7([m.hole[seat][0], m.hole[seat][1], m.board[0], m.board[1], m.board[2], m.board[3], m.board[4]]);
                match score(0).cmp(&score(1)) {
                    std::cmp::Ordering::Greater => Outcome::Won(0),
                    std::cmp::Ordering::Less => Outcome::Won(1),
                    std::cmp::Ordering::Equal => Outcome::Split,
                }
            };
            m.end_hand(outcome);
            m.restart_clock();
        }
        self.save(id, m);
    }

    /// The seat opens its shuffle: for each of the 52 cards the position it came from (one byte), then the 52 scalars
    /// it re-encrypted them with. The contract recomputes the seat's deck from the deck before it and refuses an
    /// opening that does not give exactly the deck the seat sent. When both seats have opened, the hand is paid.
    pub fn audit(&mut self, id: String, seat: u8, opening: Base64VecU8) {
        let (mut m, seat) = self.turn(&id, seat, Phase::Audit);
        require!(opening.0.len() == OPENING_BYTES, "an opening is 52 positions, then 52 scalars of 32 bytes");
        let (order, scalars) = opening.0.split_at(DECK);
        let mut seen = [false; DECK];
        for &from in order {
            require!(usize::from(from) < DECK && !seen[usize::from(from)], "the order must name each of the 52 positions once");
            seen[usize::from(from)] = true;
        }
        let step = u8::from(seat != m.button());
        let before = if step == 0 { open_deck() } else { self.deck(&id, m.hand, 0) };
        let after = self.deck(&id, m.hand, step);
        let (g, key) = (generator(), add(&m.keys[0], &m.keys[1]));
        for (to, &from) in order.iter().enumerate() {
            let scalar = &scalars[to * SCALAR..(to + 1) * SCALAR];
            let from = &before[usize::from(from) * CARD_BYTES..][..CARD_BYTES];
            let card = [add(&from[..POINT], &mul(&g, scalar)), add(&from[POINT..], &mul(&key, scalar))].concat();
            require!(after[to * CARD_BYTES..][..CARD_BYTES] == card, "this is not how the deck was shuffled");
        }
        m.done[seat] = true;
        if m.done != [true; 2] {
            self.save(id, m);
            return;
        }
        let pot = m.put[0] + m.put[1];
        let outcome = m.outcome.unwrap();
        match outcome {
            Outcome::Won(winner) => m.chips[usize::from(winner)] += pot,
            // At a showdown both seats put in the same, so a split pot and a void hand both give each its own back.
            Outcome::Split | Outcome::Void => {
                m.chips[0] += m.put[0];
                m.chips[1] += m.put[1];
            }
        }
        m.last = Some(Hand { number: m.hand, board: m.board.clone(), hole: m.hole.clone(), outcome, pot });
        self.decks.remove(&deck_key(&id, m.hand, 0));
        self.decks.remove(&deck_key(&id, m.hand, 1));
        m.hand += 1;
        if m.chips.iter().any(|&chips| chips < BIG_BLIND) {
            self.settle(id, m, "busted");
        } else {
            m.new_hand();
            m.restart_clock();
            self.save(id, m);
        }
    }

    /// After the deadline: the seat the match was waiting for forfeits, and the other takes every chip. If it was
    /// waiting for both, each gets back what it put into the hand.
    pub fn timeout(&mut self, id: String) {
        let mut m = self.matches.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such match"));
        require!(m.phase != Phase::Lobby, "the match has not started");
        require!(env::block_timestamp() > m.deadline, "the deadline has not passed");
        let late = m.awaited();
        if late.len() == 1 {
            m.chips = [0; 2];
            m.chips[1 - late[0]] = 2 * CHIPS;
        } else {
            m.chips[0] += m.put[0];
            m.chips[1] += m.put[1];
        }
        self.settle(id, m, "timeout");
    }

    pub fn get_match(&self, id: String) -> Option<Value> {
        self.matches.get(&id).map(|m| m.view(&id))
    }

    /// The deck after shuffle `step` (0 or 1) of hand number `hand`, while that hand is under way; 1 is the deck dealt.
    pub fn get_deck(&self, id: String, hand: u32, step: u8) -> Option<Base64VecU8> {
        self.decks.get(&deck_key(&id, hand, step)).map(|deck| Base64VecU8(deck.clone()))
    }

    pub fn list_matches(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Value> {
        self.matches.iter().skip(from_index.unwrap_or(0) as usize).take(limit.unwrap_or(50).min(100) as usize).map(|(id, m)| m.view(id)).collect()
    }

    pub fn get_result(&self, id: String) -> Option<Value> {
        self.results.get(&id).map(|r| {
            json!({
                "id": id,
                "stake": U128(r.stake.as_yoctonear()),
                "players": r.players,
                "chips": r.chips,
                "payouts": r.payouts.iter().map(|p| U128(p.as_yoctonear())).collect::<Vec<_>>(),
                "hands": r.hands,
                "reason": r.reason,
            })
        })
    }
}

impl Contract {
    /// The match, checked to be in `phase` and to be waiting for `seat`, played by the caller.
    fn turn(&self, id: &str, seat: u8, phase: Phase) -> (Match, usize) {
        let m = self.matches.get(id).cloned().unwrap_or_else(|| env::panic_str("no such match"));
        let seat = usize::from(seat);
        require!(m.players.get(seat) == Some(&env::predecessor_account_id()), "only the account in the seat may play it");
        require!(m.phase == phase, "not now: the hand is at another step");
        require!(m.awaited().contains(&seat), "not this seat's turn");
        (m, seat)
    }

    fn save(&mut self, id: String, mut m: Match) {
        m.seq += 1;
        self.matches.insert(id, m);
    }

    fn deck(&self, id: &str, hand: u32, step: u8) -> Vec<u8> {
        self.decks.get(&deck_key(id, hand, step)).cloned().unwrap_or_else(|| env::panic_str("the deck is missing"))
    }

    /// Pays each seat its chips (a chip is a hundredth of the stake), keeps a summary and deletes the match.
    fn settle(&mut self, id: String, m: Match, reason: &str) {
        let chip = m.stake.as_yoctonear() / u128::from(CHIPS);
        let payouts: Vec<NearToken> = m.chips.iter().map(|&chips| NearToken::from_yoctonear(chip * u128::from(chips))).collect();
        for (player, &amount) in m.players.iter().zip(&payouts) {
            if amount.as_yoctonear() > 0 {
                Promise::new(player.clone()).transfer(amount).detach();
            }
        }
        self.decks.remove(&deck_key(&id, m.hand, 0));
        self.decks.remove(&deck_key(&id, m.hand, 1));
        self.matches.remove(&id);
        self.results.insert(id, MatchResult { stake: m.stake, players: m.players, chips: m.chips, payouts, hands: m.hand, reason: reason.into() });
    }
}
