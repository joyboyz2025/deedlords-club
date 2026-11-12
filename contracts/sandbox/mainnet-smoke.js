// node --experimental-strip-types mainnet-smoke.js plan | rehearse | run --yes
//
// Plays both games of Deedlords Club once, with real NEAR, on the contracts `mainnet.js` put on mainnet:
//   * Deedlords: a 2-seat match of 3 rounds, 0.05 NEAR a seat, both seats played by plan (`turn`) to settlement;
//     checks that the pot was paid in full (the fee is 0).
//   * Poker: a 2-seat table, 0.1 NEAR a seat, one hand played to the showdown by both seats with the page's own code
//     (shuffles proved, shares proved, both seats check or call), then seat 1 leaves and the table settles; checks that
//     the chips paid out add up to the chips bought.
// Two player accounts play, `p1.<parent>` and `p2.<parent>`: created and funded by the parent when missing (0.6 NEAR
// each), their keys written to ~/.near-credentials/<network>/ first. What is left on them stays theirs.
//
//   plan        reads mainnet and prints what it would do and what it costs. Signs nothing.
//   rehearse    the very same play on a LOCAL near-sandbox (the contracts deployed there first). Spends nothing real.
//   run --yes   on mainnet, signed with the parent's key (to fund p1 and p2) and theirs. Only the owner runs this.
//
// Environment: DEEDLORDS_PARENT (default deedlords.near), NEAR_RPC.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert/strict");
const { connect, keyStores, KeyPair, transactions } = require("near-api-js");

const Y = 10n ** 24n;
const NEAR = (n) => (BigInt(Math.round(n * 1e6)) * Y) / 1_000_000n;
const TGAS = 10n ** 12n;
const fmt = (yocto) => `${(Number(BigInt(yocto) / 10n ** 18n) / 1e6).toFixed(4)} NEAR`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const PLAYER_FUND = NEAR(0.6);
const BOARD_STAKE = NEAR(0.05);
const POKER_STAKE = NEAR(0.1);
const POKER_RECORD_FEE = 2n * 10n ** 21n;
const MOVE_GAS = 100n * TGAS;
const PLAN = { buy_reserve: 200, build: [], keep_reserve: 200, bail: true, liquidate: [] };
const pokerGas = (method, args) => {
  const tokens = typeof args.tokens === "string" ? Math.round((args.tokens.length * 3) / 4 / 224) : 0;
  return (method === "shuffle" ? 260n : BigInt(Math.max(40, 30 + 7 * tokens))) * TGAS;
};

let NETWORK = "mainnet";
let PARENT = process.env.DEEDLORDS_PARENT ?? "deedlords.near";
let RPC = process.env.NEAR_RPC ?? "https://free.rpc.fastnear.com";

/** A call or a view, tried again while the public RPC is busy; a resent move the contract refuses means the first landed. */
async function patient(what, resent = /not this seat's turn|not now: the hand is at another step|the table moved on since this bet was chosen|it is not this seat's turn/) {
  let unanswered = false;
  for (let attempt = 0; ; attempt++) {
    try {
      return await what();
    } catch (error) {
      const text = String(error && (error.message || error));
      if (unanswered && resent.test(text)) return null;
      if (attempt >= 8 || !/429|408|Rate limit|timeout|Timeout|ECONNRESET|fetch failed|TooManyRequests/.test(text)) throw error;
      unanswered = !/429|Rate limit|TooManyRequests/.test(text);
      await sleep(2500 * (attempt + 1));
    }
  }
}

const balanceOf = async (account) => BigInt((await patient(() => account.getAccountBalance())).available);

// ----- Deedlords: one match of two seats, by plan, to settlement --------------------------------------------------

async function playBoard(game, [p1, p2]) {
  const { openDuelCalls, joinCalls } = await import("../../games/co-ty-phu/chain/calls.ts");
  const id = `smoke-${Date.now().toString(36)}`;
  const send = (account, calls) =>
    patient(() =>
      account.signAndSendTransaction({ receiverId: game, actions: calls.map((call) => transactions.functionCall(call.method, Buffer.from(call.args), call.gas, call.deposit)) }),
    );
  const before = [await balanceOf(p1), await balanceOf(p2)];
  await send(p1, openDuelCalls(id, { stake: BOARD_STAKE, maxRounds: 3, turnSeconds: 120 }));
  await send(p2, joinCalls(id, 1, BOARD_STAKE));
  console.log(`  Deedlords: ${id} opened by ${p1.accountId}, joined by ${p2.accountId}`);
  const view = (method, args) => patient(() => p1.viewFunction({ contractId: game, methodName: method, args }));
  let turns = 0;
  for (let i = 0; i < 400; i++) {
    const match = await view("get_match", { id });
    if (!match) break;
    if (match.meta.status !== "playing") {
      await sleep(1500);
      continue;
    }
    const seat = match.meta.current_seat;
    const who = match.meta.seats[seat].backer === p1.accountId ? p1 : p2;
    await patient(() => who.functionCall({ contractId: game, methodName: "turn", args: { id, seat, plan: PLAN }, gas: MOVE_GAS }));
    turns += 1;
  }
  let result = null;
  for (let i = 0; i < 20 && !result; i++) result = (await view("get_result", { id })) ?? (await sleep(1500), null);
  assert.ok(result, "the match settled");
  const paid = result.payouts.reduce((sum, amount) => sum + BigInt(amount), 0n);
  assert.equal(result.fee, "0", "no fee is taken");
  assert.equal(paid, 2n * BOARD_STAKE, "the whole pot was paid out");
  const after = [await balanceOf(p1), await balanceOf(p2)];
  console.log(`  Deedlords: settled after ${turns} turns (${result.reason}); paid ${result.payouts.map(fmt).join(" and ")}, fee 0`);
  console.log(`  Deedlords: balances ${after.map((now, i) => `${fmt(before[i])} -> ${fmt(now)}`).join(", ")}`);
  return id;
}

// ----- Poker: one table of two seats, one hand to the showdown, then a seat leaves --------------------------------

async function playPoker(poker, [p1, p2]) {
  const { newKeys, keyProof } = await import("../../games/poker/crypto.ts");
  const { duty, betCall, toBase64, fromBase64 } = await import("../../games/poker/table/seat.ts");
  const id = `smoke-${Date.now().toString(36)}`;
  const view = (method, args) => patient(() => p1.viewFunction({ contractId: poker, methodName: method, args }));
  const store = {
    deck: async (hand, step) => {
      for (;;) {
        const deck = await view("get_deck", { id, hand, step });
        if (deck) return fromBase64(deck);
        await sleep(1000);
      }
    },
  };
  const seats = [p1, p2].map((account) => ({ account, keys: newKeys() }));
  const deposit = POKER_STAKE + POKER_RECORD_FEE;
  const before = [await balanceOf(p1), await balanceOf(p2)];
  await patient(() =>
    p1.functionCall({ contractId: poker, methodName: "create_match", args: { id, stake: POKER_STAKE.toString(), key: toBase64(keyProof(seats[0].keys, p1.accountId)), seats: 2, turn_seconds: 300 }, gas: 60n * TGAS, attachedDeposit: deposit }),
  );
  await patient(() => p2.functionCall({ contractId: poker, methodName: "join", args: { id, key: toBase64(keyProof(seats[1].keys, p2.accountId)) }, gas: 60n * TGAS, attachedDeposit: deposit }));
  console.log(`  Poker: table ${id} opened by ${p1.accountId}, joined by ${p2.accountId}`);

  const played = ["", ""];
  let seq = 0;
  let left = false;
  for (let i = 0; i < 600; i++) {
    const table = await view("get_match", { id });
    if (!table) break;
    if (table.seq < seq) {
      await sleep(1000);
      continue;
    }
    // One hand played: seat 1 stands up between hands, and with one seat left the table settles.
    if (table.hand >= 1 && table.phase === "shuffle" && table.shuffled === 0 && !left) {
      left = true;
      await patient(() => p1.functionCall({ contractId: poker, methodName: "leave", args: { id }, gas: 60n * TGAS }));
      console.log(`  Poker: hand 1 over (${table.last?.ending}), ${p1.accountId} leaves`);
      continue;
    }
    const step = `${table.hand}:${table.phase}:${table.street}:${table.shuffled}:${table.bets}`;
    let moved = false;
    for (const [seat, { account, keys }] of seats.entries()) {
      if (!table.awaited.includes(seat) || played[seat] === step) continue;
      const call = table.phase === "bet" ? await betCall(table, seat, "call", undefined, keys, store) : await duty(table, seat, keys, store);
      if (!call) continue;
      await patient(() => account.functionCall({ contractId: poker, methodName: call.method, args: call.args, gas: pokerGas(call.method, call.args) }));
      played[seat] = step;
      moved = true;
      console.log(`  Poker: seat ${seat + 1} ${call.method === "act" ? call.args.action : call.method}`);
      break;
    }
    if (moved) seq = table.seq + 1;
    else await sleep(1000);
  }
  let result = null;
  for (let i = 0; i < 20 && !result; i++) result = (await view("get_result", { id })) ?? (await sleep(1500), null);
  assert.ok(result, "the table settled");
  const chips = result.cashed.reduce((sum, cashed) => sum + cashed.chips, 0);
  assert.equal(chips, 200, "every chip bought was paid out");
  const after = [await balanceOf(p1), await balanceOf(p2)];
  console.log(`  Poker: settled after ${result.hands} hand(s): ${result.cashed.map((cashed) => `${cashed.account} ${cashed.chips} chips (${fmt(cashed.payout)})`).join(", ")}`);
  console.log(`  Poker: balances ${after.map((now, i) => `${fmt(before[i])} -> ${fmt(now)}`).join(", ")}`);
  return id;
}

// ----- The players, then both games --------------------------------------------------------------------------------

async function players(near, keyStore, parent, fund) {
  const out = [];
  for (const name of ["p1", "p2"]) {
    const id = `${name}.${PARENT}`;
    let exists = true;
    try {
      await (await near.account(id)).state();
    } catch {
      exists = false;
    }
    if (!exists) {
      if (!fund) throw new Error(`${id} does not exist`);
      let key = await keyStore.getKey(NETWORK, id);
      if (!key) {
        key = KeyPair.fromRandom("ed25519");
        await keyStore.setKey(NETWORK, id, key); // stored before the account exists
      }
      const done = await parent.createAccount(id, key.getPublicKey(), PLAYER_FUND);
      console.log(`  created ${id} with ${fmt(PLAYER_FUND)}: tx ${done.transaction.hash}`);
      for (let i = 0; i < 20; i++) {
        try {
          await (await near.account(id)).state();
          break;
        } catch {
          await sleep(500);
        }
      }
    } else if (!(await keyStore.getKey(NETWORK, id))) throw new Error(`${id} exists but its key is not in the credentials directory`);
    out.push(await near.account(id));
  }
  return out;
}

async function both(near, keyStore, parent) {
  const game = `game.${PARENT}`;
  const poker = `poker.${PARENT}`;
  const ps = await players(near, keyStore, parent, true);
  const board = await playBoard(game, ps);
  const table = await playPoker(poker, ps);
  return { board, table, players: ps.map((p) => p.accountId) };
}

async function rehearse() {
  const { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } = require("near-sandbox");
  console.log("booting a local near-sandbox...");
  const sandbox = await Sandbox.start({});
  try {
    NETWORK = "sandbox";
    RPC = sandbox.rpcUrl;
    PARENT = `club.${DEFAULT_ACCOUNT_ID}`;
    const keyStore = new keyStores.InMemoryKeyStore();
    await keyStore.setKey("sandbox", DEFAULT_ACCOUNT_ID, KeyPair.fromString(DEFAULT_PRIVATE_KEY));
    const near = await connect({ networkId: "sandbox", nodeUrl: RPC, keyStore });
    const root = await near.account(DEFAULT_ACCOUNT_ID);
    const make = async (id, amount) => {
      const key = KeyPair.fromRandom("ed25519");
      await keyStore.setKey("sandbox", id, key);
      await root.createAccount(id, key.getPublicKey(), amount);
      return near.account(id);
    };
    // What mainnet.js puts on mainnet, put here the same way.
    const parent = await make(PARENT, NEAR(30));
    const parentAccount = await near.account(PARENT);
    const deploy = async (id, wasm, init) => {
      const key = KeyPair.fromRandom("ed25519");
      await keyStore.setKey("sandbox", id, key);
      await parentAccount.createAccount(id, key.getPublicKey(), NEAR(6));
      await (await near.account(id)).signAndSendTransaction({ receiverId: id, actions: [transactions.deployContract(fs.readFileSync(wasm)), transactions.functionCall("new", init, 100n * TGAS, 0n)] });
    };
    await deploy(`game.${PARENT}`, path.join(__dirname, "../target/wasm32-unknown-unknown/release/deedlords.wasm"), { owner: PARENT, house: `house.${PARENT}`, max_stake: Y.toString(), fee_bps: 0 });
    await deploy(`poker.${PARENT}`, path.join(__dirname, "../poker-table/target/wasm32-unknown-unknown/release/deedlords_poker_table.wasm"), { owner: PARENT, fee_bps: 0 });
    void parent;
    const out = await both(near, keyStore, parentAccount);
    console.log(`REHEARSAL PASSED: both games played to settlement on the sandbox (${out.board}, ${out.table})`);
  } finally {
    sandbox.childProcess.kill("SIGKILL");
    await sleep(500);
    await fs.promises.rm(sandbox.homeDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  const mode = process.argv[2];
  if (mode === "rehearse") return rehearse();
  if (mode !== "plan" && mode !== "run") return console.log("usage: node --experimental-strip-types mainnet-smoke.js plan | rehearse | run --yes");
  if (mode === "run" && !process.argv.includes("--yes")) throw new Error("run spends real NEAR: add --yes once the plan reads right");
  if (!PARENT.endsWith(".near")) throw new Error(`${PARENT} is not a mainnet account`);
  const keyStore = new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), ".near-credentials"));
  const near = await connect({ networkId: "mainnet", nodeUrl: RPC, keyStore, headers: { "user-agent": "deedlords-smoke/0.1" } });
  const status = await near.connection.provider.status();
  if (status.chain_id !== "mainnet") throw new Error(`${RPC} is ${status.chain_id}, not mainnet`);
  const state = async (id) => {
    try {
      return await (await near.account(id)).state();
    } catch {
      return null;
    }
  };
  const [parentState, gameState, pokerState, p1State, p2State] = await Promise.all([PARENT, `game.${PARENT}`, `poker.${PARENT}`, `p1.${PARENT}`, `p2.${PARENT}`].map(state));
  console.log(`NEAR MAINNET via ${RPC}`);
  console.log(`parent ${PARENT}: ${parentState ? fmt(parentState.amount) : "DOES NOT EXIST"}; key ${(await keyStore.getKey("mainnet", PARENT)) ? "found" : "MISSING"}`);
  console.log(`game.${PARENT}: ${gameState?.code_hash && gameState.code_hash !== "11111111111111111111111111111111" ? "deployed" : "NOT DEPLOYED: run mainnet.js first"}`);
  console.log(`poker.${PARENT}: ${pokerState?.code_hash && pokerState.code_hash !== "11111111111111111111111111111111" ? "deployed" : "NOT DEPLOYED: run mainnet.js first"}`);
  for (const [name, s] of [["p1", p1State], ["p2", p2State]]) console.log(`${name}.${PARENT}: ${s ? fmt(s.amount) : `to create with ${fmt(PLAYER_FUND)} from the parent`}`);
  console.log(`\nIt plays: one Deedlords match (2 seats, 3 rounds, ${fmt(BOARD_STAKE)} a seat) and one poker hand (2 seats, ${fmt(POKER_STAKE)} a seat).`);
  console.log(`Gas burnt, all told: about 0.15 NEAR (a poker shuffle is about 0.02). Stakes come back to p1 and p2 as the games pay out.`);
  if (mode === "plan") return;
  const parent = await near.account(PARENT);
  const out = await both(near, keyStore, parent);
  console.log(`\nALL GOOD ON MAINNET: Deedlords ${out.board}, poker ${out.table}`);
  console.log(`  https://nearblocks.io/address/game.${PARENT}\n  https://nearblocks.io/address/poker.${PARENT}`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
