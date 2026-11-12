// An opponent for a Deedlords Poker table on TESTNET: it takes the open seat of a table somebody opened on the page
// (`/poker`, "Open a table for a friend"), then plays its part of every hand and never folds: it checks or calls
// whatever is bet. For trying the page against another account. Refuses mainnet.
//
//   POKER_BOT=p2.deedlords.testnet node --experimental-strip-types poker-bot.js <table id>
//
// The account's key is read from the NEAR credentials directory, never printed. It stops when the match is settled.

"use strict";

const os = require("os");
const path = require("path");
const { connect, keyStores } = require("near-api-js");

const CONTRACT = process.env.POKER_CONTRACT ?? "poker.deedlords.testnet";
const BOT = process.env.POKER_BOT ?? "p2.deedlords.testnet";
const TGAS = 10n ** 12n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const id = process.argv[2];
  if (!id) throw new Error("give the table id");
  if (!BOT.endsWith(".testnet") || !CONTRACT.endsWith(".testnet")) throw new Error("this bot plays on testnet only");
  const { newKeys, keyProof } = await import("../../games/poker/crypto.ts");
  const { duty, toBase64, fromBase64 } = await import("../../games/poker/seat.ts");
  const keyStore = new keyStores.UnencryptedFileSystemKeyStore(process.env.NEAR_CREDENTIALS_DIR ?? path.join(os.homedir(), ".near-credentials"));
  const near = await connect({ networkId: "testnet", nodeUrl: process.env.POKER_RPC ?? "https://test.rpc.fastnear.com", keyStore });
  const account = await near.account(BOT);

  /// A read or a call, tried again when the public RPC is busy.
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
  const store = {
    deck: async (hand, step) => {
      for (;;) {
        const deck = await view("get_deck", { id, hand, step });
        if (deck) return fromBase64(deck);
        await sleep(1000);
      }
    },
  };

  let table = await view("get_match", { id });
  if (!table) throw new Error(`there is no open table ${id}`);
  const keys = newKeys();
  let seat = table.players.indexOf(BOT);
  if (table.phase === "lobby") {
    await call("join", { id, key: toBase64(keyProof(keys, BOT)) }, BigInt(table.deposit));
    seat = 1;
    console.log(`${BOT} took seat 2 of ${id}`);
  } else if (seat < 0) {
    throw new Error(`table ${id} is full`);
  } else {
    throw new Error(`${BOT} already sits at ${id}, with a card key this run does not have`);
  }

  let seq = table.seq + 1;
  for (;;) {
    table = await view("get_match", { id });
    if (!table) {
      const result = await view("get_result", { id });
      if (result) return console.log(`settled (${result.reason}): chips ${result.chips.join(" : ")}`);
    }
    // A public RPC may answer from a node a block behind: act only on a view at least as new as the last one acted on.
    if (!table || table.seq < seq || !table.awaited.includes(seat)) {
      await sleep(1500);
      continue;
    }
    if (table.phase === "bet") {
      await call("act", { id, seat, action: "call", amount: null });
      console.log(`hand ${table.hand + 1}: ${table.bet[1 - seat] > table.bet[seat] ? `calls ${table.bet[1 - seat] - table.bet[seat]}` : "checks"}`);
    } else {
      const owed = await duty(table, seat, keys, store);
      await call(owed.method, owed.args);
      console.log(`hand ${table.hand + 1}: ${owed.method}`);
    }
    seq = table.seq + 1;
  }
}

main().catch((e) => {
  console.error(String(e && (e.message || e)));
  process.exit(1);
});
