//! Unit tests: whole matches through the contract's methods under `testing_env!`, with a new block seed per call.

use std::panic::{catch_unwind, AssertUnwindSafe};

use arena_engine::{UNITS, WON};
use near_sdk::json_types::U128;
use near_sdk::serde_json::Value;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, AccountId, Gas, NearToken};

use crate::{seal, Contract, ABANDON_AFTER_NS};

const STAKE: u128 = 10u128.pow(24);
const SECOND: u64 = 1_000_000_000;
const EMPTY: &str = r#"{"sells":[],"bids":[0,0,0,0,0],"promotes":[],"formation":null}"#;

fn acc(name: &str) -> AccountId {
    name.parse().unwrap()
}

/// A contract, a clock, and a counter that gives every call its own block seed.
struct T {
    c: Contract,
    now: u64,
    calls: u8,
}

fn context(who: &str, deposit: u128, now: u64, seed: u8) {
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(acc("arena.test"))
        .predecessor_account_id(acc(who))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(now)
        .random_seed([seed; 32])
        .prepaid_gas(Gas::from_tgas(300));
    testing_env!(builder.build());
}

impl T {
    fn new(fee_bps: u16) -> T {
        let now = 1_000 * SECOND;
        context("arena.test", 0, now, 0);
        T { c: Contract::new(acc("owner.test"), U128(100 * STAKE), fee_bps), now, calls: 0 }
    }

    fn as_caller(&mut self, who: &str, deposit: u128) {
        self.calls = self.calls.wrapping_add(1);
        self.now += SECOND;
        context(who, deposit, self.now, self.calls);
    }

    fn start(&mut self, id: &str, rounds: u8) {
        self.as_caller("p1.test", STAKE);
        self.c.create_match(id.into(), rounds, U128(STAKE), None);
        self.as_caller("p2.test", STAKE);
        self.c.join(id.into());
    }

    fn game(&self, id: &str) -> Value {
        self.c.get_match(id.into()).expect("the match is under way")
    }

    fn hex(bytes: [u8; 32]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn commit(&mut self, id: &str, who: &str, seat: u8, plan: &str) {
        self.as_caller(who, 0);
        self.c.commit(id.into(), seat, Self::hex(seal(plan, "salt")));
    }

    fn reveal(&mut self, id: &str, who: &str, seat: u8, plan: &str) {
        self.as_caller(who, 0);
        self.c.reveal(id.into(), seat, plan.into(), "salt".into());
    }

    /// Seat 0's plan for this round: bid the cost of the first market unit and stand it next to what is already there.
    fn buyer_plan(&self, id: &str) -> String {
        let game = &self.game(id)["game"];
        let unit = game["market"][0].as_u64().unwrap() as usize;
        let mut formation: Vec<String> = game["seats"][0]["formation"].as_array().unwrap().iter().enumerate().filter(|(_, held)| held.as_i64().unwrap() >= 0).map(|(cell, held)| format!("[{held},{cell}]")).collect();
        let free = (0..6).find(|cell| game["seats"][0]["formation"][*cell].as_i64().unwrap() < 0).unwrap();
        formation.push(format!("[{WON},{free}]"));
        format!(r#"{{"sells":[],"bids":[{},0,0,0,0],"promotes":[],"formation":[{}]}}"#, UNITS[unit].cost, formation.join(","))
    }
}

fn fails(action: impl FnOnce()) -> bool {
    catch_unwind(AssertUnwindSafe(action)).is_err()
}

#[test]
fn a_match_is_played_to_the_payout() {
    let mut t = T::new(250);
    t.start("m1", 3);
    assert_eq!(t.game("m1")["phase"], "commit");
    assert_eq!(t.game("m1")["game"]["market"].as_array().unwrap().len(), 5);
    for round in 1..=3 {
        let plan = t.buyer_plan("m1");
        t.commit("m1", "p1.test", 0, &plan);
        assert_eq!(t.game("m1")["phase"], "commit");
        t.commit("m1", "p2.test", 1, EMPTY);
        assert_eq!(t.game("m1")["phase"], "reveal");
        t.reveal("m1", "p2.test", 1, EMPTY);
        t.reveal("m1", "p1.test", 0, &plan);
        if round < 3 {
            let game = t.game("m1");
            assert_eq!(game["game"]["round"], round + 1);
            assert_eq!(game["game"]["last"]["winner"], 0);
            assert_eq!(game["game"]["seats"][0]["pieces"].as_array().unwrap().len(), round as usize);
        }
    }
    assert!(t.c.get_match("m1".into()).is_none());
    let result = t.c.get_result("m1".into()).unwrap();
    assert_eq!(result["ranking"], near_sdk::serde_json::json!([0, 1]));
    assert_eq!(result["backers"][0], "p1.test");
    let paid = |rank: usize| result["payouts"][rank].as_str().unwrap().parse::<u128>().unwrap();
    let fee = result["fee"].as_str().unwrap().parse::<u128>().unwrap();
    assert_eq!(fee, 2 * STAKE * 250 / 10_000);
    assert_eq!(paid(0), (2 * STAKE - fee) * 7 / 10);
    assert_eq!(paid(0) + paid(1) + fee, 2 * STAKE);
    assert_eq!(t.c.get_config()["fees"], fee.to_string());
    // The id cannot be used again.
    t.as_caller("p1.test", STAKE);
    assert!(fails(|| t.c.create_match("m1".into(), 3, U128(STAKE), None)));
}

#[test]
fn a_plan_must_match_its_commitment_and_only_the_seat_may_play() {
    let mut t = T::new(0);
    t.start("m2", 3);
    t.as_caller("p2.test", 0);
    assert!(fails(|| t.c.commit("m2".into(), 0, T::hex(seal(EMPTY, "salt")))), "p2 cannot play seat 0");
    t.commit("m2", "p1.test", 0, EMPTY);
    t.as_caller("p1.test", 0);
    assert!(fails(|| t.c.reveal("m2".into(), 0, EMPTY.into(), "salt".into())), "no reveal before both committed");
    // A driver named by the backer may play the seat.
    t.as_caller("p2.test", 0);
    t.c.set_driver("m2".into(), 1, Some(acc("agent.test")));
    t.commit("m2", "agent.test", 1, EMPTY);
    t.as_caller("p1.test", 0);
    assert!(fails(|| t.c.commit("m2".into(), 0, T::hex(seal(EMPTY, "other")))), "no new commitment once both are in");
    assert!(fails(|| t.c.reveal("m2".into(), 0, EMPTY.into(), "wrong".into())), "the salt must match");
    let other = EMPTY.replace("null", "[]");
    assert!(fails(|| t.c.reveal("m2".into(), 0, other, "salt".into())), "the plan must match");
    t.reveal("m2", "p1.test", 0, EMPTY);
    t.as_caller("p1.test", 0);
    assert!(fails(|| t.c.reveal("m2".into(), 0, EMPTY.into(), "salt".into())), "one reveal per round");
    t.reveal("m2", "agent.test", 1, EMPTY);
    assert_eq!(t.game("m2")["game"]["round"], 2);
    assert_eq!(t.game("m2")["game"]["last"]["winner"], 2);
}

#[test]
fn a_seat_that_runs_out_of_time_plays_the_empty_plan() {
    let mut t = T::new(0);
    t.start("m3", 3);
    t.as_caller("p1.test", 0);
    assert!(fails(|| t.c.timeout("m3".into())), "not before the deadline");
    // Nobody commits: the round is played with two empty plans.
    t.now += 61 * SECOND;
    t.as_caller("anyone.test", 0);
    t.c.timeout("m3".into());
    assert_eq!(t.game("m3")["game"]["round"], 2);
    // Seat 0 commits in time, seat 1 never does: seat 1 gets the empty plan and seat 0 may still reveal.
    let plan = t.buyer_plan("m3");
    t.commit("m3", "p1.test", 0, &plan);
    t.now += 61 * SECOND;
    t.as_caller("anyone.test", 0);
    t.c.timeout("m3".into());
    assert_eq!(t.game("m3")["phase"], "reveal");
    assert_eq!(t.game("m3")["game"]["round"], 2);
    t.reveal("m3", "p1.test", 0, &plan);
    assert_eq!(t.game("m3")["game"]["round"], 3);
    assert_eq!(t.game("m3")["game"]["last"]["winner"], 0);
    // Both commit, nobody reveals: the last round is played empty and the match is settled.
    t.commit("m3", "p1.test", 0, EMPTY);
    t.commit("m3", "p2.test", 1, EMPTY);
    t.now += 61 * SECOND;
    t.as_caller("anyone.test", 0);
    t.c.timeout("m3".into());
    assert!(t.c.get_match("m3".into()).is_none());
    assert_eq!(t.c.get_result("m3".into()).unwrap()["ranking"][0], 0);
}

#[test]
fn a_lobby_can_be_closed_and_the_stake_is_exact() {
    let mut t = T::new(0);
    t.as_caller("p1.test", STAKE - 1);
    assert!(fails(|| t.c.create_match("m4".into(), 3, U128(STAKE), None)), "the deposit must be the stake");
    t.as_caller("p1.test", STAKE);
    assert!(fails(|| t.c.create_match("m4".into(), 9, U128(STAKE), None)), "rounds are 3 to 7");
    t.c.create_match("m4".into(), 5, U128(STAKE), None);
    t.as_caller("p2.test", 0);
    assert!(fails(|| t.c.leave("m4".into())), "only the creator may leave");
    assert!(fails(|| t.c.abandon("m4".into())), "not before 15 minutes");
    t.now += ABANDON_AFTER_NS;
    t.as_caller("p2.test", 0);
    t.c.abandon("m4".into());
    assert!(t.c.get_match("m4".into()).is_none());
    t.as_caller("p1.test", STAKE);
    t.c.create_match("m5".into(), 5, U128(STAKE), None);
    t.as_caller("p1.test", 0);
    t.c.leave("m5".into());
    assert!(t.c.get_match("m5".into()).is_none());
}
