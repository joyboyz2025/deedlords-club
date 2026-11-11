// The transactions of one match: every move is one, and each can be opened in an explorer. Two sources, merged by
// hash: what this browser sent itself (known at once, with its arguments), and what an indexer lists for the contract
// (everybody's, a few seconds later). The indexer only says who called which method, so each listed transaction is read
// from the RPC once to see which match it belongs to and what it did.

import { SQUARES } from "../board.ts";
import type { ContractAction } from "./types.ts";

export type MoveTx = {
  hash: string;
  signer: string;
  method: string;
  /** What the transaction did, in the table's words. */
  what: string;
  /** Block time, or when this browser sent it. */
  atMs: number;
  ok: boolean;
};

/** The contract's methods that belong to a match. */
export const MATCH_METHODS = ["create_match", "join", "play", "turn", "timeout", "leave", "abandon", "set_driver"];

const ACTION_WORDS: Record<string, string> = { Roll: "Roll", Buy: "Buy", Skip: "Pass", End: "End turn", Bail: "Pay the fine", Card: "Use a release card", Pay: "Pay the debt", Bankrupt: "Go bankrupt" };
const SQUARE_WORDS: Record<string, string> = { Build: "Build in", Sell: "Sell a house in", Mortgage: "Mortgage", Redeem: "Redeem" };

function actionWord(action: unknown): string {
  if (typeof action === "string") return ACTION_WORDS[action] ?? action;
  if (typeof action === "object" && action !== null) {
    const [[verb, square] = ["?", null]] = Object.entries(action as Record<string, unknown>);
    const name = typeof square === "number" ? SQUARES[square]?.name : undefined;
    return `${SQUARE_WORDS[verb] ?? verb}${name ? ` ${name}` : ""}`;
  }
  return "?";
}

/** One line for a call to the contract. */
export function describeCall(method: string, args: unknown): string {
  const a = (typeof args === "object" && args !== null ? args : {}) as { seat?: unknown; actions?: unknown; driver?: unknown };
  const seat = typeof a.seat === "number" ? ` ${a.seat + 1}` : "";
  switch (method) {
    case "create_match":
      return "Open the match";
    case "join":
      return `Stake and take seat${seat}`;
    case "play":
      return Array.isArray(a.actions) && a.actions.length > 0 ? (a.actions as ContractAction[]).map(actionWord).join(" · ") : "Move";
    case "turn":
      return "AI turn, by plan";
    case "timeout":
      return "Timeout · the contract moves";
    case "leave":
      return `Leave seat${seat}`;
    case "abandon":
      return "Close the match, stakes back";
    case "set_driver":
      return a.driver ? `Hand seat${seat} to an agent` : `Take seat${seat} back`;
    default:
      return method;
  }
}

/** A row of the indexer's list (NearBlocks API v3, `GET /v3/accounts/<account>/txns`). */
type Listed = {
  transaction_hash: string;
  signer_account_id: string;
  actions?: { action?: string; method?: string | null }[];
  block?: { block_timestamp?: string };
  outcomes?: { status?: boolean | null };
};

type RpcTx = { transaction?: { actions?: unknown[] }; receipts_outcome?: { outcome?: { logs?: string[] } }[] };

type Step = { action: unknown; events?: { kind?: string; dice?: [number, number]; square?: number; amount?: number; by?: string }[] };

/**
 * What a move did, from the contract's own event (`actions`, logged by `play`, `turn` and `timeout`): the dice that
 * came up and the squares bought, which the call's arguments cannot say. `null` when the transaction logged none.
 */
export function describeSteps(tx: RpcTx): string | null {
  const parts: string[] = [];
  for (const receipt of tx.receipts_outcome ?? []) {
    for (const log of receipt.outcome?.logs ?? []) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      let event: { event?: string; data?: { steps?: Step[] } };
      try {
        event = JSON.parse(log.slice("EVENT_JSON:".length));
      } catch {
        continue;
      }
      if (event.event !== "actions") continue;
      for (const step of event.data?.steps ?? []) {
        const events = step.events ?? [];
        const roll = events.find((e) => e.kind === "roll")?.dice;
        const bought = events.find((e) => e.kind === "buy")?.square;
        let word = step.action === "Auto" ? (roll ? "Roll" : "Auto") : actionWord(step.action);
        if (roll) word = `${word} ${roll[0]}+${roll[1]}`;
        if (step.action === "Buy" && typeof bought === "number") word = `Buy ${SQUARES[bought]?.name ?? bought}`;
        const paid = events.find((e) => e.kind === "rent" || e.kind === "tax");
        if (paid?.amount) word += `, ${paid.kind} ${paid.amount}`;
        if (events.some((e) => e.kind === "jailed")) word += ", held at Customs";
        parts.push(word);
      }
    }
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export type LedgerSources = {
  /** Base of the indexer's API, without a trailing slash. */
  indexerUrl: string;
  contractId: string;
  /** The RPC's `tx` method: the transaction `hash` signed by `signer`. */
  readTx: (hash: string, signer: string) => Promise<RpcTx>;
  fetch?: typeof fetch;
  /** What is known of each transaction already, by hash: `null` for one that is not a call of the game. Filled here. */
  known: Map<string, { id: string | null; method: string; what: string } | null>;
  /** How many of the contract's latest transactions are looked at: one page of the indexer per hundred. */
  depth?: number;
};

const PAGE = 100;
const PARALLEL = 6;

/** The calls of a transaction, in order. One that opens a match carries two: `create_match`, then `join`. */
function callsOf(tx: RpcTx): { method: string; args: unknown }[] {
  const calls: { method: string; args: unknown }[] = [];
  for (const action of tx.transaction?.actions ?? []) {
    const call = (action as { FunctionCall?: { method_name?: string; args?: string } } | null)?.FunctionCall;
    if (!call?.method_name) continue;
    let args: unknown = {};
    try {
      args = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(call.args ?? ""), (c) => c.charCodeAt(0))));
    } catch {
      // Not JSON: a call of something else.
    }
    calls.push({ method: call.method_name, args });
  }
  return calls;
}

/**
 * The transactions of match `id` among the contract's latest, newest first. Stops at the one that opened the match.
 * Throws when the indexer cannot be reached; a transaction the RPC will not show is left out and asked for again later.
 */
export async function matchTransactions(id: string, sources: LedgerSources): Promise<MoveTx[]> {
  const get = sources.fetch ?? fetch;
  const rows: MoveTx[] = [];
  let cursor: string | null = null;
  for (let page = 0; page * PAGE < (sources.depth ?? 300); page++) {
    const url = `${sources.indexerUrl}/v3/accounts/${encodeURIComponent(sources.contractId)}/txns?limit=${PAGE}${cursor ? `&next=${encodeURIComponent(cursor)}` : ""}`;
    const response = await get(url, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`the indexer answered ${response.status}`);
    const body = (await response.json()) as { data?: Listed[] | null; meta?: { next_page?: string | null } };
    const listed = (body.data ?? []).filter((row) => row.actions?.some((action) => action.method && MATCH_METHODS.includes(action.method)));
    const unknown = listed.filter((row) => !sources.known.has(row.transaction_hash));
    for (let i = 0; i < unknown.length; i += PARALLEL) {
      await Promise.all(
        unknown.slice(i, i + PARALLEL).map(async (row) => {
          try {
            const tx = await sources.readTx(row.transaction_hash, row.signer_account_id);
            const calls = callsOf(tx);
            const matchId = (calls[0]?.args as { id?: unknown } | null)?.id;
            const did = describeSteps(tx);
            const said = calls.map((call) => describeCall(call.method, call.args)).join(" · ");
            // A turn by plan and a timeout say nothing of what happened in their arguments: the contract's event does.
            const what = did === null ? said : calls[0]?.method === "turn" ? `AI turn: ${did}` : calls[0]?.method === "timeout" ? `Timeout: ${did}` : did;
            sources.known.set(row.transaction_hash, calls.length > 0 ? { id: typeof matchId === "string" ? matchId : null, method: calls[0].method, what } : null);
          } catch {
            // Not remembered: read again the next time the list is asked for.
          }
        }),
      );
    }
    let opened = false;
    for (const row of listed) {
      const known = sources.known.get(row.transaction_hash);
      if (!known || known.id !== id) continue;
      rows.push({
        hash: row.transaction_hash,
        signer: row.signer_account_id,
        method: known.method,
        what: known.what,
        atMs: Math.floor(Number(row.block?.block_timestamp ?? 0) / 1e6),
        ok: row.outcomes?.status !== false,
      });
      if (known.method === "create_match") opened = true;
    }
    cursor = body.meta?.next_page ?? null;
    if (opened || !cursor) break;
  }
  return rows.sort((a, b) => b.atMs - a.atMs);
}

/** Both sources as one list, newest first: the indexer's row wins over this browser's own note of the same transaction. */
export function mergeMoves(listed: MoveTx[], sent: MoveTx[]): MoveTx[] {
  const byHash = new Map<string, MoveTx>();
  for (const row of [...sent, ...listed]) byHash.set(row.hash, row);
  return [...byHash.values()].sort((a, b) => b.atMs - a.atMs);
}
