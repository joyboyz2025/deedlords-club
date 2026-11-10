// Deedlords on NEAR TESTNET: deploy the contract under an account you own, play real matches, measure real latency.
// Refuses mainnet. Private keys are read from / written to the NEAR credentials directory, never the repo, never printed.
//
//   node testnet.js --sandbox                              dry run of the same flow on a local near-sandbox
//   node testnet.js --sandbox-recover                      dry run of an interrupted run followed by a second run
//   DEEDLORDS_V1_WASM=<old wasm> node testnet.js --sandbox dry run of the upgrade: a run with the wasm from before the
//                                                          fee, then a run with the new one (deploy + migrate)
//   DEEDLORDS_PARENT=<you>.testnet node testnet.js plan    read-only: balances and the transactions `run` would sign
//   DEEDLORDS_PARENT=<you>.testnet node testnet.js run     signs on testnet
//
// The parent account is created by you, once (the faucet funds it):
//   near account create-account sponsor-by-faucet-service <you>.testnet autogenerate-new-keypair \
//     save-to-legacy-keychain network-config testnet create
//
// Environment: DEEDLORDS_PARENT (required outside --sandbox), DEEDLORDS_RPC (default https://test.rpc.fastnear.com),
// NEAR_CREDENTIALS_DIR (default ~/.near-credentials), DEEDLORDS_OUT (optional path for the JSON results),
// DEEDLORDS_RPC_GAP_MS (pause between two RPC requests on testnet, default 350).
//
// `run` can be repeated: it skips what exists, deletes the session keys an interrupted run left on p1/p2/house and
// finishes the matches that run left in play. A free public RPC answers HTTP 429 when asked too often, so requests are
// paced and a 429 is retried with a growing pause; pacing and retries stay outside the timings (a sample that needed a
// retry is counted in the report).
//
// What `run` does, in order:
//   1. creates game.<parent>, house.<parent>, p1.<parent>, p2.<parent> (skips the ones that exist)
//   2. deploys the wasm to game.<parent> and calls new(owner, house, max_stake, fee_bps) (skips what is already done);
//      over a deployment made before the fee existed: deploy + migrate(fee_bps) in one transaction
//   3. adds a FUNCTION-CALL access key ("session key") to p1, p2 and house: it can only call the play methods of the
//      game contract, cannot attach a deposit, and is what a browser would hold so that moves need no wallet prompt
//   4. plays: (B) a 2-seat classic match through play(), (A) a solo Blitz match against the house through turn(),
//      (C) a match whose turns are forced by timeout() from a third account. Every move is signed by a session key
//      with exactly the contract's gas floor (100 Tgas) attached. create_match and join carry a deposit, so they are
//      signed by the full-access key.
//   5. deletes the session keys and prints latency, gas, fees and balances.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { KeyPair, InMemorySigner, transactions, utils } = require("near-api-js");

const Y = 10n ** 24n;
const NEAR = (n) => (BigInt(Math.round(n * 1e6)) * Y) / 1_000_000n;
const TGAS = 10n ** 12n;
/// Exactly the contract's floor (MIN_MOVE_GAS): what a client attaches to join / play / turn / timeout.
const MOVE_GAS = 100n * TGAS;
const UA = "deedlords-dev-check/0.1";
const SESSION_METHODS = ["play", "turn", "timeout", "set_driver", "leave"];
/// The allowance wallets give a function-call key by default.
const SESSION_ALLOWANCE = NEAR(0.25);
const STAKE = NEAR(0.05);
const MAX_STAKE = NEAR(1);
/// The fee of the deployment: 2.5% of every pot, in basis points. Fixed by new() or migrate(); the contract caps it at 500.
const FEE_BPS = 250;
const STORAGE_DEPOSIT = NEAR(0.06);
/// Initial balance of each sub-account. `game` must cover the storage of the wasm (1e19 yocto per byte).
const FUND = { game: NEAR(5.6), house: NEAR(0.5), p1: NEAR(0.8), p2: NEAR(0.6) };
const PARENT_BUFFER = NEAR(0.3);
const ALL_CITIES = [1, 3, 6, 8, 9, 11, 13, 14, 16, 18, 19, 21, 23, 24, 26, 27, 29, 31, 32, 34, 37, 39];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (yocto) => {
  const v = BigInt(yocto);
  const a = v < 0n ? -v : v;
  return `${v < 0n ? "-" : ""}${a / Y}.${((a % Y) / 10n ** 18n).toString().padStart(6, "0")} NEAR`;
};
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};

let rpcUrl, networkId, credDir, game;
let rpcId = 0;
let rpcRetries = 0;
let rateLimited = 0;
/// Minimum pause between two RPC requests (0 on the local sandbox).
let rpcGapMs = 0;
let nextFreeAt = 0;
/// Dry run only: stop in the middle of the solo match and skip the cleanup, like a run that died.
let simulateCrash = false;
const samples = {}; // label -> [sample]
const viewMs = [];

// ----- RPC (plain fetch: no hidden retries or caches inside the timings) -------------------------------------------

/// Waits until the next request may leave. Called before a clock starts, so that pacing is never part of a timing.
async function gate() {
  const wait = nextFreeAt - Date.now();
  if (wait > 0) await sleep(wait);
}

async function rpcOnce(method, params, timeoutMs) {
  await gate();
  nextFreeAt = Date.now() + rpcGapMs;
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": UA },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const after = Number(res.headers.get("retry-after"));
    await res.text().catch(() => "");
    throw Object.assign(new Error(`RPC ${method}: HTTP ${res.status}`), { http: res.status, retryAfterMs: after > 0 ? after * 1000 : null });
  }
  const body = await res.json();
  if (body.error) {
    const name = body.error.cause?.name ?? body.error.name ?? "RPC_ERROR";
    const detail = JSON.stringify(body.error.data ?? body.error.cause?.info ?? body.error.message ?? "");
    throw Object.assign(new Error(`RPC ${method}: ${name}: ${detail.slice(0, 500)}`), { rpcName: name, detail });
  }
  return body.result;
}

/// Retries what is transient: a rate limit (HTTP 429), a gateway error, a network failure. A 429 from a public endpoint
/// can last a whole window, so the pauses grow to 30 s (or follow Retry-After) and add up to about a minute and a half.
async function rpc(method, params, { timeoutMs = 20000, tries = 9, retryTimeout = true } = {}) {
  for (let i = 0; ; i++) {
    try {
      return await rpcOnce(method, params, timeoutMs);
    } catch (e) {
      const transient = !e.rpcName && (e.http === 429 || e.http >= 500 || (retryTimeout && e.name === "TimeoutError") || e.name === "TypeError");
      if (!transient || i + 1 >= tries) throw e;
      rpcRetries++;
      if (e.http === 429 && !rateLimited++) console.log(`  (the RPC answered HTTP 429${e.retryAfterMs ? `, retry-after ${e.retryAfterMs / 1000} s` : ""}: backing off, the timings are not affected)`);
      await sleep(Math.min(60_000, e.retryAfterMs ?? Math.min(30_000, 500 * 2 ** i)) + Math.random() * 250);
    }
  }
}

async function viewAccount(id) {
  try {
    return await rpc("query", { request_type: "view_account", finality: "optimistic", account_id: id });
  } catch (e) {
    if (e.rpcName === "UNKNOWN_ACCOUNT") return null;
    throw e;
  }
}

async function viewKey(id, publicKey) {
  try {
    return await rpc("query", { request_type: "view_access_key", finality: "optimistic", account_id: id, public_key: publicKey.toString() });
  } catch (e) {
    if (e.rpcName === "UNKNOWN_ACCESS_KEY") return null;
    throw e;
  }
}

async function view(method, args = {}) {
  await gate();
  const t0 = performance.now();
  const r = await rpc("query", {
    request_type: "call_function",
    finality: "optimistic",
    account_id: game.id,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (method === "get_match") viewMs.push(performance.now() - t0);
  return JSON.parse(Buffer.from(r.result).toString());
}

const head = async () => {
  const b = await rpc("block", { finality: "optimistic" });
  return { height: b.header.height, ts: BigInt(b.header.timestamp_nanosec) };
};

const heights = new Map();
async function heightOf(blockHash, opts) {
  if (!heights.has(blockHash)) heights.set(blockHash, (await rpc("block", { block_id: blockHash }, opts)).header.height);
  return heights.get(blockHash);
}

// ----- keys (credentials directory only) ---------------------------------------------------------------------------

const credPath = (id) => path.join(credDir, networkId, `${id}.json`);
const shown = (p) => p.replace(os.homedir(), "~");

function loadKey(id) {
  const p = credPath(id);
  if (!fs.existsSync(p)) return null;
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  return KeyPair.fromString(j.private_key ?? j.secret_key);
}

function saveKey(id, kp) {
  fs.mkdirSync(path.dirname(credPath(id)), { recursive: true, mode: 0o700 });
  // "wx": never overwrite an existing key file.
  fs.writeFileSync(credPath(id), JSON.stringify({ account_id: id, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600, flag: "wx" });
}

// ----- signing and sending -----------------------------------------------------------------------------------------

/// A transaction is valid for a number of blocks after the block it names: 86,400 on testnet, but only 100 on the local
/// sandbox (about 12 s), hence the short cache there (60 s on testnet, to spare the RPC). It is read before the clock
/// starts, so it is not part of any timing.
let hashTtlMs = 4_000;
let hashCache = { at: 0, hash: null };
async function recentBlockHash() {
  if (Date.now() - hashCache.at > hashTtlMs) hashCache = { at: Date.now(), hash: (await rpc("block", { finality: "final" })).header.hash };
  return hashCache.hash;
}

/// One RPC read for the first transaction of a key, then counted locally: a move costs a single request.
async function nextNonce(s) {
  if (s.nonce === null) {
    const k = await viewKey(s.id, s.kp.getPublicKey());
    if (!k) throw new Error(`${s.id} has no such access key on chain`);
    s.nonce = BigInt(k.nonce);
  }
  s.nonce += 1n;
  return s.nonce;
}

async function sign(s, receiverId, actions) {
  const nonce = await nextNonce(s);
  const tx = transactions.createTransaction(s.id, s.kp.getPublicKey(), receiverId, nonce, actions, utils.serialize.base_decode(await recentBlockHash()));
  const signer = await InMemorySigner.fromKeyPair(networkId, s.id, s.kp);
  const [hash, signed] = await transactions.signTransaction(tx, signer, s.id, networkId);
  return { hash: utils.serialize.base_encode(hash), b64: Buffer.from(signed.encode()).toString("base64") };
}

async function waitTx(hash, senderId, level) {
  const until = Date.now() + 120_000;
  for (;;) {
    try {
      return await rpc("tx", { tx_hash: hash, sender_account_id: senderId, wait_until: level }, { timeoutMs: 30000 });
    } catch (e) {
      if (!(e.rpcName === "TIMEOUT_ERROR" || e.rpcName === "UNKNOWN_TRANSACTION") || Date.now() > until) throw e;
      await sleep(200);
    }
  }
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

/// Signs and sends one transaction and measures it: wall-clock from "request sent" to "executed" (what a client waits
/// for before it can show the result) and to "final". The same in blocks is filled in by fillHeights(), after the clocks.
async function measureTx(s, receiverId, actions) {
  const head0 = (await head()).height;
  const { hash, b64 } = await sign(s, receiverId, actions);
  await gate();
  const retries0 = rpcRetries;
  const t0 = performance.now();
  try {
    // Sending the same signed transaction again is harmless (same hash), so a 429 here is simply retried.
    await rpc("send_tx", { signed_tx_base64: b64, wait_until: "EXECUTED_OPTIMISTIC" }, { timeoutMs: 60000, retryTimeout: false });
  } catch (e) {
    if (e.rpcName !== "TIMEOUT_ERROR" && e.name !== "TimeoutError") {
      s.nonce = null; // not accepted: re-read the nonce next time
      throw e;
    }
    await waitTx(hash, s.id, "EXECUTED_OPTIMISTIC");
  }
  const msExec = performance.now() - t0;
  const fin = await waitTx(hash, s.id, "FINAL");
  const msFinal = performance.now() - t0;

  const all = [fin.transaction_outcome, ...fin.receipts_outcome];
  const failure = fin.status.Failure ?? null;
  const text = Buffer.from(fin.status.SuccessValue ?? "", "base64").toString();
  let value = null;
  try {
    value = text ? JSON.parse(text) : null;
  } catch (_) {}
  const sample = {
    hash,
    signer: s.id,
    session: Boolean(s.session),
    ok: !failure,
    error: failure ? JSON.stringify(failure).slice(0, 400) : null,
    msExec,
    msFinal,
    head0,
    inclBlock: fin.transaction_outcome.block_hash,
    receiptBlocks: fin.receipts_outcome.map((r) => r.block_hash),
    toIncl: null,
    inclToExec: null,
    inclToLast: null,
    gasBurnt: all.reduce((a, o) => a + BigInt(o.outcome.gas_burnt), 0n),
    contractGas: fin.receipts_outcome.length ? BigInt(fin.receipts_outcome[0].outcome.gas_burnt) : 0n,
    tokensBurnt: all.reduce((a, o) => a + BigInt(o.outcome.tokens_burnt), 0n),
    retried: rpcRetries > retries0,
    events: eventsOf(fin),
    value,
  };
  if (eagerHeights) await fillHeights(sample, { tries: 2 }).catch(() => {});
  return sample;
}

function record(label, sample) {
  (samples[label] ??= []).push(sample);
  return sample;
}

/// The local sandbox forgets a block about a minute after producing it, so there the heights are read right after each
/// transaction (once its clocks have stopped). On testnet they are read at the end instead, to spare the public RPC.
let eagerHeights = false;

/// Block heights of one sample's outcomes. Bookkeeping only: nothing here is timed.
async function fillHeights(s, opts) {
  const inclH = await heightOf(s.inclBlock, opts);
  let lastH = inclH;
  for (const b of s.receiptBlocks) lastH = Math.max(lastH, await heightOf(b, opts));
  const execH = s.receiptBlocks.length ? await heightOf(s.receiptBlocks[0], opts) : inclH;
  s.toIncl = inclH - s.head0;
  s.inclToExec = execH - inclH;
  s.inclToLast = lastH - inclH;
}

/// Fills in the block heights still missing, once the matches are over. These lookups never abort a run: a height that
/// cannot be read leaves the block columns of that sample empty. Returns how many stayed empty.
async function resolveHeights() {
  let unknown = 0;
  let first = null;
  let stop = false;
  const gap = rpcGapMs;
  rpcGapMs = gap * 2; // nothing is timed here: ask slowly
  for (const s of Object.values(samples).flat()) {
    if (s.toIncl !== null) continue;
    if (!stop) {
      try {
        await fillHeights(s);
        continue;
      } catch (e) {
        first ??= e;
        // An answer from the node ("unknown block") concerns this sample only. No answer at all, after the retries
        // inside rpc() have already waited about a minute and a half, ends the pass.
        if (!e.rpcName) stop = true;
      }
    }
    unknown++;
  }
  rpcGapMs = gap;
  if (first) console.log(`  (block lookup: ${first.rpcName ?? first.name}: ${String(first.message).slice(0, 200)})`);
  return unknown;
}

/// A setup transaction (account, deploy, key): must succeed.
async function setupTx(label, s, receiverId, actions) {
  const sample = record(`setup: ${label}`, await measureTx(s, receiverId, actions));
  if (!sample.ok) throw new Error(`${label} failed: ${sample.error}`);
  console.log(`  ${label}: tx ${sample.hash} (${(sample.msExec / 1000).toFixed(2)} s)`);
  return sample;
}

/// A call into the game contract. The label gets a suffix when the call was rejected or settled the match.
async function call(s, method, args, { deposit = 0n, label = method } = {}) {
  const sample = await measureTx(s, game.id, [transactions.functionCall(method, args, MOVE_GAS, deposit)]);
  const settled = sample.events.some((e) => e.event === "settle");
  record(!sample.ok ? `${label} (rejected)` : settled ? `${label} (settles + pays out)` : label, sample);
  return sample;
}

async function must(promise, what) {
  const sample = await promise;
  if (!sample.ok) throw new Error(`${what} failed: ${sample.error}`);
  return sample;
}

/// Sends a transaction that validation must refuse; returns the reason. Nothing reaches the chain, nothing is charged.
async function refused(s, receiverId, actions) {
  try {
    const { b64 } = await sign(s, receiverId, actions);
    await rpc("send_tx", { signed_tx_base64: b64, wait_until: "INCLUDED" }, { timeoutMs: 30000 });
  } catch (e) {
    s.nonce = null;
    if (e.rpcName) return `${e.rpcName} ${e.detail}`.slice(0, 200);
    throw e;
  }
  s.nonce = null;
  return null; // accepted: the caller treats this as a failed check
}

// ----- setup -------------------------------------------------------------------------------------------------------

async function ensureAccount(parent, sub, amount, plan) {
  const id = `${sub}.${parent.id}`;
  const onChain = await viewAccount(id);
  let kp = loadKey(id);
  if (onChain && !kp) throw new Error(`${id} exists but its key is not in ${shown(credPath(id))}`);
  if (plan) return { id, kp, nonce: null, exists: Boolean(onChain), amount: onChain ? BigInt(onChain.amount) : null };
  if (!onChain) {
    if (!kp) {
      kp = KeyPair.fromRandom("ed25519");
      saveKey(id, kp); // on disk before the account exists, so a crash cannot orphan it
    }
    await setupTx(`create ${id} with ${fmt(amount)}`, parent, id, [transactions.createAccount(), transactions.transfer(amount), transactions.addKey(kp.getPublicKey(), transactions.fullAccessKey())]);
  }
  return { id, kp, nonce: null };
}

async function addSessionKey(acc) {
  const kp = KeyPair.fromRandom("ed25519"); // lives in memory only, like a browser session
  await setupTx(`add session key to ${acc.id}`, acc, acc.id, [transactions.addKey(kp.getPublicKey(), transactions.functionCallAccessKey(game.id, SESSION_METHODS, SESSION_ALLOWANCE))]);
  return { id: acc.id, kp, nonce: null, session: true, owner: acc };
}

const allowanceOf = async (s) => {
  const k = await viewKey(s.id, s.kp.getPublicKey());
  return k ? BigInt(k.permission.FunctionCall.allowance) : null;
};

/// Deletes every function-call key for the game contract on the account: the one this run added and any that an
/// interrupted run left behind (their private halves lived in memory only, so nobody holds them). Returns the count.
async function sweepSessionKeys(a) {
  const list = await rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: a.id });
  const stale = list.keys.filter((k) => k.access_key.permission?.FunctionCall?.receiver_id === game.id);
  if (!stale.length) return 0;
  await setupTx(`delete ${stale.length} session key(s) of ${a.id}`, a, a.id, stale.map((k) => transactions.deleteKey(utils.PublicKey.fromString(k.public_key))));
  return stale.length;
}

// ----- scenarios ---------------------------------------------------------------------------------------------------

const createMatch = (creator, id, o) =>
  must(call(creator, "create_match", { id, seats: o.seats, stake: STAKE.toString(), split: o.split, rules: o.rules, solo_player: o.solo ?? null, turn_seconds: o.turnSeconds }, { deposit: STORAGE_DEPOSIT }), "create_match");

async function printResult(id) {
  const r = await view("get_result", { id });
  console.log(`  settled (${r.reason}); backers by rank: ${r.backers.join(" > ")}; payouts ${r.payouts.map(fmt).join(", ")}${BigInt(r.fee ?? 0) > 0n ? `; fee ${fmt(r.fee)}` : ""}${BigInt(r.forfeited ?? 0) > 0n ? `; forfeited to the contract ${fmt(r.forfeited)}` : ""}`);
}

/// (B) 2-seat classic match, every move through play() signed by the session key of the seat's backer.
async function scenarioClassic(acc, tag) {
  const id = `${tag}-duo`;
  console.log(`\n(B) 2-seat classic match "${id}" through play(), moves signed by session keys`);
  await createMatch(acc.p1, id, { seats: 2, split: [7000, 3000], rules: { salary: 200, cash: 1500, blitz: false, max_rounds: 2 }, turnSeconds: 60 });
  await must(call(acc.p1, "join", { id, seat: 0 }, { deposit: STAKE }), "join");
  await must(call(acc.p2, "join", { id, seat: 1 }, { deposit: STAKE, label: "join (last seat: starts the game)" }), "join");
  const session = { [acc.p1.id]: acc.s1, [acc.p2.id]: acc.s2 };
  let calls = 0;
  for (; calls < 300; calls++) {
    const m = await view("get_match", { id });
    if (m === null) break;
    const g = m.game;
    const seat = m.meta.current_seat;
    const signer = session[m.meta.seats[seat].backer];
    const me = g.players.find((p) => p.id === `s${seat}`);
    let actions;
    if (g.stage === "roll") actions = me.jail !== null && me.cash >= 50 ? ["Bail", "Roll"] : ["Roll"];
    else if (g.stage === "buy") actions = me.cash > 400 ? ["Buy", g.again ? "Roll" : "End"] : ["Skip"];
    else if (g.stage === "end") actions = [g.again ? "Roll" : "End"];
    else {
      const owed = g.debt.reduce((a, d) => a + d.amount, 0);
      const mine = Object.entries(g.props).filter(([, o]) => o.owner === `s${seat}`);
      const house = mine.find(([, o]) => o.houses > 0);
      const free = mine.find(([, o]) => !o.mortgaged && o.houses === 0);
      actions = me.cash >= owed ? ["Pay"] : house ? [{ Sell: Number(house[0]) }] : free ? [{ Mortgage: Number(free[0]) }] : ["Bankrupt"];
    }
    let s = await call(signer, "play", { id, seat, actions });
    if (!s.ok && g.stage === "buy") s = await call(signer, "play", { id, seat, actions: ["Skip"] });
    if (!s.ok) throw new Error(`play ${JSON.stringify(actions)} failed: ${s.error}`);
  }
  if (calls >= 300) throw new Error("the classic match did not settle");
  console.log(`  ${calls} play() calls`);
  await printResult(id);
}

/// (A) solo Blitz: p1 against one house seat, every turn through turn() signed by a session key.
async function scenarioSolo(acc, tag) {
  const id = `${tag}-solo`;
  console.log(`\n(A) solo Blitz match "${id}" (p1 + 1 house seat) through turn(), moves signed by session keys`);
  await createMatch(acc.p1, id, { seats: 2, split: [7000, 3000], rules: { salary: 200, cash: 2000, blitz: true, max_rounds: 3 }, solo: acc.p1.id, turnSeconds: 60 });
  await must(call(acc.house, "join", { id, seat: 1 }, { deposit: STAKE }), "join (house)");
  await must(call(acc.p1, "join", { id, seat: 0 }, { deposit: STAKE, label: "join (last seat: starts the game)" }), "join");
  const session = { [acc.p1.id]: acc.s1, [acc.house.id]: acc.sh };
  const turns = await driveTurns(id, session, simulateCrash ? 3 : 200);
  if (simulateCrash) throw new Error("simulated crash in the middle of the solo match");
  if (turns >= 200) throw new Error("the solo match did not settle");
  console.log(`  ${turns} turn() calls`);
  await printResult(id);
}

const PLAN = { buy_reserve: 150, build: ALL_CITIES, keep_reserve: 250, bail: true, liquidate: [] };

/// Plays whole turns through turn() until the match settles or `max` calls were made; returns the number of calls.
async function driveTurns(id, session, max) {
  let turns = 0;
  for (; turns < max; turns++) {
    const m = await view("get_match", { id });
    if (m === null) break;
    const seat = m.meta.current_seat;
    await must(call(session[m.meta.seats[seat].backer], "turn", { id, seat, plan: PLAN }), "turn");
  }
  return turns;
}

/// Matches an interrupted run left behind. The ones in play between our own accounts are finished through turn(), so
/// that their stakes are paid out; anything else is only listed (a lobby can be abandoned 15 minutes after creation).
async function finishLeftovers(acc) {
  const session = { [acc.p1.id]: acc.s1, [acc.p2.id]: acc.s2, [acc.house.id]: acc.sh };
  const open = await view("list_matches", { from_index: 0, limit: 50 });
  for (const meta of open) {
    const ours = meta.seats.every((s) => session[s.backer]);
    if (String(meta.status).toLowerCase() !== "playing" || !ours) {
      console.log(`\n(leftover) match "${meta.id}" (${meta.status}) is left as it is`);
      continue;
    }
    console.log(`\n(leftover) match "${meta.id}" from an interrupted run: finishing it through turn(), moves signed by session keys`);
    try {
      const turns = await driveTurns(meta.id, session, 200);
      if (turns >= 200) throw new Error("it did not settle");
      console.log(`  ${turns} turn() calls`);
      await printResult(meta.id);
    } catch (e) {
      console.log(`  could not finish it: ${e.message}`);
    }
  }
}

/// (C) nobody moves: a third account forces every step with timeout() once the turn deadline has passed.
async function scenarioTimeout(acc, tag, third) {
  const id = `${tag}-late`;
  const turnSeconds = 8;
  console.log(`\n(C) match "${id}" with a ${turnSeconds} s turn clock: every step forced by timeout() from ${third.id}`);
  await createMatch(acc.p1, id, { seats: 2, split: [10000], rules: { salary: 200, cash: 1500, blitz: false, max_rounds: 1 }, turnSeconds });
  await must(call(acc.p1, "join", { id, seat: 0 }, { deposit: STAKE }), "join");
  await must(call(acc.p2, "join", { id, seat: 1 }, { deposit: STAKE, label: "join (last seat: starts the game)" }), "join");
  let forced = 0;
  let waits = 0;
  for (; forced < 60; forced++) {
    const m = await view("get_match", { id });
    if (m === null) break;
    const deadline = BigInt(m.meta.turn_deadline);
    let now = (await head()).ts;
    if (now <= deadline) waits++;
    while (now <= deadline) {
      // Sleep for what is left on the chain's clock instead of polling the RPC.
      await sleep(Math.max(500, Number(deadline - now) / 1e6 + 300));
      now = (await head()).ts;
    }
    await must(call(third, "timeout", { id }), "timeout");
  }
  if (forced >= 60) throw new Error("the timeout match did not settle");
  console.log(`  ${forced} timeout() calls, ${waits} waits for a deadline`);
  await printResult(id);
}

// ----- report ------------------------------------------------------------------------------------------------------

function report() {
  const rows = [];
  const line = (label, list) => {
    // A sample whose requests had to be retried (rate limit, network) carries the pause in its clock: left out here.
    const ms = (pick) => {
      const xs = list.filter((s) => !s.retried).map(pick);
      return xs.length ? `${(median(xs) / 1000).toFixed(2)} (${(Math.min(...xs) / 1000).toFixed(2)}-${(Math.max(...xs) / 1000).toFixed(2)})` : "n/a";
    };
    const blocks = (pick) => {
      const xs = list.map(pick).filter((x) => x !== null);
      return xs.length ? `${median(xs)} (${Math.min(...xs)}-${Math.max(...xs)})` : "n/a";
    };
    const tg = list.map((s) => Number(s.gasBurnt) / 1e12);
    const fee = list.map((s) => Number(s.tokensBurnt) / 1e21);
    rows.push({
      call: label,
      n: list.length,
      "executed s med (min-max)": ms((s) => s.msExec),
      "final s": ms((s) => s.msFinal),
      "blocks to inclusion": blocks((s) => s.toIncl),
      "+blocks to contract result": blocks((s) => s.inclToExec),
      "+blocks to last receipt": blocks((s) => s.inclToLast),
      "gas Tgas med/max": `${median(tg).toFixed(2)} / ${Math.max(...tg).toFixed(2)}`,
      "fee mNEAR med/max": `${median(fee).toFixed(3)} / ${Math.max(...fee).toFixed(3)}`,
    });
  };
  for (const [label, list] of Object.entries(samples)) line(label, list);
  console.table(rows);
}

// ----- main flow ---------------------------------------------------------------------------------------------------

async function flow(mode, parentId, wasmPath) {
  const wasm = fs.readFileSync(wasmPath);
  const digest = crypto.createHash("sha256").update(wasm).digest();
  const wasmHash = utils.serialize.base_encode(digest);
  const status = await rpc("status", []);
  if (status.chain_id === "mainnet") throw new Error("this script never runs on mainnet");
  if (networkId === "testnet" && status.chain_id !== "testnet") throw new Error(`expected chain testnet, the RPC reports ${status.chain_id}`);
  console.log(`network ${status.chain_id} (protocol ${status.protocol_version}) through ${rpcUrl}`);
  console.log(`wasm ${wasmPath}: ${wasm.length} bytes, sha256 ${digest.toString("hex")} (code hash ${wasmHash})`);

  const parentKp = loadKey(parentId);
  if (!parentKp) throw new Error(`no key for ${parentId} at ${shown(credPath(parentId))}: create the account first (see the top of this file)`);
  const parent = { id: parentId, kp: parentKp, nonce: null };
  const parentAccount = await viewAccount(parentId);
  if (!parentAccount) throw new Error(`${parentId} does not exist on ${status.chain_id}`);
  const parentKey = await viewKey(parentId, parentKp.getPublicKey());
  if (!parentKey || parentKey.permission !== "FullAccess") throw new Error(`the key in ${shown(credPath(parentId))} is not a full-access key of ${parentId}`);

  // ---- plan: read-only ----
  const planned = {};
  for (const sub of Object.keys(FUND)) planned[sub] = await ensureAccount(parent, sub, FUND[sub], true);
  const toFund = Object.keys(FUND).filter((s) => !planned[s].exists).reduce((a, s) => a + FUND[s], 0n);
  const parentFree = BigInt(parentAccount.amount) - BigInt(parentAccount.storage_usage) * 10n ** 19n;
  console.log("\nACCOUNTS");
  console.log(`  parent  ${parentId}: ${fmt(parentAccount.amount)} (key ${shown(credPath(parentId))})`);
  for (const sub of Object.keys(FUND)) {
    const p = planned[sub];
    console.log(`  ${sub.padEnd(7)} ${p.id}: ${p.exists ? `exists, ${fmt(p.amount)}` : `to create with ${fmt(FUND[sub])}`} (key ${shown(credPath(p.id))})`);
  }
  console.log(`  needs ${fmt(toFund + PARENT_BUFFER)} free on the parent (new accounts ${fmt(toFund)} + ${fmt(PARENT_BUFFER)} for fees); it has ${fmt(parentFree)} free`);
  console.log("\nTRANSACTIONS `run` signs, in order");
  console.log("  1. parent: create each missing sub-account above (create account + transfer + its own full-access key)");
  console.log(`  2. game: deploy the wasm (skipped when the code hash already matches), then new(owner=${parentId}, house=${planned.house.id}, max_stake=${fmt(MAX_STAKE)}, fee_bps=${FEE_BPS})`);
  console.log(`     if it runs the contract from before the fee: deploy + migrate(fee_bps=${FEE_BPS}) in ONE transaction instead (refused while a match is open; what was settled is kept)`);
  console.log(`  3. p1, p2, house: add a function-call key each: receiver ${planned.game.id}, methods ${SESSION_METHODS.join("/")}, allowance ${fmt(SESSION_ALLOWANCE)}`);
  console.log(`  4. three matches, stake ${fmt(STAKE)} per seat, storage deposit ${fmt(STORAGE_DEPOSIT)} per match (refunded at settlement):`);
  console.log("     create_match and join signed by full-access keys (they carry a deposit); play/turn signed by session keys;");
  console.log(`     timeout signed by the parent as a third account; every call with ${MOVE_GAS / TGAS} Tgas attached`);
  console.log("  5. p1, p2, house: delete the session keys");
  if (mode === "plan") return null;
  if (parentFree < toFund + PARENT_BUFFER) throw new Error("the parent account cannot fund the plan above");

  // ---- 1. accounts ----
  console.log("\nSETUP");
  const before = {};
  const acc = {};
  for (const sub of Object.keys(FUND)) acc[sub] = await ensureAccount(parent, sub, FUND[sub], false);
  game = acc.game;
  const ids = { parent: parent.id, game: acc.game.id, house: acc.house.id, p1: acc.p1.id, p2: acc.p2.id };
  for (const [name, id] of Object.entries(ids)) before[name] = BigInt((await viewAccount(id)).amount);

  // ---- 2. deploy + init ----
  const gameAccount = await viewAccount(game.id);
  const fresh = gameAccount.code_hash === "11111111111111111111111111111111";
  let config = fresh ? null : await view("get_config").catch(() => null);
  if (gameAccount.code_hash === wasmHash) console.log(`  ${game.id} already runs this wasm`);
  else if (config && config.fee_bps === undefined) {
    // The contract from before the fee: its state has another layout. New code alone would leave it unreadable, so the
    // deploy and migrate() go in one transaction: both happen or neither does.
    if (config.matches > 0) throw new Error(`${game.id} has ${config.matches} open match(es): finish or abandon them before upgrading (migrate() refuses otherwise)`);
    console.log(`  ${game.id} runs the contract from before the fee (${gameAccount.code_hash}): upgrading in place`);
    await setupTx(`deploy ${wasm.length} bytes to ${game.id} + migrate(fee_bps=${FEE_BPS})`, game, game.id, [transactions.deployContract(wasm), transactions.functionCall("migrate", { fee_bps: FEE_BPS }, MOVE_GAS, 0n)]);
    config = await view("get_config");
    if (config.fee_bps !== FEE_BPS) throw new Error(`after migrate() the contract reports fee_bps ${config.fee_bps}`);
  } else {
    if (!fresh) console.log(`  WARNING: replacing other code on ${game.id} (${gameAccount.code_hash}); its state is kept`);
    await setupTx(`deploy ${wasm.length} bytes to ${game.id}`, game, game.id, [transactions.deployContract(wasm)]);
    config = await view("get_config").catch(() => null);
  }
  if (!config) {
    await setupTx("new(owner, house, max_stake, fee_bps)", game, game.id, [transactions.functionCall("new", { owner: parent.id, house: acc.house.id, max_stake: MAX_STAKE.toString(), fee_bps: FEE_BPS }, MOVE_GAS, 0n)]);
    config = await view("get_config");
  }
  console.log(`  config: ${JSON.stringify(config)}`);
  console.log(`  ${game.id}: ${(await viewAccount(game.id)).storage_usage} bytes of storage, ${fmt((await viewAccount(game.id)).amount)}`);

  // ---- baseline ----
  await head();
  const rtt = [];
  for (let i = 0; i < 8; i++) {
    await gate();
    const t0 = performance.now();
    await head();
    rtt.push(performance.now() - t0);
  }
  const tip = await rpc("block", { finality: "final" });
  // Up to 100 blocks back; a height can be missing (skipped block) or not exist yet (fresh sandbox), so step until one answers.
  let back = null;
  for (let h = Math.max(1, tip.header.height - 100), i = 0; !back && i < 8 && h < tip.header.height; h++, i++) {
    back = await rpc("block", { block_id: h }, { tries: 1 }).catch(() => null);
  }
  const span = back ? tip.header.height - back.header.height : 0;
  const blockMs = span ? Number(BigInt(tip.header.timestamp_nanosec) - BigInt(back.header.timestamp_nanosec)) / 1e6 / span : NaN;
  const gasPrice = (await rpc("gas_price", [null])).gas_price;
  console.log(`\nBASELINE  RPC round trip ${median(rtt).toFixed(0)} ms median (${Math.min(...rtt).toFixed(0)}-${Math.max(...rtt).toFixed(0)}); block time ${blockMs.toFixed(0)} ms over the last ${span} blocks; gas price ${gasPrice} yocto/gas`);

  // ---- 3. session keys ----
  console.log("\nSESSION KEYS");
  const holders = [acc.p1, acc.p2, acc.house];
  for (const a of holders) {
    if (await sweepSessionKeys(a)) console.log(`    (left on ${a.id} by an interrupted run)`);
  }
  acc.s1 = await addSessionKey(acc.p1);
  acc.s2 = await addSessionKey(acc.p2);
  acc.sh = await addSessionKey(acc.house);
  const checks = {};
  let failed = null;
  try {
    const tag = `t${Date.now().toString(36)}`;
    // What the session key must NOT be able to do: both are refused before reaching the chain, at no cost.
    checks.joinWithDeposit = await refused(acc.s1, game.id, [transactions.functionCall("join", { id: "x", seat: 0 }, MOVE_GAS, STAKE)]);
    checks.otherMethod = await refused(acc.s1, game.id, [transactions.functionCall("create_match", { id: "x" }, MOVE_GAS, 0n)]);
    checks.transfer = await refused(acc.s1, parent.id, [transactions.transfer(NEAR(0.01))]);
    console.log(`  session key + deposit (join): ${checks.joinWithDeposit ?? "ACCEPTED (unexpected)"}`);
    console.log(`  session key + method outside its list: ${checks.otherMethod ?? "ACCEPTED (unexpected)"}`);
    console.log(`  session key + plain transfer: ${checks.transfer ?? "ACCEPTED (unexpected)"}`);
    if (Object.values(checks).some((v) => v === null)) throw new Error("a session key was able to do more than play");

    const allowance0 = await allowanceOf(acc.s1);
    await finishLeftovers(acc);
    await scenarioClassic(acc, tag);
    await scenarioSolo(acc, tag);
    await scenarioTimeout(acc, tag, parent);

    // Allowance: did the gas refunds come back to the key, or did every move eat the full 100 Tgas?
    await sleep(4000);
    const allowance1 = await allowanceOf(acc.s1);
    const mine = Object.values(samples).flat().filter((s) => s.session && s.signer === acc.p1.id);
    const burnt = mine.reduce((a, s) => a + s.tokensBurnt, 0n);
    const prepaid = BigInt(mine.length) * MOVE_GAS * BigInt(gasPrice);
    checks.allowance = { before: allowance0.toString(), after: allowance1.toString(), spent: (allowance0 - allowance1).toString(), moves: mine.length, tokensBurnt: burnt.toString(), prepaidIfNotRefunded: prepaid.toString() };
    console.log(`\nSESSION KEY ALLOWANCE (p1): ${fmt(allowance0)} -> ${fmt(allowance1)} after ${mine.length} moves`);
    console.log(`  spent ${fmt(allowance0 - allowance1)}; fees actually burnt by those moves ${fmt(burnt)}; 100 Tgas x ${mine.length} would be ${fmt(prepaid)}`);
    console.log(`  => ${allowance0 - allowance1 === burnt ? "only the burnt fee is taken from the allowance: gas refunds return to the key" : "the allowance moved by something other than the burnt fees: see the numbers above"}`);
    if (allowance0 !== allowance1 && mine.length) console.log(`  one allowance of ${fmt(SESSION_ALLOWANCE)} lasts about ${(SESSION_ALLOWANCE * BigInt(mine.length)) / (allowance0 - allowance1)} moves at this rate`);
  } catch (e) {
    failed = e;
  } finally {
    console.log("\nCLEANUP");
    if (simulateCrash) console.log("  skipped (simulated crash): the session keys stay on the accounts");
    for (const a of simulateCrash ? [] : holders) {
      for (let attempt = 1; ; attempt++) {
        try {
          if (!(await sweepSessionKeys(a))) console.log(`  ${a.id}: no session key to delete`);
          break;
        } catch (e) {
          console.log(`  could not delete the session keys of ${a.id} (attempt ${attempt} of 3): ${e.message}`);
          if (attempt >= 3) {
            checks.sessionKeysLeftOn = [...(checks.sessionKeysLeftOn ?? []), a.id];
            break;
          }
          a.nonce = null;
          await sleep(5000);
        }
      }
    }
  }

  const unknownHeights = await resolveHeights();
  console.log("\n================ MEASUREMENTS ================");
  report();
  if (unknownHeights) console.log(`note: the block heights of ${unknownHeights} sample(s) could not be read; they are left out of the block columns`);
  if (viewMs.length) console.log(`view get_match: n=${viewMs.length}, median ${median(viewMs).toFixed(0)} ms (${Math.min(...viewMs).toFixed(0)}-${Math.max(...viewMs).toFixed(0)})`);
  const moves = Object.values(samples).flat().filter((s) => s.session);
  console.log(`moves signed by a session key (no deposit, ${MOVE_GAS / TGAS} Tgas attached): ${moves.length}, of which rejected by the contract: ${moves.filter((s) => !s.ok).length}`);
  if (rpcRetries) console.log(`note: ${rpcRetries} RPC request(s) were retried (${rateLimited} of them after HTTP 429); ${Object.values(samples).flat().filter((s) => s.retried).length} sample(s) had a retry inside their clock and are left out of the two time columns`);
  await sleep(3000);
  const after = {};
  console.log("BALANCES (before -> after this run)");
  let net = 0n;
  for (const [name, id] of Object.entries(ids)) {
    after[name] = BigInt((await viewAccount(id)).amount);
    net += after[name] - before[name];
    console.log(`  ${name.padEnd(7)} ${id}: ${fmt(before[name])} -> ${fmt(after[name])} (${after[name] >= before[name] ? "+" : ""}${fmt(after[name] - before[name])})`);
  }
  console.log(`  all five together: ${fmt(net)} (fees burnt by this run, sub-account creation excluded)`);

  const result = {
    at: new Date().toISOString(),
    chain: status.chain_id,
    protocol: status.protocol_version,
    rpc: rpcUrl,
    contract: game.id,
    wasmBytes: wasm.length,
    wasmSha256: digest.toString("hex"),
    baseline: { rpcRoundTripMs: rtt, blockMs, gasPrice },
    checks,
    viewMs,
    rpcRetries,
    rateLimited,
    rpcGapMs,
    balances: Object.fromEntries(Object.keys(ids).map((k) => [k, { id: ids[k], before: before[k].toString(), after: after[k].toString() }])),
    samples: Object.fromEntries(Object.entries(samples).map(([label, list]) => [label, list.map(({ events, value, ...s }) => ({ ...s, gasBurnt: s.gasBurnt.toString(), contractGas: s.contractGas.toString(), tokensBurnt: s.tokensBurnt.toString() }))])),
  };
  if (process.env.DEEDLORDS_OUT) {
    fs.writeFileSync(process.env.DEEDLORDS_OUT, JSON.stringify(result, null, 2));
    console.log(`results written to ${process.env.DEEDLORDS_OUT}`);
  }
  if (failed) throw failed;
  return result;
}

// ----- entry points ------------------------------------------------------------------------------------------------

/// near-sandbox 0.3.5 cannot stop the 2.14 node (see run.js): SIGTERM, SIGKILL after 5 s, unlock the ports, remove the home.
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

async function dryRun(wasmPath, recover) {
  const { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } = require("near-sandbox");
  console.log("DRY RUN on a local near-sandbox: nothing here touches testnet");
  eagerHeights = true;
  const sandbox = await Sandbox.start({});
  const ownDir = !process.env.NEAR_CREDENTIALS_DIR;
  credDir = process.env.NEAR_CREDENTIALS_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "deedlords-dry-"));
  const stop = async () => {
    await stopSandbox(sandbox);
    if (ownDir) fs.rmSync(credDir, { recursive: true, force: true });
  };
  process.once("SIGINT", () => stop().then(() => process.exit(1)));
  process.once("SIGTERM", () => stop().then(() => process.exit(1)));
  try {
    rpcUrl = sandbox.rpcUrl;
    networkId = "sandbox";
    // Stand-in for the faucet: a parent account holding 10 NEAR, its key in the (temporary) credentials directory.
    const parentId = `parent.${DEFAULT_ACCOUNT_ID}`;
    fs.rmSync(path.join(credDir, networkId), { recursive: true, force: true });
    const kp = KeyPair.fromRandom("ed25519");
    saveKey(parentId, kp);
    const root = { id: DEFAULT_ACCOUNT_ID, kp: KeyPair.fromString(DEFAULT_PRIVATE_KEY), nonce: null };
    const made = await measureTx(root, parentId, [transactions.createAccount(), transactions.transfer(NEAR(10)), transactions.addKey(kp.getPublicKey(), transactions.fullAccessKey())]);
    if (!made.ok) throw new Error(`could not create ${parentId}: ${made.error}`);
    const v1Path = process.env.DEEDLORDS_V1_WASM;
    if (v1Path) {
      // What testnet looks like today: a first run deployed the wasm from before the fee and settled its matches.
      console.log(`\nFIRST RUN with ${v1Path} (the contract from before the fee)`);
      await flow("run", parentId, v1Path);
      console.log("\n================ SECOND RUN: the new wasm over it ================");
      for (const label of Object.keys(samples)) delete samples[label];
      viewMs.length = 0;
    }
    if (recover) {
      // First run dies in the middle of the solo match and leaves its session keys; the second one must clean up.
      simulateCrash = true;
      await flow("run", parentId, wasmPath).then(
        () => Promise.reject(new Error("the simulated crash did not happen")),
        (e) => console.log(`\nFIRST RUN ENDED AS PLANNED: ${e.message}\n\n================ SECOND RUN ================`),
      );
      simulateCrash = false;
      for (const label of Object.keys(samples)) delete samples[label];
      viewMs.length = 0;
    }
    await flow("run", parentId, wasmPath);
  } finally {
    await stop();
  }
}

(async () => {
  const args = process.argv.slice(2);
  const wasmPath = args.find((a) => a.endsWith(".wasm")) ?? path.join(__dirname, "../target/wasm32-unknown-unknown/release/deedlords.wasm");
  const watchdog = setTimeout(() => {
    console.error("watchdog: 25 minutes, giving up");
    process.exit(1);
  }, 25 * 60 * 1000);
  if (args.includes("--sandbox") || args.includes("--sandbox-recover")) await dryRun(wasmPath, args.includes("--sandbox-recover"));
  else {
    const mode = args.find((a) => a === "plan" || a === "run");
    const parentId = process.env.DEEDLORDS_PARENT;
    if (!mode || !parentId) {
      console.error("usage: DEEDLORDS_PARENT=<you>.testnet node testnet.js plan|run   (or: node testnet.js --sandbox | --sandbox-recover)");
      process.exit(2);
    }
    if (!parentId.endsWith(".testnet")) throw new Error("DEEDLORDS_PARENT must be a .testnet account: this script never runs on mainnet");
    networkId = "testnet";
    rpcGapMs = Number(process.env.DEEDLORDS_RPC_GAP_MS ?? 350);
    if (!(rpcGapMs >= 0 && rpcGapMs <= 10_000)) throw new Error("DEEDLORDS_RPC_GAP_MS must be between 0 and 10000");
    hashTtlMs = 60_000;
    rpcUrl = process.env.DEEDLORDS_RPC ?? "https://test.rpc.fastnear.com";
    credDir = process.env.NEAR_CREDENTIALS_DIR ?? path.join(os.homedir(), ".near-credentials");
    await flow(mode, parentId, wasmPath);
  }
  clearTimeout(watchdog);
  process.exit(0);
})().catch((e) => {
  console.error(`\nFAILED: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
