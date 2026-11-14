// What carries a stake (games/co-ty-phu/chain/calls.ts) and the game account derived from an EVM wallet
// (lib/chain/evmKey.ts). A wallet, and NEAR Connect before it, reads a transaction with near-api-js, so the vector
// below is what near-api-js 5.1.1 makes of the same transaction (createTransaction + encode).

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  MOVE_HOLD,
  ROUND_CHOICES,
  RULES,
  SEAT_COUNTS,
  SESSION_METHODS,
  SPLITS,
  STORAGE_DEPOSIT,
  TO_THE_END,
  TURN_SECONDS,
  createDuelCall,
  joinCalls,
  near,
  newMatchId,
  openDuelCalls,
  roundOf,
  roundsFor,
  upfront,
  winLine,
} from "../games/co-ty-phu/chain/calls.ts";
import { encodeBase58, toBase64 } from "../lib/chain/base58.ts";
import { gameKeyMessage, hexOfText, implicitAccountId, keyFromSignature, sameSignature } from "../lib/chain/evmKey.ts";
import { parseSecretKey, publicKeyText } from "../lib/chain/keys.ts";
import { encodeTransaction } from "../lib/chain/transaction.ts";

const pair = parseSecretKey(`ed25519:${encodeBase58(new Uint8Array(32).fill(7))}`);

test("opening a duel is one transaction a wallet can read: create_match, then join", () => {
  const calls = openDuelCalls("m-test-abcd", { stake: near(0.05), maxRounds: 6, turnSeconds: 60 });
  assert.deepEqual(calls.map((call) => [call.method, call.gas, call.deposit]), [
    ["create_match", 20_000_000_000_000n, STORAGE_DEPOSIT],
    ["join", 100_000_000_000_000n, 50_000_000_000_000_000_000_000n],
  ]);
  assert.equal(STORAGE_DEPOSIT, near(0.06));
  const transaction = {
    signerId: "alice.testnet",
    publicKey: pair.publicKey,
    nonce: 277_000_000_000_042n,
    receiverId: "game.deedlords.testnet",
    blockHash: Uint8Array.from({ length: 32 }, (_, i) => 255 - i * 3),
    actions: calls,
  };
  assert.equal(
    toBase64(encodeTransaction(transaction)),
    "DQAAAGFsaWNlLnRlc3RuZXQA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iwqUJoW7vsAABYAAABnYW1lLmRlZWRsb3Jkcy50ZXN0bmV0//z59vPw7ern5OHe29jV0s/MycbDwL26t7SxrquopaICAAAAAgwAAABjcmVhdGVfbWF0Y2i4AAAAeyJpZCI6Im0tdGVzdC1hYmNkIiwic2VhdHMiOjIsInN0YWtlIjoiNTAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCJzcGxpdCI6WzcwMDAsMzAwMF0sInJ1bGVzIjp7InNhbGFyeSI6MjAwLCJjYXNoIjoyMDAwLCJibGl0eiI6dHJ1ZSwibWF4X3JvdW5kcyI6Nn0sInNvbG9fcGxheWVyIjpudWxsLCJ0dXJuX3NlY29uZHMiOjYwfQBA5ZwwEgAAAACALWC6RJu0DAAAAAAAAAIEAAAAam9pbh0AAAB7ImlkIjoibS10ZXN0LWFiY2QiLCJzZWF0IjowfQBAehDzWgAAAABAe6XwY4GWCgAAAAAAAA==",
  );
});

test("every match the page can open is one the contract takes: its rules, rounds, seats and clock, against the contract's own limits", () => {
  // The limits are read from the contract's source, and the Blitz rules from its tests, so that neither can drift from here unseen.
  const contract = readFileSync(new URL("../contracts/deedlords/src/lib.rs", import.meta.url), "utf8");
  const limit = (name: string) => Number(new RegExp(`pub const ${name}: \\w+ = ([\\d_]+);`).exec(contract)![1].replaceAll("_", ""));
  const [minSeats, maxSeats, blitzCash, maxCash, maxSalary, maxTurn] = ["MIN_SEATS", "MAX_SEATS", "BLITZ_MIN_CASH", "MAX_CASH", "MAX_SALARY", "MAX_TURN_SECONDS"].map(limit);
  assert.deepEqual([minSeats, maxSeats, blitzCash], [2, 4, 1670]);
  assert.match(contract, /require!\(rules\.max_rounds >= 1, "rules\.max_rounds must be 1\.\.=255"\)/);
  assert.match(contract, /pub max_rounds: u8,/);

  for (const seats of SEAT_COUNTS) {
    assert.ok(ROUND_CHOICES.includes(roundsFor(seats)), `the rounds a table of ${seats} opens with are among those offered`);
    for (const maxRounds of ROUND_CHOICES) {
      const args = JSON.parse(new TextDecoder().decode(createDuelCall("m-1", { stake: 0n, maxRounds, turnSeconds: TURN_SECONDS, seats }).args));
      const { rules } = args;
      assert.deepEqual(Object.keys(rules).sort(), ["blitz", "cash", "max_rounds", "salary"]);
      assert.ok(Number.isInteger(rules.salary) && rules.salary >= 0 && rules.salary <= maxSalary);
      assert.ok(Number.isInteger(rules.cash) && rules.cash >= (rules.blitz ? blitzCash : 1) && rules.cash <= maxCash);
      assert.ok(Number.isInteger(rules.max_rounds) && rules.max_rounds >= 1 && rules.max_rounds <= 255);
      assert.ok(args.seats >= minSeats && args.seats <= maxSeats);
      assert.ok(args.turn_seconds >= 1 && args.turn_seconds <= maxTurn);
      assert.ok(args.split.length >= 1 && args.split.length <= args.seats);
      assert.equal(args.split.reduce((sum: number, share: number) => sum + share, 0), 10_000);
      assert.deepEqual(args.split, SPLITS[seats]);
    }
  }
  // Blitz as the contract's own tests play it (contracts/deedlords/src/tests.rs `fn blitz`).
  const tests = readFileSync(new URL("../contracts/deedlords/src/tests.rs", import.meta.url), "utf8");
  assert.match(tests, /fn blitz\(max_rounds: u8\) -> RulesArg \{\s*RulesArg \{ salary: 200, cash: 2000, blitz: true, max_rounds \}/);
  assert.deepEqual(RULES, { salary: 200, cash: 2000, blitz: true });
  // About the same number of turns whatever the seats: a table of four is not twice as long as a table of two.
  assert.deepEqual(SEAT_COUNTS.map((seats) => seats * roundsFor(seats)), [40, 48, 48]);
});

test("a table says which round it is in and what wins it", () => {
  assert.equal(roundOf(0, 20), "1/20");
  assert.equal(roundOf(19, 20), "20/20");
  assert.equal(roundOf(36, TO_THE_END), "37");
  assert.match(winLine({ blitz: true, maxRounds: 20 }), /^The last seat standing wins; after round 20 the highest net worth wins: cash, properties at their price \(half when mortgaged\) and houses at three quarters of their cost\.$/);
  assert.match(winLine({ blitz: false, maxRounds: 12 }), /houses at their cost\.$/);
  assert.match(winLine({ blitz: true, maxRounds: TO_THE_END }), /^The last seat standing wins\. Should round 255 ever end/);
});

test("a node holds the price of all the gas attached, so the calls attach no more than the contract asks", () => {
  const open = openDuelCalls("m-test-abcd", { stake: near(0.05), maxRounds: 6, turnSeconds: 60 });
  const [join, ...rest] = joinCalls("m-test-abcd", 1, near(1));
  assert.equal(rest.length, 0);
  assert.equal(join.method, "join");
  assert.equal(new TextDecoder().decode(join.args), '{"id":"m-test-abcd","seat":1}');
  assert.equal(join.deposit, 1_000_000_000_000_000_000_000_000n);
  // join may start the game: the contract refuses it with less than 100 Tgas. Exactly that is attached.
  assert.equal(join.gas, 100_000_000_000_000n);
  assert.equal(open[1].gas, 100_000_000_000_000n);
  // On testnet 180 Tgas attached made a node ask for 0.1817 NEAR on top of the deposits: 1.01e9 yocto a unit of gas.
  assert.equal(upfront(open), near(0.11) + 120_000_000_000_000n * 1_010_000_000n);
  assert.ok(upfront(open) < near(0.25), "a game account holding the faucet's 0.25 NEAR can open the smallest duel");
  assert.ok(near(0.25) - near(0.11) > MOVE_HOLD, "and can still move afterwards");
  assert.equal(MOVE_HOLD, 101_000_000_000_000_000_000_000n);
  assert.equal(near(0.25), 250_000_000_000_000_000_000_000n);
});

test("a match id is short, new each time, and made of what the contract accepts", () => {
  const ids = new Set(Array.from({ length: 200 }, (_, i) => newMatchId(1_794_338_000_000 + i)));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{1,32}$/);
  assert.equal(newMatchId(1_794_338_000_000, () => 0), "m-mwb2ilq8-aaaa");
  assert.equal(newMatchId(1_794_338_000_000, () => 0.999), "m-mwb2ilq8-zzzz");
});

test("a session key may only make moves", () => {
  assert.deepEqual([...SESSION_METHODS], ["play", "turn", "timeout", "set_driver", "leave"]);
  for (const method of ["create_match", "join", "abandon", "withdraw_fees", "migrate"]) assert.ok(!(SESSION_METHODS as readonly string[]).includes(method));
});

// A 65-byte secp256k1 signature as a wallet returns it: r, s, v.
const R = "8f".repeat(32);
const LOW_S = "0000000000000000000000000000000000000000000000000000000000000abc";
// n - s for the s above: the other valid form of the same signature.
const HIGH_S = (0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n - 0xabcn).toString(16).padStart(64, "0");

test("an EVM wallet's signature gives one game account, whatever form the wallet gives the signature", () => {
  const key = keyFromSignature(`0x${R}${LOW_S}1b`);
  assert.equal(key.seed.length, 32);
  assert.equal(key.publicKey.length, 32);
  const account = implicitAccountId(key.publicKey);
  assert.match(account, /^[0-9a-f]{64}$/);
  assert.equal(publicKeyText(key.publicKey), `ed25519:${encodeBase58(key.publicKey)}`);
  // The recovery byte (27/28, or 0/1 from some hardware wallets), the 0x prefix, upper case and the high-s twin.
  for (const other of [`0x${R}${LOW_S}1c`, `${R}${LOW_S}00`, `0x${R}${LOW_S}`, `0x${R.toUpperCase()}${LOW_S.toUpperCase()}1B`, `0x${R}${HIGH_S}1c`]) {
    assert.equal(implicitAccountId(keyFromSignature(other).publicKey), account, other.slice(0, 12));
    assert.ok(sameSignature(other, `0x${R}${LOW_S}1b`));
  }
  // Another signature (another wallet, or another message) is another account.
  const stranger = keyFromSignature(`0x${"8e".repeat(32)}${LOW_S}1b`);
  assert.notEqual(implicitAccountId(stranger.publicKey), account);
  assert.ok(!sameSignature(`0x${"8e".repeat(32)}${LOW_S}1b`, `0x${R}${LOW_S}1b`));
  assert.throws(() => keyFromSignature("0x1234"), /64 or 65 bytes/);
  assert.throws(() => keyFromSignature("not hex"), /hex/);
});

test("the message a wallet signs says what it is for, and differs per network", () => {
  const testnet = gameKeyMessage("testnet");
  assert.match(testnet, /^Deedlords: create the key of my game account\./);
  assert.match(testnet, /controls the game account/);
  assert.match(testnet, /Network: testnet\nVersion: 1$/);
  assert.notEqual(gameKeyMessage("mainnet"), testnet);
  assert.equal(hexOfText("Az"), "0x417a");
});
