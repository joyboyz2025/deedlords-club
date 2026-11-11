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
