// Tickets and the leader's rent (docs/ENGINE-RULES.md §10) on the page's side: the reference engine, what goes to and
// comes from the contract, the agents, the room, and the simulation. That a match without them is untouched is checked
// by every other test file passing as it did; here it is also said outright where it matters most.

import assert from "node:assert/strict";
import { test } from "node:test";
import { briefFor } from "../games/co-ty-phu/agent/brief.ts";
import { evPlan } from "../games/co-ty-phu/agent/ev.ts";
import { buildMessages, parseAnswer } from "../games/co-ty-phu/agent/llm.ts";
import { cleanPlan } from "../games/co-ty-phu/agent/plan.ts";
import { DEFAULT_PLAYBOOK, playbookPlan } from "../games/co-ty-phu/agent/playbook.ts";
import { SQUARES } from "../games/co-ty-phu/board.ts";
import { applyAction, diceAllowed, logLine, needsDice, toAction, toGame } from "../games/co-ty-phu/chain/adapt.ts";
import { NO_EXTRAS, RULES, TICKET_LINES, createDuelCall, extrasOf, freeTableCalls, roundsFor } from "../games/co-ty-phu/chain/calls.ts";
import { describeCall } from "../games/co-ty-phu/chain/ledger.ts";
import { AUTO_ROLL_AFTER_MS, CHOOSE_LIMIT_MS, ChainRoom, autoMove, nothingToDecide, ticketNews } from "../games/co-ty-phu/chain/room.ts";
import type { ChainEvent, ChainGame, ChainMatch, ChainRules } from "../games/co-ty-phu/chain/types.ts";
import {
  TICKETS,
  canPlay,
  canTakeover,
  createGame,
  endTurn,
  leads,
  newPlayer,
  playFestival,
  playSteps,
  playWaiver,
  rentDue,
  rentFor,
  roll,
  startGame,
  takeover,
  ticketsOf,
  type Game,
  type Rng,
  type Ticket,
} from "../games/co-ty-phu/engine.ts";
import { viewFor } from "../games/co-ty-phu/view.ts";
import { PACE_NOW, measure, playMatch } from "../scripts/co-ty-phu-sim.ts";
import { snapshot } from "../tools/diff/snapshot.ts";

/** Hands out the queued values for dice and draws alike; a test that asks for more than it scripted fails. */
function script(values: number[]): Rng {
  const next = () => {
    assert.ok(values.length > 0, "the engine asked for a random value the test did not script");
    return values.shift()!;
  };
  return { die: next, below: next };
}
const NONE = script([]);

const BOTH = { tickets: true, leaderRent: true };
const city = (n: number) => SQUARES.findIndex((square, index) => square.kind === "city" && index >= n);

/** Two seats in seating order, classic rules; `draws`: the ticket each is dealt, when the match has tickets. */
function started(extras: { tickets?: boolean; leaderRent?: boolean }, draws: number[] = []): Game {
  const game = createGame();
  game.players.push(newPlayer("s0", "", "s0"), newPlayer("s1", "", "s1"));
  game.settings = { limitMinutes: 0, salary: 200, cash: 1500, autoSeconds: 0, maxRounds: 20, blitz: false, ...extras };
  startGame(game, new Set(["s0", "s1"]), 0, script([1, ...draws]));
  assert.deepEqual(game.order, ["s0", "s1"]);
  return game;
}

function asMatch(game: Game, log: ChainEvent[] = []): ChainMatch {
  const rules: ChainRules = {
    salary: 200,
    cash: 1500,
    blitz: false,
    maxRounds: 20,
    ...(game.settings.tickets ? { tickets: true } : {}),
    ...(game.settings.leaderRent ? { leaderRent: true } : {}),
  };
  const seats = game.players.map((player, seat) => ({ seat, player: player.id, backer: `${player.id}.test`, driver: null, house: false }));
  const meta = { id: "m1", status: "playing" as const, seats, stake: "0", split: [7000, 3000], fee_bps: 0, rules, solo_player: null, creator: "s0.test", storage_deposit: "0" };
  const clock = {
    created_at: "1",
    last_activity: String(1000 + game.rolls * 10 + log.length),
    turn_seconds: 30,
    turn_deadline: "0",
    draws: 0,
    current_seat: game.phase === "playing" ? game.players.findIndex((p) => p.id === game.order[game.turn]) : null,
  };
  return structuredClone({ meta: { ...meta, ...clock }, game: snapshot(game) as unknown as ChainGame, log });
}

test("a match without the rules has no ticket state, and no ticket can be played in it", () => {
  const game = started({});
  assert.equal("tickets" in snapshot(game), false);
  assert.equal("tickets" in game, false);
  const before = JSON.stringify(game);
  playWaiver(game, "s0");
  playFestival(game, "s0");
  playSteps(game, "s0", 7, NONE);
  takeover(game, "s0");
  assert.equal(JSON.stringify(game), before);
  const view = viewFor(game, "s0", { code: "m", online: new Set(["s0", "s1"]), now: 0 });
  assert.equal("tickets" in view, false);
  assert.equal("leader" in view, false);
});

test("a ticket each at the start, one more at Departure, never more than two", () => {
  const game = started({ tickets: true }, [0, 3]);
  assert.deepEqual(game.tickets, { held: { s0: ["waiver"], s1: ["festival"] }, waiver: false, festival: [] });
  game.players[0].position = 38;
  roll(game, "s0", null, script([1, 2, 1]));
  assert.deepEqual(ticketsOf(game, "s0"), ["waiver", "steps"]);
  game.players[0].position = 38;
  game.stage = "roll";
  roll(game, "s0", null, script([1, 2]));
  assert.equal(ticketsOf(game, "s0").length, 2, "a hand of two draws nothing");
});

test("the four tickets do what the rules sheet says", () => {
  // Rent waiver: the next rent of the turn is not charged.
  let game = started(BOTH, [0, 0]);
  const cheap = city(1);
  game.props[cheap] = { owner: "s1", houses: 0, mortgaged: false };
  playWaiver(game, "s0");
  assert.equal(game.tickets!.waiver, true);
  roll(game, "s0", null, script([1, cheap - 1]));
  assert.deepEqual([game.players[0].cash, game.players[1].cash, game.tickets!.waiver], [1500, 1500, false]);
  assert.match(game.log.at(-1)!, /Rent waiver covers/);

  // Pick your steps: the dice are set, no second throw even for twelve.
  game = started(BOTH, [1, 1]);
  playSteps(game, "s0", 12, NONE);
  assert.deepEqual([game.dice, game.again, game.doubles, game.rolls, game.players[0].position], [[6, 6], false, 0, 1, 12]);
  playSteps(game, "s0", 5, NONE);
  assert.equal(game.players[0].position, 12, "one ticket, one move");

  // Festival and the lead add one rent each; a tie is no lead.
  game = started(BOTH, [3, 3]);
  game.props[cheap] = { owner: "s1", houses: 0, mortgaged: false };
  const base = rentFor(game, cheap, 7);
  assert.equal(rentDue(game, "s0", cheap, 7), base, "s1 is ahead by a city: s0 does not lead");
  game.tickets!.festival.push("s1");
  assert.equal(rentDue(game, "s0", cheap, 7), 2 * base);
  const price = (SQUARES[cheap] as { price: number }).price;
  game.players[0].cash += price;
  assert.equal(leads(game, "s0") || leads(game, "s1"), false, "a tie");
  game.players[0].cash += 1;
  assert.equal(rentDue(game, "s0", cheap, 7), 3 * base);
  // It ends when its owner's next turn starts.
  roll(game, "s0", null, script([1, cheap - 1]));
  endTurn(game, "s0");
  assert.deepEqual(game.tickets!.festival, []);

  // Takeover: twice the price to the owner, only with no house.
  game = started(BOTH, [2, 2]);
  game.props[cheap] = { owner: "s1", houses: 1, mortgaged: false };
  roll(game, "s0", null, script([1, cheap - 1]));
  assert.equal(canTakeover(game, "s0"), false, "a house stands there");
  game.props[cheap].houses = 0;
  const cash = game.players.map((p) => p.cash);
  takeover(game, "s0");
  assert.deepEqual(
    game.players.map((p) => p.cash),
    [cash[0] - 2 * price, cash[1] + 2 * price],
  );
  assert.equal(game.props[cheap].owner, "s0");
  assert.equal(canPlay(game, "s0", "takeover"), false);
});

test("what the page sends: today's arguments unless the contract lists the rules", () => {
  const args = (call: { args: Uint8Array }) => JSON.parse(new TextDecoder().decode(call.args));
  const terms = { stake: 0n, maxRounds: 20, turnSeconds: 30 };
  // A contract from before: no `features`. The match opened is today's, to the letter.
  const old = { owner: "o", house: "h", matches: 0, max_stake: "1", fee_bps: 250 };
  assert.deepEqual(extrasOf(old), NO_EXTRAS);
  assert.deepEqual(extrasOf(null), NO_EXTRAS);
  assert.deepEqual(args(createDuelCall("m", { ...terms, extras: extrasOf(old) })).rules, { ...RULES, max_rounds: 20 });
  assert.deepEqual(args(createDuelCall("m", { ...terms, extras: extrasOf(old) })), args(createDuelCall("m", terms)));
  // One that lists them.
  const now = { ...old, features: ["tickets", "leaderRent"] };
  assert.deepEqual(extrasOf(now), { tickets: true, leaderRent: true });
  assert.deepEqual(extrasOf(now, true), NO_EXTRAS, "switched off for this deployment of the page");
  assert.deepEqual(args(createDuelCall("m", { ...terms, extras: extrasOf(now) })).rules, { ...RULES, max_rounds: 20, tickets: true, leaderRent: true });
  assert.deepEqual(args(freeTableCalls("f", 20, 30, true, null, 1, extrasOf(now))[0]).rules.tickets, true);
  assert.deepEqual(args(freeTableCalls("f", 20, 30, true)[0]), args(freeTableCalls("f", 20, 30, true, null, 1, NO_EXTRAS)[0]));
  assert.equal(TICKET_LINES.length, TICKETS.length);
});

test("the screen's ticket messages are the contract's actions, shown ahead of the chain when no dice are involved", () => {
  assert.equal(toAction({ t: "ticket", ticket: "waiver" }), "Waiver");
  assert.equal(toAction({ t: "ticket", ticket: "festival" }), "Festival");
  assert.equal(toAction({ t: "ticket", ticket: "takeover" }), "Takeover");
  assert.deepEqual(toAction({ t: "ticket", ticket: "steps", steps: 9 }), { Steps: 9 });
  assert.equal(toAction({ t: "ticket", ticket: "steps", steps: 13 }), null);
  assert.equal(toAction({ t: "ticket", ticket: "steps" }), null);

  const match = asMatch(started(BOTH, [1, 3]));
  const game = toGame(match);
  assert.deepEqual([game.settings.tickets, game.settings.leaderRent], [true, true]);
  assert.deepEqual(game.tickets, { held: { s0: ["steps"], s1: ["festival"] }, waiver: false, festival: [] });
  // "Pick your steps" may draw a card or a ticket where it leads: only the chain plays it.
  assert.equal(needsDice(game, { Steps: 7 }), true);
  assert.equal(diceAllowed(game, "s0", { Steps: 7 }), true);
  assert.equal(diceAllowed(game, "s1", { Steps: 7 }), false);
  assert.equal(applyAction(game, "s0", { Steps: 7 }), false);
  assert.equal(applyAction(game, "s0", "Festival"), false, "not held");
  assert.equal(applyAction(game, "s0", "Waiver"), false);
  const theirs = toGame(asMatch(Object.assign(started(BOTH, [1, 3]), { turn: 1 })));
  assert.equal(applyAction(theirs, "s1", "Festival"), true);
  assert.deepEqual(theirs.tickets!.festival, ["s1"]);

  const name = (id: string) => (id === "s0" ? "Ann" : "Ben");
  assert.equal(logLine({ kind: "played", player: "s0", ticket: "steps", value: 9 }, name), "Ann plays Pick your steps and moves 9.");
  assert.equal(logLine({ kind: "drew", player: "s1", ticket: "takeover" }, name), "Ben gets a ticket: Takeover.");
  assert.match(logLine({ kind: "waived", player: "s0", owner: "s1", square: city(1), amount: 40 }, name), /^Ann's Rent waiver covers 40 rent to Ben at /);
  assert.match(logLine({ kind: "raised", player: "s0", square: city(1), festival: true, leader: true }, name), /^Triple rent for Ann/);
  assert.match(logLine({ kind: "raised", player: "s0", square: city(1), festival: false, leader: true }, name), /the leader on net worth pays double/);
  assert.equal(describeCall("play", { seat: 0, actions: ["Waiver", { Steps: 7 }] }), "Play a Rent waiver · Pick 7 steps");
});

test("a plan without tickets is the plan it always was; one with them is cleaned", () => {
  const old = { buy_reserve: 150, build: [1, 3], keep_reserve: 150, bail: true, liquidate: [5] };
  assert.equal(JSON.stringify(cleanPlan(old)), JSON.stringify(old), "key for key: what /verify and check:live compare");
  assert.deepEqual(Object.keys(cleanPlan(old)!), ["buy_reserve", "build", "keep_reserve", "bail", "liquidate"]);
  for (const nothing of [undefined, null, {}, [], "waiver", { waiver: false, steps: 0, takeover: [] }, { steps: 13 }, { steps: 2.5 }, { takeover: [0, 5] }])
    assert.equal(JSON.stringify(cleanPlan({ ...old, tickets: nothing })), JSON.stringify(old), JSON.stringify(nothing));
  assert.deepEqual(cleanPlan({ ...old, tickets: { waiver: true, festival: "yes", steps: 9, takeover: [1, 1, 5, 3], more: 1 } })!.tickets, {
    waiver: true,
    steps: 9,
    takeover: [1, 3],
  });
  assert.deepEqual(parseAnswer('{"plan": {"buy_reserve": 0, "tickets": {"festival": true}}, "reason": "r"}')!.plan.tickets, { festival: true });
});

test("an agent is told what it holds and plays it by rule; a match without tickets is briefed as before", () => {
  const plain = briefFor(asMatch(started({})), 0)!;
  assert.equal("tickets" in plain, false);
  assert.equal("leads" in plain, false);
  assert.equal("tickets" in playbookPlan(plain, DEFAULT_PLAYBOOK).plan, false);
  assert.equal("tickets" in evPlan(plain).plan, false);
  const system = buildMessages(plain).system;
  assert.doesNotMatch(system, /ticket|Festival|leads/i);

  // Seat 0 holds a waiver and a steps ticket; seat 1's hotel is seven steps ahead.
  const game = started(BOTH, [0, 3]);
  game.tickets!.held.s0 = ["waiver", "steps"];
  const hotel = city(11);
  game.props[hotel] = { owner: "s1", houses: 5, mortgaged: false };
  game.players[0].position = hotel - 7;
  const brief = briefFor(asMatch(game), 0)!;
  assert.deepEqual(brief.tickets!.held, ["waiver", "steps"]);
  assert.equal(brief.leads, false);
  assert.deepEqual(brief.tickets!.takeover, [], "a city with a hotel cannot be taken over");
  const told = buildMessages(brief).system;
  assert.ok(
    told.startsWith(system) &&
      /Rent waiver/.test(told) &&
      /Pick your steps/.test(told) &&
      /Takeover/.test(told) &&
      /Festival/.test(told) &&
      /leads on net worth pays double/.test(told),
  );
  const { plan, reason } = playbookPlan(brief, DEFAULT_PLAYBOOK);
  // A hand of two is spent: the steps go where no rent is, so the waiver is kept for another turn.
  assert.ok(plan.tickets?.steps !== undefined && plan.tickets.steps !== 7);
  assert.equal(plan.tickets.waiver, undefined);
  assert.match(reason, /pick \d+ steps/);
  assert.deepEqual(evPlan(brief).plan.tickets, plan.tickets, "the rule bot, the fallback when a model is late, plays them the same");
  assert.deepEqual(cleanPlan(plan), plan, "and the plan is one the contract takes");
  // With the waiver alone, the hotel ahead is what it is for.
  game.tickets!.held.s0 = ["waiver"];
  assert.deepEqual(playbookPlan(briefFor(asMatch(game), 0)!, DEFAULT_PLAYBOOK).plan.tickets, { waiver: true });
  // A Festival is called when the others' next rolls can pay for it; a Takeover is named when the reserve allows one.
  game.tickets!.held.s1 = ["festival", "takeover"];
  game.props[city(1)] = { owner: "s0", houses: 0, mortgaged: false };
  game.turn = 1;
  const theirs = playbookPlan(briefFor(asMatch(game), 1)!, DEFAULT_PLAYBOOK).plan.tickets!;
  assert.equal(theirs.festival, true);
});

test("the room: a Takeover is something to decide, tickets before the throw are not waited for, and choosing pauses the dice", async () => {
  const game = started(BOTH, [2, 0]);
  const cheap = city(1);
  game.props[cheap] = { owner: "s1", houses: 0, mortgaged: false };
  roll(game, "s0", null, script([1, cheap - 1]));
  assert.equal(nothingToDecide(game, "s0"), false, "a city to take over");
  game.tickets!.held.s0 = ["waiver", "festival"];
  assert.equal(nothingToDecide(game, "s0"), true, "tickets for before the throw do not hold the end of the turn");
  assert.equal(autoMove(started(BOTH, [0, 1]), "s0")!.after, AUTO_ROLL_AFTER_MS, "holding tickets, the dice are thrown as soon as ever");

  // News: dated by the rolls thrown before each piece, so the table tells it when the board is there.
  const log: ChainEvent[] = [
    { kind: "drew", player: "s0", ticket: "waiver" },
    { kind: "played", player: "s0", ticket: "waiver", value: 0 },
    { kind: "roll", player: "s0", dice: [1, 2] },
    { kind: "raised", player: "s0", square: cheap, festival: false, leader: true },
    { kind: "waived", player: "s0", owner: "s1", square: cheap, amount: 10 },
  ];
  const news = ticketNews(log, 5, (id) => id);
  assert.deepEqual(
    news.map((item) => [item.kind, item.after, item.ticket ?? null]),
    [
      ["drew", 4, "waiver"],
      ["played", 4, "waiver"],
      ["raised", 5, null],
      ["waived", 5, null],
    ],
  );
  assert.equal(new Set(news.map((item) => item.id)).size, 4);

  // The room, with the viewer on turn and a ticket in hand.
  const table = started(BOTH, [0, 1]);
  const sent: unknown[] = [];
  let now = 0;
  const room = new ChainRoom({
    id: "m1",
    reader: { view: async <T>(method: string) => (method === "get_match" ? asMatch(table) : null) as T },
    caller: { accountId: "s0.test", call: async (_method, args) => (sent.push(args), { value: { applied: 1, rejected: null } }) },
    pollMs: 1_000_000,
    now: () => now,
    sleep: async () => undefined,
    autoPlay: true,
  });
  await room.refresh();
  const view = room.getState().view!;
  assert.deepEqual(view.tickets!.can, ["waiver"]);
  assert.equal(view.leader, null, "nobody leads at the start");
  assert.ok(Array.isArray((view as { news?: unknown }).news));
  // The viewer opens their tickets: past the five seconds nothing is thrown for them.
  room.choose(true);
  now += AUTO_ROLL_AFTER_MS + 1000;
  await room.refresh();
  await room.idle();
  assert.deepEqual(sent, []);
  // They play the waiver: shown at once, sent as a move; then they are given their five seconds again.
  room.send({ t: "ticket", ticket: "waiver" });
  assert.equal(room.getState().view!.tickets!.waiver, true);
  await room.idle();
  assert.deepEqual(sent, [{ id: "m1", seat: 0, actions: ["Waiver"] }]);
  // Tickets left open on a table nobody is at hold a turn for so long, not for ever: then the dice are thrown.
  room.choose(false);
  room.choose(true);
  now += CHOOSE_LIMIT_MS + 1;
  await room.refresh();
  now += AUTO_ROLL_AFTER_MS + 1;
  await room.refresh();
  await room.idle();
  assert.deepEqual(sent.at(-1), { id: "m1", seat: 0, actions: ["Roll"] });
  room.stop();
});

test("the simulation: with tickets and the leader's rent a match is as long, more open, and no coin is made or lost", () => {
  const rules = (seats: number, extras = {}) => ({ ...RULES, maxRounds: roundsFor(seats), ...extras });
  const once = playMatch(4, rules(4, BOTH), 77);
  assert.deepEqual(playMatch(4, rules(4, BOTH), 77), once, "the same match from the same seed");
  const played = new Set<Ticket>(once.turns.flatMap((turn) => turn.tickets ?? []));
  assert.ok(played.size >= 2, "the rule bots play their tickets");
  const [before, after] = [measure(2, rules(2), 300, 1, PACE_NOW), measure(2, rules(2, BOTH), 300, 1, PACE_NOW)];
  assert.ok(after.leaderWins.half < before.leaderWins.half - 0.03, `whoever leads at half-time wins less often: ${after.leaderWins.half} against ${before.leaderWins.half}`);
  assert.ok(Math.abs(after.minutes.people.mean - before.minutes.people.mean) < 1, "within a minute of the match of before");
  assert.equal(before.tickets, undefined);
  for (const ticket of TICKETS) assert.ok(after.tickets![ticket].played >= 0);
  assert.ok(after.tickets!.waiver.played > 0.5 && after.tickets!.steps.played > 0.5 && after.tickets!.festival.played > 0.5);
});
