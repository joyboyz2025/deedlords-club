//! Deedlords NEAR contract: the referee around the pure rules engine (`deedlords-engine`).
//!
//! * A match has 2–4 seats. Seat `k` is the engine player `"s<k>"` and is backed by an account that paid the stake;
//!   the backer may name a driver (an agent account) that may also play the seat. In a solo match the solo player
//!   backs exactly one seat and the house backs the others; in any other match one account may back several seats.
//! * When the last seat is backed the game starts in the same call. Every move goes through the engine with the
//!   on-chain Rng ([`rng`]). A roll can never be taken back: a call that drew no randomness is rejected whole on an
//!   engine error, but once a die or a card was drawn the call stands (what was applied is kept, the rejected action
//!   is reported), and every call that may draw needs [`MIN_MOVE_GAS`] attached so it cannot be made to run out of gas.
//! * Each turn has a deadline, renewed only when the seat to move changes or the current seat rolls; after it anyone
//!   may call `timeout`, so no one can stall a match.
//! * When the engine reports the end, the contract settles once: takes the fee off the pot (the `fee_bps` in force
//!   when the match was opened, at most 5%; the owner may change it for matches opened later), pays the rest by rank, locks the house's shares forever (`forfeited`), mints a Deed NFT
//!   (NEP-171) to a non-house winner, records stats and a summary, deletes the match and refunds the creator's storage
//!   deposit (minus the bytes the permanent records occupy). The fees add up in a counter; the owner can withdraw
//!   exactly that and nothing else.
//!
//! Every successful state change logs `EVENT_JSON:{"standard":"deedlords","version":"1.0.0","event":..,"data":..}`.
//! The engine `Game` is stored with borsh; JSON is only produced for views and events.

pub mod autoplay;
pub mod rng;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod ticket_tests;

use std::collections::BTreeMap;

use deedlords_engine::{Action, Extras, Game, Phase, Reason, Rules, Tickets};
use near_contract_standards::non_fungible_token::core::{NonFungibleTokenCore, NonFungibleTokenResolver};
use near_contract_standards::non_fungible_token::events::NftMint;
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, NonFungibleTokenMetadataProvider, TokenMetadata, NFT_METADATA_SPEC,
};
use near_contract_standards::non_fungible_token::{NonFungibleToken, NonFungibleTokenEnumeration, Token, TokenId};
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{assert_one_yocto, env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue};

use autoplay::{apply_logged, play_turn_with, timeout_step, MAX_PLAN_LIST};
pub use autoplay::{Plan, Step, TicketPlan};
use rng::{near_sha256, ChainRng};

/// Engine player id of each seat.
pub const SEAT_IDS: [&str; 4] = ["s0", "s1", "s2", "s3"];
pub const MIN_SEATS: u8 = 2;
pub const MAX_SEATS: u8 = 4;
pub const DEFAULT_TURN_SECONDS: u32 = 20;
pub const MAX_TURN_SECONDS: u32 = 86_400;
/// A match still in the lobby this long after creation may be abandoned by anyone.
pub const ABANDON_AFTER_NS: u64 = 15 * 60 * 1_000_000_000;
/// A full hosted room its host does not start: this long after its last seat was taken, anyone seated may start it.
pub const HOST_GRACE_NS: u64 = 30 * 1_000_000_000;
/// The clock of a seat that is away (it let a whole turn's clock run out without throwing): its turns after that last
/// this long, until it moves again or says it is back. Never longer than the match's own `turn_seconds`.
pub const AWAY_TURN_SECONDS: u32 = 5;
/// The most steps one `timeout` plays for a seat that is away: a whole turn (three throws and what follows) fits.
const AWAY_STEPS: usize = 16;
/// Blitz deals 5 squares per player at list price; the 5 dearest ownables cost 400 + 350 + 320 + 300 + 300.
pub const BLITZ_MIN_CASH: i64 = 1670;
pub const MAX_CASH: i64 = 1_000_000;
pub const MAX_SALARY: i64 = 100_000;
/// Basis points of a full pot.
pub const SPLIT_TOTAL: u32 = 10_000;
/// Upper bound of a deployment's stake cap (1,000,000 NEAR), so `pot * basis points` always fits in a u128. The cap
/// that matches are checked against is `max_stake`, set once in `new`.
pub const MAX_STAKE: u128 = 1_000_000 * 10u128.pow(24);
/// The most a deployment may take from a pot: 500 basis points, 5%. `fee_bps` is set in `new` and changed by
/// `set_fee`; a match keeps the fee in force when it was opened.
pub const MAX_FEE_BPS: u16 = 500;
pub const MAX_ID_LEN: usize = 32;
pub const MAX_ACTIONS_PER_CALL: usize = 32;
/// Gas that `join`, `play`, `turn` and `timeout` require to be attached. These calls may draw dice or cards, and a call
/// that ran out of gas after the draw would revert it: a caller could tune the gas so that only the outcomes it likes
/// fit, and roll again otherwise. The floor is several times the heaviest call measured (contracts/README.md), so
/// every outcome completes.
pub const MIN_MOVE_GAS: Gas = Gas::from_tgas(100);
/// Bytes the creator pre-pays on top of the measured size of the new match: the growth of the match while it is played
/// (backers, drivers, owned squares, the 30-event log) and the permanent records written when it is settled (summary,
/// stats, Deed NFT). Measured in `tests::storage_reserve_covers_a_full_match`: a full 4-seat Blitz match with
/// 64-character accounts and drivers grows by about 1.1 KB while played and leaves about 2.5 KB of records; the rest
/// is margin. At 10^19 yoctoNEAR per byte this is 0.045 NEAR, refunded except for the records.
pub const STORAGE_RESERVE_BYTES: u64 = 4_500;
/// Event payloads above this size drop the per-step engine events (the NEAR log limit is 16 KB per receipt).
const MAX_EVENT_BYTES: usize = 12_000;

pub const EVENT_STANDARD: &str = "deedlords";
pub const EVENT_VERSION: &str = "1.0.0";

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Lobby,
    Playing,
    Ended,
    Abandoned,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Seat {
    pub backer: Option<AccountId>,
    pub driver: Option<AccountId>,
}

/// Full state of an unfinished match. Deleted when the match is settled or abandoned.
///
/// Stored with borsh, by hand (below): the fields in this order, which is the layout every deployment has stored, and
/// then, only for a match opened with tickets or the leader's rent, a tail ([`MATCH_TAIL_V1`]) that the top bit of the
/// stored status byte announces ([`MATCH_TAIL_FLAG`]). A match without them is stored byte for byte as before those
/// rules existed, and a match stored before them reads as one without. (The map that holds the matches writes its own
/// bytes after each of them, so the end of the value cannot tell whether a tail is there: the flag does.)
#[derive(Clone, Debug)]
pub struct Match {
    pub rules: Rules,
    pub stake: NearToken,
    /// Basis points of the pot per rank (best first), summing to 10,000.
    pub split: Vec<u16>,
    pub seats: Vec<Seat>,
    pub solo_player: Option<AccountId>,
    pub creator: AccountId,
    pub storage_deposit: NearToken,
    pub status: Status,
    pub created_at: u64,
    pub last_activity: u64,
    pub turn_seconds: u32,
    /// Nanoseconds; 0 in the lobby.
    pub turn_deadline: u64,
    /// Rng hashes drawn so far (see [`rng`]).
    pub draws: u64,
    pub game: Game,
}

/// First byte of the tail of a stored [`Match`]: after it come the game's `extras` and `tickets` (ENGINE-RULES §10),
/// which the engine leaves out of its own borsh form.
pub const MATCH_TAIL_V1: u8 = 1;
/// The same tail, followed by one more flag: `extras.build_here` (ENGINE-RULES §10.5). Written only for a match that
/// has that rule, so that every other match is stored exactly as the build before it stored it.
pub const MATCH_TAIL_V2: u8 = 2;
/// Set on the stored status byte (a [`Status`] is 0..=3) of a match that has a tail after its game.
pub const MATCH_TAIL_FLAG: u8 = 0x80;

impl BorshSerialize for Match {
    fn serialize<W: std::io::Write>(&self, writer: &mut W) -> std::io::Result<()> {
        BorshSerialize::serialize(&self.rules, writer)?;
        BorshSerialize::serialize(&self.stake, writer)?;
        BorshSerialize::serialize(&self.split, writer)?;
        BorshSerialize::serialize(&self.seats, writer)?;
        BorshSerialize::serialize(&self.solo_player, writer)?;
        BorshSerialize::serialize(&self.creator, writer)?;
        BorshSerialize::serialize(&self.storage_deposit, writer)?;
        let tail = !self.game.extras.is_off();
        let mut status = [0u8; 1];
        BorshSerialize::serialize(&self.status, &mut status.as_mut_slice())?;
        writer.write_all(&[status[0] | if tail { MATCH_TAIL_FLAG } else { 0 }])?;
        BorshSerialize::serialize(&self.created_at, writer)?;
        BorshSerialize::serialize(&self.last_activity, writer)?;
        BorshSerialize::serialize(&self.turn_seconds, writer)?;
        BorshSerialize::serialize(&self.turn_deadline, writer)?;
        BorshSerialize::serialize(&self.draws, writer)?;
        BorshSerialize::serialize(&self.game, writer)?;
        if tail {
            let build_here = self.game.extras.build_here;
            BorshSerialize::serialize(&if build_here { MATCH_TAIL_V2 } else { MATCH_TAIL_V1 }, writer)?;
            BorshSerialize::serialize(&self.game.extras, writer)?;
            BorshSerialize::serialize(&self.game.tickets, writer)?;
            if build_here {
                BorshSerialize::serialize(&true, writer)?;
            }
        }
        Ok(())
    }
}

impl BorshDeserialize for Match {
    fn deserialize_reader<R: std::io::Read>(reader: &mut R) -> std::io::Result<Self> {
        let rules = BorshDeserialize::deserialize_reader(reader)?;
        let stake = BorshDeserialize::deserialize_reader(reader)?;
        let split = BorshDeserialize::deserialize_reader(reader)?;
        let seats = BorshDeserialize::deserialize_reader(reader)?;
        let solo_player = BorshDeserialize::deserialize_reader(reader)?;
        let creator = BorshDeserialize::deserialize_reader(reader)?;
        let storage_deposit = BorshDeserialize::deserialize_reader(reader)?;
        let status = u8::deserialize_reader(reader)?;
        let tail = status & MATCH_TAIL_FLAG != 0;
        let mut m = Match {
            rules,
            stake,
            split,
            seats,
            solo_player,
            creator,
            storage_deposit,
            status: Status::try_from_slice(&[status & !MATCH_TAIL_FLAG])?,
            created_at: BorshDeserialize::deserialize_reader(reader)?,
            last_activity: BorshDeserialize::deserialize_reader(reader)?,
            turn_seconds: BorshDeserialize::deserialize_reader(reader)?,
            turn_deadline: BorshDeserialize::deserialize_reader(reader)?,
            draws: BorshDeserialize::deserialize_reader(reader)?,
            game: BorshDeserialize::deserialize_reader(reader)?,
        };
        // No flag: a match without the later rules, or one stored before they existed.
        if !tail {
            return Ok(m);
        }
        let version = u8::deserialize_reader(reader)?;
        if version != MATCH_TAIL_V1 && version != MATCH_TAIL_V2 {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "unknown match tail"));
        }
        m.game.extras = Extras::deserialize_reader(reader)?;
        m.game.tickets = Option::<Tickets>::deserialize_reader(reader)?;
        if version == MATCH_TAIL_V2 {
            m.game.extras.build_here = bool::deserialize_reader(reader)?;
        }
        Ok(m)
    }
}

/// Permanent summary of a settled match.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct MatchResult {
    pub stake: NearToken,
    /// Seat indexes, best first (the backer of each seat is `backers[rank]`; the view also lists them by seat).
    pub ranking: Vec<u8>,
    /// Backer per rank, best first.
    pub backers: Vec<AccountId>,
    /// Amount transferred per rank (0 for a house seat, whose share is forfeited).
    pub payouts: Vec<NearToken>,
    /// Shares of house seats locked in this match.
    pub forfeited: NearToken,
    pub reason: Reason,
    pub block_height: u64,
    pub ended_at: u64,
    /// Owner of the Deed NFT minted for this match (token id = match id), if any.
    pub deed: Option<AccountId>,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default)]
pub struct Stats {
    /// Settled matches in which the account backed at least one seat.
    pub played: u32,
    /// Settled matches in which the account backed the first-ranked seat.
    pub wins: u32,
    /// Total payouts received.
    pub earned: NearToken,
}

/// `rules` argument of `create_match`. Accepts `max_rounds` or `maxRounds`. The same JSON object may also carry
/// `tickets: true`, `leaderRent: true` (or `leader_rent`) and `buildHere: true` (or `build_here`), which switch on the rules of ENGINE-RULES §10 for this
/// match; absent means off. They are read from the call's arguments by [`extras_of_call`], not through this struct.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct RulesArg {
    pub salary: i64,
    pub cash: i64,
    pub blitz: bool,
    #[serde(alias = "maxRounds", default)]
    pub max_rounds: u8,
}

/// The opt-in rules a `create_match` call asks for: `rules.tickets` and `rules.leaderRent` of its JSON arguments.
/// Anything else there (no such keys, not booleans) means off.
fn extras_of_call() -> Extras {
    let rules = call_arg("rules");
    let on = |keys: [&str; 2]| keys.iter().any(|key| rules[*key] == json!(true));
    Extras { tickets: on(["tickets", "tickets"]), leader_rent: on(["leaderRent", "leader_rent"]), build_here: on(["buildHere", "build_here"]) }
}

/// The tickets a `turn` call's plan plays: `plan.tickets` of its JSON arguments ([`TicketPlan`]). Absent, or not such
/// an object: none.
fn tickets_of_call() -> TicketPlan {
    serde_json::from_value(call_arg("plan")["tickets"].clone()).unwrap_or_default()
}

/// One argument of the call being run, as the JSON it was sent as; `null` when there is none.
fn call_arg(name: &str) -> Value {
    env::input().and_then(|input| serde_json::from_slice::<Value>(&input).ok()).map_or(Value::Null, |args| args[name].clone())
}

/// What `get_config` lists under `features`: the opt-in rules this code knows. A page opens a match with one of them
/// only when the contract it talks to lists it (a contract deployed before them ignores the fields it does not know).
pub const FEATURES: [&str; 6] = ["tickets", "leaderRent", "buildHere", "hostGrace", "away", "close"];

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    house: AccountId,
    /// Unfinished matches (lobby or playing).
    matches: IterableMap<String, Match>,
    results: LookupMap<String, MatchResult>,
    stats: LookupMap<AccountId, Stats>,
    /// House shares locked forever. No method moves them.
    forfeited: NearToken,
    tokens: NonFungibleToken,
    /// Largest stake per seat a match may ask for. Set in `new`; no method changes it.
    max_stake: NearToken,
    /// Basis points of the pot kept as the fee, for matches opened from now on. Set in `new`, changed by the owner with
    /// `set_fee`; each match keeps the fee it was opened with under a key of its own (see [`fee_key`]).
    fee_bps: u16,
    /// Fees collected and not yet withdrawn. Only `withdraw_fees` moves them, and only this much.
    fees: NearToken,
}

/// The contract state before the fee existed: the layout of the first testnet deployment (2026-11-10). Read once by
/// [`Contract::migrate`].
#[derive(BorshDeserialize, BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
pub struct ContractV1 {
    owner: AccountId,
    house: AccountId,
    matches: IterableMap<String, Match>,
    results: LookupMap<String, MatchResult>,
    stats: LookupMap<AccountId, Stats>,
    forfeited: NearToken,
    tokens: NonFungibleToken,
    max_stake: NearToken,
}

// ----- Helpers ---------------------------------------------------------------------------------------------------------

fn panic_msg(message: String) -> ! {
    env::panic_str(&message)
}

fn storage_cost(bytes: u64) -> u128 {
    env::storage_byte_cost().as_yoctonear() * u128::from(bytes)
}

/// First check of every call that may draw randomness (see [`MIN_MOVE_GAS`]).
fn require_move_gas() {
    if env::prepaid_gas() < MIN_MOVE_GAS {
        panic_msg(format!("attach at least {} Tgas: a call that may roll dice must not be able to run out of gas", MIN_MOVE_GAS.as_tgas()));
    }
}

/// What to do with an engine error in the middle of a call. If the call drew no randomness, rejecting it whole is
/// harmless: the caller learned nothing. Once a die or a card was drawn the call must stand, or the caller could
/// append an action that fails on the outcomes it dislikes and roll again; then `detail` is returned for the event.
fn keep_or_revert(randomness_drawn: bool, message: String, detail: Value) -> Value {
    if !randomness_drawn {
        panic_msg(message);
    }
    detail
}

fn emit(event: &str, data: Value) {
    let body = json!({ "standard": EVENT_STANDARD, "version": EVENT_VERSION, "event": event, "data": data });
    env::log_str(&format!("EVENT_JSON:{body}"));
}

fn validate_id(id: &str) {
    require!(!id.is_empty() && id.len() <= MAX_ID_LEN, "match id must be 1..=32 characters");
    require!(
        id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
        "match id may only contain ASCII letters, digits, '-' and '_'"
    );
}

fn validate_split(split: &[u16], seats: u8) {
    require!(!split.is_empty() && split.len() <= usize::from(seats), "split needs 1..=seats entries (basis points per rank)");
    let total: u32 = split.iter().map(|&bps| u32::from(bps)).sum();
    require!(total == SPLIT_TOTAL, "split must sum to 10000 basis points");
}

fn validate_rules(rules: RulesArg) -> Rules {
    require!((0..=MAX_SALARY).contains(&rules.salary), "rules.salary must be 0..=100000");
    require!((1..=MAX_CASH).contains(&rules.cash), "rules.cash must be 1..=1000000");
    if rules.blitz {
        require!(rules.cash >= BLITZ_MIN_CASH, "Blitz needs rules.cash >= 1670 to pay for the dealt squares");
    }
    // Without a round limit a match could be kept alive forever with the stakes locked in it.
    require!(rules.max_rounds >= 1, "rules.max_rounds must be 1..=255");
    Rules { salary: rules.salary, cash: rules.cash, blitz: rules.blitz, max_rounds: rules.max_rounds }
}

fn validate_fee(fee_bps: u16) {
    require!(fee_bps <= MAX_FEE_BPS, "fee_bps must be at most 500 (5%)");
}

/// The fee on a pot: `pot * fee_bps / 10000`, rounded down.
pub fn fee_of(pot: u128, fee_bps: u16) -> u128 {
    pot * u128::from(fee_bps) / u128::from(SPLIT_TOTAL)
}

/// Shares of the pot per rank: `pot * split[i] / 10000`, the integer remainder going to rank 0. Ranks beyond the
/// split get 0. The shares always sum to `pot`.
pub fn split_pot(pot: u128, split: &[u16], ranks: usize) -> Vec<u128> {
    let mut shares: Vec<u128> =
        (0..ranks).map(|i| split.get(i).map_or(0, |&bps| pot * u128::from(bps) / u128::from(SPLIT_TOTAL))).collect();
    let paid: u128 = shares.iter().sum();
    if let Some(first) = shares.first_mut() {
        *first += pot - paid;
    }
    shares
}

/// Seat index of an engine player id (`"s2"` -> 2).
fn seat_of(player: &str) -> usize {
    SEAT_IDS.iter().position(|&s| s == player).unwrap_or_else(|| env::panic_str("unknown engine player"))
}

fn current_seat(game: &Game) -> Option<usize> {
    game.current_player().map(seat_of)
}

/// Whether moves made by seat `s` restart the turn clock: only when the seat to move changed, or when `s` was the seat
/// to move and rolled. Building, selling, mortgaging and redeeming are free and unlimited, so they never extend the
/// deadline; a turn lasts at most `turn_seconds` after each of its rolls.
fn restarts_clock(game: &Game, s: usize, seat_before: Option<usize>, rolls_before: u32) -> bool {
    current_seat(game) != seat_before || (seat_before == Some(s) && game.rolls > rolls_before)
}

/// A hosted match keeps its host under a storage key of its own, outside [`Match`]: matches opened before hosts
/// existed read as they were written, with no host, and start by themselves as they always did.
fn host_key(id: &str) -> Vec<u8> {
    [b"host:".as_slice(), id.as_bytes()].concat()
}

/// The fee a match was opened with, kept under a storage key of its own outside [`Match`], like the host: changing
/// the fee never reaches a match already open. Two bytes, little-endian basis points.
fn fee_key(id: &str) -> Vec<u8> {
    [b"fee:".as_slice(), id.as_bytes()].concat()
}

/// Written by the first `set_fee`: the fee in force until then, which is the fee of every match opened before match
/// fees were recorded. Its name cannot be a [`fee_key`] (no colon).
const FEE_BEFORE_KEY: &[u8] = b"fee_before_set";

/// Which seats of the match `id` are away, one bit a seat, under a storage key of its own outside [`Match`] like the
/// host: a match from before seats could be away reads as it was written, with nobody away.
fn away_key(id: &str) -> Vec<u8> {
    [b"away:".as_slice(), id.as_bytes()].concat()
}

fn away_of(id: &str) -> u8 {
    env::storage_read(&away_key(id)).and_then(|bytes| bytes.first().copied()).unwrap_or(0)
}

fn set_away(id: &str, mask: u8) {
    if mask == 0 {
        env::storage_remove(&away_key(id));
    } else {
        env::storage_write(&away_key(id), &[mask]);
    }
}

fn read_bps(key: &[u8]) -> Option<u16> {
    env::storage_read(key).and_then(|bytes| <[u8; 2]>::try_from(bytes.as_slice()).ok()).map(u16::from_le_bytes)
}

/// The account that starts the match `id`, if it is a hosted one still in the lobby.
fn host_of(id: &str) -> Option<AccountId> {
    env::storage_read(&host_key(id)).and_then(|bytes| String::from_utf8(bytes).ok()).and_then(|account| account.parse().ok())
}

fn transfer_all(transfers: BTreeMap<AccountId, u128>) {
    for (account, amount) in transfers {
        if amount > 0 {
            Promise::new(account).transfer(NearToken::from_yoctonear(amount)).detach();
        }
    }
}

fn u64_json(value: u64) -> Value {
    json!(U64(value))
}

fn yocto_json(value: NearToken) -> Value {
    json!(U128(value.as_yoctonear()))
}

impl Match {
    fn seat_index(&self, seat: u8) -> usize {
        let s = usize::from(seat);
        require!(s < self.seats.len(), "no such seat");
        s
    }

    /// The caller, if it is the backer or the driver of `seat`.
    fn authorize(&self, s: usize) -> AccountId {
        let caller = env::predecessor_account_id();
        let seat = &self.seats[s];
        require!(
            seat.backer.as_ref() == Some(&caller) || seat.driver.as_ref() == Some(&caller),
            "only the backer or the driver of this seat may play it"
        );
        caller
    }

    /// `{ salary, cash, blitz, maxRounds }`, with `tickets: true` and `leaderRent: true` only when the match has them.
    fn rules_json(&self) -> Value {
        let mut rules = json!(self.rules);
        if self.game.extras.tickets {
            rules["tickets"] = json!(true);
        }
        if self.game.extras.leader_rent {
            rules["leaderRent"] = json!(true);
        }
        if self.game.extras.build_here {
            rules["buildHere"] = json!(true);
        }
        rules
    }

    fn meta_json(&self, id: &str, house: &AccountId, fee_bps: u16) -> Value {
        let seats: Vec<Value> = self
            .seats
            .iter()
            .enumerate()
            .map(|(k, seat)| {
                json!({
                    "seat": k,
                    "player": SEAT_IDS[k],
                    "backer": seat.backer,
                    "driver": seat.driver,
                    "house": seat.backer.as_ref() == Some(house),
                })
            })
            .collect();
        let mut meta = json!({
            "id": id,
            "status": self.status,
            "seats": seats,
            "stake": yocto_json(self.stake),
            "split": self.split,
            "fee_bps": fee_bps,
            "rules": self.rules_json(),
            "solo_player": self.solo_player,
            "creator": self.creator,
            "host": if self.status == Status::Lobby { host_of(id) } else { None },
            "storage_deposit": yocto_json(self.storage_deposit),
            "created_at": u64_json(self.created_at),
            "last_activity": u64_json(self.last_activity),
            "turn_seconds": self.turn_seconds,
            "turn_deadline": u64_json(self.turn_deadline),
            "draws": self.draws,
            "current_seat": current_seat(&self.game),
        });
        // The seats that are away, only when some are: a match where everybody is here reads as it always did.
        let away = if self.status == Status::Playing { away_of(id) } else { 0 };
        if away != 0 {
            meta["away"] = json!((0..self.seats.len()).filter(|k| away & (1 << k) != 0).collect::<Vec<_>>());
        }
        meta
    }
}

// ----- Contract --------------------------------------------------------------------------------------------------------

#[near]
impl Contract {
    /// `max_stake` (yoctoNEAR) is the largest stake per seat any match of this deployment may ask for. `fee_bps` is
    /// the part of every pot kept as the fee, in basis points (250 is 2.5%), at most [`MAX_FEE_BPS`].
    #[init]
    #[private]
    pub fn new(owner: AccountId, house: AccountId, max_stake: U128, fee_bps: u16) -> Self {
        require!(max_stake.0 <= MAX_STAKE, "max_stake must be at most 1,000,000 NEAR");
        validate_fee(fee_bps);
        Self {
            max_stake: NearToken::from_yoctonear(max_stake.0),
            fee_bps,
            fees: NearToken::from_yoctonear(0),
            owner: owner.clone(),
            house,
            matches: IterableMap::new(b"m".to_vec()),
            results: LookupMap::new(b"r".to_vec()),
            stats: LookupMap::new(b"s".to_vec()),
            forfeited: NearToken::from_yoctonear(0),
            tokens: NonFungibleToken::new(b"o".to_vec(), owner, Some(b"t".to_vec()), Some(b"e".to_vec()), None::<Vec<u8>>),
        }
    }

    /// Upgrades a deployment made before the fee existed ([`ContractV1`]), in the transaction that deploys this code.
    /// Refused while any match is open: its players staked when there was no fee.
    #[init(ignore_state)]
    #[private]
    pub fn migrate(fee_bps: u16) -> Self {
        let old: ContractV1 = env::state_read().unwrap_or_else(|| env::panic_str("no state of the first layout to migrate"));
        validate_fee(fee_bps);
        require!(old.matches.is_empty(), "finish or abandon every open match first: they were opened without a fee");
        Self {
            owner: old.owner,
            house: old.house,
            matches: old.matches,
            results: old.results,
            stats: old.stats,
            forfeited: old.forfeited,
            tokens: old.tokens,
            max_stake: old.max_stake,
            fee_bps,
            fees: NearToken::from_yoctonear(0),
        }
    }

    /// Opens a lobby. The attached deposit pays for storage: at least the measured size of the new match plus
    /// [`STORAGE_RESERVE_BYTES`]; it is kept and refunded to the creator (minus the permanent records) when the match
    /// is settled, or in full when it is abandoned.
    #[payable]
    #[allow(clippy::too_many_arguments)]
    pub fn create_match(
        &mut self,
        id: String,
        seats: u8,
        stake: U128,
        split: Vec<u16>,
        rules: RulesArg,
        solo_player: Option<AccountId>,
        turn_seconds: Option<u32>,
        host: Option<AccountId>,
    ) {
        self.open_match(id, seats, stake, split, rules, extras_of_call(), solo_player, turn_seconds, host);
    }

    /// Backs a free seat with exactly the stake. Backing the last seat starts the game (and draws the turn order, and
    /// the Blitz deal), so every `join` needs [`MIN_MOVE_GAS`] attached.
    ///
    /// In a solo match the solo player backs exactly one seat and the house backs all the others: a match in which one
    /// account played every seat would hand it a win, stats and a Deed for nothing.
    #[payable]
    pub fn join(&mut self, id: String, seat: u8) {
        require_move_gas();
        let mut m = self.load(&id);
        require!(m.status == Status::Lobby, "the match is not in the lobby");
        let s = m.seat_index(seat);
        require!(m.seats[s].backer.is_none(), "seat already backed");
        let caller = env::predecessor_account_id();
        if let Some(solo) = &m.solo_player {
            let is_house = caller == self.house;
            require!(&caller == solo || is_house, "solo match: only the solo player or the house may back seats");
            let solo_seated = m.seats.iter().any(|seat| seat.backer.as_ref() == Some(solo));
            if is_house {
                let free = m.seats.iter().filter(|seat| seat.backer.is_none()).count();
                require!(solo_seated || free > 1, "solo match: the last free seat is the solo player's");
            } else {
                require!(!solo_seated, "solo match: the solo player backs exactly one seat");
            }
        }
        if env::attached_deposit() != m.stake {
            panic_msg(format!("attach exactly the stake: {} yoctoNEAR", m.stake.as_yoctonear()));
        }
        let now = env::block_timestamp();
        m.seats[s].backer = Some(caller.clone());
        m.last_activity = now;
        emit("join", json!({ "id": id, "seat": s, "backer": caller }));

        // A hosted match waits here, every seat taken, until its host says go (`start`).
        if m.seats.iter().all(|seat| seat.backer.is_some()) && host_of(&id).is_none() {
            begin(&id, &mut m, now);
        }
        self.matches.insert(id, m);
    }

    /// The host of a hosted match starts the game once every seat is taken: the turn order is drawn (and the Blitz
    /// deal), as `join` does for a match with no host. Needs [`MIN_MOVE_GAS`] attached.
    pub fn start(&mut self, id: String) {
        require_move_gas();
        self.start_hosted(id);
    }

    /// Gives up a seat before the game starts; the backer gets the stake back.
    pub fn leave(&mut self, id: String, seat: u8) {
        let mut m = self.load(&id);
        require!(m.status == Status::Lobby, "the game has already started");
        let s = m.seat_index(seat);
        let caller = env::predecessor_account_id();
        require!(m.seats[s].backer.as_ref() == Some(&caller), "only the backer may leave a seat");
        m.seats[s] = Seat::default();
        m.last_activity = env::block_timestamp();
        let stake = m.stake;
        self.matches.insert(id.clone(), m);
        if stake.as_yoctonear() > 0 {
            Promise::new(caller.clone()).transfer(stake).detach();
        }
        emit("leave", json!({ "id": id, "seat": s, "backer": caller, "refund": yocto_json(stake) }));
    }

    /// Lets `driver` (an agent account) play the seat too, or removes the driver with `None`. Backer only.
    pub fn set_driver(&mut self, id: String, seat: u8, driver: Option<AccountId>) {
        let mut m = self.load(&id);
        let s = m.seat_index(seat);
        let caller = env::predecessor_account_id();
        require!(m.seats[s].backer.as_ref() == Some(&caller), "only the backer may set the driver");
        m.seats[s].driver = driver.clone();
        m.last_activity = env::block_timestamp();
        self.matches.insert(id.clone(), m);
        emit("set_driver", json!({ "id": id, "seat": s, "backer": caller, "driver": driver }));
    }

    /// Applies `actions` in order as `seat` (backer or driver only) and returns
    /// `{ "applied": <count>, "rejected": null | { "index", "action", "error" } }`.
    ///
    /// If the engine rejects an action before the call drew any randomness, the whole call is rejected and nothing
    /// changes. Once a die or a card was drawn the call stands: the actions applied so far are kept, the rest of the
    /// list is dropped, and the rejected action is reported in the return value and in the `actions` event. (If it
    /// reverted instead, `["Roll", <an action that fails after a bad roll>]` would be a free re-roll.)
    ///
    /// `Sell`/`Mortgage`/`Redeem` work out of turn exactly as the engine allows. `Start` and `Auto` are not accepted
    /// (`Auto` is what `timeout` does).
    ///
    /// One exception to the last: `["Start"]` alone, from the host of a hosted match still in the lobby, is `start`.
    /// A key that may only call the moves of a match (a session key) can then start one as well.
    pub fn play(&mut self, id: String, seat: u8, actions: Vec<Action>) -> Value {
        require_move_gas();
        require!(actions.len() <= MAX_ACTIONS_PER_CALL, "send at most 32 actions");
        if actions == [Action::Start] && self.matches.get(&id).is_some_and(|m| m.status == Status::Lobby) {
            self.start_hosted(id);
            return json!({ "applied": 1, "rejected": null });
        }
        let mut m = self.load_playing(&id);
        let s = m.seat_index(seat);
        let caller = m.authorize(s);
        // Whoever moves is here: a seat that was away gets its whole clock again. No actions at all is "I am back".
        let away = away_of(&id);
        if away & (1 << s) != 0 {
            set_away(&id, away & !(1 << s));
            emit("back", json!({ "id": id, "seat": s, "by": caller }));
        }
        if actions.is_empty() {
            require!(away & (1 << s) != 0, "send 1..=32 actions");
            // Its turn right now: the clock it would have had, from now.
            if current_seat(&m.game) == Some(s) {
                m.turn_deadline = env::block_timestamp() + u64::from(m.turn_seconds) * 1_000_000_000;
                self.matches.insert(id, m);
            }
            return json!({ "applied": 0, "rejected": null });
        }
        // Checked for the whole list before anything is applied, so this rejection never follows a roll.
        if let Some((i, action)) = actions.iter().enumerate().find(|(_, action)| matches!(action, Action::Start | Action::Auto)) {
            panic_msg(format!("action {i} ({}) is not playable; use timeout() after the deadline", action.op()));
        }
        let seat_before = current_seat(&m.game);
        let rolls_before = m.game.rolls;
        let draws_before = m.draws;
        let mut steps = Vec::new();
        let mut failure = None;
        {
            let mut rng = ChainRng::new(env::random_seed_array(), &id, &mut m.draws, near_sha256);
            for (i, &action) in actions.iter().enumerate() {
                if let Err(error) = apply_logged(&mut m.game, Some(SEAT_IDS[s]), action, &mut rng, &mut steps) {
                    failure = Some((i, action, error));
                    break;
                }
            }
        }
        let rejected = failure.map(|(i, action, error)| {
            keep_or_revert(
                m.draws != draws_before,
                format!("action {i} ({}) rejected: {error}", action.op()),
                json!({ "index": i, "action": action, "error": error.to_string() }),
            )
        });
        let reset = restarts_clock(&m.game, s, seat_before, rolls_before);
        let outcome = json!({ "applied": steps.len(), "rejected": rejected });
        self.after_moves(id, m, "play", s, caller, steps, rejected, reset);
        outcome
    }

    /// One transaction per agent turn: rolls, applies `plan` deterministically, rolls again after doubles and ends the
    /// turn (see [`autoplay::play_turn`]). `seat` must be the current player.
    pub fn turn(&mut self, id: String, seat: u8, plan: Plan) {
        require_move_gas();
        require!(plan.build.len() <= MAX_PLAN_LIST && plan.liquidate.len() <= MAX_PLAN_LIST, "plan lists hold at most 40 squares");
        self.turn_with(id, seat, plan, tickets_of_call());
    }
}

impl Contract {
    /// `turn` with the tickets its plan plays: what the method does once it has read them.
    pub(crate) fn turn_with(&mut self, id: String, seat: u8, plan: Plan, tickets: TicketPlan) {
        require!(tickets.takeover.len() <= MAX_PLAN_LIST, "plan lists hold at most 40 squares");
        let mut m = self.load_playing(&id);
        let s = m.seat_index(seat);
        let caller = m.authorize(s);
        let away = away_of(&id);
        if away & (1 << s) != 0 {
            set_away(&id, away & !(1 << s));
        }
        let seat_before = current_seat(&m.game);
        require!(seat_before == Some(s), "it is not this seat's turn");
        let rolls_before = m.game.rolls;
        let draws_before = m.draws;
        let mut steps = Vec::new();
        let played = {
            let mut rng = ChainRng::new(env::random_seed_array(), &id, &mut m.draws, near_sha256);
            play_turn_with(&mut m.game, SEAT_IDS[s], &plan, &tickets, &mut rng, &mut steps)
        };
        // The driver checks every optional action first, so no error is expected after the roll; the rule of `play`
        // applies all the same.
        let rejected = played
            .err()
            .map(|error| keep_or_revert(m.draws != draws_before, format!("turn failed: {error}"), json!({ "error": error.to_string() })));
        let reset = restarts_clock(&m.game, s, seat_before, rolls_before);
        self.after_moves(id, m, "turn", s, caller, steps, rejected, reset);
    }
}

#[near]
impl Contract {
    /// Anyone, once the turn deadline has passed: one engine `Auto` step for the current player (roll, skip buying, or
    /// end the turn), or, in debt, the deterministic liquidation (sell houses, mortgage, pay, else bankrupt).
    ///
    /// While the timed-out player still holds the turn the deadline stays expired, so the next step can be forced at
    /// once; when the turn passes, the next player gets a fresh deadline.
    ///
    /// A seat that let its whole clock run out without even throwing is **away**: this call plays the rest of its turn
    /// too, and from then on its turns get [`AWAY_TURN_SECONDS`] instead of the match's clock, so that one absent
    /// player does not hold the table for every round. It is here again as soon as it moves (`play`, `turn`), or says
    /// so with `play` and no actions.
    pub fn timeout(&mut self, id: String) {
        require_move_gas();
        let mut m = self.load_playing(&id);
        if env::block_timestamp() <= m.turn_deadline {
            panic_msg(format!("the turn deadline ({}) has not passed", m.turn_deadline));
        }
        let before = current_seat(&m.game);
        let s = before.unwrap_or_else(|| env::panic_str("no current player"));
        let away = away_of(&id);
        // Nothing thrown yet this turn: the seat did not come to its turn at all.
        let absent = m.game.stage == deedlords_engine::Stage::Roll;
        if absent && away & (1 << s) == 0 {
            set_away(&id, away | (1 << s));
        }
        let whole_turn = absent || away & (1 << s) != 0;
        let draws_before = m.draws;
        let mut steps = Vec::new();
        let stepped = {
            let mut rng = ChainRng::new(env::random_seed_array(), &id, &mut m.draws, near_sha256);
            let mut stepped = timeout_step(&mut m.game, &mut rng, &mut steps);
            let mut played = 1;
            while whole_turn && stepped.is_ok() && played < AWAY_STEPS && m.game.phase == Phase::Playing && current_seat(&m.game) == before {
                stepped = timeout_step(&mut m.game, &mut rng, &mut steps);
                played += 1;
            }
            stepped
        };
        let rejected = stepped.err().map(|error| {
            keep_or_revert(m.draws != draws_before, format!("timeout failed: {error}"), json!({ "error": error.to_string() }))
        });
        let reset = current_seat(&m.game) != before;
        self.after_moves(id, m, "timeout", s, env::predecessor_account_id(), steps, rejected, reset);
    }

    /// Anyone, when nothing has moved at a table under way for 15 minutes (everybody left it): the game ends as it
    /// stands, ranked by net worth as when the rounds run out, and is settled like any other. While somebody is still
    /// at the table its moves and its `timeout` calls keep it alive, so this reaches only tables nobody is at.
    pub fn close(&mut self, id: String) {
        require_move_gas();
        let mut m = self.load_playing(&id);
        if env::block_timestamp() < m.last_activity + ABANDON_AFTER_NS {
            panic_msg(format!("a table can be closed 15 minutes after its last move (at {})", m.last_activity + ABANDON_AFTER_NS));
        }
        m.game.close();
        emit("close", json!({ "id": id, "by": env::predecessor_account_id() }));
        self.settle(id, m);
    }

    /// Anyone, if the match is still in the lobby 15 minutes after creation: refunds every stake and the storage
    /// deposit and deletes the match.
    pub fn abandon(&mut self, id: String) {
        let m = self.load(&id);
        require!(m.status == Status::Lobby, "only a match still in the lobby can be abandoned");
        if env::block_timestamp() < m.created_at + ABANDON_AFTER_NS {
            panic_msg(format!("a lobby can be abandoned 15 minutes after creation (at {})", m.created_at + ABANDON_AFTER_NS));
        }
        self.matches.remove(&id);
        env::storage_remove(&host_key(&id));
        env::storage_remove(&fee_key(&id));
        let mut transfers: BTreeMap<AccountId, u128> = BTreeMap::new();
        let mut refunds = Vec::new();
        for (k, seat) in m.seats.iter().enumerate() {
            if let Some(backer) = &seat.backer {
                *transfers.entry(backer.clone()).or_default() += m.stake.as_yoctonear();
                refunds.push(json!({ "seat": k, "backer": backer, "amount": yocto_json(m.stake) }));
            }
        }
        *transfers.entry(m.creator.clone()).or_default() += m.storage_deposit.as_yoctonear();
        transfer_all(transfers);
        emit(
            "abandon",
            json!({
                "id": id,
                "status": Status::Abandoned,
                "refunds": refunds,
                "creator": m.creator,
                "storage_refund": yocto_json(m.storage_deposit),
            }),
        );
    }

    /// Owner only, with exactly 1 yoctoNEAR attached (so a full-access key has to sign): sets the fee, in basis points
    /// of the pot, at most [`MAX_FEE_BPS`], for matches opened from now on. A match already open keeps the fee it was
    /// opened with, so no player ever pays a fee they did not see when they staked.
    #[payable]
    pub fn set_fee(&mut self, fee_bps: u16) {
        assert_one_yocto();
        require!(env::predecessor_account_id() == self.owner, "only the owner may set the fee");
        validate_fee(fee_bps);
        if env::storage_read(FEE_BEFORE_KEY).is_none() {
            env::storage_write(FEE_BEFORE_KEY, &self.fee_bps.to_le_bytes());
        }
        emit("set_fee", json!({ "from": self.fee_bps, "to": fee_bps }));
        self.fee_bps = fee_bps;
    }

    /// Owner only, with exactly 1 yoctoNEAR attached (so a full-access key has to sign): sends the fees collected so
    /// far to the owner and returns the amount. Stakes of open matches, storage deposits and the house's forfeited
    /// shares are not fees: this method cannot reach them.
    #[payable]
    pub fn withdraw_fees(&mut self) -> U128 {
        assert_one_yocto();
        require!(env::predecessor_account_id() == self.owner, "only the owner may withdraw the fees");
        let amount = self.fees;
        require!(amount.as_yoctonear() > 0, "there are no fees to withdraw");
        self.fees = NearToken::from_yoctonear(0);
        Promise::new(self.owner.clone()).transfer(amount).detach();
        emit("withdraw_fees", json!({ "to": self.owner, "amount": yocto_json(amount) }));
        U128(amount.as_yoctonear())
    }

    // ----- Views ---------------------------------------------------------------------------------------------------

    /// `{ meta, game, log }`: seats, backers, drivers, stake, split, status, deadline and rules; the engine snapshot
    /// (ENGINE-RULES §8, same field names as the TS `Game`); the last 30 structured engine events. `null` when the
    /// match does not exist or is finished (see `get_result`).
    pub fn get_match(&self, id: String) -> Option<Value> {
        self.matches
            .get(&id)
            .map(|m| json!({ "meta": m.meta_json(&id, &self.house, self.fee_of_match(&id)), "game": m.game.snapshot(), "log": m.game.log }))
    }

    /// Unfinished matches (lobby or playing), `limit` defaults to 20 (at most 50).
    pub fn list_matches(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Value> {
        let from = from_index.unwrap_or(0) as usize;
        let limit = limit.unwrap_or(20).min(50) as usize;
        self.matches
            .iter()
            .skip(from)
            .take(limit)
            .map(|(id, m)| {
                let mut meta = m.meta_json(id, &self.house, self.fee_of_match(id));
                meta["round"] = json!(m.game.round);
                meta["phase"] = json!(m.game.phase);
                meta
            })
            .collect()
    }

    pub fn get_result(&self, id: String) -> Option<Value> {
        self.results.get(&id).map(|r| {
            let mut seats = r.backers.clone();
            for (rank, &seat) in r.ranking.iter().enumerate() {
                seats[usize::from(seat)] = r.backers[rank].clone();
            }
            // The fee is what is left of the pot after the payouts and the house's locked shares: the stored summary
            // keeps the layout it had before the fee existed, and a match settled back then shows a fee of 0.
            let pot = r.stake.as_yoctonear() * r.backers.len() as u128;
            let paid: u128 = r.payouts.iter().map(|p| p.as_yoctonear()).sum();
            let fee = pot.saturating_sub(paid).saturating_sub(r.forfeited.as_yoctonear());
            json!({
                "id": id,
                "stake": yocto_json(r.stake),
                "pot": json!(U128(pot)),
                "fee": json!(U128(fee)),
                "seats": seats,
                "ranking": r.ranking,
                "backers": r.backers,
                "payouts": r.payouts.iter().map(|&p| yocto_json(p)).collect::<Vec<_>>(),
                "forfeited": yocto_json(r.forfeited),
                "reason": r.reason,
                "block_height": u64_json(r.block_height),
                "ended_at": u64_json(r.ended_at),
                "deed": r.deed,
            })
        })
    }

    pub fn get_stats(&self, account_id: AccountId) -> Value {
        let stats = self.stats.get(&account_id).cloned().unwrap_or_default();
        json!({ "played": stats.played, "wins": stats.wins, "earned": yocto_json(stats.earned) })
    }

    pub fn get_forfeited(&self) -> U128 {
        U128(self.forfeited.as_yoctonear())
    }

    /// Fees collected and not yet withdrawn.
    pub fn get_fees(&self) -> U128 {
        U128(self.fees.as_yoctonear())
    }

    pub fn get_config(&self) -> Value {
        json!({
            "owner": self.owner,
            "house": self.house,
            "matches": self.matches.len(),
            "storage_reserve_bytes": STORAGE_RESERVE_BYTES,
            "default_turn_seconds": DEFAULT_TURN_SECONDS,
            "abandon_after_ns": u64_json(ABANDON_AFTER_NS),
            "max_stake": yocto_json(self.max_stake),
            "fee_bps": self.fee_bps,
            "max_fee_bps": MAX_FEE_BPS,
            "min_move_gas": u64_json(MIN_MOVE_GAS.as_gas()),
            "features": FEATURES,
        })
    }
}

// ----- Internals -------------------------------------------------------------------------------------------------------

/// Starts the game of a match whose seats are all taken: draws the turn order (and the Blitz deal) and sets the first
/// deadline. The host's record, if there was one, has done its work and is removed.
fn begin(id: &str, m: &mut Match, now: u64) {
    let mut steps = Vec::new();
    let mut rng = ChainRng::new(env::random_seed_array(), id, &mut m.draws, near_sha256);
    if let Err(error) = apply_logged(&mut m.game, None, Action::Start, &mut rng, &mut steps) {
        panic_msg(format!("cannot start: {error}"));
    }
    m.status = Status::Playing;
    m.turn_deadline = now + u64::from(m.turn_seconds) * 1_000_000_000;
    env::storage_remove(&host_key(id));
    let order: Vec<usize> = m.game.order.iter().map(|p| seat_of(p)).collect();
    emit(
        "start",
        json!({
            "id": id,
            "order": order,
            "props": m.game.props,
            "steps": steps,
            "turn_deadline": u64_json(m.turn_deadline),
        }),
    );
}

impl Contract {
    /// `create_match` with the opt-in rules given (`extras`): what the method does once it has read them.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn open_match(
        &mut self,
        id: String,
        seats: u8,
        stake: U128,
        split: Vec<u16>,
        rules: RulesArg,
        extras: Extras,
        solo_player: Option<AccountId>,
        turn_seconds: Option<u32>,
        host: Option<AccountId>,
    ) {
        validate_id(&id);
        require!(!self.matches.contains_key(&id) && !self.results.contains_key(&id), "match id already used");
        require!((MIN_SEATS..=MAX_SEATS).contains(&seats), "seats must be 2..=4");
        if stake.0 > self.max_stake.as_yoctonear() {
            panic_msg(format!("stake too large: this contract allows at most {} yoctoNEAR per seat", self.max_stake.as_yoctonear()));
        }
        require!(solo_player.as_ref() != Some(&self.house), "the house cannot be the solo player");
        require!(host.is_none() || solo_player.is_none(), "a solo match starts by itself: it has no host");
        validate_split(&split, seats);
        let rules = validate_rules(rules);
        let turn_seconds = turn_seconds.unwrap_or(DEFAULT_TURN_SECONDS);
        require!((1..=MAX_TURN_SECONDS).contains(&turn_seconds), "turn_seconds must be 1..=86400");

        let now = env::block_timestamp();
        let creator = env::predecessor_account_id();
        let deposit = env::attached_deposit();
        let players = SEAT_IDS[..usize::from(seats)].iter().map(|s| s.to_string()).collect();
        let new_match = Match {
            rules,
            stake: NearToken::from_yoctonear(stake.0),
            split,
            seats: vec![Seat::default(); usize::from(seats)],
            solo_player,
            creator: creator.clone(),
            storage_deposit: deposit,
            status: Status::Lobby,
            created_at: now,
            last_activity: now,
            turn_seconds,
            turn_deadline: 0,
            draws: 0,
            game: Game::new(rules, players).with_extras(extras),
        };
        let before = env::storage_usage();
        // Inside what is measured: the creator's deposit pays for the host's record and the fee's too.
        if let Some(host) = &host {
            env::storage_write(&host_key(&id), host.as_bytes());
        }
        env::storage_write(&fee_key(&id), &self.fee_bps.to_le_bytes());
        let data = json!({ "id": id, "meta": new_match.meta_json(&id, &self.house, self.fee_bps) });
        let id_for_error = id.clone();
        self.matches.insert(id, new_match);
        self.matches.flush();
        let measured = env::storage_usage().saturating_sub(before);
        let required = storage_cost(measured + STORAGE_RESERVE_BYTES);
        if deposit.as_yoctonear() < required {
            // The receipt reverts anyway; removing keeps unit-test state consistent too.
            env::storage_remove(&host_key(&id_for_error));
            env::storage_remove(&fee_key(&id_for_error));
            self.matches.remove(&id_for_error);
            self.matches.flush();
            panic_msg(format!(
                "attach at least {required} yoctoNEAR for storage ({measured} bytes measured + {STORAGE_RESERVE_BYTES} reserved)"
            ));
        }
        emit("create_match", data);
    }

    /// `start`, and `play(["Start"])`: the host says go.
    fn start_hosted(&mut self, id: String) {
        let mut m = self.load(&id);
        require!(m.status == Status::Lobby, "the game has already started");
        let Some(host) = host_of(&id) else { env::panic_str("this match has no host: it starts when its last seat is taken") };
        require!(m.seats.iter().all(|seat| seat.backer.is_some()), "every seat must be taken before the game starts");
        let now = env::block_timestamp();
        let caller = env::predecessor_account_id();
        if caller != host {
            // A host who is not there must not hold a full room: after a grace, anyone seated starts it.
            require!(m.seats.iter().any(|seat| seat.backer.as_ref() == Some(&caller)), "only the host or a seated player may start the game");
            if now < m.last_activity + HOST_GRACE_NS {
                panic_msg(format!("the host starts the game; anyone seated may from {}", m.last_activity + HOST_GRACE_NS));
            }
        }
        m.last_activity = now;
        begin(&id, &mut m, now);
        self.matches.insert(id, m);
    }

    fn load(&self, id: &str) -> Match {
        match self.matches.get(id) {
            Some(m) => m.clone(),
            None if self.results.contains_key(id) => env::panic_str("the match has ended"),
            None => env::panic_str("no such match"),
        }
    }

    fn load_playing(&self, id: &str) -> Match {
        let m = self.load(id);
        require!(m.status == Status::Playing && m.game.phase == Phase::Playing, "the match is not being played");
        m
    }

    /// Common tail of `play`, `turn` and `timeout`: bookkeeping, the event, then settlement or saving. `rejected` is
    /// the engine error that cut the call short after randomness was drawn (see [`keep_or_revert`]).
    #[allow(clippy::too_many_arguments)]
    fn after_moves(
        &mut self,
        id: String,
        mut m: Match,
        kind: &str,
        s: usize,
        by: AccountId,
        steps: Vec<Step>,
        rejected: Option<Value>,
        reset_deadline: bool,
    ) {
        let now = env::block_timestamp();
        m.last_activity = now;
        if reset_deadline {
            // A seat that is away gets a short clock: the table does not wait a whole turn for it every round.
            let next_away = current_seat(&m.game).is_some_and(|next| away_of(&id) & (1 << next) != 0);
            let seconds = if next_away { AWAY_TURN_SECONDS.min(m.turn_seconds) } else { m.turn_seconds };
            m.turn_deadline = now + u64::from(seconds) * 1_000_000_000;
        }
        let mut data = json!({
            "id": id,
            "kind": kind,
            "seat": s,
            "by": by,
            "steps": steps,
            "phase": m.game.phase,
            "stage": m.game.stage,
            "current_seat": current_seat(&m.game),
            "turn_deadline": u64_json(m.turn_deadline),
        });
        if let Some(rejected) = rejected {
            data["rejected"] = rejected;
        }
        if serde_json::to_string(&data).map_or(0, |s| s.len()) > MAX_EVENT_BYTES {
            data["steps"] = json!(steps.iter().map(|step| step.action).collect::<Vec<_>>());
            data["events_omitted"] = json!(true);
        }
        emit("actions", data);
        if m.game.phase == Phase::Ended {
            self.settle(id, m);
        } else {
            self.matches.insert(id, m);
        }
    }

    /// The fee the match `id` was opened with: its own record; for a match opened before records existed, the fee in
    /// force then (kept by the first `set_fee`, or still in force when nothing has changed it).
    fn fee_of_match(&self, id: &str) -> u16 {
        read_bps(&fee_key(id)).or_else(|| read_bps(FEE_BEFORE_KEY)).unwrap_or(self.fee_bps)
    }

    /// Pays out an ended match exactly once. The match is removed from `matches` in the same call and a summary is
    /// written to `results`; both `load` paths refuse an id found in `results`, so nothing can reach this twice.
    fn settle(&mut self, id: String, mut m: Match) {
        require!(!self.results.contains_key(&id), "the match was already settled");
        let result = m.game.result.clone().unwrap_or_else(|| env::panic_str("an ended game has a result"));
        m.status = Status::Ended;

        let ranking: Vec<usize> = result.ranking.iter().map(|p| seat_of(p)).collect();
        require!(ranking.len() == m.seats.len(), "the ranking covers every seat");
        let pot = m.stake.as_yoctonear() * m.seats.len() as u128;
        // The fee comes off the whole pot first; the ranks share what is left, so fee + shares == pot to the yocto.
        let fee_bps = self.fee_of_match(&id);
        env::storage_remove(&fee_key(&id));
        env::storage_remove(&away_key(&id));
        let fee = fee_of(pot, fee_bps);
        let shares = split_pot(pot - fee, &m.split, ranking.len());
        let backers: Vec<AccountId> = ranking
            .iter()
            .map(|&s| m.seats[s].backer.clone().unwrap_or_else(|| env::panic_str("every seat is backed while playing")))
            .collect();

        let mut payouts = Vec::with_capacity(backers.len());
        let mut forfeited: u128 = 0;
        let mut earned: BTreeMap<AccountId, u128> = BTreeMap::new();
        let mut ranks_json = Vec::with_capacity(backers.len());
        for (rank, backer) in backers.iter().enumerate() {
            let house = *backer == self.house;
            if house {
                forfeited += shares[rank];
                payouts.push(NearToken::from_yoctonear(0));
            } else {
                payouts.push(NearToken::from_yoctonear(shares[rank]));
                *earned.entry(backer.clone()).or_default() += shares[rank];
            }
            ranks_json.push(json!({
                "rank": rank,
                "seat": ranking[rank],
                "backer": backer,
                "share": json!(U128(shares[rank])),
                "forfeited": house,
            }));
        }
        self.forfeited = self.forfeited.saturating_add(NearToken::from_yoctonear(forfeited));
        self.fees = self.fees.saturating_add(NearToken::from_yoctonear(fee));

        // Free the match first, so the bytes measured below are only the permanent records.
        self.matches.remove(&id);
        self.matches.flush();
        let before = env::storage_usage();

        let winner = backers[0].clone();
        let mut accounts: Vec<AccountId> = m.seats.iter().filter_map(|seat| seat.backer.clone()).collect();
        accounts.sort();
        accounts.dedup();
        for account in accounts {
            let mut stats = self.stats.get(&account).cloned().unwrap_or_default();
            stats.played += 1;
            if account == winner {
                stats.wins += 1;
            }
            let gain = earned.get(&account).copied().unwrap_or(0);
            stats.earned = stats.earned.saturating_add(NearToken::from_yoctonear(gain));
            self.stats.insert(account, stats);
        }

        let block_height = env::block_height();
        let now = env::block_timestamp();
        let seat_backers: Vec<AccountId> = m.seats.iter().filter_map(|seat| seat.backer.clone()).collect();
        let deed = if winner != self.house {
            let extra = json!({
                "match": id,
                "stake": yocto_json(m.stake),
                "seats": seat_backers,
                "ranking": ranking,
                "reason": result.reason,
                "block_height": u64_json(block_height),
            });
            let metadata = TokenMetadata {
                title: Some(format!("Deedlords match {id}")),
                description: Some(format!("Winner's deed of Deedlords match {id}, settled on-chain at block {block_height}.")),
                issued_at: Some((now / 1_000_000).to_string()),
                extra: Some(extra.to_string()),
                ..TokenMetadata::default()
            };
            self.tokens.internal_mint_with_refund(id.clone(), winner.clone(), Some(metadata), None);
            NftMint { owner_id: &winner, token_ids: &[&id], memo: None }.emit();
            Some(winner.clone())
        } else {
            None
        };

        self.results.insert(
            id.clone(),
            MatchResult {
                stake: m.stake,
                ranking: ranking.iter().map(|&s| s as u8).collect(),
                backers,
                payouts,
                forfeited: NearToken::from_yoctonear(forfeited),
                reason: result.reason,
                block_height,
                ended_at: now,
                deed: deed.clone(),
            },
        );
        self.results.flush();
        self.stats.flush();
        let record_bytes = env::storage_usage().saturating_sub(before);
        let storage_refund = m.storage_deposit.as_yoctonear().saturating_sub(storage_cost(record_bytes));

        let mut transfers = earned;
        *transfers.entry(m.creator.clone()).or_default() += storage_refund;
        transfer_all(transfers);

        emit(
            "settle",
            json!({
                "id": id,
                "status": m.status,
                "reason": result.reason,
                "pot": json!(U128(pot)),
                "fee": json!(U128(fee)),
                "fee_bps": fee_bps,
                "ranks": ranks_json,
                "forfeited": json!(U128(forfeited)),
                "deed": deed,
                "block_height": u64_json(block_height),
                "record_bytes": record_bytes,
                "storage_refund": json!(U128(storage_refund)),
            }),
        );
    }
}

// ----- NEP-171 Deeds ---------------------------------------------------------------------------------------------------

#[near]
impl NonFungibleTokenCore for Contract {
    #[payable]
    fn nft_transfer(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>) {
        self.tokens.nft_transfer(receiver_id, token_id, approval_id, memo);
    }

    #[payable]
    fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<bool> {
        self.tokens.nft_transfer_call(receiver_id, token_id, approval_id, memo, msg)
    }

    fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.tokens.nft_token(token_id)
    }
}

#[near]
impl NonFungibleTokenResolver for Contract {
    #[private]
    fn nft_resolve_transfer(
        &mut self,
        previous_owner_id: AccountId,
        receiver_id: AccountId,
        token_id: TokenId,
        approved_account_ids: Option<std::collections::HashMap<AccountId, u64>>,
    ) -> bool {
        self.tokens.nft_resolve_transfer(previous_owner_id, receiver_id, token_id, approved_account_ids)
    }
}

#[near]
impl NonFungibleTokenEnumeration for Contract {
    fn nft_total_supply(&self) -> U128 {
        self.tokens.nft_total_supply()
    }

    fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens(from_index, limit)
    }

    fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        self.tokens.nft_supply_for_owner(account_id)
    }

    fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens_for_owner(account_id, from_index, limit)
    }
}

#[near]
impl NonFungibleTokenMetadataProvider for Contract {
    fn nft_metadata(&self) -> NFTContractMetadata {
        NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name: "Deedlords Deeds".to_string(),
            symbol: "DEED".to_string(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        }
    }
}
