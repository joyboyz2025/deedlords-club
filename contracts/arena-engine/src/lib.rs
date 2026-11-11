//! Deedlords Arena rules: the Rust port of `games/arena/engine.ts`. Same data (`shared/arena.json`, compiled in by
//! `build.rs`), same order of every step, integers only, so the two give the same match for the same plans. The JSON
//! of every type here is the JSON the TypeScript engine reads and writes.

use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    Shield,
    Dmg,
    Stun,
    Heal,
    Haste,
    Energize,
    Weaken,
    Drain,
    Ramp,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Who {
    /// "self" in `shared/arena.json`.
    Caster,
    Target,
    AllyNear,
    Allies,
    AllyWeakest,
    Weakest,
    Three,
    Farthest,
    Near,
    Around,
}

pub struct UnitDef {
    pub id: &'static str,
    pub guild: usize,
    pub role: usize,
    pub cost: i32,
    pub hp: i32,
    pub atk: i32,
    pub armor: i32,
    pub cd: i32,
    pub ranged: bool,
    pub dive: bool,
    pub every: i32,
    pub op: Op,
    pub who: Who,
    pub amount: i32,
}

include!(concat!(env!("OUT_DIR"), "/arena_data.rs"));

pub const CANAL: usize = 0;
pub const SKYPORT: usize = 1;
pub const CUSTOMS: usize = 2;
pub const GRID: usize = 3;
pub const GUARD: usize = 0;
pub const RUNNER: usize = 1;
pub const SIGNALLER: usize = 2;
pub const BROKER: usize = 3;

/// Cells of one side: `ROWS` rows of `COLS`, `cell = row * COLS + col`, row 0 nearest the enemy.
pub const CELLS: usize = (COLS * ROWS) as usize;
/// A plan names a piece by its id, or by `WON + slot` for "the unit of that market slot, if I win it".
pub const WON: u32 = 100;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct Piece {
    pub id: u32,
    pub unit: u8,
    pub rank: u8,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
#[serde(rename_all = "camelCase")]
pub struct Seat {
    pub gold: i32,
    pub points: i32,
    pub next_id: u32,
    pub pieces: Vec<Piece>,
    /// Piece id per cell, or -1.
    pub formation: [i32; CELLS],
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct Plan {
    pub sells: Vec<u32>,
    /// One per market slot: 0 for no bid, otherwise at least the unit's cost.
    pub bids: Vec<u32>,
    pub promotes: Vec<u32>,
    /// `[ref, cell]` in order of preference; `None` keeps the floor as it is.
    pub formation: Option<Vec<(u32, u8)>>,
}

impl Plan {
    /// No sells, no bids, the floor as it is: what a seat that ran out of time plays.
    pub fn empty() -> Plan {
        Plan { sells: vec![], bids: vec![0; MARKET_SIZE as usize], promotes: vec![], formation: None }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct Fielded {
    pub unit: u8,
    pub rank: u8,
    pub cell: u8,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct RoundResult {
    pub round: u8,
    pub market: Vec<u8>,
    pub bids: Vec<Vec<u32>>,
    /// Per market slot: the seat that took the unit, or -1.
    pub won: Vec<i8>,
    pub teams: Vec<Vec<Fielded>>,
    /// 0 or 1, or 2 for a draw.
    pub winner: u8,
    pub survivors: Vec<u8>,
    pub income: Vec<i32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct Match {
    pub round: u8,
    pub rounds: u8,
    pub done: bool,
    pub market: Vec<u8>,
    pub seats: Vec<Seat>,
    pub last: Option<RoundResult>,
}

fn by_round<const N: usize, T: Copy>(list: &[T; N], round: u8) -> T {
    list[usize::from(round).min(N) - 1]
}

pub fn team_cap(round: u8) -> i32 {
    by_round(&TEAM_CAP, round)
}

fn trait_bonus(at: &[i32; 2], bonus: &[i32; 2], count: i32) -> i32 {
    if count >= at[1] {
        bonus[1]
    } else if count >= at[0] {
        bonus[0]
    } else {
        0
    }
}

fn cost(unit: u8) -> i32 {
    UNITS[usize::from(unit)].cost
}

/// `below(n)` returns a uniform integer in `0..n`. Two calls per slot: the tier, then the unit within it.
pub fn draw_market(round: u8, below: &mut dyn FnMut(u32) -> u32) -> Vec<u8> {
    let weights = by_round(&TIER_WEIGHTS, round);
    (0..MARKET_SIZE)
        .map(|_| {
            let mut roll = below(100) as i32;
            let mut tier = 0;
            while roll >= weights[tier] {
                roll -= weights[tier];
                tier += 1;
            }
            let choices: Vec<u8> = (0..UNITS.len()).filter(|&i| UNITS[i].cost == tier as i32 + 1).map(|i| i as u8).collect();
            choices[below(choices.len() as u32) as usize]
        })
        .collect()
}

pub fn create_match(rounds: u8, market: Vec<u8>) -> Match {
    let seat = || Seat { gold: START_GOLD, points: START_POINTS, next_id: 0, pieces: vec![], formation: [-1; CELLS] };
    Match { round: 1, rounds, done: false, market, seats: vec![seat(), seat()], last: None }
}

/// Why this plan cannot be played by this seat now.
pub fn check_plan(game: &Match, seat: usize, plan: &Plan) -> Result<(), &'static str> {
    let me = &game.seats[seat];
    let owned = |id: u32| me.pieces.iter().find(|piece| piece.id == id);
    for (index, &id) in plan.sells.iter().enumerate() {
        if owned(id).is_none() || plan.sells[..index].contains(&id) {
            return Err("sells a piece it does not have");
        }
    }
    if plan.bids.len() != game.market.len() {
        return Err("one bid per market slot");
    }
    let mut spent: i64 = 0;
    let mut wanted: i64 = 0;
    for (slot, &bid) in plan.bids.iter().enumerate() {
        if bid > 1_000_000 {
            return Err("a bid must be a whole number");
        }
        if bid == 0 {
            continue;
        }
        if (bid as i32) < cost(game.market[slot]) {
            return Err("a bid is below the unit's cost");
        }
        spent += i64::from(bid);
        wanted += 1;
    }
    let refund: i64 = plan.sells.iter().map(|&id| i64::from(cost(owned(id).unwrap().unit))).sum();
    if spent > i64::from(me.gold) + refund {
        return Err("bids add up to more gold than the seat has");
    }
    if wanted > i64::from(team_cap(game.round) + BENCH_SIZE) - (me.pieces.len() as i64 - plan.sells.len() as i64) {
        return Err("no room for that many units");
    }
    let max_ref = WON + CELLS as u32;
    if plan.promotes.len() > 12 || plan.promotes.iter().any(|&r| r > max_ref) {
        return Err("malformed promotions");
    }
    if let Some(formation) = &plan.formation {
        if formation.len() > 12 || formation.iter().any(|&(r, cell)| r > max_ref || usize::from(cell) >= CELLS) {
            return Err("malformed formation");
        }
    }
    Ok(())
}

/// Plays one round with both plans. `next_market` is what the seats will see next.
pub fn resolve_round(game: &Match, plans: &[Plan; 2], next_market: Vec<u8>) -> Result<Match, String> {
    if game.done {
        return Err("the match is over".into());
    }
    for seat in 0..2 {
        check_plan(game, seat, &plans[seat]).map_err(|problem| format!("seat {seat}: {problem}"))?;
    }
    let mut next = game.clone();
    let round = next.round;
    let market = next.market.clone();

    for seat in 0..2 {
        let me = &mut next.seats[seat];
        for &id in &plans[seat].sells {
            let index = me.pieces.iter().position(|piece| piece.id == id).unwrap();
            me.gold += cost(me.pieces[index].unit);
            me.pieces.remove(index);
            for held in me.formation.iter_mut() {
                if *held == id as i32 {
                    *held = -1;
                }
            }
        }
    }

    // Equal bids go to the seat with fewer points, then to the one with less gold; if those are level too, the seats
    // take turns slot by slot, starting with a different seat each round.
    let (a, b) = (&next.seats[0], &next.seats[1]);
    let behind = if a.points != b.points {
        Some(usize::from(a.points > b.points))
    } else if a.gold != b.gold {
        Some(usize::from(a.gold > b.gold))
    } else {
        None
    };
    let mut won_piece: [Vec<(u32, u32)>; 2] = [vec![], vec![]];
    let mut won = Vec::with_capacity(market.len());
    for (slot, &unit) in market.iter().enumerate() {
        let (bid_a, bid_b) = (plans[0].bids[slot], plans[1].bids[slot]);
        if bid_a == 0 && bid_b == 0 {
            won.push(-1);
            continue;
        }
        let winner = if bid_a > bid_b {
            0
        } else if bid_b > bid_a {
            1
        } else {
            behind.unwrap_or((usize::from(round) + slot) % 2)
        };
        let me = &mut next.seats[winner];
        me.gold -= plans[winner].bids[slot] as i32;
        won_piece[winner].push((slot as u32, me.next_id));
        me.pieces.push(Piece { id: me.next_id, unit, rank: 1 });
        me.next_id += 1;
        won.push(winner as i8);
    }

    for seat in 0..2 {
        let me = &mut next.seats[seat];
        let resolve = |r: u32| -> Option<u32> {
            if r >= WON {
                won_piece[seat].iter().find(|&&(slot, _)| slot == r - WON).map(|&(_, id)| id)
            } else {
                Some(r)
            }
        };
        for &r in &plans[seat].promotes {
            let Some(piece) = resolve(r).and_then(|id| me.pieces.iter_mut().find(|piece| piece.id == id)) else { continue };
            if i32::from(piece.rank) >= MAX_RANK {
                continue;
            }
            let price = cost(piece.unit) * (i32::from(piece.rank) + 1);
            if me.gold < price {
                continue;
            }
            me.gold -= price;
            piece.rank += 1;
        }
        let kept: Vec<(u32, u8)> = me.formation.iter().enumerate().filter(|(_, &id)| id >= 0).map(|(cell, &id)| (id as u32, cell as u8)).collect();
        let wanted = plans[seat].formation.as_ref().unwrap_or(&kept);
        let mut floor = [-1i32; CELLS];
        let mut placed = 0;
        for &(r, cell) in wanted {
            let Some(id) = resolve(r).filter(|&id| me.pieces.iter().any(|piece| piece.id == id)) else { continue };
            let cell = usize::from(cell);
            if placed >= team_cap(round) || floor[cell] >= 0 || floor.contains(&(id as i32)) {
                continue;
            }
            floor[cell] = id as i32;
            placed += 1;
        }
        me.formation = floor;
    }

    let teams: Vec<Vec<Fielded>> = next
        .seats
        .iter()
        .map(|me| {
            me.formation
                .iter()
                .enumerate()
                .filter_map(|(cell, &id)| me.pieces.iter().find(|piece| piece.id as i32 == id).map(|piece| Fielded { unit: piece.unit, rank: piece.rank, cell: cell as u8 }))
                .collect()
        })
        .collect();
    let outcome = fight(&teams);
    if outcome.winner == 2 {
        for me in next.seats.iter_mut() {
            me.points = (me.points - 1).max(0);
        }
    } else {
        let winner = usize::from(outcome.winner);
        let loser = &mut next.seats[1 - winner];
        loser.points = (loser.points - 1 - i32::from(outcome.survivors[winner])).max(0);
    }

    let income: Vec<i32> = (0..2)
        .map(|seat| {
            let brokers = teams[seat].iter().filter(|piece| UNITS[usize::from(piece.unit)].role == BROKER).count() as i32;
            BASE_INCOME
                + INTEREST_MAX.min(next.seats[seat].gold / INTEREST_PER)
                + trait_bonus(&ROLE_AT[BROKER], &ROLE_BONUS[BROKER], brokers)
                + if usize::from(outcome.winner) == seat { WIN_BONUS } else { 0 }
        })
        .collect();
    for seat in 0..2 {
        next.seats[seat].gold += income[seat];
    }

    next.last = Some(RoundResult {
        round,
        market,
        bids: plans.iter().map(|plan| plan.bids.clone()).collect(),
        won,
        teams,
        winner: outcome.winner,
        survivors: outcome.survivors.to_vec(),
        income,
    });
    next.round = round + 1;
    next.market = next_market;
    next.done = next.round > next.rounds || next.seats.iter().any(|me| me.points == 0);
    Ok(next)
}

/// Seats from first place to last: more points, then more gold, then the lower seat.
pub fn standings(game: &Match) -> [usize; 2] {
    let (a, b) = (&game.seats[0], &game.seats[1]);
    let first = if a.points != b.points { usize::from(a.points < b.points) } else { usize::from(a.gold < b.gold) };
    [first, 1 - first]
}

// ---------------------------------------------------------------------------------------------------------------------
// The fight.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FightResult {
    pub winner: u8,
    pub survivors: [u8; 2],
    pub ticks: i32,
}

/// A place on the board: both sides' rows stacked, `row` 0 is the far edge of side 1.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Hex {
    pub col: i32,
    pub row: i32,
}

/// Where a side's cell is on the board. The two front rows face each other in the middle.
pub fn hex_of(side: usize, cell: u8) -> Hex {
    let row = i32::from(cell) / COLS;
    Hex { col: i32::from(cell) % COLS, row: if side == 0 { ROWS + row } else { ROWS - 1 - row } }
}

/// Steps between two hexes. Odd rows sit half a hex to the right ("odd-r" offset coordinates).
pub fn hex_distance(a: Hex, b: Hex) -> i32 {
    let ax = a.col - ((a.row - (a.row & 1)) >> 1);
    let bx = b.col - ((b.row - (b.row & 1)) >> 1);
    let (dx, dz) = (ax - bx, a.row - b.row);
    dx.abs().max(dz.abs()).max((dx + dz).abs())
}

/// The six neighbours of a hex as `(dcol, drow)`, for an even row and for an odd row. The order is part of the rules.
const NEIGHBOURS: [[(i32, i32); 6]; 2] = [[(1, 0), (0, -1), (-1, -1), (-1, 0), (-1, 1), (0, 1)], [(1, 0), (1, -1), (0, -1), (-1, 0), (0, 1), (1, 1)]];

struct Fighter {
    key: usize,
    side: usize,
    at: Hex,
    unit: usize,
    scale: i32,
    max_hp: i32,
    hp: i32,
    atk: i32,
    armor: i32,
    cd: i32,
    next: i32,
    count: i32,
    shield: i32,
    first: i32,
    /// A diving unit that has not leapt yet.
    leaps: bool,
    alive: bool,
}

fn percent(value: i32, by: i32) -> i32 {
    value * by / 100
}

fn line_up(teams: &[Vec<Fielded>]) -> Vec<Fighter> {
    let count = |team: &[Fielded], guild: bool, value: usize| -> i32 {
        team.iter().filter(|piece| (if guild { UNITS[usize::from(piece.unit)].guild } else { UNITS[usize::from(piece.unit)].role }) == value).count() as i32
    };
    let customs: Vec<i32> = (0..2).map(|side| trait_bonus(&GUILD_AT[CUSTOMS], &GUILD_BONUS[CUSTOMS], count(&teams[side], true, CUSTOMS))).collect();
    let mut fighters = Vec::new();
    for side in 0..2 {
        let mut team = teams[side].clone();
        team.sort_by_key(|piece| piece.cell);
        let canal = trait_bonus(&GUILD_AT[CANAL], &GUILD_BONUS[CANAL], count(&team, true, CANAL));
        let skyport = trait_bonus(&GUILD_AT[SKYPORT], &GUILD_BONUS[SKYPORT], count(&team, true, SKYPORT));
        let grid = trait_bonus(&GUILD_AT[GRID], &GUILD_BONUS[GRID], count(&team, true, GRID));
        let guard = trait_bonus(&ROLE_AT[GUARD], &ROLE_BONUS[GUARD], count(&team, false, GUARD));
        let runner = trait_bonus(&ROLE_AT[RUNNER], &ROLE_BONUS[RUNNER], count(&team, false, RUNNER));
        let signaller = trait_bonus(&ROLE_AT[SIGNALLER], &ROLE_BONUS[SIGNALLER], count(&team, false, SIGNALLER));
        for piece in &team {
            let unit = usize::from(piece.unit);
            let def = &UNITS[unit];
            let scale = RANK_PERCENT[usize::from(piece.rank) - 1];
            let mut max_hp = percent(def.hp, scale);
            max_hp += percent(max_hp, canal);
            let mut atk = percent(def.atk, scale);
            atk += percent(atk, grid);
            if def.role == SIGNALLER {
                atk += percent(atk, signaller);
            }
            let cd = MIN_COOLDOWN.max(def.cd - skyport);
            fighters.push(Fighter {
                key: side * CELLS + usize::from(piece.cell),
                side,
                at: hex_of(side, piece.cell),
                unit,
                scale,
                max_hp,
                hp: max_hp,
                atk,
                armor: def.armor + if def.role == GUARD { guard } else { 0 },
                cd,
                next: cd,
                count: -customs[1 - side],
                shield: 0,
                first: if def.role == RUNNER && runner > 0 { runner } else { 1 },
                leaps: def.dive,
                alive: true,
            });
        }
    }
    fighters
}

fn hurt(f: &mut Fighter, amount: i32) {
    let soaked = f.shield.min(amount);
    f.shield -= soaked;
    f.hp = (f.hp - (amount - soaked)).max(0);
    if f.hp == 0 {
        f.alive = false;
    }
}

/// After `OVERTIME` ticks every blow lands twice as hard, and harder again every ten ticks, so healing and shields
/// cannot hold a fight up.
fn late(t: i32) -> i32 {
    if t > OVERTIME {
        2 + (t - OVERTIME - 1) / 10
    } else {
        1
    }
}

/// Indexes of the living fighters of a side, in the order they were lined up (by cell).
fn living(fighters: &[Fighter], side: usize) -> Vec<usize> {
    (0..fighters.len()).filter(|&i| fighters[i].alive && fighters[i].side == side).collect()
}

fn weakest_first(fighters: &[Fighter], mut list: Vec<usize>) -> Vec<usize> {
    list.sort_by_key(|&i| (fighters[i].hp, fighters[i].key));
    list
}

/// The living enemy nearest to fighter `me` (or furthest from it); of several as near, the weakest, then the lowest key.
fn pick(fighters: &[Fighter], me: usize, furthest: bool) -> Option<usize> {
    let f = &fighters[me];
    let sign = if furthest { -1 } else { 1 };
    living(fighters, 1 - f.side).into_iter().min_by_key(|&i| (hex_distance(f.at, fighters[i].at) * sign, fighters[i].hp, fighters[i].key))
}

/// The hexes next to `at` that are on the board and empty, in the fixed order.
fn free_around(fighters: &[Fighter], at: Hex) -> Vec<Hex> {
    NEIGHBOURS[(at.row & 1) as usize]
        .iter()
        .map(|&(dcol, drow)| Hex { col: at.col + dcol, row: at.row + drow })
        .filter(|to| to.col >= 0 && to.col < COLS && to.row >= 0 && to.row < ROWS * 2 && !fighters.iter().any(|x| x.alive && x.at == *to))
        .collect()
}

/// One step towards `goal`: the first free neighbour that is nearer than where the fighter stands.
fn step(fighters: &mut [Fighter], me: usize, goal: Hex) -> bool {
    let mut best = None;
    let mut best_distance = hex_distance(fighters[me].at, goal);
    for to in free_around(fighters, fighters[me].at) {
        let distance = hex_distance(to, goal);
        if distance < best_distance {
            best = Some(to);
            best_distance = distance;
        }
    }
    if let Some(to) = best {
        fighters[me].at = to;
    }
    best.is_some()
}

fn cast(fighters: &mut [Fighter], me: usize, target: usize, t: i32) {
    let def = &UNITS[fighters[me].unit];
    let (side, at, scale) = (fighters[me].side, fighters[me].at, fighters[me].scale);
    let friends = living(fighters, side);
    let foes = living(fighters, 1 - side);
    let reach: Vec<usize> = match def.who {
        Who::Caster => vec![me],
        Who::Target => {
            if fighters[target].alive {
                vec![target]
            } else {
                vec![]
            }
        }
        Who::AllyNear => friends.into_iter().filter(|&i| hex_distance(at, fighters[i].at) <= 1).collect(),
        Who::Allies => {
            if def.op == Op::Energize {
                friends.into_iter().filter(|&i| i != me).collect()
            } else {
                friends
            }
        }
        Who::AllyWeakest => weakest_first(fighters, friends).into_iter().take(1).collect(),
        Who::Weakest => weakest_first(fighters, foes).into_iter().take(1).collect(),
        Who::Three => weakest_first(fighters, foes).into_iter().take(3).collect(),
        Who::Farthest => pick(fighters, me, true).into_iter().collect(),
        Who::Near => {
            let centre = fighters[target].at;
            foes.into_iter().filter(|&i| hex_distance(centre, fighters[i].at) <= 1).collect()
        }
        Who::Around => {
            let around: Vec<usize> = foes.iter().copied().filter(|&i| hex_distance(at, fighters[i].at) <= 2).collect();
            if around.is_empty() {
                pick(fighters, me, false).into_iter().collect()
            } else {
                around
            }
        }
    };
    let scaled = percent(def.amount, scale);
    for i in reach {
        let x = &mut fighters[i];
        match def.op {
            Op::Dmg => hurt(x, scaled * late(t)),
            Op::Heal => x.hp = x.max_hp.min(x.hp + scaled),
            Op::Shield => x.shield += scaled,
            Op::Stun => x.next = x.next.max(t) + def.amount,
            Op::Haste => x.cd = MIN_COOLDOWN.max(x.cd - def.amount),
            Op::Energize => x.count += def.amount,
            Op::Weaken => x.atk = percent(x.atk, 100 - def.amount).max(1),
            Op::Drain => x.count = x.count.min(0),
            Op::Ramp => x.atk += percent(x.atk, def.amount),
        }
    }
}

/// Fights two floors to the end. No randomness: the same floors always give the same result.
pub fn fight(teams: &[Vec<Fielded>]) -> FightResult {
    let mut fighters = line_up(teams);
    let mut t = 0;
    while t < MAX_TICKS && !living(&fighters, 0).is_empty() && !living(&fighters, 1).is_empty() {
        t += 1;
        // Side 0 moves first on odd ticks, side 1 on even ticks; within a side, by key.
        let first = if t % 2 == 1 { 0 } else { 1 };
        let order: Vec<usize> = (0..fighters.len()).filter(|&i| fighters[i].side == first).chain((0..fighters.len()).filter(|&i| fighters[i].side != first)).collect();
        for me in order {
            if !fighters[me].alive || fighters[me].next > t {
                continue;
            }
            let def = &UNITS[fighters[me].unit];
            let Some(target) = pick(&fighters, me, false) else { break };
            if fighters[me].leaps {
                // A diving unit's first move: land next to the enemy furthest away, if there is room there.
                fighters[me].leaps = false;
                let prey = pick(&fighters, me, true).unwrap();
                let landing = free_around(&fighters, fighters[prey].at).first().copied();
                if let Some(landing) = landing {
                    if hex_distance(fighters[me].at, fighters[prey].at) > 1 {
                        fighters[me].at = landing;
                        fighters[me].next = t + 1;
                        continue;
                    }
                }
            }
            if hex_distance(fighters[me].at, fighters[target].at) > if def.ranged { RANGED_RANGE } else { MELEE_RANGE } {
                // Out of reach: one step nearer. A unit that cannot get nearer waits where it is.
                let goal = fighters[target].at;
                step(&mut fighters, me, goal);
                fighters[me].next = t + 1;
                continue;
            }
            let dmg = (fighters[me].atk * fighters[me].first - fighters[target].armor).max(1) * late(t);
            fighters[me].first = 1;
            hurt(&mut fighters[target], dmg);
            fighters[me].count += 1;
            if fighters[me].count >= def.every {
                fighters[me].count = 0;
                cast(&mut fighters, me, target, t);
            }
            fighters[me].next = t + fighters[me].cd;
        }
    }
    let alive = [living(&fighters, 0), living(&fighters, 1)];
    let survivors = [alive[0].len() as u8, alive[1].len() as u8];
    let health: Vec<i32> = alive.iter().map(|side| side.iter().map(|&i| fighters[i].hp).sum()).collect();
    let winner = if survivors[1] == 0 && survivors[0] > 0 {
        0
    } else if survivors[0] == 0 && survivors[1] > 0 {
        1
    } else if health[0] > health[1] {
        0
    } else if health[1] > health[0] {
        1
    } else {
        2
    };
    FightResult { winner, survivors, ticks: t }
}
