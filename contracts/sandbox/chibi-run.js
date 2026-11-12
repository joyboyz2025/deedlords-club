// Deedlords chibi characters (contracts/chibi): deploy, then go through what the web pages do.
//
//   node chibi-run.js                                   local near-sandbox (never leaves this machine)
//   CHIBI_PARENT=<you>.testnet node chibi-run.js testnet [--redeploy] [--pool <NEAR>]
//
// Sandbox: a minter makes a character for an account that never signs anything (as the server's sponsor does for a
// guest with no NEAR), claims a basic item and dresses it; the account buys boxes with its own NEAR and wears what
// came out; the refusals that keep the free pool and other accounts safe are tried; the owner withdraws the revenue.
// Testnet: creates chibi.<parent> (skipped if it exists, needs about 1 NEAR per 100 KB of wasm), deploys, calls
// new(owner = parent, minter = free.<parent>, box price 0.1 NEAR) and tops the free pool up to --pool NEAR (default 1)
// from the parent. Keys come from the NEAR credentials directory and are never printed. Refuses mainnet.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert/strict");
const { connect, keyStores, KeyPair } = require("near-api-js");

const Y = 10n ** 24n;
const NEAR = (n) => (BigInt(Math.round(n * 1000)) * Y) / 1000n;
const fmt = (yocto) => `${(Number(BigInt(yocto) / 10n ** 18n) / 1e6).toFixed(4)} NEAR`;
const GAS = 100n * 10n ** 12n;
const PRICE = NEAR(0.1);
const WASM = process.env.CHIBI_WASM ?? path.join(__dirname, "../target/wasm32-unknown-unknown/release/deedlords_chibi.wasm");

const tgas = (outcome) => {
  const burnt = [outcome.transaction_outcome, ...outcome.receipts_outcome].reduce((sum, o) => sum + BigInt(o.outcome.gas_burnt), 0n);
  return `${(Number(burnt) / 1e12).toFixed(1)} Tgas`;
};
const value = (outcome) => {
  const success = outcome.status && outcome.status.SuccessValue;
  return success ? JSON.parse(Buffer.from(success, "base64").toString()) : null;
};

async function call(account, contractId, methodName, args, deposit = 0n) {
  return account.functionCall({ contractId, methodName, args, gas: GAS, attachedDeposit: deposit });
}

async function refused(promise, words) {
  try {
    await promise;
  } catch (error) {
    const text = String(error && (error.message || error));
    assert.ok(text.includes(words), `refused, but not for "${words}": ${text.slice(0, 300)}`);
    return;
  }
  assert.fail(`should have been refused: ${words}`);
}

const LOOK = { body: 1, skin: 2, hair: 4, hairColor: 1, outfit: 1, robe: 5, neck: 1, hat: 5, face: 0, held: 3, shoes: 1, pet: 0, ride: 0 };

async function sandboxRun() {
  const { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } = require("near-sandbox");
  const wasm = fs.readFileSync(WASM);
  console.log(`wasm: ${wasm.length} bytes; booting a local near-sandbox...`);
  const sandbox = await Sandbox.start({});
  const stop = async () => {
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
    const chibi = await make("chibi", 10);
    const [owner, minter, alice, bob] = [await make("owner", 5), await make("minter", 2), await make("alice", 5), await make("bob", 5)];
    const id = chibi.accountId;
    const view = (methodName, args = {}) => owner.viewFunction({ contractId: id, methodName, args });
    await chibi.deployContract(wasm);
    await call(chibi, id, "new", { owner_id: owner.accountId, minter_id: minter.accountId, box_price: PRICE.toString() });
    console.log(`deployed to ${id}`);

    await refused(call(minter, id, "create_character", { owner: alice.accountId, name: "Alice", look: LOOK }), "the free pool is empty");
    await call(owner, id, "fund_free_pool", {}, NEAR(1));
    const minterBefore = BigInt((await minter.getAccountBalance()).total);
    const created = await call(minter, id, "create_character", { owner: alice.accountId, name: "Bà Alice", look: LOOK });
    const character = value(created);
    assert.deepEqual(character.look, LOOK);
    assert.equal(character.name, "Bà Alice");
    const pool = BigInt((await view("settings")).freePool);
    console.log(`create_character (by the minter, for alice): ${tgas(created)}; the free pool paid ${fmt(NEAR(1) - pool)} of storage`);
    await new Promise((r) => setTimeout(r, 3000)); // the unused gas comes back in a later receipt
    const minterSpent = minterBefore - BigInt((await minter.getAccountBalance()).total);
    assert.ok(minterSpent < NEAR(0.02), `the minter only pays gas, paid ${fmt(minterSpent)}`);
    const owned = await view("nft_tokens_for_owner", { account_id: alice.accountId });
    assert.equal(owned.length, 1 + Object.keys(character.worn).length, "the character and each item it wears");
    console.log(`  alice holds ${owned.map((t) => `${t.token_id} (${t.metadata.title})`).join(", ")}`);

    await refused(call(minter, id, "create_character", { owner: bob.accountId, name: "BÀ ALICE", look: LOOK }), "that name is taken");
    await refused(call(bob, id, "create_character", { owner: alice.accountId, name: "Mallory", look: LOOK }), "only the minter acts for another account");
    await refused(call(minter, id, "create_character", { owner: bob.accountId, name: "Bob", look: { ...LOOK, hat: 10 } }), "basic items only");

    const claimed = await call(minter, id, "claim", { owner: alice.accountId, part: "hat", index: 4 });
    const straw = value(claimed);
    console.log(`claim (basic, by the minter): ${tgas(claimed)} -> ${straw}`);
    await refused(call(minter, id, "claim", { owner: alice.accountId, part: "hat", index: 4 }), "already took that item");
    await refused(call(minter, id, "claim", { owner: alice.accountId, part: "hat", index: 10 }), "only basic items are free");

    const outfit = { body: 1, skin: 2, hairColor: 1, robe: 5, worn: [straw, character.worn.hair, character.worn.outfit] };
    const dressed = await call(minter, id, "equip", { owner: alice.accountId, outfit });
    assert.equal(value(dressed).look.hat, 4);
    assert.equal(value(dressed).look.neck, 0, "what is not named goes back to bare");
    console.log(`equip (by the minter): ${tgas(dressed)}`);

    await refused(call(bob, id, "buy_box", {}, PRICE), "make a character first");
    await refused(call(alice, id, "buy_box", {}, PRICE - 1n), "a box costs");
    const before = BigInt((await alice.getAccountBalance()).total);
    const bought = await call(alice, id, "buy_box", {}, PRICE + NEAR(0.5));
    const box = value(bought);
    const after = BigInt((await alice.getAccountBalance()).total);
    assert.ok(box.rarity >= 1, "a box gives Rare or better");
    assert.ok(before - after < PRICE + NEAR(0.02), "the deposit above the price came back");
    console.log(`buy_box: ${tgas(bought)} -> ${box.tokenId} (${box.name}, rarity ${box.rarity}); alice paid ${fmt(before - after)} with gas`);
    for (let n = 0; n < 9; n++) {
      const more = value(await call(alice, id, "buy_box", {}, PRICE));
      process.stdout.write(`  ${more.name} (${more.rarity})${n === 8 ? "\n" : ","}`);
    }
    const count = await view("box_count_of", { account_id: alice.accountId });
    assert.equal(count.opened, 10);
    assert.ok(count.sinceEpic < 10, "ten boxes always give at least one Epic");

    const wearing = value(await call(alice, id, "equip", { outfit: { ...outfit, worn: [box.tokenId] } }));
    assert.equal(wearing.worn[box.part], box.tokenId, "alice wears what came out, signing herself without a deposit");
    await call(alice, id, "nft_transfer", { receiver_id: bob.accountId, token_id: box.tokenId }, 1n);
    assert.equal((await view("character_of", { account_id: alice.accountId })).worn[box.part], undefined, "given away, no longer worn");
    await refused(call(alice, id, "nft_transfer", { receiver_id: bob.accountId, token_id: character.tokenId }, 1n), "a character stays with its account");
    const [a, b] = await view("characters_of", { account_ids: [alice.accountId, bob.accountId] });
    assert.equal(a.name, "Bà Alice");
    assert.equal(b, null);

    const settings = await view("settings");
    await refused(call(alice, id, "withdraw_revenue", {}), "only the owner");
    await call(owner, id, "withdraw_revenue", {});
    console.log(`the owner withdrew ${fmt(settings.revenue)} of box revenue (10 boxes at ${fmt(PRICE)} less their storage)`);
    assert.equal((await view("settings")).revenue, "0");
    console.log("all good");
  } finally {
    clearTimeout(watchdog);
    await stop();
  }
}

async function testnetRun() {
  const parent = process.env.CHIBI_PARENT;
  if (!parent || !parent.endsWith(".testnet")) throw new Error("set CHIBI_PARENT to a .testnet account whose key is in the NEAR credentials directory");
  const poolArg = process.argv.indexOf("--pool");
  const poolTarget = NEAR(poolArg > 0 ? Number(process.argv[poolArg + 1]) : 1);
  const keyStore = new keyStores.UnencryptedFileSystemKeyStore(process.env.NEAR_CREDENTIALS_DIR ?? path.join(os.homedir(), ".near-credentials"));
  const near = await connect({ networkId: "testnet", nodeUrl: process.env.CHIBI_RPC ?? "https://test.rpc.fastnear.com", keyStore });
  const status = await near.connection.provider.status();
  if (status.chain_id !== "testnet") throw new Error(`expected chain testnet, the RPC reports ${status.chain_id}`);
  const wasm = fs.readFileSync(WASM);
  const chibiId = `chibi.${parent}`;
  const minterId = `free.${parent}`;
  const root = await near.account(parent);
  const exists = await near.connection.provider.query({ request_type: "view_account", finality: "final", account_id: chibiId }).then(
    () => true,
    () => false,
  );
  if (!exists) {
    const fund = (BigInt(wasm.length) * 10n ** 19n * 115n) / 100n + NEAR(0.3);
    const balance = BigInt((await root.getAccountBalance()).available);
    if (balance < fund + poolTarget + NEAR(0.1)) throw new Error(`${parent} has ${fmt(balance)} available; ${chibiId} needs ${fmt(fund)} plus the pool`);
    const key = KeyPair.fromRandom("ed25519");
    await keyStore.setKey("testnet", chibiId, key); // before the transaction: a key nobody kept would strand the account
    const made = await root.createAccount(chibiId, key.getPublicKey(), fund);
    console.log(`created ${chibiId} with ${fmt(fund)}: ${made.transaction.hash}`);
  }
  const chibi = await near.account(chibiId);
  const state = await chibi.state();
  if (state.code_hash === "11111111111111111111111111111111") {
    await chibi.deployContract(wasm);
    await call(chibi, chibiId, "new", { owner_id: parent, minter_id: minterId, box_price: PRICE.toString() });
    console.log(`deployed ${wasm.length} bytes to ${chibiId}`);
  } else if (process.argv.includes("--redeploy")) {
    await chibi.deployContract(wasm);
    console.log(`redeployed ${wasm.length} bytes to ${chibiId} (state kept)`);
  }
  const settings = await root.viewFunction({ contractId: chibiId, methodName: "settings", args: {} });
  const pool = BigInt(settings.freePool);
  if (pool < poolTarget) {
    const topped = await call(root, chibiId, "fund_free_pool", {}, poolTarget - pool);
    console.log(`free pool topped up by ${fmt(poolTarget - pool)} from ${parent}: ${topped.transaction.hash}`);
  }
  console.log(await root.viewFunction({ contractId: chibiId, methodName: "settings", args: {} }));
  console.log(`contract: https://testnet.nearblocks.io/address/${chibiId}`);
}

(process.argv[2] === "testnet" ? testnetRun() : sandboxRun()).catch((e) => {
  console.error(e);
  process.exit(1);
});
