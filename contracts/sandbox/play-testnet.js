// Play a Deedlords match on NEAR TESTNET from the browser, with the two test accounts p1.<parent> and p2.<parent>.
// Refuses any other network. Private keys are read from the NEAR credentials directory by near-api-js, never printed.
//
//   DEEDLORDS_PARENT=<you>.testnet npm run play:testnet       helper on http://127.0.0.1:8792
//   npm run dev:testnet                                       (repo root) the web app pointed at it
//
// It is the testnet twin of dev.js: the same loopback stub, standing in for the wallet until wallet sign-in exists.
// A browser cannot sign what carries a deposit or changes keys without a wallet, so this helper signs exactly three
// things with the full-access keys of p1 and p2, and nothing else:
//   POST /session { accountId, publicKey }   adds the browser's key to p1 or p2 as a FUNCTION-CALL key: the game
//                                            contract only, the move methods only, 0.25 NEAR allowance for gas
//   POST /match   { kind: "duel", open?, player?, turnSeconds?, rules: { max_rounds }? }
//                                            create_match (0.06 NEAR storage deposit, refunded at settlement but for
//                                            the permanent records) and join (0.05 NEAR stake) for p1 and/or p2
//   POST /join    { id, seat, accountId }    join for p1 or p2, only a match staked at 0.05 NEAR or less
//   POST /fund    { accountId }              sends 0.25 NEAR from the parent account to a GAME ACCOUNT (an implicit
//                                            account: 64 hex digits) that holds less than 0.25 NEAR, so that somebody
//                                            who signed in with an EVM wallet or as a guest can stake on testnet
//   POST /agent   { id }                     seats p2 (or p1) in the open seat of a lobby staked at 0.05 NEAR or less
//                                            and plays that seat as an AGENT until the match is settled: on each of its
//                                            turns it asks the web app's agent desk (DEEDLORDS_WEB_URL/api/agent: a
//                                            language model, or the rule bot) for a plan and signs `turn(id, seat, plan)`
//   GET  /config                             { networkId, contractId, house, players, stake, solo: false, faucet, agent }
// Every move of the game itself is signed in the browser with its session key and goes straight to the RPC.
//
// Bounds: at most 10 matches, 8 session keys, 6 fundings and 4 agent seats at a time per run; a test account is never taken below 0.15 NEAR and
// the parent never below 1 NEAR. On start it removes
// session keys an earlier run left on p1/p2, on Ctrl-C the ones it added. A match nobody finishes keeps its two stakes
// until its turns are timed out (the players' browsers do that while open; `testnet.js run` finishes leftovers).
//
// Only pages served from localhost may call it (CORS), every POST must be application/json, and it listens on
// loopback only. Environment: DEEDLORDS_PARENT (required), DEEDLORDS_RPC (default https://test.rpc.fastnear.com),
// NEAR_CREDENTIALS_DIR (default ~/.near-credentials), DEEDLORDS_PLAY_PORT (default 8792), DEEDLORDS_WEB_URL (the web
// app whose /api/agent plans the agent's turns, default http://localhost:3000).

"use strict";

const os = require("os");
const path = require("path");
const http = require("http");
const { connect, keyStores } = require("near-api-js");

const NET = "testnet";
const Y = 10n ** 24n;
const NEAR = (n) => (BigInt(Math.round(n * 1000)) * Y) / 1000n;
const fmt = (yocto) => `${(Number(BigInt(yocto) / 10n ** 18n) / 1e6).toFixed(4)} NEAR`;
const TGAS = 10n ** 12n;
/// The contract's floor for calls that may roll (MIN_MOVE_GAS); unspent gas is refunded.
const GAS = 100n * TGAS;
const UA = "deedlords-dev-check/0.1";
/// The same stake, deposit and session key as testnet.js.
const STAKE = NEAR(0.05);
const STORAGE_DEPOSIT = NEAR(0.06);
const SESSION_METHODS = ["play", "turn", "timeout", "set_driver", "leave"];
const SESSION_ALLOWANCE = NEAR(0.25);
const RESERVE = NEAR(0.15);
const MAX_MATCHES = 10;
const MAX_KEYS = 8;
/// Test NEAR for a new game account, and what the parent keeps for itself.
const FAUCET_AMOUNT = NEAR(0.25);
const FAUCET_FLOOR = NEAR(0.25);
const FAUCET_RESERVE = NEAR(1);
const MAX_FUNDINGS = 6;
/// Agent seats: how many at a time, how often a match is looked at, and what is played when the desk cannot be reached.
const MAX_AGENTS = 4;
const AGENT_LOOK_MS = 1200;
const WEB_URL = (process.env.DEEDLORDS_WEB_URL ?? "http://localhost:3000").replace(/\/$/, "");
const CAREFUL_PLAN = { buy_reserve: 200, build: [], keep_reserve: 200, bail: true, liquidate: [] };
const PORT = Number(process.env.DEEDLORDS_PLAY_PORT ?? 8792);
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let provider, contractId, house;
const acc = {};
const addedKeys = []; // { account, publicKey }
let matches = 0;
let serial = 0;
let fundings = 0;
const agents = new Map(); // match id -> { seat, account }

// ----- chain helpers -----------------------------------------------------------------------------------------------

/// One transaction at a time per signing account: its nonce only goes up.
const queues = new Map();
function inTurn(key, job) {
  const next = (queues.get(key) ?? Promise.resolve()).then(job);
  queues.set(key, next.catch(() => {}));
  return next;
}

const view = (method, args = {}) => provider
  .query({ request_type: "call_function", finality: "optimistic", account_id: contractId, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") })
  .then((r) => JSON.parse(Buffer.from(r.result).toString()));

async function call(account, method, args, deposit = 0n) {
  const outcome = await inTurn(account.accountId, () => account.functionCall({ contractId, methodName: method, args, gas: GAS, attachedDeposit: deposit }));
  console.log(`  signed by ${account.accountId}: ${method}(${args.id ?? ""})${deposit > 0n ? ` with ${fmt(deposit)}` : ""}, tx ${outcome.transaction.hash}`);
  return outcome;
}

const players = () => [acc.p1, acc.p2];
function playerById(id) {
  const account = players().find((a) => a.accountId === id);
  if (!account) throw new Error(`this helper signs for ${players().map((a) => a.accountId).join(" and ")} only, not ${String(id).slice(0, 64)}`);
  return account;
}

async function requireFunds(account, spend) {
  const { amount } = await account.state();
  if (BigInt(amount) < spend + RESERVE) throw new Error(`${account.accountId} has ${fmt(amount)}: not enough to put in ${fmt(spend)} and keep ${fmt(RESERVE)}`);
}

/// Function-call keys of `account` for the game contract: session keys, of this run or left by an earlier one.
async function sessionKeysOf(account) {
  const keys = await account.getAccessKeys();
  return keys.filter((k) => k.access_key.permission !== "FullAccess" && k.access_key.permission.FunctionCall?.receiver_id === contractId).map((k) => k.public_key);
}

async function removeKeys(account, publicKeys, why) {
  for (const publicKey of publicKeys) {
    const outcome = await inTurn(account.accountId, () => account.deleteKey(publicKey));
    console.log(`  signed by ${account.accountId}: delete session key ${publicKey.slice(0, 16)}… (${why}), tx ${outcome.transaction.hash}`);
  }
}

// ----- what the browser may ask for --------------------------------------------------------------------------------

async function addSessionKey({ accountId, publicKey }) {
  const account = playerById(accountId);
  if (typeof publicKey !== "string" || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(publicKey)) throw new Error("publicKey must be an ed25519:<base58> key");
  const existing = await sessionKeysOf(account);
  if (!existing.includes(publicKey)) {
    if (addedKeys.length >= MAX_KEYS) throw new Error(`this run has added ${MAX_KEYS} session keys already: restart the helper to go on`);
    const outcome = await inTurn(account.accountId, () => account.addKey(publicKey, contractId, SESSION_METHODS, SESSION_ALLOWANCE));
    addedKeys.push({ account, publicKey });
    console.log(`  signed by ${account.accountId}: add session key ${publicKey.slice(0, 16)}… (${SESSION_METHODS.join("/")} on ${contractId}, allowance ${fmt(SESSION_ALLOWANCE)}), tx ${outcome.transaction.hash}`);
  }
  return { accountId: account.accountId, publicKey, contractId, methods: SESSION_METHODS, added: !existing.includes(publicKey) };
}

/// Test NEAR for a game account, from the parent. An implicit account comes to exist with this first transfer.
async function fund({ accountId }) {
  if (typeof accountId !== "string" || !/^[0-9a-f]{64}$/.test(accountId)) throw new Error("only a game account (64 hex digits) is funded here");
  const have = await provider.query({ request_type: "view_account", finality: "optimistic", account_id: accountId }).then((a) => BigInt(a.amount), () => 0n);
  if (have >= FAUCET_FLOOR) return { accountId, funded: false, balance: have.toString() };
  if (fundings >= MAX_FUNDINGS) throw new Error(`this run has funded ${MAX_FUNDINGS} game accounts already: restart the helper to go on`);
  const { amount } = await acc.faucet.state();
  if (BigInt(amount) < FAUCET_AMOUNT + FAUCET_RESERVE) throw new Error(`the faucet account ${acc.faucet.accountId} is down to ${fmt(amount)}`);
  fundings++;
  const outcome = await inTurn(acc.faucet.accountId, () => acc.faucet.sendMoney(accountId, FAUCET_AMOUNT));
  console.log(`  signed by ${acc.faucet.accountId}: send ${fmt(FAUCET_AMOUNT)} to game account ${accountId.slice(0, 8)}…, tx ${outcome.transaction.hash}`);
  return { accountId, funded: true, balance: (have + FAUCET_AMOUNT).toString() };
}

const whole = (value, min, max, name) => {
  if (!(Number.isInteger(value) && value >= min && value <= max)) throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  return value;
};

/// A duel between the two test accounts. `open` leaves the second seat free, to be taken from the lobby page.
async function createMatch({ kind = "duel", open = false, player = null, turnSeconds = 60, rules = {} }) {
  if (kind !== "duel") throw new Error("only duels here: a match against the house needs a house runner, which this helper does not have");
  if (matches >= MAX_MATCHES) throw new Error(`this run has opened ${MAX_MATCHES} matches already: restart the helper to go on`);
  const maxRounds = whole(rules?.max_rounds ?? 20, 1, 255, "rules.max_rounds");
  whole(turnSeconds, 20, 300, "turnSeconds");
  const creator = player === null ? acc.p1 : playerById(player);
  const other = creator === acc.p1 ? acc.p2 : acc.p1;
  await requireFunds(creator, STORAGE_DEPOSIT + STAKE);
  if (!open) await requireFunds(other, STAKE);
  const id = `web-${Date.now().toString(36)}-${++serial}`;
  matches++;
  await call(creator, "create_match", {
    id,
    seats: 2,
    stake: STAKE.toString(),
    split: [7000, 3000],
    // The rules the web page opens a match with (games/co-ty-phu/chain/calls.ts RULES).
    rules: { salary: 200, cash: 2000, blitz: true, max_rounds: maxRounds },
    solo_player: null,
    turn_seconds: turnSeconds,
  }, STORAGE_DEPOSIT);
  await call(creator, "join", { id, seat: 0 }, STAKE);
  if (!open) await call(other, "join", { id, seat: 1 }, STAKE);
  return id;
}

async function join({ id, seat, accountId }) {
  const account = playerById(accountId);
  const match = await view("get_match", { id: String(id) });
  if (!match) throw new Error(`no such match: ${String(id).slice(0, 40)}`);
  const stake = BigInt(match.meta.stake);
  if (stake > STAKE) throw new Error(`this helper stakes at most ${fmt(STAKE)} a seat; ${match.meta.id} asks for ${fmt(stake)}`);
  await requireFunds(account, stake);
  await call(account, "join", { id: match.meta.id, seat: whole(Number(seat), 0, 3, "seat") }, stake);
  return { id: match.meta.id, seat: Number(seat), accountId: account.accountId };
}

// ----- an agent in a seat ------------------------------------------------------------------------------------------

/// A plan for the seat from the web app's agent desk; when the desk cannot be reached, a careful plan that needs no advice.
async function adviceFor(id, seat) {
  try {
    const response = await fetch(`${WEB_URL}/api/agent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, seat }), signal: AbortSignal.timeout(9000) });
    const advice = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(advice.error ?? `HTTP ${response.status}`);
    return advice;
  } catch (e) {
    return { plan: CAREFUL_PLAN, driver: "default plan", reason: `the agent desk at ${WEB_URL} did not answer (${String(e.message ?? e).slice(0, 80)})`, fallback: true };
  }
}

/// Plays `seat` of match `id` with `account` until the contract no longer has the match (settled) or it fails 5 times running.
async function drive(id, seat, account) {
  console.log(`  agent: ${account.accountId} plays seat ${seat + 1} of ${id}`);
  let failures = 0;
  let played = null; // the turn already sent: a node one block behind may still show it as ours
  for (;;) {
    await sleep(AGENT_LOOK_MS);
    let match;
    try {
      match = await view("get_match", { id });
    } catch {
      continue;
    }
    if (!match) break;
    if (match.meta.status !== "playing" || match.meta.current_seat !== seat) continue;
    const turnKey = `${match.game.rolls}:${match.game.round}`;
    if (played && played.key === turnKey && Date.now() - played.at < 8000) continue;
    const advice = await adviceFor(id, seat);
    try {
      await call(account, "turn", { id, seat, plan: advice.plan });
      played = { key: turnKey, at: Date.now() };
      failures = 0;
      console.log(`  agent ${advice.driver}${advice.fallback ? " (fallback)" : ""}, round ${match.game.round + 1}: ${String(advice.reason).slice(0, 160)}`);
    } catch (e) {
      failures++;
      console.log(`  agent: turn refused (${failures}/5): ${String(e.message ?? e).slice(0, 160)}`);
      if (failures >= 5) break;
      await sleep(2000);
    }
  }
  agents.delete(id);
  console.log(`  agent: seat ${seat + 1} of ${id} is done`);
}

async function seatAgent({ id }) {
  const match = await view("get_match", { id: String(id) });
  if (!match) throw new Error(`no such match: ${String(id).slice(0, 40)}`);
  if (match.meta.status !== "lobby") throw new Error("the game has already started");
  if (agents.has(match.meta.id)) throw new Error("an agent already sits in this match");
  if (agents.size >= MAX_AGENTS) throw new Error(`${MAX_AGENTS} agents are playing already: wait for a match to end`);
  const free = match.meta.seats.find((s) => s.backer === null);
  if (!free) throw new Error("no seat is free");
  const seated = new Set(match.meta.seats.map((s) => s.backer));
  const account = [acc.p2, acc.p1].find((a) => !seated.has(a.accountId));
  if (!account) throw new Error("both test accounts already sit in this match");
  const stake = BigInt(match.meta.stake);
  if (stake > STAKE) throw new Error(`this helper stakes at most ${fmt(STAKE)} a seat; ${match.meta.id} asks for ${fmt(stake)}`);
  await requireFunds(account, stake);
  agents.set(match.meta.id, { seat: free.seat, account });
  try {
    await call(account, "join", { id: match.meta.id, seat: free.seat }, stake);
  } catch (e) {
    agents.delete(match.meta.id);
    throw e;
  }
  void drive(match.meta.id, free.seat, account);
  return { id: match.meta.id, seat: free.seat, accountId: account.accountId };
}

// ----- the stub ----------------------------------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 100_000) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function serve() {
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const allowed = origin === undefined || LOCAL_ORIGIN.test(origin);
    const headers = { "content-type": "application/json", "cache-control": "no-store" };
    if (origin && allowed) Object.assign(headers, { "access-control-allow-origin": origin, vary: "origin", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-max-age": "600" });
    const send = (status, body) => {
      res.writeHead(status, headers);
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    try {
      if (!allowed) return send(403, { error: "only pages served from localhost may call this helper" });
      if (req.method === "OPTIONS") return send(204);
      const route = `${req.method} ${new URL(req.url, "http://x").pathname}`;
      if (route === "GET /config") {
        return send(200, { networkId: NET, contractId, house, players: players().map((a) => a.accountId), stake: STAKE.toString(), solo: false, faucet: FAUCET_AMOUNT.toString(), agent: true });
      }
      if (req.method !== "POST") return send(404, { error: "not found" });
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return send(415, { error: "content-type must be application/json" });
      const text = await readBody(req);
      const body = text ? JSON.parse(text) : {};
      if (route === "POST /session") return send(200, await addSessionKey(body));
      if (route === "POST /match") return send(200, { id: await createMatch(body) });
      if (route === "POST /join") return send(200, await join(body));
      if (route === "POST /fund") return send(200, await fund(body));
      if (route === "POST /agent") return send(200, await seatAgent(body));
      return send(404, { error: "not found" });
    } catch (e) {
      const message = String(e && e.message ? e.message : e).slice(0, 600);
      console.log(`  refused: ${message}`);
      send(400, { error: message });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // Loopback only: this process signs for the test accounts, so it is never offered to the network.
    server.listen(PORT, "127.0.0.1", () => resolve(server));
  });
}

// ----- entry -------------------------------------------------------------------------------------------------------

(async () => {
  const parent = process.env.DEEDLORDS_PARENT;
  if (!parent || !parent.endsWith(".testnet")) throw new Error("set DEEDLORDS_PARENT to your .testnet account: this helper never runs on mainnet");
  const rpcUrl = process.env.DEEDLORDS_RPC ?? "https://test.rpc.fastnear.com";
  const keyStore = new keyStores.UnencryptedFileSystemKeyStore(process.env.NEAR_CREDENTIALS_DIR ?? path.join(os.homedir(), ".near-credentials"));
  const near = await connect({ networkId: NET, nodeUrl: rpcUrl, keyStore, headers: { "user-agent": UA } });
  provider = near.connection.provider;
  const status = await provider.status();
  if (status.chain_id !== NET) throw new Error(`${rpcUrl} is ${status.chain_id}, not testnet: refusing`);

  contractId = `game.${parent}`;
  for (const name of ["p1", "p2"]) {
    const id = `${name}.${parent}`;
    if (!(await keyStore.getKey(NET, id))) throw new Error(`no key for ${id} in the credentials directory: run \`testnet.js run\` first`);
    acc[name] = await near.account(id);
  }
  if (!(await keyStore.getKey(NET, parent))) throw new Error(`no key for ${parent} in the credentials directory`);
  acc.faucet = await near.account(parent);
  const config = await view("get_config");
  house = config.house;
  if (config.fee_bps === undefined) throw new Error(`${contractId} runs the contract from before the fee: upgrade it with \`testnet.js run\` first`);
  if (BigInt(config.max_stake) < STAKE) throw new Error(`${contractId} allows at most ${fmt(config.max_stake)} a seat`);
  console.log(`testnet through ${rpcUrl}; contract ${contractId} (fee ${config.fee_bps / 100}%, ${config.matches} open match(es))`);
  for (const account of players()) {
    console.log(`  ${account.accountId}: ${fmt((await account.state()).amount)}`);
    await removeKeys(account, await sessionKeysOf(account), "left by an earlier run");
  }

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log("\nstopping: removing the session keys of this run");
    for (const { account, publicKey } of addedKeys) {
      await removeKeys(account, [publicKey], "end of run").catch((e) => console.log(`  could not remove ${publicKey.slice(0, 16)}… from ${account.accountId}: ${String(e.message ?? e).slice(0, 120)}`));
    }
    const open = await view("list_matches", { from_index: 0, limit: 50 }).catch(() => []);
    if (open.length) console.log(`  ${open.length} match(es) still open on ${contractId}: ${open.map((m) => m.id).join(", ")} (their stakes stay in the contract until they are played out or timed out)`);
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await serve();
  console.log(`testnet helper ready on http://127.0.0.1:${PORT}`);
  console.log(`  signs for ${players().map((a) => a.accountId).join(" and ")}: session keys, duels at ${fmt(STAKE)} a seat (+ ${fmt(STORAGE_DEPOSIT)} storage deposit), joins`);
  console.log(`  ${acc.faucet.accountId} (${fmt((await acc.faucet.state()).amount)}) sends ${fmt(FAUCET_AMOUNT)} to a new game account that asks, ${MAX_FUNDINGS} times at most`);
  console.log(`  POST /agent seats p2 (or p1) as an AGENT in a lobby and plays it by the plans of ${WEB_URL}/api/agent`);
  console.log(`  at most ${MAX_MATCHES} matches and ${MAX_KEYS} session keys this run; Ctrl-C removes the session keys`);
  // Keeps the process alive and tells how long it has been up when asked; nothing is signed on a timer.
  for (;;) await sleep(60_000);
})().catch((e) => {
  console.error(`\nFAILED: ${e && e.message ? e.message : e}`);
  process.exit(1);
});
