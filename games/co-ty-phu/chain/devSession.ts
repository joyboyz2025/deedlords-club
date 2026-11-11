// With a local helper only (`CHAIN.devUrl`): who this browser plays as, and its session key. The helper stands in for
// the wallet: it holds the test accounts' own keys, adds this browser's session key to one of them and signs what
// carries a deposit (creating a match, taking a seat). On the sandbox that is the stub of contracts/sandbox/dev.js, on
// testnet contracts/sandbox/play-testnet.js. Without a helper the page only watches until wallet sign-in is built.

import { useEffect, useState } from "react";
import type { Session } from "@/lib/chain/client";
import { CHAIN } from "@/lib/chain/config";
import { generateKeyPair, parseSecretKey, publicKeyText, secretKeyText, type KeyPair } from "@/lib/chain/keys";
import { chainClient } from "@/lib/chain/shared";
import { readStored, writeStored } from "@/lib/storage";

/** The test account last played as on this network, so a page opened without `?as=` keeps it. */
export const AS_KEY = `deedlords:as:${CHAIN.network}`;

export type DevConfig = {
  networkId: string;
  contractId: string;
  house: string;
  /** The accounts the helper signs for. */
  players: string[];
  /** What a seat costs in the matches the helper opens, in yoctoNEAR. */
  stake: string;
  /** Whether it can open a match against the house (it needs a house runner for that). */
  solo: boolean;
  /** What it sends a new game account that asks (`devFund`), in yoctoNEAR; `null` when it hands out nothing. */
  faucet: string | null;
  /** Whether it can sit one of its test accounts in a lobby and play it as an agent (`devSeatAgent`). */
  agent?: boolean;
};

async function dev<T>(path: string, body?: unknown): Promise<T> {
  if (!CHAIN.devUrl) throw new Error("no local helper is set up for this network");
  const response = await fetch(`${CHAIN.devUrl}${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const answer = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(answer.error ?? `local helper: HTTP ${response.status}`);
  return answer;
}

let config: Promise<DevConfig> | null = null;
/** Asked once per page: the helper does not change while it runs. A failed read is asked again. */
export function devConfig(): Promise<DevConfig> {
  config ??= dev<DevConfig>("/config").catch((error) => {
    config = null;
    throw error;
  });
  return config;
}

/** `null` until the helper has answered, and for as long as it cannot be reached: it is asked again every few seconds. */
export function useDevConfig(): DevConfig | null {
  const [known, setKnown] = useState<DevConfig | null>(null);
  useEffect(() => {
    if (!CHAIN.devUrl) return;
    let stale = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = () =>
      devConfig().then(
        (answer) => !stale && setKnown(answer),
        () => {
          // The helper may still be starting (on testnet it first clears old session keys).
          if (!stale) timer = setTimeout(ask, 3_000);
        },
      );
    void ask();
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, []);
  return known;
}

export type NewMatch = { kind: "solo" | "duel"; open?: boolean; player?: string; turnSeconds?: number; rules?: { max_rounds?: number } };
export const devCreateMatch = (match: NewMatch) => dev<{ id: string }>("/match", match);

export const devJoin = (id: string, seat: number, accountId: string) => dev<{ id: string }>("/join", { id, seat, accountId });

/** Asks the helper for test NEAR for a game account. It sends nothing to an account that already has some. */
export const devFund = (accountId: string) => dev<{ funded: boolean; balance: string }>("/fund", { accountId });

const keyStorage = (accountId: string) => `deedlords:session:${CHAIN.network}:${CHAIN.contractId}:${accountId}`;

/**
 * This browser's session for a test account. The key pair is made here and only its public half is handed to the
 * helper, which adds it to the account as a function-call key for the game contract's move methods.
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
  // The key kept here may be gone from the account: a restarted sandbox is a new chain, and the testnet helper removes
  // its session keys when it stops.
  if (!(await session.ready())) {
    await dev("/session", { accountId, publicKey: publicKeyText(pair.publicKey) });
    // The node asked next may still be a block behind the one that added the key.
    for (let i = 0; i < 20 && !(await session.ready()); i++) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return session;
}

/** The helper seats one of its test accounts in the open seat of the lobby and plays it as an agent until the match ends. */
export function devSeatAgent(id: string): Promise<{ id: string; seat: number; accountId: string }> {
  return dev("/agent", { id });
}
