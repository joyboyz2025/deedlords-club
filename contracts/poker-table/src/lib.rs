//! Deedlords Poker NEAR contract for tables of two to nine seats: Texas Hold'em with no dealer. The contract is the
//! referee, the bank and the public notice board; it never sees a secret.
//!
//! * A table has two to nine seats, each bought with the same stake for 100 chips; blinds are 1 and 2. Hands follow one
//!   another until fewer than two seats are left. A seat may be taken at any time and is dealt in from the next hand; a
//!   seat that leaves is paid its chips when the hand it is in is over.
//! * Cards are ElGamal ciphertexts over BN254 G1 under the sum of the keys of the seats dealt into the hand (card `i`
//!   is the point `(i+1)·G`). Each seat proves it knows its key when it sits down (Schnorr), so the summed key belongs
//!   to nobody alone.
//! * A hand: every seat shuffles and re-encrypts the deck in turn, the button first (`shuffle`), with a proof that it
//!   is a shuffle (see `shuffle.rs`); each gives its share of the decryption of every other seat's two hole cards
//!   (`deal`); bets (`act`); the seats still in give their shares for the board cards of a street (`open`), and for
//!   their own hole cards at the end (`show`). Every share comes with a Chaum-Pedersen proof checked here.
//! * A board card needs the share of every seat dealt in, so a seat that folds hands over its shares for the board
//!   cards not yet open with the fold. A card stays hidden as long as one seat still in has not given its share.
//! * The owner of the contract may take a fee: a part of what a seat wins, taken when the seat is paid. It starts at
//!   what `new` is given (nothing, for now), the owner changes it with `set_fee` (5% at most), and a table keeps the
//!   fee in force when it was opened, so a change never reaches money already at a table.
//! * A free table: one of the owner's own accounts (the owner, or an account named under it) may open a table with a
//!   stake of nothing. Its seats cost nothing and are paid nothing: the chips are only chips. The host attaches
//!   [`FREE_TABLE_DEPOSIT`] instead, which covers the table's storage while it is open and the record of every seat
//!   taken there; what is left of it comes back to the host when the table closes. Everything else is the same game.
//! * Each step has a deadline; after it anyone may call `timeout`. If the hand can go on without the late seat it is
//!   folded. If it cannot, because its shares are missing, the hand is cancelled: the others take back what they put
//!   in and share everything the late seat had at the table. See [`Contract::timeout`].

#[path = "../../poker/src/cards.rs"]
mod cards;
#[path = "../../poker/src/curve.rs"]
mod curve;
#[path = "../../poker/src/fr.rs"]
mod fr;
mod pots;
#[path = "../../poker/src/shuffle.rs"]
mod shuffle;
#[cfg(test)]
mod tests;

use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise};

use curve::{add, generator, sum, POINT, SCALAR};

pub const CHIPS: u32 = 100;
pub const SMALL_BLIND: u32 = 1;
pub const BIG_BLIND: u32 = 2;
pub const MAX_SEATS: usize = 9;
/// The least a seat may stake: 0.1 NEAR. A table under way stores up to 16 KB (two decks while a seat shuffles, and
/// its own state), which NEAR makes the contract's balance cover at 1 NEAR per 100 KB; with two stakes of this size
/// the table's own money covers it, so opening tables can never tie up money that other tables must be paid from.
pub const MIN_STAKE: u128 = 10u128.pow(23);
/// What a seat pays on top of its stake, and does not get back once the table has started: 0.002 NEAR. Every seat
/// that was ever taken leaves a line in the table's summary, which is stored for good (about 100 bytes, 0.001 NEAR of
/// storage), and nothing else pays for it.
pub const RECORD_FEE: u128 = 2 * 10u128.pow(21);
/// What the host of a free table (a stake of nothing) attaches to open it: 0.25 NEAR. It stands where the stakes of a
/// paid table stand: it covers the table's storage while it is open (up to 16 KB, 0.16 NEAR) and pays [`RECORD_FEE`]
/// for every seat ever taken there. The rest comes back to the host when the table closes.
pub const FREE_TABLE_DEPOSIT: u128 = 25 * 10u128.pow(22);
/// The most seats ever taken at one free table, the host's included: each leaves a line in the table's summary that
/// the host's deposit pays for, and 30 of them leave 0.19 NEAR of it for the storage.
pub const MAX_FREE_SITTINGS: usize = 30;
/// The most a deployment may take of a seat's winnings: 500 basis points, 5%.
pub const MAX_FEE_BPS: u16 = 500;
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
const BOARD: usize = 5;

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
}

/// The hand before this one, kept so the table can see how it ended. Lists are by seat.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Hand {
    pub number: u32,
    /// The seats dealt in, the button first.
    pub dealt: Vec<u8>,
    pub board: Vec<u8>,
    /// Hole cards, of the seats that showed them.
    pub hole: Vec<Vec<u8>>,
    pub folded: Vec<bool>,
    pub put: Vec<u32>,
    /// The chips each seat took from the middle.
    pub won: Vec<u32>,
    /// `"fold"`: everyone else folded. `"showdown"`. `"cancelled"`: a seat did not answer and no card could be
    /// opened without it. `"void"`: a position did not decrypt to a card, which proved shuffles and proved shares
    /// rule out; every chip put in went back.
    pub ending: String,
    /// The seats that ran out of time.
    pub late: Vec<u8>,
}

/// A seat that was given up, and the chips it was paid for.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Cashed {
    pub account: AccountId,
    pub chips: u32,
}

/// Full state of a table. Deleted when the table is settled. Lists are by seat unless said otherwise.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Match {
    pub stake: NearToken,
    /// Who opened the table: the only one who may start it before it is full.
    pub host: AccountId,
    /// The owner's fee in force when the table was opened, in basis points of what a seat wins: see [`fee_of`].
    pub fee_bps: u16,
    pub players: Vec<Option<AccountId>>,
    /// Each seat's ElGamal public key; empty for an empty seat.
    pub keys: Vec<Vec<u8>>,
    pub turn_seconds: u32,
    /// Nanoseconds; 0 in the lobby.
    pub deadline: u64,
    /// Chips behind each seat, not counting what it put into this hand.
    pub chips: Vec<u32>,
    /// Hands finished so far.
    pub hand: u32,
    /// The seat with the button: it shuffles first. With two seats it posts the small blind and acts first before
    /// the flop; with more, the two seats after it post the blinds and the one after them acts first.
    pub button: u8,
    pub phase: Phase,
    /// The seats dealt into this hand, the button first: fixed by the hand's first shuffle, empty before it.
    pub dealt: Vec<u8>,
    /// The sum of their keys: what this hand's cards are encrypted under.
    pub key: Vec<u8>,
    /// Shuffles accepted for this hand.
    pub shuffled: u8,
    /// 0 before the flop, 1 flop, 2 turn, 3 river.
    pub street: u8,
    pub to_act: u8,
    /// Chips each seat put into this hand, and how many of them on this street.
    pub put: Vec<u32>,
    pub bet: Vec<u32>,
    pub folded: Vec<bool>,
    /// In `Bet`: the seat has acted since the last raise. In the other phases: the seat has done its part.
    pub done: Vec<bool>,
    /// The seat is paid its chips and given up when this hand is over.
    pub leaving: Vec<bool>,
    /// By deck position: the sum of the decryption shares given for it so far. The seat dealt in at place `j` holds
    /// positions `2j` and `2j + 1`; the board is the five positions after the last hole card.
    pub sums: Vec<Vec<u8>>,
    pub board: Vec<u8>,
    /// Hole cards shown at the showdown.
    pub hole: Vec<Vec<u8>>,
    pub last: Option<Hand>,
    /// Every seat given up so far.
    pub cashed: Vec<Cashed>,
    /// Counts the changes stored for this table. A public RPC may answer from a node that is a block behind, so a
    /// reader keeps the view with the highest number.
    pub seq: u32,
    /// Counts the bets made at this table, every hand, folds by the clock included. A bet may name the count it was
    /// chosen at (`act`'s `bets`): a bet sent twice (a node that did not answer, a page that sent again) then lands
    /// once, and never answers a bet made in between.
    pub bets: u32,
}

/// Permanent summary of a settled table.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct MatchResult {
    pub stake: NearToken,
    pub fee_bps: u16,
    pub cashed: Vec<Cashed>,
    pub hands: u32,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    /// Tables in the lobby or playing.
    matches: IterableMap<String, Match>,
    /// The newest deck of the hand under way, under `<table id>/<hand>/<shuffles before it>`; the one before it is
    /// removed when a shuffle is accepted. The deck after the last seat's shuffle is the deck dealt. The hand is in
    /// the key so that a reader a block behind gets no deck rather than the last hand's.
    decks: LookupMap<String, Vec<u8>>,
    results: LookupMap<String, MatchResult>,
    /// Who may change the fee and withdraw what it brought in.
    owner: AccountId,
    /// The fee of tables opened from now on, in basis points of what a seat wins.
    fee_bps: u16,
    /// Fees taken and not yet withdrawn. Only `withdraw_fees` moves them, and only this much.
    fees: NearToken,
}

/// The contract state before the fee existed: the layout of the first testnet deployment (2026-11-12). Read once by
/// [`Contract::migrate`].
#[near(serializers = [borsh])]
pub struct ContractV1 {
    matches: IterableMap<String, Match>,
    decks: LookupMap<String, Vec<u8>>,
    results: LookupMap<String, MatchResult>,
}

fn validate_fee(fee_bps: u16) {
    require!(fee_bps <= MAX_FEE_BPS, "fee_bps must be at most 500 (5%)");
}

/// What a seat paid for `chips` chips receives, and the owner's fee on it, in yoctoNEAR. The fee is `fee_bps` of what
/// the seat won: of the chips above the 100 it bought. A seat that leaves with 100 chips or fewer pays none.
pub fn fee_of(stake: NearToken, chips: u32, fee_bps: u16) -> (u128, u128) {
    let chip = stake.as_yoctonear() / u128::from(CHIPS);
    let fee = chip * u128::from(chips.saturating_sub(CHIPS)) * u128::from(fee_bps) / 10_000;
    (chip * u128::from(chips) - fee, fee)
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

fn is_shuffle(key: &[u8], before: &[u8], after: &[u8], proof: &[u8]) -> bool {
    // The tests of the betting play thousands of hands; they may switch the proof off. Never in the contract itself.
    #[cfg(test)]
    if tests::trusting() {
        return true;
    }
    shuffle::holds(key, before, after, proof)
}

/// `pool` chips among `seats`, as evenly as they go; the odd ones to the first seats.
fn divided(pool: u32, seats: &[usize], won: &mut [u32]) {
    let (each, odd) = (pool / seats.len() as u32, pool as usize % seats.len());
    for (place, &seat) in seats.iter().enumerate() {
        won[seat] += each + u32::from(place < odd);
    }
}

impl Match {
    fn seats(&self) -> usize {
        self.players.len()
    }

    fn seat_of(&self, account: &AccountId) -> Option<usize> {
        self.players.iter().position(|player| player.as_ref() == Some(account))
    }

    /// The seats somebody sits in.
    fn seated(&self) -> Vec<usize> {
        (0..self.seats()).filter(|&seat| self.players[seat].is_some()).collect()
    }

    /// The seats dealt into this hand, starting `start` places after the button.
    fn seats_from(&self, start: usize) -> Vec<usize> {
        let n = self.dealt.len();
        (0..n).map(|i| usize::from(self.dealt[(start + i) % n])).collect()
    }

    /// The place at the table of a seat dealt in: 0 is the button.
    fn place(&self, seat: usize) -> usize {
        self.dealt.iter().position(|&dealt| usize::from(dealt) == seat).unwrap_or_else(|| env::panic_str("this seat is not in the hand"))
    }

    /// The seats dealt in that have not folded.
    fn contenders(&self) -> Vec<usize> {
        self.seats_from(0).into_iter().filter(|&seat| !self.folded[seat]).collect()
    }

    /// The seats that can still bet: in the hand, with chips behind.
    fn able(&self) -> Vec<usize> {
        self.contenders().into_iter().filter(|&seat| self.chips[seat] > 0).collect()
    }

    /// The highest bet of this street.
    fn top(&self) -> u32 {
        self.bet.iter().copied().max().unwrap_or(0)
    }

    fn restart_clock(&mut self) {
        self.deadline = env::block_timestamp() + u64::from(self.turn_seconds) * 1_000_000_000;
    }

    fn new_hand(&mut self) {
        let seats = self.seats();
        self.phase = Phase::Shuffle;
        self.dealt = vec![];
        self.key = vec![];
        self.shuffled = 0;
        self.street = 0;
        self.to_act = self.button;
        self.put = vec![0; seats];
        self.bet = vec![0; seats];
        self.folded = vec![false; seats];
        self.done = vec![false; seats];
        self.sums = vec![];
        self.board = vec![];
        self.hole = vec![vec![]; seats];
    }

    fn pay(&mut self, seat: usize, chips: u32) {
        self.chips[seat] -= chips;
        self.bet[seat] += chips;
        self.put[seat] += chips;
    }

    /// The deck positions of the hole cards of the seat at `place`.
    fn hole_at(place: usize) -> [usize; 2] {
        [2 * place, 2 * place + 1]
    }

    /// The deck position of board card `index` (0..5).
    fn board_at(&self, index: usize) -> usize {
        2 * self.dealt.len() + index
    }

    /// The board cards a street opens: three on the flop, then one.
    fn street_cards(street: u8) -> std::ops::Range<usize> {
        match street {
            1 => 0..3,
            2 => 3..4,
            _ => 4..5,
        }
    }

    /// The first seat, from `start` places after the button, that still has to bet: it can, and it has not acted
    /// since the last raise or has not matched the highest bet.
    fn next_to_act(&self, start: usize) -> Option<usize> {
        let top = self.top();
        self.seats_from(start).into_iter().find(|&seat| !self.folded[seat] && self.chips[seat] > 0 && (!self.done[seat] || self.bet[seat] < top))
    }

    /// The street's bets are closed: every seat that can bet has matched the highest bet and has acted, or only one
    /// seat can still bet and it owes nothing.
    fn bets_closed(&self) -> bool {
        let (top, able) = (self.top(), self.able());
        able.iter().all(|&seat| self.bet[seat] == top && (self.done[seat] || able.len() == 1))
    }

    /// A street's bets are matched: the next board cards, or the showdown after the river.
    fn after_bets(&mut self) {
        self.bet.fill(0);
        self.done.fill(false);
        if self.street == 3 {
            self.phase = Phase::Showdown;
        } else {
            self.street += 1;
            self.phase = Phase::Open;
        }
    }

    /// A street's cards are on the board: bets, unless fewer than two seats have chips left to bet with.
    fn after_open(&mut self) {
        self.done.fill(false);
        match self.next_to_act(1) {
            Some(seat) if self.able().len() >= 2 => {
                self.phase = Phase::Bet;
                self.to_act = seat as u8;
            }
            _ => self.after_bets(),
        }
    }

    /// The seats the table is waiting for.
    fn awaited(&self) -> Vec<usize> {
        match self.phase {
            Phase::Lobby => vec![],
            Phase::Shuffle if self.shuffled == 0 => vec![usize::from(self.button)],
            Phase::Shuffle => vec![usize::from(self.dealt[usize::from(self.shuffled)])],
            Phase::Deal => self.seats_from(0).into_iter().filter(|&seat| !self.done[seat]).collect(),
            Phase::Bet => vec![usize::from(self.to_act)],
            Phase::Open | Phase::Showdown => self.contenders().into_iter().filter(|&seat| !self.done[seat]).collect(),
        }
    }

    /// The card at deck position `at`, once every seat dealt in has given its share: C2 minus the shares, looked up
    /// among the card points. `None` when that is no card at all, which only a false shuffle can cause.
    fn card_at(&self, deck: &[u8], points: &[Vec<u8>], at: usize) -> Option<u8> {
        let c2 = &deck[at * CARD_BYTES + POINT..(at + 1) * CARD_BYTES];
        let point = sum(&[(false, c2), (true, &self.sums[at])]);
        points.iter().position(|card| *card == point).map(|card| card as u8)
    }

    /// Adds `seat`'s shares for the deck positions `at`, each checked against the seat's key.
    fn take_tokens(&mut self, deck: &[u8], seat: usize, at: &[usize], tokens: &[u8]) {
        require!(tokens.len() == at.len() * TOKEN_BYTES, "send one 224-byte share (token, then its proof) per card");
        for (share, &at) in tokens.chunks(TOKEN_BYTES).zip(at) {
            let (token, proof) = share.split_at(POINT);
            let c1 = &deck[at * CARD_BYTES..at * CARD_BYTES + POINT];
            require!(curve::same_key(&self.keys[seat], c1, token, proof), "a share was not made with this seat's key");
            self.sums[at] = add(&self.sums[at], token);
        }
    }

    /// A table with a stake of nothing: its seats cost nothing and are paid nothing.
    fn free(&self) -> bool {
        self.stake.as_yoctonear() == 0
    }

    /// What taking a seat costs: the stake and the record fee, or nothing at a free table.
    fn seat_price(&self) -> u128 {
        if self.free() {
            0
        } else {
            self.stake.as_yoctonear() + RECORD_FEE
        }
    }

    /// Pays the seat its chips (a chip is a hundredth of the stake), less the table's fee on what it won, and empties
    /// it. Returns the fee, which the caller adds to the contract's.
    #[must_use]
    fn stand_up(&mut self, seat: usize) -> u128 {
        let account = self.players[seat].take().unwrap_or_else(|| env::panic_str("the seat is empty"));
        let chips = std::mem::take(&mut self.chips[seat]);
        let (paid, fee) = fee_of(self.stake, chips, self.fee_bps);
        if paid > 0 {
            Promise::new(account.clone()).transfer(NearToken::from_yoctonear(paid)).detach();
        }
        self.keys[seat] = vec![];
        self.leaving[seat] = false;
        self.cashed.push(Cashed { account, chips });
        fee
    }

    fn view(&self, id: &str) -> Value {
        let bytes = |list: &[Vec<u8>]| list.iter().map(|item| Base64VecU8(item.clone())).collect::<Vec<_>>();
        json!({
            "id": id,
            "phase": self.phase,
            "stake": U128(self.stake.as_yoctonear()),
            "deposit": U128(self.seat_price()),
            "host": self.host,
            "feeBps": self.fee_bps,
            "players": self.players,
            "keys": bytes(&self.keys),
            "turnSeconds": self.turn_seconds,
            "deadline": U64(self.deadline),
            "chips": self.chips,
            "hand": self.hand,
            "button": self.button,
            "dealt": self.dealt,
            "key": Base64VecU8(self.key.clone()),
            "shuffled": self.shuffled,
            "street": self.street,
            "toAct": self.to_act,
            "awaited": self.awaited(),
            "put": self.put,
            "bet": self.bet,
            "folded": self.folded,
            "done": self.done,
            "leaving": self.leaving,
            "sums": bytes(&self.sums),
            "board": self.board,
            "hole": self.hole,
            "last": self.last,
            "cashed": self.cashed,
            "seq": self.seq,
            "bets": self.bets,
        })
    }
}

#[near]
impl Contract {
    /// `owner` may change the fee and withdraw it. `fee_bps` is the part of what a seat wins that is kept as the fee,
    /// in basis points (250 is 2.5%), at most [`MAX_FEE_BPS`]; 0 takes nothing.
    #[init]
    #[private]
    pub fn new(owner: AccountId, fee_bps: u16) -> Self {
        validate_fee(fee_bps);
        Contract { matches: IterableMap::new(b"m"), decks: LookupMap::new(b"d"), results: LookupMap::new(b"s"), owner, fee_bps, fees: NearToken::from_yoctonear(0) }
    }

    /// Upgrades a deployment made before the fee existed ([`ContractV1`]), in the transaction that deploys this code.
    /// Refused while any table is open. The summaries of the tables settled before are left behind under their old
    /// storage prefix: they have another layout.
    #[init(ignore_state)]
    #[private]
    pub fn migrate(owner: AccountId, fee_bps: u16) -> Self {
        validate_fee(fee_bps);
        let old: ContractV1 = env::state_read().unwrap_or_else(|| env::panic_str("there is no state to upgrade"));
        require!(old.matches.is_empty(), "finish every open table first");
        Contract { matches: old.matches, decks: old.decks, results: LookupMap::new(b"s"), owner, fee_bps, fees: NearToken::from_yoctonear(0) }
    }

    /// Owner only, with exactly 1 yoctoNEAR attached (so a full-access key has to sign): the fee of tables opened from
    /// now on. A table already open keeps the fee it was opened with.
    #[payable]
    pub fn set_fee(&mut self, fee_bps: u16) {
        near_sdk::assert_one_yocto();
        require!(env::predecessor_account_id() == self.owner, "only the owner may set the fee");
        validate_fee(fee_bps);
        self.fee_bps = fee_bps;
    }

    /// Owner only, with exactly 1 yoctoNEAR attached: sends the fees taken so far to the owner and returns the amount.
    /// Stakes, chips at open tables and record fees are not fees: this method cannot reach them.
    #[payable]
    pub fn withdraw_fees(&mut self) -> U128 {
        near_sdk::assert_one_yocto();
        require!(env::predecessor_account_id() == self.owner, "only the owner may withdraw the fees");
        let amount = self.fees;
        require!(amount.as_yoctonear() > 0, "there are no fees to withdraw");
        self.fees = NearToken::from_yoctonear(0);
        Promise::new(self.owner.clone()).transfer(amount).detach();
        U128(amount.as_yoctonear())
    }

    pub fn get_config(&self) -> Value {
        json!({ "owner": self.owner, "fee_bps": self.fee_bps, "max_fee_bps": MAX_FEE_BPS, "fees": U128(self.fees.as_yoctonear()), "tables": self.matches.len() })
    }

    /// Opens a table of `seats` seats (2 to 9; 2 when not given) and takes seat 0. The attached deposit is the stake
    /// (at least [`MIN_STAKE`]), worth 100 chips, plus [`RECORD_FEE`]. A stake of 0 opens a free table: only the
    /// owner's own accounts may, and they attach [`FREE_TABLE_DEPOSIT`] instead.
    #[payable]
    pub fn create_match(&mut self, id: String, stake: U128, key: Base64VecU8, seats: Option<u8>, turn_seconds: Option<u32>) {
        require!(!id.is_empty() && id.len() <= MAX_ID_LEN, "table id must be 1..=32 characters");
        require!(id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'), "table id may only contain ASCII letters, digits, '-' and '_'");
        require!(!self.matches.contains_key(&id) && !self.results.contains_key(&id), "this table id was already used");
        let seats = usize::from(seats.unwrap_or(2));
        require!((2..=MAX_SEATS).contains(&seats), "a table has 2 to 9 seats");
        let turn_seconds = turn_seconds.unwrap_or(DEFAULT_TURN_SECONDS);
        require!((5..=MAX_TURN_SECONDS).contains(&turn_seconds), "turn_seconds must be 5..=86400");
        let host = env::predecessor_account_id();
        let stake = NearToken::from_yoctonear(stake.0);
        if stake.as_yoctonear() == 0 {
            require!(self.is_own(&host), "only the owner's own accounts open a free table: a stake is at least 0.1 NEAR");
            require!(env::attached_deposit().as_yoctonear() == FREE_TABLE_DEPOSIT, "attach exactly the free table's deposit of 0.25 NEAR");
        } else {
            require!(stake.as_yoctonear() >= MIN_STAKE && stake.as_yoctonear().is_multiple_of(u128::from(CHIPS)), "the stake must be at least 0.1 NEAR and a multiple of 100 yoctoNEAR");
            require!(env::attached_deposit().as_yoctonear() == stake.as_yoctonear() + RECORD_FEE, "attach exactly the stake and the record fee of 0.002 NEAR");
        }
        let mut m = Match {
            stake,
            host: host.clone(),
            fee_bps: self.fee_bps,
            players: vec![None; seats],
            keys: vec![vec![]; seats],
            turn_seconds,
            deadline: 0,
            chips: vec![0; seats],
            hand: 0,
            button: 0,
            phase: Phase::Lobby,
            dealt: vec![],
            key: vec![],
            shuffled: 0,
            street: 0,
            to_act: 0,
            put: vec![],
            bet: vec![],
            folded: vec![],
            done: vec![],
            leaving: vec![false; seats],
            sums: vec![],
            board: vec![],
            hole: vec![],
            last: None,
            cashed: vec![],
            seq: 0,
            bets: 0,
        };
        m.new_hand();
        m.phase = Phase::Lobby;
        m.players[0] = Some(host);
        m.keys[0] = checked_key(&key.0);
        m.chips[0] = CHIPS;
        self.save(id, m);
    }

    /// Takes the first empty seat with the same stake and fee. In the lobby the table starts when the last seat is
    /// taken. At a table under way the seat is dealt in from the next hand. A seat at a free table costs nothing,
    /// and nothing may be attached; a free table seats [`MAX_FREE_SITTINGS`] in all.
    #[payable]
    pub fn join(&mut self, id: String, key: Base64VecU8) {
        let mut m = self.matches.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such table"));
        let account = env::predecessor_account_id();
        if m.free() {
            require!(env::attached_deposit().as_yoctonear() == 0, "a seat at a free table costs nothing: attach nothing");
            require!(m.cashed.len() + m.seated().len() < MAX_FREE_SITTINGS, "this free table has seated all the players it can");
        } else {
            require!(env::attached_deposit().as_yoctonear() == m.seat_price(), "attach exactly the stake and the record fee of 0.002 NEAR");
        }
        require!(m.seat_of(&account).is_none(), "this account already has a seat at the table");
        let seat = m.players.iter().position(Option::is_none).unwrap_or_else(|| env::panic_str("the table is full"));
        m.players[seat] = Some(account);
        m.keys[seat] = checked_key(&key.0);
        m.chips[seat] = CHIPS;
        if m.phase == Phase::Lobby && m.seated().len() == m.seats() {
            m.phase = Phase::Shuffle;
            m.restart_clock();
        }
        self.save(id, m);
    }

    /// The host starts a table that is not full, once two seats or more are taken.
    pub fn start(&mut self, id: String) {
        let mut m = self.matches.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such table"));
        require!(m.phase == Phase::Lobby, "the table has started");
        require!(env::predecessor_account_id() == m.host, "only the host starts the table");
        require!(m.seated().len() >= 2, "a table needs two seats taken");
        m.phase = Phase::Shuffle;
        m.restart_clock();
        self.save(id, m);
    }

    /// Gives up the caller's seat. In the lobby its stake and fee come back; when it is the host who leaves, the
    /// table closes and every seat's do. At a table under way the seat is paid the chips it holds: at once when it is
    /// not in a hand, else when the hand it is in is over (it still owes that hand its part, or a fold). The table is
    /// settled when fewer than two seats are left.
    pub fn leave(&mut self, id: String) {
        let mut m = self.matches.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such table"));
        let account = env::predecessor_account_id();
        let seat = m.seat_of(&account).unwrap_or_else(|| env::panic_str("only an account in a seat may leave"));
        if m.phase == Phase::Lobby {
            // Nothing was paid for a seat at a free table: nothing comes back for it.
            let refund = NearToken::from_yoctonear(m.seat_price());
            if account == m.host {
                if !m.free() {
                    for player in m.players.iter().flatten() {
                        Promise::new(player.clone()).transfer(refund).detach();
                    }
                } else {
                    // No summary is kept of a table that never started: the whole deposit comes back.
                    Promise::new(m.host.clone()).transfer(NearToken::from_yoctonear(FREE_TABLE_DEPOSIT)).detach();
                }
                self.matches.remove(&id);
                return;
            }
            m.players[seat] = None;
            m.keys[seat] = vec![];
            m.chips[seat] = 0;
            if !m.free() {
                Promise::new(account).transfer(refund).detach();
            }
            self.save(id, m);
        } else if m.dealt.contains(&(seat as u8)) {
            m.leaving[seat] = true;
            self.save(id, m);
        } else {
            self.take_fee(m.stand_up(seat));
            if m.shuffled == 0 {
                self.next(id, m, false);
            } else {
                self.save(id, m);
            }
        }
    }

    /// The seat whose turn it is replaces the deck with its own shuffle of it (52 cards, C1 ‖ C2 each) and proves that
    /// it is one. A deck without a valid proof is refused. The button's shuffle starts the hand: the seats taken at
    /// that moment are the seats dealt in. `key` is the table key the seat shuffled under: when it is not this hand's
    /// (a seat was taken or given up meanwhile), the call is refused before the proof, which could only fail, is
    /// checked at its full price.
    pub fn shuffle(&mut self, id: String, seat: u8, deck: Base64VecU8, proof: Base64VecU8, key: Option<Base64VecU8>) {
        let (mut m, _) = self.turn(&id, seat, Phase::Shuffle);
        require!(deck.0.len() == DECK_BYTES, "a deck is 52 cards of 128 bytes");
        require!(proof.0.len() == shuffle::PROOF_BYTES, "a shuffle proof is 10144 bytes");
        if m.shuffled == 0 {
            let seated = m.seated();
            let first = seated.iter().position(|&taken| taken == usize::from(m.button)).unwrap_or(0);
            m.dealt = (0..seated.len()).map(|i| seated[(first + i) % seated.len()] as u8).collect();
            let keys: Vec<(bool, &[u8])> = m.dealt.iter().map(|&dealt| (false, m.keys[usize::from(dealt)].as_slice())).collect();
            m.key = sum(&keys);
            m.sums = vec![vec![0; POINT]; 2 * m.dealt.len() + BOARD];
        }
        require!(key.is_none_or(|key| key.0 == m.key), "the seats at the table changed: shuffle again under the table's key");
        let before = if m.shuffled == 0 { open_deck() } else { self.deck(&id, m.hand, m.shuffled - 1) };
        require!(is_shuffle(&m.key, &before, &deck.0, &proof.0), "the proof does not show that this deck is a shuffle of the deck before it");
        self.decks.insert(deck_key(&id, m.hand, m.shuffled), deck.0);
        if m.shuffled > 0 {
            self.decks.remove(&deck_key(&id, m.hand, m.shuffled - 1));
        }
        m.shuffled += 1;
        if usize::from(m.shuffled) == m.dealt.len() {
            m.phase = Phase::Deal;
        }
        m.restart_clock();
        self.save(id, m);
    }

    /// The seat's shares for the hole cards of every other seat dealt in, in the order of their deck positions. When
    /// every seat's are in, the blinds are posted and bets open.
    pub fn deal(&mut self, id: String, seat: u8, tokens: Base64VecU8) {
        let (mut m, seat) = self.turn(&id, seat, Phase::Deal);
        let own = m.place(seat);
        let at: Vec<usize> = (0..m.dealt.len()).filter(|&place| place != own).flat_map(Match::hole_at).collect();
        m.take_tokens(&self.dealt_deck(&id, &m), seat, &at, &tokens.0);
        m.done[seat] = true;
        if m.awaited().is_empty() {
            // Two seats: the button posts the small blind. More: the two seats after it post the blinds.
            let small = usize::from(m.dealt.len() > 2);
            let blinds = m.seats_from(small);
            m.pay(blinds[0], SMALL_BLIND);
            m.pay(blinds[1], BIG_BLIND);
            m.done.fill(false);
            m.phase = Phase::Bet;
            m.to_act = m.next_to_act(small + 2).unwrap_or_else(|| env::panic_str("nobody can bet")) as u8;
            m.restart_clock();
        }
        self.save(id, m);
    }

    /// A bet: `"fold"`, `"call"` (a check when nothing is owed; all in when the seat has less than it owes) or
    /// `"raise"` with `amount`, the seat's whole bet on this street after the raise: at least the big blind more than
    /// the bet it answers, unless it is all in. A fold comes with `tokens`: the seat's shares for the board cards not
    /// yet open, in order, so that the hand can go on without it. `bets`: the table's count of bets the bet was chosen
    /// at (`bets` in the view); when it is given and the table has moved on since, the bet is refused, so that a bet
    /// sent twice is made once.
    pub fn act(&mut self, id: String, seat: u8, action: String, amount: Option<u32>, tokens: Option<Base64VecU8>, bets: Option<u32>) {
        let (mut m, me) = self.turn(&id, seat, Phase::Bet);
        require!(bets.is_none_or(|bets| bets == m.bets), "the table moved on since this bet was chosen: read it again");
        let top = m.top();
        match action.as_str() {
            "fold" => {
                let at: Vec<usize> = (m.board.len()..BOARD).map(|index| m.board_at(index)).collect();
                m.take_tokens(&self.dealt_deck(&id, &m), me, &at, &tokens.map(|tokens| tokens.0).unwrap_or_default());
                m.folded[me] = true;
            }
            "call" => {
                m.pay(me, m.chips[me].min(top - m.bet[me]));
                m.done[me] = true;
            }
            "raise" => {
                let to = amount.unwrap_or_else(|| env::panic_str("a raise needs an amount"));
                let all = m.bet[me] + m.chips[me];
                require!(to > top, "a raise must be more than the bet it answers");
                require!(to <= all, "you do not have that many chips");
                require!(to - top >= BIG_BLIND || to == all, "raise by at least the big blind, or go all in");
                m.pay(me, to - m.bet[me]);
                m.done.fill(false);
                m.done[me] = true;
            }
            _ => env::panic_str("action must be fold, call or raise"),
        }
        self.after_act(id, m, me);
    }

    /// The seat's shares for this street's board cards (three on the flop, then one). When the shares of every seat
    /// still in are in, the cards are decrypted onto the board.
    pub fn open(&mut self, id: String, seat: u8, tokens: Base64VecU8) {
        let (mut m, seat) = self.turn(&id, seat, Phase::Open);
        let at: Vec<usize> = Match::street_cards(m.street).map(|index| m.board_at(index)).collect();
        let deck = self.dealt_deck(&id, &m);
        m.take_tokens(&deck, seat, &at, &tokens.0);
        m.done[seat] = true;
        if m.awaited().is_empty() {
            let points = card_points();
            let cards: Vec<u8> = at.iter().filter_map(|&at| m.card_at(&deck, &points, at)).collect();
            if cards.len() != at.len() {
                return self.void(id, m);
            }
            m.board.extend(cards);
            m.after_open();
            m.restart_clock();
        }
        self.save(id, m);
    }

    /// The seat's shares for its own two hole cards, which shows them. When every seat still in has shown, the pots
    /// go to the best hands.
    pub fn show(&mut self, id: String, seat: u8, tokens: Base64VecU8) {
        let (mut m, seat) = self.turn(&id, seat, Phase::Showdown);
        let at = Match::hole_at(m.place(seat));
        let deck = self.dealt_deck(&id, &m);
        m.take_tokens(&deck, seat, &at, &tokens.0);
        let points = card_points();
        m.hole[seat] = at.iter().filter_map(|&at| m.card_at(&deck, &points, at)).collect();
        m.done[seat] = true;
        if m.awaited().is_empty() {
            return self.showdown(id, m, vec![]);
        }
        self.save(id, m);
    }

    /// After the deadline, for anyone to call. What happens to the seats the table was waiting for:
    ///
    /// * No hand has begun (the button has not shuffled): the button's seat is paid its chips and given up.
    /// * A later shuffle is missing: nobody has seen a card, so the hand is called off and the late seat is paid its
    ///   chips and given up.
    /// * The hand can go on without the late seat (it owed a bet with the whole board open, or its own cards at the
    ///   showdown): it is folded, and given up when the hand is over.
    /// * Its shares are missing (for the hole cards, for a street, or because it owed a bet and with it the shares a
    ///   fold carries), so no card can be opened: the hand is cancelled. Every other seat takes back exactly what it
    ///   put in; everything the late seats had at the table is shared among the seats still in the hand that were
    ///   not late. If none of those is left, nobody loses anything.
    pub fn timeout(&mut self, id: String) {
        let mut m = self.matches.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such table"));
        require!(m.phase != Phase::Lobby, "the table has not started");
        require!(env::block_timestamp() > m.deadline, "the deadline has not passed");
        let late = m.awaited();
        match m.phase {
            Phase::Shuffle if m.shuffled == 0 => {
                m.leaving[late[0]] = true;
                self.next(id, m, true);
            }
            Phase::Shuffle => self.cancel(id, m, late, false),
            Phase::Bet if m.street == 3 => {
                m.folded[late[0]] = true;
                m.leaving[late[0]] = true;
                self.after_act(id, m, late[0]);
            }
            Phase::Showdown => {
                for &seat in &late {
                    m.folded[seat] = true;
                    m.leaving[seat] = true;
                }
                self.showdown(id, m, late);
            }
            _ => self.cancel(id, m, late, true),
        }
    }

    pub fn get_match(&self, id: String) -> Option<Value> {
        self.matches.get(&id).map(|m| m.view(&id))
    }

    /// The deck after `step` shuffles came before it, of hand number `hand`, while it is the newest deck of that hand.
    /// The deck dealt is the one at step `dealt.len() - 1`.
    pub fn get_deck(&self, id: String, hand: u32, step: u8) -> Option<Base64VecU8> {
        self.decks.get(&deck_key(&id, hand, step)).map(|deck| Base64VecU8(deck.clone()))
    }

    pub fn list_matches(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Value> {
        self.matches.iter().skip(from_index.unwrap_or(0) as usize).take(limit.unwrap_or(50).min(100) as usize).map(|(id, m)| m.view(id)).collect()
    }

    pub fn get_result(&self, id: String) -> Option<Value> {
        self.results.get(&id).map(|r| {
            let line = |cashed: &Cashed| {
                let (paid, fee) = fee_of(r.stake, cashed.chips, r.fee_bps);
                json!({ "account": cashed.account, "chips": cashed.chips, "payout": U128(paid), "fee": U128(fee) })
            };
            json!({ "id": id, "stake": U128(r.stake.as_yoctonear()), "feeBps": r.fee_bps, "cashed": r.cashed.iter().map(line).collect::<Vec<_>>(), "hands": r.hands })
        })
    }
}

impl Contract {
    /// The table, checked to be in `phase` and to be waiting for `seat`, played by the caller.
    fn turn(&self, id: &str, seat: u8, phase: Phase) -> (Match, usize) {
        let m = self.matches.get(id).cloned().unwrap_or_else(|| env::panic_str("no such table"));
        let seat = usize::from(seat);
        require!(m.players.get(seat).and_then(Option::as_ref) == Some(&env::predecessor_account_id()), "only the account in the seat may play it");
        require!(m.phase == phase, "not now: the hand is at another step");
        require!(m.awaited().contains(&seat), "not this seat's turn");
        (m, seat)
    }

    /// The owner, or an account named under it (`house.<owner>`): only the owner's key can have made those.
    fn is_own(&self, account: &AccountId) -> bool {
        *account == self.owner || account.as_str().strip_suffix(self.owner.as_str()).is_some_and(|rest| rest.ends_with('.'))
    }

    fn take_fee(&mut self, fee: u128) {
        self.fees = self.fees.saturating_add(NearToken::from_yoctonear(fee));
    }

    fn save(&mut self, id: String, mut m: Match) {
        m.seq += 1;
        self.matches.insert(id, m);
    }

    fn deck(&self, id: &str, hand: u32, step: u8) -> Vec<u8> {
        self.decks.get(&deck_key(id, hand, step)).cloned().unwrap_or_else(|| env::panic_str("the deck is missing"))
    }

    /// The deck this hand is dealt from: the one after the last seat's shuffle.
    fn dealt_deck(&self, id: &str, m: &Match) -> Vec<u8> {
        self.deck(id, m.hand, m.shuffled - 1)
    }

    /// After `me` bet or folded: the pot to the last seat in, the next street, or the next seat to bet.
    fn after_act(&mut self, id: String, mut m: Match, me: usize) {
        m.bets += 1;
        let contenders = m.contenders();
        if contenders.len() == 1 {
            let mut won = vec![0; m.seats()];
            won[contenders[0]] = m.put.iter().sum();
            return self.end_hand(id, m, "fold", won, vec![]);
        }
        if m.bets_closed() {
            m.after_bets();
        } else {
            m.to_act = m.next_to_act(m.place(me) + 1).unwrap_or_else(|| env::panic_str("nobody can bet")) as u8;
        }
        m.restart_clock();
        self.save(id, m);
    }

    /// Every seat still in has shown its cards, or ran out of time and was folded (`late`): the pots go to the best
    /// hands among the seats that reached them.
    fn showdown(&mut self, id: String, m: Match, late: Vec<usize>) {
        let contenders = m.contenders();
        if contenders.is_empty() {
            let won = m.put.clone();
            return self.end_hand(id, m, "cancelled", won, late);
        }
        if m.board.len() != BOARD || contenders.iter().any(|&seat| m.hole[seat].len() != 2) {
            return self.void(id, m);
        }
        let score: Vec<Option<u32>> = (0..m.seats())
            .map(|seat| contenders.contains(&seat).then(|| cards::rank7([m.hole[seat][0], m.hole[seat][1], m.board[0], m.board[1], m.board[2], m.board[3], m.board[4]])))
            .collect();
        // Chips that do not divide go to the first seats after the button.
        let order: Vec<usize> = m.seats_from(1).into_iter().filter(|seat| contenders.contains(seat)).collect();
        let won = pots::share(&m.put, &score, &order);
        self.end_hand(id, m, "showdown", won, late)
    }

    /// A position did not decrypt to a card: every seat takes back what it put in.
    fn void(&mut self, id: String, m: Match) {
        let won = m.put.clone();
        self.end_hand(id, m, "void", won, vec![])
    }

    /// The hand cannot go on without the seats in `late`. Every other seat takes back what it put in. With `fined`,
    /// the late seats lose all they have at the table to the seats still in the hand that were not late, if there is
    /// one; otherwise they take back what they put in too. The late seats are given up.
    fn cancel(&mut self, id: String, mut m: Match, late: Vec<usize>, fined: bool) {
        let safe: Vec<usize> = m.seats_from(1).into_iter().filter(|seat| !m.folded[*seat] && !late.contains(seat)).collect();
        let fined = fined && !safe.is_empty();
        let mut won = vec![0; m.seats()];
        let mut pool = 0;
        for seat in m.seats_from(0) {
            if fined && late.contains(&seat) {
                pool += m.put[seat] + std::mem::take(&mut m.chips[seat]);
            } else {
                won[seat] = m.put[seat];
            }
        }
        if fined {
            divided(pool, &safe, &mut won);
        }
        for &seat in &late {
            m.leaving[seat] = true;
        }
        self.end_hand(id, m, "cancelled", won, late)
    }

    /// Pays the hand that just ended as `won` says, keeps how it ended, and goes on to the next hand.
    fn end_hand(&mut self, id: String, mut m: Match, ending: &str, won: Vec<u32>, late: Vec<usize>) {
        for (seat, chips) in won.iter().enumerate() {
            m.chips[seat] += chips;
        }
        m.last = Some(Hand {
            number: m.hand,
            dealt: m.dealt.clone(),
            board: m.board.clone(),
            hole: m.hole.clone(),
            folded: m.folded.clone(),
            put: m.put.clone(),
            won,
            ending: ending.into(),
            late: late.iter().map(|&seat| seat as u8).collect(),
        });
        if m.shuffled > 0 {
            self.decks.remove(&deck_key(&id, m.hand, m.shuffled - 1));
        }
        m.hand += 1;
        self.next(id, m, true);
    }

    /// Between hands: the seats that asked to leave, ran out of time or cannot post the big blind are paid and given
    /// up; then the table is settled if fewer than two seats are left, or waits for the button to start a hand. The
    /// button moves to the next seat taken when `move_button` says so or its seat was given up.
    fn next(&mut self, id: String, mut m: Match, move_button: bool) {
        for seat in m.seated() {
            if m.leaving[seat] || m.chips[seat] < BIG_BLIND {
                self.take_fee(m.stand_up(seat));
            }
        }
        let seated = m.seated();
        if seated.len() < 2 {
            for seat in seated {
                self.take_fee(m.stand_up(seat));
            }
            self.matches.remove(&id);
            if m.free() {
                // The host's deposit paid for the table's storage, now given up, and pays for the lines of its summary.
                let kept = RECORD_FEE * m.cashed.len() as u128;
                let back = FREE_TABLE_DEPOSIT.saturating_sub(kept);
                if back > 0 {
                    Promise::new(m.host.clone()).transfer(NearToken::from_yoctonear(back)).detach();
                }
            }
            self.results.insert(id, MatchResult { stake: m.stake, fee_bps: m.fee_bps, cashed: m.cashed, hands: m.hand });
            return;
        }
        if move_button || !seated.contains(&usize::from(m.button)) {
            m.button = seated.iter().copied().find(|&seat| seat > usize::from(m.button)).unwrap_or(seated[0]) as u8;
        }
        m.new_hand();
        m.restart_clock();
        self.save(id, m);
    }
}
