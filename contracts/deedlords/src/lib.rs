//! Deedlords NEAR contract: the referee around the pure rules engine (`deedlords-engine`).
//!
//! * A match has 2–4 seats. Seat `k` is the engine player `"s<k>"` and is backed by an account that paid the stake;
//!   the backer may name a driver (an agent account) that may also play the seat. One account may back several seats
//!   (typically the house in a solo match).
//! * When the last seat is backed the game starts in the same call. Every move goes through the engine with the
//!   on-chain Rng ([`rng`]); any engine error rejects the whole call.
//! * Each turn has a deadline; after it anyone may call `timeout`, so no one can stall a match.
//! * When the engine reports the end, the contract settles once: pays the pot by rank, locks the house's shares
//!   forever (`forfeited`), mints a Deed NFT (NEP-171) to a non-house winner, records stats and a summary, deletes the
//!   match and refunds the creator's storage deposit (minus the bytes the permanent records occupy).
//!
//! Every successful state change logs `EVENT_JSON:{"standard":"deedlords","version":"1.0.0","event":..,"data":..}`.
//! The engine `Game` is stored with borsh; JSON is only produced for views and events.

pub mod autoplay;
pub mod rng;
#[cfg(test)]
mod tests;

use std::collections::BTreeMap;

use deedlords_engine::{Action, Game, Phase, Reason, Rules};
use near_contract_standards::non_fungible_token::core::{NonFungibleTokenCore, NonFungibleTokenResolver};
use near_contract_standards::non_fungible_token::events::NftMint;
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, NonFungibleTokenMetadataProvider, TokenMetadata, NFT_METADATA_SPEC,
};
use near_contract_standards::non_fungible_token::{NonFungibleToken, NonFungibleTokenEnumeration, Token, TokenId};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise, PromiseOrValue};

pub use autoplay::{Plan, Step};
use autoplay::{apply_logged, play_turn, timeout_step, MAX_PLAN_LIST};
use rng::{near_sha256, ChainRng};

/// Engine player id of each seat.
pub const SEAT_IDS: [&str; 4] = ["s0", "s1", "s2", "s3"];
pub const MIN_SEATS: u8 = 2;
pub const MAX_SEATS: u8 = 4;
pub const DEFAULT_TURN_SECONDS: u32 = 20;
pub const MAX_TURN_SECONDS: u32 = 86_400;
/// A match still in the lobby this long after creation may be abandoned by anyone.
pub const ABANDON_AFTER_NS: u64 = 15 * 60 * 1_000_000_000;
/// Blitz deals 5 squares per player at list price; the 5 dearest ownables cost 400 + 350 + 320 + 300 + 300.
pub const BLITZ_MIN_CASH: i64 = 1670;
pub const MAX_CASH: i64 = 1_000_000;
pub const MAX_SALARY: i64 = 100_000;
/// Basis points of a full pot.
pub const SPLIT_TOTAL: u32 = 10_000;
/// Largest stake (1,000,000 NEAR), so `pot * basis points` always fits in a u128.
pub const MAX_STAKE: u128 = 1_000_000 * 10u128.pow(24);
pub const MAX_ID_LEN: usize = 32;
pub const MAX_ACTIONS_PER_CALL: usize = 32;
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
#[near(serializers = [borsh])]
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

/// `rules` argument of `create_match`. Accepts `max_rounds` or `maxRounds`.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct RulesArg {
    pub salary: i64,
    pub cash: i64,
    pub blitz: bool,
    #[serde(alias = "maxRounds", default)]
    pub max_rounds: u8,
}

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
}

// ----- Helpers ---------------------------------------------------------------------------------------------------------

fn panic_msg(message: String) -> ! {
    env::panic_str(&message)
}

fn storage_cost(bytes: u64) -> u128 {
    env::storage_byte_cost().as_yoctonear() * u128::from(bytes)
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
    Rules { salary: rules.salary, cash: rules.cash, blitz: rules.blitz, max_rounds: rules.max_rounds }
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

    fn meta_json(&self, id: &str, house: &AccountId) -> Value {
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
        json!({
            "id": id,
            "status": self.status,
            "seats": seats,
            "stake": yocto_json(self.stake),
            "split": self.split,
            "rules": self.rules,
            "solo_player": self.solo_player,
            "creator": self.creator,
            "storage_deposit": yocto_json(self.storage_deposit),
            "created_at": u64_json(self.created_at),
            "last_activity": u64_json(self.last_activity),
            "turn_seconds": self.turn_seconds,
            "turn_deadline": u64_json(self.turn_deadline),
            "draws": self.draws,
            "current_seat": current_seat(&self.game),
        })
    }
}

// ----- Contract --------------------------------------------------------------------------------------------------------

#[near]
impl Contract {
    #[init]
    #[private]
    pub fn new(owner: AccountId, house: AccountId) -> Self {
        Self {
            owner: owner.clone(),
            house,
            matches: IterableMap::new(b"m".to_vec()),
            results: LookupMap::new(b"r".to_vec()),
            stats: LookupMap::new(b"s".to_vec()),
            forfeited: NearToken::from_yoctonear(0),
            tokens: NonFungibleToken::new(b"o".to_vec(), owner, Some(b"t".to_vec()), Some(b"e".to_vec()), None::<Vec<u8>>),
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
    ) {
        validate_id(&id);
        require!(!self.matches.contains_key(&id) && !self.results.contains_key(&id), "match id already used");
        require!((MIN_SEATS..=MAX_SEATS).contains(&seats), "seats must be 2..=4");
        require!(stake.0 <= MAX_STAKE, "stake too large");
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
            game: Game::new(rules, players),
        };
        let data = json!({ "id": id, "meta": new_match.meta_json(&id, &self.house) });

        let before = env::storage_usage();
        let id_for_error = id.clone();
        self.matches.insert(id, new_match);
        self.matches.flush();
        let measured = env::storage_usage().saturating_sub(before);
        let required = storage_cost(measured + STORAGE_RESERVE_BYTES);
        if deposit.as_yoctonear() < required {
            // The receipt reverts anyway; removing keeps unit-test state consistent too.
            self.matches.remove(&id_for_error);
            self.matches.flush();
            panic_msg(format!(
                "attach at least {required} yoctoNEAR for storage ({measured} bytes measured + {STORAGE_RESERVE_BYTES} reserved)"
            ));
        }
        emit("create_match", data);
    }

    /// Backs a free seat with exactly the stake. Backing the last seat starts the game.
    #[payable]
    pub fn join(&mut self, id: String, seat: u8) {
        let mut m = self.load(&id);
        require!(m.status == Status::Lobby, "the match is not in the lobby");
        let s = m.seat_index(seat);
        require!(m.seats[s].backer.is_none(), "seat already backed");
        let caller = env::predecessor_account_id();
        if let Some(solo) = &m.solo_player {
            require!(&caller == solo || caller == self.house, "solo match: only the solo player or the house may back seats");
        }
        if env::attached_deposit() != m.stake {
            panic_msg(format!("attach exactly the stake: {} yoctoNEAR", m.stake.as_yoctonear()));
        }
        let now = env::block_timestamp();
        m.seats[s].backer = Some(caller.clone());
        m.last_activity = now;
        emit("join", json!({ "id": id, "seat": s, "backer": caller }));

        if m.seats.iter().all(|seat| seat.backer.is_some()) {
            let mut steps = Vec::new();
            let mut rng = ChainRng::new(env::random_seed_array(), &id, &mut m.draws, near_sha256);
            if let Err(error) = apply_logged(&mut m.game, None, Action::Start, &mut rng, &mut steps) {
                panic_msg(format!("cannot start: {error}"));
            }
            m.status = Status::Playing;
            m.turn_deadline = now + u64::from(m.turn_seconds) * 1_000_000_000;
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
        self.matches.insert(id, m);
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

    /// Applies `actions` in order as `seat` (backer or driver only). Any engine error rejects the whole call.
    /// `Sell`/`Mortgage`/`Redeem` work out of turn exactly as the engine allows. `Start` and `Auto` are not accepted
    /// (`Auto` is what `timeout` does).
    pub fn play(&mut self, id: String, seat: u8, actions: Vec<Action>) {
        require!(!actions.is_empty() && actions.len() <= MAX_ACTIONS_PER_CALL, "send 1..=32 actions");
        let mut m = self.load_playing(&id);
        let s = m.seat_index(seat);
        let caller = m.authorize(s);
        let before = current_seat(&m.game);
        let mut steps = Vec::new();
        {
            let mut rng = ChainRng::new(env::random_seed_array(), &id, &mut m.draws, near_sha256);
            for (i, &action) in actions.iter().enumerate() {
                if matches!(action, Action::Start | Action::Auto) {
                    panic_msg(format!("action {i} ({}) is not playable; use timeout() after the deadline", action.op()));
                }
                if let Err(error) = apply_logged(&mut m.game, Some(SEAT_IDS[s]), action, &mut rng, &mut steps) {
                    panic_msg(format!("action {i} ({}) rejected: {error}", action.op()));
                }
            }
        }
        // Out-of-turn sales by a waiting seat do not extend the current player's deadline.
        let reset = before == Some(s) || current_seat(&m.game) != before;
        self.after_moves(id, m, "play", s, caller, steps, reset);
    }

    /// One transaction per agent turn: rolls, applies `plan` deterministically, rolls again after doubles and ends the
    /// turn (see [`autoplay::play_turn`]). `seat` must be the current player.
    pub fn turn(&mut self, id: String, seat: u8, plan: Plan) {
        require!(plan.build.len() <= MAX_PLAN_LIST && plan.liquidate.len() <= MAX_PLAN_LIST, "plan lists hold at most 40 squares");
        let mut m = self.load_playing(&id);
        let s = m.seat_index(seat);
        let caller = m.authorize(s);
        require!(current_seat(&m.game) == Some(s), "it is not this seat's turn");
        let mut steps = Vec::new();
        {
            let mut rng = ChainRng::new(env::random_seed_array(), &id, &mut m.draws, near_sha256);
            if let Err(error) = play_turn(&mut m.game, SEAT_IDS[s], &plan, &mut rng, &mut steps) {
                panic_msg(format!("turn failed: {error}"));
            }
        }
        self.after_moves(id, m, "turn", s, caller, steps, true);
    }

    /// Anyone, once the turn deadline has passed: one engine `Auto` step for the current player (roll, skip buying, or
    /// end the turn), or, in debt, the deterministic liquidation (sell houses, mortgage, pay, else bankrupt).
    ///
    /// While the timed-out player still holds the turn the deadline stays expired, so the next step can be forced at
    /// once; when the turn passes, the next player gets a fresh deadline.
    pub fn timeout(&mut self, id: String) {
        let mut m = self.load_playing(&id);
        if env::block_timestamp() <= m.turn_deadline {
            panic_msg(format!("the turn deadline ({}) has not passed", m.turn_deadline));
        }
        let before = current_seat(&m.game);
        let s = before.unwrap_or_else(|| env::panic_str("no current player"));
        let mut steps = Vec::new();
        {
            let mut rng = ChainRng::new(env::random_seed_array(), &id, &mut m.draws, near_sha256);
            if let Err(error) = timeout_step(&mut m.game, &mut rng, &mut steps) {
                panic_msg(format!("timeout failed: {error}"));
            }
        }
        let reset = current_seat(&m.game) != before;
        self.after_moves(id, m, "timeout", s, env::predecessor_account_id(), steps, reset);
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

    // ----- Views ---------------------------------------------------------------------------------------------------

    /// `{ meta, game, log }`: seats, backers, drivers, stake, split, status, deadline and rules; the engine snapshot
    /// (ENGINE-RULES §8, same field names as the TS `Game`); the last 30 structured engine events. `null` when the
    /// match does not exist or is finished (see `get_result`).
    pub fn get_match(&self, id: String) -> Option<Value> {
        self.matches.get(&id).map(|m| json!({ "meta": m.meta_json(&id, &self.house), "game": m.game.snapshot(), "log": m.game.log }))
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
                let mut meta = m.meta_json(id, &self.house);
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
            json!({
                "id": id,
                "stake": yocto_json(r.stake),
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

    pub fn get_config(&self) -> Value {
        json!({
            "owner": self.owner,
            "house": self.house,
            "matches": self.matches.len(),
            "storage_reserve_bytes": STORAGE_RESERVE_BYTES,
            "default_turn_seconds": DEFAULT_TURN_SECONDS,
            "abandon_after_ns": u64_json(ABANDON_AFTER_NS),
        })
    }
}

// ----- Internals -------------------------------------------------------------------------------------------------------

impl Contract {
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

    /// Common tail of `play`, `turn` and `timeout`: bookkeeping, the event, then settlement or saving.
    #[allow(clippy::too_many_arguments)]
    fn after_moves(&mut self, id: String, mut m: Match, kind: &str, s: usize, by: AccountId, steps: Vec<Step>, reset_deadline: bool) {
        let now = env::block_timestamp();
        m.last_activity = now;
        if reset_deadline {
            m.turn_deadline = now + u64::from(m.turn_seconds) * 1_000_000_000;
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

    /// Pays out an ended match exactly once. The match is removed from `matches` in the same call and a summary is
    /// written to `results`; both `load` paths refuse an id found in `results`, so nothing can reach this twice.
    fn settle(&mut self, id: String, mut m: Match) {
        require!(!self.results.contains_key(&id), "the match was already settled");
        let result = m.game.result.clone().unwrap_or_else(|| env::panic_str("an ended game has a result"));
        m.status = Status::Ended;

        let ranking: Vec<usize> = result.ranking.iter().map(|p| seat_of(p)).collect();
        require!(ranking.len() == m.seats.len(), "the ranking covers every seat");
        let pot = m.stake.as_yoctonear() * m.seats.len() as u128;
        let shares = split_pot(pot, &m.split, ranking.len());
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
