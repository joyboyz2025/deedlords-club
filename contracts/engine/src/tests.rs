//! Unit tests. Ported from `tests/co-ty-phu.test.ts` (adjusted for cards drawn with replacement and the capitals board;
//! trades, lobby settings, time limit and `removeAbsent` are not ported), plus Blitz, `maxRounds`, formulas and Rng order.

use std::collections::{BTreeSet, VecDeque};

use serde_json::json;

use crate::board::{
    self, blitz_house_value, cards, city_rents, group_squares, house_cost, redeem_price, CardEffect, Deck, Square, CHANCE, CHEST, GROUPS,
    JAIL, OWNABLE, SQUARES, START_CASH,
};
use crate::{Action, EngineError, Event, Game, Owned, Payee, Phase, Reason, RentMod, Rng, Rules, Stage};

// ----- Helpers -------------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq)]
enum Call {
    Die(u8),
    /// `below(n)` returning the value.
    Below(u32, u32),
}
use Call::{Below, Die};

/// Scripted Rng: hands out the queued values in order and panics when the engine asks for anything else.
struct Script(VecDeque<Call>);

impl Script {
    fn new(calls: &[Call]) -> Self {
        Script(calls.iter().copied().collect())
    }
    fn none() -> Self {
        Script(VecDeque::new())
    }
    /// Fisher–Yates values that keep a list of `len` in place.
    fn identity(len: usize) -> Vec<Call> {
        (1..len as u32).rev().map(|i| Below(i + 1, i)).collect()
    }
    fn assert_done(&self) {
        assert!(self.0.is_empty(), "the engine did not use these Rng values: {:?}", self.0);
    }
}

impl Rng for Script {
    fn die(&mut self) -> u8 {
        match self.0.pop_front() {
            Some(Die(v)) => v,
            other => panic!("engine asked die(), script has {other:?}"),
        }
    }
    fn below(&mut self, n: u32) -> u32 {
        match self.0.pop_front() {
            Some(Below(m, v)) if m == n => v,
            other => panic!("engine asked below({n}), script has {other:?}"),
        }
    }
}

/// Records every call and answers from an LCG.
struct Recorder {
    calls: Vec<(char, u32)>,
    values: VecDeque<u32>,
}

impl Rng for Recorder {
    fn die(&mut self) -> u8 {
        self.calls.push(('d', 6));
        self.values.pop_front().unwrap_or(1) as u8
    }
    fn below(&mut self, n: u32) -> u32 {
        self.calls.push(('b', n));
        self.values.pop_front().unwrap_or(0)
    }
}

/// Deterministic pseudo-random numbers for the bot games (decisions and dice).
struct Lcg(u64);

impl Lcg {
    fn pick(&mut self, n: u32) -> u32 {
        self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        ((self.0 >> 33) % u64::from(n)) as u32
    }
    fn chance(&mut self, percent: u32) -> bool {
        self.pick(100) < percent
    }
}

impl Rng for Lcg {
    fn die(&mut self) -> u8 {
        self.pick(6) as u8 + 1
    }
    fn below(&mut self, n: u32) -> u32 {
        self.pick(n)
    }
}

fn ids(count: usize) -> Vec<String> {
    (0..count).map(|i| format!("p{i}")).collect()
}

/// A started game whose turn order is the seating order (and, in Blitz, an unshuffled deal).
fn started_with(rules: Rules, count: usize) -> Game {
    let mut game = Game::new(rules, ids(count));
    let mut calls = Script::identity(count.min(6));
    if rules.blitz {
        calls.extend(Script::identity(OWNABLE.len()));
    }
    let mut rng = Script::new(&calls);
    game.apply(None, Action::Start, &mut rng).unwrap();
    rng.assert_done();
    game
}

fn started(count: usize) -> Game {
    started_with(Rules::default(), count)
}

fn blitz_rules() -> Rules {
    Rules { blitz: true, cash: 2000, ..Rules::default() }
}

/// An action that must not touch the Rng.
fn act(game: &mut Game, id: &str, action: Action) -> Result<(), EngineError> {
    game.apply(Some(id), action, &mut Script::none())
}

/// The current player rolls, consuming exactly `calls`. Returns who rolled.
fn roll(game: &mut Game, calls: &[Call]) -> String {
    let mover = game.current_player().unwrap().to_string();
    let mut rng = Script::new(calls);
    game.apply(Some(&mover), Action::Roll, &mut rng).unwrap();
    rng.assert_done();
    mover
}

fn roll_as(game: &mut Game, a: u8, b: u8) -> String {
    roll(game, &[Die(a), Die(b)])
}

/// Makes the current player stop exactly on `square` with a 1-2 (no doubles, so no extra roll).
fn stop_at(game: &mut Game, square: u8) -> String {
    let p = index(game, game.current_player().unwrap());
    game.players[p].position = (square + 37) % 40;
    roll_as(game, 1, 2)
}

fn index(game: &Game, id: &str) -> usize {
    game.players.iter().position(|p| p.id == id).unwrap()
}

/// Gives squares to a player without buying.
fn give(game: &mut Game, id: &str, squares: &[u8]) {
    for &i in squares {
        game.props.insert(i, Owned { owner: id.to_string(), houses: 0, mortgaged: false });
    }
}

/// Sets a player's cash, keeping `minted` equal to the sum of cash.
fn set_cash(game: &mut Game, p: usize, cash: i64) {
    game.minted += cash - game.players[p].cash;
    game.players[p].cash = cash;
}

fn cash_sum(game: &Game) -> i64 {
    game.players.iter().map(|p| p.cash).sum()
}

/// The index of the first card with this effect.
fn card(deck: Deck, effect: CardEffect) -> u32 {
    cards(deck).iter().position(|c| *c == effect).unwrap_or_else(|| panic!("no {effect:?} in {deck:?}")) as u32
}

fn draw(deck: Deck, effect: CardEffect) -> Call {
    Below(cards(deck).len() as u32, card(deck, effect))
}

// ----- Board and formulas --------------------------------------------------------------------------------------------

#[test]
fn board_has_40_squares_8_groups_4_stations_2_utilities() {
    assert_eq!(SQUARES.len(), 40);
    assert_eq!(GROUPS.iter().map(|g| g.len()).collect::<Vec<_>>(), [2, 3, 3, 3, 3, 3, 3, 2]);
    assert_eq!(SQUARES.iter().filter(|s| matches!(s, Square::Station { .. })).count(), 4);
    assert_eq!(SQUARES.iter().filter(|s| matches!(s, Square::Utility { .. })).count(), 2);
    assert_eq!(SQUARES[usize::from(JAIL)], Square::Jail);
    assert_eq!(SQUARES[30], Square::Arrest);
    for group in 0..GROUPS.len() as u8 {
        let prices: Vec<i64> = group_squares(group).iter().map(|&i| board::price(i).unwrap()).collect();
        let mut sorted = prices.clone();
        sorted.sort();
        assert_eq!(prices, sorted, "within a group a later city is never cheaper");
    }
    assert_eq!(city_rents(60), [5, 30, 90, 180, 240, 300]);
    assert_eq!(city_rents(400), [40, 200, 600, 1200, 1600, 2000]);
    assert_eq!(OWNABLE.len(), 28);
    assert!(OWNABLE.windows(2).all(|w| w[0] < w[1]));
    assert_eq!(CHANCE.len(), 14);
    assert_eq!(CHEST.len(), 14);
    for deck in [Deck::Chance, Deck::Chest] {
        assert_eq!(cards(deck).iter().filter(|c| **c == CardEffect::Free).count(), 1);
    }
}

#[test]
#[allow(clippy::float_arithmetic)]
fn city_rent_formula_matches_ts_rounding_for_every_price() {
    // TS: Math.round(price * x / 5) * 5 with x = [0.1, 0.5, 1.5, 3, 4, 5]; Math.round(v) = floor(v + 0.5).
    let ts = |price: i64| [0.1, 0.5, 1.5, 3.0, 4.0, 5.0].map(|x: f64| ((price as f64 * x / 5.0) + 0.5).floor() as i64 * 5);
    let mut seen = BTreeSet::new();
    for square in &SQUARES {
        if let Square::City { price, .. } = *square {
            assert_eq!(city_rents(price), ts(price), "price {price}");
            seen.insert(price);
        }
    }
    assert_eq!(seen.len(), 15, "every distinct city price was checked");
    // The full table for this board (bare, 1-4 houses, hotel).
    let table: [(i64, [i64; 6]); 15] = [
        (60, [5, 30, 90, 180, 240, 300]),
        (100, [10, 50, 150, 300, 400, 500]),
        (120, [10, 60, 180, 360, 480, 600]),
        (140, [15, 70, 210, 420, 560, 700]),
        (160, [15, 80, 240, 480, 640, 800]),
        (180, [20, 90, 270, 540, 720, 900]),
        (200, [20, 100, 300, 600, 800, 1000]),
        (220, [20, 110, 330, 660, 880, 1100]),
        (240, [25, 120, 360, 720, 960, 1200]),
        (260, [25, 130, 390, 780, 1040, 1300]),
        (280, [30, 140, 420, 840, 1120, 1400]),
        (300, [30, 150, 450, 900, 1200, 1500]),
        (320, [30, 160, 480, 960, 1280, 1600]),
        (350, [35, 175, 525, 1050, 1400, 1750]),
        (400, [40, 200, 600, 1200, 1600, 2000]),
    ];
    for (price, rents) in table {
        assert!(seen.contains(&price));
        assert_eq!(city_rents(price), rents, "price {price}");
    }
    // Any other price the board might get later.
    for price in 1..=2000 {
        assert_eq!(city_rents(price), ts(price), "price {price}");
    }
}

#[test]
#[allow(clippy::float_arithmetic)]
fn house_cost_redeem_price_and_blitz_house_value() {
    assert_eq!([1, 11, 21, 31].map(house_cost), [50, 100, 150, 200]);
    assert_eq!([1, 11, 21, 31].map(blitz_house_value), [37, 75, 112, 150]);
    for &i in &OWNABLE {
        let price = board::price(i).unwrap();
        assert_eq!(redeem_price(i), (price as f64 * 11.0 / 20.0).ceil() as i64, "square {i}");
    }
    assert_eq!(redeem_price(39), 220);
    assert_eq!(redeem_price(37), 193);
    assert_eq!(redeem_price(12), 83);
    assert_eq!(redeem_price(0), 0);
}

// ----- Start and randomness ------------------------------------------------------------------------------------------

#[test]
fn two_to_six_players_seventh_and_later_only_watch() {
    let mut game = Game::new(Rules::default(), ids(8));
    let mut rng = Script::new(&Script::identity(6));
    game.apply(None, Action::Start, &mut rng).unwrap();
    rng.assert_done();
    assert_eq!(game.phase, Phase::Playing);
    assert_eq!(game.order, ids(6));
    assert_eq!(game.players[6].cash, 0);
    assert_eq!(game.players[7].cash, 0);
    assert_eq!(cash_sum(&game), START_CASH * 6);
    assert_eq!(game.minted, START_CASH * 6);
    assert_eq!(game.apply(None, Action::Start, &mut Script::none()), Err(EngineError::NotInLobby));

    let mut lonely = Game::new(Rules::default(), vec!["a".into()]);
    assert_eq!(lonely.apply(None, Action::Start, &mut Script::none()), Err(EngineError::NotEnoughPlayers));
    assert_eq!(lonely.phase, Phase::Lobby, "one player cannot start");
}

#[test]
fn fisher_yates_turn_order_uses_below_i_plus_1_from_the_end() {
    let mut rng = Recorder { calls: Vec::new(), values: [2, 0, 1].into() };
    let mut game = Game::new(Rules::default(), ids(4));
    game.apply(None, Action::Start, &mut rng).unwrap();
    assert_eq!(rng.calls, [('b', 4), ('b', 3), ('b', 2)]);
    // [p0,p1,p2,p3] -> swap(3,2) -> [p0,p1,p3,p2] -> swap(2,0) -> [p3,p1,p0,p2] -> swap(1,1)
    assert_eq!(game.order, ["p3", "p1", "p0", "p2"]);
    assert_eq!(game.current_player(), Some("p3"));

    // Blitz: the 28 ownable squares are shuffled after the turn order, with the same loop.
    let mut rng = Recorder { calls: Vec::new(), values: VecDeque::new() };
    let mut game = Game::new(blitz_rules(), ids(2));
    game.apply(None, Action::Start, &mut rng).unwrap();
    let expected: Vec<(char, u32)> = std::iter::once(('b', 2)).chain((2..=28).rev().map(|n| ('b', n))).collect();
    assert_eq!(rng.calls, expected);
}

#[test]
fn snapshot_has_exactly_the_engine_rules_fields() {
    let mut game = started(2);
    roll_as(&mut game, 3, 3);
    act(&mut game, "p0", Action::Buy).unwrap();
    let player = |id: &str, cash: i64, position: u8| json!({ "id": id, "cash": cash, "position": position, "jail": null, "freeCards": [], "bankrupt": false, "outAt": null });
    assert_eq!(
        game.snapshot(),
        json!({
            "phase": "playing", "order": ["p0", "p1"], "turn": 0, "stage": "end", "dice": [3, 3], "doubles": 1, "again": true,
            "round": 0, "props": { "6": { "owner": "p0", "houses": 0, "mortgaged": false } }, "debt": null, "pendingMove": null,
            "card": null, "buildAt": null, "builtThisTurn": [], "minted": 2900, "rolls": 1, "result": null,
            "players": [player("p0", 1400, 6), player("p1", 1500, 0)]
        })
    );

    // Debt, card and jail formats; the deck order (gone anyway), the log and the rules are never in the snapshot.
    let mut game = started(2);
    set_cash(&mut game, 0, 10);
    roll(&mut game, &[Die(1), Die(1), draw(Deck::Chest, CardEffect::Money { amount: -50 })]);
    let snap = game.snapshot();
    assert_eq!(snap["debt"], json!([{ "id": null, "amount": 50 }]));
    assert_eq!(snap["card"], json!({ "deck": "chest", "index": 6 }));
    assert_eq!(snap["stage"], json!("debt"));
    // Sorted on both sides: the key order of a serde_json map depends on the `preserve_order` feature, which another
    // workspace member's dependencies can switch on.
    let mut keys: Vec<&str> = snap.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort();
    let mut expected = vec![
        "phase",
        "order",
        "turn",
        "stage",
        "dice",
        "doubles",
        "again",
        "round",
        "props",
        "debt",
        "pendingMove",
        "card",
        "buildAt",
        "builtThisTurn",
        "minted",
        "rolls",
        "result",
        "players",
    ];
    expected.sort();
    assert_eq!(keys, expected);

    // The lobby snapshot.
    let lobby = Game::new(Rules::default(), ids(2)).snapshot();
    assert_eq!(lobby["phase"], json!("lobby"));
    assert_eq!(lobby["order"], json!([]));
    assert_eq!(lobby["players"][1], player("p1", 0, 0));
}

// ----- Moving, buying, rent ------------------------------------------------------------------------------------------

#[test]
fn rolling_moves_and_passing_departure_pays_the_salary() {
    let mut game = started(3);
    roll_as(&mut game, 2, 3);
    assert_eq!(game.players[0].position, 5);
    assert_eq!(game.stage, Stage::Buy);
    act(&mut game, "p0", Action::Skip).unwrap();
    act(&mut game, "p0", Action::End).unwrap();
    assert_eq!(game.current_player(), Some("p1"));
    game.players[1].position = 38;
    roll_as(&mut game, 1, 2);
    assert_eq!(game.players[1].position, 1);
    assert_eq!(game.players[1].cash, START_CASH + 200);
    assert!(game.log.contains(&Event::Salary { player: "p1".into(), amount: 200 }));
}

#[test]
fn only_the_current_player_acts_and_only_at_the_right_stage() {
    let mut game = started(3);
    assert_eq!(act(&mut game, "p1", Action::Roll), Err(EngineError::NotYourTurn));
    assert_eq!(game.apply(None, Action::Roll, &mut Script::none()), Err(EngineError::NotYourTurn));
    assert_eq!(game.rolls, 0);
    assert_eq!(act(&mut game, "p0", Action::End), Err(EngineError::WrongStage), "cannot end before rolling");
    assert_eq!(game.current_player(), Some("p0"));
    roll_as(&mut game, 1, 2);
    assert_eq!(act(&mut game, "p0", Action::Roll), Err(EngineError::WrongStage), "no doubles, no second roll");
    assert_eq!(game.rolls, 1);
}

#[test]
fn buying_costs_the_price_and_needs_the_cash_skipping_leaves_it_unowned() {
    let mut game = started(3);
    let an = roll_as(&mut game, 1, 2);
    act(&mut game, &an, Action::Buy).unwrap();
    assert_eq!(game.props[&3].owner, an);
    assert_eq!(game.players[0].cash, START_CASH - 60);
    act(&mut game, &an, Action::End).unwrap();
    set_cash(&mut game, 1, 50);
    roll_as(&mut game, 3, 3);
    assert_eq!(act(&mut game, "p1", Action::Buy), Err(EngineError::NotEnoughCash));
    assert!(!game.props.contains_key(&6));
    assert_eq!(game.stage, Stage::Buy);
    act(&mut game, "p1", Action::Skip).unwrap();
    assert!(!game.props.contains_key(&6));
    assert_eq!(cash_sum(&game), game.minted);
}

#[test]
fn city_rent_doubles_with_the_whole_group_follows_houses_and_is_zero_when_mortgaged() {
    let mut game = started(3);
    give(&mut game, "p1", &[1]);
    assert_eq!(game.rent_for(1, 7, RentMod::Normal), 5);
    give(&mut game, "p1", &[3]);
    assert_eq!(game.rent_for(1, 7, RentMod::Normal), 10, "whole South America group");
    game.props.get_mut(&1).unwrap().houses = 2;
    assert_eq!(game.rent_for(1, 7, RentMod::Normal), 90);
    game.props.get_mut(&1).unwrap().houses = 0;
    game.props.get_mut(&3).unwrap().mortgaged = true;
    assert_eq!(game.rent_for(3, 7, RentMod::Normal), 0);
    assert_eq!(game.rent_for(1, 7, RentMod::Normal), 10, "a mortgaged square still completes the group");

    game.players[0].position = 38;
    roll_as(&mut game, 1, 2);
    assert_eq!(game.players[0].position, 1);
    assert_eq!(game.players[0].cash, START_CASH + 200 - 10);
    assert_eq!(game.players[1].cash, START_CASH + 10);
    assert_eq!(game.stage, Stage::End);
    assert_eq!(cash_sum(&game), game.minted);
}

#[test]
fn station_rent_counts_stations_utility_rent_counts_the_dice() {
    let mut game = started(3);
    give(&mut game, "p1", &[5, 15]);
    assert_eq!(game.rent_for(5, 7, RentMod::Normal), 50);
    assert_eq!(game.rent_for(5, 7, RentMod::DoubleStation), 100);
    give(&mut game, "p1", &[25, 35]);
    assert_eq!(game.rent_for(5, 7, RentMod::Normal), 200);
    give(&mut game, "p2", &[12]);
    assert_eq!(game.rent_for(12, 7, RentMod::Normal), 28);
    assert_eq!(game.rent_for(12, 7, RentMod::UtilityTen), 70);
    give(&mut game, "p2", &[28]);
    assert_eq!(game.rent_for(12, 7, RentMod::Normal), 70);
}

#[test]
fn rules_salary_and_starting_cash_are_used() {
    let mut game = started_with(Rules { salary: 700, ..Rules::default() }, 2);
    game.players[0].position = 38;
    roll_as(&mut game, 1, 2);
    assert_eq!(game.players[0].cash, START_CASH + 700);
    assert!(game.log.contains(&Event::Salary { player: "p0".into(), amount: 700 }));
    assert_eq!(cash_sum(&game), game.minted);

    let game = started_with(Rules { cash: 3000, ..Rules::default() }, 3);
    assert!(game.players.iter().all(|p| p.cash == 3000));
    assert_eq!(game.minted, 9000);
}

#[test]
fn auto_rolls_skips_buying_rolls_again_after_doubles_and_ends_the_turn_but_never_acts_in_debt() {
    let mut game = started(3);
    let mut rng = Script::new(&[Die(1), Die(2)]);
    game.apply(None, Action::Auto, &mut rng).unwrap();
    rng.assert_done();
    assert_eq!(game.rolls, 1);
    assert!(game.log.contains(&Event::Auto { player: "p0".into() }));

    // Asked to buy: skip, the square stays unowned and the cash unchanged.
    game.turn = 0;
    game.stage = Stage::Buy;
    game.again = false;
    game.players[0].position = 1;
    let cash = game.players[0].cash;
    game.apply(Some("p2"), Action::Auto, &mut Script::none()).unwrap();
    assert_eq!(game.stage, Stage::End);
    assert!(!game.props.contains_key(&1));
    assert_eq!(game.players[0].cash, cash);

    game.again = true;
    let rolls = game.rolls;
    let mut rng = Script::new(&[Die(2), Die(3)]);
    game.apply(None, Action::Auto, &mut rng).unwrap();
    rng.assert_done();
    assert_eq!(game.rolls, rolls + 1, "rolls again after doubles");

    game.stage = Stage::End;
    game.again = false;
    game.apply(None, Action::Auto, &mut Script::none()).unwrap();
    assert_eq!(game.current_player(), Some("p1"), "moved: the turn ends");
    assert_eq!(game.stage, Stage::Roll);

    game.stage = Stage::Debt;
    game.debt = Some(vec![Payee { id: None, amount: 99_999 }]);
    let before = game.clone();
    assert_eq!(game.apply(None, Action::Auto, &mut Script::none()), Err(EngineError::WrongStage), "never acts in debt");
    assert_eq!(game, before);
    assert_eq!(cash_sum(&game), game.minted);
}

// ----- Houses and mortgages ------------------------------------------------------------------------------------------

#[test]
fn classic_build_only_after_stopping_on_your_own_city_one_house_per_stop_up_to_a_hotel() {
    let mut game = started(2);
    // p1 stops on the jail square (just visiting) every turn, away from p0's cities.
    let other_turn = |game: &mut Game| {
        act(game, "p0", Action::End).unwrap();
        stop_at(game, 10);
        act(game, "p1", Action::End).unwrap();
    };
    stop_at(&mut game, 6);
    assert_eq!(game.stage, Stage::Buy);
    act(&mut game, "p0", Action::Buy).unwrap();
    assert!(game.check(Some("p0"), Action::Build(6)).is_err(), "buying is not stopping");
    give(&mut game, "p0", &[8]);
    for houses in 1..=5 {
        other_turn(&mut game);
        stop_at(&mut game, 6);
        assert_eq!(game.build_at, Some(6));
        assert!(game.check(Some("p0"), Action::Build(8)).is_err(), "only where you stopped");
        assert!(game.check(Some("p1"), Action::Build(6)).is_err(), "not on someone else's city");
        act(&mut game, "p0", Action::Build(6)).unwrap();
        assert_eq!(game.build_at, None);
        assert!(act(&mut game, "p0", Action::Build(6)).is_err());
        assert_eq!(game.props[&6].houses, houses, "one house per stop, the fifth is a hotel");
    }
    other_turn(&mut game);
    stop_at(&mut game, 6);
    assert!(game.check(Some("p0"), Action::Build(6)).is_err(), "a hotel is the maximum");
    assert_eq!(game.players[0].cash, START_CASH - 100 - 5 * house_cost(6));
    assert!(game.built_this_turn.is_empty(), "classic rules never fill builtThisTurn");

    // Not on a mortgaged city, not while in debt.
    game.props.get_mut(&8).unwrap().mortgaged = true;
    other_turn(&mut game);
    stop_at(&mut game, 8);
    assert_eq!(game.build_at, None);
    assert!(game.check(Some("p0"), Action::Build(8)).is_err(), "mortgaged");
    game.props.get_mut(&8).unwrap().mortgaged = false;
    other_turn(&mut game);
    stop_at(&mut game, 8);
    game.stage = Stage::Debt;
    assert_eq!(game.check(Some("p0"), Action::Build(8)), Err(EngineError::WrongStage), "in debt");
    game.stage = Stage::End;
    assert_eq!(game.check(Some("p0"), Action::Build(8)), Ok(()));

    // Sell a house anywhere for half; no mortgage while the square has houses.
    let cash = game.players[0].cash;
    act(&mut game, "p0", Action::Sell(6)).unwrap();
    assert_eq!(game.props[&6].houses, 4);
    assert_eq!(game.players[0].cash, cash + house_cost(6) / 2);
    assert!(game.check(Some("p1"), Action::Sell(6)).is_err(), "not someone else's house");
    assert!(game.check(Some("p0"), Action::Mortgage(6)).is_err(), "houses first");
    assert_eq!(game.check(Some("p0"), Action::Mortgage(8)), Ok(()), "a group-mate without houses can be mortgaged");
    assert_eq!(cash_sum(&game), game.minted);
}

#[test]
fn mortgage_pays_half_redeem_costs_ten_percent_more() {
    let mut game = started(3);
    give(&mut game, "p0", &[39]);
    act(&mut game, "p0", Action::Mortgage(39)).unwrap();
    assert_eq!(game.players[0].cash, START_CASH + 200);
    assert!(act(&mut game, "p0", Action::Mortgage(39)).is_err(), "already mortgaged");
    act(&mut game, "p0", Action::Redeem(39)).unwrap();
    assert_eq!(game.players[0].cash, START_CASH - 20);
    assert!(!game.props[&39].mortgaged);
    assert!(act(&mut game, "p1", Action::Redeem(39)).is_err());
    assert!(act(&mut game, "p1", Action::Mortgage(39)).is_err());
    assert!(!game.props[&39].mortgaged, "someone else's square is untouchable");
    // Selling, mortgaging and redeeming work outside your turn.
    give(&mut game, "p2", &[37]);
    act(&mut game, "p2", Action::Mortgage(37)).unwrap();
    set_cash(&mut game, 2, 192);
    assert_eq!(act(&mut game, "p2", Action::Redeem(37)), Err(EngineError::NotEnoughCash));
    set_cash(&mut game, 2, 193);
    act(&mut game, "p2", Action::Redeem(37)).unwrap();
    assert_eq!(game.players[2].cash, 0);
    assert_eq!(act(&mut game, "p2", Action::Mortgage(10)), Err(EngineError::BadSquare));
    assert_eq!(act(&mut game, "p2", Action::Mortgage(200)), Err(EngineError::BadSquare));
    assert_eq!(act(&mut game, "nobody", Action::Mortgage(37)), Err(EngineError::UnknownPlayer));
    assert_eq!(cash_sum(&game), game.minted);
}

// ----- Doubles and jail ----------------------------------------------------------------------------------------------

#[test]
fn doubles_roll_again_and_three_in_a_row_go_to_jail() {
    let mut game = started(3);
    let an = roll(&mut game, &[Die(1), Die(1), draw(Deck::Chest, CardEffect::Money { amount: 10 })]);
    assert!(game.again);
    assert!(act(&mut game, &an, Action::Skip).is_err());
    assert!(act(&mut game, &an, Action::End).is_err());
    assert_eq!(game.current_player(), Some(an.as_str()), "rolling again, the turn is not over");
    roll_as(&mut game, 2, 2);
    assert_eq!(game.stage, Stage::Buy);
    act(&mut game, &an, Action::Skip).unwrap();
    roll_as(&mut game, 3, 3);
    assert_eq!(game.players[0].position, JAIL);
    assert_eq!(game.players[0].jail, Some(0));
    assert!(!game.again);
    assert_eq!(game.doubles, 3);
    act(&mut game, &an, Action::End).unwrap();
    assert_eq!(game.current_player(), Some("p1"));
    assert_eq!(game.doubles, 0);
}

#[test]
fn jail_doubles_get_out_without_another_roll_third_failure_pays_the_fine_and_moves() {
    let mut game = started(2);
    game.players[0].position = JAIL;
    game.players[0].jail = Some(0);
    roll_as(&mut game, 1, 2);
    assert_eq!(game.players[0].position, JAIL);
    assert_eq!(game.players[0].jail, Some(1));
    act(&mut game, "p0", Action::End).unwrap();
    roll_as(&mut game, 1, 2);
    act(&mut game, "p1", Action::Skip).unwrap();
    act(&mut game, "p1", Action::End).unwrap();
    roll_as(&mut game, 4, 4);
    assert_eq!(game.players[0].jail, None);
    assert_eq!(game.players[0].position, 18);
    assert!(!game.again);
    assert_eq!(game.doubles, 0, "doubles in jail do not count");

    let mut other = started(2);
    other.players[0].position = JAIL;
    other.players[0].jail = Some(2);
    roll_as(&mut other, 1, 3);
    assert_eq!(other.players[0].jail, None);
    assert_eq!(other.players[0].position, 14);
    assert_eq!(other.players[0].cash, START_CASH - 50);
}

#[test]
fn third_failure_without_the_fine_waits_for_the_debt_then_moves_and_may_draw_a_card() {
    let mut game = started(2);
    give(&mut game, "p0", &[39]);
    game.players[0].position = JAIL;
    game.players[0].jail = Some(2);
    set_cash(&mut game, 0, 30);
    roll_as(&mut game, 3, 4);
    assert_eq!(game.stage, Stage::Debt);
    assert_eq!(game.debt, Some(vec![Payee { id: None, amount: 50 }]));
    assert_eq!(game.pending_move, Some(7));
    assert_eq!(game.players[0].position, JAIL);
    assert_eq!(game.players[0].jail, None);
    act(&mut game, "p0", Action::Mortgage(39)).unwrap();
    // Paying moves the pending 7 squares onto a Souvenir square: the card is drawn inside `pay`.
    let mut rng = Script::new(&[draw(Deck::Chest, CardEffect::Money { amount: 200 })]);
    game.apply(Some("p0"), Action::Pay, &mut rng).unwrap();
    rng.assert_done();
    assert_eq!(game.players[0].position, 17);
    assert_eq!(game.pending_move, None);
    assert_eq!(game.players[0].cash, 30 + 200 - 50 + 200);
    assert_eq!(game.stage, Stage::End);
    assert_eq!(cash_sum(&game), game.minted);
}

#[test]
fn bail_or_a_free_card_gets_out_before_rolling() {
    let mut game = started(2);
    assert_eq!(act(&mut game, "p0", Action::Bail), Err(EngineError::WrongStage), "not in jail");
    game.players[0].position = JAIL;
    game.players[0].jail = Some(0);
    assert_eq!(act(&mut game, "p0", Action::Card), Err(EngineError::NoFreeCard));
    act(&mut game, "p0", Action::Bail).unwrap();
    assert_eq!(game.players[0].jail, None);
    assert_eq!(game.players[0].cash, START_CASH - 50);
    assert_eq!(cash_sum(&game), game.minted);

    let mut other = started(2);
    other.players[0].position = JAIL;
    other.players[0].jail = Some(1);
    other.players[0].free_cards = vec![Deck::Chest, Deck::Chance];
    act(&mut other, "p0", Action::Card).unwrap();
    assert_eq!(other.players[0].jail, None);
    assert_eq!(other.players[0].free_cards, [Deck::Chance], "the first card is used, nothing goes back to a deck");
}

// ----- Cards ---------------------------------------------------------------------------------------------------------

#[test]
fn cards_goto_back_nearest_station_double_jail_and_free() {
    let mut game = started(3);
    roll(&mut game, &[Die(3), Die(4), draw(Deck::Chance, CardEffect::Goto { to: 24 })]);
    assert_eq!(game.players[0].position, 24);
    assert_eq!(game.stage, Stage::Buy);
    assert_eq!(game.snapshot()["card"], json!({ "deck": "chance", "index": 1 }));
    act(&mut game, "p0", Action::Skip).unwrap();
    act(&mut game, "p0", Action::End).unwrap();
    assert_eq!(game.card, None, "the card is shown only during the drawer's turn");

    game.players[1].position = 15;
    give(&mut game, "p2", &[25]);
    roll(&mut game, &[Die(3), Die(4), draw(Deck::Chance, CardEffect::Nearest { kind: board::Nearest::Station })]);
    assert_eq!(game.players[1].position, 25);
    assert_eq!(game.players[1].cash, START_CASH - 50);
    act(&mut game, "p1", Action::End).unwrap();

    game.players[2].position = 33;
    roll(
        &mut game,
        &[Die(1), Die(2), draw(Deck::Chance, CardEffect::Back { steps: 3 }), draw(Deck::Chest, CardEffect::Money { amount: 10 })],
    );
    assert_eq!(game.players[2].position, 33, "back onto a Souvenir square draws again");
    assert_eq!(game.card, Some(crate::CardRef { deck: Deck::Chest, index: 4 }));
    act(&mut game, "p2", Action::End).unwrap();

    game.players[0].position = 0;
    roll(&mut game, &[Die(1), Die(1), draw(Deck::Chest, CardEffect::Free)]);
    assert_eq!(game.players[0].free_cards, [Deck::Chest]);
    roll(&mut game, &[Die(2), Die(3), draw(Deck::Chance, CardEffect::Jail)]);
    assert_eq!(game.players[0].position, JAIL);
    assert!(!game.again, "jail ends the turn even after doubles");
    assert_eq!(cash_sum(&game), game.minted);
}

#[test]
fn cards_are_drawn_with_replacement() {
    let mut game = started(2);
    roll(&mut game, &[Die(1), Die(1), draw(Deck::Chest, CardEffect::Free)]);
    act(&mut game, "p0", Action::Skip).unwrap_err();
    game.players[0].position = 0;
    roll(&mut game, &[Die(1), Die(1), draw(Deck::Chest, CardEffect::Free)]);
    assert_eq!(game.players[0].free_cards, [Deck::Chest, Deck::Chest], "the same card can be drawn again at once");
}

#[test]
fn cards_goto_departure_pays_salary_nearest_utility_charges_ten_times_the_dice() {
    let mut game = started(2);
    game.players[0].position = 33;
    roll(&mut game, &[Die(1), Die(2), draw(Deck::Chance, CardEffect::Goto { to: 0 })]);
    assert_eq!(game.players[0].position, 0);
    assert_eq!(game.players[0].cash, START_CASH + 200);
    act(&mut game, "p0", Action::End).unwrap();

    give(&mut game, "p0", &[28]);
    game.players[1].position = 17;
    roll(&mut game, &[Die(2), Die(3), draw(Deck::Chance, CardEffect::Nearest { kind: board::Nearest::Utility })]);
    assert_eq!(game.players[1].position, 28);
    assert_eq!(game.players[1].cash, START_CASH - 50);
    assert_eq!(cash_sum(&game), game.minted);
}

#[test]
fn card_each_collects_up_to_their_cash_or_pays_each_player() {
    let mut game = started(3);
    set_cash(&mut game, 2, 4);
    roll(&mut game, &[Die(1), Die(1), draw(Deck::Chest, CardEffect::Each { amount: 10 })]);
    assert_eq!(game.players[0].cash, START_CASH + 14, "a player short of cash gives what they have");
    assert_eq!(game.players[2].cash, 0);
    assert_eq!(cash_sum(&game), game.minted);

    let mut game = started(3);
    set_cash(&mut game, 0, 30);
    game.players[0].position = 4;
    roll(&mut game, &[Die(1), Die(2), draw(Deck::Chance, CardEffect::Each { amount: -50 })]);
    assert_eq!(game.stage, Stage::Debt);
    assert_eq!(
        game.debt,
        Some(vec![Payee { id: Some("p1".into()), amount: 50 }, Payee { id: Some("p2".into()), amount: 50 }]),
        "one payee per other player, in turn order"
    );
}

#[test]
fn card_repairs_charge_per_house_and_hotel() {
    let mut game = started(2);
    give(&mut game, "p0", &[1, 3, 39]);
    game.props.get_mut(&1).unwrap().houses = 2;
    game.props.get_mut(&39).unwrap().houses = 5;
    roll(&mut game, &[Die(1), Die(1), draw(Deck::Chest, CardEffect::Repairs { house: 40, hotel: 115 })]);
    assert_eq!(game.players[0].cash, START_CASH - 80 - 115);
    assert_eq!(cash_sum(&game), game.minted);
}

// ----- Debt and bankruptcy -------------------------------------------------------------------------------------------

#[test]
fn short_of_cash_is_a_debt_paid_after_selling_or_mortgaging() {
    let mut game = started(2);
    give(&mut game, "p1", &[39]);
    give(&mut game, "p0", &[1]);
    set_cash(&mut game, 0, 20);
    game.players[0].position = 37;
    roll_as(&mut game, 1, 1);
    assert_eq!(game.stage, Stage::Debt);
    assert_eq!(game.debt, Some(vec![Payee { id: Some("p1".into()), amount: 40 }]));
    assert!(act(&mut game, "p0", Action::End).is_err());
    assert_eq!(game.current_player(), Some("p0"), "the turn waits for the debt");
    assert_eq!(act(&mut game, "p0", Action::Pay), Err(EngineError::NotEnoughCash));
    assert_eq!(game.stage, Stage::Debt);
    act(&mut game, "p0", Action::Mortgage(1)).unwrap();
    act(&mut game, "p0", Action::Pay).unwrap();
    assert_eq!(game.stage, Stage::End);
    assert_eq!(game.debt, None);
    assert_eq!(game.players[0].cash, 10);
    assert_eq!(game.players[1].cash, START_CASH + 40);
    assert_eq!(cash_sum(&game), game.minted);
}

#[test]
fn bankrupt_to_a_player_who_takes_everything_and_the_last_player_wins() {
    let mut game = started(2);
    give(&mut game, "p0", &[6, 8, 9]);
    game.props.get_mut(&6).unwrap().houses = 1;
    game.props.get_mut(&8).unwrap().mortgaged = true;
    game.players[0].position = 37;
    game.players[0].free_cards = vec![Deck::Chance, Deck::Chest];
    game.players[1].free_cards = vec![Deck::Chest];
    set_cash(&mut game, 0, 30);
    give(&mut game, "p1", &[39]);
    game.props.get_mut(&39).unwrap().houses = 5;
    roll_as(&mut game, 1, 1);
    assert_eq!(game.stage, Stage::Debt);
    act(&mut game, "p0", Action::Bankrupt).unwrap();
    assert!(game.players[0].bankrupt);
    assert_eq!(game.players[0].out_at, Some(1));
    assert_eq!(game.players[0].cash, 0);
    assert_eq!(game.props[&6].owner, "p1");
    assert_eq!(game.props[&6].houses, 0);
    assert!(game.props[&8].mortgaged, "a mortgaged square stays mortgaged");
    assert_eq!(game.players[1].cash, START_CASH + 30 + house_cost(6) / 2);
    assert_eq!(game.players[1].free_cards, [Deck::Chest, Deck::Chance, Deck::Chest], "cards are appended in order");
    assert!(game.players[0].free_cards.is_empty());
    assert_eq!(game.phase, Phase::Ended);
    assert_eq!(game.result.as_ref().unwrap().reason, Reason::Last);
    assert_eq!(game.result.as_ref().unwrap().ranking, ["p1", "p0"]);
    assert_eq!(game.debt, None);
    assert_eq!(cash_sum(&game), game.minted);
    assert_eq!(act(&mut game, "p1", Action::Roll), Err(EngineError::NotPlaying));
}

#[test]
fn bankrupt_to_the_bank_returns_squares_drops_cards_and_passes_the_turn() {
    let mut game = started(3);
    give(&mut game, "p0", &[5]);
    game.props.get_mut(&5).unwrap().mortgaged = true;
    game.players[0].free_cards = vec![Deck::Chance];
    set_cash(&mut game, 0, 10);
    game.players[0].position = 2;
    roll_as(&mut game, 1, 1);
    assert_eq!(game.stage, Stage::Debt);
    act(&mut game, "p0", Action::Bankrupt).unwrap();
    assert!(!game.props.contains_key(&5));
    assert_eq!(game.phase, Phase::Playing);
    assert_eq!(game.current_player(), Some("p1"));
    assert_eq!(game.active_players(), ["p1", "p2"]);
    assert!(game.players.iter().all(|p| p.free_cards.is_empty()), "cards are dropped");
    assert_eq!(cash_sum(&game), game.minted);
}

#[test]
fn bankrupt_to_several_players_goes_to_the_bank() {
    let mut game = started(3);
    give(&mut game, "p0", &[1]);
    set_cash(&mut game, 0, 30);
    game.players[0].position = 4;
    roll(&mut game, &[Die(1), Die(2), draw(Deck::Chance, CardEffect::Each { amount: -50 })]);
    act(&mut game, "p0", Action::Bankrupt).unwrap();
    assert!(game.props.is_empty());
    assert_eq!(game.players[1].cash, START_CASH);
    assert_eq!(game.minted, 2 * START_CASH);
    assert_eq!(game.log.last(), Some(&Event::Bankrupt { player: "p0".into(), creditor: None }));
}

// ----- Rounds and maxRounds ------------------------------------------------------------------------------------------

fn end_turn(game: &mut Game) {
    let id = game.current_player().unwrap().to_string();
    game.stage = Stage::End;
    act(game, &id, Action::End).unwrap();
}

#[test]
fn max_rounds_ends_the_game_on_the_wrap_and_ranks_by_net_worth_with_stable_ties() {
    let mut game = started_with(Rules { max_rounds: 2, ..Rules::default() }, 3);
    give(&mut game, "p2", &[39]);
    let expected = [(1, 0), (2, 0), (0, 1), (1, 1), (2, 1)];
    for (turn, round) in expected {
        end_turn(&mut game);
        assert_eq!((game.turn, game.round), (turn, round));
        assert_eq!(game.phase, Phase::Playing);
    }
    game.card = Some(crate::CardRef { deck: Deck::Chance, index: 3 });
    end_turn(&mut game);
    assert_eq!(game.phase, Phase::Ended);
    assert_eq!(game.round, 2);
    assert_eq!(game.turn, 2, "the turn does not advance");
    assert_eq!(game.stage, Stage::End);
    assert!(game.card.is_some(), "nothing else is reset");
    let result = game.result.clone().unwrap();
    assert_eq!(result.reason, Reason::Time);
    assert_eq!(result.ranking, ["p2", "p0", "p1"], "Hanoi makes p2 richest; p0 and p1 tie and keep turn order");
    assert_eq!(game.net_worth("p2"), game.players[2].cash + 400);

    // No limit: the rounds just count.
    let mut game = started(2);
    for _ in 0..50 {
        end_turn(&mut game);
    }
    assert_eq!(game.phase, Phase::Playing);
    assert_eq!(game.round, 25);
}

#[test]
fn rounds_count_wraps_past_bankrupt_players_and_a_bankruptcy_can_end_the_last_round() {
    let mut game = started(3);
    game.players[1].bankrupt = true;
    game.players[1].out_at = Some(1);
    set_cash(&mut game, 1, 0);
    end_turn(&mut game);
    assert_eq!((game.turn, game.round), (2, 0), "p1 is skipped");
    end_turn(&mut game);
    assert_eq!((game.turn, game.round), (0, 1));

    // p2 (last in order) goes bankrupt on the final round: the wrap ends the game with reason "time".
    let mut game = started_with(Rules { max_rounds: 1, ..Rules::default() }, 3);
    end_turn(&mut game);
    end_turn(&mut game);
    assert_eq!(game.current_player(), Some("p2"));
    game.stage = Stage::Debt;
    game.debt = Some(vec![Payee { id: None, amount: 100_000 }]);
    act(&mut game, "p2", Action::Bankrupt).unwrap();
    assert_eq!(game.phase, Phase::Ended);
    assert_eq!(game.turn, 2);
    let result = game.result.clone().unwrap();
    assert_eq!(result.reason, Reason::Time);
    assert_eq!(result.ranking, ["p0", "p1", "p2"]);
    assert_eq!(game.stage, Stage::Debt, "finish does not touch the stage");
    assert_eq!(game.debt, None);

    // Bankrupt players rank last, the latest out first.
    let mut game = started(3);
    for loser in ["p0", "p1"] {
        let p = index(&game, loser);
        game.turn = game.order.iter().position(|id| id == loser).unwrap() as u8;
        game.stage = Stage::Debt;
        game.debt = Some(vec![Payee { id: None, amount: 100_000 }]);
        act(&mut game, loser, Action::Bankrupt).unwrap();
        assert!(game.players[p].bankrupt);
    }
    assert_eq!(game.result.unwrap().ranking, ["p2", "p1", "p0"]);
}

// ----- Blitz ---------------------------------------------------------------------------------------------------------

#[test]
fn blitz_deals_five_shuffled_squares_to_each_player_in_turn_order_at_list_price() {
    let mut calls = vec![Below(4, 0), Below(3, 0), Below(2, 0)];
    calls.extend(Script::identity(28));
    let mut rng = Script::new(&calls);
    let mut game = Game::new(blitz_rules(), ids(4));
    game.apply(None, Action::Start, &mut rng).unwrap();
    rng.assert_done();
    assert_eq!(game.order, ["p1", "p2", "p3", "p0"]);
    for (k, id) in game.order.iter().enumerate() {
        for i in &OWNABLE[5 * k..5 * k + 5] {
            assert_eq!(&game.props[i].owner, id, "order[{k}] gets entries [{}, {})", 5 * k, 5 * k + 5);
        }
    }
    assert_eq!(game.props.len(), 20);
    assert!(OWNABLE[20..].iter().all(|i| !game.props.contains_key(i)));
    let cash: Vec<i64> = game.players.iter().map(|p| p.cash).collect();
    assert_eq!(cash, [2000 - 1180, 2000 - 520, 2000 - 710, 2000 - 980]);
    assert_eq!(game.minted, 8000 - 3390);
    assert_eq!(cash_sum(&game), game.minted);
    assert!(game.props.values().all(|o| o.houses == 0 && !o.mortgaged));

    // A shuffled list: entries follow the shuffle, not the board order.
    let mut calls = vec![Below(2, 1), Below(28, 0)];
    calls.extend((2..27).rev().map(|i| Below(i + 1, i)));
    calls.push(Below(2, 0));
    let mut rng = Script::new(&calls);
    let mut game = Game::new(blitz_rules(), ids(2));
    game.apply(None, Action::Start, &mut rng).unwrap();
    rng.assert_done();
    let owned = |id: &str| game.props.iter().filter(|(_, o)| o.owner == id).map(|(&i, _)| i).collect::<Vec<u8>>();
    assert_eq!(owned("p0"), [3, 5, 6, 8, 39]);
    assert_eq!(owned("p1"), [9, 11, 12, 13, 14]);
    assert_eq!(game.players[0].cash, 2000 - 60 - 400 - 200 - 100 - 100);

    // Six players: 28 squares run out, the last player gets three.
    let game = started_with(blitz_rules(), 6);
    assert_eq!(game.props.len(), 28);
    assert_eq!(game.props.values().filter(|o| o.owner == "p5").count(), 3);
}

#[test]
fn blitz_build_on_any_own_city_once_per_city_per_turn() {
    let mut game = started_with(blitz_rules(), 2);
    // p0 owns 1, 3 (South America), 5 (station), 6, 8; p1 owns 9, 11, 12, 13, 14.
    assert_eq!(game.players[0].cash, 1480);
    act(&mut game, "p0", Action::Build(1)).unwrap();
    assert_eq!(game.props[&1].houses, 1);
    assert_eq!(game.players[0].cash, 1430);
    assert_eq!(game.built_this_turn, [1]);
    assert_eq!(act(&mut game, "p0", Action::Build(1)), Err(EngineError::NotAllowed), "once per city per turn");
    act(&mut game, "p0", Action::Build(3)).unwrap();
    assert_eq!(game.built_this_turn, [1, 3]);
    assert_eq!(act(&mut game, "p0", Action::Build(5)), Err(EngineError::BadSquare), "a station");
    assert_eq!(act(&mut game, "p0", Action::Build(9)), Err(EngineError::NotOwner));
    assert_eq!(act(&mut game, "p1", Action::Build(9)), Err(EngineError::NotYourTurn));
    act(&mut game, "p0", Action::Mortgage(6)).unwrap();
    assert_eq!(act(&mut game, "p0", Action::Build(6)), Err(EngineError::NotAllowed), "mortgaged");

    // Landing on an own city still sets buildAt (it is in the snapshot); any build clears it, as in TS.
    roll_as(&mut game, 4, 4);
    assert_eq!(game.players[0].position, 8);
    assert_eq!(game.build_at, Some(8));
    assert_eq!(act(&mut game, "p0", Action::Build(3)), Err(EngineError::NotAllowed));
    act(&mut game, "p0", Action::Build(1)).unwrap_err();
    act(&mut game, "p0", Action::Build(8)).unwrap();
    assert_eq!(game.build_at, None);
    assert_eq!(game.built_this_turn, [1, 3, 8]);
    roll_as(&mut game, 1, 2);
    assert_eq!(game.players[0].position, 11);
    assert_eq!(game.players[0].cash, 1480 - 150 + 50 - 30, "p1 owns all of Western Europe: Madrid rent doubles to 30");
    act(&mut game, "p0", Action::End).unwrap();
    assert!(game.built_this_turn.is_empty(), "reset at the next turn");

    act(&mut game, "p1", Action::Build(11)).unwrap();
    assert_eq!(game.built_this_turn, [11]);
    end_turn(&mut game);
    act(&mut game, "p0", Action::Build(1)).unwrap();
    assert_eq!(game.props[&1].houses, 2);

    game.stage = Stage::Debt;
    assert_eq!(game.check(Some("p0"), Action::Build(3)), Err(EngineError::WrongStage));
    game.stage = Stage::Roll;
    game.props.get_mut(&3).unwrap().houses = 5;
    assert_eq!(game.check(Some("p0"), Action::Build(3)), Err(EngineError::NotAllowed), "hotel");
    game.props.get_mut(&3).unwrap().houses = 1;
    set_cash(&mut game, 0, 49);
    assert_eq!(game.check(Some("p0"), Action::Build(3)), Err(EngineError::NotEnoughCash));
    set_cash(&mut game, 0, 50);
    assert_eq!(game.check(Some("p0"), Action::Build(3)), Ok(()));
}

#[test]
fn blitz_net_worth_counts_houses_at_three_quarters_and_decides_the_ranking() {
    let mut game = started_with(Rules { max_rounds: 1, ..blitz_rules() }, 2);
    // p0: 1, 3, 5, 6, 8 (520); p1: 9, 11, 12, 13, 14 (710).
    game.props.get_mut(&13).unwrap().houses = 5;
    game.props.get_mut(&6).unwrap().mortgaged = true;
    set_cash(&mut game, 0, 1950);
    assert_eq!(game.net_worth("p0"), 1950 + 520 - 50, "Mexico City mortgaged counts half");
    assert_eq!(game.net_worth("p1"), 1290 + 710 + 5 * 75);
    let mut classic = game.clone();
    classic.rules.blitz = false;
    assert_eq!(classic.net_worth("p1"), 1290 + 710 + 5 * 100);
    game.props.get_mut(&1).unwrap().houses = 2;
    assert_eq!(game.net_worth("p0"), 1950 + 470 + 2 * 37);
    game.props.get_mut(&1).unwrap().houses = 0;
    game.props.get_mut(&6).unwrap().mortgaged = false;

    // p0 2470 vs p1 2375 in Blitz (classic would be 2470 vs 2500).
    for game in [&mut game, &mut classic] {
        game.props.get_mut(&6).unwrap().mortgaged = false;
        end_turn(game);
        end_turn(game);
        assert_eq!(game.phase, Phase::Ended);
    }
    assert_eq!(game.result.as_ref().unwrap().ranking, ["p0", "p1"]);
    assert_eq!(classic.result.as_ref().unwrap().ranking, ["p1", "p0"]);
    assert_eq!(game.net_worth("nobody"), 0);
}

// ----- Legal actions, errors, serialization --------------------------------------------------------------------------

#[test]
fn legal_actions_at_the_start() {
    let lobby = Game::new(Rules::default(), ids(2));
    assert_eq!(lobby.legal_actions("p0"), [Action::Start]);
    let game = started(2);
    assert_eq!(game.legal_actions("p0"), [Action::Roll, Action::Auto]);
    assert_eq!(game.legal_actions("p1"), [Action::Auto]);
    let blitz = started_with(blitz_rules(), 2);
    let mut expected = vec![Action::Roll];
    expected.extend([1, 3, 6, 8].map(Action::Build));
    expected.extend([1, 3, 5, 6, 8].map(Action::Mortgage));
    expected.push(Action::Auto);
    assert_eq!(blitz.legal_actions("p0"), expected);
    assert_eq!(blitz.legal_actions("p1"), [9, 11, 12, 13, 14].map(Action::Mortgage).into_iter().chain([Action::Auto]).collect::<Vec<_>>());
}

#[test]
fn rejected_actions_change_nothing_and_use_no_randomness() {
    let mut game = started(3);
    roll_as(&mut game, 1, 2);
    let before = game.clone();
    let attempts = [
        (Some("p0"), Action::Start),
        (Some("p0"), Action::Roll),
        (Some("p1"), Action::Buy),
        (None, Action::Buy),
        (Some("p0"), Action::End),
        (Some("p0"), Action::Bail),
        (Some("p0"), Action::Card),
        (Some("p0"), Action::Pay),
        (Some("p0"), Action::Bankrupt),
        (Some("p0"), Action::Build(3)),
        (Some("p0"), Action::Sell(3)),
        (Some("p1"), Action::Mortgage(3)),
        (Some("p0"), Action::Redeem(3)),
        (Some("ghost"), Action::Skip),
        (Some("p0"), Action::Mortgage(255)),
    ];
    for (actor, action) in attempts {
        assert!(game.apply(actor, action, &mut Script::none()).is_err(), "{actor:?} {action:?}");
        assert_eq!(game, before, "{actor:?} {action:?} changed the game");
    }
}

#[test]
fn game_round_trips_through_borsh_and_serde_and_its_json_extends_the_snapshot() {
    let mut game = started_with(blitz_rules(), 3);
    act(&mut game, "p0", Action::Build(1)).unwrap();
    roll(&mut game, &[Die(1), Die(1), draw(Deck::Chest, CardEffect::Free)]);
    let bytes = borsh::to_vec(&game).unwrap();
    assert_eq!(borsh::from_slice::<Game>(&bytes).unwrap(), game);
    let value = serde_json::to_value(&game).unwrap();
    assert_eq!(serde_json::from_value::<Game>(value.clone()).unwrap(), game);
    let mut without = value.as_object().unwrap().clone();
    assert_eq!(without.remove("rules"), Some(json!({ "salary": 200, "cash": 2000, "blitz": true, "maxRounds": 0 })));
    assert!(without.remove("log").unwrap().as_array().unwrap().iter().any(|e| e["kind"] == "card"));
    assert_eq!(serde_json::Value::Object(without), game.snapshot());
}

#[test]
fn the_log_keeps_the_last_30_events() {
    let mut game = started(2);
    for _ in 0..40 {
        game.stage = Stage::End;
        game.apply(None, Action::Auto, &mut Script::none()).unwrap();
    }
    assert_eq!(game.log.len(), crate::MAX_LOG);
    assert_eq!(game.log.last(), Some(&Event::Auto { player: "p1".into() }));
}

// ----- Bot games -----------------------------------------------------------------------------------------------------

/// Applies an action and checks ENGINE-RULES §7: `Err` leaves the game (log included) unchanged and the Rng unused,
/// `Ok` changes the snapshot.
fn checked(game: &mut Game, actor: Option<&str>, action: Action, rng: &mut Lcg) -> bool {
    let before = game.clone();
    let seed = rng.0;
    let result = game.apply(actor, action, rng);
    match result {
        Err(_) => {
            assert_eq!(*game, before, "{actor:?} {action:?} failed but changed the game");
            assert_eq!(rng.0, seed, "{actor:?} {action:?} failed but used the Rng");
            false
        }
        Ok(()) => {
            let mut changed = game.clone();
            changed.log = before.log.clone();
            assert_ne!(changed, before, "{actor:?} {action:?} succeeded without changing the snapshot");
            true
        }
    }
}

/// The TS test bot: buys when it can, builds when allowed, sells and mortgages to pay debts, else goes bankrupt.
fn bot_step(game: &mut Game, r: &mut Lcg, dice: &mut Lcg) {
    let me = game.current_player().unwrap().to_string();
    let p = index(game, &me);
    let me = Some(me.as_str());
    match game.stage {
        Stage::Debt => {
            let owed: i64 = game.debt.as_ref().unwrap().iter().map(|payee| payee.amount).sum();
            let squares: Vec<u8> = game.props.keys().copied().collect();
            for &i in &squares {
                while game.players[p].cash < owed && game.check(me, Action::Sell(i)).is_ok() {
                    assert!(checked(game, me, Action::Sell(i), dice));
                }
            }
            for &i in &squares {
                if game.players[p].cash < owed && game.check(me, Action::Mortgage(i)).is_ok() {
                    assert!(checked(game, me, Action::Mortgage(i), dice));
                }
            }
            let action = if game.players[p].cash >= owed { Action::Pay } else { Action::Bankrupt };
            assert!(checked(game, me, action, dice));
        }
        Stage::Roll => {
            let jailed = game.players[p].jail.is_some();
            if jailed && !game.players[p].free_cards.is_empty() && r.chance(50) {
                assert!(checked(game, me, Action::Card, dice));
            } else if jailed && r.chance(30) {
                checked(game, me, Action::Bail, dice);
            }
            if game.rules.blitz && r.chance(30) {
                let i = OWNABLE[r.pick(OWNABLE.len() as u32) as usize];
                checked(game, me, Action::Build(i), dice);
            }
            assert!(checked(game, me, Action::Roll, dice));
        }
        Stage::Buy => {
            let affordable = board::price(game.players[p].position).is_some_and(|price| game.players[p].cash >= price);
            let action = if affordable && r.chance(90) { Action::Buy } else { Action::Skip };
            assert!(checked(game, me, action, dice));
        }
        Stage::End => {
            let squares: Vec<u8> = game.props.keys().copied().collect();
            for i in squares {
                if r.chance(70) {
                    checked(game, me, Action::Build(i), dice);
                }
                if game.props.get(&i).is_some_and(|o| o.mortgaged) && r.chance(20) {
                    checked(game, me, Action::Redeem(i), dice);
                }
            }
            let action = if game.again { Action::Roll } else { Action::End };
            assert!(checked(game, me, action, dice));
        }
    }
}

/// Any action from anyone, mostly illegal.
fn random_action(game: &mut Game, r: &mut Lcg, dice: &mut Lcg) {
    let ids: Vec<String> = game.players.iter().map(|p| p.id.clone()).collect();
    let who = r.pick(ids.len() as u32 + 2) as usize;
    let actor = match who {
        w if w < ids.len() => Some(ids[w].as_str()),
        w if w == ids.len() => Some("ghost"),
        _ => None,
    };
    let i = r.pick(45) as u8;
    let actions = [
        Action::Start,
        Action::Roll,
        Action::Buy,
        Action::Skip,
        Action::End,
        Action::Bail,
        Action::Card,
        Action::Pay,
        Action::Bankrupt,
        Action::Build(i),
        Action::Sell(i),
        Action::Mortgage(i),
        Action::Redeem(i),
        Action::Auto,
    ];
    let action = actions[r.pick(actions.len() as u32) as usize];
    checked(game, actor, action, dice);
}

fn assert_legal(game: &Game) {
    assert_eq!(cash_sum(game), game.minted, "money is never created or lost");
    for p in &game.players {
        assert!(p.cash >= 0, "{} has negative cash", p.id);
        assert!(p.position < 40);
        if p.bankrupt {
            assert_eq!(p.cash, 0);
            assert!(p.free_cards.is_empty());
        }
    }
    for (&i, owned) in &game.props {
        let square = board::square(i).unwrap();
        assert!(square.is_ownable());
        assert!(!game.player(&owned.owner).unwrap().bankrupt, "bankrupt players own nothing");
        if owned.houses > 0 {
            assert!(square.is_city(), "houses only on cities");
            assert!(!owned.mortgaged && owned.houses <= 5);
        }
    }
    if game.phase == Phase::Playing {
        assert!(!game.player(game.current_player().unwrap()).unwrap().bankrupt);
        assert_eq!(game.debt.is_some(), game.stage == Stage::Debt);
        assert!(game.pending_move.is_none() || game.stage == Stage::Debt);
    }
    if !game.rules.blitz {
        assert!(game.built_this_turn.is_empty());
    }
}

/// Port of the TS "60 random games" test: every game ends and every step is legal. Every action also checks the
/// ok-iff-changed rule, and random (mostly illegal) actions from anyone are thrown in.
#[test]
fn bots_play_60_random_games_every_game_ends_and_every_step_is_legal() {
    let mut r = Lcg(7);
    let mut dice = Lcg(12_345);
    let mut reasons = BTreeSet::new();
    let mut unfinished = 0;
    for round in 0..60 {
        let count = 2 + round % 5;
        let blitz = round % 3 == 1;
        let rules =
            Rules { blitz, cash: if blitz { 2000 } else { 1500 }, max_rounds: if round % 4 == 0 { 25 } else { 0 }, ..Rules::default() };
        let mut game = Game::new(rules, ids(count));
        assert!(checked(&mut game, None, Action::Start, &mut dice));
        for step in 0..20_000 {
            if game.phase != Phase::Playing {
                break;
            }
            bot_step(&mut game, &mut r, &mut dice);
            if game.phase == Phase::Playing && r.chance(10) {
                random_action(&mut game, &mut r, &mut dice);
            }
            if step % 500 == 0 {
                game = borsh::from_slice(&borsh::to_vec(&game).unwrap()).unwrap();
            }
            assert_legal(&game);
        }
        if game.phase == Phase::Playing {
            unfinished += 1;
            continue;
        }
        let result = game.result.clone().unwrap();
        reasons.insert(format!("{:?}", result.reason));
        assert_eq!(result.ranking.len(), count);
        if result.reason == Reason::Last {
            assert_eq!(game.active_players().len(), 1);
        }
    }
    assert_eq!(unfinished, 0, "{unfinished} games without a round limit did not end in 20,000 steps");
    assert_eq!(reasons.into_iter().collect::<Vec<_>>(), ["Last", "Time"]);
}

/// `legal_actions` is exact: it lists precisely the actions `apply` accepts (checked on clones during bot games).
#[test]
fn legal_actions_match_apply_exactly() {
    let mut r = Lcg(99);
    let mut dice = Lcg(4242);
    for round in 0..8 {
        let rules = Rules { blitz: round % 2 == 1, cash: 2000, ..Rules::default() };
        let mut game = Game::new(rules, ids(2 + round % 3));
        game.apply(None, Action::Start, &mut dice).unwrap();
        for step in 0..3000 {
            if game.phase != Phase::Playing {
                break;
            }
            if step % 13 == 0 {
                for id in game.players.iter().map(|p| p.id.clone()).chain(["ghost".to_string()]) {
                    let mut brute = Vec::new();
                    let candidates = [Action::Start, Action::Roll, Action::Buy, Action::Skip, Action::End, Action::Bail, Action::Card]
                        .into_iter()
                        .chain([Action::Pay, Action::Bankrupt])
                        .chain((0..=45).map(Action::Build))
                        .chain((0..=45).map(Action::Sell))
                        .chain((0..=45).map(Action::Mortgage))
                        .chain((0..=45).map(Action::Redeem))
                        .chain([Action::Auto]);
                    for action in candidates {
                        if game.clone().apply(Some(&id), action, &mut Lcg(step as u64)).is_ok() {
                            brute.push(action);
                        }
                    }
                    assert_eq!(game.legal_actions(&id), brute, "step {step} actor {id}");
                }
            }
            bot_step(&mut game, &mut r, &mut dice);
        }
    }
}
