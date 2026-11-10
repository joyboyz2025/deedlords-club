// Deedlords contract integration test on a LOCAL near-sandbox (nearcore 2.14) with near-api-js 5.
// Never talks to testnet or mainnet: every account lives on the sandbox started (and torn down) by this script.
//
//   npm test                         # uses ../target/wasm32-unknown-unknown/release/deedlords.wasm
//   node run.js <path/to/deedlords.wasm>
//
// Set NEAR_SANDBOX_BIN_PATH to reuse an already downloaded near-sandbox 2.14 binary.
//
// Scenarios: (a) solo Blitz, player + house backing 3 seats, every turn through turn(); (b) 2-player classic match
// through play(); (c) timeout called by a third account after the deadline; (d) abandon refunds after 15 minutes.
// Prints gas per join/turn/play, the wasm size and storage bytes per match.

const fs = require("fs");
const assert = require("assert/strict");
const { connect, keyStores, KeyPair } = require("near-api-js");
const { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } = require("near-sandbox");

const NET = "sandbox";
const Y = 10n ** 24n;
const NEAR = (n) => (BigInt(Math.round(n * 1000)) * Y) / 1000n;
const fmt = (yocto) => `${(Number(BigInt(yocto) / 10n ** 18n) / 1e6).toFixed(6)} NEAR`;
const TGAS = 10n ** 12n;
const GAS = 300n * TGAS;
const SEC = 1_000_000_000n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let near, keyStore, provider, contractId;
const gas = { join: [], turn: [], play: [], timeout: [], create_match: [] };
const storage = {};

// ----- chain helpers -----------------------------------------------------------------------------------------------

async function head() {
  const b = await provider.block({ finality: "optimistic" });
  return { height: b.header.height, ts: BigInt(b.header.timestamp_nanosec) };
}

async function viewAccount(id) {
  return provider.query({ request_type: "view_account", finality: "optimistic", account_id: id });
}

const balance = async (id) => BigInt((await viewAccount(id)).amount);
const storageUsage = async (id) => Number((await viewAccount(id)).storage_usage);

async function makeAccount(name, amount) {
  const id = `${name}.${DEFAULT_ACCOUNT_ID}`;
  const kp = KeyPair.fromRandom("ed25519");
  await keyStore.setKey(NET, id, kp);
  const root = await near.account(DEFAULT_ACCOUNT_ID);
  await root.createAccount(id, kp.getPublicKey(), NEAR(amount));
  return near.account(id);
}

function gasOf(outcome) {
  const burnt = [outcome.transaction_outcome, ...outcome.receipts_outcome].reduce((s, o) => s + BigInt(o.outcome.gas_burnt), 0n);
  const contract = BigInt(outcome.receipts_outcome[0].outcome.gas_burnt);
  return { burnt, contract };
}

function eventsOf(outcome) {
  const out = [];
  for (const r of outcome.receipts_outcome) {
    for (const log of r.outcome.logs) {
      if (log.startsWith("EVENT_JSON:")) out.push(JSON.parse(log.slice("EVENT_JSON:".length)));
    }
  }
  return out;
}

async function call(account, method, args, deposit = 0n) {
  const outcome = await account.functionCall({ contractId, methodName: method, args, gas: GAS, attachedDeposit: deposit });
  if (gas[method]) gas[method].push(gasOf(outcome));
  return outcome;
}

async function expectFail(promise, needle) {
  try {
    await promise;
  } catch (e) {
    const msg = String(e && (e.message || e));
    assert.ok(msg.includes(needle), `expected failure containing ${JSON.stringify(needle)}, got: ${msg.slice(0, 300)}`);
    return msg;
  }
  assert.fail(`expected the call to fail with ${JSON.stringify(needle)}`);
}

const view = (method, args = {}) => near.connection.provider
  .query({ request_type: "call_function", finality: "optimistic", account_id: contractId, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") })
  .then((r) => JSON.parse(Buffer.from(r.result).toString()));

/// Transfers (receiver -> yocto) made by the receipts of a transaction, read back from EXPERIMENTAL_tx_status.
async function transfersOf(outcome, signerId) {
  const status = await provider.sendJsonRpc("EXPERIMENTAL_tx_status", { tx_hash: outcome.transaction.hash, sender_account_id: signerId, wait_until: "FINAL" });
  const out = {};
  for (const receipt of status.receipts) {
    if (receipt.predecessor_id === "system") continue; // gas refunds
    for (const action of receipt.receipt.Action?.actions ?? []) {
      if (action.Transfer) out[receipt.receiver_id] = (out[receipt.receiver_id] ?? 0n) + BigInt(action.Transfer.deposit);
    }
  }
  return out;
}

/// Lets block time pass `targetNs`: fast-forwards the sandbox (about 0.3 s of chain time per block), then polls.
async function passTime(targetNs) {
  let now = (await head()).ts;
  if (now > targetNs) return;
  let blocks = Number((targetNs - now) / (SEC / 4n)) + 4;
  while (blocks > 0) {
    const chunk = Math.min(blocks, 1000);
    await provider.sendJsonRpc("sandbox_fast_forward", { delta_height: chunk }).catch(() => {});
    blocks -= chunk;
  }
  for (let i = 0; i < 200 && (await head()).ts <= targetNs; i++) await sleep(250);
  assert.ok((await head()).ts > targetNs, "block time did not pass the target");
}

async function waitBlocks(n) {
  const start = (await head()).height;
  while ((await head()).height < start + n) await sleep(100);
}

function sampleStorage(key, value) {
  storage[key] = Math.max(storage[key] ?? 0, value);
}

// ----- scenarios ---------------------------------------------------------------------------------------------------

const ALL_CITIES = [1, 3, 6, 8, 9, 11, 13, 14, 16, 18, 19, 21, 23, 24, 26, 27, 29, 31, 32, 34, 37, 39];

async function createMatch(creator, id, opts) {
  const outcome = await call(creator, "create_match", {
    id,
    seats: opts.seats,
    stake: opts.stake.toString(),
    split: opts.split,
    rules: opts.rules,
    solo_player: opts.solo ?? null,
    turn_seconds: opts.turnSeconds ?? null,
  }, opts.storage ?? NEAR(0.06));
  return outcome;
}

async function scenarioSoloBlitz(acc) {
  console.log("\n(a) solo Blitz: alice + house backing 3 seats, every turn through turn()");
  const id = "solo-blitz-1";
  const stake = NEAR(1);
  const split = [6000, 3000, 1000];
  const forfeitedBefore = BigInt(await view("get_forfeited"));
  const s0 = await storageUsage(contractId);
  await createMatch(acc.alice, id, { seats: 4, stake, split, rules: { salary: 200, cash: 2000, blitz: true, max_rounds: 3 }, solo: acc.alice.accountId, turnSeconds: 120 });
  sampleStorage("lobby match (bytes)", (await storageUsage(contractId)) - s0);
  await expectFail(call(acc.bob, "join", { id, seat: 0 }, stake), "solo match: only the solo player or the house");
  await call(acc.house, "join", { id, seat: 1 }, stake);
  await call(acc.house, "join", { id, seat: 2 }, stake);
  await call(acc.house, "join", { id, seat: 3 }, stake);
  await call(acc.alice, "join", { id, seat: 0 }, stake); // last seat: starts the game
  let m = await view("get_match", { id });
  assert.equal(m.meta.status, "playing");
  assert.equal(Object.keys(m.game.props).length, 20, "Blitz dealt 5 squares to each seat");
  sampleStorage("started match (bytes)", (await storageUsage(contractId)) - s0);

  const plan = { buy_reserve: 150, build: ALL_CITIES, keep_reserve: 250, bail: true, liquidate: [] };
  const accounts = { [acc.alice.accountId]: acc.alice, [acc.house.accountId]: acc.house };
  let last = null;
  let aliceBefore = 0n;
  let turns = 0;
  for (; turns < 200; turns++) {
    m = await view("get_match", { id });
    if (m === null) break;
    sampleStorage("peak match while playing (bytes)", (await storageUsage(contractId)) - s0);
    const seat = m.meta.current_seat;
    const signer = accounts[m.meta.seats[seat].backer];
    await waitBlocks(3); // let earlier gas refunds land before the balance snapshot
    aliceBefore = await balance(acc.alice.accountId);
    last = { outcome: await call(signer, "turn", { id, seat, plan }), signer };
    const ev = eventsOf(last.outcome).find((e) => e.event === "actions");
    const dice = ev.data.steps.flatMap((s) => s.events).filter((e) => e.kind === "roll").map((e) => e.dice.join("+"));
    process.stdout.write(`  turn ${String(turns + 1).padStart(2)} seat ${seat} (${signer === acc.alice ? "alice" : "house"}): ${ev.data.steps.length} steps, dice ${dice.join(", ")}\n`);
  }
  assert.ok(turns > 0 && turns < 200, "the match settled");
  await waitBlocks(3);
  const result = await view("get_result", { id });
  const settle = eventsOf(last.outcome).find((e) => e.event === "settle").data;
  console.log(`  settled after ${turns} turns, reason ${result.reason}, ranking (seats) ${result.ranking.join(" > ")}`);

  const pot = stake * 4n;
  const payouts = result.payouts.map(BigInt);
  const forfeited = BigInt(result.forfeited);
  assert.equal(payouts.reduce((a, b) => a + b, 0n) + forfeited, pot, "payouts + forfeited == pot");
  assert.equal(BigInt(await view("get_forfeited")) - forfeitedBefore, forfeited, "contract forfeited counter");
  const aliceRank = result.backers.indexOf(acc.alice.accountId);
  const alicePayout = payouts[aliceRank];
  const storageRefund = BigInt(settle.storage_refund);

  // Real transfers in the settling transaction, and alice's real balance.
  const sent = await transfersOf(last.outcome, last.signer.accountId);
  assert.equal(sent[acc.alice.accountId] ?? 0n, alicePayout + storageRefund, "alice receives her payout + the creator's storage refund");
  assert.equal(sent[acc.house.accountId], undefined, "nothing is ever sent to the house");
  const aliceAfter = await balance(acc.alice.accountId);
  const delta = aliceAfter - aliceBefore;
  if (last.signer === acc.alice) {
    const fee = alicePayout + storageRefund - delta;
    assert.ok(fee >= 0n && fee < NEAR(0.02), `alice's balance moved by the transfer minus her gas fee (fee ${fmt(fee)})`);
  } else {
    assert.equal(delta, alicePayout + storageRefund, "alice's balance moved by exactly the transfer");
  }
  console.log(`  alice rank ${aliceRank}: payout ${fmt(alicePayout)} + storage refund ${fmt(storageRefund)}; balance +${fmt(delta)}`);
  console.log(`  house shares forfeited: ${fmt(forfeited)} (contract total ${fmt(await view("get_forfeited"))})`);

  // Deed: minted to alice only if she won.
  const token = await view("nft_token", { token_id: id });
  if (result.backers[0] === acc.alice.accountId) {
    assert.equal(token.owner_id, acc.alice.accountId);
    const owned = await view("nft_tokens_for_owner", { account_id: acc.alice.accountId });
    assert.ok(owned.some((t) => t.token_id === id));
    console.log(`  alice won: Deed "${token.metadata.title}" owned by ${token.owner_id}`);
  } else {
    assert.equal(token, null, "no Deed for a house win");
    assert.equal((await view("nft_tokens_for_owner", { account_id: acc.house.accountId })).length, 0);
    console.log("  the house won: no Deed minted, its share is locked");
  }
  const stats = await view("get_stats", { account_id: acc.alice.accountId });
  assert.equal(stats.played, 1);
  storage["permanent records after settle (bytes)"] = settle.record_bytes;
  sampleStorage("contract residue after settle (bytes)", (await storageUsage(contractId)) - s0);
}

async function scenarioClassicPlay(acc) {
  console.log("\n(b) 2-player classic match (maxRounds 2) through play()");
  const id = "classic-duo-1";
  const stake = NEAR(0.5);
  await createMatch(acc.bob, id, { seats: 2, stake, split: [7000, 3000], rules: { salary: 200, cash: 1500, blitz: false, maxRounds: 2 }, turnSeconds: 120 });
  await call(acc.alice, "join", { id, seat: 0 }, stake);
  await call(acc.bob, "join", { id, seat: 1 }, stake);
  const byAccount = { [acc.alice.accountId]: acc.alice, [acc.bob.accountId]: acc.bob };
  let m = await view("get_match", { id });
  const first = m.meta.current_seat;
  const firstSigner = byAccount[m.meta.seats[first].backer];
  const otherSigner = firstSigner === acc.alice ? acc.bob : acc.alice;

  // Authorization and whole-call rejection.
  await expectFail(call(otherSigner, "play", { id, seat: first, actions: ["Roll"] }), "only the backer or the driver");
  await expectFail(call(firstSigner, "play", { id, seat: first, actions: ["Roll", "Bankrupt"] }), "action 1 (bankrupt) rejected");
  assert.equal((await view("get_match", { id })).game.rolls, 0, "the rejected call left no roll behind");
  await expectFail(call(firstSigner, "play", { id, seat: first, actions: ["Auto"] }), "not playable");

  let last = null;
  let calls = 0;
  for (; calls < 300; calls++) {
    m = await view("get_match", { id });
    if (m === null) break;
    const g = m.game;
    const seat = m.meta.current_seat;
    const signer = byAccount[m.meta.seats[seat].backer];
    const me = g.players.find((p) => p.id === `s${seat}`);
    let actions;
    if (g.stage === "roll") actions = me.jail !== null && me.cash >= 50 ? ["Bail", "Roll"] : ["Roll"];
    else if (g.stage === "buy") actions = me.cash > 400 ? ["Buy", g.again ? "Roll" : "End"] : ["Skip"];
    else if (g.stage === "end") actions = [g.again ? "Roll" : "End"];
    else {
      const owed = g.debt.reduce((s, d) => s + d.amount, 0);
      const mine = Object.entries(g.props).filter(([, o]) => o.owner === `s${seat}`);
      const house = mine.find(([, o]) => o.houses > 0);
      const free = mine.find(([, o]) => !o.mortgaged && o.houses === 0);
      actions = me.cash >= owed ? ["Pay"] : house ? [{ Sell: Number(house[0]) }] : free ? [{ Mortgage: Number(free[0]) }] : ["Bankrupt"];
    }
    try {
      last = { outcome: await call(signer, "play", { id, seat, actions }), signer };
    } catch (e) {
      // e.g. Buy without the cash: the whole call is rejected, fall back to Skip.
      if (g.stage !== "buy") throw e;
      last = { outcome: await call(signer, "play", { id, seat, actions: ["Skip"] }), signer };
    }
  }
  assert.ok(calls > 0 && calls < 300, "the match settled");
  await waitBlocks(3);
  const result = await view("get_result", { id });
  const settle = eventsOf(last.outcome).find((e) => e.event === "settle").data;
  const pot = stake * 2n;
  const payouts = result.payouts.map(BigInt);
  assert.equal(payouts[0], (pot * 7000n) / 10000n);
  assert.equal(payouts[0] + payouts[1], pot);
  assert.equal(BigInt(result.forfeited), 0n);
  const sent = await transfersOf(last.outcome, last.signer.accountId);
  for (const [rank, backer] of result.backers.entries()) {
    const refund = backer === acc.bob.accountId ? BigInt(settle.storage_refund) : 0n;
    assert.equal(sent[backer], payouts[rank] + refund, `${backer} receives the rank ${rank} share`);
  }
  const token = await view("nft_token", { token_id: id });
  assert.equal(token.owner_id, result.backers[0], "the winner's backer owns the Deed");
  console.log(`  settled after ${calls} play() calls (${result.reason}); winner ${result.backers[0]} got ${fmt(payouts[0])} and the Deed; runner-up ${fmt(payouts[1])}`);
}

async function scenarioTimeout(acc) {
  console.log("\n(c) timeout by a third account after the deadline");
  const id = "timeout-1";
  const stake = NEAR(0.1);
  await createMatch(acc.alice, id, { seats: 2, stake, split: [10000], rules: { salary: 200, cash: 1500, blitz: false, max_rounds: 0 }, turnSeconds: 10 });
  await call(acc.alice, "join", { id, seat: 0 }, stake);
  await call(acc.bob, "join", { id, seat: 1 }, stake);
  let m = await view("get_match", { id });
  const deadline = BigInt(m.meta.turn_deadline);
  const seat = m.meta.current_seat;
  await expectFail(call(acc.carol, "timeout", { id }), "has not passed");
  await passTime(deadline);
  const outcome = await call(acc.carol, "timeout", { id });
  const ev = eventsOf(outcome).find((e) => e.event === "actions").data;
  assert.equal(ev.kind, "timeout");
  assert.equal(ev.by, acc.carol.accountId);
  assert.equal(ev.steps[0].action, "Auto");
  m = await view("get_match", { id });
  assert.equal(m.game.rolls, 1, "Auto rolled for the absent player");
  console.log(`  carol forced seat ${seat}: ${ev.steps[0].events.map((e) => e.kind + (e.dice ? ` ${e.dice.join("+")}` : "")).join(", ")}`);
  // The timed-out seat keeps an expired deadline: carol finishes the turn at once.
  let forced = 1;
  while (m.meta.current_seat === seat) {
    assert.equal(BigInt(m.meta.turn_deadline), deadline);
    await call(acc.carol, "timeout", { id });
    m = await view("get_match", { id });
    forced++;
  }
  const fresh = BigInt(m.meta.turn_deadline);
  assert.ok(fresh > deadline, "the next player gets a fresh deadline");
  await expectFail(call(acc.carol, "timeout", { id }), "has not passed");
  console.log(`  ${forced} timeout step(s) finished the turn; seat ${m.meta.current_seat} has a fresh deadline (+${Number(fresh - deadline) / 1e9}s)`);
}

async function scenarioAbandon(acc) {
  console.log("\n(d) abandon refunds after 15 minutes in the lobby");
  const id = "abandon-1";
  const stake = NEAR(0.2);
  const deposit = NEAR(0.06);
  const s0 = await storageUsage(contractId);
  await createMatch(acc.carol, id, { seats: 3, stake, split: [10000], rules: { salary: 200, cash: 1500, blitz: false, max_rounds: 0 }, storage: deposit });
  await call(acc.alice, "join", { id, seat: 0 }, stake);
  await call(acc.bob, "join", { id, seat: 2 }, stake);
  const created = BigInt((await view("get_match", { id })).meta.created_at);
  await expectFail(call(acc.owner, "abandon", { id }), "15 minutes after creation");
  await passTime(created + 15n * 60n * SEC);
  await waitBlocks(2);
  const before = { alice: await balance(acc.alice.accountId), bob: await balance(acc.bob.accountId), carol: await balance(acc.carol.accountId) };
  const outcome = await call(acc.owner, "abandon", { id });
  await waitBlocks(3);
  const sent = await transfersOf(outcome, acc.owner.accountId);
  assert.equal(sent[acc.alice.accountId], stake);
  assert.equal(sent[acc.bob.accountId], stake);
  assert.equal(sent[acc.carol.accountId], deposit, "the creator gets the whole storage deposit back");
  assert.equal(await balance(acc.alice.accountId) - before.alice, stake);
  assert.equal(await balance(acc.bob.accountId) - before.bob, stake);
  assert.equal(await balance(acc.carol.accountId) - before.carol, deposit);
  assert.equal(await view("get_match", { id }), null);
  assert.equal(await storageUsage(contractId), s0, "an abandoned match leaves no storage behind");
  console.log(`  refunded ${fmt(stake)} to alice and bob, ${fmt(deposit)} storage deposit to carol; storage back to the pre-match size`);
}

// ----- main --------------------------------------------------------------------------------------------------------

function stat(list, pick) {
  if (!list.length) return "n/a";
  const tg = list.map((g) => Number(pick(g)) / 1e12);
  const avg = tg.reduce((a, b) => a + b, 0) / tg.length;
  return `n=${tg.length} avg ${avg.toFixed(2)} min ${Math.min(...tg).toFixed(2)} max ${Math.max(...tg).toFixed(2)} Tgas`;
}

/// `Sandbox.tearDown()` of near-sandbox 0.3.5 sends SIGTERM and waits for the exit event, but the 2.14 node does not
/// exit on SIGTERM, so it waits forever. Stop it ourselves: SIGTERM, SIGKILL after 5 s, unlock the ports, remove the home.
async function stopSandbox(sandbox) {
  const child = sandbox.childProcess;
  const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  const stopped = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]);
  if (!stopped) {
    child.kill("SIGKILL");
    await Promise.race([exited, sleep(5000)]);
  }
  try {
    const lockfile = require("proper-lockfile");
    await Promise.allSettled([lockfile.unlock(sandbox.rpcPortLockPath), lockfile.unlock(sandbox.netPortLockPath)]);
  } catch (_) {}
  await fs.promises.rm(sandbox.homeDir, { recursive: true, force: true }).catch(() => {});
}

(async () => {
  const wasmPath = process.argv[2] ?? "../target/wasm32-unknown-unknown/release/deedlords.wasm";
  const wasm = fs.readFileSync(wasmPath);
  console.log(`wasm: ${wasmPath} (${wasm.length} bytes)`);
  console.log("booting a local near-sandbox (nearcore 2.14)...");
  const sandbox = await Sandbox.start({});
  // Never leave a node behind: on Ctrl-C, or if the whole run takes over 20 minutes.
  const abort = async (why) => {
    console.error(`\naborting (${why}); stopping the sandbox`);
    await stopSandbox(sandbox);
    process.exit(1);
  };
  process.once("SIGINT", () => abort("SIGINT"));
  process.once("SIGTERM", () => abort("SIGTERM"));
  const watchdog = setTimeout(() => abort("watchdog: 20 minutes"), 20 * 60 * 1000);
  keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(NET, DEFAULT_ACCOUNT_ID, KeyPair.fromString(DEFAULT_PRIVATE_KEY));
  near = await connect({ networkId: NET, nodeUrl: sandbox.rpcUrl, keyStore });
  provider = near.connection.provider;
  let failed = false;
  try {
    const game = await makeAccount("game", 30);
    contractId = game.accountId;
    const acc = {
      owner: await makeAccount("owner", 10),
      house: await makeAccount("house", 50),
      alice: await makeAccount("alice", 50),
      bob: await makeAccount("bob", 50),
      carol: await makeAccount("carol", 20),
    };
    const empty = await storageUsage(contractId);
    await game.deployContract(wasm);
    await game.functionCall({ contractId, methodName: "new", args: { owner: acc.owner.accountId, house: acc.house.accountId }, gas: GAS });
    console.log(`deployed to ${contractId}: contract storage ${await storageUsage(contractId) - empty} bytes (code + state)`);
    await expectFail(acc.alice.functionCall({ contractId, methodName: "new", args: { owner: acc.alice.accountId, house: acc.alice.accountId }, gas: GAS }), "");

    for (const [name, run] of [["a", scenarioSoloBlitz], ["b", scenarioClassicPlay], ["c", scenarioTimeout], ["d", scenarioAbandon]]) {
      try {
        await run(acc);
        console.log(`  PASS (${name})`);
      } catch (e) {
        failed = true;
        console.log(`  FAIL (${name}): ${e && e.stack ? e.stack : e}`);
      }
    }

    console.log("\n================ MEASUREMENTS ================");
    console.log(`wasm size:          ${wasm.length} bytes`);
    for (const method of ["create_match", "join", "turn", "play", "timeout"]) {
      console.log(`gas ${method.padEnd(13)} tx total ${stat(gas[method], (g) => g.burnt)} | contract receipt ${stat(gas[method], (g) => g.contract)}`);
    }
    for (const [k, v] of Object.entries(storage)) console.log(`storage ${k}: ${v}`);
    console.log(failed ? "\nRESULT: FAIL" : "\nRESULT: all 4 scenarios passed");
  } finally {
    clearTimeout(watchdog);
    await stopSandbox(sandbox);
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("harness error:", e);
  process.exit(1);
});
