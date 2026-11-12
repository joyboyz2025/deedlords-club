// The Poker contract for tables of two to nine seats, from the browser. The signer is the game account kept in this
// browser (games/co-ty-phu/chain/keySession.ts). An account's card key at a table is kept in localStorage: without
// it the seat cannot decrypt its cards or give its shares, and runs out of time.

import { ChainClient, type Outcome, type Session } from "@/lib/chain/client";
import { CHAIN } from "@/lib/chain/config";
import { parseSecretKey } from "@/lib/chain/keys";
import { type FunctionCall, jsonArgs } from "@/lib/chain/transaction";
import { readStored, writeStored } from "@/lib/storage";
import { exportGameKey, openKeySession } from "../../co-ty-phu/chain/keySession";
import { type Keys, keyProof, keysFromSecret, newKeys, secretText } from "../crypto";
import { MAX_SEATS, RECORD_FEE, STAKE, TABLE_CHAIN, TABLE_CONTRACT, gasFor } from "./contract";
import { type Call, type SeatStore, type TableResult, type TableView, fromBase64, toBase64 } from "./seat";

export { MAX_SEATS, STAKE, TABLE_CONTRACT };
export const tableClient = new ChainClient(TABLE_CHAIN);

export const TURN_SECONDS = 300;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** This browser's game account as a signer for the table contract, or `null` when there is none. */
export function tableSession(): Session | null {
  const account = openKeySession();
  const key = exportGameKey();
  return account && key ? tableClient.session(account.accountId, parseSecretKey(key)) : null;
}

export const viewResult = (id: string) => tableClient.view<TableResult | null>("get_result", { id });
export const explorerLink = (hash: string): string | null => (CHAIN.explorerUrl ? `${CHAIN.explorerUrl}/txns/${hash}` : null);

/**
 * The table as the newest node sees it: a public RPC answers from several nodes, some a block behind, so a view older
 * than change number `atLeast` is read again. `null`: the table is settled, or (only when `atLeast` is 0) never
 * existed, or the caller no longer wants it (`wanted` answers false).
 */
export async function readTable(id: string, atLeast: number, wanted: () => boolean = () => true): Promise<TableView | null> {
  for (;;) {
    const view = await tableClient.view<TableView | null>("get_match", { id });
    if (view && view.seq >= atLeast) return view;
    if (!view && (atLeast === 0 || (await viewResult(id)))) return null;
    if (!wanted()) return null;
    await sleep(CHAIN.pollMs);
  }
}

const keyName = (id: string, accountId: string) => `deedlords:poker-table:${CHAIN.network}:${id}:${accountId}`;

/** The card key this browser holds for an account at a table, or `null`. */
export function seatKeys(id: string, accountId: string): Keys | null {
  const secret = readStored<string>(keyName(id, accountId));
  return secret ? keysFromSecret(secret) : null;
}

function newSeatKeys(id: string, accountId: string): Keys {
  const keys = newKeys();
  writeStored(keyName(id, accountId), secretText(keys));
  return keys;
}

/** The decks of a table as read from the chain. */
export function seatStore(id: string): SeatStore {
  const decks = new Map<string, Uint8Array>();
  return {
    async deck(hand, step) {
      const at = `${hand}/${step}`;
      for (let tries = 0; ; tries++) {
        const known = decks.get(at);
        if (known) return known;
        const deck = await tableClient.view<string | null>("get_deck", { id, hand, step });
        if (deck) decks.set(at, fromBase64(deck));
        // A deck is deleted when the next seat has shuffled it or the hand is over: stop asking, and let the caller
        // read the table again.
        else if (tries >= 12) throw new Error(`the deck of hand ${hand + 1} is not on chain (any more)`);
        else await sleep(CHAIN.pollMs);
      }
    },
  };
}

const newTableId = (): string => `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const seatCall = (method: string, id: string, accountId: string, stake: bigint, more: Record<string, unknown> = {}): FunctionCall => ({
  method,
  args: jsonArgs({ id, key: toBase64(keyProof(newSeatKeys(id, accountId), accountId)), ...more }),
  gas: gasFor(method),
  deposit: stake + RECORD_FEE,
});

/** Opens a table of `seats` seats (2 to 9) and takes seat 0. It starts when it is full, or when the host starts it. Returns the table id. */
export async function openTable(session: Session, seats: number): Promise<string> {
  const id = newTableId();
  await session.transact([seatCall("create_match", id, session.accountId, STAKE, { stake: STAKE.toString(), seats, turn_seconds: TURN_SECONDS })]);
  return id;
}

/** Takes the first empty seat of a table; `stake` is the table's. At a table under way the seat is dealt in from the next hand. */
export const takeSeat = (session: Session, id: string, stake: bigint): Promise<Outcome> => session.transact([seatCall("join", id, session.accountId, stake)]);
/** The host starts a table that is not full, once two seats are taken. */
export const startTable = (session: Session, id: string): Promise<Outcome> => session.call("start", { id }, gasFor("start"));
/** Gives up the caller's seat: paid at once when it is not in a hand, else when that hand is over. */
export const leaveTable = (session: Session, id: string): Promise<Outcome> => session.call("leave", { id }, gasFor("leave"));
/** After the deadline: lets the contract deal with the seats the table was waiting for. */
export const callTime = (session: Session, id: string): Promise<Outcome> => session.call("timeout", { id }, gasFor("timeout"));
export const send = (session: Session, call: Call): Promise<Outcome> => session.call(call.method, call.args, gasFor(call.method, call.args));
