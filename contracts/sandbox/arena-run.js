// Deedlords Arena: deploy the contract and play one whole match, both seats driven by the rule bot.
//
//   node --experimental-strip-types arena-run.js                      local near-sandbox (never leaves this machine)
//   ARENA_PARENT=<you>.testnet node --experimental-strip-types arena-run.js testnet
//
// On testnet it creates arena.<parent> (skipped if it exists), deploys the wasm, calls new(), and plays a match
// between p1.<parent> and p2.<parent>. Keys are read from the NEAR credentials directory, never printed. Refuses
// mainnet. After every round the match on chain is compared with the TypeScript engine given the same plans: the two
// must be equal.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const assert = require("assert/strict");
const { connect, keyStores, KeyPair } = require("near-api-js");

const Y = 10n ** 24n;
const NEAR = (n) => (BigInt(Math.round(n * 1000)) * Y) / 1000n;
const fmt = (yocto) => `${(Number(BigInt(yocto) / 10n ** 18n) / 1e6).toFixed(4)} NEAR`;
const GAS = 100n * 10n ** 12n;
const FEE_BPS = 250;
const WASM = process.env.ARENA_WASM ?? path.join(__dirname, "../target/wasm32-unknown-unknown/release/deedlords_arena.wasm");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// Sends a call; on testnet a free public RPC sometimes answers 429 or times out, so it is retried a few times.
async function call(account, contractId, methodName, args, deposit = 0n) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await account.functionCall({ contractId, methodName, args, gas: GAS, attachedDeposit: deposit });
    } catch (e) {
      const text = String(e && (e.message || e));
      if (attempt >= 4 || !/429|timeout|Timeout|ECONNRESET|fetch failed|Exceeded/.test(text)) throw e;
      await sleep(1500 * (attempt + 1));
    }
  }
}

async function playMatch({ contractId, seats, stake, rounds, explorer }) {
  const { planFor } = await import("../../games/arena/agent/bot.ts");
  const { resolveRound } = await import("../../games/arena/engine.ts");
  const id = `a-${Date.now().toString(36)}`;
  const view = (method, args) => seats[0].viewFunction({ contractId, methodName: method, args });
  const link = (outcome) => (explorer ? `${explorer}/txns/${outcome.transaction.hash}` : outcome.transaction.hash);
  const books = [{ overbid: 1, reserve: 0, guild: -1, role: -1 }, { overbid: 2, reserve: 5, guild: 3, role: -1 }];

  console.log(`match ${id}: ${seats[0].accountId} against ${seats[1].accountId}, stake ${fmt(stake)}, ${rounds} rounds`);
  console.log(`  create_match  ${link(await call(seats[0], contractId, "create_match", { id, rounds, stake: stake.toString() }, stake))}`);
  console.log(`  join          ${link(await call(seats[1], contractId, "join", { id }, stake))}`);

  for (;;) {
    const before = (await view("get_match", { id })).game;
    const plans = [0, 1].map((seat) => planFor(before, seat, books[seat]));
    const sealed = plans.map((plan) => ({ text: JSON.stringify(plan), salt: crypto.randomBytes(16).toString("hex") }));
    const hash = ({ text, salt }) => crypto.createHash("sha256").update(`${text}|${salt}`).digest("hex");
    for (const seat of [0, 1]) await call(seats[seat], contractId, "commit", { id, seat, hash: hash(sealed[seat]) });
    await call(seats[0], contractId, "reveal", { id, seat: 0, plan: sealed[0].text, salt: sealed[0].salt });
    const last = await call(seats[1], contractId, "reveal", { id, seat: 1, plan: sealed[1].text, salt: sealed[1].salt });
    const round = last.receipts_outcome.flatMap((r) => r.outcome.logs).filter((log) => log.startsWith("EVENT_JSON:")).map((log) => JSON.parse(log.slice(11))).find((event) => event.event === "round");
    assert.ok(round, "the second reveal plays the round");
    // The chain drew the next market; given it, the TypeScript engine must reach the same match.
    const expected = resolveRound(before, plans, round.data.next.market);
    assert.deepEqual(round.data.result, expected.last, `round ${before.round}: the contract and the TypeScript engine differ`);
    const { winner, survivors } = round.data.result;
    console.log(`  round ${before.round}: ${winner === 2 ? "draw" : `seat ${winner} wins with ${survivors[winner]} standing`}; points ${expected.seats.map((s) => s.points).join(" : ")}   ${link(last)}`);
    if (expected.done) break;
    assert.deepEqual((await view("get_match", { id })).game, expected, `after round ${before.round}: the stored match differs`);
  }

  const result = await view("get_result", { id });
  assert.equal(await view("get_match", { id }), null, "a settled match is deleted");
  assert.equal(BigInt(result.payouts[0]) + BigInt(result.payouts[1]) + BigInt(result.fee), stake * 2n, "the pot is paid out in full");
  console.log(`  settled: ${result.backers[0]} takes ${fmt(result.payouts[0])}, ${result.backers[1]} takes ${fmt(result.payouts[1])}, fee ${fmt(result.fee)}`);
  return id;
}

async function sandboxRun() {
  const { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } = require("near-sandbox");
  const wasm = fs.readFileSync(WASM);
  console.log(`wasm: ${wasm.length} bytes; booting a local near-sandbox...`);
  const sandbox = await Sandbox.start({});
  const stop = async () => {
    // The 2.14 node does not exit on SIGTERM (see run.js): kill it and remove its home.
    sandbox.childProcess.kill("SIGKILL");
    await fs.promises.rm(sandbox.homeDir, { recursive: true, force: true }).catch(() => {});
  };
  process.once("SIGINT", () => stop().then(() => process.exit(1)));
  const watchdog = setTimeout(() => stop().then(() => process.exit(1)), 10 * 60 * 1000);
  try {
    const keyStore = new keyStores.InMemoryKeyStore();
    await keyStore.setKey("sandbox", DEFAULT_ACCOUNT_ID, KeyPair.fromString(DEFAULT_PRIVATE_KEY));
    const near = await connect({ networkId: "sandbox", nodeUrl: sandbox.rpcUrl, keyStore });
    const root = await near.account(DEFAULT_ACCOUNT_ID);
    const make = async (name, amount) => {
      const id = `${name}.${DEFAULT_ACCOUNT_ID}`;
      const key = KeyPair.fromRandom("ed25519");
      await keyStore.setKey("sandbox", id, key);
      await root.createAccount(id, key.getPublicKey(), NEAR(amount));
      return near.account(id);
    };
    const arena = await make("arena", 10);
    const [owner, p1, p2] = [await make("owner", 5), await make("p1", 20), await make("p2", 20)];
    await arena.deployContract(wasm);
    await arena.functionCall({ contractId: arena.accountId, methodName: "new", args: { owner: owner.accountId, max_stake: NEAR(5).toString(), fee_bps: FEE_BPS }, gas: GAS });
    console.log(`deployed to ${arena.accountId}`);
    for (const rounds of [3, 7]) await playMatch({ contractId: arena.accountId, seats: [p1, p2], stake: NEAR(1), rounds });
    const fees = BigInt((await owner.viewFunction({ contractId: arena.accountId, methodName: "get_config", args: {} })).fees);
    assert.equal(fees, (NEAR(1) * 2n * BigInt(FEE_BPS) * 2n) / 10000n, "the fees of both matches add up");
    await owner.functionCall({ contractId: arena.accountId, methodName: "withdraw_fees", args: {}, gas: GAS });
    console.log(`the owner withdrew ${fmt(fees)} of fees\nall good`);
  } finally {
    clearTimeout(watchdog);
    await stop();
  }
}

async function testnetRun() {
  const parent = process.env.ARENA_PARENT;
  if (!parent || !parent.endsWith(".testnet")) throw new Error("set ARENA_PARENT to a .testnet account whose key is in the NEAR credentials directory");
  const keyStore = new keyStores.UnencryptedFileSystemKeyStore(process.env.NEAR_CREDENTIALS_DIR ?? path.join(os.homedir(), ".near-credentials"));
  const near = await connect({ networkId: "testnet", nodeUrl: process.env.ARENA_RPC ?? "https://test.rpc.fastnear.com", keyStore });
  const wasm = fs.readFileSync(WASM);
  const arenaId = `arena.${parent}`;
  const root = await near.account(parent);
  const exists = await near.connection.provider.query({ request_type: "view_account", finality: "final", account_id: arenaId }).then(() => true, () => false);
  if (!exists) {
    // The account must hold 1 NEAR per 100 KB of contract code, plus room for matches.
    const fund = (BigInt(wasm.length) * 10n ** 19n * 115n) / 100n + NEAR(0.3);
    const balance = BigInt((await root.getAccountBalance()).available);
    if (balance < fund + NEAR(0.1)) throw new Error(`${parent} has ${fmt(balance)} available; creating ${arenaId} needs ${fmt(fund)} for the ${wasm.length}-byte contract`);
    const key = KeyPair.fromRandom("ed25519");
    await keyStore.setKey("testnet", arenaId, key);
    await root.createAccount(arenaId, key.getPublicKey(), fund);
    console.log(`created ${arenaId} with ${fmt(fund)}`);
  }
  const arena = await near.account(arenaId);
  const state = await arena.state();
  if (state.code_hash === "11111111111111111111111111111111") {
    await arena.deployContract(wasm);
    await arena.functionCall({ contractId: arenaId, methodName: "new", args: { owner: parent, max_stake: NEAR(1).toString(), fee_bps: FEE_BPS }, gas: GAS });
    console.log(`deployed ${wasm.length} bytes to ${arenaId}`);
  } else if (process.argv.includes("--redeploy")) {
    await arena.deployContract(wasm);
    console.log(`redeployed ${wasm.length} bytes to ${arenaId} (state kept)`);
  }
  const seats = [await near.account(`p1.${parent}`), await near.account(`p2.${parent}`)];
  const id = await playMatch({ contractId: arenaId, seats, stake: NEAR(0.05), rounds: 5, explorer: "https://testnet.nearblocks.io" });
  console.log(`contract: https://testnet.nearblocks.io/address/${arenaId}\nmatch ${id} settled on testnet`);
}

(process.argv[2] === "testnet" ? testnetRun() : sandboxRun()).catch((e) => {
  console.error(e);
  process.exit(1);
});
