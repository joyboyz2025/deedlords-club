// The Poker contract from the browser. The signer is the game account kept in this browser
// (games/co-ty-phu/chain/keySession.ts), as for the Arena. A seat's card key and the openings of its shuffles are kept
// in localStorage: without them the seat cannot decrypt, and cannot pass the audit at the end of a hand.

import { sha256 } from "@noble/hashes/sha2.js";
import { ChainClient, type Outcome, type Session } from "@/lib/chain/client";
import { CHAIN } from "@/lib/chain/config";
import { parseSecretKey } from "@/lib/chain/keys";
import { type FunctionCall, jsonArgs } from "@/lib/chain/transaction";
import { readStored, writeStored } from "@/lib/storage";
import { exportGameKey, openKeySession } from "../co-ty-phu/chain/keySession";
import { type Keys, keyProof, keysFromSecret, newKeys, secretText } from "./crypto";
import { type Call, type MatchView, type SeatStore, fromBase64, toBase64 } from "./seat";

export const POKER_CONTRACT = process.env.NEXT_PUBLIC_POKER_CONTRACT ?? (CHAIN.network === "sandbox" ? "poker.sandbox" : "poker.deedlords.testnet");
export const pokerClient = new ChainClient({ ...CHAIN, contractId: POKER_CONTRACT });

export type Result = { id: string; stake: string; players: string[]; chips: [number, number]; payouts: string[]; hands: number; reason: string };

const TGAS = 1_000_000_000_000n;
/** A seat's stake: 0.01 NEAR for 100 chips. */
export const STAKE = 10n ** 22n;
export const TURN_SECONDS = 300;
/**
 * An account must hold about 0.001 NEAR per Tgas it attaches, so calls attach what they need: the audit recomputes a
 * whole shuffle (about 117 Tgas burnt), everything else stays under 20.
 */
const gasFor = (method: string): bigint => (method === "audit" ? 180n : 40n) * TGAS;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** This browser's game account as a signer for the Poker contract, or `null` when there is none. */
export function pokerSession(): Session | null {
  const account = openKeySession();
  const key = exportGameKey();
  return account && key ? pokerClient.session(account.accountId, parseSecretKey(key)) : null;
}

export const viewResult = (id: string) => pokerClient.view<Result | null>("get_result", { id });
export const explorerLink = (hash: string): string | null => (CHAIN.explorerUrl ? `${CHAIN.explorerUrl}/txns/${hash}` : null);

/**
 * The match as the newest node sees it: a public RPC answers from several nodes, some a block behind, so a view older
 * than change number `atLeast` is read again. `null`: the match is settled, or (only when `atLeast` is 0) never
 * existed, or the caller no longer wants it (`wanted` answers false).
 */
export async function readMatch(id: string, atLeast: number, wanted: () => boolean = () => true): Promise<MatchView | null> {
  for (;;) {
    const view = await pokerClient.view<MatchView | null>("get_match", { id });
    if (view && view.seq >= atLeast) return view;
    if (!view && (atLeast === 0 || (await viewResult(id)))) return null;
    if (!wanted()) return null;
    await sleep(CHAIN.pollMs);
  }
}

const keyName = (id: string, seat: number) => `deedlords:poker:${CHAIN.network}:${id}:${seat}`;

/** The card key this browser holds for a seat of a match, or `null`. */
export function seatKeys(id: string, seat: number): Keys | null {
  const secret = readStored<string>(keyName(id, seat));
  return secret ? keysFromSecret(secret) : null;
}

function newSeatKeys(id: string, seat: number): Keys {
  const keys = newKeys();
  writeStored(keyName(id, seat), secretText(keys));
  return keys;
}

/** The decks of a match as read from the chain, and this browser's openings of the shuffles it made. */
export function seatStore(id: string): SeatStore {
  const decks = new Map<string, Uint8Array>();
  const openings = new Map<string, Uint8Array>();
  const name = (deck: Uint8Array) => `deedlords:poker:${CHAIN.network}:opening:${hex(sha256(deck)).slice(0, 32)}`;
  return {
    async deck(hand, step) {
      const at = `${hand}/${step}`;
      for (let tries = 0; ; tries++) {
        const known = decks.get(at);
        if (known) return known;
        const deck = await pokerClient.view<string | null>("get_deck", { id, hand, step });
        if (deck) decks.set(at, fromBase64(deck));
        // A deck is deleted when its hand ends: stop asking, and let the caller read the match again.
        else if (tries >= 12) throw new Error(`the deck of hand ${hand + 1} is not on chain (any more)`);
        else await sleep(CHAIN.pollMs);
      }
    },
    saveOpening(deck, opening) {
      openings.set(name(deck), opening);
      writeStored(name(deck), toBase64(opening));
    },
    loadOpening(deck) {
      const stored = readStored<string>(name(deck));
      return openings.get(name(deck)) ?? (stored ? fromBase64(stored) : null);
    },
  };
}

const newTableId = (): string => `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const seatCall = (method: string, id: string, seat: number, accountId: string, stake: bigint, more: Record<string, unknown> = {}): FunctionCall => ({
  method,
  args: jsonArgs({ id, key: toBase64(keyProof(newSeatKeys(id, seat), accountId)), ...more }),
  gas: gasFor(method),
  deposit: stake,
});

/** Opens a match and takes seat 0; with `bothSeats` the same account takes seat 1 too, in the same transaction. Returns the match id. */
export async function openTable(session: Session, bothSeats: boolean): Promise<string> {
  const id = newTableId();
  const calls = [seatCall("create_match", id, 0, session.accountId, STAKE, { stake: STAKE.toString(), turn_seconds: TURN_SECONDS })];
  if (bothSeats) calls.push(seatCall("join", id, 1, session.accountId, STAKE));
  await session.transact(calls);
  return id;
}

export const takeSeat = (session: Session, id: string, stake: bigint): Promise<Outcome> => session.transact([seatCall("join", id, 1, session.accountId, stake)]);
export const send = (session: Session, call: Call): Promise<Outcome> => session.call(call.method, call.args, gasFor(call.method));
