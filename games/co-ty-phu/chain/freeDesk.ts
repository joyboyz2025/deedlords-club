// The server's side of free play: which matches the sponsor pays for, and the limits that keep a public deployment
// from being drained. Everything the sponsor signs goes through here or through relayRules.ts.

import { chainClient } from "../../../lib/chain/shared.ts";
import type { Sponsor } from "../../../lib/chain/sponsor.ts";
import { intEnv, rateLimiter } from "../agent/rateLimit.ts";
import type { ChainMatch, ChainMeta } from "./types.ts";

const env = process.env;
const TEN_MINUTES = 10 * 60_000;
const HOUR = 60 * 60_000;

// 0 disables a limit. A relayed move burns about 0.0005 NEAR of the sponsor's; a table holds 0.06 until it is settled.
export const limits = {
  /** Relayed calls: a match is 50 to 150 of them a seat. */
  relayPerIp: rateLimiter(intEnv(env.DEEDLORDS_RELAY_IP_LIMIT, 400), TEN_MINUTES),
  relayPerAccount: rateLimiter(intEnv(env.DEEDLORDS_RELAY_IP_LIMIT, 400), TEN_MINUTES),
  relayGlobal: rateLimiter(intEnv(env.DEEDLORDS_RELAY_GLOBAL_LIMIT, 6000), HOUR),
  /** New game accounts brought into existence, and free tables opened. */
  openPerIp: rateLimiter(intEnv(env.DEEDLORDS_FREE_IP_LIMIT, 6), TEN_MINUTES),
  openGlobal: rateLimiter(intEnv(env.DEEDLORDS_FREE_GLOBAL_LIMIT, 120), HOUR),
  tablePerIp: rateLimiter(intEnv(env.DEEDLORDS_FREE_IP_LIMIT, 6), TEN_MINUTES),
  tableGlobal: rateLimiter(intEnv(env.DEEDLORDS_FREE_GLOBAL_LIMIT, 120), HOUR),
  /** Key grants signed through NEAR Auth: each is a 300 Tgas call of the sponsor's. One per sign-in on a new browser. */
  grantPerIp: rateLimiter(intEnv(env.DEEDLORDS_GRANT_IP_LIMIT, 4), TEN_MINUTES),
  grantGlobal: rateLimiter(intEnv(env.DEEDLORDS_GRANT_GLOBAL_LIMIT, 60), HOUR),
  /** Stakes and withdrawals signed through NEAR Auth: the same call, asked for once per stake. */
  signPerIp: rateLimiter(intEnv(env.DEEDLORDS_SIGN_IP_LIMIT, 20), TEN_MINUTES),
  signPerAccount: rateLimiter(intEnv(env.DEEDLORDS_SIGN_IP_LIMIT, 20), TEN_MINUTES),
  signGlobal: rateLimiter(intEnv(env.DEEDLORDS_SIGN_GLOBAL_LIMIT, 300), HOUR),
  /** Turns of the house agent asked for. Every watcher asks, the server plays each turn once. */
  movePerIp: rateLimiter(intEnv(env.DEEDLORDS_RELAY_IP_LIMIT, 400), TEN_MINUTES),
};

/** How many free tables may be open at once: each holds a storage deposit of the sponsor's until it ends. */
export const MAX_FREE_TABLES = intEnv(env.DEEDLORDS_FREE_TABLES, 12);

export const jsonAnswer = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * The model each house agent of a free table plays with, by seat, as whoever opened it chose. Kept in this process:
 * after a restart a house seat plays with the server's house model (DEEDLORDS_HOUSE_MODEL).
 */
const houseSeats = new Map<string, Record<number, string>>();

export function rememberHouseSeats(id: string, models: Record<number, string>): void {
  if (houseSeats.size > 2_000) houseSeats.delete(houseSeats.keys().next().value!);
  houseSeats.set(id, models);
}

/**
 * A free table's id with its house agents' models written into it, one base-36 letter each (seat 1, 2, 3): the place
 * of the model in `offered`. A server that keeps nothing between requests (one serverless call opens the table, another
 * plays its turns) reads them back from the id. Left as it is when a model is not in the first 36 offered.
 */
export function idWithHouseSeats(base: string, models: string[], offered: string[]): string {
  const places = models.map((model) => offered.indexOf(model));
  if (!places.length || places.some((place) => place < 0 || place >= 36)) return base;
  return `${base}-${places.map((place) => place.toString(36)).join("")}`;
}

const HOUSE_SEATS_IN_ID = /^f-[0-9a-z]+-[a-z]{4}-([0-9a-z]{1,3})$/;

/**
 * The model chosen for a house seat, or `null` when none was (the server's house model plays): the one remembered by
 * this process, else the one the id names among `offered` (the same list, in the same order, the table was opened with).
 */
export function houseSeatModel(id: string, seat: number, offered: string[] = []): string | null {
  const kept = houseSeats.get(id)?.[seat];
  if (kept) return kept;
  const letter = HOUSE_SEATS_IN_ID.exec(id)?.[1]?.[seat - 1];
  return letter === undefined ? null : (offered[parseInt(letter, 36)] ?? null);
}

/** The most house agents a free table seats: the board takes four seats, one is the visitor's. */
export const MAX_HOUSE_AGENTS = 3;

/** A table the sponsor opened and nobody staked on: the only kind it pays moves for. */
export const isFreeTable = (meta: ChainMeta, sponsor: Sponsor) => meta.stake === "0" && meta.creator === sponsor.accountId;

// A match's stake and creator never change, so a yes is remembered. A no is asked again: the match may not have been
// visible yet to the node that answered.
const known = new Map<string, number>();
const REMEMBER_MS = 30 * 60_000;

/** A table this server has just opened: no need to ask the chain about it. */
export function rememberSponsored(id: string, sponsor: Sponsor): void {
  const now = Date.now();
  if (known.size > 2_000) for (const [key, until] of known) if (until <= now) known.delete(key);
  known.set(`${sponsor.accountId}:${id}`, now + REMEMBER_MS);
}

export async function isSponsored(id: string, sponsor: Sponsor): Promise<boolean> {
  const until = known.get(`${sponsor.accountId}:${id}`);
  if (until !== undefined && until > Date.now()) return true;
  const match = await chainClient.view<ChainMatch | null>("get_match", { id });
  if (!match || !isFreeTable(match.meta, sponsor)) return false;
  rememberSponsored(id, sponsor);
  return true;
}

// A key an account granted for the game contract stays granted: a yes is remembered, a no is asked again.
const granted = new Map<string, number>();

/** Whether `publicKey` is a function-call key the account holds for the game contract (see relayRules `relayable`). */
export async function isGrantedKey(accountId: string, publicKey: Uint8Array): Promise<boolean> {
  const name = `${accountId}:${Array.from(publicKey).join(",")}`;
  if ((granted.get(name) ?? 0) > Date.now()) return true;
  const key = await chainClient.functionCallKey(accountId, publicKey);
  if (key?.receiverId !== chainClient.config.contractId) return false;
  if (granted.size > 2_000) for (const [k, until] of granted) if (until <= Date.now()) granted.delete(k);
  granted.set(name, Date.now() + REMEMBER_MS);
  return true;
}

/** Every unfinished match the sponsor opened, lobby or playing. */
export async function sponsoredTables(sponsor: Sponsor): Promise<ChainMeta[]> {
  const mine: ChainMeta[] = [];
  for (let from = 0; from < 400; from += 50) {
    const page = await chainClient.view<ChainMeta[]>("list_matches", { from_index: from, limit: 50 });
    mine.push(...page.filter((meta) => meta.creator === sponsor.accountId));
    if (page.length < 50) break;
  }
  return mine;
}

/** A lobby nobody else came to is abandoned (the contract allows it 15 minutes after it was opened). */
export const ABANDON_AFTER_MS = 16 * 60_000;
/**
 * A free table under way where nothing has moved for this long has been left: while somebody has it open, the page
 * throws the dice within seconds and the house plays its turns, so a quiet table is one whose players closed it.
 */
export const LEFT_AFTER_MS = 20 * 60_000;

/**
 * What the sponsor does about its tables before it opens another, so that tables people left do not hold every place
 * for ever: lobbies nobody came to are abandoned (`abandon`), and at tables under way that were left the house's seats
 * give up (`resign`: the seats it backs), which ends a table where only one other seat is left, and returns the
 * sponsor's storage deposit. `open`: the tables that still count against `MAX_FREE_TABLES`; a left table with no house
 * seat to give up (a room of friends) no longer does.
 */
export function tidyFreeTables(tables: ChainMeta[], sponsorId: string, now: number): { abandon: string[]; resign: { id: string; seats: number[] }[]; open: number } {
  const ms = (nanos: string) => Number(BigInt(nanos) / 1_000_000n);
  const abandon = tables.filter((meta) => meta.status === "lobby" && ms(meta.created_at) + ABANDON_AFTER_MS < now).map((meta) => meta.id);
  const left = tables.filter((meta) => meta.status === "playing" && ms(meta.last_activity) + LEFT_AFTER_MS < now);
  const resign = left
    .map((meta) => ({ id: meta.id, seats: meta.seats.filter((seat) => seat.backer === sponsorId).map((seat) => seat.seat) }))
    .filter((table) => table.seats.length > 0);
  return { abandon, resign, open: tables.length - abandon.length - left.length };
}
