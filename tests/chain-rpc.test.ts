// One request to a NEAR node, with a second node to turn to (lib/chain/rpc.ts).

import assert from "node:assert/strict";
import { test } from "node:test";
import { readTransaction, rpc, RpcError } from "../lib/chain/rpc.ts";

type Reply = { status: number; body?: unknown };

function fakeNodes(replies: Record<string, Reply[]>): { asked: string[]; restore: () => void } {
  const real = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    const reply = replies[url]?.shift() ?? { status: 200, body: { result: `answer of ${url}` } };
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status });
  }) as typeof fetch;
  return { asked, restore: () => (globalThis.fetch = real) };
}

test("a node that limits the caller hands over to the next one, which is then asked first", async () => {
  const nodes = fakeNodes({ "https://a.test": [{ status: 429 }] });
  try {
    const list = `https://a.test, https://b.test#${Math.random()}`.replace(/#.*/, "");
    assert.equal(await rpc<string>(list, "status", []), "answer of https://b.test");
    assert.deepEqual(nodes.asked, ["https://a.test", "https://b.test"]);
    // The next request goes straight to the node that answered.
    assert.equal(await rpc<string>(list, "status", []), "answer of https://b.test");
    assert.deepEqual(nodes.asked.slice(2), ["https://b.test"]);
  } finally {
    nodes.restore();
  }
});

test("what a node says about the request itself is not asked of another node", async () => {
  const refusal = { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: { requested_account_id: "x" } } } };
  const nodes = fakeNodes({ "https://c.test": [{ status: 200, body: refusal }] });
  try {
    await assert.rejects(rpc("https://c.test,https://d.test", "query", {}), (error) => error instanceof RpcError && error.code === "UNKNOWN_ACCOUNT");
    assert.deepEqual(nodes.asked, ["https://c.test"]);
  } finally {
    nodes.restore();
  }
});

test("a transaction the ordinary nodes have forgotten is read from the archive", async () => {
  const forgotten = { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION", info: { requested_transaction_hash: "h" } } } };
  const nodes = fakeNodes({
    "https://e.test": [
      { status: 200, body: forgotten },
      { status: 200, body: forgotten },
    ],
  });
  try {
    assert.equal(await readTransaction<string>({ rpcUrl: "https://e.test", archiveUrl: "https://archive.test" }, "h", "signer.near"), "answer of https://archive.test");
    assert.deepEqual(nodes.asked, ["https://e.test", "https://archive.test"]);
    // With no archive to turn to, the node's own answer is what the caller gets.
    await assert.rejects(
      readTransaction({ rpcUrl: "https://e.test", archiveUrl: null }, "h", "signer.near"),
      (error) => error instanceof RpcError && error.code === "UNKNOWN_TRANSACTION",
    );
  } finally {
    nodes.restore();
  }
});
