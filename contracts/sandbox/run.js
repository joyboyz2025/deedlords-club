// Deedlords contract integration test on a LOCAL near-sandbox (nearcore 2.14) with near-api-js 5.
// Never talks to testnet or mainnet: every account lives on the sandbox started (and torn down) by this script.
//
//   npm test                         # uses ../target/wasm32-unknown-unknown/release/deedlords.wasm
//   node run.js <path/to/deedlords.wasm>
//
// Set NEAR_SANDBOX_BIN_PATH to reuse an already downloaded near-sandbox 2.14 binary.
//
// Scenarios: (a) solo Blitz, player + house backing 3 seats, every turn through turn(); (b) 2-player classic match
// through play(); (c) timeout called by a third account after the deadline; (d) abandon refunds after 15 minutes;
// (e) the stake cap, the gas floor of every call that may roll, the turn clock under free moves, and a whole match
// played with exactly the floor attached and the largest plan the contract accepts; (f) the fee: 2.5% of every settled
// pot adds up in the contract and only the owner can withdraw it, and nothing but it.
// (h) the transaction a web wallet signs to open a match: create_match + join in one, and its refusal as a whole.
// With DEEDLORDS_V1_WASM=<wasm built before the fee existed> also (g): that wasm is deployed to a second account, a
// match is settled on it, then the new wasm is deployed over it with migrate() in the same transaction.
// Prints gas per join/turn/play, the heaviest calls against the gas floor, the wasm size and storage bytes per match.

const fs = require("fs");
const assert = require("assert/strict");
const { connect, keyStores, KeyPair, transactions } = require("near-api-js");
const { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } = require("near-sandbox");

const NET = "sandbox";
const Y = 10n ** 24n;
const NEAR = (n) => (BigInt(Math.round(n * 1000)) * Y) / 1000n;
const fmt = (yocto) => `${(Number(BigInt(yocto) / 10n ** 18n) / 1e6).toFixed(6)} NEAR`;
const TGAS = 10n ** 12n;
const GAS = 300n * TGAS;
/// Stake cap this test deployment is initialised with.
const MAX_STAKE = 10n * Y;
/// Fee this test deployment is initialised with: 2.5% of every pot, in basis points.
const FEE_BPS = 250;
const feeOf = (pot) => (pot * BigInt(FEE_BPS)) / 10000n;
/// Matches settled by the scenarios, for (f) to add their fees up.
const settledIds = [];
const SEC = 1_000_000_000n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let near, keyStore, provider, contractId;
const gas = { join: [], turn: [], play: [], timeout: [], create_match: [] };
const storage = {};
const floorReport = [];

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

async function call(account, method, args, deposit = 0n, gasLimit = GAS) {
  const outcome = await account.functionCall({ contractId, methodName: method, args, gas: gasLimit, attachedDeposit: deposit });
  if (gas[method]) gas[method].push(gasOf(outcome));
  return outcome;
}

/// The JSON value a successful call returned (null for a method without one).
function returned(outcome) {
  const text = Buffer.from(outcome.status.SuccessValue ?? "", "base64").toString();
  return text ? JSON.parse(text) : null;
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
  // One seat for the solo player, every other seat for the house: neither can play the match against itself.
  await call(acc.alice, "join", { id, seat: 2 }, stake);
  await expectFail(call(acc.alice, "join", { id, seat: 0 }, stake), "the solo player backs exactly one seat");
  await call(acc.alice, "leave", { id, seat: 2 });
  await call(acc.house, "join", { id, seat: 1 }, stake);
  await call(acc.house, "join", { id, seat: 2 }, stake);
  await call(acc.house, "join", { id, seat: 3 }, stake);
  await expectFail(call(acc.house, "join", { id, seat: 0 }, stake), "the last free seat is the solo player's");
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
  assert.equal(BigInt(result.fee), feeOf(pot), "the fee is 2.5% of the pot");
  assert.equal(BigInt(settle.fee), feeOf(pot));
  assert.equal(payouts.reduce((a, b) => a + b, 0n) + forfeited + feeOf(pot), pot, "payouts + forfeited + fee == pot");
  settledIds.push(id);
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

  // Authorization, and what a rejected action does to the call.
  await expectFail(call(otherSigner, "play", { id, seat: first, actions: ["Roll"] }), "only the backer or the driver");
  await expectFail(call(firstSigner, "play", { id, seat: first, actions: ["Auto"] }), "not playable");
  // Rejected before any die was rolled: the whole call is rejected. (Square 0 is the start square: never buildable.)
  await expectFail(call(firstSigner, "play", { id, seat: first, actions: [{ Build: 0 }, "Roll"] }), "action 0 (build) rejected");
  assert.equal((await view("get_match", { id })).game.rolls, 0, "the rejected call left no roll behind");
  // Rejected after a roll: the roll stands and the rejection is reported, so a failing action is not a free re-roll.
  const kept = await call(firstSigner, "play", { id, seat: first, actions: ["Roll", { Build: 0 }, "End"] });
  const verdict = returned(kept);
  assert.equal(verdict.applied, 1);
  assert.equal(verdict.rejected.index, 1);
  assert.deepEqual(verdict.rejected.action, { Build: 0 });
  const keptEvent = eventsOf(kept).find((e) => e.event === "actions").data;
  assert.equal(keptEvent.steps.length, 1);
  assert.deepEqual(keptEvent.rejected, verdict.rejected);
  assert.equal((await view("get_match", { id })).game.rolls, 1, "the roll is kept");
  console.log(`  play([Roll, Build 0, End]): roll kept, then "${verdict.rejected.error}" reported in the return value and the event`);

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
  const fee = feeOf(pot);
  assert.equal(BigInt(result.fee), fee);
  assert.equal(payouts[0], ((pot - fee) * 7000n) / 10000n, "the ranks share the pot less the fee");
  assert.equal(payouts[0] + payouts[1], pot - fee);
  assert.equal(BigInt(result.forfeited), 0n);
  settledIds.push(id);
  const sent = await transfersOf(last.outcome, last.signer.accountId);
  for (const [rank, backer] of result.backers.entries()) {
    const refund = backer === acc.bob.accountId ? BigInt(settle.storage_refund) : 0n;
    assert.equal(sent[backer], payouts[rank] + refund, `${backer} receives the rank ${rank} share`);
  }
  const token = await view("nft_token", { token_id: id });
  assert.equal(token.owner_id, result.backers[0], "the winner's backer owns the Deed");
  console.log(`  settled after ${calls} play() calls (${result.reason}); winner ${result.backers[0]} got ${fmt(payouts[0])} and the Deed; runner-up ${fmt(payouts[1])}; fee ${fmt(fee)}`);
}

async function scenarioTimeout(acc) {
  console.log("\n(c) timeout by a third account after the deadline");
  const id = "timeout-1";
  const stake = NEAR(0.1);
  await createMatch(acc.alice, id, { seats: 2, stake, split: [10000], rules: { salary: 200, cash: 1500, blitz: false, max_rounds: 30 }, turnSeconds: 10 });
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
  await createMatch(acc.carol, id, { seats: 3, stake, split: [10000], rules: { salary: 200, cash: 1500, blitz: false, max_rounds: 30 }, storage: deposit });
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

async function scenarioGasFloor(acc) {
  console.log("\n(e) stake cap, gas floor, turn clock under free moves, and a whole match at exactly the floor");
  const config = await view("get_config");
  const floor = BigInt(config.min_move_gas);
  const below = floor - TGAS;
  assert.equal(BigInt(config.max_stake), MAX_STAKE);
  assert.equal(config.fee_bps, FEE_BPS);
  assert.equal(config.max_fee_bps, 500);
  const rules = { salary: 200, cash: 2000, blitz: true, max_rounds: 4 };
  await expectFail(createMatch(acc.alice, "too-rich", { seats: 2, stake: MAX_STAKE + 1n, split: [10000], rules }), "stake too large");
  await expectFail(createMatch(acc.alice, "endless", { seats: 2, stake: 0n, split: [10000], rules: { ...rules, max_rounds: 0 } }), "rules.max_rounds must be 1..=255");
  await expectFail(createMatch(acc.alice, "house-solo", { seats: 2, stake: 0n, split: [10000], rules, solo: acc.house.accountId }), "the house cannot be the solo player");

  const id = "floor-1";
  const stake = NEAR(0.1);
  await createMatch(acc.alice, id, { seats: 3, stake, split: [6000, 3000, 1000], rules, turnSeconds: 60 });
  const players = [acc.alice, acc.bob, acc.carol];
  const needle = `attach at least ${floor / TGAS} Tgas`;
  await expectFail(call(acc.alice, "join", { id, seat: 0 }, stake, below), needle);
  const heavy = [];
  const measure = (label, outcome) => {
    const g = gasOf(outcome);
    const steps = eventsOf(outcome).find((e) => e.event === "actions")?.data.steps.length ?? 0;
    heavy.push({ label, steps, ...g });
    return outcome;
  };
  // Every move from here on is sent with exactly the floor attached.
  for (const [seat, who] of players.entries()) measure(seat === 2 ? "join (last seat: deals, starts)" : "join", await call(who, "join", { id, seat }, stake, floor));
  let m = await view("get_match", { id });
  assert.equal(m.meta.status, "playing");
  const byId = Object.fromEntries(players.map((x) => [x.accountId, x]));
  const seat = m.meta.current_seat;
  const signer = byId[m.meta.seats[seat].backer];
  const outsider = acc.owner;
  await expectFail(call(signer, "play", { id, seat, actions: ["Roll"] }, 0n, below), needle);
  await expectFail(call(signer, "turn", { id, seat, plan: {} }, 0n, below), needle);
  await expectFail(call(outsider, "timeout", { id }, 0n, below), needle);
  assert.equal((await view("get_match", { id })).game.rolls, 0);
  console.log(`  join, play, turn and timeout with ${below / TGAS} Tgas attached: all refused ("${needle}")`);

  // The seat to move makes 32 free moves (the most one call takes): they change the board, never its deadline.
  const deadline = BigInt(m.meta.turn_deadline);
  const mine = Object.entries(m.game.props).filter(([, o]) => o.owner === `s${seat}`).map(([sq]) => Number(sq));
  const stall = Array.from({ length: 16 }, () => [{ Mortgage: mine[0] }, { Redeem: mine[0] }]).flat();
  for (let k = 0; k < 2; k++) {
    await waitBlocks(4);
    const outcome = measure("play, 32 actions (mortgage/redeem)", await call(signer, "play", { id, seat, actions: stall }, 0n, floor));
    assert.equal(returned(outcome).applied, 32);
    m = await view("get_match", { id });
    assert.equal(BigInt(m.meta.turn_deadline), deadline, "free moves do not restart the turn clock");
  }
  assert.equal(m.meta.current_seat, seat);
  await expectFail(call(outsider, "timeout", { id }, 0n, floor), "has not passed");
  await passTime(deadline);
  measure("timeout", await call(outsider, "timeout", { id }, 0n, floor));
  m = await view("get_match", { id });
  assert.equal(m.game.rolls, 1, "the stalling seat was rolled for at its first deadline");
  console.log(`  64 mortgage/redeem moves by seat ${seat} left its deadline where it was; a third account's timeout() rolled for it`);
  while (m !== null && m.meta.current_seat === seat) {
    measure("timeout", await call(outsider, "timeout", { id }, 0n, floor));
    m = await view("get_match", { id });
  }

  // The rest of the match through turn() with the largest plan accepted: 40 build squares, 40 liquidation squares.
  const forty = Array.from({ length: 40 }, (_, k) => ALL_CITIES[k % ALL_CITIES.length]);
  const plan = { buy_reserve: 0, build: forty, keep_reserve: 0, bail: true, liquidate: forty };
  await expectFail(call(byId[m.meta.seats[m.meta.current_seat].backer], "turn", { id, seat: m.meta.current_seat, plan: { ...plan, build: [...forty, 1] } }, 0n, floor), "at most 40 squares");
  let turns = 0;
  for (; turns < 200; turns++) {
    m = await view("get_match", { id });
    if (m === null) break;
    const s = m.meta.current_seat;
    const outcome = await call(byId[m.meta.seats[s].backer], "turn", { id, seat: s, plan }, 0n, floor);
    measure(eventsOf(outcome).some((e) => e.event === "settle") ? "turn that settles the match" : "turn, 40+40 plan", outcome);
  }
  assert.ok(turns > 0 && turns < 200, "the match settled");
  const result = await view("get_result", { id });
  assert.equal(result.payouts.map(BigInt).reduce((a, b) => a + b, 0n), stake * 3n - feeOf(stake * 3n), "the whole pot less the fee is paid out");
  settledIds.push(id);
  console.log(`  the match settled after ${turns} turn() calls (${result.reason}), every call with exactly ${floor / TGAS} Tgas attached`);

  const labels = [...new Set(heavy.map((h) => h.label))];
  for (const label of labels) {
    const list = heavy.filter((h) => h.label === label);
    const top = list.reduce((a, b) => (b.burnt > a.burnt ? b : a));
    floorReport.push(`${label.padEnd(36)} n=${String(list.length).padStart(3)}  heaviest: ${(Number(top.burnt) / 1e12).toFixed(2)} Tgas whole transaction, ${(Number(top.contract) / 1e12).toFixed(2)} Tgas contract receipt, ${top.steps} steps`);
  }
  const worst = heavy.reduce((a, b) => (b.burnt > a.burnt ? b : a));
  // Gas per engine step, from the turn() calls: least squares of contract gas on steps.
  const pts = heavy.filter((h) => h.label === "turn, 40+40 plan").map((h) => [h.steps, Number(h.contract) / 1e12]);
  if (pts.length > 2) {
    const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    const slope = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / (pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0) || 1);
    const settleExtra = Math.max(0, ...heavy.filter((h) => h.label === "turn that settles the match").map((h) => Number(h.burnt) / 1e12 - (my + slope * (h.steps - mx))));
    const bound = my + slope * (64 - mx) + settleExtra;
    floorReport.push(`turn(): ${slope.toFixed(3)} Tgas per engine step (max ${Math.max(...pts.map((p) => p[0]))} steps seen); a 64-step turn (the driver's cap) that also settles: about ${bound.toFixed(1)} Tgas`);
  }
  floorReport.push(`gas floor ${floor / TGAS} Tgas = ${(Number(floor) / Number(worst.burnt)).toFixed(1)} x the heaviest call seen (${(Number(worst.burnt) / 1e12).toFixed(2)} Tgas, "${worst.label}")`);
}

async function scenarioFees(acc) {
  console.log("\n(f) the fee: collected at every settlement, withdrawn by the owner only");
  // Every match the scenarios above settled, plus any other that left a result (the timeout scenario's).
  let expected = 0n;
  for (const id of [...settledIds, "timeout-1"]) {
    const result = await view("get_result", { id });
    if (!result) continue;
    assert.equal(BigInt(result.fee), feeOf(BigInt(result.pot)), `${id}: fee is 2.5% of its pot`);
    expected += BigInt(result.fee);
  }
  const fees = BigInt(await view("get_fees"));
  assert.ok(fees > 0n, "fees were collected");
  assert.equal(fees, expected, "the counter is the sum of the fees of the settled matches");
  const forfeited = BigInt(await view("get_forfeited"));

  await expectFail(call(acc.alice, "withdraw_fees", {}, 1n), "only the owner may withdraw the fees");
  await expectFail(call(acc.house, "withdraw_fees", {}, 1n), "only the owner may withdraw the fees");
  await expectFail(call(acc.owner, "withdraw_fees", {}), "exactly 1 yoctoNEAR");
  assert.equal(BigInt(await view("get_fees")), fees, "refused calls moved nothing");

  // An open match with real stakes in the contract while the owner withdraws.
  const id = "fees-open-1";
  const stake = NEAR(2);
  await createMatch(acc.alice, id, { seats: 2, stake, split: [10000], rules: { salary: 200, cash: 1500, blitz: false, max_rounds: 30 }, turnSeconds: 600 });
  await call(acc.alice, "join", { id, seat: 0 }, stake);
  await call(acc.bob, "join", { id, seat: 1 }, stake);

  const ownerBefore = await balance(acc.owner.accountId);
  const outcome = await call(acc.owner, "withdraw_fees", {}, 1n);
  assert.equal(BigInt(returned(outcome)), fees, "withdraw_fees returns what it sent");
  const sent = await transfersOf(outcome, acc.owner.accountId);
  assert.deepEqual(sent, { [acc.owner.accountId]: fees }, "one transfer, to the owner, of exactly the fees");
  const event = eventsOf(outcome).find((e) => e.event === "withdraw_fees").data;
  assert.equal(BigInt(event.amount), fees);
  await waitBlocks(3);
  const gained = (await balance(acc.owner.accountId)) - ownerBefore;
  assert.ok(gained <= fees && fees - gained < NEAR(0.02), `the owner's balance grew by the fees minus gas (${fmt(gained)} of ${fmt(fees)})`);
  assert.equal(BigInt(await view("get_fees")), 0n);
  assert.equal(BigInt(await view("get_forfeited")), forfeited, "the house's locked shares stay locked");
  assert.equal((await view("get_match", { id })).meta.status, "playing", "the open match is untouched");
  await expectFail(call(acc.owner, "withdraw_fees", {}, 1n), "there are no fees to withdraw");
  console.log(`  ${fmt(fees)} collected from ${settledIds.length}+ settled matches; alice, the house and a call without the yocto were refused; the owner received ${fmt(fees)} (balance +${fmt(gained)} after gas)`);
}

/// (h) What the web wallet is handed when a player opens a match: create_match and join as two calls of ONE transaction,
/// with the gas the page gives them (20 and 100 Tgas: join gets exactly the contract's floor). See games/co-ty-phu/chain/calls.ts.
async function scenarioWalletBatch(acc) {
  console.log("\n(h) one transaction: create_match + join, as the web wallet signs it");
  const stake = NEAR(0.05);
  const rules = { salary: 200, cash: 1500, blitz: false, max_rounds: 6 };
  const actionsFor = (id, joinGas) => [
    transactions.functionCall("create_match", { id, seats: 2, stake: stake.toString(), split: [7000, 3000], rules, solo_player: null, turn_seconds: 60 }, 20n * TGAS, NEAR(0.06)),
    transactions.functionCall("join", { id, seat: 0 }, joinGas, stake),
  ];
  // With too little gas on join the contract refuses it, and the create_match before it is undone with it.
  await expectFail(acc.carol.signAndSendTransaction({ receiverId: contractId, actions: actionsFor("wallet-low", 99n * TGAS) }), "attach at least 100 Tgas");
  assert.equal(await view("get_match", { id: "wallet-low" }), null, "nothing of the refused transaction stays");

  const before = await balance(acc.carol.accountId);
  const outcome = await acc.carol.signAndSendTransaction({ receiverId: contractId, actions: actionsFor("wallet-1", 100n * TGAS) });
  const m = await view("get_match", { id: "wallet-1" });
  assert.equal(m.meta.status, "lobby");
  assert.equal(m.meta.creator, acc.carol.accountId);
  assert.deepEqual(m.meta.seats.map((seat) => seat.backer), [acc.carol.accountId, null]);
  await waitBlocks(3);
  const spent = before - (await balance(acc.carol.accountId));
  const { burnt } = gasOf(outcome);
  assert.ok(spent >= NEAR(0.11) && spent < NEAR(0.12), `carol put in the deposit and the stake, plus gas (${fmt(spent)})`);
  // The second player's wallet signs a single join; the last seat starts the game.
  await acc.bob.signAndSendTransaction({ receiverId: contractId, actions: [transactions.functionCall("join", { id: "wallet-1", seat: 1 }, 100n * TGAS, stake)] });
  assert.equal((await view("get_match", { id: "wallet-1" })).meta.status, "playing");
  console.log(`  both calls ran in one transaction (${(Number(burnt) / 1e12).toFixed(2)} Tgas burnt, ${fmt(spent)} out of carol's balance); with 99 Tgas on join the whole transaction was refused; bob's join started the game`);
}

/// (g) Upgrade in place: the wasm from before the fee on a second account, then deploy + migrate in one transaction.
async function scenarioUpgrade(acc, wasm, v1Path) {
  console.log(`\n(g) upgrade: ${v1Path} deployed first, then the new wasm with migrate()`);
  const main = contractId;
  const old = await makeAccount("old", 30);
  contractId = old.accountId;
  try {
    await old.deployContract(fs.readFileSync(v1Path));
    await old.functionCall({ contractId, methodName: "new", args: { owner: acc.owner.accountId, house: acc.house.accountId, max_stake: MAX_STAKE.toString() }, gas: GAS });
    const before = await view("get_config");
    assert.equal(before.fee_bps, undefined, "the first layout has no fee");

    // A match settled before the upgrade: no fee was taken.
    const stake = NEAR(1);
    const plan = { buy_reserve: 0, build: [], keep_reserve: 0, bail: true, liquidate: [] };
    const playOut = async (id) => {
      const byId = { [acc.alice.accountId]: acc.alice, [acc.bob.accountId]: acc.bob };
      for (let i = 0; i < 50; i++) {
        const m = await view("get_match", { id });
        if (m === null) return;
        const seat = m.meta.current_seat;
        await call(byId[m.meta.seats[seat].backer], "turn", { id, seat, plan });
      }
      assert.fail(`${id} did not settle`);
    };
    const duel = async (id) => {
      await createMatch(acc.alice, id, { seats: 2, stake, split: [7000, 3000], rules: { salary: 200, cash: 1500, blitz: false, max_rounds: 1 }, turnSeconds: 120 });
      await call(acc.alice, "join", { id, seat: 0 }, stake);
      await call(acc.bob, "join", { id, seat: 1 }, stake);
      await playOut(id);
      return view("get_result", { id });
    };
    const oldResult = await duel("before-1");
    assert.deepEqual(oldResult.payouts.map(BigInt), [NEAR(1.4), NEAR(0.6)], "before the fee the whole pot was paid");
    const oldStats = await view("get_stats", { account_id: acc.alice.accountId });
    const oldDeed = await view("nft_token", { token_id: "before-1" });

    // While a match is open the upgrade is refused, and the refusal undoes the deploy made in the same transaction.
    await createMatch(acc.carol, "lobby-1", { seats: 2, stake, split: [10000], rules: { salary: 200, cash: 1500, blitz: false, max_rounds: 1 } });
    const created = BigInt((await view("get_match", { id: "lobby-1" })).meta.created_at);
    const upgrade = () => old.signAndSendTransaction({ receiverId: old.accountId, actions: [transactions.deployContract(wasm), transactions.functionCall("migrate", { fee_bps: FEE_BPS }, GAS, 0n)] });
    await expectFail(upgrade(), "finish or abandon every open match first");
    assert.equal((await view("get_config")).fee_bps, undefined, "still the first code and state");
    await passTime(created + 15n * 60n * SEC);
    await call(acc.bob, "abandon", { id: "lobby-1" });

    await upgrade();
    const config = await view("get_config");
    assert.equal(config.fee_bps, FEE_BPS);
    assert.equal(config.owner, before.owner);
    assert.equal(config.house, before.house);
    assert.equal(config.max_stake, before.max_stake);
    assert.equal(BigInt(await view("get_fees")), 0n);
    // What was settled before is still there, and shows that it paid no fee.
    const kept = await view("get_result", { id: "before-1" });
    assert.deepEqual({ ...kept, pot: undefined, fee: undefined }, { ...oldResult, pot: undefined, fee: undefined });
    assert.equal(BigInt(kept.fee), 0n);
    assert.equal(BigInt(kept.pot), stake * 2n);
    assert.deepEqual(await view("get_stats", { account_id: acc.alice.accountId }), oldStats);
    assert.deepEqual(await view("nft_token", { token_id: "before-1" }), oldDeed);
    await expectFail(createMatch(acc.alice, "before-1", { seats: 2, stake, split: [10000], rules: { salary: 200, cash: 1500, blitz: false, max_rounds: 1 } }), "match id already used");

    // A match after the upgrade pays the fee, and the owner can withdraw it.
    const newResult = await duel("after-1");
    const fee = feeOf(stake * 2n);
    assert.equal(BigInt(newResult.fee), fee);
    assert.deepEqual(newResult.payouts.map(BigInt), [((stake * 2n - fee) * 7000n) / 10000n, ((stake * 2n - fee) * 3000n) / 10000n]);
    assert.equal(BigInt(await view("get_fees")), fee);
    assert.equal(BigInt(returned(await call(acc.owner, "withdraw_fees", {}, 1n))), fee);
    // Only the contract account may call migrate, and the new state is not the first layout.
    await expectFail(call(acc.owner, "migrate", { fee_bps: 0 }), "Method migrate is private");
    await expectFail(call(old, "migrate", { fee_bps: 0 }), "Cannot deserialize the contract state");
    console.log(`  before: payouts ${oldResult.payouts.map(fmt).join(", ")}, no fee; open lobby: upgrade refused; after: fee_bps ${config.fee_bps}, old result, stats and Deed kept, payouts ${newResult.payouts.map(fmt).join(", ")}, fee ${fmt(fee)} withdrawn by the owner`);
  } finally {
    contractId = main;
  }
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
    await expectFail(game.functionCall({ contractId, methodName: "new", args: { owner: acc.owner.accountId, house: acc.house.accountId, max_stake: MAX_STAKE.toString(), fee_bps: 501 }, gas: GAS }), "fee_bps must be at most 500");
    await game.functionCall({ contractId, methodName: "new", args: { owner: acc.owner.accountId, house: acc.house.accountId, max_stake: MAX_STAKE.toString(), fee_bps: FEE_BPS }, gas: GAS });
    console.log(`deployed to ${contractId}: contract storage ${await storageUsage(contractId) - empty} bytes (code + state)`);
    await expectFail(acc.alice.functionCall({ contractId, methodName: "new", args: { owner: acc.alice.accountId, house: acc.alice.accountId, max_stake: "0", fee_bps: 0 }, gas: GAS }), "");

    const scenarios = [["a", scenarioSoloBlitz], ["b", scenarioClassicPlay], ["c", scenarioTimeout], ["d", scenarioAbandon], ["e", scenarioGasFloor], ["f", scenarioFees], ["h", scenarioWalletBatch]];
    const v1Path = process.env.DEEDLORDS_V1_WASM;
    if (v1Path) scenarios.push(["g", (a) => scenarioUpgrade(a, wasm, v1Path)]);
    else console.log("(g) upgrade from the first layout: skipped, set DEEDLORDS_V1_WASM to a wasm built before the fee existed");
    for (const [name, run] of scenarios) {
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
    console.log("heaviest calls of scenario (e), each sent with exactly the gas floor:");
    for (const line of floorReport) console.log(`  ${line}`);
    console.log(failed ? "\nRESULT: FAIL" : `\nRESULT: all ${scenarios.length} scenarios passed`);
  } finally {
    clearTimeout(watchdog);
    await stopSandbox(sandbox);
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("harness error:", e);
  process.exit(1);
});
