// The agent (games/co-ty-phu/agent): what it is told, what the rule bot plans, and what happens to a model's answer.
// The matches are real answers of the contract (tests/fixtures/chain-duel.json).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { advise } from "../games/co-ty-phu/agent/advise.ts";
import { briefFor, diceChance } from "../games/co-ty-phu/agent/brief.ts";
import { evPlan } from "../games/co-ty-phu/agent/ev.ts";
import { buildMessages, llmConfig, parseAnswer, type LlmConfig } from "../games/co-ty-phu/agent/llm.ts";
import { cleanPlan } from "../games/co-ty-phu/agent/plan.ts";
import { SQUARES, cityRents, houseCost } from "../games/co-ty-phu/board.ts";
import type { ChainMatch } from "../games/co-ty-phu/chain/types.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/chain-duel.json", import.meta.url), "utf8")) as { lobby: ChainMatch; started: ChainMatch; mid: ChainMatch };
const copy = (match: ChainMatch): ChainMatch => structuredClone(match);
const firstCity = SQUARES.findIndex((square) => square.kind === "city");

/** A match where seat 0 stands on Departure with `cash`, and seat 1 owns `square` with `houses` on it. */
function facing(square: number, houses: number, cash = 1500): ChainMatch {
  const match = copy(fixture.started);
  const [me, rival] = match.meta.seats.map((seat) => match.game.players.find((player) => player.id === seat.player)!);
  Object.assign(me, { position: 0, cash, jail: null });
  Object.assign(rival, { position: 20, jail: null });
  match.game.props = { [square]: { owner: rival.id, houses, mortgaged: false } };
  match.game.turn = match.game.order.indexOf(me.id);
  match.game.stage = "roll";
  return match;
}

test("two dice", () => {
  assert.equal(diceChance(7), 6 / 36);
  assert.equal(diceChance(2), 1 / 36);
  assert.equal(diceChance(12), 1 / 36);
  assert.equal(diceChance(1), 0);
  assert.equal(diceChance(13), 0);
  let sum = 0;
  for (let total = 2; total <= 12; total++) sum += diceChance(total);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test("a brief tells a seat what the next roll can land on, and names nobody", () => {
  assert.equal(briefFor(fixture.lobby, 0), null, "no game yet");
  const city = SQUARES.findIndex((square, i) => square.kind === "city" && i >= 2 && i <= 12);
  const match = facing(city, 3);
  const brief = briefFor(match, 0)!;
  assert.equal(brief.seat, 0);
  assert.equal(brief.position, 0);
  assert.equal(brief.reach.length, 11);
  assert.deepEqual(brief.reach.map((r) => r.steps), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const there = brief.reach.find((r) => r.square === city)!;
  const price = (SQUARES[city] as { price: number }).price;
  assert.deepEqual([there.what, there.amount], ["rent", cityRents(price)[3]]);
  assert.deepEqual(brief.threat, { amount: cityRents(price)[3], square: city, name: SQUARES[city].name, steps: city });
  assert.equal(brief.holdings.length, 0);
  assert.equal(brief.rivals.length, 1);
  assert.equal(brief.rivals[0].seat, 1);
  assert.equal(brief.turnsLeft, match.meta.rules.maxRounds - match.game.round);
  // The other side of the same board.
  const theirs = briefFor(match, 1)!;
  assert.deepEqual(theirs.holdings.map((h) => [h.square, h.houses, h.rent, h.houseCost, h.rentWithHouse]), [[city, 3, cityRents(price)[3], houseCost(city), cityRents(price)[4]]]);
  assert.ok(theirs.holdings[0].visits > 0);
  assert.equal(theirs.threat, null);
  // Accounts stay out of what a model reads.
  const text = JSON.stringify(brief) + JSON.stringify(theirs);
  for (const seat of match.meta.seats) assert.ok(!text.includes(seat.backer!), seat.backer!);
});

test("the rule bot keeps the largest rent within two rolls in hand", () => {
  const city = SQUARES.findIndex((square, i) => square.kind === "city" && i >= 2 && i <= 12);
  const price = (SQUARES[city] as { price: number }).price;
  const rent = cityRents(price)[4];
  const { plan, reason } = evPlan(briefFor(facing(city, 4), 0)!);
  assert.equal(plan.buy_reserve, Math.max(150, rent));
  assert.equal(plan.keep_reserve, plan.buy_reserve);
  assert.deepEqual(plan.build, []);
  assert.match(reason, new RegExp(`^Keep ${plan.buy_reserve} for ${SQUARES[city].name} \\(rent ${rent}, ${city} ahead\\); buy what leaves that much\\.$`));
  // Nothing owned by anybody: the floor, and the owner of a city builds on it.
  const calm = facing(city, 0);
  calm.game.props = {};
  assert.equal(evPlan(briefFor(calm, 0)!).plan.buy_reserve, 150);
  const owner = evPlan(briefFor(facing(city, 1), 1)!);
  assert.deepEqual(owner.plan.build, [city]);
  assert.deepEqual(owner.plan.liquidate, [city]);
  assert.match(owner.reason, new RegExp(`build ${SQUARES[city].name} first`));
});

test("in custody the rule bot pays its way out only while there is something to buy", () => {
  const match = facing(firstCity, 0);
  match.game.props = {};
  const me = match.game.players.find((player) => player.id === match.meta.seats[0].player)!;
  me.jail = 0;
  assert.equal(evPlan(briefFor(match, 0)!).plan.bail, true);
  // Last round: no time to earn from anything bought.
  match.game.round = match.meta.rules.maxRounds - 1;
  const last = evPlan(briefFor(match, 0)!);
  assert.equal(last.plan.bail, false);
  assert.match(last.reason, /sit out in custody/);
});

test("a model's answer becomes a plan the contract accepts, or nothing", () => {
  const station = SQUARES.findIndex((square) => square.kind === "station");
  assert.deepEqual(cleanPlan({ buy_reserve: 199.6, build: [firstCity, firstCity, station, 0], keep_reserve: -5, bail: true, liquidate: [station, firstCity, 0] }), {
    buy_reserve: 200,
    build: [firstCity],
    keep_reserve: 0,
    bail: true,
    liquidate: [station, firstCity],
  });
  // What is left out takes the careful default; `keep_reserve` follows `buy_reserve`.
  assert.deepEqual(cleanPlan({ buy_reserve: 300 }), { buy_reserve: 300, build: [], keep_reserve: 300, bail: false, liquidate: [] });
  assert.equal(cleanPlan({ buy_reserve: 1e12 })!.buy_reserve, 1_000_000);
  assert.equal(cleanPlan({ buy_reserve: 0, build: Array.from({ length: 40 }, (_, i) => i).concat([1, 3]) })!.build.length <= 40, true);
  for (const wrong of [null, "buy everything", [], {}, { buy_reserve: "200" }, { buy_reserve: 1, build: "all" }, { buy_reserve: 1, build: [40] }, { buy_reserve: 1, build: [1.5] }, { buy_reserve: 1, bail: "yes" }, { buy_reserve: Number.NaN }]) {
    assert.equal(cleanPlan(wrong), null, JSON.stringify(wrong));
  }
  assert.deepEqual(parseAnswer('```json\n{"plan": {"buy_reserve": 250, "build": []}, "reason": "Keep  rent money.\\nBuy the rest."}\n```'), {
    plan: { buy_reserve: 250, build: [], keep_reserve: 250, bail: false, liquidate: [] },
    reason: "Keep rent money. Buy the rest.",
  });
  assert.equal(parseAnswer('{"plan": {"buy_reserve": 1}, "reason": "' + "x".repeat(400) + '"}')!.reason.length, 160);
  assert.equal(parseAnswer('{"plan": {"buy_reserve": 1}}')!.reason, "No reason given.");
  assert.equal(parseAnswer("I would buy everything."), null);
  assert.equal(parseAnswer('{"reason": "no plan"}'), null);
  assert.equal(parseAnswer("{not json}"), null);
});

test("which model plays comes from the server's environment", () => {
  assert.equal(llmConfig({}), null);
  assert.deepEqual(llmConfig({ OPENAI_API_KEY: "k1" }), { baseUrl: "https://api.openai.com/v1", apiKey: "k1", model: "gpt-4.1-mini", label: "gpt-4.1-mini" });
  assert.deepEqual(llmConfig({ OPENAI_API_KEY: "k1", NEARAI_API_KEY: "k2", DEEDLORDS_LLM_MODEL: "anthropic/claude-sonnet-5-5" }), {
    baseUrl: "https://cloud-api.near.ai/v1",
    apiKey: "k2",
    model: "anthropic/claude-sonnet-5-5",
    label: "claude-sonnet-5-5",
  });
  assert.deepEqual(llmConfig({ OPENAI_API_KEY: "k1", DEEDLORDS_LLM_API_KEY: "k3", DEEDLORDS_LLM_BASE_URL: "https://llm.example/v1/", DEEDLORDS_LLM_MODEL: "m", DEEDLORDS_LLM_LABEL: "House AI" }), {
    baseUrl: "https://llm.example/v1",
    apiKey: "k3",
    model: "m",
    label: "House AI",
  });
});

const model: LlmConfig = { baseUrl: "https://llm.example/v1", apiKey: "secret-key", model: "m", label: "test-model" };
const answering = (content: string, status = 200) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: String(url), init: init! });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });
  }) as typeof fetch;
let asked: { url: string; init: RequestInit }[] = [];

test("advice is the model's plan when it answers, with its label", async () => {
  asked = [];
  const match = facing(firstCity, 0);
  const advice = (await advise(match, 0, { llm: model, style: "  Buy stations above all.  ", fetch: answering('{"plan":{"buy_reserve":120,"build":[],"keep_reserve":90,"bail":true,"liquidate":[]},"reason":"Cheap board: spend."}') }))!;
  assert.deepEqual(advice.plan, { buy_reserve: 120, build: [], keep_reserve: 90, bail: true, liquidate: [] });
  assert.deepEqual([advice.driver, advice.fallback, advice.problem, advice.reason], ["test-model", false, null, "Cheap board: spend."]);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].url, "https://llm.example/v1/chat/completions");
  assert.equal((asked[0].init.headers as Record<string, string>).authorization, "Bearer secret-key");
  const body = JSON.parse(asked[0].init.body as string) as { model: string; messages: { role: string; content: string }[]; response_format: unknown };
  assert.equal(body.model, "m");
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.deepEqual(body.messages.map((m) => m.role), ["system", "user"]);
  assert.match(body.messages[1].content, /^The owner of this seat asks you to play like this: "Buy stations above all\."\n\nState of your seat:\n\{"seat":0,/);
  // The key goes in the header only.
  assert.ok(!(asked[0].init.body as string).includes("secret-key"));
  assert.match(buildMessages(briefFor(match, 0)!).user, /^State of your seat:\n/);
  assert.equal(buildMessages(briefFor(match, 0)!, "x".repeat(999)).user.split("\n")[0].length, "The owner of this seat asks you to play like this: ".length + 282);
});

test("advice falls back to the rule bot when the model is wrong, refused or late, and says so", async () => {
  const match = facing(firstCity, 0);
  const rule = evPlan(briefFor(match, 0)!);
  const nonsense = (await advise(match, 0, { llm: model, fetch: answering("Buy it all!") }))!;
  assert.deepEqual([nonsense.plan, nonsense.reason, nonsense.driver, nonsense.fallback], [rule.plan, rule.reason, "ev", true]);
  assert.equal(nonsense.problem, "the model did not answer with a plan");
  const refused = (await advise(match, 0, { llm: model, fetch: answering("{}", 429) }))!;
  assert.deepEqual([refused.fallback, refused.problem], [true, "the model service answered 429"]);
  const never = ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch;
  const late = (await advise(match, 0, { llm: model, fetch: never, timeoutMs: 30 }))!;
  assert.deepEqual([late.plan, late.driver, late.fallback, late.problem], [rule.plan, "ev", true, "no answer in 0.03 s"]);
  // No model configured: the rule bot plays as itself, and nothing is asked.
  asked = [];
  const alone = (await advise(match, 0, { llm: null, fetch: answering("{}") }))!;
  assert.deepEqual([alone.plan, alone.driver, alone.fallback, alone.problem], [rule.plan, "ev", false, null]);
  assert.equal(asked.length, 0);
  assert.equal(await advise(fixture.lobby, 0, { llm: null }), null);
});
