// lib/chain signs transactions by hand (borsh + ed25519). These vectors are what near-api-js 5.1.1 makes of the same
// transactions (createTransaction + signTransaction with a key whose seed is 32 bytes of 0x07): the bytes, the hash and
// the signature must be identical, or a node would refuse what the browser sends.

import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeBase58, encodeBase58, fromBase64, toBase64 } from "../lib/chain/base58.ts";
import { eventsOf, failureText } from "../lib/chain/client.ts";
import { generateKeyPair, parseSecretKey, publicKeyText, secretKeyText } from "../lib/chain/keys.ts";
import {
  type DelegateAction,
  encodeDelegateAction,
  encodeKeyGrant,
  encodeTransaction,
  jsonArgs,
  type KeyGrant,
  readKeyGrant,
  readSignedDelegate,
  signDelegateAction,
  signedKeyGrant,
  signTransaction,
  type Transaction,
} from "../lib/chain/transaction.ts";

const pair = parseSecretKey(`ed25519:${encodeBase58(new Uint8Array(32).fill(7))}`);
const args = { id: "m-1", seat: 1, actions: ["Buy", { Mortgage: 39 }, "End"] };

const transaction = (nonce: bigint, gas: bigint, deposit: bigint): Transaction => ({
  signerId: "p1.deedlords.testnet",
  publicKey: pair.publicKey,
  nonce,
  receiverId: "game.deedlords.testnet",
  blockHash: Uint8Array.from({ length: 32 }, (_, i) => i * 8 + 1),
  actions: [{ method: "play", args: jsonArgs(args), gas, deposit }],
});

const VECTORS = [
  {
    tx: transaction(123456789012345n, 100_000_000_000_000n, 0n),
    unsigned:
      "FAAAAHAxLmRlZWRsb3Jkcy50ZXN0bmV0AOpKbGPinFIKvvVQexMuxfmVR3auvr57kkIe6mkURtIsed8NhkhwAAAWAAAAZ2FtZS5kZWVkbG9yZHMudGVzdG5ldAEJERkhKTE5QUlRWWFpcXmBiZGZoamxucHJ0dnh6fH5AQAAAAIEAAAAcGxheT0AAAB7ImlkIjoibS0xIiwic2VhdCI6MSwiYWN0aW9ucyI6WyJCdXkiLHsiTW9ydGdhZ2UiOjM5fSwiRW5kIl19AEB6EPNaAAAAAAAAAAAAAAAAAAAAAAAA",
    signature: "AOaMwrozwjaAszaFT59uiDyAqrcdQtPFh0QKTgVrvSwKb+uu4dloMdpHH4eN8E5PlUg0GK1dK4sn1gY68V2eXAk=",
    hash: "76XNm3k7RvT7aybHtpQtkcyUvXNNb4o32K1o3Y6W4vVS",
  },
  {
    // The largest nonce and deposit there are: every byte of the u64 and the u128 is checked.
    tx: transaction(18446744073709551615n, 300_000_000_000_000n, 340282366920938463463374607431768211455n),
    unsigned:
      "FAAAAHAxLmRlZWRsb3Jkcy50ZXN0bmV0AOpKbGPinFIKvvVQexMuxfmVR3auvr57kkIe6mkURtIs//////////8WAAAAZ2FtZS5kZWVkbG9yZHMudGVzdG5ldAEJERkhKTE5QUlRWWFpcXmBiZGZoamxucHJ0dnh6fH5AQAAAAIEAAAAcGxheT0AAAB7ImlkIjoibS0xIiwic2VhdCI6MSwiYWN0aW9ucyI6WyJCdXkiLHsiTW9ydGdhZ2UiOjM5fSwiRW5kIl19AMBuMdkQAQD/////////////////////",
    signature: "AEJBqjXmp8g3kMbUI1rsG+YM2eKqB+arBIEpSQ41LK8+mhOoDqKUvcC8gWlewLWblQpowHjwtgRb4b0EJ5Vr7A4=",
    hash: "3oRY25KeG4Vyuq8YYKqZ6QYJ21m86KWJVbTo6fimzU42",
  },
];

test("a transaction is serialized, hashed and signed exactly as near-api-js does", () => {
  assert.equal(publicKeyText(pair.publicKey), "ed25519:GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB");
  for (const vector of VECTORS) {
    assert.equal(toBase64(encodeTransaction(vector.tx)), vector.unsigned);
    const signed = signTransaction(vector.tx, pair);
    assert.equal(signed.hash, vector.hash);
    const unsigned = fromBase64(vector.unsigned);
    assert.equal(toBase64(signed.bytes.slice(0, unsigned.length)), vector.unsigned);
    assert.equal(toBase64(signed.bytes.slice(unsigned.length)), vector.signature);
  }
});

test("keys keep NEAR's text form", () => {
  const text = secretKeyText(pair);
  assert.equal(decodeBase58(text.slice("ed25519:".length)).length, 64);
  assert.deepEqual(parseSecretKey(text), pair);
  const fresh = generateKeyPair();
  assert.equal(fresh.seed.length, 32);
  assert.equal(fresh.publicKey.length, 32);
  assert.deepEqual(parseSecretKey(secretKeyText(fresh)).publicKey, fresh.publicKey);
  assert.throws(() => parseSecretKey("secp256k1:abc"));
});

test("base58 and base64 survive leading zeros and odd lengths", () => {
  for (const bytes of [new Uint8Array(0), Uint8Array.of(0), Uint8Array.of(0, 0, 1), Uint8Array.of(255, 254, 253, 0), Uint8Array.from({ length: 33 }, (_, i) => (i * 37) % 256)]) {
    assert.deepEqual(decodeBase58(encodeBase58(bytes)), bytes);
    assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
  }
  assert.equal(encodeBase58(Uint8Array.of(0, 0, 1)), "112");
  assert.throws(() => decodeBase58("0OIl"));
});

test("a refused transaction is told in the contract's own words", () => {
  const failure = { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: action 0 (buy) rejected: "s1" cannot afford it' } } } };
  assert.equal(failureText(failure), 'action 0 (buy) rejected: "s1" cannot afford it');
  assert.equal(failureText({ InvalidTxError: "Expired" }), '{"InvalidTxError":"Expired"}');
});

test("events are read from the receipts' logs", () => {
  const result = {
    receipts_outcome: [
      { outcome: { logs: ["plain log", 'EVENT_JSON:{"standard":"deedlords","version":"1.0.0","event":"actions","data":{"id":"m-1"}}', "EVENT_JSON:not json"] } },
      { outcome: { logs: ['EVENT_JSON:{"standard":"deedlords","version":"1.0.0","event":"settle","data":{"id":"m-1"}}'] } },
    ],
  };
  assert.deepEqual(eventsOf(result).map((event) => event.event), ["actions", "settle"]);
});

// A delegate action (NEP-366), the transaction a relayer wraps it in, and a transfer: again the bytes of near-api-js
// 5.1.1 (buildDelegateAction, encodeDelegateAction, encodeSignedDelegate, encodeTransaction), player key seed 0x07,
// relayer key seed 0x09.
const SENDER = "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c";
const turnArgs = { id: "m-1", seat: 1, plan: { buy_reserve: 150, build: [], keep_reserve: 150, bail: false, liquidate: [] } };
const delegate: DelegateAction = {
  senderId: SENDER,
  receiverId: "game.deedlords.testnet",
  actions: [{ method: "turn", args: jsonArgs(turnArgs), gas: 100_000_000_000_000n, deposit: 0n }],
  nonce: 123456789012346n,
  maxBlockHeight: 277175999n,
  publicKey: pair.publicKey,
};
const SIGNED_DELEGATE =
  "QAAAAGVhNGE2YzYzZTI5YzUyMGFiZWY1NTA3YjEzMmVjNWY5OTU0Nzc2YWViZWJlN2I5MjQyMWVlYTY5MTQ0NmQyMmMWAAAAZ2FtZS5kZWVkbG9yZHMudGVzdG5ldAEAAAACBAAAAHR1cm5qAAAAeyJpZCI6Im0tMSIsInNlYXQiOjEsInBsYW4iOnsiYnV5X3Jlc2VydmUiOjE1MCwiYnVpbGQiOltdLCJrZWVwX3Jlc2VydmUiOjE1MCwiYmFpbCI6ZmFsc2UsImxpcXVpZGF0ZSI6W119fQBAehDzWgAAAAAAAAAAAAAAAAAAAAAAAHrfDYZIcAAAv16FEAAAAAAA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iwAg7nYlDx/Mmbm+DzORntvJ6X5NoY4aN74gBYbyKk/2ArQdwFeoOnc/yCyuwRBLtQzYvfWwHbc9csSEcdrUQ+VBQ==";
const OUTER =
  "EQAAAGRlZWRsb3Jkcy50ZXN0bmV0AP0XJDhaoMdbZPt4zWAvodmR/ev3axPFjtcC6sg16fYYTQAAAAAAAABAAAAAZWE0YTZjNjNlMjljNTIwYWJlZjU1MDdiMTMyZWM1Zjk5NTQ3NzZhZWJlYmU3YjkyNDIxZWVhNjkxNDQ2ZDIyYwEJERkhKTE5QUlRWWFpcXmBiZGZoamxucHJ0dnh6fH5AQAAAAhAAAAAZWE0YTZjNjNlMjljNTIwYWJlZjU1MDdiMTMyZWM1Zjk5NTQ3NzZhZWJlYmU3YjkyNDIxZWVhNjkxNDQ2ZDIyYxYAAABnYW1lLmRlZWRsb3Jkcy50ZXN0bmV0AQAAAAIEAAAAdHVybmoAAAB7ImlkIjoibS0xIiwic2VhdCI6MSwicGxhbiI6eyJidXlfcmVzZXJ2ZSI6MTUwLCJidWlsZCI6W10sImtlZXBfcmVzZXJ2ZSI6MTUwLCJiYWlsIjpmYWxzZSwibGlxdWlkYXRlIjpbXX19AEB6EPNaAAAAAAAAAAAAAAAAAAAAAAAAet8NhkhwAAC/XoUQAAAAAADqSmxj4pxSCr71UHsTLsX5lUd2rr6+e5JCHuppFEbSLACDudiUPH8yZub4PM5Ge28npfk2hjho3viAFhvIqT/YCtB3AV6g6dz/ILK7BEEu1DNi99bAdtz1yxIRx2tRD5UF";
const TRANSFER =
  "EQAAAGRlZWRsb3Jkcy50ZXN0bmV0AP0XJDhaoMdbZPt4zWAvodmR/ev3axPFjtcC6sg16fYYTgAAAAAAAABAAAAAZWE0YTZjNjNlMjljNTIwYWJlZjU1MDdiMTMyZWM1Zjk5NTQ3NzZhZWJlYmU3YjkyNDIxZWVhNjkxNDQ2ZDIyYwEJERkhKTE5QUlRWWFpcXmBiZGZoamxucHJ0dnh6fH5AQAAAAMBAAAAAAAAAAAAAAAAAAAA";
const relayer = parseSecretKey(`ed25519:${encodeBase58(new Uint8Array(32).fill(9))}`);
const blockHash = Uint8Array.from({ length: 32 }, (_, i) => i * 8 + 1);

test("a delegate action is serialized and signed like near-api-js does", () => {
  const signed = signDelegateAction(delegate, pair);
  assert.equal(toBase64(signed), SIGNED_DELEGATE);
  // The signed bytes are the action followed by the key type and the 64 bytes of the signature.
  assert.equal(signed.length, encodeDelegateAction(delegate).length + 65);
});

test("a relayer's transaction carries the signed delegate action, and a transfer is three fields", () => {
  const outer: Transaction = { signerId: "deedlords.testnet", publicKey: relayer.publicKey, nonce: 77n, receiverId: SENDER, blockHash, actions: [{ delegate: fromBase64(SIGNED_DELEGATE) }] };
  assert.equal(toBase64(encodeTransaction(outer)), OUTER);
  assert.equal(toBase64(encodeTransaction({ ...outer, nonce: 78n, actions: [{ transfer: 1n }] })), TRANSFER);
});

test("a relayer reads back exactly what the player signed, and refuses anything tampered with", () => {
  const signed = fromBase64(SIGNED_DELEGATE);
  const read = readSignedDelegate(signed);
  assert.equal(read.senderId, SENDER);
  assert.equal(read.receiverId, "game.deedlords.testnet");
  assert.deepEqual([read.nonce, read.maxBlockHeight], [123456789012346n, 277175999n]);
  assert.deepEqual(read.publicKey, pair.publicKey);
  assert.equal(read.actions.length, 1);
  assert.deepEqual([read.actions[0].method, read.actions[0].gas, read.actions[0].deposit], ["turn", 100_000_000_000_000n, 0n]);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(read.actions[0].args)), turnArgs);

  // One byte of the arguments changed after signing: the signature no longer covers it.
  const forged = signed.slice();
  forged[signed.indexOf(0x6d, 100)] ^= 1;
  assert.throws(() => readSignedDelegate(forged), /not this key's/);
  assert.throws(() => readSignedDelegate(signed.subarray(0, signed.length - 1)), /stops short/);
  assert.throws(() => readSignedDelegate(Uint8Array.from([...signed, 0])), /left over/);
  // Signed by somebody else's key than the one named inside.
  const other = signDelegateAction({ ...delegate, publicKey: pair.publicKey }, relayer);
  assert.throws(() => readSignedDelegate(other), /not this key's/);
});

// A key grant: a delegate action that adds a function-call key to its own sender. near-api-js 5.1.1 again
// (actionCreators.addKey + functionCallAccessKey, encodeDelegateAction), account key seed 0x07, new key seed 0x05.
const KEY_GRANT =
  "bgEAQEAAAABlYTRhNmM2M2UyOWM1MjBhYmVmNTUwN2IxMzJlYzVmOTk1NDc3NmFlYmViZTdiOTI0MjFlZWE2OTE0NDZkMjJjQAAAAGVhNGE2YzYzZTI5YzUyMGFiZWY1NTA3YjEzMmVjNWY5OTU0Nzc2YWViZWJlN2I5MjQyMWVlYTY5MTQ0NmQyMmMBAAAABQBuehzdKbC3j9E69MVZj+/07yqXFm48pvLk+/zNgFBb8QAAAAAAAAAAAAEAAEBoO7PzhvA0AAAAAAAAFgAAAGdhbWUuZGVlZGxvcmRzLnRlc3RuZXQDAAAABAAAAGpvaW4EAAAAcGxheQQAAAB0dXJuet8NhkhwAAC/XoUQAAAAAADqSmxj4pxSCr71UHsTLsX5lUd2rr6+e5JCHuppFEbSLA==";
const KEY_GRANT_NO_ALLOWANCE =
  "bgEAQEAAAABlYTRhNmM2M2UyOWM1MjBhYmVmNTUwN2IxMzJlYzVmOTk1NDc3NmFlYmViZTdiOTI0MjFlZWE2OTE0NDZkMjJjQAAAAGVhNGE2YzYzZTI5YzUyMGFiZWY1NTA3YjEzMmVjNWY5OTU0Nzc2YWViZWJlN2I5MjQyMWVlYTY5MTQ0NmQyMmMBAAAABQBuehzdKbC3j9E69MVZj+/07yqXFm48pvLk+/zNgFBb8QAAAAAAAAAAAAAWAAAAZ2FtZS5kZWVkbG9yZHMudGVzdG5ldAAAAAABAAAAAAAAAAIAAAAAAAAAAOpKbGPinFIKvvVQexMuxfmVR3auvr57kkIe6mkURtIs";
const FULL_ACCESS_GRANT =
  "bgEAQEAAAABlYTRhNmM2M2UyOWM1MjBhYmVmNTUwN2IxMzJlYzVmOTk1NDc3NmFlYmViZTdiOTI0MjFlZWE2OTE0NDZkMjJjQAAAAGVhNGE2YzYzZTI5YzUyMGFiZWY1NTA3YjEzMmVjNWY5OTU0Nzc2YWViZWJlN2I5MjQyMWVlYTY5MTQ0NmQyMmMBAAAABQBuehzdKbC3j9E69MVZj+/07yqXFm48pvLk+/zNgFBb8QAAAAAAAAAAAQEAAAAAAAAAAgAAAAAAAAAA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=";
const sessionPair = parseSecretKey(`ed25519:${encodeBase58(new Uint8Array(32).fill(5))}`);
const grant: KeyGrant = {
  accountId: SENDER,
  accountKey: pair.publicKey,
  sessionKey: sessionPair.publicKey,
  contractId: "game.deedlords.testnet",
  methods: ["join", "play", "turn"],
  allowance: 250_000_000_000_000_000_000_000n,
  nonce: 123456789012346n,
  maxBlockHeight: 277175999n,
};

test("a key grant is serialized like near-api-js does, and read back whole", () => {
  assert.equal(toBase64(encodeKeyGrant(grant)), KEY_GRANT);
  assert.deepEqual(readKeyGrant(fromBase64(KEY_GRANT)), grant);
  const open = { ...grant, methods: [], allowance: null, nonce: 1n, maxBlockHeight: 2n };
  assert.equal(toBase64(encodeKeyGrant(open)), KEY_GRANT_NO_ALLOWANCE);
  assert.deepEqual(readKeyGrant(fromBase64(KEY_GRANT_NO_ALLOWANCE)), open);
});

test("only a function-call key for the account itself reads as a key grant", () => {
  assert.throws(() => readKeyGrant(fromBase64(FULL_ACCESS_GRANT)), /only a function-call key/);
  // A delegate action of function calls, with the prefix a signer puts in front: not a grant.
  assert.throws(() => readKeyGrant(Uint8Array.from([0x6e, 0x01, 0x00, 0x40, ...encodeDelegateAction(delegate)])), /own behalf|not a key grant/);
  assert.throws(() => readKeyGrant(fromBase64(KEY_GRANT).subarray(4)), /not a delegate action/);
  assert.throws(() => readKeyGrant(Uint8Array.from([...fromBase64(KEY_GRANT), 0])), /left over/);
});

test("a key grant takes the account key's signature and no other, and then reads as a signed delegate a relayer can wrap", async () => {
  const { sha256 } = await import("@noble/hashes/sha2.js");
  const { sign } = await import("../lib/chain/keys.ts");
  const payload = fromBase64(KEY_GRANT);
  const signed = signedKeyGrant(payload, sign(pair, sha256(payload)));
  assert.equal(signed.length, payload.length - 4 + 65);
  assert.deepEqual(signed.subarray(0, payload.length - 4), payload.subarray(4));
  assert.throws(() => signedKeyGrant(payload, sign(sessionPair, sha256(payload))), /not the account key's/);
  assert.throws(() => signedKeyGrant(payload, new Uint8Array(64)), /not the account key's/);
});
