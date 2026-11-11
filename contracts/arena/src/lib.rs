//! Deedlords Arena NEAR contract: the referee around the pure rules engine (`arena-engine`).
//!
//! * A match is a duel. The creator backs seat 0 with the stake, a second account backs seat 1 with the same stake,
//!   and the first market is drawn in that call. A backer may name a driver (an agent account) that may also play
//!   the seat.
//! * A round is played with sealed plans. Each seat first sends `commit` with `sha256(plan ‖ "|" ‖ salt)`; when both
//!   have, each sends `reveal` with the plan and the salt. The second reveal resolves the round in the same call:
//!   the bids are opened together, the two floors fight, and the next market is drawn.
//! * Each phase has a deadline. After it anyone may call `timeout`: a seat that did not commit, or did not reveal,
//!   plays the empty plan (no bids, its floor as it was), so nobody can stall a match.
//! * When the engine reports the end the contract settles once: the fee comes off the pot (`fee_bps`, fixed at
//!   deployment, at most 5%), the winner is paid 70% of the rest and the other seat 30%, a summary is kept and the
//!   match is deleted. The owner can withdraw exactly the fees collected and nothing else.
//!
//! Every successful state change logs `EVENT_JSON:{"standard":"deedlords-arena","version":"1.0.0","event":..,"data":..}`.

mod rng;
#[cfg(test)]
mod tests;

use arena_engine::{check_plan, create_match as new_game, draw_market, resolve_round, standings, Match as Game, Plan};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise};

use rng::ChainRng;

pub const MIN_ROUNDS: u8 = 3;
pub const MAX_ROUNDS: u8 = 7;
pub const DEFAULT_TURN_SECONDS: u32 = 60;
pub const MAX_TURN_SECONDS: u32 = 86_400;
/// A match still in the lobby this long after creation may be abandoned by anyone.
pub const ABANDON_AFTER_NS: u64 = 15 * 60 * 1_000_000_000;
/// Upper bound of a deployment's stake cap (1,000,000 NEAR), so `pot * basis points` always fits in a u128.
pub const MAX_STAKE: u128 = 1_000_000 * 10u128.pow(24);
/// The most a deployment may take from a pot: 500 basis points, 5%.
pub const MAX_FEE_BPS: u16 = 500;
/// Basis points of the pot after the fee, for the winner; the other seat gets the rest.
pub const WINNER_BPS: u128 = 7_000;
pub const MAX_ID_LEN: usize = 32;
pub const MAX_PLAN_BYTES: usize = 1_024;
/// Gas that `join`, `reveal` and `timeout` require: these calls may draw a market, and a call that ran out of gas
/// after the draw would revert it, so a caller could keep only the markets it likes.
pub const MIN_MOVE_GAS: Gas = Gas::from_tgas(60);

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Lobby,
    Playing,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Seat {
    pub backer: AccountId,
    pub driver: Option<AccountId>,
    /// This round's sealed plan, until it is revealed.
    pub commit: Option<[u8; 32]>,
    /// This round's plan once revealed (or the empty plan after a timeout).
    pub plan: Option<Plan>,
}

/// Full state of an unfinished match. Deleted when the match is settled or abandoned.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Match {
    pub stake: NearToken,
    pub rounds: u8,
    pub seats: Vec<Seat>,
    pub status: Status,
    pub created_at: u64,
    pub turn_seconds: u32,
    /// Nanoseconds; 0 in the lobby.
    pub deadline: u64,
    /// Rng hashes drawn so far (see [`rng`]).
    pub draws: u64,
    pub game: Option<Game>,
}

/// Permanent summary of a settled match.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct MatchResult {
    pub stake: NearToken,
    /// Seat indexes, best first.
    pub ranking: Vec<u8>,
    /// Backer and amount paid per rank, best first.
    pub backers: Vec<AccountId>,
    pub payouts: Vec<NearToken>,
    pub fee: NearToken,
    /// Points and gold per seat when the match ended.
    pub points: Vec<i32>,
    pub gold: Vec<i32>,
    pub rounds_played: u8,
    pub block_height: u64,
    pub ended_at: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    /// Unfinished matches (lobby or playing).
    matches: IterableMap<String, Match>,
    results: LookupMap<String, MatchResult>,
    /// Largest stake per seat a match may ask for. Set in `new`; no method changes it.
    max_stake: NearToken,
    /// Basis points of every pot kept as the fee when a match is settled. Set in `new`; no method changes it.
    fee_bps: u16,
    /// Fees collected and not yet withdrawn. Only `withdraw_fees` moves them, and only this much.
    fees: NearToken,
}

fn emit(event: &str, data: Value) {
    let body = json!({ "standard": "deedlords-arena", "version": "1.0.0", "event": event, "data": data });
    env::log_str(&format!("EVENT_JSON:{body}"));
}

fn require_move_gas() {
    require!(env::prepaid_gas() >= MIN_MOVE_GAS, "attach at least 60 Tgas: a call that may draw a market must not be able to run out of gas");
}

fn from_hex(text: &str) -> Option<[u8; 32]> {
    if text.len() != 64 || !text.is_ascii() {
        return None;
    }
    let mut out = [0u8; 32];
    for (index, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// The fee on a pot: `pot * fee_bps / 10000`, rounded down.
pub fn fee_of(pot: u128, fee_bps: u16) -> u128 {
    pot * u128::from(fee_bps) / 10_000
}

/// The hash a seat commits to: `sha256(plan ‖ "|" ‖ salt)` over the exact text of the plan it will reveal.
pub fn seal(plan: &str, salt: &str) -> [u8; 32] {
    env::sha256_array(format!("{plan}|{salt}").as_bytes())
}

impl Match {
    /// Reveals are open once every seat has committed (or was given the empty plan).
    fn revealing(&self) -> bool {
        self.seats.iter().all(|seat| seat.commit.is_some() || seat.plan.is_some())
    }

    fn view(&self, id: &str) -> Value {
        json!({
            "id": id,
            "status": self.status,
            "stake": U128(self.stake.as_yoctonear()),
            "rounds": self.rounds,
            "turnSeconds": self.turn_seconds,
            "deadline": U64(self.deadline),
            "createdAt": U64(self.created_at),
            "phase": if self.status == Status::Lobby { "lobby" } else if self.revealing() { "reveal" } else { "commit" },
            "seats": self.seats.iter().map(|seat| json!({
                "backer": seat.backer,
                "driver": seat.driver,
                "committed": seat.commit.is_some() || seat.plan.is_some(),
                "revealed": seat.plan.is_some(),
            })).collect::<Vec<_>>(),
            "game": self.game,
        })
    }
}

#[near]
impl Contract {
    #[init]
    #[private]
    pub fn new(owner: AccountId, max_stake: U128, fee_bps: u16) -> Self {
        require!(max_stake.0 <= MAX_STAKE, "max_stake is above 1,000,000 NEAR");
        require!(fee_bps <= MAX_FEE_BPS, "fee_bps must be at most 500 (5%)");
        Contract {
            owner,
            matches: IterableMap::new(b"m"),
            results: LookupMap::new(b"r"),
            max_stake: NearToken::from_yoctonear(max_stake.0),
            fee_bps,
            fees: NearToken::from_yoctonear(0),
        }
    }

    /// Opens a match and takes seat 0. The attached deposit is the stake.
    #[payable]
    pub fn create_match(&mut self, id: String, rounds: u8, stake: U128, turn_seconds: Option<u32>) {
        require!(!id.is_empty() && id.len() <= MAX_ID_LEN, "match id must be 1..=32 characters");
        require!(id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'), "match id may only contain ASCII letters, digits, '-' and '_'");
        require!(!self.matches.contains_key(&id) && !self.results.contains_key(&id), "this match id was already used");
        require!((MIN_ROUNDS..=MAX_ROUNDS).contains(&rounds), "rounds must be 3..=7");
        let turn_seconds = turn_seconds.unwrap_or(DEFAULT_TURN_SECONDS);
        require!((5..=MAX_TURN_SECONDS).contains(&turn_seconds), "turn_seconds must be 5..=86400");
        let stake = NearToken::from_yoctonear(stake.0);
        require!(stake <= self.max_stake, "the stake is above this deployment's cap");
        require!(env::attached_deposit() == stake, "attach exactly the stake");
        let creator = env::predecessor_account_id();
        let m = Match {
            stake,
            rounds,
            seats: vec![Seat { backer: creator.clone(), driver: None, commit: None, plan: None }],
            status: Status::Lobby,
            created_at: env::block_timestamp(),
            turn_seconds,
            deadline: 0,
            draws: 0,
            game: None,
        };
        emit("match_created", json!({ "id": id, "creator": creator, "stake": U128(stake.as_yoctonear()), "rounds": rounds }));
        self.matches.insert(id, m);
    }

    /// Takes seat 1 with the same stake; the first market is drawn and the match starts.
    #[payable]
    pub fn join(&mut self, id: String) {
        require_move_gas();
        let mut m = self.matches.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such match"));
        require!(m.status == Status::Lobby, "the match has started");
        require!(env::attached_deposit() == m.stake, "attach exactly the stake");
        let now = env::block_timestamp();
        m.seats.push(Seat { backer: env::predecessor_account_id(), driver: None, commit: None, plan: None });
        let market = draw_market(1, &mut |n| ChainRng::new(env::random_seed_array(), &id, &mut m.draws).below(n));
        m.game = Some(new_game(m.rounds, market));
        m.status = Status::Playing;
        m.deadline = now + u64::from(m.turn_seconds) * 1_000_000_000;
        emit("match_started", json!({ "id": id, "seats": m.seats.iter().map(|seat| &seat.backer).collect::<Vec<_>>(), "market": m.game.as_ref().unwrap().market }));
        self.matches.insert(id, m);
    }

    /// The creator closes a match nobody joined and takes the stake back.
    pub fn leave(&mut self, id: String) {
        let m = self.matches.get(&id).unwrap_or_else(|| env::panic_str("no such match"));
        require!(m.status == Status::Lobby, "the match has started");
        require!(env::predecessor_account_id() == m.seats[0].backer, "only the creator may close the match");
        let (creator, stake) = (m.seats[0].backer.clone(), m.stake);
        self.matches.remove(&id);
        Promise::new(creator).transfer(stake).detach();
        emit("match_abandoned", json!({ "id": id }));
    }

    /// Anyone may close a match that sat in the lobby for 15 minutes; the stake goes back to the creator.
    pub fn abandon(&mut self, id: String) {
        let m = self.matches.get(&id).unwrap_or_else(|| env::panic_str("no such match"));
        require!(m.status == Status::Lobby, "the match has started");
        require!(env::block_timestamp() >= m.created_at + ABANDON_AFTER_NS, "the match is not old enough to abandon");
        let (creator, stake) = (m.seats[0].backer.clone(), m.stake);
        self.matches.remove(&id);
        Promise::new(creator).transfer(stake).detach();
        emit("match_abandoned", json!({ "id": id }));
    }

    /// The backer of a seat names (or removes) an account that may also play it.
    pub fn set_driver(&mut self, id: String, seat: u8, driver: Option<AccountId>) {
        let mut m = self.matches.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such match"));
        let s = m.seats.get_mut(usize::from(seat)).unwrap_or_else(|| env::panic_str("no such seat"));
        require!(env::predecessor_account_id() == s.backer, "only the backer of the seat may set its driver");
        s.driver = driver.clone();
        emit("driver_set", json!({ "id": id, "seat": seat, "driver": driver }));
        self.matches.insert(id, m);
    }

    /// Seals this round's plan: `hash` is the hex of `sha256(plan ‖ "|" ‖ salt)`. May be replaced until both seats committed.
    pub fn commit(&mut self, id: String, seat: u8, hash: String) {
        let mut m = self.playing(&id, seat);
        require!(!m.revealing(), "both seats have committed: reveal now");
        let hash = from_hex(&hash).unwrap_or_else(|| env::panic_str("hash must be 64 hex characters"));
        m.seats[usize::from(seat)].commit = Some(hash);
        if m.revealing() {
            m.deadline = env::block_timestamp() + u64::from(m.turn_seconds) * 1_000_000_000;
        }
        emit("committed", json!({ "id": id, "seat": seat, "round": m.game.as_ref().unwrap().round }));
        self.matches.insert(id, m);
    }

    /// Opens the sealed plan. `plan` is the exact JSON text that was hashed. The second reveal plays the round.
    pub fn reveal(&mut self, id: String, seat: u8, plan: String, salt: String) {
        require_move_gas();
        let mut m = self.playing(&id, seat);
        require!(m.revealing(), "wait until both seats have committed");
        require!(plan.len() <= MAX_PLAN_BYTES && salt.len() <= 64, "plan or salt too long");
        let s = &m.seats[usize::from(seat)];
        require!(s.plan.is_none(), "this seat has already revealed");
        require!(s.commit == Some(seal(&plan, &salt)), "the plan and salt do not match the commitment");
        let parsed: Plan = serde_json::from_str(&plan).unwrap_or_else(|e| env::panic_str(&format!("the plan is not valid: {e}")));
        if let Err(problem) = check_plan(m.game.as_ref().unwrap(), usize::from(seat), &parsed) {
            env::panic_str(&format!("the plan cannot be played: {problem}"));
        }
        m.seats[usize::from(seat)].plan = Some(parsed);
        emit("revealed", json!({ "id": id, "seat": seat, "round": m.game.as_ref().unwrap().round }));
        self.advance(id, m);
    }

    /// After the deadline: a seat that did not commit, or did not reveal, plays the empty plan.
    pub fn timeout(&mut self, id: String) {
        require_move_gas();
        let mut m = self.matches.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such match"));
        require!(m.status == Status::Playing, "the match has not started");
        require!(env::block_timestamp() > m.deadline, "the deadline has not passed");
        let revealing = m.revealing();
        let mut late = vec![];
        for (index, seat) in m.seats.iter_mut().enumerate() {
            // Before the reveals open, only a seat that did not commit is late; a seat that did still gets to reveal.
            if seat.plan.is_none() && (revealing || seat.commit.is_none()) {
                seat.plan = Some(Plan::empty());
                late.push(index);
            }
        }
        m.deadline = env::block_timestamp() + u64::from(m.turn_seconds) * 1_000_000_000;
        emit("timeout", json!({ "id": id, "round": m.game.as_ref().unwrap().round, "late": late }));
        self.advance(id, m);
    }

    /// The owner takes the fees collected so far.
    pub fn withdraw_fees(&mut self) -> U128 {
        require!(env::predecessor_account_id() == self.owner, "only the owner may withdraw the fees");
        let amount = self.fees;
        require!(amount.as_yoctonear() > 0, "no fees to withdraw");
        self.fees = NearToken::from_yoctonear(0);
        Promise::new(self.owner.clone()).transfer(amount).detach();
        emit("fees_withdrawn", json!({ "amount": U128(amount.as_yoctonear()) }));
        U128(amount.as_yoctonear())
    }

    pub fn get_match(&self, id: String) -> Option<Value> {
        self.matches.get(&id).map(|m| m.view(&id))
    }

    pub fn list_matches(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Value> {
        self.matches.iter().skip(from_index.unwrap_or(0) as usize).take(limit.unwrap_or(50).min(100) as usize).map(|(id, m)| m.view(id)).collect()
    }

    pub fn get_result(&self, id: String) -> Option<Value> {
        self.results.get(&id).map(|r| {
            json!({
                "id": id,
                "stake": U128(r.stake.as_yoctonear()),
                "ranking": r.ranking,
                "backers": r.backers,
                "payouts": r.payouts.iter().map(|p| U128(p.as_yoctonear())).collect::<Vec<_>>(),
                "fee": U128(r.fee.as_yoctonear()),
                "points": r.points,
                "gold": r.gold,
                "roundsPlayed": r.rounds_played,
                "blockHeight": r.block_height,
                "endedAt": U64(r.ended_at),
            })
        })
    }

    pub fn get_config(&self) -> Value {
        json!({ "owner": self.owner, "maxStake": U128(self.max_stake.as_yoctonear()), "feeBps": self.fee_bps, "fees": U128(self.fees.as_yoctonear()), "winnerBps": WINNER_BPS as u32 })
    }
}

impl Contract {
    /// The match, checked to be under way and `seat` to be played by the caller (its backer or its driver).
    fn playing(&self, id: &str, seat: u8) -> Match {
        let m = self.matches.get(id).cloned().unwrap_or_else(|| env::panic_str("no such match"));
        require!(m.status == Status::Playing, "the match has not started");
        let s = m.seats.get(usize::from(seat)).unwrap_or_else(|| env::panic_str("no such seat"));
        let caller = env::predecessor_account_id();
        require!(caller == s.backer || s.driver.as_ref() == Some(&caller), "only the backer or the driver of the seat may play it");
        m
    }

    /// Plays the round once both plans are in, then settles the match if it ended. Stores the match otherwise.
    fn advance(&mut self, id: String, mut m: Match) {
        if m.seats.iter().any(|seat| seat.plan.is_none()) {
            self.matches.insert(id, m);
            return;
        }
        let game = m.game.take().unwrap();
        let plans = [m.seats[0].plan.take().unwrap(), m.seats[1].plan.take().unwrap()];
        let next_market = draw_market(game.round + 1, &mut |n| ChainRng::new(env::random_seed_array(), &id, &mut m.draws).below(n));
        // A revealed plan was checked against this same state, so the engine cannot refuse it here.
        let game = resolve_round(&game, &plans, next_market).unwrap_or_else(|e| env::panic_str(&e));
        for seat in m.seats.iter_mut() {
            seat.commit = None;
        }
        emit("round", json!({ "id": id, "plans": plans, "result": game.last, "next": { "round": game.round, "market": game.market, "done": game.done } }));
        if game.done {
            self.settle(id, m, game);
            return;
        }
        m.deadline = env::block_timestamp() + u64::from(m.turn_seconds) * 1_000_000_000;
        m.game = Some(game);
        self.matches.insert(id, m);
    }

    fn settle(&mut self, id: String, m: Match, game: Game) {
        let pot = m.stake.as_yoctonear() * 2;
        let fee = fee_of(pot, self.fee_bps);
        let first = (pot - fee) * WINNER_BPS / 10_000;
        let payouts = [first, pot - fee - first];
        let order = standings(&game);
        self.fees = NearToken::from_yoctonear(self.fees.as_yoctonear() + fee);
        for (rank, &seat) in order.iter().enumerate() {
            if payouts[rank] > 0 {
                Promise::new(m.seats[seat].backer.clone()).transfer(NearToken::from_yoctonear(payouts[rank])).detach();
            }
        }
        let result = MatchResult {
            stake: m.stake,
            ranking: order.iter().map(|&seat| seat as u8).collect(),
            backers: order.iter().map(|&seat| m.seats[seat].backer.clone()).collect(),
            payouts: payouts.iter().map(|&p| NearToken::from_yoctonear(p)).collect(),
            fee: NearToken::from_yoctonear(fee),
            points: game.seats.iter().map(|seat| seat.points).collect(),
            gold: game.seats.iter().map(|seat| seat.gold).collect(),
            rounds_played: game.round - 1,
            block_height: env::block_height(),
            ended_at: env::block_timestamp(),
        };
        emit("match_ended", json!({ "id": id, "ranking": result.ranking, "backers": result.backers, "payouts": [U128(payouts[0]), U128(payouts[1])], "fee": U128(fee), "points": result.points }));
        self.results.insert(id.clone(), result);
        self.matches.remove(&id);
    }
}
