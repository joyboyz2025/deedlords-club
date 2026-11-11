// The Arena's rules: sealed bids, the floor, the fight, and whole matches played by the rule bot. Every match ends,
// gold is only ever earned as income and spent on bids and promotions, and the same input always gives the same result.

import assert from "node:assert/strict";
import { test } from "node:test";
import { C, UNITS } from "../games/arena/data.ts";
import { CELLS, EMPTY_PLAN, WON, checkPlan, hexDistance, hexOf, createMatch, drawMarket, fight, resolveRound, standings, teamCap, type FightEvent, type Match, type Plan } from "../games/arena/engine.ts";
import { DEFAULT_PLAYBOOK, planFor } from "../games/arena/agent/bot.ts";

const unit = (id: string): number => UNITS.findIndex((def) => def.id === id);
const plan = (over: Partial<Plan>): Plan => ({ ...EMPTY_PLAN, ...over });

/** A small seeded generator, so a failing match can be played again. */
function seeded(seed: number): (n: number) => number {
  let state = seed >>> 0;
  return (n) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

test("the data is a full grid: every guild and every role has one unit of each cost", () => {
  assert.equal(UNITS.length, 16);
  for (const key of ["guild", "role"] as const) {
    for (let value = 0; value < 4; value++) {
      assert.deepEqual(UNITS.filter((def) => def[key] === value).map((def) => def.cost).sort(), [1, 2, 3, 4], `${key} ${value}`);
    }
  }
  assert.equal(new Set(UNITS.map((def) => def.id)).size, 16);
});

test("a market has five units and early rounds offer no costly ones", () => {
  const below = seeded(1);
  for (let i = 0; i < 200; i++) {
    const market = drawMarket(1, below);
    assert.equal(market.length, C.marketSize);
    assert.ok(market.every((index) => UNITS[index].cost <= 2));
  }
  assert.ok(Array.from({ length: 200 }, () => drawMarket(7, below)).flat().some((index) => UNITS[index].cost === 4));
});

test("the higher sealed bid takes the unit and pays what it bid", () => {
  const market = [unit("brann"), unit("pip"), unit("mirela"), unit("opal"), unit("eel")];
  const start = createMatch(7, market);
  const after = resolveRound(start, [plan({ bids: [3, 0, 1, 0, 0] }), plan({ bids: [2, 1, 0, 0, 0] })], market);
  assert.deepEqual(after.last!.won, [0, 1, 0, -1, -1]);
  assert.deepEqual(after.seats[0].pieces.map((piece) => piece.unit), [unit("brann"), unit("mirela")]);
  assert.deepEqual(after.seats[1].pieces.map((piece) => piece.unit), [unit("pip")]);
  // Nobody was placed on the floor, so the fight is a draw and both lose a point.
  assert.deepEqual(after.seats.map((seat) => seat.points), [C.startPoints - 1, C.startPoints - 1]);
  assert.equal(after.seats[0].gold, C.startGold - 4 + after.last!.income[0]);
  assert.equal(after.seats[1].gold, C.startGold - 1 + after.last!.income[1]);
});

test("equal bids go to the seat with fewer points; level seats take turns slot by slot", () => {
  const market = [unit("brann"), unit("pip"), unit("mirela"), unit("opal"), unit("eel")];
  const level = createMatch(7, market);
  assert.deepEqual(resolveRound(level, [plan({ bids: [1, 1, 1, 0, 0] }), plan({ bids: [1, 1, 1, 0, 0] })], market).last!.won, [1, 0, 1, -1, -1]);
  const behind: Match = structuredClone(level);
  behind.seats[0].points = 4;
  assert.equal(resolveRound(behind, [plan({ bids: [2, 0, 0, 0, 0] }), plan({ bids: [2, 0, 0, 0, 0] })], market).last!.won[0], 0);
});

test("plans that break the rules are refused", () => {
  const match = createMatch(7, [unit("brann"), unit("eel"), unit("mirela"), unit("opal"), unit("pip")]);
  assert.equal(checkPlan(match, 0, EMPTY_PLAN), null);
  assert.match(checkPlan(match, 0, plan({ bids: [0, 1, 0, 0, 0] }))!, /below the unit's cost/);
  assert.match(checkPlan(match, 0, plan({ bids: [4, 3, 0, 0, 0] }))!, /more gold/);
  assert.match(checkPlan(match, 0, plan({ bids: [1, 0, 0] }))!, /one bid per market slot/);
  assert.match(checkPlan(match, 0, plan({ sells: [3] }))!, /does not have/);
  assert.match(checkPlan(match, 0, plan({ formation: [[0, CELLS]] }))!, /malformed formation/);
  assert.throws(() => resolveRound(match, [plan({ bids: [0, 1, 0, 0, 0] }), EMPTY_PLAN], match.market), /seat 0/);
});

test("a formation takes units in order up to the cap and skips a unit that was not won", () => {
  const market = [unit("brann"), unit("pip"), unit("mirela"), unit("opal"), unit("opal")];
  const start = createMatch(7, market);
  const mine = plan({ bids: [1, 1, 1, 1, 1], formation: [[WON + 4, 1], [WON + 0, 1], [WON + 1, 0], [WON + 2, 4], [WON + 3, 5]] });
  // Seat 1 outbids slot 4, so seat 0's first choice for cell 1 is skipped and Brann stands there instead.
  const after = resolveRound(start, [mine, plan({ bids: [0, 0, 0, 0, 2] })], market);
  const floor = after.last!.teams[0];
  assert.equal(floor.length, teamCap(1));
  assert.deepEqual(floor, [
    { unit: unit("pip"), rank: 1, cell: 0 },
    { unit: unit("brann"), rank: 1, cell: 1 },
    { unit: unit("mirela"), rank: 1, cell: 4 },
  ]);
  assert.equal(after.seats[0].pieces.length, 4);
});

test("selling refunds the cost and promoting costs the unit's cost times the new rank", () => {
  const market = [unit("eel"), unit("pip"), unit("mirela"), unit("opal"), unit("brann")];
  let match = resolveRound(createMatch(7, market), [plan({ bids: [2, 1, 0, 0, 0], formation: [[WON, 1], [WON + 1, 0]] }), EMPTY_PLAN], market);
  const gold = match.seats[0].gold;
  const [eel, pip] = match.seats[0].pieces;
  match = resolveRound(match, [plan({ sells: [pip.id], promotes: [eel.id] }), EMPTY_PLAN], market);
  assert.equal(match.seats[0].pieces.length, 1);
  assert.equal(match.seats[0].pieces[0].rank, 2);
  assert.equal(match.seats[0].gold, gold + UNITS[pip.unit].cost - UNITS[eel.unit].cost * 2 + match.last!.income[0]);
  assert.deepEqual(match.last!.teams[0], [{ unit: eel.unit, rank: 2, cell: 1 }]);
});

test("a fight is the same every time and its events account for every point of health", () => {
  const teams = [
    [{ unit: unit("brann"), rank: 1, cell: 1 }, { unit: unit("mirela"), rank: 1, cell: 4 }, { unit: unit("opal"), rank: 1, cell: 3 }],
    [{ unit: unit("tamsin"), rank: 1, cell: 1 }, { unit: unit("pip"), rank: 2, cell: 0 }, { unit: unit("sena"), rank: 1, cell: 4 }],
  ];
  const events: FightEvent[] = [];
  const first = fight(teams, (event) => events.push(event));
  assert.deepEqual(fight(teams), first);
  assert.ok(events.length > 10);
  assert.ok(first.winner === 0 || first.winner === 1);
  const last = events.at(-1)!;
  const alive = (side: number) => last.hp.slice(side * CELLS, side * CELLS + CELLS).filter((hp) => hp > 0).length;
  assert.deepEqual(first.survivors, [alive(0), alive(1)]);
  assert.equal(first.survivors[1 - first.winner], 0);
});

test("the board: front rows touch, distance counts hex steps, and a far unit walks before it hits", () => {
  // The middle cells of the two front rows are next to each other; the two back corners are far apart.
  assert.equal(hexDistance(hexOf(0, 3), hexOf(1, 3)), 1);
  assert.equal(hexDistance(hexOf(0, 0), hexOf(0, 6)), 6);
  assert.equal(hexDistance(hexOf(0, 14), hexOf(1, 14)), 5);
  const events: FightEvent[] = [];
  fight([[{ unit: unit("brann"), rank: 1, cell: 14 }], [{ unit: unit("tamsin"), rank: 1, cell: 20 }]], (event) => events.push(event));
  const firstHit = events.findIndex((event) => event.kind === "attack");
  assert.ok(firstHit > 0 && events.slice(0, firstHit).every((event) => event.kind === "move"));
});

test("an empty floor loses to any unit, and two empty floors draw", () => {
  const one = [{ unit: unit("opal"), rank: 1, cell: 4 }];
  assert.deepEqual(fight([one, []]), { winner: 0, survivors: [1, 0], ticks: 0 });
  assert.deepEqual(fight([[], one]), { winner: 1, survivors: [0, 1], ticks: 0 });
  assert.equal(fight([[], []]).winner, 2);
});

test("traits change the numbers: two Canal units give health, two Customs units delay the enemy's ability", () => {
  const canal = [{ unit: unit("brann"), rank: 1, cell: 1 }, { unit: unit("eel"), rank: 1, cell: 0 }];
  const foe = [{ unit: unit("opal"), rank: 1, cell: 4 }];
  const seen: FightEvent[] = [];
  fight([canal, foe], (event) => seen.push(event));
  const brann = UNITS[unit("brann")].hp;
  assert.equal(Math.max(...seen.map((event) => event.hp[1])), brann + Math.floor(brann / 10));

  /** How many times Hask attacks before his first ability. */
  const attacksBeforeCast = (enemy: { unit: number; rank: number; cell: number }[]) => {
    const events: FightEvent[] = [];
    fight([[{ unit: unit("hask"), rank: 3, cell: 1 }], enemy], (event) => events.push(event));
    const mine = events.filter((event) => event.from === 1);
    return mine.findIndex((event) => event.kind === "cast");
  };
  assert.equal(attacksBeforeCast([{ unit: unit("tamsin"), rank: 3, cell: 1 }, { unit: unit("odo"), rank: 3, cell: 4 }]), 3);
  assert.equal(attacksBeforeCast([{ unit: unit("grigg"), rank: 3, cell: 1 }, { unit: unit("mirela"), rank: 3, cell: 4 }]), 4);
});

test("bot against bot: every match ends, nothing goes negative, and neither seat is favoured", () => {
  const wins = [0, 0];
  for (let game = 0; game < 400; game++) {
    const below = seeded(game + 1);
    let match = createMatch(7, drawMarket(1, below));
    while (!match.done) {
      const before = match;
      const plans = [planFor(match, 0, DEFAULT_PLAYBOOK), planFor(match, 1, DEFAULT_PLAYBOOK)];
      match = resolveRound(match, plans, drawMarket(match.round + 1, below));
      for (const seat of [0, 1]) {
        const me = match.seats[seat];
        assert.ok(me.gold >= 0 && me.points >= 0 && me.points <= C.startPoints, `game ${game}`);
        assert.ok(me.pieces.length <= teamCap(before.round) + C.benchSize, `game ${game}`);
        assert.ok(match.last!.teams[seat].length <= teamCap(before.round), `game ${game}`);
        assert.ok(me.gold <= before.seats[seat].gold + match.last!.income[seat] + before.seats[seat].pieces.length * 4, `game ${game}`);
      }
    }
    assert.ok(match.round <= 8);
    wins[standings(match)[0]]++;
  }
  assert.ok(wins[0] > 140 && wins[1] > 140, `seat wins ${wins}`);
});
