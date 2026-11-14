// A server's key that signs on several servers at once: a transaction the chain passed over is signed again
// (lib/chain/client.ts `Session.wait`).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { encodeBase58, fromBase64 } from "../lib/chain/base58.ts";
import { ChainClient } from "../lib/chain/client.ts";
import type { ChainConfig } from "../lib/chain/config.ts";
import { generateKeyPair } from "../lib/chain/keys.ts";
import { jsonArgs } from "../lib/chain/transaction.ts";

const config = {
  network: "testnet",
  rpcUrl: "https://node.test",
  archiveUrl: null,
  contractId: "game.test",
  chibiId: "chibi.test",
  devUrl: null,
  wallets: false,
  explorerUrl: null,
  indexerUrl: null,
  pollMs: 500,
  blockHashTtlMs: 60_000,
} as ChainConfig;

/** A node that keeps one key's nonce and knows only the transactions it is told to run. */
function fakeNode(start: number) {
  const real = globalThis.fetch;
  const node = {
    nonce: start,
    sent: [] as { hash: string; nonce: number }[],
    ran: new Set<string>(),
    asked: [] as string[],
    onSend: (_sent: { hash: string; nonce: number }) => {},
  };
  const unknown = (hash: string) => ({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION", info: { requested_transaction_hash: hash } } } });
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: Record<string, string> };
    node.asked.push(method === "tx" ? `tx:${params.wait_until}` : method);
    let body: unknown;
    if (method === "query") body = { result: { nonce: node.nonce } };
    else if (method === "block") body = { result: { header: { hash: encodeBase58(new Uint8Array(32).fill(7)), height: 100 } } };
    else if (method === "send_tx") {
      const bytes = fromBase64(params.signed_tx_base64);
      // A signed transaction is the transaction and, after it, the kind of signature (one byte) and its 64 bytes.
      const tx = bytes.subarray(0, bytes.length - 65);
      const signer = new DataView(tx.buffer, tx.byteOffset).getUint32(0, true);
      const nonce = Number(new DataView(tx.buffer, tx.byteOffset).getBigUint64(4 + signer + 33, true));
      const sent = { hash: encodeBase58(createHash("sha256").update(tx).digest()), nonce };
      node.sent.push(sent);
      node.onSend(sent);
      body = { result: {} };
    } else if (method === "tx") body = node.ran.has(params.tx_hash) ? { result: { status: { SuccessValue: "" }, receipts_outcome: [] } } : unknown(params.tx_hash);
    else body = { error: { name: "REQUEST_VALIDATION_ERROR" } };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { node, restore: () => (globalThis.fetch = real) };
}

const call = [{ method: "play", args: jsonArgs({ id: "m-1", seat: 0, actions: ["End"] }), gas: 100_000_000_000_000n, deposit: 0n }];

test("a transaction another server's took the nonce of is signed again with the next one", async () => {
  const { node, restore } = fakeNode(10);
  try {
    const session = new ChainClient(config).session("free.test", generateKeyPair(), { pipelined: true, passedOverAfterMs: 20 });
    // The first one goes out with nonce 11 while another server's, with the same nonce, is the one the chain runs.
    node.onSend = (sent) => {
      if (node.sent.length === 1) node.nonce = 11;
      else node.ran.add(sent.hash);
    };
    const outcome = await session.sendTo("game.test", call);
    assert.deepEqual(
      node.sent.map((sent) => sent.nonce),
      [11, 12],
    );
    assert.equal(outcome.hash, node.sent[1].hash);
    // It asked whether the chain knew the first one at all before giving it up.
    assert.ok(node.asked.includes("tx:NONE"));
  } finally {
    restore();
  }
});

test("one that is only slow is waited for, not sent twice", async () => {
  const { node, restore } = fakeNode(10);
  try {
    const session = new ChainClient(config).session("free.test", generateKeyPair(), { pipelined: true, passedOverAfterMs: 20 });
    // Its own nonce is on the chain (it was taken into a block) and the chain knows it; it has just not run yet.
    let known = "";
    node.onSend = (sent) => {
      node.nonce = sent.nonce;
      known = sent.hash;
      setTimeout(() => node.ran.add(sent.hash), 200);
    };
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: Record<string, string> };
      if (method === "tx" && params.wait_until === "NONE" && params.tx_hash === known) return new Response(JSON.stringify({ result: { status: {} } }), { status: 200 });
      return real(url, init);
    }) as typeof fetch;
    const outcome = await session.sendTo("game.test", call);
    assert.equal(node.sent.length, 1);
    assert.equal(outcome.hash, node.sent[0].hash);
  } finally {
    restore();
  }
});

test("a server reads the chain's nonce before each signature: one used elsewhere is not used again", async () => {
  const { node, restore } = fakeNode(10);
  try {
    const session = new ChainClient(config).session("free.test", generateKeyPair(), { pipelined: true, passedOverAfterMs: 20 });
    node.onSend = (sent) => {
      node.ran.add(sent.hash);
      node.nonce = sent.nonce;
    };
    await session.sendTo("game.test", call);
    node.nonce = 15; // other servers have signed four more with this key
    await session.sendTo("game.test", call);
    assert.deepEqual(
      node.sent.map((sent) => sent.nonce),
      [11, 16],
    );
  } finally {
    restore();
  }
});

// What the public nodes answered on 2026-11-14 when asked to wait for a transaction they did not know: the question
// held for ten seconds and then HTTP 408 with this body, or (two times in three, test.rpc.fastnear.com) no answer at all.
const HELD = { error: { name: "HANDLER_ERROR", cause: { info: { cause: "NOT_OBSERVED" }, name: "TIMEOUT_ERROR" }, code: -32000, message: "Server error", data: "Timeout" } };

/** `fakeNode`, but asked to wait for a transaction it does not know it answers as `held` says, as a real node does. */
function realisticNode(start: number, held: (init?: RequestInit) => Promise<Response>) {
  const made = fakeNode(start);
  const fake = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: Record<string, string> };
    if (method === "tx" && params.wait_until !== "NONE" && !made.node.ran.has(params.tx_hash)) return held(init);
    return fake(url, init);
  }) as typeof fetch;
  return made;
}

/** The first transaction goes out with a nonce another server's has taken; the second is the one the chain runs. */
const passedOverOnce = (node: ReturnType<typeof fakeNode>["node"]) => (sent: { hash: string; nonce: number }) => {
  if (node.sent.length === 1) node.nonce = sent.nonce;
  else node.ran.add(sent.hash);
};
async function within<T>(ms: number, job: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((_, reject) => (timer = setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms)));
  try {
    return await Promise.race([job, late]);
  } finally {
    clearTimeout(timer);
  }
}

test("a node that gives up waiting with HTTP 408, as the public ones do, does not hide a transaction that was passed over", async () => {
  const { node, restore } = realisticNode(10, async () => new Response(JSON.stringify(HELD), { status: 408 }));
  try {
    const session = new ChainClient(config).session("free.test", generateKeyPair(), { pipelined: true, passedOverAfterMs: 20 });
    node.onSend = passedOverOnce(node);
    const outcome = await within(3_000, session.sendTo("game.test", call));
    assert.deepEqual(
      node.sent.map((sent) => sent.nonce),
      [11, 12],
    );
    assert.equal(outcome.hash, node.sent[1].hash);
  } finally {
    restore();
  }
});

test("a node that does not answer at all does not hold the wait: the transaction passed over is signed again", async () => {
  // Like fetch: nothing until the request is given up, then the reason it was given up for.
  const silent = (init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
  const { node, restore } = realisticNode(10, silent);
  try {
    const session = new ChainClient(config).session("free.test", generateKeyPair(), { pipelined: true, passedOverAfterMs: 20 });
    node.onSend = passedOverOnce(node);
    const outcome = await within(3_000, session.sendTo("game.test", call));
    assert.deepEqual(
      node.sent.map((sent) => sent.nonce),
      [11, 12],
    );
    assert.equal(outcome.hash, node.sent[1].hash);
  } finally {
    restore();
  }
});
