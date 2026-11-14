// A seat at a poker table of two to nine seats (games/poker/table): what it may bet, which shares it owes and when,
// and what its agent is told and answers. Whole hands against the contract are played by
// contracts/sandbox/poker-table-run.js.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { LlmConfig } from "../games/co-ty-phu/agent/llm.ts";
import { winChance } from "../games/poker/agent/hands.ts";
import { keyProof, newKeys, openDeck, tableKey } from "../games/poker/crypto.ts";
import { shuffle } from "../games/poker/shuffle.ts";
import { advise, briefFor, byTheBook } from "../games/poker/table/decide.ts";
import {
  type SeatStore,
  type TableView,
  betCall,
  betOptions,
  callsTime,
  clockAhead,
  clockMarginMs,
  clockMove,
  contenders,
  duty,
  fromBase64,
  holeCards,
  nextDealt,
  toBase64,
  tookEffect,
} from "../games/poker/table/seat.ts";

const card = (name: string): number => "23456789TJQKA".indexOf(name[0]) + 13 * "cdhs".indexOf(name[1]);
const cards = (names: string): number[] => names.split(" ").map(card);

/** The same numbers every run. */
function dice(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A table of six seats, four taken (seats 0, 1, 3, 4), at the first bet of a hand whose button is seat 3: seat 4 posted
 * the small blind, seat 0 the big blind, and seat 1 is first to act.
 */
function table(more: Partial<TableView> = {}): TableView {
  return {
    id: "t",
    phase: "bet",
    stake: "100000000000000000000000",
    deposit: "102000000000000000000000",
    host: "a.testnet",
    feeBps: 0,
    players: ["a.testnet", "b.testnet", null, "d.testnet", "e.testnet", null],
    keys: ["", "", "", "", "", ""],
    turnSeconds: 300,
    deadline: "0",
    chips: [99, 98, 0, 100, 100, 0],
    hand: 4,
    button: 3,
    dealt: [3, 4, 0, 1],
    key: "",
    shuffled: 4,
    street: 0,
    toAct: 1,
    awaited: [1],
    put: [2, 0, 0, 0, 1, 0],
    bet: [2, 0, 0, 0, 1, 0],
    folded: [false, false, false, false, false, false],
    done: [false, false, false, false, false, false],
    leaving: [false, false, false, false, false, false],
    sums: [],
    board: [],
    hole: [[], [], [], [], [], []],
    last: null,
    cashed: [],
    seq: 20,
    bets: 7,
    ...more,
  };
}

test("the seats of a hand are the seats taken, the button first", () => {
  assert.deepEqual(nextDealt(table()), [3, 4, 0, 1]);
  assert.deepEqual(nextDealt(table({ button: 0 })), [0, 1, 3, 4]);
  // The button's seat was given up: the contract moves the button, and until it has the first seat taken leads.
  assert.deepEqual(nextDealt(table({ button: 2 })), [0, 1, 3, 4]);
  assert.deepEqual(contenders(table({ folded: [true, false, false, false, false, false] })), [3, 4, 1]);
});

test("a seat may bet what the contract takes", () => {
  // The big blind is 2: a seat with nothing in owes 2 and may raise to 4 or more, up to all it has.
  assert.deepEqual(betOptions(table(), 3), { owed: 2, raise: { min: 4, max: 100 } });
  // A seat with less than it owes can only call all in or fold.
  assert.deepEqual(betOptions(table({ chips: [0, 98, 0, 30, 100, 0], bet: [50, 0, 0, 0, 1, 0] }), 3), { owed: 30, raise: null });
  // A seat that can cover the bet by less than the big blind may raise all in only.
  assert.deepEqual(betOptions(table({ chips: [0, 98, 0, 51, 100, 0], bet: [50, 0, 0, 0, 1, 0] }), 3), { owed: 50, raise: { min: 51, max: 51 } });
  // Nobody is left who could answer a raise: the others still in are all in.
  assert.deepEqual(betOptions(table({ chips: [0, 0, 0, 100, 0, 0], bet: [40, 40, 0, 0, 40, 0] }), 3), { owed: 40, raise: null });
  assert.deepEqual(betOptions(table({ chips: [0, 0, 0, 100, 100, 0], bet: [40, 40, 0, 0, 40, 0], folded: [false, false, false, false, true, false] }), 3), { owed: 40, raise: null });
});

test("a seat owes its shuffle, then its shares for the cards it must not see alone", async () => {
  const names = ["a.testnet", "b.testnet", "d.testnet", "e.testnet"];
  const keys = names.map(() => newKeys());
  const publicKeys = ["", "", "", "", "", ""];
  [0, 1, 3, 4].forEach((seat, index) => (publicKeys[seat] = toBase64(keys[index].publicKey)));
  assert.equal(keyProof(keys[0], names[0]).length, 160);
  const between = table({ phase: "shuffle", shuffled: 0, dealt: [], key: "", awaited: [3], keys: publicKeys });
  const none: SeatStore = { deck: () => Promise.reject(new Error("no deck is read for the first shuffle")) };
  // The button shuffles the open deck under the keys of the four seats taken, and says which key that is.
  const first = await duty(between, 3, keys[2], none);
  const key = tableKey(keys.map((one) => one.publicKey));
  assert.equal(first?.method, "shuffle");
  assert.equal(first?.args.key, toBase64(key));
  assert.equal(await duty(between, 4, keys[3], none), null, "only the button starts a hand");

  // The second seat shuffles the first seat's deck, under the key the table shows.
  const deck = fromBase64(first!.args.deck as string);
  const read: number[][] = [];
  const store: SeatStore = {
    deck: async (hand, step) => {
      read.push([hand, step]);
      return deck;
    },
  };
  const second = await duty(table({ phase: "shuffle", shuffled: 1, key: toBase64(key), awaited: [4], keys: publicKeys }), 4, keys[3], store);
  assert.deepEqual([second?.method, second?.args.key, read], ["shuffle", toBase64(key), [[4, 0]]]);

  // Dealing: every other seat's two hole cards, six shares for a seat of four, from the deck after the fourth shuffle.
  const shares = (call: { args: Record<string, unknown> } | null) => fromBase64(call!.args.tokens as string).length / 224;
  read.length = 0;
  const dealing = await duty(table({ phase: "deal", awaited: [3, 4, 0, 1], keys: publicKeys, key: toBase64(key) }), 0, keys[0], store);
  assert.deepEqual([dealing?.method, shares(dealing), read], ["deal", 6, [[4, 3]]]);
  // A street: three shares for the flop, one for the turn and the river; the showdown: the seat's own two.
  const flop = await duty(table({ phase: "open", street: 1, awaited: [0, 1], keys: publicKeys }), 0, keys[0], store);
  const river = await duty(table({ phase: "open", street: 3, awaited: [0, 1], keys: publicKeys, board: cards("2c 3c 4c 5c") }), 1, keys[1], store);
  const showing = await duty(table({ phase: "showdown", street: 3, awaited: [0], keys: publicKeys }), 0, keys[0], store);
  assert.deepEqual([flop?.method, shares(flop), river?.method, shares(river), showing?.method, shares(showing)], ["open", 3, "open", 1, "show", 2]);
  assert.equal(await duty(table({ phase: "open", street: 1, awaited: [0, 1] }), 3, keys[2], store), null, "a seat that is not awaited owes nothing");

  // A fold carries the shares for the board cards not yet open: five before the flop, two after it, none on the river.
  const fold = async (board: string) => (await betCall(table({ board: board ? cards(board) : [] }), 3, "fold", undefined, keys[2], store)).args;
  assert.equal(fromBase64((await fold("")).tokens as string).length, 5 * 224);
  assert.equal(fromBase64((await fold("2c 3c 4c")).tokens as string).length, 2 * 224);
  assert.equal((await fold("2c 3c 4c 5c 6c")).tokens, null);
  // Every bet names the count of bets it was chosen at, so that a copy sent again is refused.
  assert.deepEqual((await betCall(table(), 3, "raise", 12, keys[2], store)).args, { id: "t", seat: 3, action: "raise", amount: 12, tokens: null, bets: 7 });
  assert.deepEqual((await betCall(table(), 3, "call", 12, keys[2], store)).args, { id: "t", seat: 3, action: "call", amount: null, tokens: null, bets: 7 });
  // Before the cards are dealt a seat has no cards to read; a seat that is not in the hand never has.
  assert.equal(holeCards(table({ phase: "deal" }), 3, keys[2], deck), null);
  assert.equal(holeCards(table(), 2, keys[2], deck), null);
  // The deck this was done with is a real shuffle, proved.
  assert.equal(shuffle(openDeck(), key).proof.length, 10_144);
});

test("a hand is worth less the more seats are in", () => {
  const near = (value: number, wanted: number, by: number) => assert.ok(Math.abs(value - wanted) <= by, `${value} is not within ${by} of ${wanted}`);
  // Known figures for a pair of aces before the flop: about 85% against one random hand, 64% against three, 35% against eight.
  near(winChance(cards("As Ah"), [], 6_000, dice(1), 1), 0.85, 0.02);
  near(winChance(cards("As Ah"), [], 6_000, dice(2), 3), 0.64, 0.025);
  near(winChance(cards("As Ah"), [], 6_000, dice(3), 8), 0.35, 0.025);
  // The nuts cannot lose to any number of hands; a hand that plays the board splits with all of them.
  assert.equal(winChance(cards("As Ks"), cards("Qs Js Ts 2c 3d"), 200, dice(4), 5), 1);
  near(winChance(cards("2c 3d"), cards("As Ks Qs Js Ts"), 200, dice(5), 4), 0.2, 0.001);
});

test("an agent is told what its seat can see at a table of several", () => {
  // Seat 1 opened to 8; the button, seat 3, is to act.
  const view = table({ toAct: 3, awaited: [3], bet: [2, 8, 0, 0, 1, 0], put: [2, 8, 0, 0, 1, 0], chips: [98, 92, 0, 100, 99, 0] });
  const brief = briefFor(view, 3, cards("As Kd"), { samples: 400, random: dice(6) });
  assert.deepEqual(
    { ...brief, winChance: 0 },
    {
      street: "pre-flop",
      hand: 5,
      seatsDealt: 4,
      seatsStillIn: 4,
      position: "button",
      yourCards: ["As", "Kd"],
      board: [],
      youHold: null,
      pot: 11,
      toCall: 8,
      potOdds: 0.42,
      winChance: 0,
      yourChips: 100,
      yourBet: 0,
      highestBet: 8,
      // The other seats, in the order they act after the button: the blinds (seats 4 and 0), then seat 1.
      others: [
        { chips: 99, bet: 1, allIn: false },
        { chips: 98, bet: 2, allIn: false },
        { chips: 92, bet: 8, allIn: false },
      ],
      raiseTo: { min: 10, max: 100 },
      blinds: [1, 2],
    },
  );
  assert.ok(brief.winChance > 0.3 && brief.winChance < 0.5, `${brief.winChance}`);
  assert.deepEqual(["button", "small blind", "big blind", "1 after the big blind"], [3, 4, 0, 1].map((seat) => briefFor(table(), seat, cards("As Kd"), { samples: 20 }).position));
  assert.equal(briefFor(table({ dealt: [3, 4], players: [null, null, null, "d.testnet", "e.testnet", null] }), 3, cards("As Kd"), { samples: 20 }).position, "button and small blind");
  // The raise it is offered is the raise the page offers and the contract takes.
  assert.deepEqual(brief.raiseTo, betOptions(view, 3).raise);
});

test("by the odds alone it raises its best hands and folds what a call does not pay for", async () => {
  const nine = table({
    players: ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((name) => `${name}.testnet`),
    dealt: [0, 1, 2, 3, 4, 5, 6, 7, 8],
    button: 0,
    toAct: 3,
    chips: [100, 99, 98, 100, 100, 100, 100, 100, 100],
    bet: [0, 1, 2, 0, 0, 0, 0, 0, 0],
    put: [0, 1, 2, 0, 0, 0, 0, 0, 0],
    folded: new Array(9).fill(false),
    done: new Array(9).fill(false),
    leaving: new Array(9).fill(false),
    hole: new Array(9).fill([]),
  });
  const aces = byTheBook(briefFor(nine, 3, cards("As Ah"), { samples: 800, random: dice(7) }));
  assert.equal(aces.action, "raise");
  assert.ok(aces.amount! >= 4 && aces.amount! <= 100);
  const rags = byTheBook(briefFor(nine, 3, cards("7c 2d"), { samples: 800, random: dice(8) }));
  assert.deepEqual([rags.action, /random hands/.test(rags.reason) || /the call needs/.test(rags.reason)], ["fold", true]);
  // Nothing to call: never a fold.
  const free = table({ street: 1, board: cards("Ks 7d 2c"), bet: [0, 0, 0, 0, 0, 0], put: [4, 4, 0, 4, 4, 0], chips: [96, 96, 0, 96, 96, 0], toAct: 4, awaited: [4] });
  assert.notEqual(byTheBook(briefFor(free, 4, cards("3h 4d"), { samples: 300, random: dice(9) })).action, "fold");

  // A model's answer is held inside what the contract takes, and the odds answer when it fails.
  const llm: LlmConfig = { baseUrl: "https://model.test/v1", apiKey: "k", model: "m", label: "m" };
  let sent = "";
  const answering = (content: string): typeof fetch =>
    (async (_url: unknown, init?: { body?: unknown }) => {
      sent = String(init?.body);
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }) as unknown as typeof fetch;
  const asked = await advise(nine, 3, cards("As Ah"), { llm, style: "Press every edge.", samples: 100, fetch: answering('{"action":"raise","amount":500,"reason":"Aces."}') });
  assert.deepEqual(asked, { action: "raise", amount: 100, reason: "Aces.", driver: "m" });
  assert.ok(sent.includes("Press every edge.") && sent.includes("two to nine seats") && sent.includes('\\"seatsDealt\\":9'));
  const failed = await advise(nine, 3, cards("7c 2d"), { llm, samples: 100, fetch: answering("no idea") });
  assert.deepEqual([failed.action, failed.driver, failed.fallback], ["fold", "the book", true]);
});

test("a call the node gave no receipt for landed only if the table shows what it would have changed", () => {
  // Seat 0 (a.testnet) asked to leave between hands and the node did not answer. Then the button shuffled: the table
  // changed, but the seat is still there and is not leaving. On 2026-11-14 the page wrote "the table shows it landed".
  const before = table({ phase: "shuffle", dealt: [], shuffled: 0, awaited: [3] });
  const shuffled = table({ phase: "shuffle", dealt: [3, 4, 0, 1], shuffled: 1, awaited: [4], seq: 21 });
  assert.equal(tookEffect("leave", "a.testnet", 0, before, shuffled), false);
  assert.equal(tookEffect("leave", "a.testnet", 0, before, { ...shuffled, leaving: [true, false, false, false, false, false] }), true);
  assert.equal(tookEffect("leave", "a.testnet", 0, before, { ...shuffled, players: [null, "b.testnet", null, "d.testnet", "e.testnet", null] }), true);
  assert.equal(tookEffect("leave", "a.testnet", 0, before, null), true);

  // Shares for the flop, owed by seats 0 and 1: when seat 1's are in, seat 0's are still owed.
  const flop = table({ phase: "open", street: 1, awaited: [0, 1] });
  assert.equal(tookEffect("open", "a.testnet", 0, flop, { ...flop, awaited: [0], seq: 21 }), false);
  assert.equal(tookEffect("open", "a.testnet", 0, flop, { ...flop, awaited: [1], seq: 21 }), true);
  assert.equal(tookEffect("open", "a.testnet", 0, flop, table({ street: 1, board: [1, 2, 3], awaited: [4], toAct: 4, seq: 22 })), true);
  // A shuffle is the seat's alone: the count of shuffles says whether it is in.
  const mine = table({ phase: "shuffle", shuffled: 2, awaited: [0] });
  assert.equal(tookEffect("shuffle", "a.testnet", 0, mine, { ...mine, seq: 21 }), false);
  assert.equal(tookEffect("shuffle", "a.testnet", 0, mine, { ...mine, shuffled: 3, awaited: [1], seq: 21 }), true);

  // A bet moves the table's count of bets; a seat taken shows the account; a start leaves the lobby.
  assert.equal(tookEffect("act", "b.testnet", 1, table(), table({ seq: 21 })), false);
  assert.equal(tookEffect("act", "b.testnet", 1, table(), table({ seq: 21, bets: 8, toAct: 3, awaited: [3] })), true);
  assert.equal(tookEffect("join", "z.testnet", null, table(), table({ seq: 21 })), false);
  assert.equal(tookEffect("join", "z.testnet", null, table(), table({ seq: 21, players: ["a.testnet", "b.testnet", "z.testnet", "d.testnet", "e.testnet", null] })), true);
  assert.equal(tookEffect("start", "a.testnet", 0, table({ phase: "lobby" }), table({ phase: "lobby", seq: 21 })), false);
  assert.equal(tookEffect("start", "a.testnet", 0, table({ phase: "lobby" }), table({ phase: "shuffle", seq: 21 })), true);
  // Whatever it was, a table that is gone tells nothing about a bet or a share.
  assert.equal(tookEffect("act", "b.testnet", 1, table(), null), false);
});

test("with its clock nearly out a seat's page checks for it, or folds to a bet, rather than let it be ruled late", () => {
  // The contract cannot fold a seat that lets its bet run out before the river: the hand is called off and the seat
  // loses all it has at the table (contracts/poker-table `timeout`). The page makes the bet a clock makes anywhere.
  const at = 1_800_000_000_000;
  const until = (ms: number) => String(BigInt(at + ms) * 1_000_000n);
  // A minute's clock (a free table): the page moves with twelve seconds left; half a minute's: with seven and a half.
  assert.equal(clockMarginMs(table({ turnSeconds: 60 })), 12_000);
  assert.equal(clockMarginMs(table({ turnSeconds: 30 })), 7_500);
  // Seat 1 owes the big blind: time enough, then a fold.
  assert.equal(clockMove(table({ turnSeconds: 60, deadline: until(40_000) }), 1, at), null);
  assert.equal(clockMove(table({ turnSeconds: 60, deadline: until(12_000) }), 1, at), "fold");
  // Nothing owed (the big blind after a call round): a check, never a fold.
  const free = table({ turnSeconds: 60, deadline: until(5_000), toAct: 0, awaited: [0], bet: [2, 2, 0, 2, 2, 0], put: [2, 2, 0, 2, 2, 0] });
  assert.equal(clockMove(free, 0, at), "call");
  // Not this seat's bet, or not a bet at all: nothing.
  assert.equal(clockMove(free, 1, at), null);
  assert.equal(clockMove(table({ phase: "open", street: 1, turnSeconds: 60, deadline: until(1_000), awaited: [1] }), 1, at), null);
  // Past the deadline it is still tried: time may not have been called yet.
  assert.equal(clockMove(table({ turnSeconds: 60, deadline: until(-3_000) }), 1, at), "fold");

  // A device whose clock is 50 seconds ahead reads a fresh minute as ten seconds: seen when the clock restarts, the
  // 50 seconds are taken off its time, and the seat is not folded at the start of its turn.
  const fresh = table({ turnSeconds: 60, deadline: until(60_000) });
  const wrong = at + 50_000;
  assert.equal(clockMove(fresh, 1, wrong), "fold");
  assert.equal(clockAhead(fresh, wrong), 50_000);
  assert.equal(clockMove(fresh, 1, wrong - clockAhead(fresh, wrong)), null);
});

test("a seat's page calls time on the others only when its own part is in", () => {
  const at = 1_800_000_000_000;
  const until = (ms: number) => String(BigInt(at + ms) * 1_000_000n);
  const flop = table({ phase: "open", street: 1, awaited: [0, 1], deadline: until(-5_000) });
  // Seats 0 and 1 both owe their shares: whichever calls time is ruled late with the other, and loses its chips too.
  assert.equal(callsTime(flop, 0, at, 4_000), false);
  assert.equal(callsTime(flop, 3, at, 4_000), true);
  // Not before the deadline and its grace; never in the lobby.
  assert.equal(callsTime({ ...flop, deadline: until(-3_000) }, 3, at, 4_000), false);
  assert.equal(callsTime(table({ phase: "lobby", awaited: [], deadline: "0" }), 3, at, 4_000), false);
});
