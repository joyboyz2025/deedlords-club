// One JSON-RPC request to a NEAR node, with patience for what is transient: a rate limit (HTTP 429), a gateway error,
// a dropped connection. Errors the node reports about the request itself are thrown at once.
//
// The address may name several nodes, separated by commas. Requests go to one of them; when it turns a request away
// for a transient reason the next one takes over, for this request and those after it. A free public node limits how
// much one address may ask, and a page that polls a match, with a second tab open, gets there.

export class RpcError extends Error {
  /** The node's error name (`TIMEOUT_ERROR`, `INVALID_TRANSACTION`, `UNKNOWN_ACCESS_KEY`…), or `HTTP`, `NETWORK`, `TIMEOUT`. */
  readonly code: string;
  readonly http: number | null;
  readonly retryAfterMs: number | null;
  readonly detail: string;

  constructor(message: string, code: string, extra: { http?: number; retryAfterMs?: number | null; detail?: string } = {}) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.http = extra.http ?? null;
    this.retryAfterMs = extra.retryAfterMs ?? null;
    this.detail = extra.detail ?? "";
  }

  get transient(): boolean {
    return this.code === "NETWORK" || this.code === "TIMEOUT" || (this.code === "HTTP" && (this.http === 429 || (this.http ?? 0) >= 500));
  }
}

export type RpcOptions = { timeoutMs?: number; tries?: number; retryTimeout?: boolean };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let serial = 0;

async function once<T>(url: string, method: string, params: unknown, timeoutMs: number): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++serial, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new RpcError(`RPC ${method}: ${timedOut ? "no answer in time" : "network error"}`, timedOut ? "TIMEOUT" : "NETWORK");
  }
  if (!response.ok) {
    const after = Number(response.headers.get("retry-after"));
    await response.text().catch(() => "");
    throw new RpcError(`RPC ${method}: HTTP ${response.status}`, "HTTP", { http: response.status, retryAfterMs: after > 0 ? after * 1000 : null });
  }
  const body = (await response.json()) as { result?: T; error?: { name?: string; message?: string; data?: unknown; cause?: { name?: string; info?: unknown } } };
  if (body.error) {
    const code = body.error.cause?.name ?? body.error.name ?? "RPC_ERROR";
    const detail = JSON.stringify(body.error.data ?? body.error.cause?.info ?? body.error.message ?? "");
    throw new RpcError(`RPC ${method}: ${code}: ${detail.slice(0, 300)}`, code, { detail });
  }
  return body.result as T;
}

/** Which node of a list is in use, by the list as written. */
const inUse = new Map<string, number>();

export async function rpc<T>(url: string, method: string, params: unknown, options: RpcOptions = {}): Promise<T> {
  const { timeoutMs = 15_000, tries = 5, retryTimeout = true } = options;
  const nodes = url.includes(",")
    ? url
        .split(",")
        .map((node) => node.trim())
        .filter(Boolean)
    : [url];
  for (let i = 0; ; i++) {
    const at = (inUse.get(url) ?? 0) % nodes.length;
    try {
      return await once<T>(nodes[at], method, params, timeoutMs);
    } catch (error) {
      const retry = error instanceof RpcError && error.transient && (retryTimeout || error.code !== "TIMEOUT");
      if (!retry || i + 1 >= tries) throw error;
      // Another node to ask: move on to it at once, and wait only after each has had its turn.
      const moved = nodes.length > 1 && error.code !== "TIMEOUT";
      if (moved) inUse.set(url, at + 1);
      if (moved && (i + 1) % nodes.length !== 0) continue;
      await sleep(Math.min(60_000, error.retryAfterMs ?? Math.min(30_000, 500 * 2 ** i)) + Math.random() * 250);
    }
  }
}

/**
 * A transaction read back by its hash, as the node's `tx` method gives it. An ordinary node forgets a transaction
 * within a day or so (on 2026-11-13 two of the three public mainnet nodes no longer knew a turn of the afternoon
 * before); an archival node keeps them all and answers more slowly. So the ordinary nodes are asked first, and the
 * archive (`archiveUrl`, when there is one) for what they can no longer show.
 */
export async function readTransaction<T>(nodes: { rpcUrl: string; archiveUrl: string | null }, hash: string, signerId: string, options: RpcOptions = {}): Promise<T> {
  const params = { tx_hash: hash, sender_account_id: signerId, wait_until: "NONE" };
  try {
    return await rpc<T>(nodes.rpcUrl, "tx", params, options);
  } catch (error) {
    if (!nodes.archiveUrl) throw error;
    return rpc<T>(nodes.archiveUrl, "tx", params, options);
  }
}
