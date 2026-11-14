// The simulation behind the rules matches are opened with (scripts/co-ty-phu-sim.ts): its port of the contract's turn
// driver, its clock of the table, and what it says of the rules before and now.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Plan } from "../games/co-ty-phu/agent/plan.ts";
import { OWNABLE_SQUARES, SQUARES } from "../games/co-ty-phu/board.ts";
import { RULES, TO_THE_END, roundsFor } from "../games/co-ty-phu/chain/calls.ts";
import { createGame, currentPlayer, newPlayer, startGame, type Game, type Rng } from "../games/co-ty-phu/engine.ts";
import { PACE_BEFORE, PACE_NOW, PROPOSED, RULES_BEFORE, measure, playMatch, playTurn, tableSeconds, type MatchSeen, type RollSeen } from "../scripts/co-ty-phu-sim.ts";
import { mulberry32, prngRng } from "../tools/diff/rng.ts";

function newGame(seats: number, blitz: boolean, rng: Rng, maxRounds = 30): Game {
  const game = createGame();
  for (let seat = 0; seat < seats; seat++) game.players.push(newPlayer(`s${seat}`, "", `s${seat}`));
  game.settings = { limitMinutes: 0, salary: 200, cash: blitz ? 2000 : 1500, autoSeconds: 0, maxRounds, blitz };
  startGame(game, new Set(game.players.map((player) => player.id)), 0, rng);
  return game;
}

/** Dice as given, two a roll; every card drawn is the deck's last (repairs: nothing to pay while no house stands). */
const dice = (...faces: number[]): Rng => ({ die: () => faces.shift() ?? 1, below: (n) => n - 1 });
const cashOf = (game: Game) => game.players.reduce((sum, player) => sum + player.cash, 0);

test("the turn driver always finishes the turn, as the contract's does, and no coin is made or lost", () => {
  // The plan of the contract's own test of `play_turn` (contracts/deedlords/src/tests.rs).
  const plan: Plan = { buy_reserve: 100, build: OWNABLE_SQUARES, keep_reserve: 300, bail: true, liquidate: [] };
  for (const [seats, blitz, seed] of [[2, false, 1], [4, false, 2], [2, true, 3], [3, true, 4], [4, true, 5]] as const) {
    const rng = prngRng(mulberry32(seed));
    const game = newGame(seats, blitz, rng);
    assert.equal(Object.keys(game.props).length, blitz ? 5 * seats : 0);
    for (let turn = 0; turn < 400 && game.phase === "playing"; turn++) {
      const me = currentPlayer(game)!;
      const rolls = game.rolls;
      const seen = playTurn(game, me.id, plan, rng);
      assert.ok(game.rolls > rolls, "a turn rolls");
      assert.equal(seen.rolls.length, game.rolls - rolls, "and every roll is seen");
      const phase: string = game.phase;
      assert.ok(phase === "ended" || currentPlayer(game)!.id !== me.id || me.bankrupt, "the turn has passed");
      if (phase === "playing") assert.equal(game.stage, "roll");
      assert.equal(cashOf(game), game.minted, "all the cash is the bank's issue");
    }
    assert.equal(game.phase, "ended", `${seats} seats${blitz ? ", Blitz" : ""}: the match ends within its rounds`);
  }
});

test("the driver follows the plan: the reserve decides a purchase, the list a house, and a double throws again", () => {
  const buyer: Plan = { buy_reserve: 0, build: [], keep_reserve: 0, bail: false, liquidate: [] };
  // 1 + 2: Cape Town, 60.
  let game = newGame(2, false, dice());
  let first = currentPlayer(game)!.id;
  let seen = playTurn(game, first, buyer, dice(1, 2));
  assert.equal(game.props[3].owner, first);
  assert.deepEqual([seen.rolls.length, seen.rolls[0].steps, seen.rolls[0].offered, seen.rolls[0].bought], [1, 3, true, true]);
  // The same roll with a reserve the purchase would break: passed over.
  game = newGame(2, false, dice());
  first = currentPlayer(game)!.id;
  seen = playTurn(game, first, { ...buyer, buy_reserve: 1450 }, dice(1, 2));
  assert.equal(game.props[3], undefined);
  assert.deepEqual([seen.rolls[0].offered, seen.rolls[0].bought], [true, false]);
  // A double (onto Airport Tax), then Melbourne: two rolls in one turn.
  game = newGame(2, false, dice());
  first = currentPlayer(game)!.id;
  seen = playTurn(game, first, buyer, dice(2, 2, 1, 3));
  assert.deepEqual(seen.rolls.map((roll) => roll.steps), [4, 4]);
  assert.equal(game.props[8].owner, first);
  assert.notEqual(currentPlayer(game)!.id, first);

  // Blitz: one house a turn on each city of the list, while the cash kept back allows.
  game = newGame(2, true, prngRng(mulberry32(8)));
  first = currentPlayer(game)!.id;
  const cities = Object.keys(game.props).map(Number).filter((index) => game.props[index].owner === first && SQUARES[index].kind === "city");
  seen = playTurn(game, first, { ...buyer, buy_reserve: 100_000, build: cities }, dice(1, 3));
  assert.ok(cities.length > 0);
  assert.deepEqual(cities.map((index) => game.props[index].houses), cities.map(() => 1));
  assert.equal(seen.rolls[0].built, cities.length);
  assert.equal(seen.rolls[0].couldBuild, true);
});

test("the table's clock: a person's turn no longer pays for its end a second time", () => {
  const roll = (more: Partial<RollSeen> = {}): RollSeen => ({ steps: 7, card: false, sentOn: false, bought: false, offered: false, built: 0, couldBuild: false, debt: false, ...more });
  const one = (rolls: RollSeen[]): MatchSeen => ({ reason: "time", rounds: 1, ranking: ["s0"], worth: [], order: ["s0"], turns: [{ player: "s0", rolls, bankrupt: false }], bankruptcies: 0 });
  const person = () => true;
  const walk = 1.65 + 7 * 0.24;
  const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} is not ${expected}`);
  // Nothing to decide. Before: the throw (2 s), its transaction (2.5), the dice and the walk, 1.8 s, the end's
  // transaction. Now the end is sent when the roll lands: what is left to wait for is the piece and its moment (0.7 s).
  near(tableSeconds(one([roll()]), PACE_BEFORE, person), 2 + 2.5 + walk + 1.8 + 2.5);
  near(tableSeconds(one([roll()]), PACE_NOW, person), 2 + 2.5 + walk + 0.7);
  // A purchase (2.5 s to decide). Before: its transaction, 1.8 s, the end's. Now: one transaction for both.
  const bought = roll({ offered: true, bought: true });
  near(tableSeconds(one([bought]), PACE_BEFORE, person), 2 + 2.5 + walk + 2.5 + 2.5 + 1.8 + 2.5);
  near(tableSeconds(one([bought]), PACE_NOW, person), 2 + 2.5 + walk + 2.5 + 2.5);
  // An agent's turn is one transaction, seen at the next read of the match, then played on the board.
  near(tableSeconds(one([roll()]), PACE_NOW, () => false), 0.65 + 0.3 + 2.5 + 0.65 + walk + 0.7);
  // A card that sends the piece on is read (2.8 s) before the second leg (1.6 s).
  near(tableSeconds(one([roll({ card: true, sentOn: true })]), PACE_NOW, () => false), 0.65 + 0.3 + 2.5 + 0.65 + walk + 2.8 + 1.6 + 0.7);
});

test("a match is played the same from the same seed, and ranks every seat", () => {
  const rules = { ...RULES, maxRounds: roundsFor(4) };
  const a = playMatch(4, rules, 77);
  assert.deepEqual(playMatch(4, rules, 77), a);
  assert.notDeepEqual(playMatch(4, rules, 78).turns, a.turns);
  assert.deepEqual([...a.ranking].sort(), ["s0", "s1", "s2", "s3"]);
  assert.ok(a.rounds <= rules.maxRounds);
  assert.equal(a.worth.length, a.reason === "time" ? rules.maxRounds : a.worth.length);
  assert.equal(a.worth.at(-1)!.indexOf(Math.max(...a.worth.at(-1)!)), a.order.indexOf(a.ranking[0]), "the winner is whoever is worth most at the end");
});

test("the rules matches are opened with: about ten minutes on the table, where the rules before took most of an hour", () => {
  // Small samples, wide bands: the figures themselves come from the script's own run (thousands of matches).
  for (const seats of [2, 4]) {
    const now = measure(seats, { ...RULES, maxRounds: roundsFor(seats) }, 80, 5, PACE_NOW);
    assert.ok(now.rounds.mean <= roundsFor(seats));
    assert.ok(now.minutes.solo.mean > 5 && now.minutes.solo.mean < 11, `${seats} seats, one person against agents: ${now.minutes.solo.mean} minutes`);
    assert.ok(now.minutes.people.mean > 8 && now.minutes.people.mean < 15, `${seats} seats of people: ${now.minutes.people.mean} minutes`);
    assert.ok(now.minutes.slow.people.mean < 20, `${seats} seats of people who take their time: ${now.minutes.slow.people.mean} minutes`);
    assert.ok(now.houses > 10, "houses go up");
    // Whoever is behind at half-time still wins a share of matches worth playing for.
    assert.ok(now.leaderWins.half < 0.9 && now.leaderWins.half > 1 / seats);
  }
  const before = measure(2, { ...RULES_BEFORE, maxRounds: TO_THE_END }, 30, 5, PACE_BEFORE);
  assert.ok(before.rounds.mean > 60, `to the end took ${before.rounds.mean} rounds`);
  assert.ok(before.minutes.solo.mean > 25 && before.minutes.people.mean > 35);
  const short = measure(2, { ...RULES_BEFORE, maxRounds: 12 }, 60, 5, PACE_BEFORE);
  assert.ok(short.houses < 4, "under the rules before a house went up only where a piece happened to stop");
});

test("the rules proposed are modelled on top of the engine: no coin is made or lost, and the leader's hold loosens", () => {
  const rules = { ...RULES, maxRounds: roundsFor(4) };
  const deployed = measure(4, rules, 300, 9, PACE_NOW);
  for (const [name, mods] of PROPOSED) {
    // `playMatch` throws when the cash on the table is not what the bank issued.
    const proposed = measure(4, rules, 300, 9, PACE_NOW, mods);
    assert.ok(proposed.leaderWins.half < deployed.leaderWins.half, `${name}: whoever leads at half wins ${proposed.leaderWins.half}, as deployed ${deployed.leaderWins.half}`);
  }
});
