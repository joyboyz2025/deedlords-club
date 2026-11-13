// Reads from and calls to one contract over raw JSON-RPC. A `Session` signs with a function-call key held in the
// browser, so a move needs no wallet prompt: the key can only call the game contract's move methods and carries no
// deposit (see SESSION_METHODS in contracts/sandbox/testnet.js).
//
// A session can also sign calls for somebody else to send (`delegate`, NEP-366): the account then pays nothing, and
// needs nothing. On a server the same class holds the key of the account that pays (`pipelined`, `sendTo`).

import { decodeBase58, fromBase64, toBase64 } from "./base58.ts";
import { type ChainConfig, MOVE_GAS } from "./config.ts";
import { type KeyPair, publicKeyText, sign } from "./keys.ts";
import { RpcError, rpc } from "./rpc.ts";
import { type Action, type FunctionCall, jsonArgs, signDelegateAction, signTransaction } from "./transaction.ts";

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

/**
 * Whether `error` is a `ContractFailure`, by what it carries and not by its class: a server keeps one sender for all
 * its routes, and the routes may each have been given their own copy of this file.
 */
export function isContractFailure(error: unknown): error is ContractFailure {
  return error instanceof Error && error.name === "ContractFailure" && typeof (error as { hash?: unknown }).hash === "string";
}

type CallResult = { result?: number[]; error?: string };
type Status = { SuccessValue?: string; Failure?: unknown };
type TxResult = {
  status?: Status;
  receipts_outcome?: { outcome: { logs: string[]; executor_id?: string; status?: Status } }[];
};

/** What a relayer answers once the calls it was handed have run: what they returned, or the contract's refusal. */
export type Relayed = { hash: string; value: unknown; events: ContractEvent[] } | { hash: string; failed: string };
/** Hands a signed delegate action to whoever sends and pays for it. */
export type Deliver = (signedDelegate: Uint8Array) => Promise<Relayed>;

/** How long a signed delegate action stays sendable, in blocks: about ten minutes on testnet. */
const DELEGATE_BLOCKS = 1_000n;

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
  private block: { hash: Uint8Array; height: bigint; at: number } | null = null;

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

  /** The contract a function-call key of the account may call, or `null`: no such key on the account, or a full-access one. */
  async functionCallKey(accountId: string, publicKey: Uint8Array): Promise<{ receiverId: string; methods: string[] } | null> {
    type Permission = "FullAccess" | { FunctionCall: { receiver_id: string; method_names: string[] } };
    try {
      const key = await rpc<{ permission?: Permission; error?: string }>(this.config.rpcUrl, "query", {
        request_type: "view_access_key",
        finality: "optimistic",
        account_id: accountId,
        public_key: publicKeyText(publicKey),
      });
      if (key.error || typeof key.permission !== "object") return null;
      return { receiverId: key.permission.FunctionCall.receiver_id, methods: key.permission.FunctionCall.method_names };
    } catch (error) {
      if (error instanceof RpcError && (error.code === "UNKNOWN_ACCESS_KEY" || error.code === "UNKNOWN_ACCOUNT")) return null;
      throw error;
    }
  }

  /** Calls a view method of any contract. */
  async viewOf<T>(contractId: string, method: string, args: unknown = {}): Promise<T> {
    const query = { request_type: "call_function", finality: "optimistic", account_id: contractId, method_name: method, args_base64: toBase64(jsonArgs(args)) };
    const result = await rpc<CallResult>(this.config.rpcUrl, "query", query);
    if (result.error || !result.result) throw new RpcError(`view ${contractId}.${method}: ${result.error ?? "no result"}`, "VIEW_ERROR");
    return JSON.parse(utf8.decode(Uint8Array.from(result.result))) as T;
  }

  /** The account's balance in yoctoNEAR, or `null` when there is no such account (an implicit account nobody has funded yet). */
  async balance(accountId: string): Promise<bigint | null> {
    try {
      const account = await rpc<{ amount: string }>(this.config.rpcUrl, "query", { request_type: "view_account", finality: "optimistic", account_id: accountId });
      return BigInt(account.amount);
    } catch (error) {
      if (error instanceof RpcError && error.code === "UNKNOWN_ACCOUNT") return null;
      throw error;
    }
  }

  /**
   * A full-access key of the account with its nonce: what a wallet signs with. One of `prefer` when the account has it.
   * `null` when the account has none (or does not exist).
   */
  async fullAccessKey(accountId: string, prefer: string[] = []): Promise<{ publicKey: string; nonce: bigint } | null> {
    type Listed = { public_key: string; access_key: { nonce: number | string; permission: unknown } };
    let keys: Listed[];
    try {
      keys = (await rpc<{ keys: Listed[] }>(this.config.rpcUrl, "query", { request_type: "view_access_key_list", finality: "final", account_id: accountId })).keys;
    } catch (error) {
      if (error instanceof RpcError && error.code === "UNKNOWN_ACCOUNT") return null;
      throw error;
    }
    const full = keys.filter((key) => key.access_key.permission === "FullAccess" && key.public_key.startsWith("ed25519:"));
    const chosen = full.find((key) => prefer.includes(key.public_key)) ?? full[0];
    return chosen ? { publicKey: chosen.public_key, nonce: BigInt(chosen.access_key.nonce) } : null;
  }

  async blockHash(fresh = false): Promise<Uint8Array> {
    return (await this.recentBlock(fresh)).hash;
  }

  /** The height of a recent final block: as old as `blockHash` may be. */
  async blockHeight(fresh = false): Promise<bigint> {
    return (await this.recentBlock(fresh)).height;
  }

  private async recentBlock(fresh: boolean): Promise<{ hash: Uint8Array; height: bigint }> {
    if (!fresh && this.block && Date.now() - this.block.at < this.config.blockHashTtlMs) return this.block;
    const block = await rpc<{ header: { hash: string; height: number } }>(this.config.rpcUrl, "block", { finality: "final" });
    this.block = { hash: decodeBase58(block.header.hash), height: BigInt(block.header.height), at: Date.now() };
    return this.block;
  }

  /**
   * Sends a transaction somebody else signed (NEAR Auth, for an account whose key is not here) and waits until it
   * has run. Throws `ContractFailure` when it was refused on chain, `RpcError` when the node would not take it.
   */
  async broadcast(bytes: Uint8Array, hash: string, signerId: string): Promise<Outcome> {
    const { rpcUrl } = this.config;
    try {
      // Sending the same signed transaction twice is harmless (same hash), so a rate limit here is simply retried.
      const result = await rpc<TxResult>(rpcUrl, "send_tx", { signed_tx_base64: toBase64(bytes), wait_until: "EXECUTED_OPTIMISTIC" }, { timeoutMs: 60_000, retryTimeout: false });
      return outcomeOf(result, hash);
    } catch (error) {
      if (!(error instanceof RpcError && (error.code === "TIMEOUT_ERROR" || error.code === "TIMEOUT"))) throw error;
    }
    for (const until = Date.now() + 90_000; ;) {
      try {
        return outcomeOf(await rpc<TxResult>(rpcUrl, "tx", { tx_hash: hash, sender_account_id: signerId, wait_until: "EXECUTED_OPTIMISTIC" }, { timeoutMs: 30_000 }), hash);
      } catch (error) {
        const pending = error instanceof RpcError && (error.code === "TIMEOUT_ERROR" || error.code === "UNKNOWN_TRANSACTION" || error.code === "TIMEOUT");
        if (!pending || Date.now() > until) throw error;
        await sleep(300);
      }
    }
  }

  /**
   * `pipelined`: a transaction is only handed to the node before the next one may be signed, and its result is waited
   * for apart, so several can be on their way at once. For an account many requests send from (a server's).
   */
  session(accountId: string, pair: KeyPair, options: { pipelined?: boolean; passedOverAfterMs?: number } = {}): Session {
    return new Session(this, accountId, pair, options.pipelined ?? false, options.passedOverAfterMs);
  }
}

/** A transaction the chain still does not know after this long, while its key's nonce has moved on, was passed over. */
const PASSED_OVER_AFTER_MS = 6_000;
const passedOver = (error: unknown): boolean => error instanceof RpcError && error.code === "INVALID_TRANSACTION" && /passed over/.test(error.detail);

export class Session {
  readonly accountId: string;
  private readonly client: ChainClient;
  private readonly pair: KeyPair;
  private readonly pipelined: boolean;
  private nonce: bigint | null = null;
  private last: Promise<unknown> = Promise.resolve();
  private readonly passedOverAfterMs: number;

  constructor(client: ChainClient, accountId: string, pair: KeyPair, pipelined = false, passedOverAfterMs = PASSED_OVER_AFTER_MS) {
    this.client = client;
    this.accountId = accountId;
    this.pair = pair;
    this.pipelined = pipelined;
    this.passedOverAfterMs = passedOverAfterMs;
  }

  get publicKey(): Uint8Array {
    return this.pair.publicKey;
  }

  /** Signs `message` with this session's key: shows a server that this browser holds a key of the account. Sends nothing. */
  signMessage(message: Uint8Array): Uint8Array {
    return sign(this.pair, message);
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
    return this.transact([{ method, args: jsonArgs(args), gas, deposit: 0n }]);
  }

  /**
   * One transaction with several calls to the game contract, deposits included. Only a full-access key can sign a
   * deposit: the key of a game account, not a session key a wallet added. `value` is what the last call returned.
   */
  transact(calls: FunctionCall[]): Promise<Outcome> {
    return this.sendTo(this.client.config.contractId, calls);
  }

  /**
   * One transaction to any account: a transfer, or a player's delegate action sent to that player's own account.
   * `delegatedTo`: the account the delegate action inside calls. The transaction itself only hands the action over
   * and succeeds whatever becomes of it, so what the call returned, or why it was refused, is read from the receipt
   * it turned into.
   */
  sendTo(receiverId: string, actions: Action[], about: { delegatedTo?: string } = {}): Promise<Outcome> {
    if (!this.pipelined) return this.inTurn(() => this.retried((fresh) => this.sendOnce(receiverId, actions, fresh, true)));
    // Handed over in turn, waited for apart. One the chain passed over (see `wait`) is signed and handed over again.
    const once = async (): Promise<Outcome> => {
      const { hash, nonce } = await this.inTurn(() => this.retried((fresh) => this.sendOnce(receiverId, actions, fresh, false)));
      return outcomeOf(await this.wait(hash, nonce), hash, about.delegatedTo);
    };
    const again = async (left: number): Promise<Outcome> => {
      try {
        return await once();
      } catch (error) {
        if (left <= 0 || !passedOver(error)) throw error;
        return again(left - 1);
      }
    };
    return again(2);
  }

  /**
   * The same calls, signed here and sent by somebody else, who pays for them (`deliver`): the account needs no NEAR,
   * only to exist. No deposit can ride along: whoever sends would be the one paying it.
   * Throws `RpcError` `UNKNOWN_ACCESS_KEY` when the account does not exist yet or has lost this key.
   */
  delegate(calls: FunctionCall[], deliver: Deliver): Promise<Outcome> {
    return this.inTurn(() =>
      this.retried(async (fresh) => {
        if (this.nonce === null || fresh) this.nonce = await this.readNonce();
        const nonce = this.nonce + 1n;
        const signed = signDelegateAction(
          {
            senderId: this.accountId,
            receiverId: this.client.config.contractId,
            actions: calls,
            nonce,
            maxBlockHeight: (await this.client.blockHeight(fresh)) + DELEGATE_BLOCKS,
            publicKey: this.pair.publicKey,
          },
          this.pair,
        );
        let answer: Relayed;
        try {
          answer = await deliver(signed);
        } catch (error) {
          this.nonce = null; // it may or may not have been sent: read the nonce again next time
          throw error;
        }
        if ("failed" in answer) {
          // The chain did not take the delegate action itself (as opposed to the contract refusing the call inside).
          if (/DelegateAction(InvalidNonce|Expired)/.test(answer.failed)) {
            this.nonce = null;
            throw new RpcError(answer.failed, "INVALID_TRANSACTION", { detail: "InvalidNonce" });
          }
          this.nonce = nonce;
          throw new ContractFailure(answer.failed, answer.hash);
        }
        this.nonce = nonce;
        return answer;
      }),
    );
  }

  /** One at a time: a key's nonce only goes up. */
  private inTurn<T>(job: () => Promise<T>): Promise<T> {
    const run = this.last.then(job);
    this.last = run.catch(() => undefined);
    return run;
  }

  /** Another tab moved with the same key, or the block we named has expired: read both again, once. */
  private async retried<T>(attempt: (fresh: boolean) => Promise<T>): Promise<T> {
    try {
      return await attempt(false);
    } catch (error) {
      const stale = error instanceof RpcError && error.code === "INVALID_TRANSACTION" && /InvalidNonce|Expired/.test(error.detail);
      if (!stale) throw error;
      return attempt(true);
    }
  }

  private async readNonce(): Promise<bigint> {
    const nonce = await this.client.accessKeyNonce(this.accountId, this.pair.publicKey);
    if (nonce === null) throw new RpcError(`${this.accountId} has no session key for this browser`, "UNKNOWN_ACCESS_KEY");
    return nonce;
  }

  /** Signs and sends. `untilRun`: waits for the result; otherwise returns once the node has taken the transaction. */
  private async sendOnce(receiverId: string, actions: Action[], fresh: boolean, untilRun: true): Promise<Outcome>;
  private async sendOnce(receiverId: string, actions: Action[], fresh: boolean, untilRun: false): Promise<{ hash: string; nonce: bigint }>;
  private async sendOnce(receiverId: string, actions: Action[], fresh: boolean, untilRun: boolean): Promise<Outcome | { hash: string; nonce: bigint }> {
    const { rpcUrl } = this.client.config;
    if (this.nonce === null || fresh) this.nonce = await this.readNonce();
    else if (this.pipelined) {
      // A server's key signs on other servers too (each request of a host like Vercel may run on its own): the nonce
      // kept here may be behind what they have used. The chain's is read before every signature, and the larger kept:
      // ours when a transaction of ours is still on its way, the chain's when somebody else has signed since.
      const onChain = await this.readNonce();
      if (onChain > this.nonce) this.nonce = onChain;
    }
    const nonce = this.nonce + 1n;
    const { hash, bytes } = signTransaction(
      {
        signerId: this.accountId,
        publicKey: this.pair.publicKey,
        nonce,
        receiverId,
        blockHash: await this.client.blockHash(fresh),
        actions,
      },
      this.pair,
    );
    let result: TxResult | null = null;
    try {
      // Sending the same signed transaction twice is harmless (same hash), so a rate limit here is simply retried.
      const sent = await rpc<TxResult>(
        rpcUrl,
        "send_tx",
        { signed_tx_base64: toBase64(bytes), wait_until: untilRun ? "EXECUTED_OPTIMISTIC" : "NONE" },
        { timeoutMs: 60_000, retryTimeout: false },
      );
      if (untilRun) result = sent;
    } catch (error) {
      const waiting = error instanceof RpcError && (error.code === "TIMEOUT_ERROR" || error.code === "TIMEOUT");
      if (!waiting) {
        this.nonce = null; // not accepted: read the nonce again next time
        throw error;
      }
      if (untilRun) result = await this.wait(hash, nonce);
    }
    this.nonce = nonce;
    return result ? outcomeOf(result, hash) : { hash, nonce };
  }

  /**
   * Waits until the transaction has run. `nonce`: the one it was signed with. Two servers signing with the same key at
   * the same moment both read the same nonce; the node takes both transactions, the chain runs one and passes the
   * other over without a word, and asking after it answers "unknown" for ever (at a free poker table, where the
   * sponsor relays a guest's shares while it sends the house's own, this left a seat waiting ninety seconds and ruled
   * late). So once it has been unknown for a while, the key is looked at: if its nonce has reached ours and the chain
   * still does not know our transaction, another one took its place, and this throws the error a stale nonce throws,
   * for the caller to sign again.
   */
  private async wait(hash: string, nonce?: bigint): Promise<TxResult> {
    const { rpcUrl } = this.client.config;
    const started = Date.now();
    const until = started + 90_000;
    let looked = 0;
    for (;;) {
      try {
        return await rpc<TxResult>(rpcUrl, "tx", { tx_hash: hash, sender_account_id: this.accountId, wait_until: "EXECUTED_OPTIMISTIC" }, { timeoutMs: 30_000 });
      } catch (error) {
        const pending = error instanceof RpcError && (error.code === "TIMEOUT_ERROR" || error.code === "UNKNOWN_TRANSACTION" || error.code === "TIMEOUT");
        if (!pending || Date.now() > until) {
          this.nonce = null;
          throw error;
        }
        if (nonce !== undefined && Date.now() - started >= this.passedOverAfterMs && Date.now() - looked >= Math.min(2_000, this.passedOverAfterMs)) {
          looked = Date.now();
          const onChain = await this.client.accessKeyNonce(this.accountId, this.pair.publicKey).catch(() => null);
          if (onChain !== null && onChain >= nonce && !(await this.known(hash))) {
            this.nonce = null;
            throw new RpcError(`transaction ${hash} was passed over: another one took its nonce`, "INVALID_TRANSACTION", { detail: "InvalidNonce: passed over" });
          }
        }
        await sleep(300);
      }
    }
  }

  /** Whether the chain has the transaction at all, run or not. Asked twice, a moment apart: a node may be a block behind. */
  private async known(hash: string): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await sleep(Math.min(700, this.passedOverAfterMs));
      try {
        await rpc<TxResult>(this.client.config.rpcUrl, "tx", { tx_hash: hash, sender_account_id: this.accountId, wait_until: "NONE" }, { timeoutMs: 10_000 });
        return true;
      } catch (error) {
        if (!(error instanceof RpcError && error.code === "UNKNOWN_TRANSACTION")) return true; // not a "no": keep waiting
      }
    }
    return false;
  }
}

/**
 * What a transaction that has run returned, or `ContractFailure` when it was refused. `delegatedTo`: the transaction
 * carried a delegate action that calls that account; the answer and the refusal are then those of the call inside.
 */
function outcomeOf(result: TxResult, hash: string, delegatedTo?: string): Outcome {
  if (result.status?.Failure !== undefined) throw new ContractFailure(failureText(result.status.Failure), hash);
  let answered = result.status;
  if (delegatedTo !== undefined) {
    const receipts = result.receipts_outcome ?? [];
    const refused = receipts.find((receipt) => receipt.outcome.status?.Failure !== undefined);
    if (refused) throw new ContractFailure(failureText(refused.outcome.status!.Failure), hash);
    // The first receipt is the hand-over itself; the call is the next one that runs on the account it names.
    answered = receipts.slice(1).find((receipt) => receipt.outcome.executor_id === delegatedTo)?.outcome.status ?? {};
  }
  const returned = utf8.decode(fromBase64(answered?.SuccessValue ?? ""));
  let value: unknown = null;
  try {
    value = returned ? JSON.parse(returned) : null;
  } catch {
    value = returned;
  }
  return { hash, value, events: eventsOf(result) };
}
