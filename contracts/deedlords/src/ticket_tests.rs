//! Matches with tickets and the leader's rent (ENGINE-RULES §10): how they are stored beside matches without them,
//! how a call asks for them, and a table of agents playing every ticket through `turn`.

use deedlords_engine::board::OWNABLE;
use deedlords_engine::{Event, Extras, Ticket};
use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::json_types::U128;
use near_sdk::serde_json::{json, Value};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, AccountId, Gas, NearToken};

use crate::*;

const CONTRACT: &str = "game.test";
const NEAR: u128 = 10u128.pow(24);

fn acc(id: &str) -> AccountId {
    id.parse().unwrap()
}

/// A call by `who` with `deposit` attached and `input` as its JSON arguments, in block `n`.
fn call(who: &str, deposit: u128, n: u64, input: Value) {
    let mut seed = [7u8; 32];
    seed[..8].copy_from_slice(&n.to_le_bytes());
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(acc(CONTRACT))
        .predecessor_account_id(acc(who))
        .signer_account_id(acc(who))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(1_000_000_000 * (1_700_000_000 + n))
        .random_seed(seed)
        .account_balance(NearToken::from_near(10_000))
        .prepaid_gas(Gas::from_tgas(300));
    let mut context = builder.build();
    context.input = input.to_string().into_bytes().into();
    testing_env!(context);
}

fn contract() -> Contract {
    call(CONTRACT, 0, 0, json!({}));
    Contract::new(acc("owner.test"), acc("house.test"), U128(100 * NEAR), 250)
}

fn rules() -> RulesArg {
    RulesArg { salary: 200, cash: 2000, blitz: true, max_rounds: 12 }
}

/// A started match of `seats` accounts `a0`, `a1`…, opened with `extras`.
fn started(c: &mut Contract, id: &str, seats: u8, extras: Extras) {
    call("a0", NEAR, 1, json!({}));
    let split = if seats == 2 { vec![7000, 3000] } else { vec![5000, 3000, 1500, 500] };
    c.open_match(id.into(), seats, U128(NEAR / 10), split, rules(), extras, None, Some(30), None);
    for seat in 0..seats {
        call(&format!("a{seat}"), NEAR / 10, 2 + u64::from(seat), json!({}));
        c.join(id.into(), seat);
    }
}

/// The layout every deployment has stored, derived: what `Match` wrote before it was written by hand.
#[derive(BorshSerialize, BorshDeserialize)]
#[borsh(crate = "near_sdk::borsh")]
struct StoredBefore {
    rules: Rules,
    stake: NearToken,
    split: Vec<u16>,
    seats: Vec<Seat>,
    solo_player: Option<AccountId>,
    creator: AccountId,
    storage_deposit: NearToken,
    status: Status,
    created_at: u64,
    last_activity: u64,
    turn_seconds: u32,
    turn_deadline: u64,
    draws: u64,
    game: Game,
}

/// The match as a contract loaded afresh reads it from storage (the one in hand answers from what it has in memory).
fn stored_again(id: &str) -> Match {
    let fresh: near_sdk::store::IterableMap<String, Match> = near_sdk::store::IterableMap::new(b"m".to_vec());
    fresh.get(id).expect("the match is in storage").clone()
}

fn as_before(m: &Match) -> StoredBefore {
    StoredBefore {
        rules: m.rules,
        stake: m.stake,
        split: m.split.clone(),
        seats: m.seats.clone(),
        solo_player: m.solo_player.clone(),
        creator: m.creator.clone(),
        storage_deposit: m.storage_deposit,
        status: m.status,
        created_at: m.created_at,
        last_activity: m.last_activity,
        turn_seconds: m.turn_seconds,
        turn_deadline: m.turn_deadline,
        draws: m.draws,
        game: m.game.clone(),
    }
}

#[test]
fn a_match_without_the_new_rules_is_stored_byte_for_byte_as_before_and_old_bytes_read() {
    let mut c = contract();
    started(&mut c, "plain", 2, Extras::default());
    c.matches.flush();
    let m = c.matches.get("plain").unwrap().clone();
    let old = borsh::to_vec(&as_before(&m)).unwrap();
    assert_eq!(borsh::to_vec(&m).unwrap(), old, "the same bytes the derived layout wrote");
    let read = Match::try_from_slice(&old).unwrap();
    assert!(read.game.extras.is_off() && read.game.tickets.is_none());
    assert_eq!(read.game, m.game);
    assert_eq!(stored_again("plain").game, m.game, "and it comes back from storage, where the map writes its own bytes after it");
    assert_eq!(
        c.get_match("plain".into()).unwrap()["meta"]["rules"],
        json!({ "salary": 200, "cash": 2000, "blitz": true, "maxRounds": 12 })
    );
    assert!(c.get_match("plain".into()).unwrap()["game"].get("tickets").is_none());
}

#[test]
fn a_match_with_the_new_rules_keeps_them_in_a_tail_after_the_old_layout() {
    let mut c = contract();
    started(&mut c, "tix", 4, Extras { tickets: true, leader_rent: true, build_here: false, build_one: false });
    c.matches.flush();
    let m = c.matches.get("tix").unwrap().clone();
    let bytes = borsh::to_vec(&m).unwrap();
    let old = borsh::to_vec(&as_before(&m)).unwrap();
    // The old layout first; one bit of the status byte says a tail follows it.
    let flagged: Vec<usize> = (0..old.len()).filter(|&i| bytes[i] != old[i]).collect();
    assert_eq!(flagged.len(), 1, "one byte differs");
    assert_eq!(bytes[flagged[0]], old[flagged[0]] | MATCH_TAIL_FLAG);
    assert_eq!(bytes[old.len()], MATCH_TAIL_V1);
    let read = Match::try_from_slice(&bytes).unwrap();
    assert_eq!(read.game, m.game, "extras and tickets come back");
    assert_eq!(read.status, Status::Playing);
    // Whatever follows the match in storage (the map's own index) is left alone, with a tail and without.
    let (again, index) = <(Match, u32)>::try_from_slice(&borsh::to_vec(&(m.clone(), 1u32)).unwrap()).unwrap();
    assert_eq!((again.game, index), (m.game.clone(), 1));
    assert_eq!(stored_again("tix").game, m.game, "and it comes back from storage");
    assert_eq!(read.game.tickets.as_ref().unwrap().held.len(), 4);
    assert!(read.game.tickets.as_ref().unwrap().held.values().all(|held| held.len() == 1), "a ticket each at the start");
    // A tail this code does not know is refused, not misread.
    let mut unknown = bytes.clone();
    unknown[old.len()] = 9;
    assert!(Match::try_from_slice(&unknown).is_err());
    let view = c.get_match("tix".into()).unwrap();
    assert_eq!(
        view["meta"]["rules"],
        json!({ "salary": 200, "cash": 2000, "blitz": true, "maxRounds": 12, "tickets": true, "leaderRent": true })
    );
    assert!(view["game"]["tickets"]["held"]["s3"].is_array());
}

#[test]
fn create_match_reads_the_opt_in_rules_from_its_arguments_and_get_config_lists_them() {
    let mut c = contract();
    assert_eq!(c.get_config()["features"], json!(["tickets", "leaderRent", "buildHere", "hostGrace", "away", "close", "buildOne"]));
    let args = |rules: Value| json!({ "id": "x", "seats": 2, "stake": "0", "split": [7000, 3000], "rules": rules, "solo_player": null, "turn_seconds": 30 });
    for (id, sent, want) in [
        (
            "both",
            json!({ "salary": 200, "cash": 2000, "blitz": true, "max_rounds": 12, "tickets": true, "leaderRent": true }),
            (true, true),
        ),
        ("snake", json!({ "salary": 200, "cash": 2000, "blitz": true, "max_rounds": 12, "leader_rent": true }), (false, true)),
        ("none", json!({ "salary": 200, "cash": 2000, "blitz": true, "max_rounds": 12 }), (false, false)),
        ("odd", json!({ "salary": 200, "cash": 2000, "blitz": true, "max_rounds": 12, "tickets": "yes", "leaderRent": 1 }), (false, false)),
    ] {
        call("a0", NEAR, 1, args(sent));
        c.create_match(id.into(), 2, U128(0), vec![7000, 3000], rules(), None, Some(30), None);
        let extras = c.matches.get(id).unwrap().game.extras;
        assert_eq!((extras.tickets, extras.leader_rent), want, "{id}");
    }
}

fn played(events: &[Event], ticket: Ticket) -> bool {
    events.iter().any(|event| matches!(event, Event::Played { ticket: t, .. } if *t == ticket))
}

#[test]
fn agents_play_every_ticket_through_turn_and_the_match_settles() {
    let mut c = contract();
    let mut seen = [false; 4];
    let mut waived = false;
    for game_no in 0..12u64 {
        let id = format!("g{game_no}");
        let seats = if game_no % 2 == 0 { 2 } else { 4 };
        started(&mut c, &id, seats, Extras { tickets: true, leader_rent: true, build_here: false, build_one: false });
        let plan = Plan { buy_reserve: 100, build: OWNABLE.to_vec(), keep_reserve: 300, bail: true, liquidate: vec![] };
        let tickets = TicketPlan { waiver: true, festival: true, steps: 2 + (game_no % 11) as u8, takeover: OWNABLE.to_vec() };
        for turn in 0..400u64 {
            let Some(m) = c.matches.get(&id) else { break };
            let s = current_seat(&m.game).unwrap();
            call(&format!("a{s}"), 0, 100 + game_no * 1000 + turn, json!({}));
            c.turn_with(id.clone(), s as u8, plan.clone(), tickets.clone());
            if let Some(m) = c.matches.get(&id) {
                for (i, ticket) in Ticket::ALL.iter().enumerate() {
                    seen[i] |= played(&m.game.log, *ticket);
                }
                waived |= m.game.log.iter().any(|event| matches!(event, Event::Waived { .. }));
                let state = m.game.tickets.as_ref().unwrap();
                assert!(state.held.values().all(|held| held.len() <= 2));
                assert_eq!(m.game.players.iter().map(|p| p.cash).sum::<i64>(), m.game.minted);
            }
        }
        assert!(c.matches.get(&id).is_none() && c.get_result(id.clone()).is_some(), "{id} settled");
    }
    assert_eq!(seen, [true; 4], "waiver, steps, takeover, festival were each played");
    assert!(waived, "a waiver took a rent");
}

#[test]
fn turn_reads_the_tickets_of_its_plan_from_its_arguments() {
    let mut c = contract();
    started(&mut c, "t", 2, Extras { tickets: true, leader_rent: false, build_here: false, build_one: false });
    let s = current_seat(&c.matches.get("t").unwrap().game).unwrap();
    let seat = format!("s{s}");
    c.matches.get_mut("t").unwrap().game.tickets.as_mut().unwrap().held.insert(seat.clone(), vec![Ticket::Festival, Ticket::Steps]);
    call(
        &format!("a{s}"),
        0,
        50,
        json!({ "id": "t", "seat": s, "plan": { "buy_reserve": 0, "tickets": { "festival": true, "steps": 9 } } }),
    );
    c.turn("t".into(), s as u8, Plan::default());
    let m = c.matches.get("t").unwrap();
    assert!(played(&m.game.log, Ticket::Festival) && played(&m.game.log, Ticket::Steps));
    assert!(m.game.log.contains(&Event::Played { player: seat.clone(), ticket: Ticket::Steps, value: 9 }));
    assert_eq!(m.game.tickets.as_ref().unwrap().festival, [seat]);
    // A plan without tickets, in the same match, plays none: the turn is the one `turn` always played.
    let s = current_seat(&m.game).unwrap();
    call(&format!("a{s}"), 0, 51, json!({ "id": "t", "seat": s, "plan": {} }));
    c.turn("t".into(), s as u8, Plan::default());
    assert!(!c.matches.get("t").unwrap().game.log.iter().rev().take(3).any(|event| matches!(event, Event::Played { .. })));
}

#[test]
fn building_only_where_one_stops_is_stored_after_the_tickets_and_reads_back() {
    let mut c = contract();
    // With tickets: tail version 2, the tickets as before, then the flag.
    let both = Extras { tickets: true, leader_rent: true, build_here: true, build_one: false };
    started(&mut c, "here", 4, both);
    // Alone: a tail all the same (the status bit is set), with no tickets in it.
    started(&mut c, "only", 2, Extras { build_here: true, ..Extras::default() });
    c.matches.flush();
    for (id, extras) in [("here", both), ("only", Extras { build_here: true, ..Extras::default() })] {
        let m = c.matches.get(id).unwrap().clone();
        let bytes = borsh::to_vec(&m).unwrap();
        let old = borsh::to_vec(&as_before(&m)).unwrap();
        assert_eq!(bytes[old.len()], MATCH_TAIL_V2, "{id}: version 2 of the tail");
        let read = Match::try_from_slice(&bytes).unwrap();
        assert_eq!(read.game.extras, extras);
        assert_eq!(read.game, m.game);
        assert_eq!(stored_again(id).game.extras, extras, "{id}: and from storage");
        assert_eq!(c.get_match(id.into()).unwrap()["meta"]["rules"]["buildHere"], json!(true));
    }
    // A match with tickets but not this rule keeps version 1, byte for byte what the build before wrote.
    started(&mut c, "v1", 2, Extras { tickets: true, leader_rent: true, build_here: false, build_one: false });
    c.matches.flush();
    let m = c.matches.get("v1").unwrap().clone();
    let old = borsh::to_vec(&as_before(&m)).unwrap();
    assert_eq!(borsh::to_vec(&m).unwrap()[old.len()], MATCH_TAIL_V1);
    assert!(c.get_match("v1".into()).unwrap()["meta"]["rules"].get("buildHere").is_none());
    // And `create_match` reads it from its arguments, in either spelling.
    let args = |rules: Value| json!({ "id": "x", "seats": 2, "stake": "0", "split": [7000, 3000], "rules": rules, "solo_player": null, "turn_seconds": 30 });
    for (id, sent) in [
        ("camel", json!({ "salary": 200, "cash": 2000, "blitz": true, "max_rounds": 12, "buildHere": true })),
        ("snake2", json!({ "salary": 200, "cash": 2000, "blitz": true, "max_rounds": 12, "build_here": true })),
    ] {
        call("a0", NEAR, 1, args(sent));
        c.create_match(id.into(), 2, U128(0), vec![7000, 3000], rules(), None, Some(30), None);
        assert!(c.matches.get(id).unwrap().game.extras.build_here, "{id}");
    }
}

#[test]
fn one_house_a_turn_is_stored_in_a_third_tail_and_reads_back() {
    let mut c = contract();
    let one = Extras { tickets: true, leader_rent: true, build_here: false, build_one: true };
    started(&mut c, "one", 4, one);
    started(&mut c, "alone", 2, Extras { build_one: true, ..Extras::default() });
    c.matches.flush();
    for (id, extras) in [("one", one), ("alone", Extras { build_one: true, ..Extras::default() })] {
        let m = c.matches.get(id).unwrap().clone();
        let bytes = borsh::to_vec(&m).unwrap();
        let old = borsh::to_vec(&as_before(&m)).unwrap();
        assert_eq!(bytes[old.len()], MATCH_TAIL_V3, "{id}: version 3 of the tail");
        assert_eq!(Match::try_from_slice(&bytes).unwrap().game.extras, extras);
        assert_eq!(stored_again(id).game.extras, extras, "{id}: and from storage");
        let rules = c.get_match(id.into()).unwrap()["meta"]["rules"].clone();
        assert_eq!(rules["buildOne"], json!(true));
        assert!(rules.get("buildHere").is_none());
    }
    // The tails of before stay what they were: version 2 with buildHere alone, version 1 with neither.
    started(&mut c, "v2", 2, Extras { tickets: true, leader_rent: true, build_here: true, build_one: false });
    started(&mut c, "v1b", 2, Extras { tickets: true, leader_rent: true, build_here: false, build_one: false });
    c.matches.flush();
    for (id, version) in [("v2", MATCH_TAIL_V2), ("v1b", MATCH_TAIL_V1)] {
        let m = c.matches.get(id).unwrap().clone();
        let old = borsh::to_vec(&as_before(&m)).unwrap();
        assert_eq!(borsh::to_vec(&m).unwrap()[old.len()], version, "{id}");
    }
    let args = |rules: Value| json!({ "id": "x", "seats": 2, "stake": "0", "split": [7000, 3000], "rules": rules, "solo_player": null, "turn_seconds": 30 });
    call("a0", NEAR, 1, args(json!({ "salary": 200, "cash": 2000, "blitz": true, "max_rounds": 12, "buildOne": true })));
    c.create_match("asked".into(), 2, U128(0), vec![7000, 3000], rules(), None, Some(30), None);
    let extras = c.matches.get("asked").unwrap().game.extras;
    assert!(extras.build_one && !extras.build_here);
}
