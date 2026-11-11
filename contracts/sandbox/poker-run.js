// Deedlords Poker: deploy the contract and play it with the same code the page runs (games/poker/seat.ts, crypto.ts).
//
//   node --experimental-strip-types poker-run.js                      local near-sandbox (never leaves this machine)
//   POKER_PARENT=<you>.testnet node --experimental-strip-types poker-run.js testnet [--redeploy]
//
// It plays: a hand to the showdown (each seat's own decryption of its hole cards must equal what the contract shows),
// a folded hand, and a seat leaving between hands; then a second match in which a share made with the wrong key is
// refused, the second shuffler ignores the first shuffle, cannot open its own at the audit, and forfeits by timeout.
// On testnet it creates poker.<parent> (skipped if it exists) and plays between p1.<parent> and p2.<parent>. Keys are
// read from the NEAR credentials directory, never printed. Refuses mainnet.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert/strict");
const { connect, keyStores, KeyPair } = require("near-api-js");

const Y = 10n ** 24n;
const NEAR = (n) => (BigInt(Math.round(n * 1000)) * Y) / 1000n;
const fmt = (yocto) => `${(Number(BigInt(yocto) / 10n ** 18n) / 1e6).toFixed(4)} NEAR`;
const TGAS = 10n ** 12n;
/// An account must hold about 0.001 NEAR per Tgas it attaches, so calls attach what they need: the audit recomputes a
/// whole shuffle (about 117 Tgas), everything else stays under 20.
const gasFor = (method) => (method === "audit" ? 180n : 40n) * TGAS;
const WASM = process.env.POKER_WASM ?? path.join(__dirname, "../poker/target/wasm32-unknown-unknown/release/deedlords_poker.wasm");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CARD = (card) => "23456789TJQKA"[card % 13] + "cdhs"[Math.floor(card / 13)];

/** The most gas one call of each method burnt, in Tgas. */
const gasOf = {};

/// Sends a call; on testnet a free public RPC sometimes answers 429 or times out, so it is retried a few times.
async function call(account, contractId, methodName, args, deposit = 0n) {
  for (let attempt = 0; ; attempt++) {
    try {
      const outcome = await account.functionCall({ contractId, methodName, args, gas: gasFor(methodName), attachedDeposit: deposit });
      const burnt = [outcome.transaction_outcome, ...outcome.receipts_outcome].reduce((sum, o) => sum + o.outcome.gas_burnt, 0) / 1e12;
      gasOf[methodName] = Math.max(gasOf[methodName] ?? 0, burnt);
      return outcome;
    } catch (e) {
      const text = String(e && (e.message || e));
      if (attempt >= 6 || !/429|Rate limit|timeout|Timeout|ECONNRESET|fetch failed|Exceeded the/.test(text)) throw e;
      await sleep(1500 * (attempt + 1));
    }
  }
}

async function refused(promise, words) {
  const error = await promise.then(() => null, (e) => e);
  assert.ok(error, `the contract should have refused: ${words}`);
  assert.match(String(error.message || error), words);
}

async function run({ contractId, accounts, stake, explorer }) {
  const { newKeys, keyProof, openDeck, shuffle, shares, tableKey } = await import("../../games/poker/crypto.ts");
  const { duty, holeCards, holeAt, betOptions, toBase64, fromBase64 } = await import("../../games/poker/seat.ts");
  /// A read, tried again when the public RPC answers 429.
  const view = async (method, args) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await accounts[0].viewFunction({ contractId, methodName: method, args });
      } catch (e) {
        if (attempt >= 6 || !/429|Rate limit|timeout|Timeout|ECONNRESET|fetch failed/.test(String(e && (e.message || e)))) throw e;
        await sleep(1500 * (attempt + 1));
      }
    }
  };
  const link = (outcome) => (explorer ? `${explorer}/txns/${outcome.transaction.hash}` : outcome.transaction.hash);

  /// The match as the newest node sees it, never a view older than one already seen (a public RPC answers from
  /// several nodes, some a block behind). `null` once it is settled.
  const read = async (table) => {
    for (let tries = 0; ; tries++) {
      const now = await view("get_match", { id: table.id });
      if (now && now.seq >= table.seq) {
        table.seq = now.seq;
        return now;
      }
      if (!now && (await view("get_result", { id: table.id }))) return null;
      if (tries >= 60) throw new Error(`match ${table.id} did not reach change ${table.seq}`);
      await sleep(600);
    }
  };
  /// A call that changes the match: the next read waits for it.
  const move = async (table, account, method, args) => {
    const outcome = await call(account, contractId, method, args);
    table.seq += 1;
    return outcome;
  };

  /// A match and what each seat keeps to itself: its card key and the openings of its shuffles.
  const sitDown = async (id, turnSeconds) => {
    const keys = [newKeys(), newKeys()];
    const openings = [new Map(), new Map()];
    const stores = [0, 1].map((seat) => ({
      deck: async (hand, step) => {
        for (let tries = 0; ; tries++) {
          const deck = await view("get_deck", { id, hand, step });
          if (deck) return fromBase64(deck);
          if (tries >= 60) throw new Error(`deck ${step} of hand ${hand} of ${id} is not on chain`);
          await sleep(600);
        }
      },
      saveOpening: (deck, opening) => openings[seat].set(toBase64(deck), opening),
      loadOpening: (deck) => openings[seat].get(toBase64(deck)) ?? null,
    }));
    const proof = (seat) => toBase64(keyProof(keys[seat], accounts[seat].accountId));
    console.log(`match ${id}: ${accounts[0].accountId} against ${accounts[1].accountId}, stake ${fmt(stake)}`);
    console.log(`  create_match  ${link(await call(accounts[0], contractId, "create_match", { id, stake: stake.toString(), key: proof(0), turn_seconds: turnSeconds }, stake))}`);
    await refused(call(accounts[1], contractId, "join", { id, key: proof(0) }, stake), /does not show that you know this key/);
    console.log(`  join          ${link(await call(accounts[1], contractId, "join", { id, key: proof(1) }, stake))}`);
    return { id, keys, stores, seq: 2 };
  };

  /// Plays the hand under way to its end. `bet(view, seat)` answers [action, amount]; `tamper(view, seat, call)` may
  /// replace a call a seat owes. Returns the last view seen in the audit phase.
  const playHand = async (table, bet, tamper = (_view, _seat, owed) => owed) => {
    const { id, keys, stores } = table;
    const hand = (await read(table)).hand;
    let mine = [null, null];
    let audit = null;
    for (;;) {
      const now = await read(table);
      if (!now || now.hand !== hand) return audit;
      if (now.phase === "audit") audit = now;
      const seat = now.awaited[0];
      if (now.phase === "bet") {
        // Before its first bet a seat can read its own two cards, and nobody else's.
        mine[seat] ??= holeCards(now, seat, keys[seat], await stores[seat].deck(now.hand, 1));
        const [action, amount] = bet(now, seat);
        await move(table, accounts[seat], "act", { id, seat, action, amount: amount ?? null });
        continue;
      }
      const owed = await tamper(now, seat, await duty(now, seat, keys[seat], stores[seat]));
      const outcome = await move(table, accounts[seat], owed.method, owed.args).catch((e) => e);
      if (outcome instanceof Error) return { ...audit, refused: { seat, method: owed.method, text: String(outcome.message) }, mine };
      if (now.phase === "audit" && now.done.some(Boolean)) return { ...audit, mine, last: link(outcome) };
    }
  };

  // --- An honest match ---------------------------------------------------------------------------------------------
  const honest = await sitDown(`p-${Date.now().toString(36)}`, 120);
  // The button raises before the flop, everything is checked down, and the first to act bets the river.
  const first = await playHand(honest, (now, seat) => {
    const { owed, raise } = betOptions(now, seat);
    if (now.street === 0 && seat === now.button && owed === 1) return ["raise", 6];
    if (now.street === 3 && owed === 0 && seat !== now.button) return ["raise", Math.min(10, raise.max)];
    return ["call"];
  });
  assert.equal(first.refused, undefined, `an honest call was refused: ${JSON.stringify(first.refused)}`);
  assert.deepEqual(first.mine, first.hole, "each seat decrypted the very hole cards the contract showed at the end");
  assert.equal(first.board.length, 5);
  let after = await read(honest);
  const pot = 2 * (6 + 10);
  const won = first.outcome === "split" ? [100, 100] : [0, 1].map((seat) => 100 - pot / 2 + (first.outcome.won === seat ? pot : 0));
  assert.deepEqual(after.chips, won, "the pot went to the better hand");
  assert.deepEqual([after.hand, after.button, after.phase], [1, 1, "shuffle"]);
  console.log(`  hand 1: board ${first.board.map(CARD).join(" ")}; ${first.hole.map((hole) => hole.map(CARD).join(" ")).join(" against ")}; ${first.outcome === "split" ? "split pot" : `seat ${first.outcome.won} wins ${pot}`}   ${first.last}`);

  const second = await playHand(honest, () => ["fold"]);
  after = await read(honest);
  assert.deepEqual(second.outcome, { won: 0 }, "seat 1 had the button and folded its small blind");
  assert.deepEqual(after.chips, [won[0] + 1, won[1] - 1]);
  console.log(`  hand 2: seat 1 folds; chips ${after.chips.join(" : ")}   ${second.last}`);

  const left = await move(honest, accounts[0], "leave", { id: honest.id });
  assert.equal(await read(honest), null, "a settled match is deleted");
  const result = await view("get_result", { id: honest.id });
  assert.equal(BigInt(result.payouts[0]) + BigInt(result.payouts[1]), stake * 2n, "the stakes are paid out in full");
  console.log(`  seat 0 leaves: ${result.players[0]} takes ${fmt(result.payouts[0])}, ${result.players[1]} takes ${fmt(result.payouts[1])}   ${link(left)}`);

  // --- A match with a cheat ----------------------------------------------------------------------------------------
  const crooked = await sitDown(`c-${Date.now().toString(36)}`, 20);
  const { id, keys, stores } = crooked;
  const key = tableKey(keys.map((k) => k.publicKey));
  let wrongShare = false;
  const cheated = await playHand(crooked, () => ["fold"], async (now, seat, owed) => {
    if (now.phase === "shuffle" && now.shuffled === 1) {
      // Seat 1 throws seat 0's shuffle away and encrypts a deck of its own.
      const fresh = shuffle(openDeck(), key);
      stores[seat].saveOpening(fresh.deck, fresh.opening);
      return { method: "shuffle", args: { id, seat, deck: toBase64(fresh.deck) } };
    }
    if (now.phase === "deal" && !wrongShare) {
      wrongShare = true;
      const forged = shares(keys[1 - seat], await stores[seat].deck(now.hand, 1), holeAt(1 - seat));
      await refused(call(accounts[seat], contractId, "deal", { id, seat, tokens: toBase64(forged) }), /not made with this seat's key/);
    }
    return owed;
  });
  assert.ok(wrongShare, "a share made with the other seat's key was refused");
  assert.deepEqual([cheated.refused.seat, cheated.refused.method], [1, "audit"], "the seat that shuffled falsely cannot open its shuffle");
  assert.match(cheated.refused.text, /not how the deck was shuffled/);
  const honestAudit = await duty(await read(crooked), 0, keys[0], stores[0]);
  if (honestAudit) await move(crooked, accounts[0], honestAudit.method, honestAudit.args);
  await refused(call(accounts[0], contractId, "timeout", { id }), /deadline has not passed/);
  await sleep(22_000);
  const timedOut = await move(crooked, accounts[0], "timeout", { id });
  assert.equal(await read(crooked), null);
  const forfeit = await view("get_result", { id });
  assert.deepEqual([forfeit.reason, forfeit.chips], ["timeout", [200, 0]]);
  assert.equal(BigInt(forfeit.payouts[0]), stake * 2n);
  console.log(`  the false shuffle could not be opened; after the deadline ${forfeit.players[0]} takes ${fmt(forfeit.payouts[0])}   ${link(timedOut)}`);

  console.log("  most gas burnt by one call, in Tgas:");
  for (const [method, tgas] of Object.entries(gasOf)) console.log(`    ${method.padEnd(13)} ${tgas.toFixed(1)}`);
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
    const poker = await make("poker", 10);
    const accounts = [await make("p1", 20), await make("p2", 20)];
    await poker.deployContract(wasm);
    await poker.functionCall({ contractId: poker.accountId, methodName: "new", args: {}, gas: 40n * TGAS });
    console.log(`deployed to ${poker.accountId}`);
    await run({ contractId: poker.accountId, accounts, stake: NEAR(1) });
    console.log("all good");
  } finally {
    clearTimeout(watchdog);
    await stop();
  }
}

async function testnetRun() {
  const parent = process.env.POKER_PARENT;
  if (!parent || !parent.endsWith(".testnet")) throw new Error("set POKER_PARENT to a .testnet account whose key is in the NEAR credentials directory");
  const keyStore = new keyStores.UnencryptedFileSystemKeyStore(process.env.NEAR_CREDENTIALS_DIR ?? path.join(os.homedir(), ".near-credentials"));
  const near = await connect({ networkId: "testnet", nodeUrl: process.env.POKER_RPC ?? "https://test.rpc.fastnear.com", keyStore });
  const wasm = fs.readFileSync(WASM);
  const pokerId = `poker.${parent}`;
  const root = await near.account(parent);
  const exists = await near.connection.provider.query({ request_type: "view_account", finality: "final", account_id: pokerId }).then(() => true, () => false);
  if (!exists) {
    // The account must hold 1 NEAR per 100 KB of contract code, plus room for matches and their decks (13 KB a match).
    const fund = (BigInt(wasm.length) * 10n ** 19n * 115n) / 100n + NEAR(0.5);
    const balance = BigInt((await root.getAccountBalance()).available);
    if (balance < fund + NEAR(0.1)) throw new Error(`${parent} has ${fmt(balance)} available; creating ${pokerId} needs ${fmt(fund)} for the ${wasm.length}-byte contract`);
    const key = KeyPair.fromRandom("ed25519");
    await keyStore.setKey("testnet", pokerId, key);
    await root.createAccount(pokerId, key.getPublicKey(), fund);
    console.log(`created ${pokerId} with ${fmt(fund)}`);
  }
  const poker = await near.account(pokerId);
  const state = await poker.state();
  if (state.code_hash === "11111111111111111111111111111111") {
    await poker.deployContract(wasm);
    await poker.functionCall({ contractId: pokerId, methodName: "new", args: {}, gas: 40n * TGAS });
    console.log(`deployed ${wasm.length} bytes to ${pokerId}`);
  } else if (process.argv.includes("--redeploy")) {
    await poker.deployContract(wasm);
    console.log(`redeployed ${wasm.length} bytes to ${pokerId} (state kept)`);
  }
  const accounts = [await near.account(`p1.${parent}`), await near.account(`p2.${parent}`)];
  await run({ contractId: pokerId, accounts, stake: NEAR(0.05), explorer: "https://testnet.nearblocks.io" });
  console.log(`contract: https://testnet.nearblocks.io/address/${pokerId}\nall good on testnet`);
}

(process.argv[2] === "testnet" ? testnetRun() : sandboxRun()).catch((e) => {
  console.error(e);
  process.exit(1);
});
