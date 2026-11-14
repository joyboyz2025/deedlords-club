// The game the owner settled on (docs/ENGINE-RULES.md §10.7): nothing is dealt, and a city takes its first house in
// the stop it is bought in, then one more each time its owner stops there again.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Brief } from "../games/co-ty-phu/agent/brief.ts";
import { buildMessages } from "../games/co-ty-phu/agent/llm.ts";
import { withPurchases } from "../games/co-ty-phu/agent/tickets.ts";
import { RULES, createDuelCall, extrasOf, rulesWith } from "../games/co-ty-phu/chain/calls.ts";
import { build, buy, canBuild, createGame, currentPlayer, endTurn, newPlayer, roll, startGame, type Game, type Rng } from "../games/co-ty-phu/engine.ts";

const first: Rng = { die: () => 1, below: () => 0 };

function classic(buildOnBuy: boolean): { game: Game; mover: string } {
  const game = createGame();
  game.players.push(newPlayer("s0", "", "s0"), newPlayer("s1", "", "s1"));
  game.settings = { limitMinutes: 0, salary: 200, cash: 2000, autoSeconds: 0, maxRounds: 20, blitz: false, ...(buildOnBuy ? { buildOnBuy: true } : {}) };
  startGame(game, new Set(["s0", "s1"]), 0, first);
  return { game, mover: currentPlayer(game)!.id };
}

test("nothing is dealt, and without the rule a city bought takes no house in that stop", () => {
  const { game, mover } = classic(false);
  assert.deepEqual(game.props, {});
  roll(game, mover, [1, 2]);
  assert.equal(game.stage, "buy");
  buy(game, mover);
  assert.ok(!canBuild(game, mover, 3));
});

test("with buildOnBuy the city just bought takes one house, and one more at a later stop there", () => {
  const { game, mover } = classic(true);
  roll(game, mover, [1, 2]);
  assert.ok(!canBuild(game, mover, 3), "not before it is bought");
  buy(game, mover);
  assert.ok(canBuild(game, mover, 3));
  build(game, mover, 3);
  assert.equal(game.props[3].houses, 1);
  assert.ok(!canBuild(game, mover, 3), "one house with the purchase, not two");
  endTurn(game, mover);
  // Another turn of the same seat, not standing there: nothing to build.
  const other = currentPlayer(game)!.id;
  roll(game, other, [1, 1]);
  assert.ok(!canBuild(game, mover, 3));
});

test("the page opens that game where the contract has the rule, and the Blitz match of before where it has not", () => {
  const terms = { stake: 0n, maxRounds: 20, turnSeconds: 30 };
  const rulesOf = (features: string[]) => JSON.parse(Buffer.from(createDuelCall("m", { ...terms, extras: extrasOf({ features }) }).args).toString()).rules;
  const all = ["tickets", "leaderRent", "buildHere", "hostGrace", "away", "close", "buildOne", "buildOnBuy"];
  assert.deepEqual(rulesOf(all), { salary: 200, cash: 2000, blitz: false, max_rounds: 20, tickets: true, leaderRent: true, buildOnBuy: true });
  assert.deepEqual(rulesOf(all.filter((name) => name !== "buildOnBuy")), { ...RULES, max_rounds: 20, tickets: true, leaderRent: true, buildHere: true });
  assert.deepEqual(rulesWith(extrasOf({ features: [] })), RULES);
});

test("an agent's plan lists the free cities in reach for the house that comes with a purchase", () => {
  const brief = {
    reach: [
      { steps: 3, square: 3, name: "Cape Town", chance: 0.05, what: "free", amount: 60 },
      { steps: 5, square: 5, name: "Panama Canal", chance: 0.1, what: "free", amount: 200 },
      { steps: 6, square: 6, name: "Mumbai", chance: 0.1, what: "rent", amount: 10 },
    ],
  } as unknown as Brief;
  assert.deepEqual(withPurchases(brief, [1]), [1], "not in a match without the rule");
  assert.deepEqual(withPurchases({ ...brief, buildOnBuy: true }, [1]), [1, 3], "the free city, not the sea passage, not somebody's city");
  assert.ok(buildMessages({ blitz: false, buildOnBuy: true } as Brief).system.includes("first house in the same stop"));
  assert.ok(!buildMessages({ blitz: false } as Brief).system.includes("first house in the same stop"));
});
