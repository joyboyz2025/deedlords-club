//! Tickets and the leader's rent (ENGINE-RULES §10): the cases worth reading one by one. The traces (`tickets-*.json`)
//! check the same rules against the TypeScript engine on whole games.

use std::collections::VecDeque;

use crate::{Action, EngineError, Event, Extras, Game, Owned, Rng, Rules, Stage, Ticket};
use borsh::BorshDeserialize;

/// Hands out the queued values, for dice and draws alike, and fails the test when asked for more.
struct Script(VecDeque<u32>);

impl Script {
    fn new(values: &[u32]) -> Self {
        Script(values.iter().copied().collect())
    }
}

impl Rng for Script {
    fn die(&mut self) -> u8 {
        self.0.pop_front().expect("no die scripted") as u8
    }
    fn below(&mut self, n: u32) -> u32 {
        let value = self.0.pop_front().expect("no draw scripted");
        assert!(value < n, "scripted {value} for below({n})");
        value
    }
}

const BOTH: Extras = Extras { tickets: true, leader_rent: true };

/// Two players in seating order, classic rules; `draws`: the ticket each is dealt (`below(4)`), when tickets are on.
fn started(extras: Extras, draws: &[u32]) -> Game {
    let mut game = Game::new(Rules::default(), vec!["p0".into(), "p1".into()]).with_extras(extras);
    let mut values = vec![1];
    values.extend_from_slice(draws);
    let mut rng = Script::new(&values);
    game.apply(None, Action::Start, &mut rng).unwrap();
    assert!(rng.0.is_empty());
    game
}

fn act(game: &mut Game, id: &str, action: Action, values: &[u32]) -> Result<(), EngineError> {
    let mut rng = Script::new(values);
    let result = game.apply(Some(id), action, &mut rng);
    assert!(rng.0.is_empty(), "the engine left scripted values unused");
    result
}

fn own(game: &mut Game, index: u8, owner: &str, houses: u8) {
    game.props.insert(index, Owned { owner: owner.into(), houses, mortgaged: false });
}

fn hold(game: &mut Game, id: &str, tickets: &[Ticket]) {
    game.tickets.as_mut().unwrap().held.insert(id.into(), tickets.to_vec());
}

fn cash(game: &Game, id: &str) -> i64 {
    game.player(id).unwrap().cash
}

#[test]
fn without_the_rules_there_is_no_ticket_state_and_no_ticket_action() {
    let mut game = started(Extras::default(), &[]);
    assert!(game.tickets.is_none());
    assert!(game.snapshot().get("tickets").is_none(), "the snapshot is the one of section 8");
    for action in [Action::Waiver, Action::Festival, Action::Steps(7), Action::Takeover] {
        assert_eq!(act(&mut game, "p0", action, &[]), Err(EngineError::NotAllowed));
    }
    assert!(!game.legal_actions("p0").iter().any(|a| matches!(a, Action::Waiver | Action::Festival | Action::Steps(_) | Action::Takeover)));
    // Passing Departure draws nothing.
    game.players[0].position = 38;
    act(&mut game, "p0", Action::Roll, &[1, 2]).unwrap();
    assert_eq!(cash(&game, "p0"), 1700);
}

#[test]
fn the_borsh_form_of_a_game_is_the_one_from_before_and_leaves_the_new_rules_out() {
    let plain = started(Extras::default(), &[]);
    let mut with = started(BOTH, &[0, 3]);
    let bytes = borsh::to_vec(&with).unwrap();
    let read = Game::try_from_slice(&bytes).unwrap();
    assert_eq!(read.extras, Extras::default());
    assert!(read.tickets.is_none());
    // Apart from the log (the tickets dealt), the stored bytes are those of the same game without the rules.
    with.log = plain.log.clone();
    assert_eq!(borsh::to_vec(&with).unwrap(), borsh::to_vec(&plain).unwrap());
}

#[test]
fn a_ticket_each_at_the_start_and_one_more_at_departure_up_to_two() {
    let mut game = started(Extras { tickets: true, leader_rent: false }, &[0, 3]);
    assert_eq!(game.tickets_of("p0"), [Ticket::Waiver]);
    assert_eq!(game.tickets_of("p1"), [Ticket::Festival]);
    assert_eq!(
        game.snapshot()["tickets"],
        serde_json::json!({ "held": { "p0": ["waiver"], "p1": ["festival"] }, "waiver": false, "festival": [] })
    );
    // 38 + 3 passes Departure: the salary, then one draw.
    game.players[0].position = 38;
    act(&mut game, "p0", Action::Roll, &[1, 2, 1]).unwrap();
    assert_eq!(game.tickets_of("p0"), [Ticket::Waiver, Ticket::Steps]);
    assert!(game.log.contains(&Event::Drew { player: "p0".into(), ticket: Ticket::Steps }));
    // Holding two: the salary, and nothing is drawn (the script holds no value for a draw).
    act(&mut game, "p0", Action::Skip, &[]).unwrap();
    act(&mut game, "p0", Action::End, &[]).unwrap();
    act(&mut game, "p1", Action::Roll, &[1, 3]).unwrap();
    act(&mut game, "p1", Action::End, &[]).unwrap();
    game.players[0].position = 38;
    let before = cash(&game, "p0");
    act(&mut game, "p0", Action::Roll, &[1, 2]).unwrap();
    assert_eq!(cash(&game, "p0"), before + 200);
    assert_eq!(game.tickets_of("p0").len(), 2);
}

#[test]
fn a_rent_waiver_takes_the_next_rent_of_the_turn_and_only_that() {
    let mut game = started(BOTH, &[0, 0]);
    own(&mut game, 3, "p1", 0);
    assert_eq!(act(&mut game, "p1", Action::Waiver, &[]), Err(EngineError::NotYourTurn));
    act(&mut game, "p0", Action::Waiver, &[]).unwrap();
    assert!(game.tickets.as_ref().unwrap().waiver);
    assert_eq!(act(&mut game, "p0", Action::Waiver, &[]), Err(EngineError::NoTicket));
    act(&mut game, "p0", Action::Roll, &[1, 2]).unwrap();
    assert_eq!((cash(&game, "p0"), cash(&game, "p1")), (1500, 1500), "no rent changed hands");
    assert_eq!(game.stage, Stage::End);
    assert!(!game.tickets.as_ref().unwrap().waiver);
    assert!(game.log.contains(&Event::Waived { player: "p0".into(), owner: "p1".into(), square: 3, amount: 5 }));
    // Played and not needed: gone when the turn passes.
    act(&mut game, "p0", Action::End, &[]).unwrap();
    act(&mut game, "p1", Action::Waiver, &[]).unwrap();
    act(&mut game, "p1", Action::Roll, &[2, 3]).unwrap();
    act(&mut game, "p1", Action::Skip, &[]).unwrap();
    act(&mut game, "p1", Action::End, &[]).unwrap();
    assert!(!game.tickets.as_ref().unwrap().waiver);
    assert!(game.tickets_of("p1").is_empty());
}

#[test]
fn pick_your_steps_is_a_throw_with_chosen_dice_and_no_second_throw() {
    let mut game = started(BOTH, &[1, 1]);
    assert_eq!(act(&mut game, "p0", Action::Steps(13), &[]), Err(EngineError::NotAllowed));
    assert_eq!(act(&mut game, "p0", Action::Steps(1), &[]), Err(EngineError::NotAllowed));
    act(&mut game, "p0", Action::Steps(6), &[]).unwrap();
    assert_eq!((game.dice, game.rolls, game.again, game.doubles), (Some([5, 1]), 1, false, 0));
    assert_eq!((game.players[0].position, game.stage), (6, Stage::Buy));
    assert_eq!(act(&mut game, "p0", Action::Steps(6), &[]), Err(EngineError::WrongStage));
    act(&mut game, "p0", Action::Skip, &[]).unwrap();
    act(&mut game, "p0", Action::End, &[]).unwrap();
    // Twelve is shown as a double six, and is not one: no second throw.
    game.players[1].position = 9;
    act(&mut game, "p1", Action::Steps(12), &[]).unwrap();
    assert_eq!((game.dice, game.again, game.doubles, game.players[1].position), (Some([6, 6]), false, 0, 21));
    // Not from custody.
    hold(&mut game, "p0", &[Ticket::Steps]);
    act(&mut game, "p1", Action::Skip, &[]).unwrap();
    act(&mut game, "p1", Action::End, &[]).unwrap();
    game.players[0].jail = Some(0);
    assert_eq!(act(&mut game, "p0", Action::Steps(5), &[]), Err(EngineError::WrongStage));
}

#[test]
fn a_festival_and_the_lead_each_add_one_rent_until_the_owners_next_turn() {
    let mut game = started(BOTH, &[3, 3]);
    own(&mut game, 3, "p1", 0);
    own(&mut game, 5, "p1", 0);
    // p1 owns 260 more: p0 does not lead, and pays the base rent.
    game.players[0].position = 0;
    assert_eq!(game.rent_due("p0", 3, 3, crate::RentMod::Normal), 5);
    // p1's Festival: double on its cities, not on its station.
    game.tickets.as_mut().unwrap().festival.push("p1".into());
    assert_eq!(game.rent_due("p0", 3, 3, crate::RentMod::Normal), 10);
    assert_eq!(game.rent_due("p0", 5, 5, crate::RentMod::Normal), game.rent_for(5, 5, crate::RentMod::Normal));
    // p0 leads as well: triple. A tie is no lead.
    game.players[0].cash += 260;
    assert!(!game.leads("p0") && !game.leads("p1"));
    game.players[0].cash += 1;
    assert!(game.leads("p0"));
    assert_eq!(game.rent_due("p0", 3, 3, crate::RentMod::Normal), 15);
    let before = cash(&game, "p1");
    act(&mut game, "p0", Action::Roll, &[1, 2]).unwrap();
    assert_eq!(cash(&game, "p1"), before + 15);
    assert!(game.log.contains(&Event::Raised { player: "p0".into(), square: 3, festival: true, leader: true }));
    // The Festival ends when p1's turn starts; p1 may then play the one it holds.
    act(&mut game, "p0", Action::End, &[]).unwrap();
    assert!(game.tickets.as_ref().unwrap().festival.is_empty());
    act(&mut game, "p1", Action::Festival, &[]).unwrap();
    assert_eq!(act(&mut game, "p1", Action::Festival, &[]), Err(EngineError::NoTicket));
    assert_eq!(game.tickets.as_ref().unwrap().festival, ["p1"]);
}

#[test]
fn a_takeover_buys_the_city_stood_on_for_twice_its_price() {
    let mut game = started(BOTH, &[2, 2]);
    own(&mut game, 3, "p1", 1);
    assert_eq!(act(&mut game, "p0", Action::Takeover, &[]), Err(EngineError::WrongStage));
    act(&mut game, "p0", Action::Roll, &[1, 2]).unwrap();
    assert_eq!(act(&mut game, "p0", Action::Takeover, &[]), Err(EngineError::NotAllowed), "a house stands on it");
    game.props.get_mut(&3).unwrap().houses = 0;
    game.players[0].cash = 119;
    assert_eq!(act(&mut game, "p0", Action::Takeover, &[]), Err(EngineError::NotEnoughCash));
    game.players[0].cash = 500;
    let before = cash(&game, "p1");
    act(&mut game, "p0", Action::Takeover, &[]).unwrap();
    assert_eq!((cash(&game, "p0"), cash(&game, "p1")), (380, before + 120));
    assert_eq!(game.props[&3].owner, "p0");
    assert!(game.tickets_of("p0").is_empty());
    assert_eq!(act(&mut game, "p0", Action::Takeover, &[]), Err(EngineError::NoTicket));
    assert_eq!(game.stage, Stage::End);
}

#[test]
fn a_bankrupt_player_loses_tickets_and_festival() {
    let mut game = started(BOTH, &[3, 0]);
    act(&mut game, "p0", Action::Festival, &[]).unwrap();
    hold(&mut game, "p0", &[Ticket::Waiver, Ticket::Steps]);
    let mut three = Game::new(Rules::default(), vec!["p0".into(), "p1".into(), "p2".into()]).with_extras(BOTH);
    three.apply(None, Action::Start, &mut Script::new(&[2, 1, 3, 0, 0])).unwrap();
    three.apply(Some("p0"), Action::Festival, &mut Script::new(&[])).unwrap();
    three.apply(Some("p0"), Action::Resign, &mut Script::new(&[])).unwrap();
    assert!(three.tickets_of("p0").is_empty());
    assert!(three.tickets.as_ref().unwrap().festival.is_empty());
    assert!(game.tickets.as_ref().unwrap().festival.contains(&"p0".to_string()));
}
