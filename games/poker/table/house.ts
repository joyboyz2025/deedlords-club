// The house at tables of two to nine seats: accounts of the server's that take free seats when a player asks, so
// that somebody who came alone, or a table that is short, has opponents. Each stakes like any seat and plays by the
// same rules: it shuffles with a proof, gives its shares, and bets what a model (DEEDLORDS_HOUSE_MODEL) or the odds
// alone tell it. Each house seat may be given a model of its own when it is asked to sit down (one of the models the
// server offers, the same list as the board game's agents); without one it bets by DEEDLORDS_HOUSE_MODEL. It sees its
// own two cards and nobody else's.
//
// The model of each seat is remembered by this process only: a server that restarts mid-table plays those seats by
// DEEDLORDS_HOUSE_MODEL from then on.
//
// A table that is open in somebody's tab asks for the house's step (/api/poker/table/house), which makes it quick.
// But the house does not depend on being asked: while it sits at a table this process looks at its tables every few
// seconds (`watch`) and plays what is waited for from it, and calls time on a seat that ran out of it. When no
// player is left at a table, the house's seats leave it. Server only: it reads the house's keys.
//
// The same watch keeps every other table moving too (`sweep`): a table whose deadline passed a while ago, with no
// house seat at it, is one whose players all closed their tabs. Nothing is lost there, but nothing moves either until
// somebody calls time, so the house's first account does, paying only the gas (about 0.0003 NEAR). It bets nothing
// there and takes nothing: the contract pays what calling time pays to the seats, never to whoever calls it.
// POKER_SWEEP_ACCOUNT names an account that does only that (no house seat at all, so no stake on the table): its key
// is POKER_SWEEP_KEY, or the file NEAR's tools keep. With it the watch runs, and sweeps, on a server with no house.
//
// Free tables (a stake of nothing; the contract lets only its owner's own accounts open one): the account that
// sponsors free play (lib/chain/sponsor.ts) opens them and holds seat 0 at each, played here like any house seat. It
// never sits at a table with a stake. A visitor's seat there costs nothing, and their calls are sent by the same
// sponsor (app/api/relay), so a game account with no NEAR plays poker against it.

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RULES_MODEL, llmFor, llmModels } from "@/games/co-ty-phu/agent/llm";
import { intEnv, rateLimiter } from "@/games/co-ty-phu/agent/rateLimit";
import { ChainClient, type Session } from "@/lib/chain/client";
import { MOVE_GAS } from "@/lib/chain/config";
import { parseSecretKey } from "@/lib/chain/keys";
import { sponsor } from "@/lib/chain/sponsor";
import { type FunctionCall, jsonArgs } from "@/lib/chain/transaction";
import { type Keys, ORDER, keyProof, keysFromSecret } from "../crypto";
import { FREE_TABLE_DEPOSIT, FREE_TABLE_HANDS, MAX_SEATS, RECORD_FEE, STAKE, TABLE_CHAIN, TABLE_CONTRACT, gasFor } from "./contract";
import { advise } from "./decide";
import { type SeatStore, type TableView, betCall, betOptions, duty, fromBase64, holeCards, toBase64 } from "./seat";

export type Played =
  | { played: true; what: string; seat?: number; hash: string; reason?: string; driver?: string; account?: string; model?: string }
  /** `again`: the answer may differ in a moment (the node has not seen the table yet): worth asking once more. */
  | { played: false; why: string; again?: boolean };
type House = { accountId: string; session: Pick<Session, "call" | "transact">; secret: string };

/** How many tables one house account sits at at once: each holds a stake of its money. */
export const MAX_HOUSE_TABLES = 4;
/** How many free tables may be open at once: each holds a deposit of the sponsor's until it closes. */
export const MAX_FREE_TABLES = intEnv(process.env.POKER_FREE_TABLES, 4);
/** What an account must hold for a node to take a shuffle with its 260 Tgas attached: about 0.3 NEAR. */
const SHUFFLE_RESERVE = 3n * 10n ** 23n;
/** A free table nobody came to is closed by its host this long after it was opened. */
const FREE_LOBBY_MS = 10 * 60_000;
const ACCOUNT_ID = /^(?=.{2,64}$)[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;
const client = new ChainClient(TABLE_CHAIN);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// One session per account for the process (it owns the key's nonce) and what was last played at each seat, kept
// across the reloads of a dev server. The names carry a version: a reload must not keep what older code made.
const shelf = globalThis as {
  deedlordsTableHousesV1?: { at: string; houses: House[] };
  deedlordsTablePlayedV1?: Map<string, number>;
  deedlordsTableStepsV1?: Map<string, Promise<Played>>;
  deedlordsTableWatchV2?: { timer: ReturnType<typeof setInterval>; busy: boolean; idle: number };
  deedlordsTableModelsV1?: Map<string, string>;
  deedlordsTableSweeperV1?: { at: string; sweeper: { accountId: string; session: Session } | null };
};
const acted = (shelf.deedlordsTablePlayedV1 ??= new Map());
const steps = (shelf.deedlordsTableStepsV1 ??= new Map());
/** The model each house seat bets by, under `<table id>:<house account>`. */
const seatModels = (shelf.deedlordsTableModelsV1 ??= new Map());

/** The models a house seat may be given: the server's, or `rules` for the odds alone. */
export const houseModels = (): string[] => [...llmModels(process.env), RULES_MODEL];
const defaultModel = (): string => process.env.DEEDLORDS_HOUSE_MODEL?.trim() || RULES_MODEL;

/** The model each house seat at table `id` bets by, by account. */
export function modelsAt(id: string, accounts: string[]): Record<string, string> {
  return Object.fromEntries(accounts.map((account) => [account, seatModel(id, account)]));
}
/** The model the seat of `account` at table `id` bets by. */
function seatModel(id: string, account: string): string {
  return seatModels.get(`${id}:${account}`) ?? (account === sponsor()?.accountId ? modelInId(id) : null) ?? defaultModel();
}
const WATCH_EVERY_MS = 5_000;
/** A table without the house is swept this long after its deadline: a player's own page calls time first. */
const SWEEP_GRACE_MS = 30_000;
/** The account that calls time on tables without a house seat: POKER_SWEEP_ACCOUNT, else the first house account. */
function sweeper(): Pick<House, "accountId" | "session"> | null {
  const accountId = process.env.POKER_SWEEP_ACCOUNT?.trim() ?? "";
  const at = `${TABLE_CHAIN.network}:${accountId}`;
  if (shelf.deedlordsTableSweeperV1?.at === at) return shelf.deedlordsTableSweeperV1.sweeper ?? houses()[0] ?? null;
  let made: { accountId: string; session: Session } | null = null;
  if (ACCOUNT_ID.test(accountId)) {
    try {
      let secret = process.env.POKER_SWEEP_KEY?.trim() ?? "";
      if (!secret) {
        const file = JSON.parse(readFileSync(join(homedir(), ".near-credentials", TABLE_CHAIN.network, `${accountId}.json`), "utf8")) as {
          private_key?: string;
          secret_key?: string;
        };
        secret = file.private_key ?? file.secret_key ?? "";
      }
      if (secret) made = { accountId, session: client.session(accountId, parseSecretKey(secret)) };
    } catch {
      made = null; // no key, or not a key: the first house account sweeps, if there is one
    }
  }
  shelf.deedlordsTableSweeperV1 = { at, sweeper: made };
  return made ?? houses()[0] ?? null;
}

/** The house's own ceiling on model calls an hour; past it, it plays by the odds. */
const modelBudget = rateLimiter(intEnv(process.env.DEEDLORDS_LLM_GLOBAL_LIMIT, 300), 60 * 60_000);

/**
 * The house's accounts that have a key here, in the order they take seats. POKER_HOUSE_ACCOUNTS names them (commas);
 * on testnet they are pokerhouse, pokerhouse2 and pokerhouse3 .deedlords.testnet unless told otherwise. A key is
 * POKER_HOUSE_KEYS (commas, same order), or on a developer's machine the file NEAR's tools keep.
 */
export function houses(): House[] {
  const names = (
    process.env.POKER_HOUSE_ACCOUNTS?.trim() ??
    (TABLE_CHAIN.network === "testnet" ? "pokerhouse.deedlords.testnet,pokerhouse2.deedlords.testnet,pokerhouse3.deedlords.testnet" : "")
  )
    .split(",")
    .map((name) => name.trim())
    .filter((name) => ACCOUNT_ID.test(name));
  const at = `${TABLE_CHAIN.network}:${names.join(",")}`;
  if (shelf.deedlordsTableHousesV1?.at === at) return shelf.deedlordsTableHousesV1.houses;
  const given = (process.env.POKER_HOUSE_KEYS ?? "").split(",").map((key) => key.trim());
  const made: House[] = [];
  names.forEach((accountId, index) => {
    try {
      let secret = given[index] ?? "";
      if (!secret) {
        const file = JSON.parse(readFileSync(join(homedir(), ".near-credentials", TABLE_CHAIN.network, `${accountId}.json`), "utf8")) as {
          private_key?: string;
          secret_key?: string;
        };
        secret = file.private_key ?? file.secret_key ?? "";
      }
      if (secret) made.push({ accountId, session: client.session(accountId, parseSecretKey(secret)), secret });
    } catch {
      // No key, or not a key: that account plays no seat.
    }
  });
  shelf.deedlordsTableHousesV1 = { at, houses: made };
  return made;
}

/**
 * A house account's card key at table `id`, made from its account key and the table's id: the same every time it is
 * asked, so nothing has to be remembered between requests, and different at every table.
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

/**
 * The free tables' host: the account that sponsors free play, as a seat of the house. Its calls go out through the
 * sponsor's own session, which owns the nonce of its key. `null` when this server sponsors nothing.
 */
export function freeHost(): House | null {
  // On mainnet only once it is switched on (POKER_FREE=1): the contract there must be the build that takes a stake of
  // nothing, and every hand costs the sponsor real NEAR.
  if (TABLE_CHAIN.network === "mainnet" && process.env.POKER_FREE?.trim() !== "1") return null;
  const paying = sponsor();
  if (!paying) return null;
  const send = (calls: FunctionCall[]) => paying.session.sendTo(TABLE_CONTRACT, calls);
  return {
    accountId: paying.accountId,
    secret: paying.secret,
    session: { call: (method, args, gas = MOVE_GAS) => send([{ method, args: jsonArgs(args), gas, deposit: 0n }]), transact: send },
  };
}

/** Every account the server plays seats with: the house's, and the free tables' host (which sits at free tables only). */
export function seats(): House[] {
  const [staking, host] = [houses(), freeHost()];
  return host && !staking.some((one) => one.accountId === host.accountId) ? [...staking, host] : staking;
}

const isHouse = (accountId: string | null): boolean => seats().some((playing) => playing.accountId === accountId);
const isFree = (table: Pick<TableView, "stake">): boolean => BigInt(table.stake) === 0n;
/** When a free table was opened, from its id (`f-<time in base 36>-…`); 0 for any other id. */
const openedAt = (id: string): number => (/^f-([0-9a-z]{6,9})-/.test(id) ? parseInt(id.split("-")[1], 36) : 0);
/** The model a free table's host bets by is written in its id, for a server that remembers nothing between requests. */
const modelInId = (id: string): string | null => {
  const letter = /^f-[0-9a-z]+-[0-9a-z]{4}-([0-9a-z])$/.exec(id)?.[1];
  return letter === undefined ? null : (houseModels()[parseInt(letter, 36)] ?? null);
};
/** Every table that is not settled, in pages. */
async function everyTable(): Promise<TableView[]> {
  const all: TableView[] = [];
  for (let from = 0; ; from += 100) {
    const page = await client.view<TableView[]>("list_matches", { from_index: from, limit: 100 });
    all.push(...page);
    if (page.length < 100) return all;
  }
}

/** The tables a house account sits at now. */
async function housed(): Promise<TableView[]> {
  return (await everyTable()).filter((table) => table.players.some(isHouse));
}

/**
 * Calls time on every table without a house seat whose deadline passed more than `SWEEP_GRACE_MS` ago, once per
 * change of the table. Returns how many tables it moved.
 */
export async function sweep(tables: TableView[]): Promise<number> {
  const caller = sweeper();
  if (!caller) return 0;
  let moved = 0;
  for (const table of tables) {
    if (table.phase === "lobby" || table.players.some(isHouse)) continue;
    if (Date.now() < Number(table.deadline) / 1_000_000 + SWEEP_GRACE_MS) continue;
    if ((acted.get(`${table.id}:time`) ?? -1) >= table.seq) continue;
    acted.set(`${table.id}:time`, table.seq);
    try {
      await caller.session.call("timeout", { id: table.id }, gasFor("timeout"));
      moved += 1;
    } catch {
      // Somebody was quicker, or the node answered from a block before: the next round looks again.
    }
  }
  return moved;
}

const late = (table: TableView): boolean => Date.now() * 1_000_000 > Number(table.deadline);

export type StepOptions = {
  /** A player asks for one more house seat at the table. */
  add?: boolean;
  /** The model the seat asked for bets by: one of `houseModels()`. */
  model?: string;
  /** Whether the house may take a seat for whoever asks; not given, it may not. */
  mayJoin?: () => boolean;
};

/**
 * One step of the house at table `id`: a house account takes a free seat (with `add`, when `mayJoin` allows), or
 * the house's seats do what the table is waiting for from them, or call time on a seat that ran out of it, or leave
 * a table no player sits at any more. `played: false` says why there was nothing to do. Asked again while a step is
 * on its way, it answers with that step.
 */
export function houseStep(id: string, options: StepOptions = {}): Promise<Played> {
  const ticket = `${id}:${options.add ? "add" : "play"}`;
  let pending = steps.get(ticket);
  if (!pending) {
    pending = step(id, options)
      // The contract refusing a step (a view a block old, somebody quicker) is nothing to report.
      .catch((error): Played => ({ played: false, why: error instanceof Error ? error.message : String(error) }))
      .finally(() => steps.delete(ticket));
    steps.set(ticket, pending);
  }
  return pending;
}

/**
 * Looks at the house's tables every few seconds for as long as it sits at one, and plays what they wait for from
 * it. Started by the first request and by every seat the house takes; it stops by itself when no table is left.
 */
export function watch(): void {
  if (shelf.deedlordsTableWatchV2 || (!seats().length && !sweeper())) return;
  const watching = { busy: false, idle: 0, timer: setInterval(() => void round(), WATCH_EVERY_MS) };
  shelf.deedlordsTableWatchV2 = watching;
  async function round() {
    if (watching.busy) return;
    watching.busy = true;
    try {
      const all = await everyTable();
      const tables = all.filter((table) => table.players.some(isHouse));
      // Any table under way keeps the watch going: it may need time called on it.
      watching.idle = all.some((table) => table.phase !== "lobby") ? 0 : watching.idle + 1;
      for (const table of tables) if (table.phase !== "lobby") await houseStep(table.id);
      await sweep(all);
      // A few empty rounds in a row: nothing to watch until the house sits down again or a table is asked about.
      if (watching.idle >= 3) {
        clearInterval(watching.timer);
        shelf.deedlordsTableWatchV2 = undefined;
      }
    } catch {
      // The node did not answer: the next round asks again.
    } finally {
      watching.busy = false;
    }
  }
}

async function step(id: string, options: StepOptions): Promise<Played> {
  const playing = seats();
  if (!playing.length) return { played: false, why: "no house plays on this server" };
  const view = await client.view<TableView | null>("get_match", { id });
  if (!view) {
    // Settled, or opened a moment ago and not yet seen by the node that answered.
    const settled = await client.view<unknown>("get_result", { id });
    return settled ? { played: false, why: "the table is settled" } : { played: false, why: "the table is not on chain yet", again: true };
  }
  const here = playing.filter((one) => view.players.includes(one.accountId));

  if (options.add) {
    if (!view.players.includes(null)) return { played: false, why: "every seat is taken" };
    if (!view.players.some((player) => player && !isHouse(player))) return { played: false, why: "the house sits down with players, not alone" };
    // At a free table any of the server's accounts may sit: nothing is staked. With a stake, only the house's own.
    if (!isFree(view) && BigInt(view.stake) !== STAKE) return { played: false, why: "the house only sits at free tables and at tables with the standard stake" };
    const free = (isFree(view) ? playing : houses()).filter((one) => !here.includes(one));
    if (!free.length) return { played: false, why: isFree(view) || houses().length ? "every house seat is already at this table" : "no house plays for stakes on this server" };
    if (!options.mayJoin?.()) return { played: false, why: "too many seats were asked for from here: wait a few minutes" };
    const tables = await housed();
    const next = free.find((one) => tables.filter((table) => table.players.includes(one.accountId)).length < MAX_HOUSE_TABLES);
    if (!next) return { played: false, why: "the house is at every table it can play right now: try again in a few minutes" };
    const key = toBase64(keyProof(cardKeys(next, id), next.accountId));
    const outcome = await next.session.transact([{ method: "join", args: jsonBytes({ id, key }), gas: gasFor("join"), deposit: isFree(view) ? 0n : STAKE + RECORD_FEE }]);
    if (options.model) seatModels.set(`${id}:${next.accountId}`, options.model);
    if (seatModels.size > 2_000) for (const key of [...seatModels.keys()].slice(0, 1_000)) seatModels.delete(key);
    watch();
    return { played: true, what: "join", hash: outcome.hash, account: next.accountId, model: options.model ?? defaultModel() };
  }

  if (!here.length) return { played: false, why: "the house does not sit at this table" };
  if (view.phase === "lobby") {
    // A free table nobody came to: its host closes it, and the deposit comes back.
    const host = here.find((one) => one.accountId === view.host);
    if (host && isFree(view) && !view.players.some((player) => player && !isHouse(player)) && Date.now() > openedAt(id) + FREE_LOBBY_MS) {
      const outcome = await host.session.call("leave", { id }, gasFor("leave"));
      return { played: true, what: "leave", hash: outcome.hash };
    }
    return { played: false, why: "the table has not started" };
  }
  const seatOf = (one: House) => view.players.indexOf(one.accountId);
  // No player is left: the house's seats ask to leave, each paid what it holds, and the table closes. A hand under
  // way is played to its end first, which is what the rest of this step does.
  // A free table's host has played its hands: it asks to leave too, and the table closes when this hand is over.
  const spent = isFree(view) && view.hand >= FREE_TABLE_HANDS - 1 ? here.filter((one) => one.accountId === view.host && !view.leaving[seatOf(one)]) : [];
  const staying = view.players.some((player) => player && !isHouse(player)) ? spent : here.filter((one) => !view.leaving[seatOf(one)]);
  if (staying.length) {
    const outcomes = await Promise.all(staying.map((one) => one.session.call("leave", { id }, gasFor("leave"))));
    return { played: true, what: "leave", hash: outcomes[0].hash };
  }
  // A node may answer from the block before for a moment: what a seat played on this view is not played again.
  const due = here.filter((one) => view.awaited.includes(seatOf(one)) && (acted.get(`${id}:${seatOf(one)}`) ?? -1) < view.seq);
  if (!due.length) {
    if (here.some((one) => view.awaited.includes(seatOf(one)))) return { played: false, why: "that step is already played" };
    if (!late(view)) return { played: false, why: "the table is waiting for another seat" };
    if ((acted.get(`${id}:time`) ?? -1) >= view.seq) return { played: false, why: "time was already called" };
    const outcome = await here[0].session.call("timeout", { id }, gasFor("timeout"));
    acted.set(`${id}:time`, view.seq);
    return { played: true, what: "timeout", hash: outcome.hash };
  }
  if (acted.size > 2_000) for (const key of [...acted.keys()].slice(0, 1_000)) acted.delete(key);
  // Shares are owed by several seats at once; a shuffle or a bet by one.
  const played = await Promise.all(
    due.map(async (one): Promise<Played> => {
      const [seat, keys] = [seatOf(one), cardKeys(one, id)];
      const done = (outcome: { hash: string }, what: string, more: { reason?: string; driver?: string } = {}): Played => {
        acted.set(`${id}:${seat}`, view.seq);
        return { played: true, what, seat, hash: outcome.hash, ...more };
      };
      if (view.phase === "bet") {
        const hole = holeCards(view, seat, keys, await store(id).deck(view.hand, view.dealt.length - 1));
        if (!hole || hole.some((card) => card === null)) return { played: false, why: "the house cannot read its cards" };
        const name = seatModel(id, one.accountId);
        const llm = name === RULES_MODEL || !modelBudget.allow("*") ? null : llmFor(process.env, name);
        const advice = await advise(view, seat, hole as number[], { llm });
        const call = await betCall(view, seat, advice.action, advice.amount, keys, store(id));
        // With nothing bet on the street yet a raise is a bet.
        const raised = Math.max(...view.bet) === 0 ? `bet ${advice.amount}` : `raise to ${advice.amount}`;
        const what = advice.action === "raise" ? raised : advice.action === "fold" ? "fold" : betOptions(view, seat).owed > 0 ? "call" : "check";
        return done(await one.session.call(call.method, call.args, gasFor(call.method, call.args)), what, { reason: advice.reason, driver: advice.driver });
      }
      const owed = await duty(view, seat, keys, store(id));
      if (!owed) return { played: false, why: "nothing is owed" };
      return done(await one.session.call(owed.method, owed.args, gasFor(owed.method, owed.args)), owed.method);
    }),
  );
  return played.find((one) => one.played) ?? played[0];
}

const jsonBytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

/**
 * Opens a free table of `seats` seats for whoever asks: the sponsor's account hosts it and holds seat 0, betting by
 * `model` (one of `houseModels()`; the server's house model when not given). Free tables nobody came to are closed
 * first. Throws with what to tell the visitor when there is no room or no sponsor.
 */
export async function openFreeTable(seatCount: number, model: string | undefined, turnSeconds: number): Promise<{ id: string; hash: string; host: string; model: string }> {
  const host = freeHost();
  if (!host) throw new Error("no free tables on this server");
  if (!Number.isInteger(seatCount) || seatCount < 2 || seatCount > MAX_SEATS) throw new Error(`seats: 2 to ${MAX_SEATS}`);
  // The host must hold the table's deposit and what a shuffle's gas reserves, for its own seat and for the visitor's.
  const held = await client.balance(host.accountId);
  if (held === null || held < FREE_TABLE_DEPOSIT + 2n * SHUFFLE_RESERVE)
    throw new Error("the house is out of NEAR for free tables right now: try a table with a stake, or come back later");
  const mine = (await everyTable()).filter((table) => isFree(table) && table.host === host.accountId);
  const stale = mine.filter((table) => table.phase === "lobby" && !table.players.some((player) => player && !isHouse(player)) && Date.now() > openedAt(table.id) + FREE_LOBBY_MS);
  const closed = await Promise.allSettled(stale.slice(0, 3).map((table) => host.session.call("leave", { id: table.id }, gasFor("leave"))));
  if (mine.length - closed.filter((one) => one.status === "fulfilled").length >= MAX_FREE_TABLES)
    throw new Error("every free table is taken right now: join one from the wall, or try again in a few minutes");
  const place = model === undefined ? -1 : houseModels().indexOf(model);
  const letters = Array.from({ length: 4 }, () => "abcdefghijkmnpqrstuvwxyz"[Math.floor(Math.random() * 24)]).join("");
  const id = `f-${Date.now().toString(36)}-${letters}${place >= 0 && place < 36 ? `-${place.toString(36)}` : ""}`;
  const key = toBase64(keyProof(cardKeys(host, id), host.accountId));
  const outcome = await host.session.transact([
    { method: "create_match", args: jsonBytes({ id, stake: "0", key, seats: seatCount, turn_seconds: turnSeconds }), gas: gasFor("create_match"), deposit: FREE_TABLE_DEPOSIT },
  ]);
  if (model) seatModels.set(`${id}:${host.accountId}`, model);
  watch();
  return { id, hash: outcome.hash, host: host.accountId, model: seatModel(id, host.accountId) };
}

/** The host starts its free table that is not full, once a player sits at it: only the host can, and the host is the server's. */
export async function startFreeTable(id: string): Promise<Played> {
  const host = freeHost();
  if (!host) return { played: false, why: "no free tables on this server" };
  const view = await client.view<TableView | null>("get_match", { id });
  if (!view) return { played: false, why: "the table is not on chain yet", again: true };
  if (!isFree(view) || view.host !== host.accountId) return { played: false, why: "not a free table of this server" };
  if (view.phase !== "lobby") return { played: false, why: "the table has started" };
  if (!view.players.some((player) => player && !isHouse(player))) return { played: false, why: "nobody sits at the table yet" };
  const outcome = await host.session.call("start", { id }, gasFor("start"));
  watch();
  return { played: true, what: "start", hash: outcome.hash };
}

/** Whether table `id` is a free one the server pays the players' calls of: asked by the relayer for every call. */
export async function isFreeTableOfOurs(id: string): Promise<boolean> {
  const until = freeKnown.get(id);
  if (until !== undefined && until > Date.now()) return true;
  const view = await client.view<TableView | null>("get_match", { id });
  // The contract lets only its owner's own accounts open a table with a stake of nothing.
  if (!view || !isFree(view) || !isHouse(view.host)) return false;
  if (freeKnown.size > 500) freeKnown.clear();
  freeKnown.set(id, Date.now() + 30 * 60_000);
  return true;
}
const freeKnown = new Map<string, number>();
