// The Arena's rules: a duel of sealed plans. Each round both seats see the same market of five units and hand in a plan
// (what to sell, a bid per market unit, promotions, where everyone stands). Bids are opened together, the higher one
// takes the unit and pays what it bid, then the two floors fight on a board of hexes with no randomness at all: units
// walk to an enemy and hit it. Integer maths only, so the Rust port in `contracts/arena-engine` gives the same result
// for the same input.

import { BROKER, C, CANAL, CUSTOMS, GRID, GUARD, GUILDS, ROLES, RUNNER, SIGNALLER, SKYPORT, UNITS, traitBonus, type Op } from "./data.ts";

export type Piece = { id: number; unit: number; rank: number };
/** `formation[cell]` is a piece id or -1. A side has `ROWS` rows of `COLS` cells: `cell = row * COLS + col`, row 0 is the one nearest the enemy. */
export type Seat = { gold: number; points: number; nextId: number; pieces: Piece[]; formation: number[] };
/** A piece of the seat by its id, or `WON + slot` for "the unit of that market slot, if I win it". */
export type Ref = number;
export const WON = 100;
export type Plan = {
  sells: number[];
  /** One number per market slot: 0 for no bid, otherwise at least the unit's cost. */
  bids: number[];
  promotes: Ref[];
  /** `[ref, cell]` in order of preference, taken until the floor is full; a ref that was not won is skipped. `null` keeps the floor as it is. */
  formation: [Ref, number][] | null;
};
export const EMPTY_PLAN: Plan = { sells: [], bids: [0, 0, 0, 0, 0], promotes: [], formation: null };

export type Fielded = { unit: number; rank: number; cell: number };
export type RoundResult = {
  round: number;
  market: number[];
  bids: number[][];
  /** Per market slot: the seat that took the unit, or -1. */
  won: number[];
  teams: Fielded[][];
  /** 0 or 1, or 2 for a draw. */
  winner: number;
  survivors: number[];
  income: number[];
};
export type Match = { round: number; rounds: number; done: boolean; market: number[]; seats: Seat[]; last: RoundResult | null };

export const COLS = C.cols;
export const ROWS = C.rows;
export const CELLS = COLS * ROWS;
const at = <T>(list: T[], round: number): T => list[Math.min(round, list.length) - 1];
export const teamCap = (round: number): number => at(C.teamCap, round);

/** `below(n)` returns a uniform integer in `0..n-1`. Two calls per slot: the tier, then the unit within it. */
export function drawMarket(round: number, below: (n: number) => number): number[] {
  const weights = at(C.tierWeights, round);
  return Array.from({ length: C.marketSize }, () => {
    let roll = below(100);
    let tier = 0;
    while (roll >= weights[tier]) roll -= weights[tier++];
    const choices = UNITS.flatMap((unit, index) => (unit.cost === tier + 1 ? [index] : []));
    return choices[below(choices.length)];
  });
}

export function createMatch(rounds: number, market: number[]): Match {
  const seat = (): Seat => ({ gold: C.startGold, points: C.startPoints, nextId: 0, pieces: [], formation: Array(CELLS).fill(-1) });
  return { round: 1, rounds, done: false, market, seats: [seat(), seat()], last: null };
}

const isCount = (value: unknown, max: number): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= max;

/** Why this plan cannot be played by this seat now, or `null` when it can. */
export function checkPlan(match: Match, seat: number, plan: Plan): string | null {
  const me = match.seats[seat];
  if (!Array.isArray(plan.sells) || !Array.isArray(plan.bids) || !Array.isArray(plan.promotes)) return "malformed plan";
  if (new Set(plan.sells).size !== plan.sells.length || plan.sells.some((id) => !me.pieces.some((piece) => piece.id === id))) return "sells a piece it does not have";
  if (plan.bids.length !== match.market.length) return "one bid per market slot";
  let spent = 0;
  let wanted = 0;
  for (const [slot, bid] of plan.bids.entries()) {
    if (!isCount(bid, 1_000_000)) return "a bid must be a whole number";
    if (bid === 0) continue;
    if (bid < UNITS[match.market[slot]].cost) return "a bid is below the unit's cost";
    spent += bid;
    wanted++;
  }
  const refund = plan.sells.reduce((sum, id) => sum + UNITS[me.pieces.find((piece) => piece.id === id)!.unit].cost, 0);
  if (spent > me.gold + refund) return "bids add up to more gold than the seat has";
  if (wanted > teamCap(match.round) + C.benchSize - (me.pieces.length - plan.sells.length)) return "no room for that many units";
  if (plan.promotes.length > 12 || plan.promotes.some((ref) => !isCount(ref, WON + CELLS))) return "malformed promotions";
  if (plan.formation !== null) {
    if (!Array.isArray(plan.formation) || plan.formation.length > 12) return "malformed formation";
    for (const entry of plan.formation) {
      if (!Array.isArray(entry) || entry.length !== 2 || !isCount(entry[0], WON + CELLS) || !isCount(entry[1], CELLS - 1)) return "malformed formation";
    }
  }
  return null;
}

/** Plays one round with both plans and returns the match after it. `nextMarket` is what the seats will see next. */
export function resolveRound(match: Match, plans: Plan[], nextMarket: number[]): Match {
  if (match.done) throw new Error("the match is over");
  for (const seat of [0, 1]) {
    const problem = checkPlan(match, seat, plans[seat]);
    if (problem) throw new Error(`seat ${seat}: ${problem}`);
  }
  const next: Match = structuredClone(match);
  const { seats, round, market } = next;

  for (const seat of [0, 1]) {
    const me = seats[seat];
    for (const id of plans[seat].sells) {
      const index = me.pieces.findIndex((piece) => piece.id === id);
      me.gold += UNITS[me.pieces[index].unit].cost;
      me.pieces.splice(index, 1);
      me.formation = me.formation.map((held) => (held === id ? -1 : held));
    }
  }

  // Equal bids go to the seat with fewer points, then to the one with less gold; if those are level too, the seats
  // take turns slot by slot, starting with a different seat each round.
  const behind = seats[0].points !== seats[1].points ? (seats[0].points < seats[1].points ? 0 : 1) : seats[0].gold !== seats[1].gold ? (seats[0].gold < seats[1].gold ? 0 : 1) : -1;
  const wonPiece = [new Map<number, number>(), new Map<number, number>()];
  const won = market.map((unit, slot) => {
    const [a, b] = [plans[0].bids[slot], plans[1].bids[slot]];
    if (a === 0 && b === 0) return -1;
    const winner = a > b ? 0 : b > a ? 1 : behind >= 0 ? behind : (round + slot) % 2;
    const me = seats[winner];
    me.gold -= plans[winner].bids[slot];
    wonPiece[winner].set(slot, me.nextId);
    me.pieces.push({ id: me.nextId++, unit, rank: 1 });
    return winner;
  });

  for (const seat of [0, 1]) {
    const me = seats[seat];
    const find = (ref: Ref): Piece | undefined => {
      const id = ref >= WON ? wonPiece[seat].get(ref - WON) : ref;
      return me.pieces.find((piece) => piece.id === id);
    };
    for (const ref of plans[seat].promotes) {
      const piece = find(ref);
      if (!piece || piece.rank >= C.maxRank) continue;
      const price = UNITS[piece.unit].cost * (piece.rank + 1);
      if (me.gold < price) continue;
      me.gold -= price;
      piece.rank++;
    }
    const wanted = plans[seat].formation ?? me.formation.flatMap((id, cell): [Ref, number][] => (id < 0 ? [] : [[id, cell]]));
    const floor: number[] = Array(CELLS).fill(-1);
    let placed = 0;
    for (const [ref, cell] of wanted) {
      const piece = find(ref);
      if (!piece || placed >= teamCap(round) || floor[cell] >= 0 || floor.includes(piece.id)) continue;
      floor[cell] = piece.id;
      placed++;
    }
    me.formation = floor;
  }

  const teams = seats.map((me) =>
    me.formation.flatMap((id, cell): Fielded[] => {
      const piece = me.pieces.find((held) => held.id === id);
      return piece ? [{ unit: piece.unit, rank: piece.rank, cell }] : [];
    }),
  );
  const { winner, survivors } = fight(teams);
  if (winner === 2) for (const me of seats) me.points = Math.max(0, me.points - 1);
  else seats[1 - winner].points = Math.max(0, seats[1 - winner].points - 1 - survivors[winner]);

  const income = seats.map((me, seat) => {
    const brokers = teams[seat].filter((piece) => UNITS[piece.unit].role === BROKER).length;
    return C.baseIncome + Math.min(C.interestMax, Math.floor(me.gold / C.interestPer)) + traitBonus(ROLES[BROKER], brokers) + (winner === seat ? C.winBonus : 0);
  });
  seats.forEach((me, seat) => (me.gold += income[seat]));

  next.last = { round, market, bids: plans.map((plan) => [...plan.bids]), won, teams, winner, survivors, income };
  next.round = round + 1;
  next.market = nextMarket;
  next.done = next.round > next.rounds || seats.some((me) => me.points === 0);
  return next;
}

/** Seats from first place to last: more points, then more gold, then the lower seat. */
export function standings(match: Match): number[] {
  const [a, b] = match.seats;
  return a.points !== b.points ? (a.points > b.points ? [0, 1] : [1, 0]) : a.gold >= b.gold ? [0, 1] : [1, 0];
}

// ---------------------------------------------------------------------------------------------------------------------
// The fight.

/** A place on the board: both sides' rows stacked, `row` 0 is the far edge of side 1 and `2 * ROWS - 1` that of side 0. */
export type Hex = { col: number; row: number };
/** Where a side's cell is on the board. The two front rows face each other in the middle. */
export const hexOf = (side: number, cell: number): Hex => {
  const row = Math.floor(cell / COLS);
  return { col: cell % COLS, row: side === 0 ? ROWS + row : ROWS - 1 - row };
};
/** Steps between two hexes. Odd rows sit half a hex to the right ("odd-r" offset coordinates). */
export function hexDistance(a: Hex, b: Hex): number {
  const ax = a.col - ((a.row - (a.row & 1)) >> 1);
  const bx = b.col - ((b.row - (b.row & 1)) >> 1);
  const [dx, dz] = [ax - bx, a.row - b.row];
  return Math.max(Math.abs(dx), Math.abs(dz), Math.abs(dx + dz));
}
/** The six neighbours of a hex as `[dcol, drow]`, for an even row and for an odd row. The order is part of the rules. */
const NEIGHBOURS = [
  [[1, 0], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1]],
  [[1, 0], [1, -1], [0, -1], [-1, 0], [0, 1], [1, 1]],
];

/** A fighter is named by `side * CELLS + cell` of where it started. Every event carries the health and shield of all places after it. */
export type FightEvent = { t: number; hp: number[]; shield: number[] } & (
  | { kind: "attack"; from: number; to: number; dmg: number }
  | { kind: "cast"; from: number; op: Op; to: number[]; amount: number }
  | { kind: "move"; from: number; to: Hex }
);
type Happening = { kind: "attack"; from: number; to: number; dmg: number } | { kind: "cast"; from: number; op: Op; to: number[]; amount: number } | { kind: "move"; from: number; to: Hex };
export type FightResult = { winner: number; survivors: number[]; ticks: number };

type Fighter = {
  key: number;
  side: number;
  at: Hex;
  unit: number;
  scale: number;
  maxHp: number;
  hp: number;
  atk: number;
  armor: number;
  cd: number;
  /** The tick of its next action. */
  next: number;
  /** Attacks since the last ability; starts below zero under the Customs trait. */
  count: number;
  shield: number;
  /** What the next attack is multiplied by (the Runner trait), then 1. */
  first: number;
  /** A diving unit that has not leapt yet. */
  leaps: boolean;
  alive: boolean;
};

const percent = (value: number, by: number): number => Math.floor((value * by) / 100);

function lineUp(teams: Fielded[][]): Fighter[] {
  const fighters: Fighter[] = [];
  const customs = [0, 1].map((side) => traitBonus(GUILDS[CUSTOMS], teams[side].filter((piece) => UNITS[piece.unit].guild === CUSTOMS).length));
  for (const side of [0, 1]) {
    const team = [...teams[side]].sort((a, b) => a.cell - b.cell);
    const count = (key: "guild" | "role", value: number) => team.filter((piece) => UNITS[piece.unit][key] === value).length;
    const canal = traitBonus(GUILDS[CANAL], count("guild", CANAL));
    const skyport = traitBonus(GUILDS[SKYPORT], count("guild", SKYPORT));
    const grid = traitBonus(GUILDS[GRID], count("guild", GRID));
    const guard = traitBonus(ROLES[GUARD], count("role", GUARD));
    const runner = traitBonus(ROLES[RUNNER], count("role", RUNNER));
    const signaller = traitBonus(ROLES[SIGNALLER], count("role", SIGNALLER));
    for (const piece of team) {
      const def = UNITS[piece.unit];
      const scale = C.rankPercent[piece.rank - 1];
      let maxHp = percent(def.hp, scale);
      maxHp += percent(maxHp, canal);
      let atk = percent(def.atk, scale);
      atk += percent(atk, grid);
      if (def.role === SIGNALLER) atk += percent(atk, signaller);
      const cd = Math.max(C.minCooldown, def.cd - skyport);
      fighters.push({
        key: side * CELLS + piece.cell,
        side,
        at: hexOf(side, piece.cell),
        unit: piece.unit,
        scale,
        maxHp,
        hp: maxHp,
        atk,
        armor: def.armor + (def.role === GUARD ? guard : 0),
        cd,
        next: cd,
        count: -customs[1 - side],
        shield: 0,
        first: def.role === RUNNER && runner ? runner : 1,
        leaps: def.dive,
        alive: true,
      });
    }
  }
  return fighters;
}

/** Full health of every place before the fight (0 where nobody stands), traits included. */
export function startingHealth(teams: Fielded[][]): number[] {
  const health = Array(CELLS * 2).fill(0);
  for (const f of lineUp(teams)) health[f.key] = f.maxHp;
  return health;
}

/** Fights two floors to the end. No randomness: the same floors always give the same result and the same events. */
export function fight(teams: Fielded[][], onEvent?: (event: FightEvent) => void): FightResult {
  const fighters = lineUp(teams);
  const living = (side: number) => fighters.filter((f) => f.alive && f.side === side);
  const emit = (t: number, event: Happening) => {
    if (!onEvent) return;
    const hp = Array(CELLS * 2).fill(0);
    const shield = Array(CELLS * 2).fill(0);
    for (const f of fighters) [hp[f.key], shield[f.key]] = [f.hp, f.shield];
    onEvent({ t, hp, shield, ...event });
  };
  const hurt = (f: Fighter, amount: number) => {
    const soaked = Math.min(f.shield, amount);
    f.shield -= soaked;
    f.hp = Math.max(0, f.hp - (amount - soaked));
    if (f.hp === 0) f.alive = false;
  };
  const weakestFirst = (list: Fighter[]) => [...list].sort((a, b) => a.hp - b.hp || a.key - b.key);
  /** After `overtime` ticks every blow lands twice as hard, and harder again every ten ticks, so healing and shields cannot hold a fight up. */
  const late = (t: number) => (t > C.overtime ? 2 + Math.floor((t - C.overtime - 1) / 10) : 1);
  /** The living enemy nearest to `f` (or furthest from it); of several as near, the weakest, then the lowest key. */
  const pick = (f: Fighter, furthest: boolean): Fighter | undefined =>
    living(1 - f.side).sort((a, b) => (hexDistance(f.at, a.at) - hexDistance(f.at, b.at)) * (furthest ? -1 : 1) || a.hp - b.hp || a.key - b.key)[0];

  const cast = (f: Fighter, target: Fighter, t: number) => {
    const { op, who, amount } = UNITS[f.unit].ability;
    const friends = living(f.side);
    const foes = living(1 - f.side);
    const around = foes.filter((foe) => hexDistance(f.at, foe.at) <= 2);
    const reach: Fighter[] =
      who === "self" ? [f]
      : who === "target" ? (target.alive ? [target] : [])
      : who === "allyNear" ? friends.filter((friend) => hexDistance(f.at, friend.at) <= 1)
      : who === "allies" ? (op === "energize" ? friends.filter((friend) => friend !== f) : friends)
      : who === "allyWeakest" ? weakestFirst(friends).slice(0, 1)
      : who === "weakest" ? weakestFirst(foes).slice(0, 1)
      : who === "three" ? weakestFirst(foes).slice(0, 3)
      : who === "farthest" ? [pick(f, true)].flatMap((x) => (x ? [x] : []))
      : who === "near" ? foes.filter((foe) => hexDistance(target.at, foe.at) <= 1)
      : around.length ? around : [pick(f, false)].flatMap((x) => (x ? [x] : [])); // "around"
    const scaled = percent(amount, f.scale);
    for (const x of reach) {
      if (op === "dmg") hurt(x, scaled * late(t));
      else if (op === "heal") x.hp = Math.min(x.maxHp, x.hp + scaled);
      else if (op === "shield") x.shield += scaled;
      else if (op === "stun") x.next = Math.max(x.next, t) + amount;
      else if (op === "haste") x.cd = Math.max(C.minCooldown, x.cd - amount);
      else if (op === "energize") x.count += amount;
      else if (op === "weaken") x.atk = Math.max(1, percent(x.atk, 100 - amount));
      else if (op === "drain") x.count = Math.min(x.count, 0);
      else x.atk += percent(x.atk, amount); // "ramp"
    }
    emit(t, { kind: "cast", from: f.key, op, to: reach.map((x) => x.key), amount: op === "dmg" || op === "heal" || op === "shield" ? scaled : amount });
  };

  /** The hexes next to `at` that are on the board and empty, in the fixed order. */
  const freeAround = (at: Hex): Hex[] =>
    NEIGHBOURS[at.row & 1]
      .map(([dcol, drow]) => ({ col: at.col + dcol, row: at.row + drow }))
      .filter((to) => to.col >= 0 && to.col < COLS && to.row >= 0 && to.row < ROWS * 2 && !fighters.some((x) => x.alive && x.at.col === to.col && x.at.row === to.row));
  /** One step towards `goal`: the first free neighbour that is nearer than where `f` stands. False when there is none. */
  const step = (f: Fighter, goal: Hex): boolean => {
    let best: Hex | null = null;
    let bestDistance = hexDistance(f.at, goal);
    for (const to of freeAround(f.at)) {
      const distance = hexDistance(to, goal);
      if (distance < bestDistance) [best, bestDistance] = [to, distance];
    }
    if (best) f.at = best;
    return best !== null;
  };

  let t = 0;
  while (t < C.maxTicks && living(0).length && living(1).length) {
    t++;
    // Side 0 moves first on odd ticks, side 1 on even ticks; within a side, by key.
    const order = [...fighters].sort((a, b) => (a.side === b.side ? a.key - b.key : (a.side === t % 2 ? 1 : -1)));
    for (const f of order) {
      if (!f.alive || f.next > t) continue;
      const def = UNITS[f.unit];
      const target = pick(f, false);
      if (!target) break;
      if (f.leaps) {
        // A diving unit's first move: land next to the enemy furthest away, if there is room there.
        f.leaps = false;
        const prey = pick(f, true)!;
        const landing = freeAround(prey.at)[0];
        if (landing && hexDistance(f.at, prey.at) > 1) {
          f.at = landing;
          emit(t, { kind: "move", from: f.key, to: f.at });
          f.next = t + 1;
          continue;
        }
      }
      if (hexDistance(f.at, target.at) > (def.ranged ? C.rangedRange : C.meleeRange)) {
        // Out of reach: one step nearer. A unit that cannot get nearer waits where it is.
        if (step(f, target.at)) emit(t, { kind: "move", from: f.key, to: f.at });
        f.next = t + 1;
        continue;
      }
      const dmg = Math.max(1, f.atk * f.first - target.armor) * late(t);
      f.first = 1;
      hurt(target, dmg);
      emit(t, { kind: "attack", from: f.key, to: target.key, dmg });
      f.count++;
      if (f.count >= def.every) {
        f.count = 0;
        cast(f, target, t);
      }
      f.next = t + f.cd;
    }
  }
  const survivors = [living(0).length, living(1).length];
  const health = [0, 1].map((side) => living(side).reduce((sum, f) => sum + f.hp, 0));
  const winner = !survivors[1] && survivors[0] ? 0 : !survivors[0] && survivors[1] ? 1 : health[0] > health[1] ? 0 : health[1] > health[0] ? 1 : 2;
  return { winner, survivors, ticks: t };
}
