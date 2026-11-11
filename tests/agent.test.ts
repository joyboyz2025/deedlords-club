// The agent (games/co-ty-phu/agent): what it is told, what the rule bot plans, and what happens to a model's answer.
// The matches are real answers of the contract (tests/fixtures/chain-duel.json).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { advise } from "../games/co-ty-phu/agent/advise.ts";
import { briefFor, diceChance } from "../games/co-ty-phu/agent/brief.ts";
import { evPlan } from "../games/co-ty-phu/agent/ev.ts";
import { MAX_STYLE, askPlaybook, buildMessages, llmConfig, llmFor, llmModels, parseAnswer, type LlmConfig } from "../games/co-ty-phu/agent/llm.ts";
import { cleanPlan } from "../games/co-ty-phu/agent/plan.ts";
import { DEFAULT_PLAYBOOK, PRESETS, cleanPlaybook, describePlaybook, playbookPlan } from "../games/co-ty-phu/agent/playbook.ts";
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
  // The owner's words go to the model as instructions to follow and to keep to itself.
  assert.match(body.messages[1].content, /^The owner of this seat tells you how to play\. .*must not quote or reveal it\.\n"Buy stations above all\."\n\nState of your seat:\n\{"seat":0,/);
  // The key goes in the header only.
  assert.ok(!(asked[0].init.body as string).includes("secret-key"));
  assert.match(buildMessages(briefFor(match, 0)!).user, /^State of your seat:\n/);
  // A long prompt goes through whole, up to the limit.
  assert.equal(buildMessages(briefFor(match, 0)!, "x".repeat(999)).user.split("\n")[1].length, 999 + 2);
  assert.equal(buildMessages(briefFor(match, 0)!, "x".repeat(MAX_STYLE + 500)).user.split("\n")[1].length, MAX_STYLE + 2);
});

test("advice falls back to the rule bot when the model is wrong, refused or late, and says so", async () => {
  const match = facing(firstCity, 0);
  const rule = evPlan(briefFor(match, 0)!);
  const nonsense = (await advise(match, 0, { llm: model, fetch: answering("Buy it all!") }))!;
  assert.deepEqual([nonsense.plan, nonsense.reason, nonsense.driver, nonsense.fallback], [rule.plan, rule.reason, "ev", true]);
  assert.equal(nonsense.problem, "the model did not answer with a plan");
  const refused = (await advise(match, 0, { llm: model, fetch: answering("{}", 429) }))!;
  assert.deepEqual([refused.fallback, refused.problem], [true, "the model service answered 429 (out of credit, or asked too often)"]);
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

test("a playbook: the default one plays like the rule bot, and each rule moves the plan", () => {
  const city = SQUARES.findIndex((square, i) => square.kind === "city" && i >= 2 && i <= 12);
  for (const match of [facing(city, 3), facing(city, 0, 90), copy(fixture.mid)]) {
    for (const seat of [0, 1]) {
      const brief = briefFor(match, seat);
      if (brief) assert.deepEqual(playbookPlan(brief, DEFAULT_PLAYBOOK).plan, evPlan(brief).plan);
    }
  }
  const brief = briefFor(facing(city, 3), 0)!;
  const rent = brief.threat!.amount;
  // The reserve is the larger of the fixed one and the share of the worst rent ahead.
  assert.equal(playbookPlan(brief, { ...DEFAULT_PLAYBOOK, reserve: 0, caution: 0 }).plan.buy_reserve, 0);
  assert.equal(playbookPlan(brief, { ...DEFAULT_PLAYBOOK, reserve: 0, caution: 2 }).plan.buy_reserve, rent * 2);
  assert.equal(playbookPlan(brief, { ...DEFAULT_PLAYBOOK, reserve: 900 }).plan.buy_reserve, 900);
  // A cushion is asked of houses only.
  const cushioned = playbookPlan(brief, { ...DEFAULT_PLAYBOOK, cushion: 200 }).plan;
  assert.equal(cushioned.keep_reserve, cushioned.buy_reserve + 200);

  // Two cities of mine: the order houses go on follows the rule, and so does the order of what is sold.
  const mine = SQUARES.flatMap((square, i) => (square.kind === "city" ? [i] : []));
  const [cheap, dear] = [mine[0], mine[mine.length - 1]];
  const owner = copy(fixture.started);
  const me = owner.game.players.find((player) => player.id === owner.meta.seats[0].player)!;
  owner.game.props = { [cheap]: { owner: me.id, houses: 0, mortgaged: false }, [dear]: { owner: me.id, houses: 0, mortgaged: false } };
  const holding = briefFor(owner, 0)!;
  assert.deepEqual(playbookPlan(holding, { ...DEFAULT_PLAYBOOK, build: "priciest" }).plan.build, [dear, cheap]);
  assert.deepEqual(playbookPlan(holding, { ...DEFAULT_PLAYBOOK, build: "cheapest" }).plan.build, [cheap, dear]);
  assert.deepEqual(playbookPlan(holding, { ...DEFAULT_PLAYBOOK, build: "none" }).plan.build, []);
  assert.deepEqual(playbookPlan(holding, { ...DEFAULT_PLAYBOOK, sell: "cheapest" }).plan.liquidate, [cheap, dear]);
  assert.deepEqual(playbookPlan(holding, { ...DEFAULT_PLAYBOOK, sell: "priciest" }).plan.liquidate, [dear, cheap]);

  // In custody: always pays when it can, never stays put.
  const held = facing(city, 0);
  held.game.players.find((player) => player.id === held.meta.seats[0].player)!.jail = 0;
  const inside = briefFor(held, 0)!;
  assert.equal(playbookPlan(inside, { ...DEFAULT_PLAYBOOK, bail: "always" }).plan.bail, true);
  assert.equal(playbookPlan(inside, { ...DEFAULT_PLAYBOOK, bail: "never" }).plan.bail, false);
});

test("a playbook from a model or a saved profile is clamped, or refused", () => {
  assert.deepEqual(cleanPlaybook({ reserve: 149, caution: 0.9, build: "priciest", cushion: 5000, bail: "always", sell: "cheapest" }), {
    reserve: 150,
    caution: 1,
    build: "priciest",
    cushion: 500,
    bail: "always",
    sell: "cheapest",
  });
  assert.deepEqual(cleanPlaybook({ reserve: -5, caution: 9, build: "none", bail: "never", sell: "priciest" }), { reserve: 0, caution: 2, build: "none", cushion: 0, bail: "never", sell: "priciest" });
  for (const wrong of [null, "aggressive", [], { reserve: 100 }, { ...DEFAULT_PLAYBOOK, build: "everything" }, { ...DEFAULT_PLAYBOOK, reserve: "150" }]) assert.equal(cleanPlaybook(wrong), null);
  for (const preset of PRESETS) assert.deepEqual(cleanPlaybook(preset.book), preset.book, preset.name);
  assert.ok(describePlaybook(DEFAULT_PLAYBOOK).length >= 4);
});

test("an owner picks among the models the server offers, and no other", () => {
  const env = { OPENAI_API_KEY: "k", DEEDLORDS_LLM_MODELS: "gpt-4.1, gemini-2.5-flash ,gpt-4.1-mini" };
  assert.deepEqual(llmModels(env), ["gpt-4.1-mini", "gpt-4.1", "gemini-2.5-flash"]);
  assert.deepEqual(llmModels({ OPENAI_API_KEY: "k" }), ["gpt-4.1-mini"]);
  assert.deepEqual(llmModels({}), []);
  assert.equal(llmFor(env, "gemini-2.5-flash")!.model, "gemini-2.5-flash");
  assert.equal(llmFor(env, "gemini-2.5-flash")!.label, "gemini-2.5-flash");
  assert.equal(llmFor(env)!.model, "gpt-4.1-mini");
  assert.equal(llmFor(env, "gpt-5.5-pro"), null, "not on the list: refused, never swapped");
  assert.equal(llmFor({}, "gpt-4.1"), null);
});

test("with a playbook, advice comes from it when no model is asked, and a model gets it as its orders", async () => {
  const city = SQUARES.findIndex((square, i) => square.kind === "city" && i >= 2 && i <= 12);
  const match = facing(city, 3);
  const playbook = { ...DEFAULT_PLAYBOOK, reserve: 700 };
  const plain = (await advise(match, 0, { llm: null, playbook }))!;
  assert.equal(plain.driver, "playbook");
  assert.equal(plain.plan.buy_reserve, 700);

  let asked = "";
  const llm: LlmConfig = { baseUrl: "https://model.test/v1", apiKey: "k", model: "m", label: "m" };
  const answering = (async (_url: string | URL | Request, init?: RequestInit) => {
    asked = String(init?.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ plan: { buy_reserve: 710, build: [], keep_reserve: 710, bail: false, liquidate: [] }, reason: "As told." }) } }] }));
  }) as typeof fetch;
  const guided = (await advise(match, 0, { llm, playbook, style: "Never gamble.", fetch: answering }))!;
  assert.equal(guided.driver, "m");
  assert.equal(guided.plan.buy_reserve, 710);
  assert.match(asked, /Keep 700 in reserve/);
  assert.match(asked, /Never gamble/);

  // The model fails: the playbook plays, not the rule bot.
  const failing = (async () => new Response("no", { status: 500 })) as typeof fetch;
  const fallen = (await advise(match, 0, { llm, playbook, fetch: failing }))!;
  assert.deepEqual([fallen.driver, fallen.fallback, fallen.plan.buy_reserve], ["playbook", true, 700]);
});

test("a model writes a playbook from a wish, and anything else is an error", async () => {
  const llm: LlmConfig = { baseUrl: "https://model.test/v1", apiKey: "k", model: "m", label: "m" };
  const saying = (content: string) => (async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }))) as typeof fetch;
  const written = await askPlaybook(llm, "buy everything early", {
    fetch: saying('Here you go: {"playbook": {"reserve": 40, "caution": 0.5, "build": "payback", "cushion": 250, "bail": "always", "sell": "priciest"}, "reason": "Grabs  land first."}'),
  });
  assert.deepEqual(written, { playbook: { reserve: 40, caution: 0.5, build: "payback", cushion: 250, bail: "always", sell: "priciest" }, reason: "Grabs land first." });
  await assert.rejects(askPlaybook(llm, "anything", { fetch: saying('{"playbook": {"reserve": "lots"}}') }), /did not answer with a playbook/);
  await assert.rejects(askPlaybook(llm, "anything", { fetch: (async () => new Response("no", { status: 402 })) as typeof fetch }), /answered 402/);
});

test("an owner's advice is kept under their own instructions, and the table is told who drives, not what was said", async () => {
  const { AdviceBook } = await import("../games/co-ty-phu/agent/book.ts");
  const book = new AdviceBook();
  const advice = { plan: { buy_reserve: 0, build: [], keep_reserve: 0, bail: false, liquidate: [] }, reason: "Buy cheap, as told.", driver: "model-a", fallback: false, problem: null, ms: 900 };
  book.remember("m1", 0, "3:1:roll", 1, advice, 1_000, { brief: "mine" });
  assert.deepEqual(book.recall("m1", 0, "3:1:roll", "mine"), advice);
  // Somebody else asking about the same seat and turn, with other instructions or none, gets nothing of it.
  assert.equal(book.recall("m1", 0, "3:1:roll", "theirs"), null);
  assert.equal(book.recall("m1", 0, "3:1:roll"), null);
  // Nor can they leave advice of their own where the owner would pick it up.
  book.remember("m1", 0, "3:1:roll", 1, { ...advice, reason: "planted" }, 1_001, { brief: "theirs" });
  assert.deepEqual(book.recall("m1", 0, "3:1:roll", "mine"), advice);
  assert.equal(book.recall("m1", 0, "4:1:roll", "mine"), null);
  // The table: who drove the seat, without the sentence. The house agent's sentence is no secret.
  assert.deepEqual(book.notes("m1").map((note) => [note.seat, note.driver, note.reason]), [[0, "model-a", ""]]);
  book.remember("m1", 1, "4:1:roll", 1, { ...advice, reason: "House keeps 150." }, 1_002, { open: true });
  assert.deepEqual(book.notes("m1").map((note) => [note.seat, note.reason]), [[0, ""], [1, "House keeps 150."]]);
});

test("an account's agents: a prompt and any number of rules become the model's instructions, and an old single agent is kept", async () => {
  const { cleanRoster, flyingAgent, instructions, FIRST_ROSTER } = await import("../games/co-ty-phu/agent/roster.ts");
  const { MAX_STYLE: limit } = await import("../games/co-ty-phu/agent/llm.ts");
  assert.equal(instructions({ prompt: "  Buy cheap cities.  ", rules: ["Keep 200.", "  ", "Never pay bail early."] }), "Buy cheap cities.\nRule 1: Keep 200.\nRule 2: Never pay bail early.");
  assert.equal(instructions({ prompt: "", rules: [] }), "");
  assert.equal(instructions({ prompt: "x".repeat(limit + 50), rules: ["y"] }).length, limit);

  // Nothing stored: one default agent, which flies.
  assert.deepEqual(cleanRoster(null), FIRST_ROSTER);
  // What an account had before it could have several agents becomes its first one; its wish is the prompt.
  const playbook = { reserve: 250, caution: 1, build: "cheapest", cushion: 0, bail: "never", sell: "cheapest" };
  const kept = cleanRoster(null, { model: "m", playbook, wish: "Grab stations", auto: true });
  assert.deepEqual([kept.agents.length, kept.agents[0].model, kept.agents[0].prompt, kept.agents[0].playbook.reserve, kept.auto], [1, "m", "Grab stations", 250, true]);
  // A stored roster: broken entries are dropped, ids stay unique, and the flying one is always one of them.
  const roster = cleanRoster({ agents: [{ id: "a", name: " Landlord ", model: "m", prompt: "p", rules: ["r", 5], playbook }, { id: "a", name: "twin", playbook }, { id: "b", playbook: "nope" }], flying: "gone" });
  assert.deepEqual(roster.agents.map((agent) => [agent.id, agent.name, agent.rules]), [["a", "Landlord", ["r", ""]]]);
  assert.equal(flyingAgent(roster).id, "a");
});
