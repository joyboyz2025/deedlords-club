// Local sandbox only (`CHAIN.devUrl`): who this browser plays as, and its session key. The stub of
// contracts/sandbox/dev.js stands in for the wallet: it holds the dev accounts' own keys, adds this browser's session
// key to one of them and signs what carries a deposit (creating a match, taking a seat). On a real network none of
// this exists and the page only watches until wallet sign-in is built.

import type { Session } from "@/lib/chain/client";
import { CHAIN } from "@/lib/chain/config";
import { generateKeyPair, parseSecretKey, publicKeyText, secretKeyText, type KeyPair } from "@/lib/chain/keys";
import { chainClient } from "@/lib/chain/shared";
import { readStored, writeStored } from "@/lib/storage";

/** The dev account last played as, so a page opened without `?as=` keeps it. */
export const AS_KEY = "deedlords:as";

export type DevConfig = { networkId: string; contractId: string; house: string; players: string[] };

async function dev<T>(path: string, body?: unknown): Promise<T> {
  if (!CHAIN.devUrl) throw new Error("the dev stub exists on the local sandbox only");
  const response = await fetch(`${CHAIN.devUrl}${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const answer = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(answer.error ?? `dev stub: HTTP ${response.status}`);
  return answer;
}

export const devConfig = () => dev<DevConfig>("/config");

export type NewMatch = { kind: "solo" | "duel"; open?: boolean; player?: string; turnSeconds?: number; rules?: { max_rounds?: number } };
export const devCreateMatch = (match: NewMatch) => dev<{ id: string }>("/match", match);

export const devJoin = (id: string, seat: number, accountId: string) => dev<{ id: string }>("/join", { id, seat, accountId });

const keyStorage = (accountId: string) => `deedlords:session:${CHAIN.network}:${CHAIN.contractId}:${accountId}`;

/**
 * This browser's session for a dev account. The key pair is made here and only its public half is handed to the stub,
 * which adds it to the account as a function-call key for the game contract's move methods.
 */
export async function openDevSession(accountId: string): Promise<Session> {
  const stored = readStored<string>(keyStorage(accountId));
  let pair: KeyPair | null = null;
  try {
    pair = stored ? parseSecretKey(stored) : null;
  } catch {
    pair = null;
  }
  if (!pair) {
    pair = generateKeyPair();
    writeStored(keyStorage(accountId), secretKeyText(pair));
  }
  const session = chainClient.session(accountId, pair);
  // A restarted sandbox is a new chain: the key kept here is not on the account there.
  if (!(await session.ready())) await dev("/session", { accountId, publicKey: publicKeyText(pair.publicKey) });
  return session;
}
