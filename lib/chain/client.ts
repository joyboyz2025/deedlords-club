// Reads from and calls to one contract over raw JSON-RPC. A `Session` signs with a function-call key held in the
// browser, so a move needs no wallet prompt: the key can only call the game contract's move methods and carries no
// deposit (see SESSION_METHODS in contracts/sandbox/testnet.js).

import { decodeBase58, fromBase64, toBase64 } from "./base58.ts";
import { type ChainConfig, MOVE_GAS } from "./config.ts";
import { type KeyPair, publicKeyText } from "./keys.ts";
import { RpcError, rpc } from "./rpc.ts";
import { jsonArgs, signTransaction } from "./transaction.ts";

export type ContractEvent = { standard: string; version: string; event: string; data: Record<string, unknown> };

/** A transaction that ran. `value` is what the method returned. */
export type Outcome = { hash: string; value: unknown; events: ContractEvent[] };

/** The transaction was included and the contract refused it: nothing changed on chain. */
export class ContractFailure extends Error {
  readonly hash: string;

  constructor(message: string, hash: string) {
    super(message);
    this.name = "ContractFailure";
    this.hash = hash;
  }
}

type CallResult = { result?: number[]; error?: string };
type TxResult = {
  status?: { SuccessValue?: string; Failure?: unknown };
  receipts_outcome?: { outcome: { logs: string[] } }[];
};

const utf8 = new TextDecoder();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The contract's own words out of a failed execution, without the node's wrapping. */
export function failureText(failure: unknown): string {
  const text = JSON.stringify(failure) ?? "";
  const panic = /Smart contract panicked: ((?:[^"\\]|\\.)*)/.exec(text);
  if (panic) return panic[1].replace(/\\(.)/g, "$1");
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

export function eventsOf(result: TxResult): ContractEvent[] {
  const events: ContractEvent[] = [];
  for (const receipt of result.receipts_outcome ?? []) {
    for (const log of receipt.outcome.logs) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      try {
        events.push(JSON.parse(log.slice("EVENT_JSON:".length)) as ContractEvent);
      } catch {
        // Not ours to fix: a log that is not JSON is skipped.
      }
    }
  }
  return events;
}

export class ChainClient {
  readonly config: ChainConfig;
  private block: { hash: Uint8Array; at: number } | null = null;

  constructor(config: ChainConfig) {
    this.config = config;
  }

  /** Calls a view method of the game contract. Views are free and need no key. */
  async view<T>(method: string, args: unknown = {}): Promise<T> {
    const result = await rpc<CallResult>(this.config.rpcUrl, "query", {
      request_type: "call_function",
      finality: "optimistic",
      account_id: this.config.contractId,
      method_name: method,
      args_base64: toBase64(jsonArgs(args)),
    });
    if (result.error || !result.result) throw new RpcError(`view ${method}: ${result.error ?? "no result"}`, "VIEW_ERROR");
    return JSON.parse(utf8.decode(Uint8Array.from(result.result))) as T;
  }

  /** The nonce of an access key, or `null` when the account does not have that key. */
  async accessKeyNonce(accountId: string, publicKey: Uint8Array): Promise<bigint | null> {
    try {
      const key = await rpc<{ nonce: number | string; error?: string }>(this.config.rpcUrl, "query", {
        request_type: "view_access_key",
        finality: "optimistic",
        account_id: accountId,
        public_key: publicKeyText(publicKey),
      });
      return key.error ? null : BigInt(key.nonce);
    } catch (error) {
      if (error instanceof RpcError && (error.code === "UNKNOWN_ACCESS_KEY" || error.code === "UNKNOWN_ACCOUNT")) return null;
      throw error;
    }
  }

  async blockHash(fresh = false): Promise<Uint8Array> {
    if (!fresh && this.block && Date.now() - this.block.at < this.config.blockHashTtlMs) return this.block.hash;
    const block = await rpc<{ header: { hash: string } }>(this.config.rpcUrl, "block", { finality: "final" });
    this.block = { hash: decodeBase58(block.header.hash), at: Date.now() };
    return this.block.hash;
  }

  session(accountId: string, pair: KeyPair): Session {
    return new Session(this, accountId, pair);
  }
}

export class Session {
  readonly accountId: string;
  private readonly client: ChainClient;
  private readonly pair: KeyPair;
  private nonce: bigint | null = null;
  private last: Promise<unknown> = Promise.resolve();

  constructor(client: ChainClient, accountId: string, pair: KeyPair) {
    this.client = client;
    this.accountId = accountId;
    this.pair = pair;
  }

  /** Whether the account still has this key. */
  async ready(): Promise<boolean> {
    return (await this.client.accessKeyNonce(this.accountId, this.pair.publicKey)) !== null;
  }

  /**
   * Calls a method of the game contract and waits until it has run. One call at a time: a key's nonce only goes up.
   * Throws `ContractFailure` when the contract refuses the call, `RpcError` when the node does or cannot be reached.
   */
  call(method: string, args: unknown, gas: bigint = MOVE_GAS): Promise<Outcome> {
    const run = this.last.then(() => this.send(method, args, gas));
    this.last = run.catch(() => undefined);
    return run;
  }

  private async send(method: string, args: unknown, gas: bigint): Promise<Outcome> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.sendOnce(method, args, gas, attempt > 0);
      } catch (error) {
        // Another tab moved with the same key, or the block we named has expired: read both again, once.
        const stale = error instanceof RpcError && error.code === "INVALID_TRANSACTION" && /InvalidNonce|Expired/.test(error.detail);
        if (!stale || attempt > 0) throw error;
      }
    }
  }

  private async sendOnce(method: string, args: unknown, gas: bigint, fresh: boolean): Promise<Outcome> {
    const { rpcUrl, contractId } = this.client.config;
    if (this.nonce === null || fresh) {
      const nonce = await this.client.accessKeyNonce(this.accountId, this.pair.publicKey);
      if (nonce === null) throw new RpcError(`${this.accountId} has no session key for this browser`, "UNKNOWN_ACCESS_KEY");
      this.nonce = nonce;
    }
    const nonce = this.nonce + 1n;
    const { hash, bytes } = signTransaction(
      {
        signerId: this.accountId,
        publicKey: this.pair.publicKey,
        nonce,
        receiverId: contractId,
        blockHash: await this.client.blockHash(fresh),
        actions: [{ method, args: jsonArgs(args), gas, deposit: 0n }],
      },
      this.pair,
    );
    let result: TxResult;
    try {
      // Sending the same signed transaction twice is harmless (same hash), so a rate limit here is simply retried.
      result = await rpc<TxResult>(rpcUrl, "send_tx", { signed_tx_base64: toBase64(bytes), wait_until: "EXECUTED_OPTIMISTIC" }, { timeoutMs: 60_000, retryTimeout: false });
    } catch (error) {
      const waiting = error instanceof RpcError && (error.code === "TIMEOUT_ERROR" || error.code === "TIMEOUT");
      if (!waiting) {
        this.nonce = null; // not accepted: read the nonce again next time
        throw error;
      }
      result = await this.wait(hash);
    }
    this.nonce = nonce;
    if (result.status?.Failure !== undefined) throw new ContractFailure(failureText(result.status.Failure), hash);
    const returned = utf8.decode(fromBase64(result.status?.SuccessValue ?? ""));
    let value: unknown = null;
    try {
      value = returned ? JSON.parse(returned) : null;
    } catch {
      value = returned;
    }
    return { hash, value, events: eventsOf(result) };
  }

  private async wait(hash: string): Promise<TxResult> {
    const until = Date.now() + 90_000;
    for (;;) {
      try {
        return await rpc<TxResult>(this.client.config.rpcUrl, "tx", { tx_hash: hash, sender_account_id: this.accountId, wait_until: "EXECUTED_OPTIMISTIC" }, { timeoutMs: 30_000 });
      } catch (error) {
        const pending = error instanceof RpcError && (error.code === "TIMEOUT_ERROR" || error.code === "UNKNOWN_TRANSACTION" || error.code === "TIMEOUT");
        if (!pending || Date.now() > until) {
          this.nonce = null;
          throw error;
        }
        await sleep(300);
      }
    }
  }
}
