// The house: an account of the server's that takes the second seat of a table and plays it, so that somebody who came
// alone has an opponent. It stakes like any seat and plays by the same rules: it shuffles with a proof, gives its
// shares with theirs, and bets what a model (DEEDLORDS_HOUSE_MODEL) or the odds alone tell it. It sees its own two
// cards and nobody else's: the other seat's cards can only be decrypted with a key that never leaves that browser.
//
// A table that is open in somebody's tab asks for the house's step (/api/poker/house), which makes it quick. But the
// house does not depend on being asked: while it sits at a table this process looks at its tables every few seconds
// (`watch`) and plays what is waited for from it. Without that, a player could simply never ask, let the house run
// out of time, and claim its stake. A step is played once however many ask. Server only: it reads the house's key.
//
// Between hands the house is polite: it does not deal the next hand until the player says so, and when nobody deals
// (the player left the page) it leaves the table, which pays both seats what they hold, instead of claiming it.

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RULES_MODEL, llmFor } from "@/games/co-ty-phu/agent/llm";
import { intEnv, rateLimiter } from "@/games/co-ty-phu/agent/rateLimit";
import { ChainClient, type Session } from "@/lib/chain/client";
import { parseSecretKey } from "@/lib/chain/keys";
import { advise } from "./agent/decide";
import { POKER_CHAIN, RECORD_FEE, STAKE, gasFor } from "./contract";
import { type Keys, ORDER, keyProof, keysFromSecret } from "./crypto";
import { type MatchView, type SeatStore, duty, fromBase64, holeCards, toBase64 } from "./seat";

export type Played =
  | { played: true; what: string; hash: string; driver?: string }
  /** `again`: the answer may differ in a moment (the node has not seen the table yet): worth asking once more. */
  | { played: false; why: string; again?: boolean };
type House = { accountId: string; session: Session; secret: string };

/** How many tables the house sits at at once: each holds a stake of its money. */
export const MAX_HOUSE_TABLES = 4;
const ACCOUNT_ID = /^(?=.{2,64}$)[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;
const client = new ChainClient(POKER_CHAIN);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// One session for the process (it owns the key's nonce) and what was last played at each table, kept across the
// reloads of a dev server. The names carry a version: a reload must not keep what older code made.
const shelf = globalThis as {
  deedlordsPokerHouseV1?: { at: string; house: House | null };
  deedlordsPokerPlayedV1?: Map<string, number>;
  deedlordsPokerDealV1?: Map<string, number>;
  deedlordsPokerStepsV1?: Map<string, Promise<Played>>;
  deedlordsPokerWatchV1?: { timer: ReturnType<typeof setInterval>; busy: boolean; idle: number };
};
const acted = (shelf.deedlordsPokerPlayedV1 ??= new Map());
/** The hand the player asked the house to deal, per table. */
const dealAsked = (shelf.deedlordsPokerDealV1 ??= new Map());
const steps = (shelf.deedlordsPokerStepsV1 ??= new Map());
const WATCH_EVERY_MS = 5_000;
/** The house's own ceiling on model calls an hour; past it, it plays by the odds. */
const modelBudget = rateLimiter(intEnv(process.env.DEEDLORDS_LLM_GLOBAL_LIMIT, 300), 60 * 60_000);

/**
 * `null`: no house on this server. The account is POKER_HOUSE_ACCOUNT (on testnet `pokerhouse.deedlords.testnet`
 * unless told otherwise); its key POKER_HOUSE_KEY, or on a developer's machine the file NEAR's tools keep.
 */
export function house(): House | null {
  const accountId = process.env.POKER_HOUSE_ACCOUNT?.trim() ?? (POKER_CHAIN.network === "testnet" ? "pokerhouse.deedlords.testnet" : "");
  const at = `${POKER_CHAIN.network}:${accountId}`;
  if (shelf.deedlordsPokerHouseV1?.at === at) return shelf.deedlordsPokerHouseV1.house;
  let made: House | null = null;
  if (ACCOUNT_ID.test(accountId)) {
    let secret = process.env.POKER_HOUSE_KEY?.trim() ?? "";
    try {
      if (!secret) {
        const file = JSON.parse(readFileSync(join(homedir(), ".near-credentials", POKER_CHAIN.network, `${accountId}.json`), "utf8")) as { private_key?: string; secret_key?: string };
        secret = file.private_key ?? file.secret_key ?? "";
      }
      if (secret) made = { accountId, session: client.session(accountId, parseSecretKey(secret)), secret };
    } catch {
      made = null; // no key, or not a key: no house rather than a failure on every request
    }
  }
  shelf.deedlordsPokerHouseV1 = { at, house: made };
  return made;
}

/**
 * The house's card key at table `id`, made from its account key and the table's id: the same every time it is asked,
 * so nothing has to be remembered between requests, and different at every table.
 */
function cardKeys(playing: House, id: string): Keys {
  const digest = createHmac("sha256", playing.secret).update(`deedlords-poker/house/${id}`).digest("hex");
  return keysFromSecret(((BigInt(`0x${digest}`) % (ORDER - 1n)) + 1n).toString(16));
}

const store = (id: string): SeatStore => ({
  async deck(hand, step) {
    for (let tries = 0; ; tries++) {
      const deck = await client.view<string | null>("get_deck", { id, hand, step });
      if (deck) return fromBase64(deck);
      if (tries >= 8) throw new Error("the deck is not on chain yet");
      await sleep(700);
    }
  },
});

/** The tables the house sits at now. */
async function housed(playing: House): Promise<MatchView[]> {
  return (await client.view<MatchView[]>("list_matches", { from_index: 0, limit: 100 })).filter((table) => table.players.includes(playing.accountId));
}

const late = (table: MatchView): boolean => Date.now() * 1_000_000 > Number(table.deadline);

export type StepOptions = {
  /** Whether the house may take the open seat for whoever asks; not given, it may not. */
  mayJoin?: () => boolean;
  /** The player asks the house to deal the next hand. */
  deal?: boolean;
};

/**
 * One step of the house at table `id`: it takes the open seat (when `mayJoin` allows), or does what the table is
 * waiting for from it, or ends a table whose other seat ran out of time. `played: false` says why there was nothing
 * to do. Asked again while a step is on its way, it answers with that step.
 */
export function houseStep(id: string, options: StepOptions = {}): Promise<Played> {
  let pending = steps.get(id);
  if (!pending) {
    pending = step(id, options)
      // The contract refusing a step (a view a block old, somebody quicker) is nothing to report.
      .catch((error): Played => ({ played: false, why: error instanceof Error ? error.message : String(error) }))
      .finally(() => steps.delete(id));
    steps.set(id, pending);
  }
  return pending;
}

/**
 * Looks at the house's tables every few seconds for as long as it sits at one, and plays what they wait for from
 * it. Started by the first request and by every seat the house takes; it stops by itself when no table is left.
 */
export function watch(): void {
  if (shelf.deedlordsPokerWatchV1 || !house()) return;
  const watching = { busy: false, idle: 0, timer: setInterval(() => void round(), WATCH_EVERY_MS) };
  shelf.deedlordsPokerWatchV1 = watching;
  async function round() {
    const playing = house();
    if (watching.busy || !playing) return;
    watching.busy = true;
    try {
      const tables = await housed(playing);
      watching.idle = tables.length ? 0 : watching.idle + 1;
      for (const table of tables) {
        const seat = table.players.indexOf(playing.accountId);
        if (table.phase !== "lobby" && (table.awaited.includes(seat) || late(table))) await houseStep(table.id);
      }
      // A few empty rounds in a row: nothing to watch until the house sits down again.
      if (watching.idle >= 3) {
        clearInterval(watching.timer);
        shelf.deedlordsPokerWatchV1 = undefined;
      }
    } catch {
      // The node did not answer: the next round asks again.
    } finally {
      watching.busy = false;
    }
  }
}

async function step(id: string, options: StepOptions): Promise<Played> {
  const playing = house();
  if (!playing) return { played: false, why: "no house plays on this server" };
  const view = await client.view<MatchView | null>("get_match", { id });
  if (!view) {
    // Settled, or opened a moment ago and not yet seen by the node that answered.
    const settled = await client.view<unknown>("get_result", { id });
    return settled ? { played: false, why: "the table is settled" } : { played: false, why: "the table is not on chain yet", again: true };
  }
  const keys = cardKeys(playing, id);

  if (view.phase === "lobby") {
    if (view.players[0] === playing.accountId) return { played: false, why: "the house opened this table" };
    if (BigInt(view.stake) !== STAKE) return { played: false, why: "the house only sits at tables with the standard stake" };
    if (!options.mayJoin?.()) return { played: false, why: "too many tables were asked for from here: wait a few minutes" };
    const tables = await housed(playing);
    // A table whose other seat ran out of time is claimed first: its stake comes back to the house.
    for (const stale of tables.filter((table) => late(table) && !table.awaited.includes(table.players.indexOf(playing.accountId))).slice(0, 2)) {
      await playing.session.call("timeout", { id: stale.id }, gasFor("timeout")).catch(() => undefined);
    }
    if ((await housed(playing)).length >= MAX_HOUSE_TABLES) return { played: false, why: "the house is at every table it can play right now: try again in a few minutes" };
    const outcome = await playing.session.transact([{ method: "join", args: jsonBytes({ id, key: toBase64(keyProof(keys, playing.accountId)) }), gas: gasFor("join"), deposit: STAKE + RECORD_FEE }]);
    watch();
    return { played: true, what: "join", hash: outcome.hash };
  }

  const seat = view.players.indexOf(playing.accountId);
  if (seat < 0) return { played: false, why: "the house does not sit at this table" };
  // A node may answer from the block before for a moment: what was played on this view is not played again.
  if ((acted.get(id) ?? -1) >= view.seq) return { played: false, why: "that step is already played" };
  // What the house thought for a bet names its cards: it is not sent to the page (tables of two to nine seats open it
  // after the hand, table/sealed.ts).
  const done = (outcome: { hash: string }, what: string, more: { driver?: string } = {}): Played => {
    acted.set(id, view.seq);
    if (acted.size > 500) for (const key of [...acted.keys()].slice(0, 250)) acted.delete(key);
    return { played: true, what, hash: outcome.hash, ...more };
  };

  if (options.deal) dealAsked.set(id, view.hand);
  if (dealAsked.size > 500) for (const key of [...dealAsked.keys()].slice(0, 250)) dealAsked.delete(key);
  // Before the first shuffle of a hand either seat may leave, and both are paid what they hold.
  const betweenHands = view.phase === "shuffle" && view.shuffled === 0;
  if (!view.awaited.includes(seat)) {
    if (!late(view)) return { played: false, why: "the table is waiting for the other seat" };
    // The other seat ran out of time. In a hand, that forfeits the table. Between hands the player has only walked
    // away: the house leaves instead, and each is paid its chips.
    const how = betweenHands ? "leave" : "timeout";
    return done(await playing.session.call(how, { id }, gasFor(how)), how);
  }
  if (betweenHands && view.hand > 0 && dealAsked.get(id) !== view.hand) {
    // The house is to deal the next hand. It waits for the player to say so, for half of the time it has; then it
    // leaves the table rather than run out of time itself.
    const left = Number(view.deadline) / 1_000_000 - Date.now();
    if (left > (view.turnSeconds * 1_000) / 2) return { played: false, why: "the house deals the next hand when you say so" };
    return done(await playing.session.call("leave", { id }, gasFor("leave")), "leave");
  }
  if (view.phase === "bet") {
    const hole = holeCards(view, seat, keys, await store(id).deck(view.hand, 1));
    if (!hole || hole.some((card) => card === null)) return { played: false, why: "the house cannot read its cards" };
    const name = process.env.DEEDLORDS_HOUSE_MODEL?.trim();
    const llm = !name || name === RULES_MODEL || !modelBudget.allow("*") ? null : llmFor(process.env, name);
    const advice = await advise(view, seat, hole as number[], { llm });
    const outcome = await playing.session.call("act", { id, seat, action: advice.action, amount: advice.amount ?? null }, gasFor("act"));
    return done(outcome, advice.action === "raise" ? `raise to ${advice.amount}` : advice.action === "fold" ? "fold" : view.bet[1 - seat] > view.bet[seat] ? "call" : "check", { driver: advice.driver });
  }
  const owed = await duty(view, seat, keys, store(id));
  if (!owed) return { played: false, why: "nothing is owed" };
  return done(await playing.session.call(owed.method, owed.args, gasFor(owed.method)), owed.method);
}

const jsonBytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
