// Deedlords Poker on TESTNET with nobody at the table: one account plays seat 1 with the bets the agent's desk
// advises (/api/poker/agent), against the house the server plays (/api/poker/house). It checks both routes of a
// running web server end to end: the house joins, shuffles with its proof, shares and bets; the desk answers each of
// this seat's bets from the seat's own cards. Two hands, then the seat leaves. Refuses mainnet.
//
//   POKER_PLAYER=p1.deedlords.testnet node --experimental-strip-types poker-ai-run.js [model]
//
// `model`: one the server offers (GET /api/poker/agent), or nothing for the odds alone. POKER_WEB (default
// http://localhost:3000) is the web server. The account's key is read from the NEAR credentials directory.

"use strict";

const os = require("os");
const path = require("path");
const assert = require("assert/strict");
const { connect, keyStores } = require("near-api-js");

const CONTRACT = process.env.POKER_CONTRACT ?? "poker.deedlords.testnet";
const PLAYER = process.env.POKER_PLAYER ?? "p1.deedlords.testnet";
const WEB = (process.env.POKER_WEB ?? "http://localhost:3000").replace(/\/$/, "");
const MODEL = process.argv[2] ?? "rules";
const TGAS = 10n ** 12n;
const DEPOSIT = 10n ** 23n + 2n * 10n ** 21n;
const HANDS = 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CARD = (card) => "23456789TJQKA"[card % 13] + "cdhs"[Math.floor(card / 13)];

async function main() {
  if (!PLAYER.endsWith(".testnet") || !CONTRACT.endsWith(".testnet")) throw new Error("testnet only");
  const { newKeys, keyProof } = await import("../../games/poker/crypto.ts");
  const { duty, holeCards, toBase64, fromBase64 } = await import("../../games/poker/seat.ts");
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
  const post = async (route, body) => {
    const response = await fetch(`${WEB}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, ...(await response.json()) };
  };

  const offered = await (await fetch(`${WEB}/api/poker/house`)).json();
  assert.ok(offered.house, "this server plays no house");
  const id = `ai-${Date.now().toString(36)}`;
  const keys = newKeys();
  const store = {
    deck: async (hand, step) => {
      for (;;) {
        const deck = await view("get_deck", { id, hand, step });
        if (deck) return fromBase64(deck);
        await sleep(1000);
      }
    },
  };
  await call("create_match", { id, stake: (10n ** 23n).toString(), key: toBase64(keyProof(keys, PLAYER)), turn_seconds: 300 }, DEPOSIT);
  let joined = await post("/api/poker/house", { id });
  // A table opened a moment ago may not have reached the node the server read from.
  for (let tries = 0; !joined.played && joined.again && tries < 5; tries++) {
    await sleep(1500);
    joined = await post("/api/poker/house", { id });
  }
  assert.deepEqual([joined.played, joined.what], [true, "join"], `the house did not take the seat: ${JSON.stringify(joined)}`);
  console.log(`table ${id}: ${PLAYER} (bets by ${MODEL === "rules" ? "the odds alone" : MODEL}) against the house ${offered.house} (${offered.model ?? "the odds alone"})`);

  let seq = 2;
  let shownFor = -1;
  for (;;) {
    const table = await view("get_match", { id });
    if (!table || table.seq < seq) {
      await sleep(1200);
      continue;
    }
    if (table.last && table.last.number > shownFor) {
      shownFor = table.last.number;
      const { board, hole, outcome, pot } = table.last;
      console.log(`  hand ${shownFor + 1} over: ${outcome === "split" ? "split" : `seat ${outcome.won + 1} wins`} ${pot}; board ${board.map(CARD).join(" ") || "not reached"}${hole[0].length ? `; ${hole.map((h) => h.map(CARD).join(" ")).join(" against ")}` : ""}; chips ${table.chips.join(" : ")}`);
    }
    if (table.hand >= HANDS && table.phase === "shuffle" && table.shuffled === 0) break;
    if (table.awaited.includes(0)) {
      if (table.phase === "bet") {
        const hole = holeCards(table, 0, keys, await store.deck(table.hand, 1));
        const advice = await post("/api/poker/agent", { id, seat: 0, hole, model: MODEL, style: "Play tight and aggressive. Fold weak hands to big bets." });
        assert.equal(advice.status, 200, `the desk refused: ${JSON.stringify(advice)}`);
        assert.ok(["fold", "call", "raise"].includes(advice.action));
        await call("act", { id, seat: 0, action: advice.action, amount: advice.amount ?? null });
        console.log(`  seat 1 holds ${hole.map(CARD).join(" ")}, ${advice.action}${advice.amount ? ` to ${advice.amount}` : ""} (${advice.driver}${advice.fallback ? `, because ${advice.problem}` : ""}): ${advice.reason}`);
      } else {
        const owed = await duty(table, 0, keys, store);
        await call(owed.method, owed.args);
      }
      seq = table.seq + 1;
      continue;
    }
    // Between hands the house waits to be told to deal.
    const step = await post("/api/poker/house", { id, deal: table.phase === "shuffle" && table.shuffled === 0 });
    if (step.played) {
      seq = table.seq + 1;
      if (step.reason) console.log(`  the house: ${step.what} (${step.driver}): ${step.reason}`);
    } else await sleep(1500);
  }
  await call("leave", { id });
  for (let tries = 0; tries < 20; tries++) {
    const result = await view("get_result", { id });
    if (result) return console.log(`settled (${result.reason}) after ${result.hands} hands: chips ${result.chips.join(" : ")}\nall good`);
    await sleep(1000);
  }
  throw new Error("the table was not settled");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
