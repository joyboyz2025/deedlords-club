// GET ?id=<match>: the transactions of the match, newest first, for the table's "Transactions" list. Read from an
// indexer (who called what, when) and the RPC (which match, which actions); see games/co-ty-phu/chain/ledger.ts.
// Kept here, behind the page's own server, so that every viewer shares one cache and the indexer is asked at most
// once every few seconds per match.

import { matchTransactions, type LedgerSources, type MoveTx } from "@/games/co-ty-phu/chain/ledger";
import { CHAIN } from "@/lib/chain/config";
import { rpc } from "@/lib/chain/rpc";

export const dynamic = "force-dynamic";

const MATCH_ID = /^[A-Za-z0-9_-]{1,32}$/;
const FRESH_MS = 4_000;
const MAX_KNOWN = 5_000;

const shelf = globalThis as { deedlordsLedger?: { known: LedgerSources["known"]; lists: Map<string, { at: number; rows: Promise<MoveTx[]> }> } };
const cache = (shelf.deedlordsLedger ??= { known: new Map(), lists: new Map() });

const answer = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

export async function GET(request: Request): Promise<Response> {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!MATCH_ID.test(id)) return answer({ error: "ask with ?id=<match>" }, 400);
  if (!CHAIN.indexerUrl) return answer({ rows: [], explorer: CHAIN.explorerUrl, indexed: false });

  const now = Date.now();
  let list = cache.lists.get(id);
  if (!list || now - list.at > FRESH_MS) {
    if (cache.known.size > MAX_KNOWN) cache.known.clear();
    list = {
      at: now,
      rows: matchTransactions(id, {
        indexerUrl: CHAIN.indexerUrl,
        contractId: CHAIN.contractId,
        known: cache.known,
        readTx: (hash, signer) => rpc(CHAIN.rpcUrl, "tx", { tx_hash: hash, sender_account_id: signer, wait_until: "NONE" }, { timeoutMs: 10_000 }),
      }),
    };
    cache.lists.set(id, list);
    if (cache.lists.size > 200) cache.lists.delete(cache.lists.keys().next().value as string);
  }
  try {
    return answer({ rows: await list.rows, explorer: CHAIN.explorerUrl, indexed: true });
  } catch (error) {
    cache.lists.delete(id);
    return answer({ error: error instanceof Error ? error.message : String(error), rows: [], explorer: CHAIN.explorerUrl, indexed: true }, 502);
  }
}
