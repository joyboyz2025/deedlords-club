// node mainnet.js plan | rehearse | run --yes
//
// Puts Deedlords Club on NEAR MAINNET, with real NEAR. Three modes:
//   plan        reads the chain and prints every transaction it would send, what each costs, and what is missing.
//               Signs nothing. Safe to run any time.
//   rehearse    the same steps, signed and sent, on a LOCAL near-sandbox (a parent account made there), then a check
//               that the contract answers as planned. Spends nothing real.
//   run --yes   sends exactly those transactions, signed by the parent account's full-access key from
//               ~/.near-credentials/mainnet/<parent>.json. Only the owner of that key runs this, by hand.
//
// What it builds, under the parent (DEEDLORDS_PARENT, default deedlords.near), each step skipped when already done:
//   1. game.<parent>   created and funded, the board-game wasm deployed and new(owner, house, max_stake, fee_bps)
//                      called in the same transaction, so nobody can initialise it first. fee_bps starts at 0; the
//                      owner can change it later with set_fee (contracts/README.md, "Fee").
//   2. house.<parent>  the house's account (a seat the house holds forfeits its share).
//   3. poker.<parent>  only when POKER_WASM and POKER_INIT (the JSON arguments of its `new`) are given: the poker
//                      contract is the poker session's, and its arguments come from there.
//   4. pokersweep.<parent>  with poker: an account that only calls `timeout` on abandoned tables (the server's
//                      POKER_SWEEP_ACCOUNT); it never sits down and stakes nothing. 0.3 NEAR is gas for hundreds of calls.
// New accounts get a fresh full-access key, written to ~/.near-credentials/mainnet/ before the account exists.
//
//   5. free.<parent>  the sponsor of free tables (FREE_SPONSOR_NEAR, default 1.5; 0 leaves it out): it opens a table
//                      with nothing staked, sits the house's AI agents at it and pays every move's gas, so a visitor
//                      plays the AI on mainnet with no NEAR at all.
//   6. chibi.<parent>  the characters, items and boxes (contracts/chibi; CHIBI_WASM, default the release build;
//                      CHIBI=0 leaves it out): new(owner = parent, minter = free.<parent>, box price CHIBI_BOX_NEAR,
//                      default 0.1) in the deploy transaction, then its free pool topped up to CHIBI_POOL_NEAR (default
//                      1) from the parent: the pool pays the storage of the characters the sponsor makes for guests.
//   7. pokerhouse.<parent>, pokerhouse2…  only with POKER_HOUSES=<n> (default 0): accounts whose AI agents take seats
//                      at poker tables and stake REAL NEAR there (1 NEAR each, POKER_HOUSE_NEAR). Off unless asked.
// Every account made here gets its key in ~/.near-credentials/mainnet/, where the server reads it on this machine.
//
// Environment: DEEDLORDS_PARENT, NEAR_RPC (default FastNEAR's free node), GAME_WASM (default the release build),
// MAX_STAKE_NEAR (default 1), POKER_WASM, POKER_INIT, POKER_FUND_NEAR.
// Poker, heads-up (what /poker plays today): POKER_WASM=../poker/target/wasm32-unknown-unknown/release/deedlords_poker.wasm
//   POKER_INIT='{}'. Two to nine seats: POKER_WASM=../poker-table/target/wasm32-unknown-unknown/release/deedlords_poker_table.wasm
//   POKER_INIT='{"owner":"$PARENT","fee_bps":0}'. Paths are from contracts/sandbox.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { connect, keyStores, KeyPair, transactions, utils } = require("near-api-js");

const Y = 10n ** 24n;
const NEAR = (n) => (BigInt(Math.round(n * 1e6)) * Y) / 1_000_000n;
const TGAS = 10n ** 12n;
/** Mainnet storage: 1e19 yoctoNEAR a byte (1 NEAR per 100 KB). */
const BYTE = 10n ** 19n;

let PARENT = process.env.DEEDLORDS_PARENT ?? "deedlords.near";
let RPC = process.env.NEAR_RPC ?? "https://free.rpc.fastnear.com";
let NETWORK = "mainnet";
const GAME_WASM = process.env.GAME_WASM ?? path.join(__dirname, "../target/wasm32-unknown-unknown/release/deedlords.wasm");
const MAX_STAKE = NEAR(Number(process.env.MAX_STAKE_NEAR ?? 1));
const FEE_BPS = 0;
const POKER_WASM = process.env.POKER_WASM ?? null;
/** The poker contract's `new` arguments, as JSON; `$PARENT` in it stands for the parent account. */
const POKER_INIT_RAW = process.env.POKER_INIT ?? null;
const pokerInit = () => POKER_INIT_RAW && POKER_INIT_RAW.replaceAll("$PARENT", PARENT);
/** Room for state beyond the code: open matches, results, Deed NFTs. Their creators' deposits pay for most of it. */
const STATE_ROOM = NEAR(0.5);
const HOUSE_FUND = NEAR(0.2);
const SWEEP_FUND = NEAR(0.3);
const SPONSOR_FUND = NEAR(Number(process.env.FREE_SPONSOR_NEAR ?? 1.5));
const CHIBI_WASM = process.env.CHIBI === "0" ? null : (process.env.CHIBI_WASM ?? path.join(__dirname, "../target/wasm32-unknown-unknown/release/deedlords_chibi.wasm"));
const CHIBI_BOX = NEAR(Number(process.env.CHIBI_BOX_NEAR ?? 0.1));
const CHIBI_POOL = NEAR(Number(process.env.CHIBI_POOL_NEAR ?? 1));
const POKER_HOUSES = Number(process.env.POKER_HOUSES ?? 0);
const POKER_HOUSE_FUND = NEAR(Number(process.env.POKER_HOUSE_NEAR ?? 1));
/** Left on the parent after everything, for its own gas. */
const PARENT_KEEPS = NEAR(0.2);
const CREDS = path.join(os.homedir(), ".near-credentials");

const fmt = (yocto) => `${(Number(BigInt(yocto) / 10n ** 18n) / 1e6).toFixed(4)} NEAR`;
const hashOf = (bytes) => utils.serialize.base_encode(crypto.createHash("sha256").update(bytes).digest());

async function rpc(method, params) {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "deedlords-deploy/0.1" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) {
    if (body.error.cause?.name === "UNKNOWN_ACCOUNT") return null;
    throw new Error(`${method}: ${JSON.stringify(body.error).slice(0, 300)}`);
  }
  return body.result;
}
const view = async (id, method, args = {}) =>
  JSON.parse(
    Buffer.from(
      (
        await rpc("query", {
          request_type: "call_function",
          finality: "final",
          account_id: id,
          method_name: method,
          args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
        })
      ).result,
    ).toString(),
  );
const viewAccount = (id) => rpc("query", { request_type: "view_account", finality: "final", account_id: id });

async function main() {
  const mode = process.argv[2];
  const yes = process.argv.includes("--yes");
  if (mode === "rehearse") return rehearse();
  if (mode !== "plan" && mode !== "run") return console.log("usage: node mainnet.js plan | rehearse | run --yes");
  if (mode === "run" && !yes) throw new Error("run sends real transactions with real NEAR: add --yes once the plan reads right");
  if (!PARENT.endsWith(".near") || PARENT.endsWith(".testnet")) throw new Error(`${PARENT} is not a mainnet account`);
  const status = await rpc("status", []);
  if (status.chain_id !== "mainnet") throw new Error(`${RPC} is ${status.chain_id}, not mainnet`);
  const keyStore = new keyStores.UnencryptedFileSystemKeyStore(CREDS);
  return deploy(mode, keyStore, path.join(CREDS, "mainnet", `${PARENT}.json`));
}

/** On a local near-sandbox: a parent with 30 NEAR, the same plan and run, then the contract's answers checked. */
async function rehearse() {
  const assert = require("assert");
  const { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } = require("near-sandbox");
  console.log("booting a local near-sandbox...");
  const sandbox = await Sandbox.start({});
  try {
    const keyStore = new keyStores.InMemoryKeyStore();
    await keyStore.setKey("sandbox", DEFAULT_ACCOUNT_ID, KeyPair.fromString(DEFAULT_PRIVATE_KEY));
    const near = await connect({ networkId: "sandbox", nodeUrl: sandbox.rpcUrl, keyStore });
    PARENT = `club.${DEFAULT_ACCOUNT_ID}`;
    RPC = sandbox.rpcUrl;
    NETWORK = "sandbox";
    const parentKey = KeyPair.fromRandom("ed25519");
    await keyStore.setKey("sandbox", PARENT, parentKey);
    await (await near.account(DEFAULT_ACCOUNT_ID)).createAccount(PARENT, parentKey.getPublicKey(), NEAR(30));
    // The plan reads final state, a couple of blocks behind.
    for (let i = 0; i < 40 && !(await viewAccount(PARENT)); i++) await new Promise((done) => setTimeout(done, 250));
    await deploy("run", keyStore, null);
    const rpcView = view;
    const viewGame = async (method, args = {}) =>
      JSON.parse(
        Buffer.from(
          (
            await rpc("query", {
              request_type: "call_function",
              finality: "final",
              account_id: `game.${PARENT}`,
              method_name: method,
              args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
            })
          ).result,
        ).toString(),
      );
    const config = await viewGame("get_config");
    assert.equal(config.owner, PARENT);
    assert.equal(config.house, `house.${PARENT}`);
    assert.equal(config.fee_bps, 0);
    assert.equal(config.max_stake, MAX_STAKE.toString());
    // Run again: everything is in place, nothing is sent.
    for (let i = 0; i < 40 && !(await viewAccount(`house.${PARENT}`)); i++) await new Promise((done) => setTimeout(done, 250));
    await new Promise((done) => setTimeout(done, 1500));
    await deploy("plan", keyStore, null);
    // The owner can still set a fee later, for matches opened from then on.
    const parent = await near.account(PARENT);
    await parent.functionCall({ contractId: `game.${PARENT}`, methodName: "set_fee", args: { fee_bps: 100 }, gas: 30n * TGAS, attachedDeposit: 1n });
    if (POKER_WASM) {
      const poker = await viewAccount(`poker.${PARENT}`);
      assert.equal(poker.code_hash, hashOf(fs.readFileSync(POKER_WASM)), "the poker code is live");
      const init = JSON.parse(pokerInit());
      if (init.owner) {
        const config = JSON.parse(
          Buffer.from(
            (
              await rpc("query", {
                request_type: "call_function",
                finality: "final",
                account_id: `poker.${PARENT}`,
                method_name: "get_config",
                args_base64: Buffer.from("{}").toString("base64"),
              })
            ).result,
          ).toString(),
        );
        assert.equal(config.owner, PARENT);
        assert.equal(config.fee_bps, init.fee_bps);
      }
      console.log(`  poker.${PARENT}: code live${init.owner ? ", owner and fee as planned" : ""}`);
    }
    if (CHIBI_WASM) {
      const settings = await rpcView(`chibi.${PARENT}`, "settings");
      assert.equal(BigInt(settings.freePool), CHIBI_POOL, "the free pool is funded");
      console.log(`  chibi.${PARENT}: code live, free pool ${fmt(settings.freePool)}`);
    }
    for (let i = 0; i < 40 && (await viewGame("get_config")).fee_bps !== 100; i++) await new Promise((done) => setTimeout(done, 250));
    assert.equal((await viewGame("get_config")).fee_bps, 100);
    console.log("REHEARSAL PASSED: the run creates, deploys and initialises as planned, a second run has nothing to do, and the owner can set a fee");
  } finally {
    sandbox.childProcess.kill("SIGKILL");
    await new Promise((done) => setTimeout(done, 500));
    await fs.promises.rm(sandbox.homeDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function deploy(mode, keyStore, keyFile) {
  const game = `game.${PARENT}`;
  const house = `house.${PARENT}`;
  const poker = `poker.${PARENT}`;
  const wasm = fs.readFileSync(GAME_WASM);
  const parentOnChain = await viewAccount(PARENT);
  const hasKey = keyFile ? fs.existsSync(keyFile) : Boolean(await keyStore.getKey(NETWORK, PARENT));
  const sweep = `pokersweep.${PARENT}`;
  const [gameOnChain, houseOnChain, pokerOnChain, sweepOnChain] = await Promise.all([viewAccount(game), viewAccount(house), viewAccount(poker), viewAccount(sweep)]);
  const pokerWasm = POKER_WASM ? fs.readFileSync(POKER_WASM) : null;

  const steps = [];
  const gameFund = BigInt(wasm.length + 2_000) * BYTE + STATE_ROOM;
  if (!gameOnChain)
    steps.push({
      what: `create ${game} with ${fmt(gameFund)} (${wasm.length} bytes of code at 1 NEAR per 100 KB, plus ${fmt(STATE_ROOM)} for state)`,
      cost: gameFund,
      kind: "create",
      id: game,
      fund: gameFund,
    });
  if (!gameOnChain || gameOnChain.code_hash !== hashOf(wasm))
    steps.push({
      what: `deploy ${path.basename(GAME_WASM)} (hash ${hashOf(wasm)}) to ${game} and call new(owner=${PARENT}, house=${house}, max_stake=${fmt(MAX_STAKE)}, fee_bps=${FEE_BPS}) in one transaction`,
      cost: NEAR(0.01),
      kind: "deploy-game",
      fresh: !gameOnChain || gameOnChain.code_hash === "11111111111111111111111111111111",
    });
  if (!houseOnChain) steps.push({ what: `create ${house} with ${fmt(HOUSE_FUND)}`, cost: HOUSE_FUND, kind: "create", id: house, fund: HOUSE_FUND });
  if (pokerWasm) {
    if (!pokerInit()) throw new Error("POKER_WASM without POKER_INIT: give the JSON arguments of the poker contract's new");
    const pokerFund = process.env.POKER_FUND_NEAR ? NEAR(Number(process.env.POKER_FUND_NEAR)) : BigInt(pokerWasm.length + 2_000) * BYTE + STATE_ROOM;
    if (!pokerOnChain) steps.push({ what: `create ${poker} with ${fmt(pokerFund)}`, cost: pokerFund, kind: "create", id: poker, fund: pokerFund });
    if (!pokerOnChain || pokerOnChain.code_hash !== hashOf(pokerWasm))
      steps.push({
        what: `deploy ${path.basename(POKER_WASM)} (hash ${hashOf(pokerWasm)}) to ${poker} and call new(${pokerInit()}) in one transaction`,
        cost: NEAR(0.01),
        kind: "deploy-poker",
        fresh: !pokerOnChain || pokerOnChain.code_hash === "11111111111111111111111111111111",
      });
    if (!sweepOnChain)
      steps.push({
        what: `create ${sweep} with ${fmt(SWEEP_FUND)} (calls time on abandoned poker tables; never sits down)`,
        cost: SWEEP_FUND,
        kind: "create",
        id: sweep,
        fund: SWEEP_FUND,
      });
  }
  // The AI's accounts: the free tables' sponsor, and poker house seats only when asked for.
  const sponsorId = `free.${PARENT}`;
  if (SPONSOR_FUND > 0n && !(await viewAccount(sponsorId)))
    steps.push({
      what: `create ${sponsorId} with ${fmt(SPONSOR_FUND)} (free tables: the house's AI agents play, this account pays the gas)`,
      cost: SPONSOR_FUND,
      kind: "create",
      id: sponsorId,
      fund: SPONSOR_FUND,
    });
  // The characters: created, deployed with its new in one transaction, and its free pool topped up.
  const chibi = `chibi.${PARENT}`;
  const chibiWasm = CHIBI_WASM && fs.existsSync(CHIBI_WASM) ? fs.readFileSync(CHIBI_WASM) : null;
  if (CHIBI_WASM && !chibiWasm) throw new Error(`no chibi wasm at ${CHIBI_WASM}: build it (contracts/README.md) or set CHIBI=0`);
  const chibiOnChain = chibiWasm ? await viewAccount(chibi) : null;
  if (chibiWasm) {
    const chibiFund = BigInt(chibiWasm.length + 2_000) * BYTE + STATE_ROOM;
    if (!chibiOnChain) steps.push({ what: `create ${chibi} with ${fmt(chibiFund)}`, cost: chibiFund, kind: "create", id: chibi, fund: chibiFund });
    const fresh = !chibiOnChain || chibiOnChain.code_hash === "11111111111111111111111111111111";
    if (!chibiOnChain || chibiOnChain.code_hash !== hashOf(chibiWasm))
      steps.push({
        what: `deploy ${path.basename(CHIBI_WASM)} (hash ${hashOf(chibiWasm)}) to ${chibi}${fresh ? ` and call new(owner_id=${PARENT}, minter_id=${sponsorId}, box_price=${fmt(CHIBI_BOX)}) in one transaction` : " (state kept)"}`,
        cost: NEAR(0.01),
        kind: "deploy-chibi",
        fresh,
      });
    const pool = fresh ? 0n : BigInt((await view(chibi, "settings")).freePool);
    if (pool < CHIBI_POOL)
      steps.push({
        what: `fund_free_pool on ${chibi} with ${fmt(CHIBI_POOL - pool)} from ${PARENT} (pays the storage of guests' free characters)`,
        cost: CHIBI_POOL - pool,
        kind: "chibi-pool",
        deposit: CHIBI_POOL - pool,
      });
  }
  const houseIds = Array.from({ length: pokerWasm ? POKER_HOUSES : 0 }, (_, i) => `pokerhouse${i === 0 ? "" : i + 1}.${PARENT}`);
  for (const id of houseIds)
    if (!(await viewAccount(id)))
      steps.push({
        what: `create ${id} with ${fmt(POKER_HOUSE_FUND)} (an AI seat at poker: it stakes REAL NEAR)`,
        cost: POKER_HOUSE_FUND,
        kind: "create",
        id,
        fund: POKER_HOUSE_FUND,
      });
  const total = steps.reduce((sum, step) => sum + step.cost, 0n) + PARENT_KEEPS;

  console.log(`NEAR ${NETWORK.toUpperCase()} via ${RPC}`);
  console.log(
    `parent ${PARENT}: ${parentOnChain ? `exists, ${fmt(parentOnChain.amount)}` : "DOES NOT EXIST: create it in a NEAR wallet first"}; key ${hasKey ? (keyFile ?? "in memory") : `MISSING at ${keyFile}`}`,
  );
  console.log(`game   ${game}: ${gameOnChain ? `exists, ${fmt(gameOnChain.amount)}, code ${gameOnChain.code_hash}` : "to create"}`);
  console.log(`house  ${house}: ${houseOnChain ? `exists, ${fmt(houseOnChain.amount)}` : "to create"}`);
  console.log(`poker  ${poker}: ${pokerWasm ? (pokerOnChain ? `exists, code ${pokerOnChain.code_hash}` : "to create") : "skipped (no POKER_WASM)"}`);
  if (chibiWasm) console.log(`chibi  ${chibi}: ${chibiOnChain ? `exists, code ${chibiOnChain.code_hash}` : "to create"}`);
  if (pokerWasm) console.log(`sweep  ${sweep}: ${sweepOnChain ? `exists, ${fmt(sweepOnChain.amount)}` : "to create"} (server: POKER_SWEEP_ACCOUNT=${sweep})`);
  console.log(steps.length ? "\nTransactions, in order:" : "\nNothing to do: everything is in place.");
  steps.forEach((step, i) => console.log(`  ${i + 1}. ${step.what}`));
  console.log(`\nThe parent needs about ${fmt(total)} (the steps, plus ${fmt(PARENT_KEEPS)} kept for gas).`);
  console.log(`\nThe mainnet server then runs with (npm run start:mainnet sets these):`);
  console.log(
    `  NEXT_PUBLIC_NEAR_NETWORK=mainnet${SPONSOR_FUND > 0n ? ` DEEDLORDS_SPONSOR_ACCOUNT=${sponsorId}` : ""}${pokerWasm ? ` POKER_SWEEP_ACCOUNT=pokersweep.${PARENT}` : ""}${houseIds.length ? ` POKER_HOUSE_ACCOUNTS=${houseIds.join(",")}` : ""}`,
  );
  const short = parentOnChain ? total - BigInt(parentOnChain.amount) : total;
  if (short > 0n) console.log(`It is ${fmt(short)} short: send that much to ${PARENT} before run.`);
  if (mode === "plan" || steps.length === 0) return;

  if (!parentOnChain) throw new Error(`${PARENT} does not exist`);
  if (!hasKey) throw new Error(`no key for ${PARENT} at ${keyFile}`);
  if (short > 0n) throw new Error(`${PARENT} holds too little`);
  const near = await connect({ networkId: NETWORK, nodeUrl: RPC, keyStore, headers: { "user-agent": "deedlords-deploy/0.1" } });
  const parent = await near.account(PARENT);
  for (const step of steps) {
    if (step.kind === "create") {
      let key = await keyStore.getKey(NETWORK, step.id);
      if (!key) {
        key = KeyPair.fromRandom("ed25519");
        await keyStore.setKey(NETWORK, step.id, key); // stored before the account exists
      }
      const done = await parent.createAccount(step.id, key.getPublicKey(), step.fund);
      console.log(`  created ${step.id}: tx ${done.transaction.hash}`);
    } else if (step.kind === "deploy-chibi") {
      const account = await near.account(chibi);
      const actions = [transactions.deployContract(chibiWasm)];
      if (step.fresh) actions.push(transactions.functionCall("new", { owner_id: PARENT, minter_id: sponsorId, box_price: CHIBI_BOX.toString() }, 100n * TGAS, 0n));
      const done = await account.signAndSendTransaction({ receiverId: chibi, actions });
      console.log(`  deployed to ${chibi}: tx ${done.transaction.hash}`);
    } else if (step.kind === "chibi-pool") {
      const done = await parent.functionCall({ contractId: chibi, methodName: "fund_free_pool", args: {}, gas: 30n * TGAS, attachedDeposit: step.deposit });
      console.log(`  free pool of ${chibi} topped up: tx ${done.transaction.hash}`);
    } else {
      const forGame = step.kind === "deploy-game";
      const id = forGame ? game : poker;
      const code = forGame ? wasm : pokerWasm;
      const account = await near.account(id);
      const actions = [transactions.deployContract(code)];
      // A contract already initialised keeps its state: a new build is deployed alone, like upgrade.js on testnet.
      if (step.fresh)
        actions.push(
          transactions.functionCall("new", forGame ? { owner: PARENT, house, max_stake: MAX_STAKE.toString(), fee_bps: FEE_BPS } : JSON.parse(pokerInit()), 100n * TGAS, 0n),
        );
      const done = await account.signAndSendTransaction({ receiverId: id, actions });
      console.log(`  deployed to ${id}: tx ${done.transaction.hash}`);
    }
  }
  const config = await rpc("query", {
    request_type: "call_function",
    finality: "final",
    account_id: game,
    method_name: "get_config",
    args_base64: Buffer.from("{}").toString("base64"),
  });
  console.log(`\n${game} get_config: ${Buffer.from(config.result).toString()}`);
}

main().catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
});
