// The Poker contract for tables of two to nine seats, from the browser. The signer is the game account kept in this
// browser (games/co-ty-phu/chain/keySession.ts). An account's card key at a table is kept in localStorage: without
// it the seat cannot decrypt its cards or give its shares, and runs out of time.
//
// A free table (a stake of nothing, opened by the server's sponsor) is played without any NEAR: the account signs
// each call as a delegate action and the sponsor sends it (app/api/relay), as at the board game's free tables.

import { ChainClient, type Outcome, type Session } from "@/lib/chain/client";
import { CHAIN } from "@/lib/chain/config";
import { parseSecretKey } from "@/lib/chain/keys";
import { type FunctionCall, jsonArgs } from "@/lib/chain/transaction";
import { readStored, writeStored } from "@/lib/storage";
import { canRelay, post, relay } from "../../co-ty-phu/chain/free";
import { pokerAccount } from "../pokerAccount";
import { type Keys, keyProof, keysFromSecret, newKeys, secretText } from "../crypto";
import { MAX_SEATS, RECORD_FEE, STAKE, TABLE_CHAIN, TABLE_CONTRACT, gasFor } from "./contract";
import { type Call, type SeatStore, type TableResult, type TableView, fromBase64, toBase64 } from "./seat";

export { MAX_SEATS, STAKE, TABLE_CONTRACT };
export const tableClient = new ChainClient(TABLE_CHAIN);

export const TURN_SECONDS = 300;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The account this browser plays poker as (pokerAccount.ts), as a signer for the table contract, or `null` when there is none. */
export function tableSession(): Session | null {
  const account = pokerAccount();
  return account ? tableClient.session(account.accountId, parseSecretKey(account.secretKey)) : null;
}

/** The free tables this page has seen: their calls go through the sponsor. A table's stake never changes. */
const freeTables = new Set<string>();
export const isFreeStake = (table: Pick<TableView, "stake">): boolean => BigInt(table.stake) === 0n;
/** Remembers a table read from the chain as free, when it is. */
export function noteTable(table: Pick<TableView, "id" | "stake">): void {
  if (isFreeStake(table)) freeTables.add(table.id);
}

/** One transaction of a seat at table `id`: through the sponsor at a free table, else signed and paid by the account. */
function dispatch(session: Session, id: string, calls: FunctionCall[]): Promise<Outcome> {
  return freeTables.has(id) && canRelay(session) ? relay(session, calls) : session.transact(calls);
}
const callOf = (method: string, args: Record<string, unknown>): FunctionCall => ({ method, args: jsonArgs(args), gas: gasFor(method, args), deposit: 0n });

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
    if (view) noteTable(view);
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

/** Opening a table or taking a seat: the account's new card key at the table, and what the seat costs (nothing when `stake` is 0). */
const seatCall = (method: string, id: string, accountId: string, stake: bigint, more: Record<string, unknown> = {}): FunctionCall => ({
  method,
  args: jsonArgs({ id, key: toBase64(keyProof(newSeatKeys(id, accountId), accountId)), ...more }),
  gas: gasFor(method),
  deposit: stake === 0n ? 0n : stake + RECORD_FEE,
});

/**
 * Opens a table of `seats` seats (2 to 9) and takes seat 0, every seat bought with `stake` (at least 0.1 NEAR) for 100
 * chips. It starts when it is full, or when the host starts it. Returns the table id.
 */
export async function openTable(session: Session, seats: number, stake: bigint = STAKE): Promise<string> {
  const id = newTableId();
  await session.transact([seatCall("create_match", id, session.accountId, stake, { stake: stake.toString(), seats, turn_seconds: TURN_SECONDS })]);
  return id;
}

/**
 * Asks the server for a free table of `seats` seats, whose host (the sponsor's account) holds seat 0 and bets by
 * `model`, and takes a seat at it. Returns the table id. The account needs no NEAR, only to be a game account.
 */
export async function openFreeTable(session: Session, seats: number, model?: string): Promise<string> {
  const { id } = await post<{ id: string }>("/api/poker/table/free", { seats, ...(model ? { model } : {}) }, 65_000);
  freeTables.add(id);
  // The node that answers may not have seen the table yet: the seat is asked for again for a few seconds.
  for (let tries = 0; ; tries++) {
    try {
      await takeSeat(session, id, 0n);
      return id;
    } catch (error) {
      if (tries >= 4 || !/no such table|not an open free table/.test(error instanceof Error ? error.message : String(error))) throw error;
      await sleep(1_500);
    }
  }
}

/** Asks the host of a free table (the server) to start it with the seats taken: only a table's host can start it. */
export const startFreeTable = (id: string): Promise<{ hash?: string }> =>
  post<{ played: boolean; hash?: string; why?: string }>("/api/poker/table/free", { id, start: true }).then((answer) => {
    if (!answer.played) throw new Error(`The table was not started: ${answer.why ?? "the host did not say why"}`);
    return answer;
  });

/** Takes the first empty seat of a table; `stake` is the table's. At a table under way the seat is dealt in from the next hand. */
export function takeSeat(session: Session, id: string, stake: bigint): Promise<Outcome> {
  if (stake === 0n) freeTables.add(id);
  return dispatch(session, id, [seatCall("join", id, session.accountId, stake)]);
}
/** The host starts a table that is not full, once two seats are taken. */
export const startTable = (session: Session, id: string): Promise<Outcome> => dispatch(session, id, [callOf("start", { id })]);
/** Gives up the caller's seat: paid at once when it is not in a hand, else when that hand is over. */
export const leaveTable = (session: Session, id: string): Promise<Outcome> => dispatch(session, id, [callOf("leave", { id })]);
/** After the deadline: lets the contract deal with the seats the table was waiting for. */
export const callTime = (session: Session, id: string): Promise<Outcome> => dispatch(session, id, [callOf("timeout", { id })]);
export const send = (session: Session, call: Call): Promise<Outcome> =>
  dispatch(session, String((call.args as { id?: unknown }).id ?? ""), [callOf(call.method, call.args as Record<string, unknown>)]);
