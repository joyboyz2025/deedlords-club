// Free play, from the browser. A free table is a match the server's sponsor opened with nothing staked; a game account
// plays it without holding any NEAR: it signs each call as a delegate action and the sponsor sends it (/api/relay).
// The contract cannot tell the difference: the player is still the caller.

import { type Deliver, type Outcome, type Relayed, type Session } from "../../../lib/chain/client.ts";
import { toBase64 } from "../../../lib/chain/base58.ts";
import { MOVE_GAS } from "../../../lib/chain/config.ts";
import { implicitAccountId } from "../../../lib/chain/evmKey.ts";
import { publicKeyText } from "../../../lib/chain/keys.ts";
import { RpcError } from "../../../lib/chain/rpc.ts";
import { type FunctionCall, jsonArgs } from "../../../lib/chain/transaction.ts";
import { chainClient } from "../../../lib/chain/shared.ts";
import { knowHouseAgent } from "./adapt.ts";
import type { ChainMatch } from "./types.ts";
import { FREE_GUEST_SEAT, joinCalls } from "./calls.ts";
import type { Caller, Table } from "./room.ts";

export type FreeOpponent = "agent" | "friend";

const JSON_POST = { method: "POST", headers: { "content-type": "application/json" } };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let asked: Promise<string | null> | null = null;

/** The account that sponsors free play on this server, `null` when none does. Asked once per page. */
export function freeSponsor(): Promise<string | null> {
  asked ??= fetch("/api/relay")
    .then((response) => (response.ok ? (response.json() as Promise<{ sponsor: string | null }>) : null))
    .then((answer) => answer?.sponsor ?? null)
    .catch(() => null)
    .then((sponsor) => {
      knowHouseAgent(sponsor); // so its seat is named for what it is, wherever seats are named
      return sponsor;
    });
  return asked;
}

/**
 * A server route, waited for at most `timeoutMs`: a phone that loses the network, or goes to sleep, mid-request may
 * otherwise never hear back, and whatever waits for the answer (a roll, a seat) would wait for ever.
 */
export async function post<T>(path: string, body: unknown, timeoutMs = 30_000): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { ...JSON_POST, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"))
      throw new Error("The server did not answer in time. The move may still land: the page reads the table again.");
    throw error;
  }
  const answer = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok || !answer) throw new Error(answer?.error ?? `the server answered ${response.status}`);
  return answer;
}

const deliver: Deliver = (signed) => post<Relayed>("/api/relay", { delegate: toBase64(signed) });

/** Only a game account is relayed, signing with its own key or one it granted: the sponsor checks the same thing. */
export const canRelay = (session: Session): boolean => /^[0-9a-f]{64}$/.test(session.accountId);

/** A match with nothing staked, opened by `sponsor`: the sponsor pays for its moves. */
export const isFreeTable = (table: Table | null | undefined, sponsor: string | null | undefined): boolean =>
  !!table && !!sponsor && table.stake === "0" && table.creator === sponsor;

/**
 * A game account nobody has sent anything to does not exist on chain yet, and its key has no nonce to sign with: the
 * sponsor is asked to bring it into existence, once.
 */
async function ensureOpen(session: Session): Promise<void> {
  // Only an account named after this very key can be opened with it; a granted key is on an account that exists.
  if (session.accountId !== implicitAccountId(session.publicKey) || (await session.ready())) return;
  await post("/api/relay", { open: publicKeyText(session.publicKey) });
  // The node that answers may be a block behind the one that took the transfer.
  for (let i = 0; i < 20 && !(await session.ready()); i++) await sleep(300);
}

/** Sends calls through the sponsor, opening the account first if it has to. */
export async function relay(session: Session, calls: FunctionCall[]): Promise<Outcome> {
  try {
    return await session.delegate(calls, deliver);
  } catch (error) {
    if (!(error instanceof RpcError && error.code === "UNKNOWN_ACCESS_KEY")) throw error;
  }
  await ensureOpen(session);
  return session.delegate(calls, deliver);
}

/**
 * Asks the sponsor for a new free table. Resolves to the match's id; nobody sits at it yet but the house's agents, if
 * asked for: one per model in `agents` (models the server offers, or "rules"), each in a seat of its own.
 */
export async function requestFreeTable(rounds: number, opponent: FreeOpponent, room: { host: string; seats: number } | null = null, agents?: string[]): Promise<string> {
  const ask = () =>
    post<{ id: string }>("/api/free", { rounds, opponent, ...(opponent === "friend" && room ? room : {}), ...(agents?.length ? { agents } : {}) }, 65_000);
  try {
    return (await ask()).id;
  } catch (error) {
    // A gateway that gave up on a server just waking (HTTP 502, 503, 504 with no answer of the route's own) says
    // nothing about a table: ask once more. A table the first request did open after all is one nobody sits at, and
    // the sponsor abandons those.
    if (!(error instanceof Error && /^the server answered 50[234]$/.test(error.message))) throw error;
    return (await ask()).id;
  }
}

/** The sponsor opens a free table and this game account takes its first seat. Resolves to the match's id. */
export async function openFreeTable(session: Session, rounds: number, opponent: FreeOpponent, seats = 2, agents?: string[]): Promise<string> {
  // A new guest's account is opened while the table is: two transactions of the sponsor's, side by side.
  const [id] = await Promise.all([requestFreeTable(rounds, opponent, { host: session.accountId, seats }, agents), ensureOpen(session)]);
  try {
    await takeFreeSeat(session, id, FREE_GUEST_SEAT);
  } catch (error) {
    // A public node may give up waiting (HTTP 408) on a seat that was taken: the table says.
    if (!(await seatTaken(id, FREE_GUEST_SEAT, session.accountId))) throw error;
  }
  return id;
}

/** Whether `accountId` backs `seat` of match `id`, read a few times while the chain catches up. */
async function seatTaken(id: string, seat: number, accountId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(2_000);
    const match = await chainClient.view<ChainMatch | null>("get_match", { id }).catch(() => null);
    if (match?.meta.seats[seat]?.backer === accountId) return true;
  }
  return false;
}

export async function takeFreeSeat(session: Session, id: string, seat: number): Promise<void> {
  await relay(session, joinCalls(id, seat, 0n));
}

/** Asks the server to play the house agent's turn if it is due. Every watcher may ask; a turn is played once. */
export async function nudgeHouseAgent(id: string): Promise<void> {
  await post("/api/free/move", { id });
}

/**
 * What a room calls the contract with: the session itself, except at a free table, where a game account's calls go
 * through the sponsor. Decided per call, from the table the call is for.
 */
export function seatCaller(session: Session): Caller {
  return {
    accountId: session.accountId,
    async call(method, args, table) {
      if (table?.stake === "0" && canRelay(session) && isFreeTable(table, await freeSponsor())) {
        return relay(session, [{ method, args: jsonArgs(args), gas: MOVE_GAS, deposit: 0n }]);
      }
      return session.call(method, args);
    },
  };
}
