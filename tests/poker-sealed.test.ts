// What a house seat thought for a bet, sealed until the hand is over (games/poker/table/sealed.ts).

import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_SEALED, handIsOver, readThought, sealThought, type Thought } from "../games/poker/table/sealed.ts";

const thought: Thought = { id: "f-table-1", hand: 3, seat: 1, what: "call", reason: "We have pocket kings and only need to call 2 more chips.", driver: "gemini-2.5-flash-lite" };

test("a sealed thought names no card, and only the secret that sealed it reads it", () => {
  const sealed = sealThought("house secret", thought);
  assert.ok(!/king/i.test(sealed) && !/king/i.test(Buffer.from(sealed, "base64url").toString("latin1")));
  assert.ok(sealed.length < MAX_SEALED);
  assert.deepEqual(readThought("house secret", sealed), thought);
  assert.equal(readThought("another secret", sealed), null);
  // Sealed twice, the same thought does not look the same: nothing is learned by comparing notes.
  assert.notEqual(sealThought("house secret", thought), sealed);
});

test("a sealed thought that was changed, cut or made up is not read", () => {
  const sealed = sealThought("house secret", thought);
  const raw = Buffer.from(sealed, "base64url");
  raw[raw.length - 1] ^= 1;
  assert.equal(readThought("house secret", raw.toString("base64url")), null);
  assert.equal(readThought("house secret", sealed.slice(0, 20)), null);
  assert.equal(readThought("house secret", "x".repeat(MAX_SEALED + 1)), null);
  assert.equal(readThought("house secret", ""), null);
});

test("a hand is over when the table has moved on to the next one, gone back to waiting, or closed", () => {
  assert.equal(handIsOver({ hand: 3, phase: "bet" }, 3), false);
  assert.equal(handIsOver({ hand: 3, phase: "showdown" }, 3), false);
  assert.equal(handIsOver({ hand: 4, phase: "shuffle" }, 3), true);
  assert.equal(handIsOver({ hand: 3, phase: "lobby" }, 3), true);
  assert.equal(handIsOver(null, 3), true);
});
