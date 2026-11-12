// A Deedlords Poker table of several seats on TESTNET with one account and the house: the account opens a table,
// the house's accounts take seats when asked (/api/poker/table/house), and the account's seat bets what the agent's
// desk advises (/api/poker/table/agent). It checks both routes of a running web server end to end: house seats join,
// shuffle with their proofs, give their shares and bet; the desk answers each of this seat's bets from the seat's own
// cards. A few hands, then the seat leaves and the house's seats follow it out. Refuses mainnet.
//
//   POKER_PLAYER=p1.deedlords.testnet node --experimental-strip-types poker-table-ai-run.js [model]
//
// `model`: one the server offers (GET /api/poker/table/agent), or nothing for the odds alone. POKER_WEB (default
// http://localhost:3000) is the web server; POKER_SEATS (default 4) the size of the table; POKER_HANDS (default 3).
// The account's key is read from the NEAR credentials directory, never printed.

"use strict";

const os = require("os");
const path = require("path");
const assert = require("assert/strict");
const { connect, keyStores } = require("near-api-js");

const CONTRACT = process.env.POKER_TABLE_CONTRACT ?? "pokertable.deedlords.testnet";
const PLAYER = process.env.POKER_PLAYER ?? "p1.deedlords.testnet";
const WEB = (process.env.POKER_WEB ?? "http://localhost:3000").replace(/\/$/, "");
const MODEL = process.argv[2] ?? "rules";
const SEATS = Number(process.env.POKER_SEATS ?? 4);
const HANDS = Number(process.env.POKER_HANDS ?? 3);
const TGAS = 10n ** 12n;
const DEPOSIT = 10n ** 23n + 2n * 10n ** 21n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CARD = (card) => "23456789TJQKA"[card % 13] + "cdhs"[Math.floor(card / 13)];
const gasFor = (method, args) => {
  const tokens = typeof args.tokens === "string" ? Math.round((args.tokens.length * 3) / 4 / 224) : 0;
  return (method === "shuffle" ? 260n : BigInt(Math.max(40, 30 + 7 * tokens))) * TGAS;
};

async function main() {
  if (!PLAYER.endsWith(".testnet") || !CONTRACT.endsWith(".testnet")) throw new Error("testnet only");
  const { newKeys, keyProof } = await import("../../games/poker/crypto.ts");
  const { duty, betCall, holeCards, toBase64, fromBase64 } = await import("../../games/poker/table/seat.ts");
  const keyStore = new keyStores.UnencryptedFileSystemKeyStore(process.env.NEAR_CREDENTIALS_DIR ?? path.join(os.homedir(), ".near-credentials"));
  const near = await connect({ networkId: "testnet", nodeUrl: process.env.POKER_RPC ?? "https://test.rpc.fastnear.com", keyStore });
  const account = await near.account(PLAYER);
  const patient = async (what) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await what();
      } catch (e) {
        if (attempt >= 9 || !/429|Rate limit|timeout|Timeout|ECONNRESET|fetch failed/.test(String(e && (e.message || e)))) throw e;
        await sleep(3000 * (attempt + 1));
      }
    }
  };
  const view = (method, args) => patient(() => account.viewFunction({ contractId: CONTRACT, methodName: method, args }));
  const call = (method, args, deposit = 0n) => patient(() => account.functionCall({ contractId: CONTRACT, methodName: method, args, gas: gasFor(method, args), attachedDeposit: deposit }));
  const post = async (route, body) => {
    const response = await fetch(`${WEB}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, ...(await response.json()) };
  };

  const offered = await (await fetch(`${WEB}/api/poker/table/house`)).json();
  assert.ok(offered.houses?.length, "this server plays no house");
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
  await call("create_match", { id, stake: (10n ** 23n).toString(), key: toBase64(keyProof(keys, PLAYER)), seats: SEATS, turn_seconds: 300 }, DEPOSIT);
  // House seats are asked for one at a time until the table is full or the house has no account left to seat.
  let housed = 0;
  for (let tries = 0; housed < SEATS - 1 && tries < 30; tries++) {
    const joined = await post("/api/poker/table/house", { id, add: true });
    if (joined.played) housed += 1;
    else if (joined.again || /not on chain yet/.test(joined.why ?? "")) await sleep(1500);
    else {
      console.log(`  the house takes no more seats: ${joined.why}`);
      break;
    }
    // The next seat is asked for once this one shows on the table.
    for (let waits = 0; waits < 20 && ((await view("get_match", { id }))?.players.filter(Boolean).length ?? 0) < housed + 1; waits++) await sleep(1000);
  }
  assert.ok(housed >= 1, "no house seat was taken");
  let table = await view("get_match", { id });
  if (table.phase === "lobby") await call("start", { id });
  console.log(`table ${id}: ${SEATS} seats; ${PLAYER} (bets by ${MODEL === "rules" ? "the odds alone" : MODEL}) and ${housed} house seat(s) of ${offered.houses.join(", ")} (${offered.model ?? "the odds alone"})`);

  let seq = 0;
  let shownFor = -1;
  let leaving = false;
  const started = Date.now();
  for (;;) {
    table = await view("get_match", { id });
    if (!table) {
      if (await view("get_result", { id })) break;
      await sleep(1200);
      continue;
    }
    if (table.seq < seq) {
      await sleep(1200);
      continue;
    }
    const seat = table.players.indexOf(PLAYER);
    if (table.last && table.last.number > shownFor) {
      shownFor = table.last.number;
      const { board, hole, ending, won, put } = table.last;
      const shown = hole.map((cards, at) => (cards.length ? `seat ${at} ${cards.map(CARD).join(" ")}` : null)).filter(Boolean).join(", ");
      console.log(`  hand ${shownFor + 1} over (${ending}) after ${((Date.now() - started) / 1000).toFixed(0)} s: put in ${put.join(" ")}; won ${won.join(" ")}; board ${board.map(CARD).join(" ") || "not reached"}${shown ? `; ${shown}` : ""}; chips ${table.chips.join(" ")}`);
      assert.notEqual(ending, "cancelled", "nobody ran out of time here");
    }
    if (seat < 0) {
      // This seat was paid and given up: the house's seats finish the hand and follow it out.
      await post("/api/poker/table/house", { id });
      await sleep(1500);
      continue;
    }
    // After the hands asked for, the seat asks to leave: it is paid when the hand it is in is over.
    if (table.hand >= HANDS && !leaving) {
      leaving = true;
      await call("leave", { id });
      continue;
    }
    if (table.awaited.includes(seat)) {
      if (table.phase === "bet") {
        const hole = holeCards(table, seat, keys, await store.deck(table.hand, table.dealt.length - 1));
        const advice = await post("/api/poker/table/agent", { id, seat, hole, model: MODEL, style: "Play tight and aggressive. Fold weak hands to big bets." });
        assert.equal(advice.status, 200, `the desk refused: ${JSON.stringify(advice)}`);
        assert.ok(["fold", "call", "raise"].includes(advice.action));
        const sent = await betCall(table, seat, advice.action, advice.amount, keys, store);
        await call(sent.method, sent.args);
        console.log(`  seat ${seat} holds ${hole.map(CARD).join(" ")}, ${advice.action}${advice.amount ? ` to ${advice.amount}` : ""} (${advice.driver}${advice.fallback ? `, because ${advice.problem}` : ""}): ${advice.reason}`);
      } else {
        const owed = await duty(table, seat, keys, store);
        await call(owed.method, owed.args);
      }
      seq = table.seq + 1;
      continue;
    }
    // The table waits for a house seat: ask for its step, as a tab that has the table open does.
    const step = await post("/api/poker/table/house", { id });
    if (step.played) {
      if (step.reason) console.log(`  the house, seat ${step.seat}: ${step.what} (${step.driver}): ${step.reason}`);
    } else await sleep(1500);
  }
  const result = await view("get_result", { id });
  assert.equal(result.cashed.reduce((sum, cashed) => sum + cashed.chips, 0), 100 * (housed + 1), "every chip was paid out");
  console.log(`settled after ${result.hands} hands: ${result.cashed.map((cashed) => `${cashed.account.split(".")[0]} ${cashed.chips}`).join(", ")}\nall good`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
