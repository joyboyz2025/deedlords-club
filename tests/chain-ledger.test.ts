// The list of a match's transactions (games/co-ty-phu/chain/ledger.ts), against the shapes the NearBlocks API v3 and the
// NEAR RPC answered on testnet on 2026-11-11.

import assert from "node:assert/strict";
import { test } from "node:test";
import { describeCall, matchTransactions, mergeMoves, type MoveTx } from "../games/co-ty-phu/chain/ledger.ts";
import { SQUARES } from "../games/co-ty-phu/board.ts";

const city = SQUARES.findIndex((square) => square.kind === "city");

test("a call reads as what it did at the table", () => {
  assert.equal(describeCall("create_match", { id: "m" }), "Open the match");
  assert.equal(describeCall("join", { id: "m", seat: 1 }), "Stake and take seat 2");
  assert.equal(describeCall("play", { id: "m", seat: 0, actions: ["Roll", "Buy", { Build: city }, "End"] }), `Roll · Buy · Build in ${SQUARES[city].name} · End turn`);
  assert.equal(describeCall("play", { id: "m", seat: 0, actions: [{ Mortgage: city }, "Pay", "Skip"] }), `Mortgage ${SQUARES[city].name} · Pay the debt · Pass`);
  assert.equal(describeCall("turn", { id: "m", seat: 0, plan: {} }), "AI turn, by plan");
  assert.equal(describeCall("timeout", { id: "m" }), "Timeout · the contract moves");
  assert.equal(describeCall("set_driver", { id: "m", seat: 0, driver: "bot.testnet" }), "Hand seat 1 to an agent");
  assert.equal(describeCall("set_driver", { id: "m", seat: 0, driver: null }), "Take seat 1 back");
  assert.equal(describeCall("withdraw_fees", {}), "withdraw_fees");
});

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
const listed = (hash: string, signer: string, method: string, seconds: number, ok = true) => ({
  transaction_hash: hash,
  signer_account_id: signer,
  receiver_account_id: "game.testnet",
  actions: [{ action: "FUNCTION_CALL", method }],
  block: { block_timestamp: `${seconds}000000000` },
  outcomes: { status: ok },
});
const call = (method: string, args: unknown) => ({ FunctionCall: { method_name: method, args: b64(args), gas: 1, deposit: "0" } });

test("the transactions of one match are picked out of the contract's, newest first, and each is read once", async () => {
  const chain: Record<string, unknown[]> = {
    t6: [call("timeout", { id: "m-a" })],
    t5: [call("play", { id: "m-b", seat: 0, actions: ["Roll"] })],
    t4: [call("play", { id: "m-a", seat: 1, actions: ["Roll", "Skip", "End"] })],
    t3: [call("turn", { id: "m-a", seat: 0, plan: { buy_reserve: 150 } })],
    t2: [call("join", { id: "m-a", seat: 1 })],
    t1: [call("create_match", { id: "m-a", seats: 2 }), call("join", { id: "m-a", seat: 0 })],
    t0: [call("play", { id: "m-old", seat: 0, actions: ["Roll"] })],
  };
  const pages: Record<string, unknown> = {
    "": { data: [listed("t6", "alice", "timeout", 60), listed("t5", "carol", "play", 50), { ...listed("x1", "owner", "withdraw_fees", 45) }, listed("t4", "bob", "play", 40, false)], meta: { next_page: "c1" } },
    c1: { data: [listed("t3", "alice", "turn", 30), listed("t2", "bob", "join", 20), listed("t1", "alice", "create_match", 10)], meta: { next_page: "c2" } },
    c2: { data: [listed("t0", "dave", "play", 5)], meta: { next_page: null } },
  };
  // What the contract logged for two of them: the dice and the squares are only there.
  const event = (steps: unknown[]) => [{ outcome: { logs: ["something else", `EVENT_JSON:${JSON.stringify({ standard: "deedlords", event: "actions", data: { id: "m-a", steps } })}`] } }];
  const logs: Record<string, unknown[]> = {
    t6: event([{ action: "Auto", events: [{ kind: "auto", player: "s0" }, { kind: "roll", player: "s0", dice: [2, 2] }, { kind: "tax", player: "s0", square: 4, amount: 200 }] }]),
    t3: event([
      { action: "Roll", events: [{ kind: "roll", player: "s0", dice: [6, 2] }] },
      { action: "Buy", events: [{ kind: "buy", player: "s0", square: city, price: 60 }] },
      { action: "End", events: [] },
    ]),
  };
  const asked: string[] = [];
  const read: string[] = [];
  const sources = {
    indexerUrl: "https://indexer.example",
    contractId: "game.testnet",
    known: new Map(),
    fetch: (async (url: string | URL | Request) => {
      asked.push(String(url));
      return new Response(JSON.stringify(pages[new URL(String(url)).searchParams.get("next") ?? ""]));
    }) as typeof fetch,
    readTx: async (hash: string, signer: string) => {
      read.push(`${hash}:${signer}`);
      return { transaction: { actions: chain[hash] }, receipts_outcome: logs[hash] ?? [] };
    },
  };
  const rows = await matchTransactions("m-a", sources);
  assert.deepEqual(rows.map((row) => [row.hash, row.signer, row.method, row.what, row.atMs, row.ok]), [
    ["t6", "alice", "timeout", "Timeout: Roll 2+2, tax 200", 60_000, true],
    ["t4", "bob", "play", "Roll · Pass · End turn", 40_000, false],
    ["t3", "alice", "turn", `AI turn: Roll 6+2 · Buy ${SQUARES[city].name} · End turn`, 30_000, true],
    ["t2", "bob", "join", "Stake and take seat 2", 20_000, true],
    ["t1", "alice", "create_match", "Open the match · Stake and take seat 1", 10_000, true],
  ]);
  // It stopped at the transaction that opened the match: the page before it was never asked for.
  assert.deepEqual(asked, ["https://indexer.example/v3/accounts/game.testnet/txns?limit=100", "https://indexer.example/v3/accounts/game.testnet/txns?limit=100&next=c1"]);
  // Calls of the game only, each read once.
  assert.deepEqual(read.sort(), ["t1:alice", "t2:bob", "t3:alice", "t4:bob", "t5:carol", "t6:alice"]);
  await matchTransactions("m-a", sources);
  assert.equal(read.length, 6, "what a transaction did never changes: nothing is read twice");
  assert.deepEqual((await matchTransactions("m-b", sources)).map((row) => row.hash), ["t5"]);

  await assert.rejects(matchTransactions("m-a", { ...sources, fetch: (async () => new Response("{}", { status: 429 })) as typeof fetch }), /the indexer answered 429/);
});

test("what this browser sent itself is listed at once, and gives way to the indexer's row", () => {
  const mine: MoveTx = { hash: "t9", signer: "alice", method: "play", what: "Roll", atMs: 99_000, ok: true };
  const early: MoveTx = { hash: "t4", signer: "alice", method: "play", what: "Roll", atMs: 41_500, ok: true };
  const indexed: MoveTx = { hash: "t4", signer: "alice", method: "play", what: "Roll", atMs: 40_000, ok: true };
  assert.deepEqual(mergeMoves([indexed], [early, mine]), [mine, indexed]);
  assert.deepEqual(mergeMoves([], []), []);
});
