// A seat for a Deedlords Poker table of several seats on TESTNET, for trying the page (`/poker/tables`) against
// another account: it sits down at a table somebody opened, or opens one itself, then plays its part of every hand
// and never folds: it checks or calls whatever is bet. Refuses mainnet.
//
//   POKER_BOT=p2.deedlords.testnet node --experimental-strip-types poker-table-bot.js <table id> [--stop-at=<phase>]
//   POKER_BOT=p2.deedlords.testnet node --experimental-strip-types poker-table-bot.js --open=<seats> [--clock=<seconds>]
//
// `--clock`: the seconds each step of a table it opens may take (300 when not given; at least 5).
// `--stop-at=deal|bet|open|showdown`: from the first time the table waits for it in that phase it answers nothing
// more, so that the page's "call time" can be tried. The account's key is read from the NEAR credentials directory,
// never printed. It stops when its seat is given up or the table is settled.

"use strict";

const os = require("os");
const path = require("path");
const { connect, keyStores } = require("near-api-js");

const CONTRACT = process.env.POKER_TABLE_CONTRACT ?? "pokertable.deedlords.testnet";
const BOT = process.env.POKER_BOT ?? "p2.deedlords.testnet";
const TGAS = 10n ** 12n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const option = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
const gasFor = (method, args) => {
  const tokens = typeof args.tokens === "string" ? Math.round((args.tokens.length * 3) / 4 / 224) : 0;
  return (method === "shuffle" ? 260n : BigInt(Math.max(40, 30 + 7 * tokens))) * TGAS;
};

async function main() {
  if (!BOT.endsWith(".testnet") || !CONTRACT.endsWith(".testnet")) throw new Error("this bot plays on testnet only");
  const [open, stopAt] = [option("open"), option("stop-at")];
  let id = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  if (!id && !open) throw new Error("give the table id, or --open=<seats>");
  const { newKeys, keyProof } = await import("../../games/poker/crypto.ts");
  const { duty, betCall, toBase64, fromBase64 } = await import("../../games/poker/table/seat.ts");
  const keyStore = new keyStores.UnencryptedFileSystemKeyStore(process.env.NEAR_CREDENTIALS_DIR ?? path.join(os.homedir(), ".near-credentials"));
  const near = await connect({ networkId: "testnet", nodeUrl: process.env.POKER_RPC ?? "https://test.rpc.fastnear.com", keyStore });
  const account = await near.account(BOT);

  /// A read or a call, tried again when the public RPC is busy.
  /// A public RPC may answer 408 or time out for a transaction that did reach the chain. Sent again, the contract then
  /// refuses it as out of turn: that refusal, after an unanswered send, means the first one landed.
  const patient = async (what) => {
    let unanswered = false;
    for (let attempt = 0; ; attempt++) {
      try {
        return await what();
      } catch (e) {
        const text = String(e && (e.message || e));
        if (unanswered && /not this seat's turn|not now: the hand is at another step/.test(text)) return null;
        if (attempt >= 9 || !/429|408|Rate limit|timeout|Timeout|ECONNRESET|fetch failed/.test(text)) throw e;
        unanswered = !/429|Rate limit/.test(text);
        await sleep(3000 * (attempt + 1));
      }
    }
  };
  const view = (method, args) => patient(() => account.viewFunction({ contractId: CONTRACT, methodName: method, args }));
  const call = (method, args, deposit = 0n) => patient(() => account.functionCall({ contractId: CONTRACT, methodName: method, args, gas: gasFor(method, args), attachedDeposit: deposit }));
  const store = {
    deck: async (hand, step) => {
      for (;;) {
        const deck = await view("get_deck", { id, hand, step });
        if (deck) return fromBase64(deck);
        await sleep(1000);
      }
    },
  };

  const keys = newKeys();
  const key = toBase64(keyProof(keys, BOT));
  if (open) {
    id = `b-${Date.now().toString(36)}`;
    await call("create_match", { id, stake: (10n ** 23n).toString(), key, seats: Number(open), turn_seconds: Number(option("clock") ?? 300) }, 10n ** 23n + 2n * 10n ** 21n);
    console.log(`${BOT} opened table ${id} for ${open} seats and waits in seat 1`);
  } else {
    const table = await view("get_match", { id });
    if (!table) throw new Error(`there is no open table ${id}`);
    if (table.players.includes(BOT)) throw new Error(`${BOT} already sits at ${id}, with a card key this run does not have`);
    await call("join", { id, key }, BigInt(table.deposit));
    console.log(`${BOT} sat down at ${id}`);
  }

  // A public RPC answers from several nodes, some a block or two behind. A view newer than the one the bot acted on
  // can still be older than the bot's own move (another seat moved too), so the bot also remembers the step it played
  // and never plays the same step twice. A refusal from the contract changed nothing: the bot reads again.
  let [seq, stopped, sat, played] = [0, false, false, ""];
  const stepOf = (table) => `${table.hand}:${table.phase}:${table.street}:${table.shuffled}:${table.bets}`;
  const refusal = /not this seat's turn|not now: the hand is at another step|the table moved on since this bet was chosen/;
  for (;;) {
    const table = await view("get_match", { id });
    if (!table) {
      const result = await view("get_result", { id });
      if (result) return console.log(`settled: ${result.cashed.map((cashed) => `${cashed.account.split(".")[0].slice(0, 12)} ${cashed.chips}`).join(", ")}`);
      await sleep(1500);
      continue;
    }
    const seat = table.players.indexOf(BOT);
    if (seat < 0) {
      // A node a block behind may not show the seat yet; once it has been seen, its absence means it was given up.
      if (sat) return console.log(`${BOT} was paid ${table.cashed.findLast((cashed) => cashed.account === BOT)?.chips ?? "its"} chips and left the table`);
      await sleep(1500);
      continue;
    }
    sat = true;
    // A public RPC may answer from a node a block behind: act only on a view at least as new as the last one acted on.
    if (stopped || table.seq < seq || !table.awaited.includes(seat) || stepOf(table) === played) {
      await sleep(1500);
      continue;
    }
    if (stopAt && table.phase === stopAt) {
      stopped = true;
      console.log(`hand ${table.hand + 1}: awaited in ${stopAt}, and answering nothing from here on`);
      continue;
    }
    try {
      if (table.phase === "bet") {
        const owed = Math.max(...table.bet) - table.bet[seat];
        const sent = await betCall(table, seat, "call", undefined, keys, store);
        await call(sent.method, sent.args);
        console.log(`hand ${table.hand + 1}: ${owed > 0 ? `calls ${Math.min(owed, table.chips[seat])}` : "checks"}`);
      } else {
        const owed = await duty(table, seat, keys, store);
        await call(owed.method, owed.args);
        console.log(`hand ${table.hand + 1}: ${owed.method}`);
      }
    } catch (e) {
      if (!refusal.test(String(e && (e.message || e)))) throw e;
      console.log(`hand ${table.hand + 1}: refused (${String(e.message || e).match(refusal)[0]}); reading the table again`);
    }
    played = stepOf(table);
    seq = table.seq + 1;
  }
}

main().catch((e) => {
  console.error(String(e && (e.message || e)));
  process.exit(1);
});
