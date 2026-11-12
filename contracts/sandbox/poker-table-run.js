// Deedlords Poker for two to nine seats: deploy the contract (contracts/poker-table) and play it with the same code
// the page runs (games/poker/table/seat.ts, games/poker/shuffle.ts, crypto.ts).
//
//   node --experimental-strip-types poker-table-run.js                      local near-sandbox (never leaves this machine)
//   POKER_PARENT=<you>.testnet node --experimental-strip-types poker-table-run.js testnet [--redeploy | --migrate] [--no-play]
//
// `--redeploy` puts the built wasm on the existing account and keeps its state; `--migrate` does that and, in the same
// transaction, upgrades the state of the first deployment, which had no owner and no fee (refused while a table is open).
//
// It plays: a table of nine seats, a hand to the showdown with everyone in (each seat's own decryption of its hole
// cards must equal what the contract shows), a hand with folds, raises and seats all in, and a hand in which a seat
// stops answering and time is called on it; a table of four where a
// seat is taken and given up between and during hands; and a table of three where a deck that is not a shuffle and a
// forged share are refused, and a seat that stops answering loses what it has to the seats still in; and the owner's
// fee: none to start with, set by the owner only, taken from what a seat won at a table opened after the change.
// On testnet it creates pokertable.<parent> and the accounts p3..p9.<parent> it needs (skipped when they exist) and
// plays with p1..p9.<parent>. Keys are read from the NEAR credentials directory, never printed. Refuses mainnet.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert/strict");
const { connect, keyStores, KeyPair, transactions } = require("near-api-js");

const Y = 10n ** 24n;
const NEAR = (n) => (BigInt(Math.round(n * 1000)) * Y) / 1000n;
const fmt = (yocto) => `${(Number(BigInt(yocto) / 10n ** 18n) / 1e6).toFixed(4)} NEAR`;
const TGAS = 10n ** 12n;
/// An account must hold about 0.001 NEAR per Tgas it attaches, so calls attach what they need: checking a shuffle
/// proof burns about 215 Tgas, a share about 6.
const gasFor = (method, args) => {
  const tokens = typeof args.tokens === "string" ? Math.round((args.tokens.length * 3) / 4 / 224) : 0;
  return (method === "shuffle" ? 260n : BigInt(Math.max(40, 30 + 7 * tokens))) * TGAS;
};
const WASM = process.env.POKER_WASM ?? path.join(__dirname, "../poker-table/target/wasm32-unknown-unknown/release/deedlords_poker_table.wasm");
/// What a seat pays on top of its stake for the table's permanent record (the contract's RECORD_FEE).
const RECORD_FEE = 2n * 10n ** 21n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CARD = (card) => "23456789TJQKA"[card % 13] + "cdhs"[Math.floor(card / 13)];
const seconds = (since) => `${((Date.now() - since) / 1000).toFixed(1)} s`;

/** The most gas one call of each method burnt, in Tgas, and all the gas burnt. */
const gasOf = {};
let burntInAll = 0;
/** Transactions sent that landed (those the RPC did not answer for and that were seen to land included). */
let sentInAll = 0;

/// Sends a call; on testnet a free public RPC sometimes answers 429 or times out, so it is retried a few times.
async function call(account, contractId, methodName, args, deposit = 0n) {
  // A public RPC may answer 408 or time out for a transaction that did reach the chain. Sent again, the contract then
  // refuses it as out of turn: that refusal, after an unanswered send, means the first one landed.
  let unanswered = false;
  for (let attempt = 0; ; attempt++) {
    try {
      const sent = Date.now();
      const outcome = await account.functionCall({ contractId, methodName, args, gas: gasFor(methodName, args), attachedDeposit: deposit });
      if (process.env.POKER_TRACE) console.log(`    ${account.accountId.split(".")[0]} ${methodName} ${seconds(sent)}`);
      const burnt = [outcome.transaction_outcome, ...outcome.receipts_outcome].reduce((sum, o) => sum + o.outcome.gas_burnt, 0) / 1e12;
      const name = methodName === "act" && args.action === "fold" ? "act (fold)" : methodName;
      gasOf[name] = Math.max(gasOf[name] ?? 0, burnt);
      burntInAll += burnt;
      sentInAll += 1;
      return outcome;
    } catch (e) {
      const text = String(e && (e.message || e));
      if (unanswered && /not this seat's turn|not now: the hand is at another step|the table moved on since this bet was chosen/.test(text)) {
        sentInAll += 1;
        return { landedUnseen: true };
      }
      if (attempt >= 9 || !/429|408|Rate limit|timeout|Timeout|ECONNRESET|fetch failed|Exceeded the/.test(text)) throw e;
      unanswered = !/429|Rate limit/.test(text);
      await sleep(3000 * (attempt + 1));
    }
  }
}

async function refused(promise, words) {
  const error = await promise.then(() => null, (e) => e);
  assert.ok(error, `the contract should have refused: ${words}`);
  assert.match(String(error.message || error), words);
}

async function run({ contractId, accounts, owner, stake, explorer, turnSeconds, nineSeconds }) {
  const { newKeys, keyProof, openDeck, shares } = await import("../../games/poker/crypto.ts");
  const { shuffle } = await import("../../games/poker/shuffle.ts");
  const { duty, betCall, holeCards, holeAt, betOptions, contenders, toBase64, fromBase64 } = await import("../../games/poker/table/seat.ts");
  /// A read, tried again when the public RPC answers 429.
  const view = async (method, args) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await accounts[0].viewFunction({ contractId, methodName: method, args });
      } catch (e) {
        if (attempt >= 9 || !/429|Rate limit|timeout|Timeout|ECONNRESET|fetch failed/.test(String(e && (e.message || e)))) throw e;
        await sleep(3000 * (attempt + 1));
      }
    }
  };
  const link = (outcome) => (outcome.landedUnseen ? "(sent; the RPC did not answer)" : explorer ? `${explorer}/txns/${outcome.transaction.hash}` : outcome.transaction.hash);
  const who = (accountId) => accounts.find((account) => account.accountId === accountId);

  /// The table as the newest node sees it, never a view older than one already seen (a public RPC answers from
  /// several nodes, some a block behind). `null` once it is settled.
  const read = async (table) => {
    for (let tries = 0; ; tries++) {
      const now = await view("get_match", { id: table.id });
      if (now && now.seq >= table.seq) {
        table.seq = now.seq;
        return now;
      }
      if (!now && (await view("get_result", { id: table.id }))) return null;
      if (tries >= 60) throw new Error(`table ${table.id} did not reach change ${table.seq}`);
      await sleep(600);
    }
  };
  /// A call that changes the table: the next read waits for it.
  const move = async (table, account, method, args, deposit = 0n) => {
    const outcome = await call(account, contractId, method, args, deposit);
    table.seq += 1;
    return outcome;
  };

  /// A table opened by `players[0]` for `seats` seats, the other `players` in the seats after it; and what each
  /// account keeps to itself: its card key.
  const sitDown = async (id, seats, players, clock) => {
    const table = { id, seq: 0, keys: new Map(), store: null };
    table.store = {
      deck: async (hand, step) => {
        for (let tries = 0; ; tries++) {
          const deck = await view("get_deck", { id, hand, step });
          if (deck) return fromBase64(deck);
          if (tries >= 60) throw new Error(`deck ${step} of hand ${hand} of ${id} is not on chain`);
          await sleep(600);
        }
      },
    };
    await move(table, players[0], "create_match", { id, stake: stake.toString(), key: seatKey(table, players[0]), seats, turn_seconds: clock }, stake + RECORD_FEE);
    for (const player of players.slice(1)) await join(table, player);
    console.log(`table ${id}: ${seats} seats, ${players.length} taken, stake ${fmt(stake)}`);
    return table;
  };
  /// A new card key for `account` at the table, with the proof that it knows it.
  const seatKey = (table, account) => {
    table.keys.set(account.accountId, newKeys());
    return toBase64(keyProof(table.keys.get(account.accountId), account.accountId));
  };
  const join = (table, account) => move(table, account, "join", { id: table.id, key: seatKey(table, account) }, stake + RECORD_FEE);

  /// Plays the hand under way until it ends, or until `bet(view, seat)` answers nothing (the seat stops playing).
  /// `bet` answers [action, amount]; `tamper(view, seat, call)` may try other calls first and returns the call to
  /// send, or nothing for a seat that stops there. Returns what each seat decrypted as its own hole cards, how long
  /// the shuffles and the whole hand took, and the last transaction.
  /// `skip(view)`: a seat that has stopped answering, from the moment it says so: the others play on around it, and the
  /// hand stops when only that seat is awaited.
  const playHand = async (table, bet, tamper = (_view, _seat, owed) => owed, skip = () => null) => {
    const { id, keys, store } = table;
    const started = Date.now();
    const hand = (await read(table)).hand;
    const mine = [];
    let [last, shuffles] = [null, null];
    for (;;) {
      const now = await read(table);
      if (!now || now.hand !== hand) return { mine, last, shuffles, took: seconds(started) };
      if (now.phase !== "shuffle") shuffles ??= seconds(started);
      const quitter = skip(now);
      const seat = now.awaited.find((awaited) => awaited !== quitter);
      if (seat === undefined) return { mine, last, stopped: quitter };
      const [account, cardKeys] = [who(now.players[seat]), keys.get(now.players[seat])];
      if (now.phase === "bet") {
        // Before its first bet a seat can read its own two cards, and nobody else's.
        mine[seat] ??= holeCards(now, seat, cardKeys, await store.deck(now.hand, now.dealt.length - 1));
        const answer = bet(now, seat);
        if (!answer) return { mine, last, stopped: seat };
        const sent = await betCall(now, seat, answer[0], answer[1], cardKeys, store);
        last = link(await move(table, account, sent.method, sent.args));
        continue;
      }
      const owed = await tamper(now, seat, await duty(now, seat, cardKeys, store));
      if (!owed) return { mine, last, stopped: seat };
      last = link(await move(table, account, owed.method, owed.args));
    }
  };

  /// What an account holds and stores, read until two readings agree (reads may lag a block).
  const holdings = async (accountId = contractId) => {
    const once = () => accounts[0].connection.provider.query({ request_type: "view_account", finality: "final", account_id: accountId });
    for (let last = await once(); ; ) {
      await sleep(1500);
      const now = await once();
      if (now.amount === last.amount && now.storage_usage === last.storage_usage) return { amount: BigInt(now.amount), bytes: now.storage_usage };
      last = now;
    }
  };
  const total = (list) => list.reduce((sum, chips) => sum + chips, 0);
  const before = await holdings();
  let bought = 0;

  // --- Nine seats ---------------------------------------------------------------------------------------------------
  const stamp = Date.now().toString(36);
  // What every account holds before; compared with what it holds at the end.
  const purses = new Map();
  for (const accountId of [contractId, owner.accountId, ...accounts.map((account) => account.accountId)]) purses.set(accountId, (await holdings(accountId)).amount);
  const nine = await sitDown(`n-${stamp}`, 9, accounts, nineSeconds);
  bought += 9;
  let now = await read(nine);
  assert.deepEqual([now.phase, now.button, now.awaited], ["shuffle", 0, [0]], "a full table starts by itself, the host with the button");

  // Everyone calls and checks to the showdown.
  const first = await playHand(nine, () => ["call"]);
  now = await read(nine);
  let shown = now.last;
  assert.equal(shown.ending, "showdown");
  assert.deepEqual(first.mine, shown.hole, "each seat decrypted the very hole cards the contract showed at the end");
  assert.equal(new Set([...shown.board, ...shown.hole.flat()]).size, 23, "23 different cards: nine pairs and the board");
  assert.deepEqual([total(shown.put), total(shown.won), total(now.chips)], [18, 18, 900]);
  assert.deepEqual([now.hand, now.button], [1, 1]);
  console.log(`  hand 1, nine seats to the showdown: board ${shown.board.map(CARD).join(" ")}; won ${shown.won.join(" ")}`);
  console.log(`    nine shuffles took ${first.shuffles}, the whole hand ${first.took}   ${first.last}`);

  // The seat after the big blind raises, the next two fold, one goes all in, the rest call or fold as they come.
  const second = await playHand(nine, (table, seat) => {
    const { owed, raise } = betOptions(table, seat);
    const place = table.dealt.indexOf(seat);
    if (table.street === 0 && place === 3 && raise && table.bet[seat] === 0) return ["raise", 8];
    if (table.street === 0 && (place === 4 || place === 5)) return ["fold"];
    if (table.street === 0 && place === 6 && raise && table.bet[seat] === 0) return ["raise", raise.max];
    if (owed > 20 && place % 2 === 0) return ["fold"];
    return ["call"];
  });
  now = await read(nine);
  shown = now.last;
  assert.equal(shown.ending, "showdown");
  assert.equal(total(shown.put), total(shown.won));
  assert.equal(total(now.chips) + total(now.cashed.map((cashed) => cashed.chips)), 900, "every chip is at the table or was paid out");
  for (const seat of shown.dealt) assert.equal(shown.hole[seat].length, shown.folded[seat] ? 0 : 2, "the cards of a seat that folded stay hidden, the others are shown");
  for (const seat of shown.dealt) if (!shown.folded[seat]) assert.deepEqual(second.mine[seat], shown.hole[seat]);
  console.log(`  hand 2, a raise, folds and an all-in: ${shown.folded.filter(Boolean).length} folded; put in ${shown.put.join(" ")}; won ${shown.won.join(" ")}   ${second.last}`);
  console.log(`    chips ${now.chips.join(" ")}; given up with nothing left: ${now.cashed.map((cashed) => cashed.account).join(", ") || "nobody"}`);

  // Hand 3: a seat stops answering when the flop is to be opened. After the deadline anybody calls time: the hand is
  // cancelled, every other seat takes back what it put in, and the late seat's chips go to the seats still in the hand.
  const before3 = await read(nine);
  let quitter = null;
  const third = await playHand(
    nine,
    () => ["call"],
    undefined,
    (table) => {
      if (quitter === null && table.phase === "open") quitter = table.dealt[1];
      return quitter;
    },
  );
  assert.equal(third.stopped, quitter, "the hand stopped at the seat that quit");
  now = await read(nine);
  assert.deepEqual([now.phase, now.awaited], ["open", [quitter]]);
  await refused(call(accounts[0], contractId, "timeout", { id: nine.id }), /deadline has not passed/);
  await sleep(Math.max(0, Number(now.deadline) / 1e6 - Date.now()) + 3000);
  const called = await move(nine, accounts[1], "timeout", { id: nine.id });
  now = await read(nine);
  shown = now.last;
  assert.deepEqual([shown.ending, shown.late], ["cancelled", [quitter]]);
  assert.equal(now.chips[quitter], 0);
  assert.ok(!now.players[quitter], "the late seat was given up");
  assert.equal(total(now.chips) + total(now.cashed.map((cashed) => cashed.chips)), 900, "every chip is at the table or was paid out");
  const lost = before3.chips[quitter];
  console.log(`  hand 3: seat ${quitter} stopped before the flop was opened; after the deadline the hand was cancelled and its ${lost} chips went to the ${shown.dealt.length - 1} seats still in (about ${(lost / (shown.dealt.length - 1)).toFixed(1)} each)   ${link(called)}`);

  // Everyone leaves: the seats between hands at once, and the table is settled when one is left.
  for (const player of now.players.filter(Boolean)) {
    if (!(await read(nine))) break;
    await move(nine, who(player), "leave", { id: nine.id });
  }
  assert.equal(await read(nine), null, "a table with one seat left is settled");
  let result = await view("get_result", { id: nine.id });
  assert.equal(total(result.cashed.map((cashed) => cashed.chips)), 900);
  assert.equal(result.cashed.reduce((sum, cashed) => sum + BigInt(cashed.payout), 0n), stake * 9n, "the nine stakes are paid out in full");
  console.log(`  everyone left: ${result.cashed.map((cashed) => `${cashed.account.split(".")[0]} ${cashed.chips}`).join(", ")}`);

  // --- Seats taken and given up -------------------------------------------------------------------------------------
  const four = await sitDown(`f-${stamp}`, 4, accounts.slice(0, 2), 300);
  bought += 2;
  await refused(call(accounts[1], contractId, "start", { id: four.id }), /only the host starts/);
  await refused(call(accounts[1], contractId, "join", { id: four.id, key: toBase64(keyProof(newKeys(), accounts[1].accountId)) }, stake + RECORD_FEE), /already has a seat/);
  const purse = (await holdings(accounts[2].accountId)).amount;
  await join(four, accounts[2]);
  await move(four, accounts[2], "leave", { id: four.id });
  const spent = purse - (await holdings(accounts[2].accountId)).amount;
  assert.ok(spent < NEAR(0.005), `sitting down in the lobby and leaving cost ${fmt(spent)}: the stake and the fee must come back`);
  await move(four, accounts[0], "start", { id: four.id });
  // A hand between two; a third sits down while it is played and is dealt in from the next hand.
  let joined = false;
  await playHand(four, () => ["call"], async (table, _seat, owed) => {
    if (table.phase === "deal" && !joined) {
      joined = true;
      await join(four, accounts[3]);
      bought += 1;
    }
    return owed;
  });
  now = await read(four);
  assert.deepEqual([now.last.dealt, now.players.filter(Boolean).length, now.button], [[0, 1], 3, 1]);
  // The next hand: the seat with the button asks to leave while it is in the hand, plays it, and is paid after it.
  let asked = false;
  await playHand(four, (table, seat) => (seat === 1 && table.street === 0 ? ["fold"] : ["call"]), async (table, _seat, owed) => {
    if (table.phase === "deal" && !asked) {
      asked = true;
      await move(four, accounts[1], "leave", { id: four.id });
    }
    return owed;
  });
  now = await read(four);
  assert.deepEqual(now.last.dealt, [1, 2, 0]);
  assert.deepEqual(now.players.map(Boolean), [true, false, true, false], "the seat that asked to leave was given up after the hand");
  assert.equal(now.cashed[0].account, accounts[1].accountId);
  console.log(`  table ${four.id}: a seat taken during a hand was dealt in from the next; a seat that left during a hand was paid ${now.cashed[0].chips} chips after it`);
  await move(four, accounts[0], "leave", { id: four.id });
  assert.equal(await read(four), null);
  result = await view("get_result", { id: four.id });
  assert.equal(total(result.cashed.map((cashed) => cashed.chips)), 300);

  // --- A cheat, and a seat that stops answering ---------------------------------------------------------------------
  const three = await sitDown(`c-${stamp}`, 3, accounts.slice(0, 3), turnSeconds);
  bought += 3;
  const { id, keys, store } = three;
  const tried = { ownDeck: false, movedCard: false, otherKey: false, wrongShare: false, bareFold: false };
  const stopped = await playHand(
    three,
    // Before the flop the button raises to 10, the small blind folds and the big blind calls.
    (table, seat) => (table.street > 0 ? ["call"] : seat === table.dealt[0] ? ["raise", 10] : seat === table.dealt[1] ? ["fold"] : ["call"]),
    async (table, seat, owed) => {
      const account = who(table.players[seat]);
      if (table.phase === "shuffle" && table.shuffled === 1) {
        // The second seat throws the first shuffle away and shuffles the open deck: a valid proof, but of another deck.
        const own = shuffle(openDeck(), fromBase64(table.key));
        await refused(call(account, contractId, "shuffle", { id, seat, deck: toBase64(own.deck), proof: toBase64(own.proof), key: table.key }), /does not show that this deck is a shuffle/);
        tried.ownDeck = true;
        // Or shuffles honestly, then puts the first card in the second card's place too.
        const deck = fromBase64(owed.args.deck);
        deck.set(deck.subarray(0, 128), 128);
        await refused(call(account, contractId, "shuffle", { id, seat, deck: toBase64(deck), proof: owed.args.proof, key: table.key }), /does not show that this deck is a shuffle/);
        tried.movedCard = true;
        // A deck shuffled under another key is turned away before its proof is looked at.
        await refused(call(account, contractId, "shuffle", { ...owed.args, key: table.keys[seat] }), /the seats at the table changed/);
        tried.otherKey = true;
      }
      if (table.phase === "deal" && !tried.wrongShare) {
        const other = table.dealt.find((dealt) => dealt !== seat);
        const at = table.dealt.flatMap((_, place) => (table.dealt[place] === seat ? [] : holeAt(place)));
        const forged = shares(keys.get(table.players[other]), await store.deck(table.hand, table.dealt.length - 1), at);
        await refused(call(account, contractId, "deal", { id, seat, tokens: toBase64(forged) }), /not made with this seat's key/);
        tried.wrongShare = true;
      }
      // On the flop the button gives its shares and the big blind never does.
      if (table.phase === "open" && seat === table.dealt[2]) return null;
      return owed;
    },
  );
  now = await read(three);
  // A fold without the shares for the board is not taken (tried by the seat to act of a table that waits for shares:
  // refused for the turn first, so try it where it matters, in the bets of the next table). Here: the timeout.
  assert.deepEqual([now.phase, now.awaited, stopped.stopped], ["open", [now.dealt[2]], now.dealt[2]]);
  assert.deepEqual(now.put, [10, 1, 10]);
  await refused(call(accounts[0], contractId, "timeout", { id }), /deadline has not passed/);
  await sleep((turnSeconds + 3) * 1000);
  const timedOut = await move(three, accounts[1], "timeout", { id });
  now = await read(three);
  assert.deepEqual([now.last.ending, now.last.late], ["cancelled", [2]]);
  // The button takes back its 10 and all the late seat had; the seat that folded takes back its blind.
  assert.deepEqual(now.chips, [200, 100, 0]);
  assert.deepEqual(now.cashed, [{ account: accounts[2].accountId, chips: 0 }]);
  assert.deepEqual(now.players.map(Boolean), [true, true, false]);
  console.log(`  table ${id}: a deck that is not a shuffle was refused twice, a deck under another key and a forged share once`);
  console.log(`    seat 2 never opened the flop; after the deadline the hand was cancelled, seat 0 holds ${now.chips[0]} and seat 1 ${now.chips[1]}   ${link(timedOut)}`);

  // The two left play on; a fold before the river must carry the shares for the board.
  const bare = await playHand(three, (table, seat) => (table.street === 0 && seat === table.dealt[0] ? null : ["call"]));
  now = await read(three);
  const folding = bare.stopped;
  await refused(call(who(now.players[folding]), contractId, "act", { id, seat: folding, action: "fold", amount: null, tokens: null }), /one 224-byte share/);
  tried.bareFold = true;
  assert.deepEqual(tried, { ownDeck: true, movedCard: true, otherKey: true, wrongShare: true, bareFold: true }, "every cheat was tried and refused");
  const folded = await betCall(now, folding, "fold", undefined, keys.get(now.players[folding]), store);
  await move(three, who(now.players[folding]), folded.method, folded.args);
  now = await read(three);
  assert.equal(now.last.ending, "fold");
  await move(three, accounts[0], "leave", { id });
  assert.equal(await read(three), null);
  result = await view("get_result", { id });
  assert.equal(total(result.cashed.map((cashed) => cashed.chips)), 300);
  console.log(`    a fold without its shares was refused; the table closed with ${result.cashed.map((cashed) => `${cashed.account.split(".")[0]} ${cashed.chips}`).join(", ")}`);

  // --- The owner's fee ----------------------------------------------------------------------------------------------
  const one = 1n;
  let config = await view("get_config", {});
  assert.deepEqual([config.owner, config.fee_bps, config.fees], [owner.accountId, 0, "0"], "no fee to start with, and none was taken");
  await refused(call(accounts[0], contractId, "set_fee", { fee_bps: 250 }, one), /only the owner may set the fee/);
  await refused(call(owner, contractId, "set_fee", { fee_bps: 501 }, one), /at most 500/);
  await call(owner, contractId, "set_fee", { fee_bps: 250 }, one);
  const paying = await sitDown(`w-${stamp}`, 2, accounts.slice(0, 2), 300);
  bought += 2;
  await call(owner, contractId, "set_fee", { fee_bps: 0 }, one);
  now = await read(paying);
  assert.equal(now.feeBps, 250, "a table keeps the fee it was opened with");
  // Both seats all in before the flop.
  await playHand(paying, (table, seat) => (betOptions(table, seat).raise ? ["raise", betOptions(table, seat).raise.max] : ["call"]));
  let fees = 0n;
  if (await read(paying)) {
    // A split pot: nobody won anything, so there is no fee. Both leave.
    await move(paying, accounts[0], "leave", { id: paying.id });
  } else fees = (stake * 250n) / 10000n;
  result = await view("get_result", { id: paying.id });
  assert.equal(result.cashed.reduce((sum, cashed) => sum + BigInt(cashed.fee), 0n), fees);
  assert.equal(result.cashed.reduce((sum, cashed) => sum + BigInt(cashed.payout), 0n), stake * 2n - fees, "what is not the fee is paid out");
  config = await view("get_config", {});
  assert.equal(BigInt(config.fees), fees);
  await refused(call(accounts[0], contractId, "withdraw_fees", {}, one), /only the owner may withdraw/);
  if (fees > 0n) {
    await call(owner, contractId, "withdraw_fees", {}, one);
    assert.equal((await view("get_config", {})).fees, "0");
  }
  console.log(`  the owner's fee: a table opened at 2.5% ${fees ? `paid ${fmt(fees)} on a win of ${fmt(stake)}, which the owner withdrew` : "ended in a split pot, so nothing was won and no fee taken"}; back to no fee`);

  // Every stake was paid out and every deck deleted: the contract stores nothing more than the results, and
  // keeps the record fees of the seats that were taken, which are more than those bytes cost (1 NEAR per 100 KB).
  const afterAll = await holdings();
  const [kept, bytes] = [afterAll.amount - before.amount, afterAll.bytes - before.bytes];
  if (!explorer) assert.ok(bytes < 3000, `the contract stores ${bytes} bytes more than before: something was not deleted`);
  // On the sandbox nobody else plays, so the sum is exact. On testnet other tables open and settle meanwhile.
  if (!explorer) assert.ok(kept >= BigInt(bought) * RECORD_FEE && kept < BigInt(bought) * RECORD_FEE + NEAR(0.001), `the contract kept ${fmt(kept)}, not the ${bought} record fees`);
  // On testnet other tables are opened and settled while this runs, which moves both numbers: checked on the sandbox.
  if (!explorer) assert.ok(kept >= BigInt(bytes) * 10n ** 19n, "the fees do not cover the storage of the results");
  console.log(`  the contract kept ${bytes} bytes (four results), which cost ${fmt(BigInt(bytes) * 10n ** 19n)} to store, and ${fmt(kept)} in record fees`);

  // What every account holds now, against before: only gas and the record fees went anywhere but back to a player,
  // except the chips won and lost at the tables.
  console.log(`  ${sentInAll} transactions. Balances before and after, NEAR:`);
  for (const [accountId, was] of purses) {
    const is = (await holdings(accountId)).amount;
    console.log(`    ${accountId.padEnd(32)} ${fmt(was).padStart(12)} ${fmt(is).padStart(12)}  ${is >= was ? "+" : "-"}${fmt(is >= was ? is - was : was - is)}`);
  }
  console.log(`  gas burnt in all: ${burntInAll.toFixed(0)} Tgas. Most burnt by one call, in Tgas:`);
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
  const watchdog = setTimeout(() => stop().then(() => process.exit(1)), 15 * 60 * 1000);
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
    const poker = await make("pokertable", 10);
    const accounts = [];
    for (let n = 1; n <= 9; n++) accounts.push(await make(`p${n}`, 20));
    await poker.deployContract(wasm);
    const owner = await make("owner", 5);
    await poker.functionCall({ contractId: poker.accountId, methodName: "new", args: { owner: owner.accountId, fee_bps: 0 }, gas: 40n * TGAS });
    console.log(`deployed to ${poker.accountId}`);
    await run({ contractId: poker.accountId, accounts, owner, stake: NEAR(1), turnSeconds: 12, nineSeconds: 30 });
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
  const pokerId = `pokertable.${parent}`;
  const root = await near.account(parent);
  const exists = (accountId) => near.connection.provider.query({ request_type: "view_account", finality: "final", account_id: accountId }).then(() => true, () => false);
  const create = async (accountId, fund) => {
    const balance = BigInt((await root.getAccountBalance()).available);
    if (balance < fund + NEAR(0.1)) throw new Error(`${parent} has ${fmt(balance)} available; creating ${accountId} needs ${fmt(fund)}`);
    const key = KeyPair.fromRandom("ed25519");
    await keyStore.setKey("testnet", accountId, key);
    await root.createAccount(accountId, key.getPublicKey(), fund);
    // A public RPC answers from several nodes, some a block behind: wait until the one that answers has the account.
    for (let tries = 0; tries < 30 && !(await exists(accountId)); tries++) await sleep(1000);
    await sleep(2000);
    console.log(`created ${accountId} with ${fmt(fund)}`);
  };
  // The contract's account must hold 1 NEAR per 100 KB of code, plus room for tables and their decks.
  if (!(await exists(pokerId))) await create(pokerId, (BigInt(wasm.length) * 10n ** 19n * 115n) / 100n + NEAR(0.5));
  const poker = await near.account(pokerId);
  const state = await poker.state();
  if (state.code_hash === "11111111111111111111111111111111") {
    await poker.deployContract(wasm);
    await poker.functionCall({ contractId: pokerId, methodName: "new", args: { owner: parent, fee_bps: 0 }, gas: 40n * TGAS });
    console.log(`deployed ${wasm.length} bytes to ${pokerId}`);
  } else if (process.argv.includes("--migrate")) {
    // The code and the upgrade of its state in one transaction: either both happen or neither.
    await poker.signAndSendTransaction({
      receiverId: pokerId,
      actions: [transactions.deployContract(wasm), transactions.functionCall("migrate", { owner: parent, fee_bps: 0 }, 100n * TGAS, 0n)],
    });
    console.log(`redeployed ${wasm.length} bytes to ${pokerId} and upgraded its state: owner ${parent}, no fee`);
  } else if (process.argv.includes("--redeploy")) {
    await poker.deployContract(wasm);
    console.log(`redeployed ${wasm.length} bytes to ${pokerId} (state kept)`);
  }
  if (process.argv.includes("--no-play")) return console.log(`contract: https://testnet.nearblocks.io/address/${pokerId}`);
  // A seat needs its stake, about 0.3 NEAR to attach the gas of a shuffle, and the gas it burns.
  const accounts = [];
  for (let n = 1; n <= 9; n++) {
    const accountId = `p${n}.${parent}`;
    if (!(await exists(accountId))) await create(accountId, NEAR(0.75));
    const account = await near.account(accountId);
    const available = BigInt((await account.getAccountBalance()).available);
    if (available < NEAR(0.6)) {
      await root.sendMoney(accountId, NEAR(0.75) - available);
      console.log(`topped ${accountId} up to ${fmt(NEAR(0.75))}`);
    }
    accounts.push(account);
  }
  await run({ contractId: pokerId, accounts, owner: root, stake: NEAR(0.1), explorer: "https://testnet.nearblocks.io", turnSeconds: 30, nineSeconds: 120 });
  console.log(`contract: https://testnet.nearblocks.io/address/${pokerId}\nall good on testnet`);
}

(process.argv[2] === "testnet" ? testnetRun() : sandboxRun()).catch((e) => {
  console.error(e);
  process.exit(1);
});
