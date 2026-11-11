// A game account: a NEAR implicit account whose key lives in this browser. The key comes from an EVM wallet's
// signature (lib/chain/evmKey.ts: the same wallet gives the same account anywhere) or is made here for a guest. It is
// the account's own full-access key, so the page signs everything itself, stakes included, with no wallet prompt.
// That is also the risk: whoever has this browser's storage has the account. It should hold a stake and some gas.

import type { Session } from "@/lib/chain/client";
import { CHAIN } from "@/lib/chain/config";
import { gameKeyMessage, hexOfText, implicitAccountId, keyFromSignature } from "@/lib/chain/evmKey";
import { generateKeyPair, parseSecretKey, secretKeyText } from "@/lib/chain/keys";
import { chainClient } from "@/lib/chain/shared";
import { readStored, removeStored, writeStored } from "@/lib/storage";

const STORE = `deedlords:key:${CHAIN.network}`;

type Stored = { accountId: string; secretKey: string; source: "evm" | "guest"; evmAddress?: string };

export type KeyAccount = { accountId: string; session: Session; source: "evm" | "guest"; /** The wallet address the key was derived from. */ evmAddress: string | null };

/** The provider an EVM wallet puts in the page (EIP-1193). */
type EvmProvider = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };

const evmProvider = (): EvmProvider | null => (typeof window === "undefined" ? null : ((window as { ethereum?: EvmProvider }).ethereum ?? null));

export const hasEvmWallet = (): boolean => evmProvider() !== null;

/**
 * Asks the EVM wallet for its address and for one signature, and keeps the game account derived from it.
 * Throws with a readable message when there is no wallet or its owner says no.
 */
export async function signInWithEvm(): Promise<void> {
  const provider = evmProvider();
  if (!provider) throw new Error("No EVM wallet in this browser. Install MetaMask, Rabby or Coinbase Wallet, or open this page in your wallet's browser.");
  let address: string;
  let signature: string;
  try {
    const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
    address = accounts[0];
    if (!address) throw new Error("the wallet shared no account");
    signature = (await provider.request({ method: "personal_sign", params: [hexOfText(gameKeyMessage(CHAIN.network)), address] })) as string;
  } catch (error) {
    const refused = (error as { code?: number }).code === 4001;
    throw new Error(refused ? "The wallet did not sign, so there is no game account." : `The EVM wallet answered: ${error instanceof Error ? error.message : String(error)}`);
  }
  const pair = keyFromSignature(signature);
  writeStored(STORE, { accountId: implicitAccountId(pair.publicKey), secretKey: secretKeyText(pair), source: "evm", evmAddress: address } satisfies Stored);
}

/** A game account whose key exists in this browser only: signing out, or clearing the browser, loses it. */
export function signInAsGuest(): void {
  const pair = generateKeyPair();
  writeStored(STORE, { accountId: implicitAccountId(pair.publicKey), secretKey: secretKeyText(pair), source: "guest" } satisfies Stored);
}

export function hasKeyAccount(): boolean {
  return readStored<Stored>(STORE) !== null;
}

export function openKeySession(): KeyAccount | null {
  const stored = readStored<Stored>(STORE);
  if (!stored) return null;
  try {
    return { accountId: stored.accountId, session: chainClient.session(stored.accountId, parseSecretKey(stored.secretKey)), source: stored.source, evmAddress: stored.evmAddress ?? null };
  } catch {
    removeStored(STORE);
    return null;
  }
}

/** The key as NEAR tools take it (`ed25519:…`), for its owner to keep somewhere safe. */
export function exportGameKey(): string | null {
  return readStored<Stored>(STORE)?.secretKey ?? null;
}

export function signOutOfKey(): void {
  removeStored(STORE);
}
