//! Unit tests: contract methods under `testing_env!` (seeds and timestamps varied per call), the autoplay driver on
//! plain engine games, settlement math and the Rng.

use std::collections::BTreeMap;
use std::panic::{catch_unwind, AssertUnwindSafe};

use deedlords_engine::board::OWNABLE;
use deedlords_engine::{Action, Game, Owned, Payee, Phase, Rng, Rules, Stage};
use near_contract_standards::non_fungible_token::core::NonFungibleTokenCore;
use near_contract_standards::non_fungible_token::{NonFungibleToken, NonFungibleTokenEnumeration};
use near_sdk::json_types::U128;
use near_sdk::mock::MockAction;
use near_sdk::serde_json::Value;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{env, testing_env, AccountId, Gas, NearToken};

use crate::autoplay::{apply_logged, liquidation_step, play_turn, resolve_debt, timeout_step, Plan, Step};
use crate::rng::{below_from_u32, below_limit, die_from_byte, near_sha256, ChainRng};
use crate::{
    current_seat, fee_key, fee_of, split_pot, Contract, ContractV1, Match, RulesArg, Status, ABANDON_AFTER_NS, DEFAULT_TURN_SECONDS, MAX_FEE_BPS,
    MAX_STAKE, MIN_MOVE_GAS, STORAGE_RESERVE_BYTES,
};

// ----- Environment helpers -------------------------------------------------------------------------------------------

const CONTRACT: &str = "deedlords.near";
const OWNER: &str = "owner.near";
const HOUSE: &str = "house.near";
const ALICE: &str = "alice.near";
const BOB: &str = "bob.near";
const CAROL: &str = "carol.near";
const NOW0: u64 = 1_700_000_000_000_000_000;
const SEC: u64 = 1_000_000_000;
const NEAR: u128 = 10u128.pow(24);
const STAKE: u128 = NEAR;
const STORAGE: u128 = NEAR / 10;
/// Stake cap of the test deployment.
const CAP: u128 = 100 * NEAR;
/// Fee of the test deployment: 2.5% of every pot.
const FEE_BPS: u16 = 250;
/// The longest match the contract accepts, for tests where the round limit plays no part.
const MANY_ROUNDS: u8 = 255;

fn acc(id: &str) -> AccountId {
    id.parse().unwrap()
}

fn seed(n: u64) -> [u8; 32] {
    let mut s = [0u8; 32];
    s[..8].copy_from_slice(&n.to_le_bytes());
    s[8] = 0xd1;
    s
}

fn context(predecessor: &str, deposit: u128, now: u64, random: [u8; 32]) {
    context_with_gas(predecessor, deposit, now, random, 300);
}

fn context_with_gas(predecessor: &str, deposit: u128, now: u64, random: [u8; 32], tgas: u64) {
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(acc(CONTRACT))
        .predecessor_account_id(acc(predecessor))
        .signer_account_id(acc(predecessor))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(now)
        .random_seed(random)
        .account_balance(NearToken::from_near(10_000))
        .prepaid_gas(Gas::from_tgas(tgas));
    testing_env!(builder.build());
}

/// A contract plus a clock and a per-call seed counter (every call sees a new block seed).
struct T {
    c: Contract,
    now: u64,
    calls: u64,
    base: u64,
}

impl T {
    fn new() -> Self {
        Self::with_seed(0)
    }

    fn with_seed(base: u64) -> Self {
        Self::with_fee(base, FEE_BPS)
    }

    fn with_fee(base: u64, fee_bps: u16) -> Self {
        context(CONTRACT, 0, NOW0, seed(base));
        T { c: Contract::new(acc(OWNER), acc(HOUSE), U128(CAP), fee_bps), now: NOW0, calls: 0, base }
    }

    fn call(&mut self, who: &str, deposit: u128) {
        self.call_with_gas(who, deposit, 300);
    }

    fn call_with_gas(&mut self, who: &str, deposit: u128, tgas: u64) {
        self.calls += 1;
        context_with_gas(who, deposit, self.now, seed(self.base.wrapping_mul(1_000_003).wrapping_add(self.calls)), tgas);
    }

    fn create(&mut self, id: &str, seats: u8, split: Vec<u16>, rules: RulesArg, solo: Option<&str>) {
        self.call(ALICE, STORAGE);
        self.c.create_match(id.into(), seats, U128(STAKE), split, rules, solo.map(acc), None, None);
    }

    fn join(&mut self, id: &str, who: &str, seat: u8) {
        self.call(who, STAKE);
        self.c.join(id.into(), seat);
    }

    fn m(&self, id: &str) -> &Match {
        self.c.matches.get(id).expect("match exists")
    }

    fn with_match(&mut self, id: &str, f: impl FnOnce(&mut Match)) {
        f(self.c.matches.get_mut(id).expect("match exists"));
    }

    fn current(&self, id: &str) -> (usize, String) {
        let m = self.m(id);
        let s = current_seat(&m.game).expect("a current player");
        (s, m.seats[s].backer.clone().unwrap().to_string())
    }

    /// Calls `timeout` (as carol) after each deadline until the match is settled.
    fn play_out_with_timeouts(&mut self, id: &str) -> usize {
        for steps in 0..5_000 {
            let Some(m) = self.c.matches.get(id) else { return steps };
            self.now = self.now.max(m.turn_deadline + 1);
            self.call(CAROL, 0);
            self.c.timeout(id.into());
        }
        panic!("the match did not end");
    }
}

fn classic(max_rounds: u8) -> RulesArg {
    RulesArg { salary: 200, cash: 1500, blitz: false, max_rounds }
}

fn blitz(max_rounds: u8) -> RulesArg {
    RulesArg { salary: 200, cash: 2000, blitz: true, max_rounds }
}

fn expect_panic<R, F: FnOnce() -> R>(f: F, needle: &str) {
    let error = catch_unwind(AssertUnwindSafe(f)).err().expect("expected the call to panic");
    let message =
        error.downcast_ref::<String>().cloned().or_else(|| error.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
    assert!(message.contains(needle), "panic message {message:?} does not contain {needle:?}");
}

fn events() -> Vec<Value> {
    get_logs()
        .iter()
        .filter_map(|log| log.strip_prefix("EVENT_JSON:"))
        .map(|json| near_sdk::serde_json::from_str::<Value>(json).unwrap())
        .filter(|event| event["standard"] == "deedlords")
        .collect()
}

fn event(name: &str) -> Value {
    events().into_iter().find(|e| e["event"] == name).unwrap_or_else(|| panic!("no {name} event in {:?}", get_logs()))
}

/// Bytes the mocked trie would charge for (`key + value + 40` per record, as on chain). `env::storage_usage()` restarts
/// from the context's value at every `testing_env!`, so it only measures within one call.
fn stored_bytes() -> u64 {
    let storage = near_sdk::mock::with_mocked_blockchain(|b| b.take_storage());
    let bytes = storage.iter().map(|(k, v)| (k.len() + v.len() + 40) as u64).sum();
    near_sdk::env::set_blockchain_interface(near_sdk::MockedBlockchain::new(
        VMContextBuilder::new().build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        vec![],
        storage,
        Default::default(),
        None,
    ));
    bytes
}

/// NEAR transferred by the receipts of the last call, by receiver.
fn transfers() -> BTreeMap<String, u128> {
    let mut out = BTreeMap::new();
    for receipt in get_created_receipts() {
        for action in &receipt.actions {
            if let MockAction::Transfer { deposit, .. } = action {
                *out.entry(receipt.receiver_id.to_string()).or_default() += deposit.as_yoctonear();
            }
        }
    }
    out
}

/// A started 2-seat classic match "m" backed by alice (seat 0) and bob (seat 1).
fn started_pair(t: &mut T, max_rounds: u8) {
    t.create("m", 2, vec![7000, 3000], classic(max_rounds), None);
    t.join("m", ALICE, 0);
    t.join("m", BOB, 1);
}

// ----- Lobby -----------------------------------------------------------------------------------------------------------

#[test]
fn create_join_and_auto_start() {
    let mut t = T::new();
    t.create("m1", 2, vec![7000, 3000], classic(2), None);
    let view = t.c.get_match("m1".into()).unwrap();
    assert_eq!(view["meta"]["status"], "lobby");
    assert_eq!(view["game"]["phase"], "lobby");
    assert_eq!(view["meta"]["rules"]["maxRounds"], 2);
    assert_eq!(event("create_match")["data"]["id"], "m1");

    t.join("m1", ALICE, 0);
    assert_eq!(t.m("m1").status, Status::Lobby);
    assert_eq!(event("join")["data"]["seat"], 0);

    t.call(BOB, STAKE - 1);
    expect_panic(|| t.c.join("m1".into(), 1), "attach exactly the stake");
    t.call(BOB, STAKE);
    expect_panic(|| t.c.join("m1".into(), 0), "seat already backed");
    t.call(BOB, STAKE);
    expect_panic(|| t.c.join("m1".into(), 2), "no such seat");

    t.join("m1", BOB, 1);
    let m = t.m("m1");
    assert_eq!(m.status, Status::Playing);
    assert_eq!(m.game.phase, Phase::Playing);
    assert_eq!(m.turn_deadline, t.now + u64::from(DEFAULT_TURN_SECONDS) * SEC);
    assert_eq!(m.draws, 1, "the turn-order shuffle of 2 players is one below(2), one hash");
    let start = event("start");
    assert_eq!(start["data"]["order"].as_array().unwrap().len(), 2);
    assert_eq!(start["data"]["steps"][0]["action"], "Start");
    assert_eq!(t.c.list_matches(None, None).len(), 1);

    t.call(CAROL, STAKE);
    expect_panic(|| t.c.join("m1".into(), 0), "not in the lobby");
}

#[test]
fn create_match_validates_its_arguments() {
    let mut t = T::new();
    t.create("dup", 2, vec![10000], classic(MANY_ROUNDS), None);
    type Case = (&'static str, u8, Vec<u16>, RulesArg, u128, &'static str);
    let cases: Vec<Case> = vec![
        ("dup", 2, vec![10000], classic(MANY_ROUNDS), STORAGE, "already used"),
        ("bad id!", 2, vec![10000], classic(MANY_ROUNDS), STORAGE, "may only contain"),
        ("", 2, vec![10000], classic(MANY_ROUNDS), STORAGE, "1..=32"),
        ("x", 1, vec![10000], classic(MANY_ROUNDS), STORAGE, "seats must be 2..=4"),
        ("x", 5, vec![10000], classic(MANY_ROUNDS), STORAGE, "seats must be 2..=4"),
        ("x", 2, vec![5000, 4000], classic(MANY_ROUNDS), STORAGE, "sum to 10000"),
        ("x", 2, vec![5000, 3000, 2000], classic(MANY_ROUNDS), STORAGE, "1..=seats"),
        ("x", 4, vec![10000], RulesArg { cash: 1669, ..blitz(3) }, STORAGE, "cash >= 1670"),
        ("x", 2, vec![10000], RulesArg { cash: 0, ..classic(MANY_ROUNDS) }, STORAGE, "rules.cash"),
        ("x", 2, vec![10000], RulesArg { salary: -1, ..classic(MANY_ROUNDS) }, STORAGE, "rules.salary"),
        ("x", 2, vec![10000], classic(0), STORAGE, "rules.max_rounds must be 1..=255"),
        ("x", 2, vec![10000], classic(MANY_ROUNDS), 1, "attach at least"),
    ];
    for (id, seats, split, rules, deposit, needle) in cases {
        t.call(ALICE, deposit);
        expect_panic(|| t.c.create_match(id.into(), seats, U128(STAKE), split, rules, None, None, None), needle);
    }
    t.call(ALICE, STORAGE);
    expect_panic(|| t.c.create_match("x".into(), 2, U128(STAKE), vec![10000], classic(MANY_ROUNDS), None, Some(0), None), "turn_seconds");
    // The stake cap of the deployment, and the house as the solo player.
    t.call(ALICE, STORAGE);
    expect_panic(
        || t.c.create_match("x".into(), 2, U128(CAP + 1), vec![10000], classic(MANY_ROUNDS), None, None, None),
        &format!("stake too large: this contract allows at most {CAP} yoctoNEAR"),
    );
    t.call(ALICE, STORAGE);
    expect_panic(
        || t.c.create_match("x".into(), 2, U128(STAKE), vec![10000], classic(MANY_ROUNDS), Some(acc(HOUSE)), None, None),
        "the house cannot be the solo player",
    );
    assert!(t.c.matches.get("x").is_none(), "a rejected create leaves nothing behind");
    t.call(ALICE, STORAGE);
    t.c.create_match("cap".into(), 2, U128(CAP), vec![10000], classic(1), None, None, None);
    assert_eq!(t.m("cap").stake.as_yoctonear(), CAP, "a stake of exactly the cap is accepted");
    // Blitz with exactly enough cash, and the camelCase rules field, are accepted.
    let rules: RulesArg = near_sdk::serde_json::from_str(r#"{"salary":200,"cash":1670,"blitz":true,"maxRounds":3}"#).unwrap();
    assert_eq!(rules.max_rounds, 3);
    t.call(ALICE, STORAGE);
    t.c.create_match("ok".into(), 4, U128(STAKE), vec![6000, 3000, 1000], rules, None, Some(5), None);
    assert_eq!(t.m("ok").turn_seconds, 5);
}

#[test]
fn solo_matches_accept_only_the_solo_player_and_the_house() {
    let mut t = T::new();
    t.create("solo", 4, vec![6000, 3000, 1000], blitz(3), Some(ALICE));
    t.call(BOB, STAKE);
    expect_panic(|| t.c.join("solo".into(), 0), "solo match");
    t.join("solo", HOUSE, 1);
    t.join("solo", ALICE, 0);
    // One seat for the solo player: every other seat is the house's.
    t.call(ALICE, STAKE);
    expect_panic(|| t.c.join("solo".into(), 2), "the solo player backs exactly one seat");
    t.join("solo", HOUSE, 2);
    assert_eq!(t.m("solo").status, Status::Lobby);
    t.join("solo", HOUSE, 3);
    let m = t.m("solo");
    assert_eq!(m.status, Status::Playing);
    assert_eq!(m.game.props.len(), 20, "Blitz deals 5 squares to each of the 4 seats");

    // The house cannot fill the match on its own either: the last free seat waits for the solo player.
    t.create("duel", 2, vec![10000], classic(3), Some(ALICE));
    t.join("duel", HOUSE, 1);
    t.call(HOUSE, STAKE);
    expect_panic(|| t.c.join("duel".into(), 0), "the last free seat is the solo player's");
    t.join("duel", ALICE, 0);
    let m = t.m("duel");
    assert_eq!(m.status, Status::Playing);
    assert_eq!(m.seats[0].backer, Some(acc(ALICE)));
    assert_eq!(m.seats[1].backer, Some(acc(HOUSE)));
    // After leaving, the solo player may sit down again (still one seat).
    t.create("again", 3, vec![10000], classic(3), Some(ALICE));
    t.join("again", ALICE, 2);
    t.call(ALICE, 0);
    t.c.leave("again".into(), 2);
    t.join("again", ALICE, 0);
    assert_eq!(t.m("again").seats[0].backer, Some(acc(ALICE)));
}

#[test]
fn leave_refunds_the_stake_before_the_start() {
    let mut t = T::new();
    t.create("m", 3, vec![10000], classic(1), None);
    t.join("m", ALICE, 0);
    t.call(BOB, 0);
    expect_panic(|| t.c.leave("m".into(), 0), "only the backer");
    t.call(ALICE, 0);
    t.c.leave("m".into(), 0);
    assert_eq!(transfers().get(ALICE), Some(&STAKE));
    assert!(t.m("m").seats[0].backer.is_none());
    t.join("m", ALICE, 0);
    t.join("m", BOB, 1);
    t.join("m", CAROL, 2);
    t.call(ALICE, 0);
    expect_panic(|| t.c.leave("m".into(), 0), "already started");
}

// ----- Playing -----------------------------------------------------------------------------------------------------------

#[test]
fn play_requires_the_backer_or_the_driver_of_the_seat() {
    let mut t = T::new();
    started_pair(&mut t, MANY_ROUNDS);
    let (s, backer) = t.current("m");
    let (other_seat, other) = (1 - s, if backer == ALICE { BOB } else { ALICE });

    t.call(other, 0);
    expect_panic(|| t.c.play("m".into(), s as u8, vec![Action::Roll]), "only the backer or the driver");
    t.call(CAROL, 0);
    expect_panic(|| t.c.play("m".into(), s as u8, vec![Action::Roll]), "only the backer or the driver");
    // The right backer on the wrong seat: the engine refuses (not that seat's turn).
    t.call(other, 0);
    expect_panic(|| t.c.play("m".into(), other_seat as u8, vec![Action::Roll]), "action 0 (roll) rejected: not your turn");
    t.call(&backer, 0);
    expect_panic(|| t.c.play("m".into(), s as u8, vec![Action::Auto]), "not playable");
    t.call(&backer, 0);
    expect_panic(|| t.c.play("m".into(), s as u8, vec![]), "1..=32 actions");

    // Only the backer may name a driver; the driver may then play the seat.
    t.call(CAROL, 0);
    expect_panic(|| t.c.set_driver("m".into(), s as u8, Some(acc(CAROL))), "only the backer");
    t.call(&backer, 0);
    t.c.set_driver("m".into(), s as u8, Some(acc(CAROL)));
    assert_eq!(event("set_driver")["data"]["driver"], CAROL);
    t.call(CAROL, 0);
    let outcome = t.c.play("m".into(), s as u8, vec![Action::Roll]);
    assert_eq!(outcome, near_sdk::serde_json::json!({ "applied": 1, "rejected": null }));
    let actions = event("actions");
    assert!(actions["data"].get("rejected").is_none(), "no `rejected` key when every action was applied");
    assert_eq!(actions["data"]["kind"], "play");
    assert_eq!(actions["data"]["by"], CAROL);
    assert_eq!(actions["data"]["steps"][0]["action"], "Roll");
    assert_eq!(actions["data"]["steps"][0]["events"][0]["kind"], "roll");
    assert!(t.m("m").game.rolls == 1);

    // Removing the driver locks them out again.
    t.call(&backer, 0);
    t.c.set_driver("m".into(), s as u8, None);
    t.call(CAROL, 0);
    expect_panic(|| t.c.play("m".into(), s as u8, vec![Action::End]), "only the backer or the driver");
}

#[test]
fn a_rejected_action_reverts_the_call_only_while_nothing_was_drawn() {
    let mut t = T::new();
    started_pair(&mut t, MANY_ROUNDS);
    let (s, backer) = t.current("m");
    let before = t.c.get_match("m".into()).unwrap();
    let draws = t.m("m").draws;
    // Bankrupt is illegal without a debt, and no die was rolled before it: nothing of the call survives.
    t.call(&backer, 0);
    expect_panic(|| t.c.play("m".into(), s as u8, vec![Action::Bankrupt, Action::Roll]), "action 0 (bankrupt) rejected");
    assert_eq!(t.c.get_match("m".into()).unwrap(), before);
    assert_eq!(t.m("m").draws, draws);
    assert!(events().iter().all(|e| e["event"] != "actions"));

    // The same illegal action after a roll: the roll stands, the rest of the list is dropped and reported. If the
    // call reverted here, appending an action that fails on unwanted outcomes would be a free re-roll.
    t.call(&backer, 0);
    let outcome = t.c.play("m".into(), s as u8, vec![Action::Roll, Action::Bankrupt, Action::End]);
    assert_eq!(outcome["applied"], 1);
    assert_eq!(outcome["rejected"]["index"], 1);
    assert_eq!(outcome["rejected"]["action"], "Bankrupt");
    assert!(!outcome["rejected"]["error"].as_str().unwrap().is_empty());
    let m = t.m("m");
    assert_eq!(m.game.rolls, 1, "the roll is kept");
    assert!(m.draws > draws);
    let actions = event("actions");
    let steps = actions["data"]["steps"].as_array().unwrap();
    assert_eq!(steps.len(), 1);
    assert_eq!(steps[0]["action"], "Roll");
    assert_eq!(actions["data"]["rejected"], outcome["rejected"]);
    assert_eq!(t.c.get_match("m".into()).unwrap()["game"], t.m("m").game.snapshot(), "the kept roll is what the view shows");
}

#[test]
fn calls_that_may_roll_need_the_gas_floor_attached() {
    let floor = MIN_MOVE_GAS.as_tgas();
    let needle = format!("attach at least {floor} Tgas");
    let mut t = T::new();
    t.create("m", 2, vec![7000, 3000], classic(MANY_ROUNDS), None);
    t.call_with_gas(ALICE, STAKE, floor - 1);
    expect_panic(|| t.c.join("m".into(), 0), &needle);
    t.join("m", ALICE, 0);
    t.join("m", BOB, 1);
    let (s, backer) = t.current("m");
    let before = t.c.get_match("m".into()).unwrap();
    t.call_with_gas(&backer, 0, floor - 1);
    expect_panic(|| t.c.play("m".into(), s as u8, vec![Action::Roll]), &needle);
    t.call_with_gas(&backer, 0, floor - 1);
    expect_panic(|| t.c.turn("m".into(), s as u8, Plan::default()), &needle);
    t.now = t.m("m").turn_deadline + 1;
    t.call_with_gas(CAROL, 0, floor - 1);
    expect_panic(|| t.c.timeout("m".into()), &needle);
    assert_eq!(t.c.get_match("m".into()).unwrap(), before);
    // Exactly the floor is enough.
    t.call_with_gas(&backer, 0, floor);
    t.c.play("m".into(), s as u8, vec![Action::Roll]);
    assert_eq!(t.m("m").game.rolls, 1);
}

#[test]
fn only_a_roll_or_a_change_of_seat_restarts_the_turn_clock() {
    let mut t = T::new();
    t.create("b", 2, vec![10000], blitz(MANY_ROUNDS), None);
    t.join("b", ALICE, 0);
    t.join("b", BOB, 1);
    let (s, backer) = t.current("b");
    let square = *t.m("b").game.props.iter().find(|(_, o)| o.owner == format!("s{s}")).unwrap().0;
    let deadline = t.m("b").turn_deadline;
    // The seat to move mortgages and redeems again and again: free moves, which must not buy it more time.
    for _ in 0..3 {
        t.now += 2 * SEC;
        t.call(&backer, 0);
        t.c.play("b".into(), s as u8, vec![Action::Mortgage(square), Action::Redeem(square)]);
        assert_eq!(t.m("b").turn_deadline, deadline, "free moves do not extend the turn");
    }
    // Its roll does.
    t.now += 2 * SEC;
    t.call(&backer, 0);
    t.c.play("b".into(), s as u8, vec![Action::Roll]);
    let after_roll = t.m("b").turn_deadline;
    assert_eq!(after_roll, t.now + 20 * SEC);
    // And after the roll, free moves again leave the deadline alone.
    if current_seat(&t.m("b").game) == Some(s) {
        t.now += 2 * SEC;
        t.call(&backer, 0);
        t.c.play("b".into(), s as u8, vec![Action::Mortgage(square)]);
        assert_eq!(t.m("b").turn_deadline, after_roll);
    }
    // Once the deadline passes, anyone moves the game on.
    t.now = after_roll + 1;
    t.call(CAROL, 0);
    t.c.timeout("b".into());
}

#[test]
fn out_of_turn_sales_follow_the_engine_and_do_not_extend_the_deadline() {
    let mut t = T::new();
    t.create("b", 2, vec![10000], blitz(MANY_ROUNDS), None);
    t.join("b", ALICE, 0);
    t.join("b", BOB, 1);
    let (s, _) = t.current("b");
    let waiting = 1 - s;
    let backer = t.m("b").seats[waiting].backer.clone().unwrap();
    let square = *t.m("b").game.props.iter().find(|(_, o)| o.owner == format!("s{waiting}")).unwrap().0;
    let deadline = t.m("b").turn_deadline;
    t.now += 3 * SEC;
    t.call(backer.as_str(), 0);
    t.c.play("b".into(), waiting as u8, vec![Action::Mortgage(square)]);
    assert!(t.m("b").game.props[&square].mortgaged);
    assert_eq!(t.m("b").turn_deadline, deadline, "a waiting seat cannot extend the current turn");
    // Building is only for the current player (engine rule).
    t.call(backer.as_str(), 0);
    expect_panic(|| t.c.play("b".into(), waiting as u8, vec![Action::Redeem(square), Action::Build(square)]), "action 1 (build)");
}

#[test]
fn turn_plays_a_whole_turn_deterministically() {
    fn scenario(base: u64) -> (Value, Vec<Value>) {
        let mut t = T::with_seed(base);
        t.create("d", 3, vec![6000, 4000], blitz(MANY_ROUNDS), None);
        t.join("d", ALICE, 0);
        t.join("d", BOB, 1);
        t.join("d", CAROL, 2);
        let mut all_events = Vec::new();
        let plan = Plan { buy_reserve: 100, build: OWNABLE.to_vec(), keep_reserve: 300, bail: true, liquidate: vec![] };
        for _ in 0..6 {
            let (s, backer) = t.current("d");
            let rolls = t.m("d").game.rolls;
            t.now += SEC;
            t.call(&backer, 0);
            t.c.turn("d".into(), s as u8, plan.clone());
            let m = t.m("d");
            assert!(m.game.rolls > rolls, "turn() rolls");
            assert_ne!(current_seat(&m.game), Some(s), "turn() ends the turn");
            assert_eq!(m.turn_deadline, t.now + 20 * SEC);
            let actions = event("actions");
            assert_eq!(actions["data"]["kind"], "turn");
            assert_eq!(actions["data"]["steps"].as_array().unwrap().last().unwrap()["action"], "End");
            all_events.push(actions);
        }
        (t.c.get_match("d".into()).unwrap(), all_events)
    }
    // Same seeds give the same game, in fresh environments (the mocked chain is thread-local).
    let a = std::thread::spawn(|| scenario(7)).join().unwrap();
    let b = std::thread::spawn(|| scenario(7)).join().unwrap();
    assert_eq!(a, b);
    let c = std::thread::spawn(|| scenario(8)).join().unwrap();
    assert_ne!(a.0["game"], c.0["game"], "another seed plays differently");

    let mut t = T::new();
    started_pair(&mut t, MANY_ROUNDS);
    let (s, backer) = t.current("m");
    let (_, other) = (1 - s, if backer == ALICE { BOB } else { ALICE });
    t.call(other, 0);
    expect_panic(|| t.c.turn("m".into(), (1 - s) as u8, Plan::default()), "not this seat's turn");
    t.call(&backer, 0);
    expect_panic(|| t.c.turn("m".into(), s as u8, Plan { build: vec![1; 41], ..Plan::default() }), "at most 40");
}

#[test]
fn timeout_only_after_the_deadline_and_the_deadline_stays_expired_until_the_turn_passes() {
    let mut t = T::new();
    started_pair(&mut t, MANY_ROUNDS);
    let deadline = t.m("m").turn_deadline;
    let (s, _) = t.current("m");
    t.now = deadline;
    t.call(CAROL, 0);
    expect_panic(|| t.c.timeout("m".into()), "has not passed");
    t.now = deadline + 1;
    t.call(CAROL, 0);
    t.c.timeout("m".into());
    let actions = event("actions");
    assert_eq!(actions["data"]["kind"], "timeout");
    assert_eq!(actions["data"]["by"], CAROL);
    assert_eq!(actions["data"]["steps"][0]["action"], "Auto");
    assert_eq!(actions["data"]["steps"][0]["events"][0]["kind"], "auto");
    assert_eq!(t.m("m").game.rolls, 1);
    // The timed-out seat keeps an expired deadline: further steps can be forced immediately until the turn passes.
    let mut guard = 0;
    while current_seat(&t.m("m").game) == Some(s) {
        assert_eq!(t.m("m").turn_deadline, deadline);
        t.call(CAROL, 0);
        t.c.timeout("m".into());
        guard += 1;
        assert!(guard < 20);
    }
    let fresh = t.m("m").turn_deadline;
    assert_eq!(fresh, t.now + 20 * SEC, "the next player gets a fresh deadline");
    t.call(CAROL, 0);
    expect_panic(|| t.c.timeout("m".into()), "has not passed");
}

/// Puts the current player of match `id` in debt: `cash`, owing `debt` to the bank, owning `props`.
fn force_debt(t: &mut T, id: &str, cash: i64, debt: i64, props: &[(u8, u8, bool)]) -> String {
    let (s, _) = t.current(id);
    let player = format!("s{s}");
    t.with_match(id, |m| {
        let g = &mut m.game;
        g.props.retain(|_, o| o.owner != player);
        for &(index, houses, mortgaged) in props {
            g.props.insert(index, Owned { owner: player.clone(), houses, mortgaged });
        }
        let p = g.players.iter_mut().find(|p| p.id == player).unwrap();
        g.minted += cash - p.cash;
        p.cash = cash;
        g.stage = Stage::Debt;
        g.debt = Some(vec![Payee { id: None, amount: debt }]);
    });
    player
}

#[test]
fn timeout_in_debt_sells_houses_then_mortgages_then_pays() {
    let mut t = T::new();
    started_pair(&mut t, MANY_ROUNDS);
    // Owes 300 with 10 cash; Hong Kong (37, no houses) and Monaco (39, two houses at 200 each).
    let player = force_debt(&mut t, "m", 10, 300, &[(37, 0, false), (39, 2, false)]);
    t.now = t.m("m").turn_deadline + 1;
    t.call(CAROL, 0);
    t.c.timeout("m".into());
    let steps: Vec<Value> = event("actions")["data"]["steps"].as_array().unwrap().iter().map(|s| s["action"].clone()).collect();
    // Default order is ascending board index: 37 has no house, so both houses of 39 go first, then 37 is mortgaged.
    let expected: Vec<Value> = [Action::Sell(39), Action::Sell(39), Action::Mortgage(37), Action::Pay]
        .iter()
        .map(|a| near_sdk::serde_json::to_value(a).unwrap())
        .collect();
    assert_eq!(steps, expected);
    let g = &t.m("m").game;
    assert_eq!(g.stage, Stage::End);
    assert!(g.debt.is_none());
    assert_eq!(g.player(&player).unwrap().cash, 10 + 100 + 100 + 175 - 300);
    assert_eq!(g.props[&39].houses, 0);
    assert!(g.props[&37].mortgaged && !g.props[&39].mortgaged);
}

#[test]
fn timeout_in_hopeless_debt_declares_bankruptcy_and_settles() {
    let mut t = T::new();
    started_pair(&mut t, MANY_ROUNDS);
    let (s, _) = t.current("m");
    force_debt(&mut t, "m", 10, 300, &[(1, 0, true)]);
    t.now = t.m("m").turn_deadline + 1;
    t.call(CAROL, 0);
    t.c.timeout("m".into());
    let actions = event("actions");
    assert_eq!(actions["data"]["steps"][0]["action"], "Bankrupt");
    assert_eq!(actions["data"]["phase"], "ended");
    assert!(t.c.get_match("m".into()).is_none());
    let result = t.c.get_result("m".into()).unwrap();
    assert_eq!(result["reason"], "last");
    assert_eq!(result["ranking"], near_sdk::serde_json::json!([1 - s, s]));
    let (winner, loser) = if s == 0 { (BOB, ALICE) } else { (ALICE, BOB) };
    assert_eq!(result["deed"], winner);
    // The ranks share the pot less the 2.5% fee.
    let pot = 2 * STAKE - fee_of(2 * STAKE, FEE_BPS);
    let paid = transfers();
    // Alice is also the creator: her transfer adds the storage refund.
    let refund: u128 = event("settle")["data"]["storage_refund"].as_str().unwrap().parse().unwrap();
    let with_refund = |who: &str| if who == ALICE { refund } else { 0 };
    assert_eq!(paid[winner], pot * 7 / 10 + with_refund(winner));
    assert_eq!(paid[loser], pot * 3 / 10 + with_refund(loser));
}

#[test]
fn abandon_only_after_15_minutes_in_the_lobby_and_refunds_everything() {
    let mut t = T::new();
    t.create("a", 3, vec![10000], classic(MANY_ROUNDS), None);
    t.join("a", BOB, 0);
    t.join("a", CAROL, 2);
    let created = t.m("a").created_at;
    t.now = created + ABANDON_AFTER_NS - 1;
    t.call(OWNER, 0);
    expect_panic(|| t.c.abandon("a".into()), "15 minutes");
    t.now = created + ABANDON_AFTER_NS;
    t.call(OWNER, 0);
    t.c.abandon("a".into());
    let paid = transfers();
    assert_eq!(paid[BOB], STAKE);
    assert_eq!(paid[CAROL], STAKE);
    assert_eq!(paid[ALICE], STORAGE, "the creator gets the whole storage deposit back");
    assert!(t.c.get_match("a".into()).is_none());
    assert_eq!(event("abandon")["data"]["status"], "abandoned");
    t.call(OWNER, 0);
    expect_panic(|| t.c.abandon("a".into()), "no such match");

    // A started match cannot be abandoned.
    started_pair(&mut t, MANY_ROUNDS);
    t.now += ABANDON_AFTER_NS;
    t.call(OWNER, 0);
    expect_panic(|| t.c.abandon("m".into()), "still in the lobby");
}

// ----- Settlement ------------------------------------------------------------------------------------------------------

#[test]
fn split_pot_sums_to_the_pot_with_the_remainder_to_rank_0() {
    assert_eq!(split_pot(1000, &[7000, 3000], 2), vec![700, 300]);
    assert_eq!(split_pot(10, &[3333, 3333, 3334], 3), vec![4, 3, 3]);
    assert_eq!(split_pot(7, &[10000], 4), vec![7, 0, 0, 0]);
    let pot = 3 * (NEAR + 1);
    let shares = split_pot(pot, &[5000, 3333, 1667], 3);
    assert_eq!(shares.iter().sum::<u128>(), pot);
    assert_eq!(shares[1], pot * 3333 / 10000);
    assert_eq!(shares[0], pot - shares[1] - shares[2]);
    let mut x: u64 = 0x9e37_79b9;
    for _ in 0..2_000 {
        x = x.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        let ranks = 2 + (x >> 60) as usize % 3;
        let mut left = 10_000u16;
        let mut split = Vec::new();
        for r in 0..ranks {
            let bps = if r + 1 == ranks { left } else { ((x >> (r * 13)) % (u64::from(left) + 1)) as u16 };
            split.push(bps);
            left -= bps;
        }
        let pot = u128::from(x >> 3) * 1_000_003 * ranks as u128;
        let shares = split_pot(pot, &split, ranks);
        assert_eq!(shares.iter().sum::<u128>(), pot);
        for (i, &share) in shares.iter().enumerate().skip(1) {
            assert_eq!(share, pot * u128::from(split[i]) / 10_000);
        }
        assert!(shares[0] - pot * u128::from(split[0]) / 10_000 < ranks as u128);
    }
}

#[test]
fn settlement_pays_backers_forfeits_house_shares_records_stats_and_settles_once() {
    let mut t = T::new();
    t.create("s", 3, vec![5000, 3333, 1667], classic(2), None);
    t.join("s", BOB, 0);
    t.join("s", HOUSE, 1);
    t.join("s", CAROL, 2);
    let plan = Plan { buy_reserve: 200, build: OWNABLE.to_vec(), keep_reserve: 200, bail: true, liquidate: vec![] };
    // Play to the last turn, then keep a copy of the match to try settling it a second time.
    let mut snapshot_before_end = None;
    for _ in 0..100 {
        let Some(m) = t.c.matches.get("s") else { break };
        snapshot_before_end = Some(m.clone());
        let (s, backer) = t.current("s");
        t.now += SEC;
        t.call(&backer, 0);
        t.c.turn("s".into(), s as u8, plan.clone());
    }
    assert!(t.c.get_match("s".into()).is_none());
    let settle = event("settle")["data"].clone();
    let result = t.c.get_result("s".into()).unwrap();
    assert_eq!(result["reason"], "time");
    let pot = 3 * STAKE;
    let fee = pot * 250 / 10_000;
    assert_eq!(fee, 75 * NEAR / 1000, "2.5% of 3 NEAR");
    let shares = split_pot(pot - fee, &[5000, 3333, 1667], 3);
    let backers: Vec<String> = result["backers"].as_array().unwrap().iter().map(|b| b.as_str().unwrap().to_string()).collect();
    let payouts: Vec<u128> = result["payouts"].as_array().unwrap().iter().map(|p| p.as_str().unwrap().parse().unwrap()).collect();
    let forfeited: u128 = result["forfeited"].as_str().unwrap().parse().unwrap();
    let house_rank = backers.iter().position(|b| b == HOUSE).unwrap();
    assert_eq!(payouts[house_rank], 0);
    assert_eq!(forfeited, shares[house_rank]);
    assert_eq!(payouts.iter().sum::<u128>() + forfeited + fee, pot, "every yocto of the pot is paid, forfeited or the fee");
    assert_eq!(t.c.get_forfeited().0, forfeited);
    assert_eq!(t.c.get_fees().0, fee);
    assert_eq!(settle["pot"], pot.to_string());
    assert_eq!(settle["fee"], fee.to_string());
    assert_eq!(settle["fee_bps"], 250);
    assert_eq!(result["pot"], pot.to_string());
    assert_eq!(result["fee"], fee.to_string());
    for (rank, share) in shares.iter().enumerate() {
        assert_eq!(settle["ranks"][rank]["share"], share.to_string());
    }
    // Real transfers: each non-house backer gets their share (alice, the creator, gets the storage refund).
    let paid = transfers();
    for (rank, backer) in backers.iter().enumerate() {
        if backer != HOUSE {
            assert_eq!(paid[backer.as_str()], shares[rank]);
        }
    }
    assert!(!paid.contains_key(HOUSE));
    let refund: u128 = settle["storage_refund"].as_str().unwrap().parse().unwrap();
    assert_eq!(paid[ALICE], refund);
    let record_bytes = settle["record_bytes"].as_u64().unwrap();
    assert_eq!(refund, STORAGE - u128::from(record_bytes) * 10u128.pow(19));
    // Stats.
    let winner = &backers[0];
    for account in [BOB, CAROL, HOUSE] {
        let stats = t.c.get_stats(acc(account));
        assert_eq!(stats["played"], 1);
        assert_eq!(stats["wins"], u32::from(account == winner));
        let rank = backers.iter().position(|b| b == account).unwrap();
        let earned = if account == HOUSE { 0 } else { shares[rank] };
        assert_eq!(stats["earned"], U128(earned).0.to_string());
    }
    // Settles once: every entry point now refuses the id, and settling a stale copy panics.
    for (who, f) in [
        (BOB, Box::new(|c: &mut Contract| drop(c.play("s".into(), 0, vec![Action::Roll]))) as Box<dyn Fn(&mut Contract)>),
        (BOB, Box::new(|c: &mut Contract| c.turn("s".into(), 0, Plan::default()))),
        (CAROL, Box::new(|c: &mut Contract| c.timeout("s".into()))),
        (CAROL, Box::new(|c: &mut Contract| c.abandon("s".into()))),
    ] {
        t.call(who, 0);
        expect_panic(|| f(&mut t.c), "the match has ended");
    }
    let mut stale = snapshot_before_end.unwrap();
    stale.game.phase = Phase::Ended;
    t.call(CAROL, 0);
    expect_panic(|| t.c.settle("s".into(), stale), "already settled");
    assert_eq!(t.c.get_forfeited().0, forfeited);
    assert_eq!(t.c.get_fees().0, fee, "a refused second settlement takes no second fee");
    t.call(ALICE, STORAGE);
    expect_panic(|| t.c.create_match("s".into(), 2, U128(STAKE), vec![10000], classic(1), None, None, None), "already used");
}

/// Plays a 2-seat match where `rich` seat gets a 100,000 cash lead, ending after one round.
fn decided_match(t: &mut T, id: &str, backers: [&str; 2], rich: usize) {
    t.create(id, 2, vec![10000], classic(1), None);
    t.join(id, backers[0], 0);
    t.join(id, backers[1], 1);
    t.with_match(id, |m| {
        let player = &mut m.game.players[rich];
        player.cash += 100_000;
        m.game.minted += 100_000;
    });
    t.play_out_with_timeouts(id);
}

#[test]
fn a_deed_is_minted_only_for_a_non_house_winner() {
    let mut t = T::new();
    decided_match(&mut t, "win", [ALICE, HOUSE], 0);
    let result = t.c.get_result("win".into()).unwrap();
    assert_eq!(result["backers"][0], ALICE);
    assert_eq!(result["deed"], ALICE);
    let token = t.c.tokens.nft_token("win".into()).expect("deed minted");
    assert_eq!(token.owner_id, acc(ALICE));
    let metadata = token.metadata.unwrap();
    assert_eq!(metadata.title.as_deref(), Some("Deedlords match win"));
    let extra: Value = near_sdk::serde_json::from_str(&metadata.extra.unwrap()).unwrap();
    assert_eq!(extra["stake"], STAKE.to_string());
    assert_eq!(extra["seats"], near_sdk::serde_json::json!([ALICE, HOUSE]));
    assert!(get_logs().iter().any(|l| l.contains("\"nft_mint\"")));
    assert_eq!(t.c.tokens.nft_tokens_for_owner(acc(ALICE), None, None).len(), 1);
    // The house's share (rank 1 gets 0 bps here) and the winner's payout: the pot less the fee.
    let after_fee = 2 * STAKE - fee_of(2 * STAKE, FEE_BPS);
    assert_eq!(transfers()[ALICE], after_fee + event("settle")["data"]["storage_refund"].as_str().unwrap().parse::<u128>().unwrap());

    decided_match(&mut t, "lose", [ALICE, HOUSE], 1);
    let result = t.c.get_result("lose".into()).unwrap();
    assert_eq!(result["backers"][0], HOUSE);
    assert!(result["deed"].is_null());
    assert!(t.c.tokens.nft_token("lose".into()).is_none(), "no deed for a house win");
    assert!(!get_logs().iter().any(|l| l.contains("\"nft_mint\"")));
    assert_eq!(t.c.get_forfeited().0, after_fee, "the house's winning share is locked");
    assert_eq!(t.c.get_fees().0, 2 * fee_of(2 * STAKE, FEE_BPS), "both matches paid the fee");
    assert_eq!(t.c.get_stats(acc(HOUSE))["wins"], 1);
    assert_eq!(t.c.get_stats(acc(HOUSE))["earned"], "0");
    assert_eq!(t.c.tokens.nft_total_supply().0, 1);
}

#[test]
fn storage_reserve_covers_a_full_match() {
    // Longest account ids, 4 seats with drivers, Blitz with building: the largest match this contract stores.
    let long = |c: char| format!("{}.near", c.to_string().repeat(59));
    let (a, b, c, d) = (long('a'), long('b'), long('c'), long('d'));
    let mut t = T::new();
    t.c.matches.flush();
    let base = stored_bytes();
    t.call(&a, STORAGE);
    t.c.create_match("x".repeat(32), 4, U128(STAKE), vec![4000, 3000, 2000, 1000], blitz(3), None, None, None);
    let id = "x".repeat(32);
    let measured_in_call = event("create_match");
    assert_eq!(measured_in_call["data"]["id"], id);
    t.c.matches.flush();
    let created = stored_bytes() - base;
    for (k, who) in [&a, &b, &c, &d].into_iter().enumerate() {
        t.join(&id, who, k as u8);
        t.call(who, 0);
        t.c.set_driver(id.clone(), k as u8, Some(acc(&long('z'))));
    }
    let plan = Plan { buy_reserve: 0, build: OWNABLE.to_vec(), keep_reserve: 0, bail: true, liquidate: vec![] };
    let mut peak = 0;
    while t.c.matches.get(&id).is_some() {
        t.c.matches.flush();
        peak = peak.max(stored_bytes() - base);
        let (s, _) = t.current(&id);
        t.now += SEC;
        t.call(&long('z'), 0);
        t.c.turn(id.clone(), s as u8, plan.clone());
    }
    let record = event("settle")["data"]["record_bytes"].as_u64().unwrap();
    let growth = peak - created;
    println!("storage: match at creation {created} B, peak {peak} B (growth {growth} B), permanent records {record} B");
    assert!(growth + record <= STORAGE_RESERVE_BYTES, "reserve {STORAGE_RESERVE_BYTES} < growth {growth} + records {record}");
}

// ----- Fee -------------------------------------------------------------------------------------------------------------

#[test]
fn the_fee_is_a_floor_of_the_pot_and_the_shares_take_the_rest() {
    assert_eq!(fee_of(20 * NEAR, 250), NEAR / 2, "2.5% of a 20 NEAR pot is 0.5 NEAR");
    assert_eq!(fee_of(0, 250), 0);
    assert_eq!(fee_of(39, 250), 0, "rounded down: 39 * 250 / 10000");
    assert_eq!(fee_of(40, 250), 1);
    assert_eq!(fee_of(4 * MAX_STAKE, MAX_FEE_BPS), MAX_STAKE / 5, "the largest pot there can be does not overflow");
    let mut x: u64 = 0x51ed_270b;
    for _ in 0..2_000 {
        x = x.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        let pot = u128::from(x >> 5) * 999_983;
        let fee_bps = (x % (u64::from(MAX_FEE_BPS) + 1)) as u16;
        let fee = fee_of(pot, fee_bps);
        assert!(fee <= pot / 20, "never more than 5%");
        assert!(pot * u128::from(fee_bps) - fee * 10_000 < 10_000, "the floor of pot * bps / 10000");
        let shares = split_pot(pot - fee, &[5500, 2500, 1500, 500], 4);
        assert_eq!(shares.iter().sum::<u128>() + fee, pot);
    }
}

#[test]
fn the_fee_is_capped_at_five_percent() {
    context(CONTRACT, 0, NOW0, seed(0));
    expect_panic(|| Contract::new(acc(OWNER), acc(HOUSE), U128(CAP), MAX_FEE_BPS + 1), "fee_bps must be at most 500");
    assert_eq!(Contract::new(acc(OWNER), acc(HOUSE), U128(CAP), MAX_FEE_BPS).get_config()["fee_bps"], 500);

    // A deployment without a fee pays the whole pot, as before the fee existed.
    let mut t = T::with_fee(0, 0);
    decided_match(&mut t, "free", [ALICE, BOB], 0);
    let result = t.c.get_result("free".into()).unwrap();
    assert_eq!(result["fee"], "0");
    assert_eq!(result["payouts"][0], (2 * STAKE).to_string());
    assert_eq!(t.c.get_fees().0, 0);
    t.call(OWNER, 1);
    expect_panic(|| t.c.withdraw_fees(), "there are no fees to withdraw");
}

/// Opens, fills and plays out a match in which seat `rich` wins, with `between` run after both seats are taken.
fn decided_match_with(t: &mut T, id: &str, rich: usize, between: impl FnOnce(&mut T)) {
    t.create(id, 2, vec![10000], classic(1), None);
    t.join(id, ALICE, 0);
    t.join(id, BOB, 1);
    between(t);
    t.with_match(id, |m| {
        let player = &mut m.game.players[rich];
        player.cash += 100_000;
        m.game.minted += 100_000;
    });
    t.play_out_with_timeouts(id);
}

#[test]
fn only_the_owner_sets_the_fee_within_the_cap() {
    let mut t = T::with_fee(0, 0);
    t.call(ALICE, 1);
    expect_panic(|| t.c.set_fee(100), "only the owner may set the fee");
    t.call(OWNER, 0);
    expect_panic(|| t.c.set_fee(100), "Requires attached deposit of exactly 1 yoctoNEAR");
    t.call(OWNER, 1);
    expect_panic(|| t.c.set_fee(MAX_FEE_BPS + 1), "fee_bps must be at most 500");
    assert_eq!(t.c.get_config()["fee_bps"], 0);
    t.call(OWNER, 1);
    t.c.set_fee(MAX_FEE_BPS);
    assert_eq!(t.c.get_config()["fee_bps"], 500);
    assert_eq!(event("set_fee")["data"], near_sdk::serde_json::json!({ "from": 0, "to": 500 }));
}

#[test]
fn a_match_keeps_the_fee_it_was_opened_with() {
    // Opened free; the owner sets 2.5% while it is being played: it still pays no fee.
    let mut t = T::with_fee(0, 0);
    decided_match_with(&mut t, "free", 0, |t| {
        t.call(OWNER, 1);
        t.c.set_fee(FEE_BPS);
    });
    let result = t.c.get_result("free".into()).unwrap();
    assert_eq!(result["fee"], "0");
    assert_eq!(result["payouts"][0], (2 * STAKE).to_string());
    assert_eq!(event("settle")["data"]["fee_bps"], 0);
    assert_eq!(t.c.get_fees().0, 0);
    assert!(env::storage_read(&fee_key("free")).is_none(), "the match's fee record goes with the match");

    // Opened at 2.5%; the owner drops the fee to zero mid-game: the 2.5% stands, and the next match is free.
    decided_match_with(&mut t, "paid", 0, |t| {
        assert_eq!(t.c.get_match("paid".into()).unwrap()["meta"]["fee_bps"], 250, "the view shows the match's own fee");
        t.call(OWNER, 1);
        t.c.set_fee(0);
    });
    assert_eq!(t.c.get_result("paid".into()).unwrap()["fee"], fee_of(2 * STAKE, FEE_BPS).to_string());
    decided_match_with(&mut t, "after", 0, |_| {});
    assert_eq!(t.c.get_result("after".into()).unwrap()["fee"], "0");
    assert_eq!(t.c.get_fees().0, fee_of(2 * STAKE, FEE_BPS));
}

#[test]
fn a_match_opened_before_fee_records_pays_the_fee_in_force_then() {
    // A deployment upgraded in place has open matches with no fee record: they pay the fee of the deployment until
    // the owner changes it, and that same fee after.
    let mut t = T::with_fee(0, FEE_BPS);
    decided_match_with(&mut t, "old", 0, |t| {
        env::storage_remove(&fee_key("old"));
        t.call(OWNER, 1);
        t.c.set_fee(0);
        t.call(OWNER, 1);
        t.c.set_fee(MAX_FEE_BPS);
    });
    assert_eq!(t.c.get_result("old".into()).unwrap()["fee"], fee_of(2 * STAKE, FEE_BPS).to_string());
}

#[test]
fn a_lobby_that_never_starts_pays_no_fee() {
    let mut t = T::new();
    t.create("gone", 2, vec![7000, 3000], classic(2), None);
    t.join("gone", ALICE, 0);
    t.call(ALICE, 0);
    t.c.leave("gone".into(), 0);
    assert_eq!(transfers()[ALICE], STAKE, "leaving returns the whole stake");
    t.join("gone", BOB, 1);
    t.now += ABANDON_AFTER_NS;
    t.call(CAROL, 0);
    t.c.abandon("gone".into());
    let paid = transfers();
    assert_eq!(paid[BOB], STAKE, "abandoning returns the whole stake");
    assert_eq!(paid[ALICE], STORAGE, "and the whole storage deposit");
    assert_eq!(t.c.get_fees().0, 0);
}

#[test]
fn only_the_owner_withdraws_and_only_the_fees() {
    let mut t = T::new();
    decided_match(&mut t, "one", [ALICE, BOB], 0);
    decided_match(&mut t, "two", [ALICE, HOUSE], 1);
    let fee = fee_of(2 * STAKE, FEE_BPS);
    assert_eq!(fee, NEAR / 20, "2.5% of a 2 NEAR pot");
    assert_eq!(t.c.get_fees().0, 2 * fee);
    let forfeited = t.c.get_forfeited().0;
    assert_eq!(forfeited, 2 * STAKE - fee);
    // A match still being played: its stakes are not fees.
    started_pair(&mut t, MANY_ROUNDS);

    t.call(ALICE, 1);
    expect_panic(|| t.c.withdraw_fees(), "only the owner may withdraw the fees");
    t.call(HOUSE, 1);
    expect_panic(|| t.c.withdraw_fees(), "only the owner may withdraw the fees");
    // Without the yocto a function-call key could sign it.
    t.call(OWNER, 0);
    expect_panic(|| t.c.withdraw_fees(), "Requires attached deposit of exactly 1 yoctoNEAR");
    assert_eq!(t.c.get_fees().0, 2 * fee);

    t.call(OWNER, 1);
    assert_eq!(t.c.withdraw_fees().0, 2 * fee);
    let paid = transfers();
    assert_eq!(paid.len(), 1, "one transfer: {paid:?}");
    assert_eq!(paid[OWNER], 2 * fee);
    assert_eq!(event("withdraw_fees")["data"]["amount"], (2 * fee).to_string());
    assert_eq!(event("withdraw_fees")["data"]["to"], OWNER);
    assert_eq!(t.c.get_fees().0, 0);
    assert_eq!(t.c.get_forfeited().0, forfeited, "the house's locked shares stay locked");
    assert_eq!(t.m("m").status, Status::Playing);

    t.call(OWNER, 1);
    expect_panic(|| t.c.withdraw_fees(), "there are no fees to withdraw");
    // The next match fills the counter again.
    decided_match(&mut t, "three", [BOB, CAROL], 1);
    assert_eq!(t.c.get_fees().0, fee);
}

/// The state of the first testnet deployment: the layout without `fee_bps` and `fees`.
fn first_layout(open_match: bool) -> ContractV1 {
    // Matches and results in the old layout are made by a contract of today: neither `Match` nor `MatchResult` changed.
    let mut t = T::new();
    decided_match(&mut t, "old-1", [ALICE, HOUSE], 1);
    decided_match(&mut t, "old-2", [ALICE, BOB], 0);
    if open_match {
        started_pair(&mut t, MANY_ROUNDS);
    }
    t.c.matches.flush();
    t.c.results.flush();
    t.c.stats.flush();
    let v1 = ContractV1 {
        owner: acc(OWNER),
        house: acc(HOUSE),
        matches: IterableMap::new(b"m".to_vec()),
        results: LookupMap::new(b"r".to_vec()),
        stats: LookupMap::new(b"s".to_vec()),
        forfeited: NearToken::from_yoctonear(t.c.get_forfeited().0),
        tokens: NonFungibleToken::new(b"o".to_vec(), acc(OWNER), Some(b"t".to_vec()), Some(b"e".to_vec()), None::<Vec<u8>>),
        max_stake: NearToken::from_yoctonear(CAP),
    };
    // The collections keep only prefixes and lengths in the root; `matches` also keeps its list of keys.
    ContractV1 { matches: std::mem::replace(&mut t.c.matches, IterableMap::new(b"x".to_vec())), ..v1 }
}

#[test]
fn migrate_adds_the_fee_to_a_deployment_of_the_first_layout() {
    let old = first_layout(false);
    let forfeited = old.forfeited;
    context(CONTRACT, 0, NOW0 + SEC, seed(7));
    env::state_write(&old);
    expect_panic(|| Contract::migrate(MAX_FEE_BPS + 1), "fee_bps must be at most 500");
    let mut c = Contract::migrate(FEE_BPS);
    let config = c.get_config();
    assert_eq!(config["owner"], OWNER);
    assert_eq!(config["house"], HOUSE);
    assert_eq!(config["max_stake"], CAP.to_string());
    assert_eq!(config["fee_bps"], 250);
    assert_eq!(config["matches"], 0);
    assert_eq!(c.get_fees().0, 0);
    assert_eq!(c.get_forfeited().0, forfeited.as_yoctonear());
    // What was settled before stays readable.
    let result = c.get_result("old-2".into()).expect("an old result");
    assert_eq!(result["backers"][0], ALICE);
    assert_eq!(c.get_stats(acc(ALICE))["played"], 2);
    assert_eq!(c.tokens.nft_token("old-2".into()).expect("an old deed").owner_id, acc(ALICE));
    // And the upgraded contract works: a used id stays used, a new match can be opened.
    context(ALICE, STORAGE, NOW0 + 2 * SEC, seed(8));
    expect_panic(|| c.create_match("old-1".into(), 2, U128(STAKE), vec![10000], classic(1), None, None, None), "already used");
    context(ALICE, STORAGE, NOW0 + 2 * SEC, seed(9));
    c.create_match("new".into(), 2, U128(STAKE), vec![10000], classic(1), None, None, None);
    assert_eq!(c.get_match("new".into()).unwrap()["meta"]["fee_bps"], 250);
    // The new layout is not the first one: migrating twice is refused (near-sdk fails to read the state as `ContractV1`).
    env::state_write(&c);
    expect_panic(|| Contract::migrate(FEE_BPS), "Cannot deserialize the contract state");
}

#[test]
fn migrate_is_refused_while_a_match_is_open() {
    let old = first_layout(true);
    context(CONTRACT, 0, NOW0 + SEC, seed(7));
    env::state_write(&old);
    expect_panic(|| Contract::migrate(FEE_BPS), "finish or abandon every open match first");
}

// ----- Views -------------------------------------------------------------------------------------------------------------

#[test]
fn views_expose_meta_snapshot_log_and_lists() {
    let mut t = T::new();
    started_pair(&mut t, MANY_ROUNDS);
    t.create("lobby", 2, vec![10000], classic(MANY_ROUNDS), None);
    let view = t.c.get_match("m".into()).unwrap();
    assert_eq!(view["meta"]["status"], "playing");
    assert_eq!(view["meta"]["seats"][0]["backer"], ALICE);
    assert_eq!(view["meta"]["seats"][1]["player"], "s1");
    assert_eq!(view["meta"]["stake"], STAKE.to_string());
    assert_eq!(view["meta"]["fee_bps"], 250);
    assert_eq!(view["game"]["players"].as_array().unwrap().len(), 2);
    assert_eq!(view["game"], t.m("m").game.snapshot());
    assert_eq!(view["log"][0]["kind"], "start");
    let list = t.c.list_matches(None, None);
    assert_eq!(list.len(), 2);
    assert_eq!(t.c.list_matches(Some(1), Some(5)).len(), 1);
    assert_eq!(t.c.list_matches(None, Some(1))[0]["id"], "m");
    assert!(t.c.get_result("m".into()).is_none());
    assert_eq!(t.c.get_stats(acc(ALICE))["played"], 0);
    let config = t.c.get_config();
    assert_eq!(config["house"], HOUSE);
    assert_eq!(config["max_stake"], CAP.to_string());
    assert_eq!(config["fee_bps"], 250);
    assert_eq!(config["max_fee_bps"], 500);
    assert_eq!(list[0]["fee_bps"], 250);
    assert_eq!(config["min_move_gas"], MIN_MOVE_GAS.as_gas().to_string());
}

#[test]
fn the_stake_cap_is_set_once_at_deployment() {
    context(CONTRACT, 0, NOW0, seed(0));
    expect_panic(|| Contract::new(acc(OWNER), acc(HOUSE), U128(MAX_STAKE + 1), FEE_BPS), "max_stake must be at most");
    let c = Contract::new(acc(OWNER), acc(HOUSE), U128(MAX_STAKE), FEE_BPS);
    assert_eq!(c.get_config()["max_stake"], MAX_STAKE.to_string());
    // A cap of 0 makes a free-play deployment: only stake-0 matches.
    let mut t = T::new();
    t.c = Contract::new(acc(OWNER), acc(HOUSE), U128(0), FEE_BPS);
    t.call(ALICE, STORAGE);
    expect_panic(|| t.c.create_match("paid".into(), 2, U128(1), vec![10000], classic(1), None, None, None), "stake too large");
    t.call(ALICE, STORAGE);
    t.c.create_match("free".into(), 2, U128(0), vec![10000], classic(1), None, None, None);
}

// ----- Rng ---------------------------------------------------------------------------------------------------------------

#[test]
fn rng_mappings_have_no_modulo_bias() {
    // Exhaustive: every face has exactly 42 accepted bytes.
    let mut faces = [0u32; 7];
    for byte in 0..=255u8 {
        if let Some(face) = die_from_byte(byte) {
            faces[usize::from(face)] += 1;
        }
    }
    assert_eq!(faces[1..], [42; 6]);
    // The accepted u32 range is a whole multiple of n, so each residue has the same number of accepted values.
    for n in [2u32, 3, 5, 6, 7, 12, 16, 28, 1_000_003, u32::MAX] {
        let limit = below_limit(n);
        assert_eq!(limit % u64::from(n), 0);
        assert!((1u64 << 32) - limit < u64::from(n));
        assert_eq!(below_from_u32((limit - 1) as u32, n), Some(((limit - 1) % u64::from(n)) as u32));
        if limit < 1 << 32 {
            assert_eq!(below_from_u32(limit as u32, n), None);
        }
    }
}

#[test]
fn chain_rng_is_uniform_on_a_large_sample() {
    // Chi-square goodness of fit with the real sha256 host function. 99.9% critical values: 20.52 (5 dof),
    // 22.46 (6 dof), 55.48 (27 dof).
    fn chi2(counts: &[u64]) -> f64 {
        let total: u64 = counts.iter().sum();
        let expected = total as f64 / counts.len() as f64;
        counts.iter().map(|&c| (c as f64 - expected).powi(2) / expected).sum()
    }
    let mut dice = [0u64; 6];
    let mut seven = [0u64; 7];
    let mut squares = [0u64; 28];
    let mut draws = 0u64;
    for chunk in 0..24u64 {
        context(CAROL, 0, NOW0, seed(chunk));
        let mut rng = ChainRng::new(env::random_seed_array(), "sample", &mut draws, near_sha256);
        for _ in 0..5_000 {
            dice[usize::from(rng.die() - 1)] += 1;
        }
        for _ in 0..1_500 {
            seven[rng.below(7) as usize] += 1;
            squares[rng.below(28) as usize] += 1;
        }
    }
    let (d, s7, s28) = (chi2(&dice), chi2(&seven), chi2(&squares));
    println!("chi2: dice {d:.2} (120000), below(7) {s7:.2} (36000), below(28) {s28:.2} (36000); hashes {draws}");
    assert!(d < 20.52 && s7 < 22.46 && s28 < 55.48);
    // Draws are counted per hash: ~120000/31.5 for the dice plus 8 u32 per hash for below.
    assert!(draws > 3_800 && draws < 15_000);
}

#[test]
fn chain_rng_depends_on_seed_match_and_counter() {
    fn fake(input: &[u8]) -> [u8; 32] {
        let mut out = [0u8; 32];
        for (i, b) in input.iter().enumerate() {
            out[i % 32] = out[i % 32].wrapping_mul(31).wrapping_add(*b);
        }
        out
    }
    let roll = |seed_byte: u8, id: &str, start: u64| {
        let mut draws = start;
        let mut rng = ChainRng::new([seed_byte; 32], id, &mut draws, fake);
        let faces: Vec<u8> = (0..40).map(|_| rng.die()).collect();
        (faces, draws)
    };
    let base = roll(1, "m", 0);
    assert_eq!(base, roll(1, "m", 0));
    assert_ne!(base.0, roll(2, "m", 0).0);
    assert_ne!(base.0, roll(1, "n", 0).0);
    assert_ne!(base.0, roll(1, "m", 5).0);
    assert!(base.1 >= 2, "40 dice need at least two 32-byte blocks");
    // below() never splits a u32 across blocks and returns in range.
    let mut draws = 0;
    let mut rng = ChainRng::new([9; 32], "m", &mut draws, fake);
    for n in 2..60 {
        assert!(rng.below(n) < n);
    }
    assert_eq!(rng.below(1), 0);
}

// ----- Autoplay on plain engine games --------------------------------------------------------------------------------------

/// LCG Rng for engine-level tests.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 33
    }
}

impl Rng for Lcg {
    fn die(&mut self) -> u8 {
        (self.next() % 6) as u8 + 1
    }
    fn below(&mut self, n: u32) -> u32 {
        (self.next() % u64::from(n)) as u32
    }
}

fn engine_game(players: usize, rules: Rules, rng: &mut Lcg) -> Game {
    let mut game = Game::new(rules, (0..players).map(|k| format!("s{k}")).collect());
    let mut steps = Vec::new();
    apply_logged(&mut game, None, Action::Start, rng, &mut steps).unwrap();
    game
}

fn random_plan(rng: &mut Lcg) -> Plan {
    let pick = |rng: &mut Lcg, len: u64| -> Vec<u8> { (0..rng.next() % len).map(|_| OWNABLE[(rng.next() % 28) as usize]).collect() };
    Plan {
        buy_reserve: (rng.next() % 600) as i64 - 100,
        build: pick(rng, 12),
        keep_reserve: (rng.next() % 500) as i64 - 50,
        bail: rng.next().is_multiple_of(2),
        liquidate: pick(rng, 6),
    }
}

#[test]
fn play_turn_always_finishes_the_turn_on_random_games() {
    let mut total_turns = 0;
    for game_no in 0..300u64 {
        let mut rng = Lcg(game_no * 7919 + 1);
        let blitz = game_no % 2 == 0;
        let rules = Rules { salary: 200, cash: if blitz { 2000 } else { 1500 }, blitz, max_rounds: 1 + (game_no % 12) as u8 };
        let players = 2 + (game_no % 3) as usize;
        let mut game = engine_game(players, rules, &mut rng);
        while game.phase == Phase::Playing {
            let seat = game.current_player().unwrap().to_string();
            let plan = random_plan(&mut rng);
            let mut steps = Vec::new();
            let rolls = game.rolls;
            play_turn(&mut game, &seat, &plan, &mut rng, &mut steps).unwrap();
            assert!(game.rolls > rolls || steps.iter().any(|s| s.action == Action::Bankrupt));
            assert!(game.phase == Phase::Ended || game.current_player() != Some(seat.as_str()), "game {game_no}: turn did not end");
            assert_eq!(game.players.iter().map(|p| p.cash).sum::<i64>(), game.minted, "money is conserved");
            assert!(game.players.iter().all(|p| p.bankrupt || p.cash >= 0));
            total_turns += 1;
        }
        assert!(game.result.is_some());
    }
    assert!(total_turns > 1_000);
}

#[test]
fn timeout_steps_alone_finish_random_games() {
    for game_no in 0..200u64 {
        let mut rng = Lcg(game_no * 104_729 + 3);
        let blitz = game_no % 2 == 1;
        let rules = Rules { salary: 200, cash: if blitz { 2000 } else { 1500 }, blitz, max_rounds: 3 };
        let mut game = engine_game(2 + (game_no % 3) as usize, rules, &mut rng);
        let mut guard = 0;
        while game.phase == Phase::Playing {
            // Random debts on top of Auto, so the liquidation path is exercised.
            if rng.next().is_multiple_of(9) && game.stage != Stage::Debt {
                let seat = game.current_player().unwrap().to_string();
                let cash = game.player(&seat).unwrap().cash;
                game.stage = Stage::Debt;
                game.debt = Some(vec![Payee { id: None, amount: cash + (rng.next() % 900) as i64 }]);
            }
            let in_debt = game.stage == Stage::Debt;
            let mut steps = Vec::new();
            timeout_step(&mut game, &mut rng, &mut steps).unwrap();
            assert!(!steps.is_empty());
            if in_debt {
                // The debt is settled (paid, or bankrupt and the turn passed); an Auto roll may land on a new one later.
                assert!(game.phase == Phase::Ended || game.stage != Stage::Debt, "a timeout always resolves the debt");
            }
            guard += 1;
            assert!(guard < 10_000);
        }
    }
}

#[test]
fn apply_logged_keeps_the_engine_log_and_reports_each_actions_events() {
    let mut rng_a = Lcg(42);
    let mut rng_b = Lcg(42);
    let rules = Rules { salary: 200, cash: 2000, blitz: true, max_rounds: 6 };
    let mut logged = Game::new(rules, vec!["s0".into(), "s1".into(), "s2".into()]);
    let mut plain = logged.clone();
    let mut steps: Vec<Step> = Vec::new();
    apply_logged(&mut logged, None, Action::Start, &mut rng_a, &mut steps).unwrap();
    plain.apply(None, Action::Start, &mut rng_b).unwrap();
    let mut chooser = Lcg(7);
    let mut events_seen = 0;
    while logged.phase == Phase::Playing {
        let seat = logged.current_player().unwrap().to_string();
        // Everything but giving up: this game has to run long enough for the log to wrap around.
        let legal: Vec<Action> = logged.legal_actions(&seat).into_iter().filter(|action| *action != Action::Resign).collect();
        let action = legal[(chooser.next() % legal.len() as u64) as usize];
        let before = steps.len();
        apply_logged(&mut logged, Some(&seat), action, &mut rng_a, &mut steps).unwrap();
        plain.apply(Some(&seat), action, &mut rng_b).unwrap();
        assert_eq!(logged, plain, "same state and same 30-event log as plain apply");
        assert_eq!(steps.len(), before + 1);
        let new = &steps.last().unwrap().events;
        assert!(plain.log.ends_with(new) || new.len() > 30);
        events_seen += new.len();
    }
    assert!(events_seen > 30, "the log wrapped around");
    // A rejected action records nothing and changes nothing.
    let mut game = engine_game(2, Rules::default(), &mut Lcg(1));
    let copy = game.clone();
    let mut steps = Vec::new();
    assert!(apply_logged(&mut game, Some("s0"), Action::Pay, &mut Lcg(1), &mut steps).is_err());
    assert_eq!(game, copy);
    assert!(steps.is_empty());
}

#[test]
fn liquidation_follows_the_plan_order_then_the_board_order() {
    let mut game = engine_game(2, Rules::default(), &mut Lcg(5));
    let me = game.current_player().unwrap().to_string();
    for (index, houses) in [(1u8, 0u8), (3, 1), (37, 2), (39, 1), (5, 0)] {
        game.props.insert(index, Owned { owner: me.clone(), houses, mortgaged: false });
    }
    // Houses first, plan order first: 39, then 37 twice, then board order (3).
    let mut order = Vec::new();
    let plan = [39u8, 37];
    while let Some(action) = liquidation_step(&game, &me, &plan) {
        order.push(action);
        game.apply(Some(&me), action, &mut Lcg(0)).unwrap();
    }
    assert_eq!(
        order,
        vec![
            Action::Sell(39),
            Action::Sell(37),
            Action::Sell(37),
            Action::Sell(3),
            Action::Mortgage(39),
            Action::Mortgage(37),
            Action::Mortgage(1),
            Action::Mortgage(3),
            Action::Mortgage(5),
        ]
    );
    // resolve_debt stops as soon as the debt can be paid.
    let mut game = engine_game(2, Rules::default(), &mut Lcg(5));
    let me = game.current_player().unwrap().to_string();
    game.props.insert(39, Owned { owner: me.clone(), houses: 3, mortgaged: false });
    let p = game.players.iter().position(|p| p.id == me).unwrap();
    game.minted -= game.players[p].cash;
    game.players[p].cash = 0;
    game.stage = Stage::Debt;
    game.debt = Some(vec![Payee { id: None, amount: 150 }]);
    let mut steps = Vec::new();
    resolve_debt(&mut game, &me, &[], &mut Lcg(0), &mut steps).unwrap();
    let actions: Vec<Action> = steps.iter().map(|s| s.action).collect();
    assert_eq!(actions, vec![Action::Sell(39), Action::Sell(39), Action::Pay]);
    assert_eq!(game.props[&39].houses, 1);
    assert_eq!(game.player(&me).unwrap().cash, 50);
}

// ----- A hosted match, and giving up -------------------------------------------------------------------------------------

#[test]
fn a_hosted_match_waits_for_its_host_and_nobody_else_starts_it() {
    let mut t = T::new();
    t.call(ALICE, STORAGE);
    t.c.create_match("room".into(), 3, U128(STAKE), vec![6000, 3000, 1000], classic(MANY_ROUNDS), None, None, Some(acc(ALICE)));
    assert_eq!(t.c.get_match("room".into()).unwrap()["meta"]["host"], ALICE);
    t.join("room", ALICE, 0);
    t.join("room", BOB, 1);
    // Not every seat is taken yet: not even the host starts it.
    t.call(ALICE, 0);
    expect_panic(|| t.c.start("room".into()), "every seat must be taken");
    t.join("room", CAROL, 2);
    assert_eq!(t.m("room").status, Status::Lobby, "the last seat does not start a hosted match");
    assert_eq!(t.m("room").turn_deadline, 0);
    // Only the host says go, by `start` or by playing `Start`.
    t.call(BOB, 0);
    expect_panic(|| t.c.start("room".into()), "only the host may start");
    t.call(BOB, 0);
    expect_panic(|| t.c.play("room".into(), 1, vec![Action::Start]), "only the host may start");
    // A move before the start is refused as it always was.
    t.call(ALICE, 0);
    expect_panic(|| t.c.play("room".into(), 0, vec![Action::Roll]), "the match is not being played");
    // Seats can still be left while everybody waits; the host starts once they are all taken again.
    t.call(CAROL, 0);
    t.c.leave("room".into(), 2);
    t.call(ALICE, 0);
    expect_panic(|| t.c.play("room".into(), 0, vec![Action::Start]), "every seat must be taken");
    t.join("room", CAROL, 2);
    t.call(ALICE, 0);
    assert_eq!(t.c.play("room".into(), 0, vec![Action::Start])["applied"], 1);
    assert_eq!(t.m("room").status, Status::Playing);
    assert!(t.m("room").turn_deadline > t.now);
    assert_eq!(event("start")["data"]["id"], "room");
    let meta = t.c.get_match("room".into()).unwrap()["meta"].clone();
    assert_eq!(meta["host"], Value::Null, "the host's record is gone once the game runs");
    assert!(env::storage_read(b"host:room").is_none());
    // Started is started.
    t.call(ALICE, 0);
    expect_panic(|| t.c.start("room".into()), "already started");
    t.call(ALICE, 0);
    expect_panic(|| t.c.play("room".into(), 0, vec![Action::Start]), "not playable");
}

#[test]
fn a_match_with_no_host_starts_by_itself_and_an_abandoned_room_leaves_no_host_behind() {
    let mut t = T::new();
    t.create("auto", 2, vec![10000], classic(MANY_ROUNDS), None);
    assert_eq!(t.c.get_match("auto".into()).unwrap()["meta"]["host"], Value::Null);
    t.join("auto", ALICE, 0);
    t.call(ALICE, 0);
    expect_panic(|| t.c.start("auto".into()), "this match has no host");
    t.join("auto", BOB, 1);
    assert_eq!(t.m("auto").status, Status::Playing);

    // A host and a solo player do not go together: the house would wait for somebody to start it.
    t.call(ALICE, STORAGE);
    expect_panic(
        || t.c.create_match("solo".into(), 2, U128(STAKE), vec![10000], classic(1), Some(acc(ALICE)), None, Some(acc(ALICE))),
        "a solo match starts by itself",
    );

    // The host may be somebody other than who opened and paid for the room.
    t.call(ALICE, STORAGE);
    t.c.create_match("gift".into(), 2, U128(STAKE), vec![10000], classic(1), None, None, Some(acc(BOB)));
    assert_eq!(t.c.get_match("gift".into()).unwrap()["meta"]["host"], BOB);
    t.join("gift", BOB, 0);
    t.now += ABANDON_AFTER_NS + 1;
    t.call(CAROL, 0);
    t.c.abandon("gift".into());
    assert!(env::storage_read(b"host:gift").is_none());
}

#[test]
fn a_player_gives_up_through_play_and_the_match_is_settled() {
    let mut t = T::new();
    t.create("duel", 2, vec![7000, 3000], classic(MANY_ROUNDS), None);
    t.join("duel", ALICE, 0);
    t.join("duel", BOB, 1);
    let (current, _) = t.current("duel");
    // The seat that is NOT to move gives up: no need to wait for one's turn.
    let (quitter, who) = if current == 0 { (1u8, BOB) } else { (0u8, ALICE) };
    let stayer = if who == BOB { ALICE } else { BOB };
    // Nobody gives up for somebody else.
    t.call(stayer, 0);
    expect_panic(|| t.c.play("duel".into(), quitter, vec![Action::Resign]), "only the backer or the driver");
    t.call(who, 0);
    let outcome = t.c.play("duel".into(), quitter, vec![Action::Resign]);
    assert_eq!(outcome["applied"], 1);
    assert_eq!(outcome["rejected"], Value::Null);
    assert!(t.c.matches.get("duel").is_none(), "one player left: settled in the same call");
    let result = t.c.get_result("duel".into()).unwrap();
    assert_eq!(result["reason"], "last");
    assert_eq!(result["ranking"], near_sdk::serde_json::json!([1 - quitter, quitter]));
    assert_eq!(result["backers"][0], stayer);
}
