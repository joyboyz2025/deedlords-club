// The Poker contract from the browser. The signer is the game account kept in this browser
// (games/co-ty-phu/chain/keySession.ts), as for the Arena. A seat's card key is kept in localStorage: without it the
// seat cannot decrypt its cards or give its shares, and runs out of time.

import { ChainClient, type Outcome, type Session } from "@/lib/chain/client";
import { CHAIN } from "@/lib/chain/config";
import { parseSecretKey } from "@/lib/chain/keys";
import { type FunctionCall, jsonArgs } from "@/lib/chain/transaction";
import { readStored, writeStored } from "@/lib/storage";
import { exportGameKey, openKeySession } from "../co-ty-phu/chain/keySession";
import { POKER_CHAIN, POKER_CONTRACT, RECORD_FEE, STAKE, gasFor } from "./contract";
import { type Keys, keyProof, keysFromSecret, newKeys, secretText } from "./crypto";
import { type Call, type MatchView, type SeatStore, fromBase64, toBase64 } from "./seat";

export { POKER_CONTRACT, STAKE };
export const pokerClient = new ChainClient(POKER_CHAIN);

export type Result = { id: string; stake: string; players: string[]; chips: [number, number]; payouts: string[]; hands: number; reason: string };

export const TURN_SECONDS = 300;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** The decks of a match as read from the chain. */
export function seatStore(id: string): SeatStore {
  const decks = new Map<string, Uint8Array>();
  return {
    async deck(hand, step) {
      const at = `${hand}/${step}`;
      for (let tries = 0; ; tries++) {
        const known = decks.get(at);
        if (known) return known;
        const deck = await pokerClient.view<string | null>("get_deck", { id, hand, step });
        if (deck) decks.set(at, fromBase64(deck));
        // A deck is deleted when it is no longer needed: stop asking, and let the caller read the match again.
        else if (tries >= 12) throw new Error(`the deck of hand ${hand + 1} is not on chain (any more)`);
        else await sleep(CHAIN.pollMs);
      }
    },
  };
}

const newTableId = (): string => `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const seatCall = (method: string, id: string, seat: number, accountId: string, stake: bigint, more: Record<string, unknown> = {}): FunctionCall => ({
  method,
  args: jsonArgs({ id, key: toBase64(keyProof(newSeatKeys(id, seat), accountId)), ...more }),
  gas: gasFor(method),
  deposit: stake + RECORD_FEE,
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
