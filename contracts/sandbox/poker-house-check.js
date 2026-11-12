// Deedlords Poker on TESTNET: that the house (games/poker/house.ts, through a running web server) looks after itself.
//   1. A player who never asks the house to play cannot make it run out of time: it plays its part unasked.
//   2. Between hands the house does not deal until told to, and when nobody tells it, it leaves the table and both
//      seats are paid what they hold.
//   3. A player who sits down and walks away before the first shuffle gets the stake back the same way.
//
//   POKER_PLAYER=p1.deedlords.testnet node --experimental-strip-types poker-house-check.js
//
// POKER_WEB (default http://localhost:3000) is the web server. Refuses mainnet.

"use strict";

const os = require("os");
const path = require("path");
const assert = require("assert/strict");
const { connect, keyStores } = require("near-api-js");

const CONTRACT = process.env.POKER_CONTRACT ?? "poker.deedlords.testnet";
const PLAYER = process.env.POKER_PLAYER ?? "p1.deedlords.testnet";
const WEB = (process.env.POKER_WEB ?? "http://localhost:3000").replace(/\/$/, "");
const TGAS = 10n ** 12n;
const DEPOSIT = 10n ** 23n + 2n * 10n ** 21n;
const TURN_SECONDS = 40;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!PLAYER.endsWith(".testnet") || !CONTRACT.endsWith(".testnet")) throw new Error("testnet only");
  const { newKeys, keyProof } = await import("../../games/poker/crypto.ts");
  const { duty, toBase64, fromBase64 } = await import("../../games/poker/seat.ts");
  const keyStore = new keyStores.UnencryptedFileSystemKeyStore(process.env.NEAR_CREDENTIALS_DIR ?? path.join(os.homedir(), ".near-credentials"));
  const near = await connect({ networkId: "testnet", nodeUrl: process.env.POKER_RPC ?? "https://test.rpc.fastnear.com", keyStore });
  const account = await near.account(PLAYER);
  const patient = async (what) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await what();
      } catch (e) {
        if (attempt >= 9 || !/429|Rate limit|timeout|Timeout|ECONNRESET|fetch failed|Exceeded the/.test(String(e && (e.message || e)))) throw e;
        await sleep(3000 * (attempt + 1));
      }
    }
  };
  const view = (method, args) => patient(() => account.viewFunction({ contractId: CONTRACT, methodName: method, args }));
  const call = (method, args, deposit = 0n) =>
    patient(() => account.functionCall({ contractId: CONTRACT, methodName: method, args, gas: (method === "shuffle" ? 260n : 40n) * TGAS, attachedDeposit: deposit }));
  const join = async (id) => {
    for (let tries = 0; ; tries++) {
      const response = await fetch(`${WEB}/api/poker/house`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
      const answer = await response.json();
      if (answer.played || !answer.again || tries >= 5) return assert.deepEqual([answer.played, answer.what], [true, "join"], `the house did not take the seat: ${JSON.stringify(answer)}`);
      await sleep(1500);
    }
  };
  /// Reads the table until `ready` says so, without ever asking the house for anything.
  const until = async (id, what, ready, seconds) => {
    for (const stop = Date.now() + seconds * 1000; ; ) {
      const [table, result] = [await view("get_match", { id }), await view("get_result", { id })];
      if (ready(table, result)) return { table, result };
      assert.ok(Date.now() < stop, `after ${seconds} s: ${what}; the table is at ${table ? `${table.phase}, shuffled ${table.shuffled}, waiting for ${table.awaited}` : "settled"}`);
      await sleep(2000);
    }
  };
  const open = async (id, keys) => {
    await call("create_match", { id, stake: (10n ** 23n).toString(), key: toBase64(keyProof(keys, PLAYER)), turn_seconds: TURN_SECONDS }, DEPOSIT);
    await join(id);
  };
  const store = (id) => ({
    deck: async (hand, step) => {
      for (;;) {
        const deck = await view("get_deck", { id, hand, step });
        if (deck) return fromBase64(deck);
        await sleep(1000);
      }
    },
  });

  // 1 and 2.
  const id = `hc-${Date.now().toString(36)}`;
  const keys = newKeys();
  await open(id, keys);
  const mine = async (phase) => {
    const { table } = await until(id, `the table should reach ${phase} with this seat awaited`, (t) => t && t.phase === phase && t.awaited.includes(0), 60);
    const owed = phase === "bet" ? { method: "act", args: { id, seat: 0, action: "fold", amount: null } } : await duty(table, 0, keys, store(id));
    await call(owed.method, owed.args);
  };
  await mine("shuffle");
  console.log(`table ${id}: this seat shuffled and asks the house for nothing`);
  await mine("deal");
  console.log("  the house shuffled and dealt unasked");
  await mine("bet");
  const held = await until(id, "the next hand should wait for the house to deal", (t) => t && t.hand === 1 && t.phase === "shuffle", 30);
  assert.deepEqual([held.table.awaited, held.table.shuffled, held.table.chips], [[1], 0, [99, 101]]);
  await sleep(8000);
  assert.equal((await view("get_match", { id })).shuffled, 0, "the house must not deal before it is told to");
  console.log("  hand 2 is the house's to deal, and it waits to be told");
  const left = await until(id, "the house should leave a table nobody deals at", (_t, result) => result, TURN_SECONDS + 20);
  assert.deepEqual([left.result.reason, left.result.chips], ["left", [99, 101]]);
  console.log(`  nobody told it: the house left, and the table paid chips ${left.result.chips.join(" : ")}`);

  // 3.
  const idle = `hi-${Date.now().toString(36)}`;
  await open(idle, newKeys());
  const gone = await until(idle, "the house should leave a table whose player walked away", (_t, result) => result, TURN_SECONDS + 30);
  assert.deepEqual([gone.result.reason, gone.result.chips], ["left", [100, 100]]);
  console.log(`table ${idle}: the player never shuffled; the house left and both stakes went back\nall good`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
