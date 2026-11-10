// The adapter against real answers of the contract (tests/fixtures/chain-duel.json, written by
// `npm run capture` in contracts/sandbox: one short duel on a local near-sandbox, with the match before and after each
// of its first play() calls).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { applyAction, chainView, deadlineMs, formatBps, formatNear, logLine, needsDice, seatNames, seatOf, settledGame, shortAccount, toAction, toGame } from "../games/co-ty-phu/chain/adapt.ts";
import type { ChainEvent, ChainListed, ChainMatch, ChainResult, ContractAction, PlayOutcome } from "../games/co-ty-phu/chain/types.ts";
import type { Game } from "../games/co-ty-phu/engine.ts";

type Call = { seat: number; actions: ContractAction[]; returned: PlayOutcome; before: ChainMatch; after: ChainMatch | null };
const fixture = JSON.parse(readFileSync(new URL("./fixtures/chain-duel.json", import.meta.url), "utf8")) as {
  lobby: ChainMatch;
  listed: ChainListed[];
  started: ChainMatch;
  mid: ChainMatch;
  calls: Call[];
  afterSettle: null;
  result: ChainResult;
};

/** Everything the rules decide. The log is worded here, and `lastRound` is derived when the answer is read. */
function core(game: Game) {
  const { log: _log, lastRound: _lastRound, ...rest } = game;
  return rest;
}

test("a lobby: every seat has its player, nobody has a colour yet", () => {
  const game = toGame(fixture.lobby);
  assert.equal(game.phase, "lobby");
  assert.deepEqual(game.players.map((p) => [p.id, p.name, p.color, p.cash]), [["s0", "alice", null, 0], ["s1", "Seat 2", null, 0]]);
  assert.equal(deadlineMs(fixture.lobby.meta), null);
  assert.equal(seatOf(fixture.lobby.meta, "alice.sandbox"), 0);
  assert.equal(seatOf(fixture.lobby.meta, "bob.sandbox"), null);
  assert.equal(fixture.listed[0].phase, "lobby");
  assert.deepEqual(seatNames(fixture.listed[0]), ["alice", "Seat 2"]);
});

test("a running match becomes the engine's game, with names and the match's rules", () => {
  const game = toGame(fixture.mid);
  const { rules, turn_seconds } = fixture.mid.meta;
  assert.equal(game.phase, "playing");
  assert.deepEqual(game.players.map((p) => [p.name, p.color]), [["alice", 0], ["bob", 1]]);
  assert.deepEqual(game.settings, { limitMinutes: 0, salary: rules.salary, cash: rules.cash, autoSeconds: turn_seconds, maxRounds: rules.maxRounds, blitz: false });
  assert.equal(game.log.length, fixture.mid.log.length);
  assert.match(game.log[0], /^(alice|bob) goes first\.$/);
  for (const line of game.log) assert.doesNotMatch(line, /undefined|\bs[01]\b/);
  // A changed copy leaves the answer alone.
  game.players[0].cash += 1;
  game.props[39] = { owner: "s0", houses: 0, mortgaged: false };
  assert.deepEqual(toGame(fixture.mid).props, fixture.mid.game.props);

  const deadline = deadlineMs(fixture.mid.meta)!;
  assert.equal(deadline, Number(BigInt(fixture.mid.meta.turn_deadline) / 1_000_000n));
  const mine = chainView(toGame(fixture.mid), fixture.mid.meta, "bob.sandbox", deadline - 4_000, deadline);
  assert.equal(mine.you.id, "s1");
  assert.equal(mine.code, fixture.mid.meta.id);
  assert.equal(mine.autoInMs, 4_000);
  assert.equal(mine.players.length, 2);
  const watched = chainView(toGame(fixture.mid), fixture.mid.meta, "carol.sandbox", deadline, null);
  assert.equal(watched.you.id, "watcher");
  assert.equal(watched.you.name, "carol");
  assert.deepEqual(watched.you.can, { build: [], sell: [], mortgage: [], redeem: [] });
  assert.deepEqual(watched.order, fixture.mid.game.order);
});

test("moves without dice give here exactly what the contract gave", () => {
  let replayed = 0;
  for (const call of fixture.calls) {
    assert.equal(call.returned.rejected, null);
    const game = toGame(call.before);
    const playerId = call.before.meta.seats[call.seat].player;
    if (call.actions.some((action) => needsDice(game, action))) {
      assert.equal(applyAction(game, playerId, call.actions[0]), false, "a roll is the chain's alone");
      assert.deepEqual(core(game), core(toGame(call.before)));
      continue;
    }
    for (const action of call.actions) assert.equal(applyAction(game, playerId, action), true, JSON.stringify(action));
    assert.ok(call.after, "the capture keeps calls made before the last one");
    assert.deepEqual(core(game), core(toGame(call.after)));
    replayed += 1;
  }
  assert.ok(replayed >= 4, `only ${replayed} calls without dice in the fixture`);
  // Out of turn, or twice: the rules refuse, and nothing changes.
  const first = fixture.calls.find((call) => call.actions[0] === "Buy")!;
  const game = toGame(first.before);
  const other = first.before.meta.seats[1 - first.seat].player;
  assert.equal(applyAction(game, other, "Buy"), false);
  assert.equal(applyAction(game, first.before.meta.seats[first.seat].player, "End"), false);
  assert.deepEqual(core(game), core(toGame(first.before)));
});

test("a settled match: no board left, the result names seats", () => {
  assert.equal(fixture.afterSettle, null);
  const game = settledGame(toGame(fixture.mid), fixture.mid.meta, fixture.result);
  assert.equal(game.phase, "ended");
  assert.deepEqual(game.result, { reason: fixture.result.reason, ranking: fixture.result.ranking.map((seat) => `s${seat}`) });
  assert.equal(settledGame(game, fixture.mid.meta, fixture.result), game);
  // 1 NEAR a seat, 2.5% of the pot to the contract, the rest split 70 / 30.
  const { pot, fee, payouts } = fixture.result;
  assert.equal(fixture.mid.meta.fee_bps, 250);
  assert.equal(formatBps(fixture.mid.meta.fee_bps), "2.5%");
  assert.equal(formatNear(pot), "2");
  assert.equal(formatNear(fee), "0.05");
  assert.equal(formatNear(payouts[0]), "1.365");
  assert.equal(formatNear(payouts[1]), "0.585");
  assert.equal(BigInt(payouts[0]) + BigInt(payouts[1]) + BigInt(fee), BigInt(pot));
});

test("screen messages map to contract actions; what the contract lacks maps to nothing", () => {
  const cases: [Parameters<typeof toAction>[0], ContractAction | null][] = [
    [{ t: "roll" }, "Roll"],
    [{ t: "buy" }, "Buy"],
    [{ t: "skip" }, "Skip"],
    [{ t: "end" }, "End"],
    [{ t: "bail" }, "Bail"],
    [{ t: "card" }, "Card"],
    [{ t: "pay" }, "Pay"],
    [{ t: "bankrupt" }, "Bankrupt"],
    [{ t: "build", square: 39 }, { Build: 39 }],
    [{ t: "sell", square: 1 }, { Sell: 1 }],
    [{ t: "mortgage", square: 0 }, { Mortgage: 0 }],
    [{ t: "redeem", square: 5 }, { Redeem: 5 }],
    [{ t: "build", square: 40 }, null],
    [{ t: "sell", square: 1.5 }, null],
    [{ t: "start" }, null],
    [{ t: "lobby" }, null],
    [{ t: "withdraw" }, null],
    [{ t: "answer", accept: true }, null],
    [{ t: "auto", seconds: 10 }, null],
  ];
  for (const [message, action] of cases) assert.deepEqual(toAction(message), action, JSON.stringify(message));
});

test("every kind of log entry reads as a sentence", () => {
  const names: Record<string, string> = { s0: "alice", s1: "House" };
  const events: ChainEvent[] = [
    { kind: "start", first: "s1" },
    { kind: "roll", player: "s0", dice: [6, 1] },
    { kind: "salary", player: "s0", amount: 200 },
    { kind: "buy", player: "s0", square: 1, price: 60 },
    { kind: "skip", player: "s0", square: 3 },
    { kind: "rent", player: "s0", owner: "s1", square: 9, amount: 8 },
    { kind: "tax", player: "s0", square: 4, amount: 200 },
    { kind: "card", player: "s0", deck: "chance", index: 4 },
    { kind: "jailed", player: "s0" },
    { kind: "released", player: "s0", by: "doubles" },
    { kind: "released", player: "s0", by: "bail" },
    { kind: "released", player: "s0", by: "card" },
    { kind: "released", player: "s0", by: "fine" },
    { kind: "build", player: "s0", square: 1, houses: 2 },
    { kind: "build", player: "s0", square: 1, houses: 5 },
    { kind: "sell", player: "s0", square: 1 },
    { kind: "mortgage", player: "s0", square: 1, amount: 30 },
    { kind: "redeem", player: "s0", square: 1, amount: 33 },
    { kind: "paidDebt", player: "s0", amount: 120 },
    { kind: "bankrupt", player: "s0", creditor: "s1" },
    { kind: "auto", player: "s0" },
    { kind: "end", reason: "time" },
    { kind: "end", reason: "last" },
  ];
  const lines = events.map((event) => logLine(event, (id) => names[id] ?? id));
  for (const line of lines) {
    assert.ok(line.length > 12, line);
    assert.doesNotMatch(line, /undefined|NaN|\bs[01]\b/);
  }
  assert.equal(lines[0], "House goes first.");
  assert.equal(lines[1], "alice rolls 6-1.");
  assert.match(lines[5], /^alice pays House 8 rent at .+\.$/);
  assert.match(lines[14], /^alice builds a hotel in .+\.$/);
  assert.equal(new Set(lines).size, lines.length);
});

test("names and amounts", () => {
  assert.equal(shortAccount("p1.deedlords.testnet"), "p1");
  assert.equal(shortAccount("someone.near"), "someone");
  assert.equal(shortAccount("a".repeat(64)), "aaaaaa…aaaa");
  const meta = structuredClone(fixture.mid.meta);
  meta.seats = [
    { seat: 0, player: "s0", backer: "carol.sandbox", driver: null, house: false },
    { seat: 1, player: "s1", backer: "house.sandbox", driver: "bot.sandbox", house: true },
    { seat: 2, player: "s2", backer: "house.sandbox", driver: null, house: true },
  ];
  assert.deepEqual(seatNames(meta), ["carol", "House 1", "House 2"]);
  assert.equal(seatOf(meta, "bot.sandbox"), 1, "a driver moves for the seat");
  assert.equal(seatOf(meta, null), null);
  assert.equal(formatNear("0"), "0");
  assert.equal(formatNear("1000000000000000000000000"), "1");
  assert.equal(formatNear("47550000000000000000000"), "0.0475");
  assert.equal(formatNear("2499999999999999999999999", 2), "2.49");
});
