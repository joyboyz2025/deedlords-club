// Puts a new build of the Deedlords contract over the one that is live, when the new build reads the stored state as
// it is (no `migrate`): what `resign` and hosted matches needed. Refuses mainnet.
//
//   node upgrade.js dry    a rehearsal on a LOCAL near-sandbox: the code that is live on testnet right now is fetched
//                          and deployed there, matches are opened and played on it, the new wasm is deployed over it,
//                          and those same matches must read the same and play on. Nothing is sent to testnet.
//                          With DEEDLORDS_PARENT=deedlords.near and NEAR_RPC=<a mainnet RPC> the rehearsal starts from
//                          the code that is live on mainnet instead (read with view_code; nothing is sent there either).
//                          It also checks the rules added with tickets: the live code does not know them (the page
//                          must not ask it for them), the new one lists them, old matches play on without them, and
//                          a match opened with them after the deploy is played to its settlement.
//   node upgrade.js run    the deploy on testnet, signed by the game account (its key is in ~/.near-credentials).
//
// DEEDLORDS_PARENT (default deedlords.testnet), NEAR_RPC (default FastNEAR testnet), and the wasm path as last argument
// (default ../target/wasm32-unknown-unknown/release/deedlords.wasm).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { connect, keyStores, KeyPair, utils } = require("near-api-js");

const PARENT = process.env.DEEDLORDS_PARENT ?? "deedlords.testnet";
const GAME = `game.${PARENT}`;
const RPC = process.env.NEAR_RPC ?? "https://test.rpc.fastnear.com";
const WASM = process.argv[3] ?? path.join(__dirname, "../target/wasm32-unknown-unknown/release/deedlords.wasm");
const TGAS = 10n ** 12n;
const GAS = 300n * TGAS;
const Y = 10n ** 24n;
const hashOf = (bytes) => utils.serialize.base_encode(crypto.createHash("sha256").update(bytes).digest());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function liveCode() {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "deedlords-dev/0.1" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_code", finality: "final", account_id: GAME } }),
  });
  const { result, error } = await response.json();
  if (!result) throw new Error(`cannot read the code of ${GAME}: ${JSON.stringify(error)}`);
  return { bytes: Buffer.from(result.code_base64, "base64"), hash: result.hash };
}

async function dry(wasm) {
  const { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } = require("near-sandbox");
  const live = await liveCode();
  console.log(`live on ${GAME}: ${live.bytes.length} bytes, hash ${live.hash}`);
  console.log("booting a local near-sandbox...");
  const sandbox = await Sandbox.start({});
  const stop = async () => {
    const child = sandbox.childProcess;
    child.kill("SIGKILL");
    await sleep(500);
    await fs.promises.rm(sandbox.homeDir, { recursive: true, force: true }).catch(() => {});
  };
  try {
    const keyStore = new keyStores.InMemoryKeyStore();
    await keyStore.setKey("sandbox", DEFAULT_ACCOUNT_ID, KeyPair.fromString(DEFAULT_PRIVATE_KEY));
    const near = await connect({ networkId: "sandbox", nodeUrl: sandbox.rpcUrl, keyStore });
    const root = await near.account(DEFAULT_ACCOUNT_ID);
    const make = async (name, amount) => {
      const id = `${name}.${DEFAULT_ACCOUNT_ID}`;
      const key = KeyPair.fromRandom("ed25519");
      await keyStore.setKey("sandbox", id, key);
      await root.createAccount(id, key.getPublicKey(), BigInt(amount) * Y);
      return near.account(id);
    };
    const game = await make("game", 30);
    const [owner, house, alice, bob, carol] = [await make("owner", 5), await make("house", 5), await make("alice", 20), await make("bob", 20), await make("carol", 20)];
    const contractId = game.accountId;
    const call = (who, methodName, args, deposit = 0n) => who.functionCall({ contractId, methodName, args, gas: GAS, attachedDeposit: deposit });
    const view = (methodName, args = {}) => game.viewFunction({ contractId, methodName, args });
    const rules = { salary: 200, cash: 1500, blitz: false, max_rounds: 6 };
    const open = (who, id, extra = {}) => call(who, "create_match", { id, seats: 2, stake: String(Y / 10n), split: [7000, 3000], rules, solo_player: null, turn_seconds: 60, ...extra }, Y / 10n);
    const plan = { buy_reserve: 150, build: [], keep_reserve: 150, bail: false, liquidate: [] };
    const seatOf = (match, account) => match.meta.seats.find((seat) => seat.backer === account.accountId).seat;
    const playTurn = async (id) => {
      const match = await view("get_match", { id });
      const who = [alice, bob, carol].find((account) => match.meta.seats[match.meta.current_seat].backer === account.accountId);
      await call(who, "turn", { id, seat: match.meta.current_seat, plan });
    };

    // The code that is live today, and what people have open on it: a lobby, and a game some turns in.
    await game.deployContract(live.bytes);
    await call(game, "new", { owner: owner.accountId, house: house.accountId, max_stake: String(10n * Y), fee_bps: 250 });
    await open(alice, "lobby");
    await call(alice, "join", { id: "lobby", seat: 0 }, Y / 10n);
    await open(alice, "running");
    await call(alice, "join", { id: "running", seat: 0 }, Y / 10n);
    await call(bob, "join", { id: "running", seat: 1 }, Y / 10n);
    for (let i = 0; i < 5; i++) await playTurn("running");
    // The code that is live does not know tickets: asked for them, it opens the match of before without a word. That is
    // why the page asks get_config first (`features`), and sends the rules only to a contract that lists them.
    const liveKnows = Array.isArray((await view("get_config")).features);
    const withTickets = { ...rules, blitz: true, cash: 2000, max_rounds: 10, tickets: true, leaderRent: true };
    await call(alice, "create_match", { id: "asked", seats: 2, stake: String(Y / 10n), split: [7000, 3000], rules: withTickets, solo_player: null, turn_seconds: 60 }, Y / 10n);
    await call(alice, "join", { id: "asked", seat: 0 }, Y / 10n);
    await call(bob, "join", { id: "asked", seat: 1 }, Y / 10n);
    for (let i = 0; i < 3; i++) await playTurn("asked");
    const asked = await view("get_match", { id: "asked" });
    if (!liveKnows) {
      assert.equal(asked.meta.rules.tickets, undefined, "the live code ignores rules it does not know");
      assert.equal(asked.game.tickets, undefined);
      console.log("  the live code lists no features and opens a plain match when asked for tickets");
    } else console.log("  the live code already lists features: this rehearsal is of a later build over it");
    const before = { lobby: await view("get_match", { id: "lobby" }), running: await view("get_match", { id: "running" }), config: await view("get_config") };
    assert.equal(before.running.meta.status, "playing");
    assert.ok(before.running.log.length > 0);

    // The new build over it: a plain deploy, no migrate. Everything open reads exactly as it did.
    await game.deployContract(wasm);
    const after = { lobby: await view("get_match", { id: "lobby" }), running: await view("get_match", { id: "running" }), config: await view("get_config") };
    assert.deepEqual(after.lobby, before.lobby, "the lobby reads as it was");
    assert.deepEqual(after.running, before.running, "the game in progress reads as it was, log included");
    // The one thing get_config says more: the opt-in rules this build knows.
    const { features, ...sameConfig } = after.config;
    const { features: _were, ...wasConfig } = before.config;
    assert.deepEqual(sameConfig, wasConfig);
    assert.deepEqual(features, ["tickets", "leaderRent", "buildHere", "hostGrace", "away", "close", "buildOne"], "the new build lists the opt-in rules");
    assert.deepEqual(await view("get_match", { id: "asked" }), asked, "the match opened on the old code reads as it was: without tickets");
    console.log("  the open lobby and the games in progress read the same after the deploy; get_config now lists features");

    // A match opened on the old code plays on as the match it is, to its settlement.
    const ticketPlan = { ...plan, tickets: { waiver: true, festival: true, steps: 7, takeover: [1, 3, 6, 8, 9, 11, 13, 14, 16, 18, 19, 21, 23, 24, 26, 27, 29, 31, 32, 34, 37, 39] } };
    const logsOf = (outcome) => outcome.receipts_outcome.flatMap((receipt) => receipt.outcome.logs).join("\n");
    const playOut = async (id, turnPlan) => {
      let logs = "";
      for (let turns = 0; turns < 200; turns++) {
        const match = await view("get_match", { id });
        if (match === null) break;
        const who = [alice, bob, carol].find((account) => match.meta.seats[match.meta.current_seat].backer === account.accountId);
        logs += logsOf(await call(who, "turn", { id, seat: match.meta.current_seat, plan: turnPlan }));
      }
      assert.ok(await view("get_result", { id }), `${id} settled`);
      return logs;
    };
    const askedLogs = await playOut("asked", ticketPlan);
    if (!liveKnows) {
      assert.ok(!askedLogs.includes('"kind":"played"'), "no ticket is played in a match opened before the deploy");
      console.log("  a match opened before the deploy played on to its settlement, without tickets");
    } else {
      // The live code already had tickets: its match, stored with the tail of before, is read by the new build and
      // plays on with them.
      assert.equal(asked.meta.rules.tickets, true);
      assert.equal(asked.meta.rules.buildHere, undefined, "a match opened before the deploy does not get the new rule");
      assert.ok(askedLogs.includes('"kind":"played"'), "tickets of a match opened before the deploy are still played");
      console.log("  a match with tickets opened before the deploy played on with them to its settlement");
    }

    // Opened after the deploy with the rules: tickets are dealt, played, and the match settles.
    await call(alice, "create_match", { id: "tickets", seats: 2, stake: String(Y / 10n), split: [7000, 3000], rules: withTickets, solo_player: null, turn_seconds: 60 }, Y / 10n);
    await call(alice, "join", { id: "tickets", seat: 0 }, Y / 10n);
    await call(bob, "join", { id: "tickets", seat: 1 }, Y / 10n);
    const dealt = await view("get_match", { id: "tickets" });
    assert.deepEqual([dealt.meta.rules.tickets, dealt.meta.rules.leaderRent], [true, true]);
    assert.deepEqual(Object.values(dealt.game.tickets.held).map((held) => held.length), [1, 1], "a ticket each at the start");
    assert.ok((await playOut("tickets", ticketPlan)).includes('"kind":"played"'), "tickets were played");
    console.log("  a match opened after the deploy with tickets and the leader's rent was dealt its tickets, played them and settled");

    // Opened after the deploy with every opt-in rule: building only where one stops is on, and the match settles.
    await call(alice, "create_match", { id: "here", seats: 2, stake: String(Y / 10n), split: [7000, 3000], rules: { ...withTickets, buildHere: true }, solo_player: null, turn_seconds: 60 }, Y / 10n);
    await call(alice, "join", { id: "here", seat: 0 }, Y / 10n);
    await call(bob, "join", { id: "here", seat: 1 }, Y / 10n);
    const here = await view("get_match", { id: "here" });
    assert.deepEqual([here.meta.rules.tickets, here.meta.rules.leaderRent, here.meta.rules.buildHere], [true, true, true]);
    // Before a throw nothing may be built in such a match (plain Blitz would allow any own city).
    const mine = Object.entries(here.game.props).find(([square, owned]) => owned.owner === here.meta.seats[here.meta.current_seat].player && ticketPlan.tickets.takeover.includes(Number(square)));
    assert.ok(mine, "the seat to move was dealt a city");
    const first = [alice, bob].find((account) => here.meta.seats[here.meta.current_seat].backer === account.accountId);
    // The contract refuses the move: by failing the call, or by answering without a build.
    const tried = await call(first, "play", { id: "here", seat: here.meta.current_seat, actions: [{ Build: Number(mine[0]) }] }).then(logsOf, () => "");
    assert.ok(!tried.includes('"kind":"build"'), "no house before the piece has stopped on that city");
    assert.equal((await view("get_match", { id: "here" })).game.props[mine[0]].houses, 0);
    await playOut("here", ticketPlan);
    console.log("  a match opened after the deploy with buildHere builds only where the piece stops, and settled");

    // Opened after the deploy with one house a turn: any own city takes the turn's house, and then no other does.
    await call(alice, "create_match", { id: "one", seats: 2, stake: String(Y / 10n), split: [7000, 3000], rules: { ...withTickets, buildOne: true }, solo_player: null, turn_seconds: 60 }, Y / 10n);
    await call(alice, "join", { id: "one", seat: 0 }, Y / 10n);
    await call(bob, "join", { id: "one", seat: 1 }, Y / 10n);
    const one = await view("get_match", { id: "one" });
    assert.deepEqual([one.meta.rules.buildOne, one.meta.rules.buildHere], [true, undefined]);
    const toMove = one.meta.seats[one.meta.current_seat];
    const cities = Object.entries(one.game.props).filter(([square, owned]) => owned.owner === toMove.player && ticketPlan.tickets.takeover.includes(Number(square))).map(([square]) => Number(square));
    assert.ok(cities.length >= 2, "the seat to move was dealt two cities");
    const builder = [alice, bob].find((account) => toMove.backer === account.accountId);
    await call(builder, "play", { id: "one", seat: one.meta.current_seat, actions: [{ Build: cities[0] }] });
    await call(builder, "play", { id: "one", seat: one.meta.current_seat, actions: [{ Build: cities[1] }] }).catch(() => undefined);
    const built = (await view("get_match", { id: "one" })).game.props;
    assert.deepEqual([built[cities[0]].houses, built[cities[1]].houses], [1, 0], "one house a turn, on the city chosen");
    await playOut("one", ticketPlan);
    console.log("  a match opened after the deploy with buildOne takes one house a turn on a chosen city, and settled");

    // The owner makes the fee free for matches opened from now on. The two matches opened before keep their 2.5%.
    await assert.rejects(call(alice, "set_fee", { fee_bps: 0 }, 1n), /only the owner may set the fee/);
    await call(owner, "set_fee", { fee_bps: 0 }, 1n);
    assert.equal((await view("get_config")).fee_bps, 0);
    assert.equal((await view("get_match", { id: "running" })).meta.fee_bps, 250, "an old match keeps the fee it was opened with");
    await open(alice, "free");
    assert.equal((await view("get_match", { id: "free" })).meta.fee_bps, 0, "a new match is opened free");
    console.log("  the owner set the fee to 0: old matches keep 2.5%, new ones are free");

    // They play on: the old lobby still starts by itself, the old game takes turns, and giving up settles it, at 2.5%.
    await call(bob, "join", { id: "lobby", seat: 1 }, Y / 10n);
    assert.equal((await view("get_match", { id: "lobby" })).meta.status, "playing", "an old lobby still starts with its last seat");
    await playTurn("running");
    const running = await view("get_match", { id: "running" });
    const waiting = running.meta.current_seat === seatOf(running, alice) ? bob : alice;
    const resigned = await call(waiting, "play", { id: "running", seat: seatOf(running, waiting), actions: ["Resign"] });
    assert.ok(resigned.receipts_outcome.some((receipt) => receipt.outcome.logs.some((log) => log.includes('"kind":"resign"'))), "the resign shows in the events");
    assert.equal(await view("get_match", { id: "running" }), null);
    const result = await view("get_result", { id: "running" });
    assert.equal(result.reason, "last");
    assert.equal(result.backers[0], waiting === alice ? bob.accountId : alice.accountId, "whoever stayed wins");
    assert.equal(result.fee, String((2n * Y) / 10n / 40n), "the old game paid the 2.5% it was opened with");
    console.log("  an old game played on, giving up settled it, at the fee it was opened with");

    // The free match plays out with no fee.
    await call(alice, "join", { id: "free", seat: 0 }, Y / 10n);
    await call(bob, "join", { id: "free", seat: 1 }, Y / 10n);
    const free = await view("get_match", { id: "free" });
    const leaver = free.meta.current_seat === seatOf(free, alice) ? bob : alice;
    await call(leaver, "play", { id: "free", seat: seatOf(free, leaver), actions: ["Resign"] });
    assert.equal((await view("get_result", { id: "free" })).fee, "0", "a match opened free pays no fee");
    console.log("  a match opened after the change paid no fee");

    // A hosted match: full is not started; only the host starts it, also with a key that can only call `play`.
    await open(alice, "room", { host: alice.accountId, seats: 3, split: [6000, 3000, 1000] });
    assert.equal((await view("get_match", { id: "room" })).meta.host, alice.accountId);
    await call(alice, "join", { id: "room", seat: 0 }, Y / 10n);
    await call(bob, "join", { id: "room", seat: 1 }, Y / 10n);
    await call(carol, "join", { id: "room", seat: 2 }, Y / 10n);
    assert.equal((await view("get_match", { id: "room" })).meta.status, "lobby", "a hosted match waits for its host");
    await assert.rejects(call(bob, "start", { id: "room" }), /the host starts the game/);
    const sessionKey = KeyPair.fromRandom("ed25519");
    await alice.addKey(sessionKey.getPublicKey(), contractId, ["play", "turn", "timeout", "set_driver", "leave"], Y / 4n);
    const session = await (await connect({ networkId: "sandbox", nodeUrl: sandbox.rpcUrl, keyStore: (() => { const store = new keyStores.InMemoryKeyStore(); store.setKey("sandbox", alice.accountId, sessionKey); return store; })() })).account(alice.accountId);
    await session.functionCall({ contractId, methodName: "play", args: { id: "room", seat: 0, actions: ["Start"] }, gas: 100n * TGAS });
    const room = await view("get_match", { id: "room" });
    assert.deepEqual([room.meta.status, room.meta.host, room.game.order.length], ["playing", null, 3]);
    await playTurn("room");
    console.log("  a hosted room of three waited for its host, who started it with a session key");
    console.log("DRY RUN PASSED: the new build can be deployed over the live one");
  } finally {
    await stop();
  }
}

async function run(wasm) {
  if (!PARENT.endsWith(".testnet")) throw new Error("DEEDLORDS_PARENT must be a .testnet account: this script never runs on mainnet");
  const keyStore = new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), ".near-credentials"));
  const near = await connect({ networkId: "testnet", nodeUrl: RPC, keyStore, headers: { "user-agent": "deedlords-dev/0.1" } });
  if ((await near.connection.provider.status()).chain_id !== "testnet") throw new Error("the RPC is not testnet's");
  if (!(await keyStore.getKey("testnet", GAME))) throw new Error(`no key for ${GAME} in ~/.near-credentials/testnet`);
  const game = await near.account(GAME);
  const live = await liveCode();
  const next = hashOf(wasm);
  console.log(`${GAME}: live ${live.hash} (${live.bytes.length} bytes) -> new ${next} (${wasm.length} bytes)`);
  if (live.hash === next) return console.log("That build is already live: nothing to do.");
  const view = (methodName, args = {}) => game.viewFunction({ contractId: GAME, methodName, args });
  const open = await view("list_matches", { from_index: 0, limit: 50 });
  const deployed = await game.deployContract(wasm);
  console.log(`deployed: ${deployed.transaction.hash}`);
  for (let i = 0; i < 10 && (await liveCode()).hash !== next; i++) await sleep(700);
  const now = await liveCode();
  assert.equal(now.hash, next, "the new code is live");
  const still = await view("list_matches", { from_index: 0, limit: 50 });
  assert.deepEqual(still.map((match) => match.id), open.map((match) => match.id), "every open match is still there");
  for (const meta of still) assert.ok(await view("get_match", { id: meta.id }), `${meta.id} still reads`);
  console.log(`config: ${JSON.stringify(await view("get_config"))}`);
  console.log(`open matches, all still readable: ${still.map((match) => `${match.id} (${match.status})`).join(", ") || "none"}`);
}

(async () => {
  const mode = process.argv[2];
  const wasm = fs.readFileSync(WASM);
  console.log(`wasm: ${WASM} (${wasm.length} bytes, hash ${hashOf(wasm)})`);
  if (mode === "dry") await dry(wasm);
  else if (mode === "run") await run(wasm);
  else console.log("usage: node upgrade.js dry | run");
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
