// Local playground for the web app: a near-sandbox running the Deedlords contract, a few funded accounts, a house
// runner and a loopback HTTP stub the browser talks to. Everything lives on this machine: nothing here can reach testnet
// or mainnet, and the account keys never leave this process.
//
//   npm run dev:chain     sandbox + stub on http://127.0.0.1:8791 (DEEDLORDS_DEV_PORT to change)
//   npm run capture       plays one short duel and rewrites ../../tests/fixtures/chain-duel.json
//
// The stub stands in for what a browser cannot do on a real network without a wallet:
//   POST /session { accountId, publicKey }    adds a function-call session key to a dev account, which is what the wallet
//                                             "sign in" does on testnet/mainnet; the browser keeps the private half
//   POST /match   { kind, seats?, open?, turnSeconds?, rules? }   creates a match and seats the dev accounts
//                                             (create_match and join carry deposits: full-access signatures)
//   POST /join    { id, seat, accountId }     seats a dev account in an open match
//   POST /rpc                                 forwards one JSON-RPC request to the sandbox node
//   GET  /config                              { networkId, contractId, house, players, stake, solo }
//
// Only pages served from localhost may call it (CORS), and every POST must be application/json.

const fs = require("fs");
const path = require("path");
const http = require("http");
const { connect, keyStores, KeyPair } = require("near-api-js");
const { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } = require("near-sandbox");

const NET = "sandbox";
const Y = 10n ** 24n;
const NEAR = (n) => (BigInt(Math.round(n * 1000)) * Y) / 1000n;
const TGAS = 10n ** 12n;
const GAS = 300n * TGAS;
const MAX_STAKE = 10n * Y;
/// The fee of this playground: 2.5% of every pot, as planned for the real deployments.
const FEE_BPS = 250;
const STAKE = NEAR(1);
const STORAGE_DEPOSIT = NEAR(0.06);
/// Same session key as on testnet (see testnet.js): these methods, this allowance, this contract only.
const SESSION_METHODS = ["play", "turn", "timeout", "set_driver", "leave"];
const SESSION_ALLOWANCE = NEAR(0.25);
const ALL_CITIES = [1, 3, 6, 8, 9, 11, 13, 14, 16, 18, 19, 21, 23, 24, 26, 27, 29, 31, 32, 34, 37, 39];
const HOUSE_PLAN = { buy_reserve: 150, build: ALL_CITIES, keep_reserve: 250, bail: true, liquidate: [] };
const DEFAULT_RULES = { salary: 200, cash: 1500, blitz: false, max_rounds: 12 };
const PORT = Number(process.env.DEEDLORDS_DEV_PORT ?? 8791);
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let near, keyStore, provider, contractId, sandboxUrl;
const acc = {};

// ----- chain helpers -----------------------------------------------------------------------------------------------

async function makeAccount(name, amount) {
  const id = `${name}.${DEFAULT_ACCOUNT_ID}`;
  const kp = KeyPair.fromRandom("ed25519");
  await keyStore.setKey(NET, id, kp);
  const root = await near.account(DEFAULT_ACCOUNT_ID);
  await root.createAccount(id, kp.getPublicKey(), NEAR(amount));
  return near.account(id);
}

/// One transaction at a time per signing account: the runner and the stub share the house key and its nonce.
const queues = new Map();
function inTurn(key, job) {
  const next = (queues.get(key) ?? Promise.resolve()).then(job);
  queues.set(key, next.catch(() => {}));
  return next;
}

const call = (account, method, args, deposit = 0n) =>
  inTurn(account.accountId, () => account.functionCall({ contractId, methodName: method, args, gas: GAS, attachedDeposit: deposit }));

const view = (method, args = {}) => provider
  .query({ request_type: "call_function", finality: "optimistic", account_id: contractId, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") })
  .then((r) => JSON.parse(Buffer.from(r.result).toString()));

function eventsOf(outcome) {
  const out = [];
  for (const r of outcome.receipts_outcome) {
    for (const log of r.outcome.logs) {
      if (log.startsWith("EVENT_JSON:")) out.push(JSON.parse(log.slice("EVENT_JSON:".length)));
    }
  }
  return out;
}

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

async function setUp(wasmPath) {
  const wasm = fs.readFileSync(wasmPath);
  console.log(`wasm: ${wasmPath} (${wasm.length} bytes)`);
  console.log("booting a local near-sandbox...");
  const sandbox = await Sandbox.start({});
  sandboxUrl = sandbox.rpcUrl;
  keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(NET, DEFAULT_ACCOUNT_ID, KeyPair.fromString(DEFAULT_PRIVATE_KEY));
  near = await connect({ networkId: NET, nodeUrl: sandbox.rpcUrl, keyStore });
  provider = near.connection.provider;
  try {
    const game = await makeAccount("game", 30);
    contractId = game.accountId;
    acc.owner = await makeAccount("owner", 10);
    acc.house = await makeAccount("house", 200);
    acc.alice = await makeAccount("alice", 200);
    acc.bob = await makeAccount("bob", 200);
    acc.carol = await makeAccount("carol", 200);
    await game.deployContract(wasm);
    await game.functionCall({ contractId, methodName: "new", args: { owner: acc.owner.accountId, house: acc.house.accountId, max_stake: MAX_STAKE.toString(), fee_bps: FEE_BPS }, gas: GAS });
    console.log(`contract deployed to ${contractId} on the local sandbox`);
  } catch (e) {
    await stopSandbox(sandbox);
    throw e;
  }
  return sandbox;
}

// ----- matches -----------------------------------------------------------------------------------------------------

const players = () => [acc.alice, acc.bob, acc.carol];
const playerById = (id) => players().find((a) => a.accountId === id) ?? null;

let serial = 0;
/// duel: the dev players against each other. solo: alice (or `player`) against the house on every other seat.
/// `open` leaves the last seat free, so the lobby and POST /join can be tried.
async function createMatch({ kind = "duel", seats = 2, open = false, turnSeconds = 45, rules = {}, player = null, stake = STAKE }) {
  if (kind !== "duel" && kind !== "solo") throw new Error('kind must be "duel" or "solo"');
  if (!(Number.isInteger(seats) && seats >= 2 && seats <= (kind === "duel" ? 3 : 4))) throw new Error("seats: 2..3 for a duel, 2..4 for solo");
  const id = `dev-${Date.now().toString(36)}-${++serial}`;
  const creator = playerById(player) ?? acc.alice;
  const split = seats === 2 ? [7000, 3000] : seats === 3 ? [6000, 3000, 1000] : [5500, 2500, 1500, 500];
  await call(creator, "create_match", {
    id,
    seats,
    stake: stake.toString(),
    split,
    rules: { ...DEFAULT_RULES, ...rules },
    solo_player: kind === "solo" ? creator.accountId : null,
    turn_seconds: turnSeconds,
  }, STORAGE_DEPOSIT);
  if (kind === "solo") {
    // The house takes every seat but the first; the solo player's join is the last one and starts the game.
    for (let seat = 1; seat < seats; seat++) await call(acc.house, "join", { id, seat }, stake);
    if (!open) await call(creator, "join", { id, seat: 0 }, stake);
  } else {
    const order = [creator, ...players().filter((a) => a !== creator)].slice(0, seats);
    for (const [seat, account] of order.entries()) {
      if (open && seat === seats - 1) break;
      await call(account, "join", { id, seat }, stake);
    }
  }
  return id;
}

async function join({ id, seat, accountId }) {
  const account = playerById(accountId);
  if (!account) throw new Error(`unknown dev account: ${accountId}`);
  const match = await view("get_match", { id: String(id) });
  if (!match) throw new Error(`no such match: ${id}`);
  await call(account, "join", { id: String(id), seat: Number(seat) }, BigInt(match.meta.stake));
  return { id, seat: Number(seat), accountId: account.accountId };
}

async function addSessionKey({ accountId, publicKey }) {
  const account = playerById(accountId);
  if (!account) throw new Error(`unknown dev account: ${accountId}`);
  if (typeof publicKey !== "string" || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(publicKey)) throw new Error("publicKey must be an ed25519:<base58> key");
  const existing = await provider
    .query({ request_type: "view_access_key", finality: "optimistic", account_id: account.accountId, public_key: publicKey })
    .catch(() => null);
  if (!existing) {
    await inTurn(account.accountId, () => account.addKey(publicKey, contractId, SESSION_METHODS, SESSION_ALLOWANCE));
  }
  return { accountId: account.accountId, publicKey, contractId, methods: SESSION_METHODS, added: !existing };
}

/// Plays the house seats (one turn() per turn) and calls timeout() on a match nobody moved in for a while.
async function runHouse() {
  for (;;) {
    try {
      const listed = await view("list_matches", { from_index: 0, limit: 50 });
      const nowNs = BigInt(Date.now()) * 1_000_000n;
      for (const m of listed) {
        if (m.status !== "playing") continue;
        const seat = m.current_seat;
        if (m.seats[seat]?.house) {
          await call(acc.house, "turn", { id: m.id, seat, plan: HOUSE_PLAN }).catch((e) => console.log(`  house turn in ${m.id}: ${String(e.message ?? e).slice(0, 160)}`));
        } else if (BigInt(m.turn_deadline) > 0n && nowNs > BigInt(m.turn_deadline) + 8_000_000_000n) {
          // The players' own browsers call timeout() first; this is the keeper for a match everybody walked away from.
          await call(acc.house, "timeout", { id: m.id }).catch(() => {});
        }
      }
    } catch (e) {
      console.log(`  house runner: ${String(e.message ?? e).slice(0, 160)}`);
    }
    await sleep(600);
  }
}

// ----- the stub ----------------------------------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 1_000_000) {
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
      res.end(body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body));
    };
    try {
      if (!allowed) return send(403, { error: "only pages served from localhost may call the dev stub" });
      if (req.method === "OPTIONS") return send(204);
      const route = `${req.method} ${new URL(req.url, "http://x").pathname}`;
      if (route === "GET /config") {
        return send(200, { networkId: NET, contractId, house: acc.house.accountId, players: players().map((a) => a.accountId), stake: STAKE.toString(), solo: true });
      }
      if (req.method !== "POST") return send(404, { error: "not found" });
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return send(415, { error: "content-type must be application/json" });
      const text = await readBody(req);
      if (route === "POST /rpc") {
        const upstream = await fetch(sandboxUrl, { method: "POST", headers: { "content-type": "application/json" }, body: text });
        return send(upstream.status, await upstream.text());
      }
      const body = text ? JSON.parse(text) : {};
      if (route === "POST /session") return send(200, await addSessionKey(body));
      if (route === "POST /match") return send(200, { id: await createMatch(body) });
      if (route === "POST /join") return send(200, await join(body));
      return send(404, { error: "not found" });
    } catch (e) {
      send(400, { error: String(e && e.message ? e.message : e).slice(0, 600) });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // Loopback only: the stub signs for the dev accounts, so it is never offered to the network.
    server.listen(PORT, "127.0.0.1", () => resolve(server));
  });
}

// ----- capture: real contract answers as test fixtures -------------------------------------------------------------

/// The plain policy of run.js scenario (b): enough to walk a whole match through play().
function nextActions(m) {
  const g = m.game;
  const seat = m.meta.current_seat;
  const me = g.players.find((p) => p.id === `s${seat}`);
  if (g.stage === "roll") return me.jail !== null && me.cash >= 50 ? ["Bail", "Roll"] : ["Roll"];
  if (g.stage === "buy") return me.cash > 400 ? ["Buy"] : ["Skip"];
  if (g.stage === "end") return [g.again ? "Roll" : "End"];
  const owed = g.debt.reduce((s, d) => s + d.amount, 0);
  const mine = Object.entries(g.props).filter(([, o]) => o.owner === `s${seat}`);
  const house = mine.find(([, o]) => o.houses > 0);
  const free = mine.find(([, o]) => !o.mortgaged && o.houses === 0);
  return me.cash >= owed ? ["Pay"] : house ? [{ Sell: Number(house[0]) }] : free ? [{ Mortgage: Number(free[0]) }] : ["Bankrupt"];
}

async function capture(outPath) {
  const out = { note: "Real answers of the Deedlords contract on a local near-sandbox, written by contracts/sandbox/dev.js --capture.", contractId };
  const id = await createMatch({ kind: "duel", open: true, turnSeconds: 120, rules: { max_rounds: 3 } });
  out.lobby = await view("get_match", { id });
  out.listed = await view("list_matches", { from_index: 0, limit: 10 });
  await join({ id, seat: 1, accountId: acc.bob.accountId });
  out.started = await view("get_match", { id });
  const byBacker = { [acc.alice.accountId]: acc.alice, [acc.bob.accountId]: acc.bob };
  out.samples = {};
  out.calls = [];
  let last = null;
  let calls = 0;
  for (; calls < 400; calls++) {
    const m = await view("get_match", { id });
    if (m === null) break;
    if (calls === 8) out.mid = m;
    if (m.game.card && !out.samples.card) out.samples.card = m;
    if (m.game.stage === "debt" && !out.samples.debt) out.samples.debt = m;
    if (m.game.stage === "buy" && !out.samples.buy) out.samples.buy = m;
    if (m.game.players.some((p) => p.jail !== null) && !out.samples.jail) out.samples.jail = m;
    const seat = m.meta.current_seat;
    const actions = nextActions(m);
    last = await call(byBacker[m.meta.seats[seat].backer], "play", { id, seat, actions });
    const value = JSON.parse(Buffer.from(last.status.SuccessValue ?? "", "base64").toString() || "null");
    // `before` and `after` let a test replay the call with the TS engine and compare (tests/chain-adapt.test.ts).
    if (out.calls.length < 14) out.calls.push({ seat, actions, returned: value, events: eventsOf(last), before: m, after: await view("get_match", { id }) });
  }
  if (calls >= 400) throw new Error("the match did not settle");
  out.settleEvents = eventsOf(last);
  out.afterSettle = await view("get_match", { id });
  out.result = await view("get_result", { id });
  out.config = await view("get_config", {});
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote ${outPath}: ${calls} play() calls, settled (${out.result.reason}), samples: ${Object.keys(out.samples).join(", ") || "none"}`);
}

// ----- entry -------------------------------------------------------------------------------------------------------

(async () => {
  const args = process.argv.slice(2);
  const wasmPath = args.find((a) => a.endsWith(".wasm")) ?? path.join(__dirname, "../target/wasm32-unknown-unknown/release/deedlords.wasm");
  const captureAt = args.indexOf("--capture");
  const sandbox = await setUp(wasmPath);
  let stopping = false;
  const stop = async (code) => {
    if (stopping) return;
    stopping = true;
    await stopSandbox(sandbox);
    process.exit(code);
  };
  process.once("SIGINT", () => stop(0));
  process.once("SIGTERM", () => stop(0));
  try {
    if (captureAt >= 0) {
      await capture(path.resolve(args[captureAt + 1] ?? path.join(__dirname, "../../tests/fixtures/chain-duel.json")));
      return stop(0);
    }
    await serve();
    runHouse();
    const solo = await createMatch({ kind: "solo" });
    const duel = await createMatch({ kind: "duel" });
    console.log(`dev stub ready on http://127.0.0.1:${PORT}`);
    console.log(`  dev accounts: ${players().map((a) => a.accountId).join(", ")} (house: ${acc.house.accountId})`);
    console.log(`  solo match vs the house: ${solo}   duel alice vs bob: ${duel}`);
    console.log("  Ctrl-C stops the sandbox and deletes its data");
  } catch (e) {
    console.error(`\nFAILED: ${e && e.stack ? e.stack : e}`);
    await stop(1);
  }
})().catch((e) => {
  console.error(`\nFAILED: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
