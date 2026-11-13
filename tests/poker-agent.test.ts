// The poker agent (games/poker/agent): how it ranks hands (the same as the contract that pays by them), what chance
// it gives its cards, and that whatever it or a model answers becomes a bet the contract takes.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { LlmConfig } from "../games/co-ty-phu/agent/llm.ts";
import { advise, briefFor, byTheBook, legal, parseAnswer, type Brief } from "../games/poker/agent/decide.ts";
import { best, madeHand, rank5, winChance } from "../games/poker/agent/hands.ts";
import { type MatchView, betOptions } from "../games/poker/seat.ts";

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

test("every five-card hand is ranked as the contract ranks it", () => {
  // All 2,598,960 hands: how many fall in each category and how many different strengths each has, the figures the
  // contract's own test checks its ranking against (contracts/poker/src/tests.rs).
  const hands = new Array(9).fill(0);
  const strengths = Array.from({ length: 9 }, () => new Set<number>());
  for (let a = 0; a < 52; a++)
    for (let b = a + 1; b < 52; b++)
      for (let c = b + 1; c < 52; c++)
        for (let d = c + 1; d < 52; d++)
          for (let e = d + 1; e < 52; e++) {
            const score = rank5([a, b, c, d, e]);
            hands[score >> 20] += 1;
            strengths[score >> 20].add(score);
          }
  assert.deepEqual(hands, [1_302_540, 1_098_240, 123_552, 54_912, 10_200, 5_108, 3_744, 624, 40]);
  assert.deepEqual(strengths.map((set) => set.size), [1_277, 2_860, 858, 858, 10, 1_277, 156, 156, 10]);
  // The wheel is the lowest straight, and the best five of seven are found.
  assert.ok(rank5(cards("2c 3d 4h 5s 6c")) > rank5(cards("Ac 2d 3h 4s 5c")));
  assert.equal(best(cards("9c 9d 9h 3s 3c Ad Kh")) >> 20, 6);
  assert.equal(madeHand(cards("Kd 3s"), cards("8c Td Ts 6h 5h")), "a pair");
  assert.equal(madeHand(cards("Kd 3s"), []), null);
});

test("the chance it gives a hand is the chance the hand has", () => {
  const near = (value: number, wanted: number, by: number) => assert.ok(Math.abs(value - wanted) <= by, `${value} is not within ${by} of ${wanted}`);
  // Known figures against one random hand before the flop: aces about 85%, seven-deuce off suit about 35%.
  near(winChance(cards("As Ah"), [], 6_000, dice(1)), 0.85, 0.02);
  near(winChance(cards("7c 2d"), [], 6_000, dice(2)), 0.35, 0.02);
  // A royal flush cannot lose; a hand that plays the board can only split.
  assert.equal(winChance(cards("As Ks"), cards("Qs Js Ts 2c 3d"), 300, dice(3)), 1);
  near(winChance(cards("2c 3d"), cards("As Ks Qs Js Ts"), 300, dice(4)), 0.5, 0.001);
});

/** A table at a bet, as `get_match` gives it. */
function table(more: Partial<MatchView> = {}): MatchView {
  return {
    id: "t",
    phase: "bet",
    stake: "100000000000000000000000",
    players: ["a.testnet", "b.testnet"],
    keys: [],
    turnSeconds: 300,
    deadline: "0",
    chips: [99, 98],
    hand: 0,
    button: 0,
    shuffled: 2,
    street: 0,
    toAct: 0,
    awaited: [0],
    put: [1, 2],
    bet: [1, 2],
    done: [false, false],
    tokens: [],
    board: [],
    hole: [[], []],
    last: null,
    seq: 6,
    ...more,
  };
}

test("an agent is told what its seat can see, with the bounds the contract sets", () => {
  const view = table();
  const brief = briefFor(view, 0, cards("As Kd"), { samples: 500, random: dice(5) });
  assert.deepEqual(
    { ...brief, winChance: 0 },
    { street: "pre-flop", hand: 1, youHaveTheButton: true, yourCards: ["As", "Kd"], board: [], youHold: null, pot: 3, toCall: 1, potOdds: 0.25, winChance: 0, yourChips: 99, theirChips: 98, yourBet: 1, theirBet: 2, raiseTo: { min: 4, max: 100 }, blinds: [1, 2] },
  );
  assert.ok(brief.winChance > 0.55 && brief.winChance < 0.75);
  // The raise it is offered is the raise the page offers and the contract takes.
  for (const view of [table(), table({ chips: [30, 0], bet: [0, 30], put: [70, 100] }), table({ chips: [90, 1], bet: [2, 2], put: [10, 109] })]) {
    assert.deepEqual(briefFor(view, 0, cards("As Kd"), { samples: 50 }).raiseTo, betOptions(view, 0).raise);
  }
  const flop = briefFor(table({ street: 1, board: cards("Ks 7d 2c"), bet: [0, 0], put: [4, 4], chips: [96, 96], toAct: 1 }), 1, cards("Kd Qd"), { samples: 500, random: dice(6) });
  assert.deepEqual([flop.street, flop.youHold, flop.board, flop.toCall, flop.potOdds], ["flop", "a pair", ["Ks", "7d", "2c"], 0, 0]);
});

const brief = (more: Partial<Brief>): Brief => ({
  street: "flop",
  hand: 1,
  youHaveTheButton: true,
  yourCards: ["As", "Kd"],
  board: ["Ks", "7d", "2c"],
  youHold: "a pair",
  pot: 8,
  toCall: 0,
  potOdds: 0,
  winChance: 0.5,
  yourChips: 96,
  theirChips: 96,
  yourBet: 0,
  theirBet: 0,
  raiseTo: { min: 2, max: 96 },
  blinds: [1, 2],
  ...more,
});

test("the odds alone bet a strong hand, call when the price is right and never fold for nothing", () => {
  assert.equal(byTheBook(brief({ winChance: 0.3 })).action, "call", "a free check is never folded");
  assert.deepEqual({ ...byTheBook(brief({ winChance: 0.8 })), reason: "" }, { action: "raise", amount: 5, reason: "" }, "about six tenths of the pot");
  // Facing a bet of 8 into 16: the call needs a third.
  const facing = { pot: 16, toCall: 8, potOdds: 0.33, theirBet: 8, raiseTo: { min: 10, max: 96 } };
  assert.equal(byTheBook(brief({ ...facing, winChance: 0.3 })).action, "fold");
  assert.equal(byTheBook(brief({ ...facing, winChance: 0.45 })).action, "call");
  assert.deepEqual({ ...byTheBook(brief({ ...facing, winChance: 0.9 })), reason: "" }, { action: "raise", amount: 20, reason: "" });
  // A raise is held inside what the other seat can call, and with no raise left a strong hand calls.
  assert.equal(byTheBook(brief({ ...facing, winChance: 0.9, raiseTo: { min: 10, max: 12 } })).amount, 12);
  assert.equal(byTheBook(brief({ ...facing, winChance: 0.9, raiseTo: null })).action, "call");
  for (const chance of [0, 0.2, 0.5, 0.7, 1]) assert.ok(byTheBook(brief({ winChance: chance })).reason.length > 10);
});

test("whatever is answered becomes a bet the contract takes, or nothing", () => {
  const free = brief({});
  const facing = brief({ pot: 16, toCall: 8, theirBet: 8, raiseTo: { min: 10, max: 96 } });
  assert.deepEqual(legal({ action: "check" }, free), { action: "call" });
  assert.equal(legal({ action: "check" }, facing), null, "there is a bet to answer");
  assert.deepEqual(legal({ action: "fold" }, free), { action: "call" }, "folding what costs nothing is a check");
  assert.deepEqual(legal({ action: "fold" }, facing), { action: "fold" });
  assert.deepEqual(legal({ action: "raise", amount: 500 }, facing), { action: "raise", amount: 96 });
  assert.deepEqual(legal({ action: "raise", amount: 9 }, facing), { action: "raise", amount: 10 });
  assert.deepEqual(legal({ action: "raise", amount: 24.4 }, facing), { action: "raise", amount: 24 });
  assert.deepEqual(legal({ action: "all-in" }, facing), { action: "raise", amount: 96 });
  assert.deepEqual(legal({ action: "raise", amount: 30 }, brief({ raiseTo: null })), { action: "call" });
  for (const nonsense of [null, "raise", {}, { action: "raise" }, { action: "raise", amount: "all" }, { action: "muck" }, { action: "raise", amount: Number.NaN }]) assert.equal(legal(nonsense, facing), null);
  // A model's answer in a code fence, with a long reason.
  const answer = parseAnswer('```json\n{"action": "raise", "amount": 20, "reason": "' + "top pair ".repeat(40) + '"}\n```', facing);
  assert.deepEqual([answer?.action, answer?.amount, answer!.reason.length <= 160], ["raise", 20, true]);
  assert.equal(parseAnswer("I would fold here.", facing), null);
  assert.deepEqual(parseAnswer('{"action": "fold", "reason": "Too weak to continue."}', free), { action: "call", reason: "Would fold to a bet; there is none, so it checks." });
  assert.equal(parseAnswer('{"action": "check"}', facing), null);
});

test("a model is asked with the owner's words, and the odds answer when it fails", async () => {
  const llm: LlmConfig = { baseUrl: "https://model.test/v1", apiKey: "k", model: "m", label: "m" };
  const view = table();
  const hole = cards("As Kd");
  let sent: { messages: { role: string; content: string }[] } | null = null;
  const answering = (content: string): typeof fetch =>
    (async (_url: unknown, init?: { body?: unknown }) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }) as unknown as typeof fetch;

  const asked = await advise(view, 0, hole, { llm, style: "Never fold an ace.", samples: 100, fetch: answering('{"action":"raise","amount":8,"reason":"Ace king plays."}') });
  assert.deepEqual(asked, { action: "raise", amount: 8, reason: "Ace king plays.", driver: "m" });
  assert.ok(sent!.messages[1].content.includes("Never fold an ace."));
  assert.ok(sent!.messages[1].content.includes('"yourCards":["As","Kd"]'));
  assert.ok(!JSON.stringify(sent).includes("theirCards"), "an agent is told nothing of the other seat's cards");

  // An answer that is no bet, a service that refuses, and one that never answers: the odds play, and say why.
  const nonsense = await advise(view, 0, hole, { llm, samples: 100, fetch: answering("call me maybe") });
  assert.deepEqual([nonsense.driver, nonsense.fallback, nonsense.problem], ["the book", true, "the model did not answer with a bet"]);
  const refusing = (async () => new Response("no", { status: 402 })) as unknown as typeof fetch;
  assert.match((await advise(view, 0, hole, { llm, samples: 100, fetch: refusing })).problem ?? "", /answered 402 \(out of credit/);
  const silent = ((_url: unknown, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
  const late = await advise(view, 0, hole, { llm, samples: 100, fetch: silent, timeoutMs: 30 });
  assert.deepEqual([late.driver, late.problem], ["the book", "m did not answer in time"]);
  // With no model there is nothing to fall back from.
  assert.deepEqual(Object.keys(await advise(view, 0, hole, { samples: 100 })).sort(), ["action", "driver", "reason"]);
});

test("a model NEAR AI serves is told to answer without thinking first, with room for the answer", async () => {
  const view = table();
  const hole = cards("As Kd");
  const asked: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const answering: typeof fetch = (async (url: unknown, init?: { body?: unknown; headers?: Record<string, string> }) => {
    asked.push({ url: String(url), headers: init?.headers ?? {}, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"call","reason":"Priced in."}' } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const near = (model: string): LlmConfig => ({ baseUrl: "https://cloud-api.near.ai/v1", apiKey: "k", model, label: model });

  // Left to think, these models spent the whole answer on it and the seat bet by the odds without a word.
  assert.equal((await advise(view, 0, hole, { llm: near("Qwen/Qwen3.8-27B"), samples: 100, fetch: answering })).driver, "Qwen/Qwen3.8-27B");
  await advise(view, 0, hole, { llm: near("z-ai/glm-5.3-flash"), samples: 100, fetch: answering });
  await advise(view, 0, hole, { llm: { baseUrl: "https://model.test/v1", apiKey: "k", model: "m", label: "m" }, samples: 100, fetch: answering });
  assert.deepEqual([asked[0].body.chat_template_kwargs, asked[0].body.max_tokens, asked[0].headers["x-no-aliasing"]], [{ enable_thinking: false }, 800, "true"]);
  assert.deepEqual([asked[1].body.reasoning_effort, asked[1].body.max_tokens], ["low", 800]);
  // Another service is asked as before: it would refuse settings it does not know.
  assert.deepEqual([asked[2].body.chat_template_kwargs, asked[2].body.reasoning_effort, asked[2].body.max_tokens, asked[2].headers["x-no-aliasing"]], [undefined, undefined, 300, undefined]);
});
