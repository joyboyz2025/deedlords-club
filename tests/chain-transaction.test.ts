// lib/chain signs transactions by hand (borsh + ed25519). These vectors are what near-api-js 5.1.1 makes of the same
// transactions (createTransaction + signTransaction with a key whose seed is 32 bytes of 0x07): the bytes, the hash and
// the signature must be identical, or a node would refuse what the browser sends.

import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeBase58, encodeBase58, fromBase64, toBase64 } from "../lib/chain/base58.ts";
import { eventsOf, failureText } from "../lib/chain/client.ts";
import { generateKeyPair, parseSecretKey, publicKeyText, secretKeyText } from "../lib/chain/keys.ts";
import { encodeTransaction, jsonArgs, signTransaction, type Transaction } from "../lib/chain/transaction.ts";

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
