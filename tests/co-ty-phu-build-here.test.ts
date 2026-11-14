// Building only where one stops (docs/ENGINE-RULES.md §10.5): in a Blitz game with `buildHere`, a house goes up only on
// the own city the piece has just stopped on, one per stop; without it, Blitz builds as it did. And what the page asks
// the contract for.

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMessages } from "../games/co-ty-phu/agent/llm.ts";
import type { Brief } from "../games/co-ty-phu/agent/brief.ts";
import { RULES, createDuelCall, extrasOf } from "../games/co-ty-phu/chain/calls.ts";
import { build, canBuild, createGame, currentPlayer, newPlayer, roll, startGame, type Game, type Rng } from "../games/co-ty-phu/engine.ts";
import { viewFor } from "../games/co-ty-phu/view.ts";

/** Hands out zeros for every draw of the start (the order, the Blitz deal's shuffle). */
const zeros: Rng = { die: () => 1, below: () => 0 };

function blitz(rule: boolean | "one"): { game: Game; mover: string } {
  const game = createGame();
  game.players.push(newPlayer("s0", "", "s0"), newPlayer("s1", "", "s1"));
  game.settings = {
    limitMinutes: 0,
    salary: 200,
    cash: 2000,
    autoSeconds: 0,
    maxRounds: 20,
    blitz: true,
    ...(rule === "one" ? { buildOne: true } : rule ? { buildHere: true } : {}),
  };
  startGame(game, new Set(["s0", "s1"]), 0, zeros);
  const mover = currentPlayer(game)!.id;
  // Whoever goes first owns cities 1 and 3 and nothing else is owned.
  game.props = { 1: { owner: mover, houses: 0, mortgaged: false }, 3: { owner: mover, houses: 0, mortgaged: false } };
  return { game, mover };
}

test("plain Blitz: a house on any own city, once a turn each", () => {
  const { game, mover } = blitz(false);
  roll(game, mover, [1, 2]);
  assert.equal(currentPlayer(game)!.position, 3);
  assert.ok(canBuild(game, mover, 1));
  assert.ok(canBuild(game, mover, 3));
});

test("Blitz with buildHere: only the own city stopped on, one house per stop", () => {
  const { game, mover } = blitz(true);
  assert.ok(!canBuild(game, mover, 1), "nothing before the throw");
  assert.ok(!canBuild(game, mover, 3));
  roll(game, mover, [1, 2]);
  assert.equal(currentPlayer(game)!.position, 3);
  assert.ok(!canBuild(game, mover, 1), "not a city it did not stop on");
  assert.ok(canBuild(game, mover, 3));
  build(game, mover, 1);
  assert.equal(game.props[1].houses, 0);
  build(game, mover, 3);
  assert.equal(game.props[3].houses, 1);
  assert.ok(!canBuild(game, mover, 3), "one house per stop");
});

test("the page asks for buildHere only from a contract that lists it", () => {
  const terms = { stake: 0n, maxRounds: 20, turnSeconds: 30 };
  const rulesOf = (features: string[]) => JSON.parse(Buffer.from(createDuelCall("m", { ...terms, extras: extrasOf({ features }) }).args).toString()).rules;
  assert.deepEqual(rulesOf(["tickets", "leaderRent"]), { ...RULES, max_rounds: 20, tickets: true, leaderRent: true });
  assert.deepEqual(rulesOf(["tickets", "leaderRent", "buildHere"]), { ...RULES, max_rounds: 20, tickets: true, leaderRent: true, buildHere: true });
  assert.equal(extrasOf({ features: ["buildHere"] }, true).buildHere, false, "switched off for this deployment of the page");
  // A contract that has the later rule is asked for that one, not for both.
  assert.deepEqual(rulesOf(["tickets", "leaderRent", "buildHere", "buildOne"]), { ...RULES, max_rounds: 20, tickets: true, leaderRent: true, buildOne: true });
});

test("a model is told the rule only in a match that has it", () => {
  const brief = { blitz: true } as Brief;
  assert.ok(!buildMessages(brief).system.includes("only on your own city that you stop on"));
  assert.ok(buildMessages({ ...brief, buildHere: true }).system.includes("only on your own city that you stop on"));
});

test("the table offers the house exactly then: the viewer's own city, when their piece has stopped on it", () => {
  const { game, mover } = blitz(true);
  const offered = () => viewFor(game, mover, { code: "m", online: new Set(["s0", "s1"]), now: 0, autoAt: null }).you.can.build;
  assert.deepEqual(offered(), []);
  roll(game, mover, [1, 2]);
  assert.deepEqual(offered(), [3]);
  build(game, mover, 3);
  assert.deepEqual(offered(), []);
});

test("Blitz with buildOne: one house a turn in all, on any own city, before the throw or after it", () => {
  const { game, mover } = blitz("one");
  assert.ok(canBuild(game, mover, 1), "before the throw too");
  assert.ok(canBuild(game, mover, 3));
  build(game, mover, 1);
  assert.equal(game.props[1].houses, 1);
  assert.ok(!canBuild(game, mover, 1), "that was the turn's house");
  assert.ok(!canBuild(game, mover, 3));
  roll(game, mover, [1, 2]);
  assert.ok(!canBuild(game, mover, 3), "not even where the piece stopped");
  build(game, mover, 3);
  assert.equal(game.props[3].houses, 0);
  const offered = viewFor(game, mover, { code: "m", online: new Set(["s0", "s1"]), now: 0, autoAt: null }).you.can.build;
  assert.deepEqual(offered, []);
});

test("a model is told of one house a turn only in a match that has it", () => {
  const brief = { blitz: true } as Brief;
  assert.ok(!buildMessages(brief).system.includes("one house a turn in all"));
  assert.ok(buildMessages({ ...brief, buildOne: true }).system.includes("one house a turn in all"));
});
