// The account that pays for free play, on the server only. It opens the free tables (its storage deposit, which comes
// back to it), sends the players' signed moves as meta-transactions (its gas), and plays the house agent's seat.
//
// Its key is a secret of the deployment: `DEEDLORDS_SPONSOR_KEY`, or on a developer's machine the file NEAR's own
// tools keep (`~/.near-credentials/<network>/<account>.json`). It is never logged and never sent anywhere. Give this
// account little: what it holds is what a leaked key, or a hole in the relayer's rules, can cost.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session } from "./client.ts";
import { CHAIN } from "./config.ts";
import { parseSecretKey } from "./keys.ts";
import { chainClient } from "./shared.ts";

export type Sponsor = { accountId: string; session: Session };

const ACCOUNT_ID = /^(?=.{2,64}$)[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;
// One session for the process: it owns the key's nonce. Kept across the reloads of a dev server.
// The name carries a version: a dev server that reloads this file must not keep a session made by older code.
const shelf = globalThis as { deedlordsSponsorV2?: { at: string; sponsor: Sponsor | null } };

function secretKey(accountId: string): string | null {
  const fromEnv = process.env.DEEDLORDS_SPONSOR_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const file = JSON.parse(readFileSync(join(homedir(), ".near-credentials", CHAIN.network, `${accountId}.json`), "utf8")) as { private_key?: string; secret_key?: string };
    return file.private_key ?? file.secret_key ?? null;
  } catch {
    return null;
  }
}

/** `null`: this deployment sponsors nothing (no account named, or no key for it). */
export function sponsor(): Sponsor | null {
  const accountId = process.env.DEEDLORDS_SPONSOR_ACCOUNT?.trim() ?? "";
  const at = `${CHAIN.network}:${accountId}`;
  if (shelf.deedlordsSponsorV2?.at === at) return shelf.deedlordsSponsorV2.sponsor;
  let made: Sponsor | null = null;
  if (ACCOUNT_ID.test(accountId)) {
    const key = secretKey(accountId);
    try {
      if (key) made = { accountId, session: chainClient.session(accountId, parseSecretKey(key), { pipelined: true }) };
    } catch {
      made = null; // not a key: sponsor nothing rather than fail every request
    }
  }
  shelf.deedlordsSponsorV2 = { at, sponsor: made };
  return made;
}
