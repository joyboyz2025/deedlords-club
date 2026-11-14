// A seat's name when its player has no character: a guest's 64 hex digits become a short handle, the same for
// everybody who looks; a named account keeps its name.

import assert from "node:assert/strict";
import { test } from "node:test";
import { guestHandle, isGuestAccount, seatName } from "../lib/seatName.ts";

const short = (account: string) => (account.length > 22 ? `${account.slice(0, 7)}…${account.slice(-5)}` : account);
// Three of the guests of f-mwgoxg6y-xqgc on testnet, 2026-11-14, a table of nine that read "a2aeb31…", "284c2b8…".
const guests = ["c2c30a0", "43d79ef", "284c2b8"].map((start) => start + "0".repeat(57));

test("a guest's account is shown as a short handle, the same every time", () => {
  for (const guest of guests) {
    assert.equal(isGuestAccount(guest), true);
    const handle = guestHandle(guest);
    assert.match(handle, /^[A-Z][a-z]{3,5}\d\d$/);
    assert.ok(handle.length <= 8, handle);
    assert.equal(guestHandle(guest), handle);
    assert.equal(seatName(guest, short), handle);
  }
  assert.equal(new Set(guests.map(guestHandle)).size, 3);
});

test("a named account keeps its own name", () => {
  assert.equal(isGuestAccount("alice.near"), false);
  assert.equal(seatName("alice.near", short), "alice.near");
  assert.equal(seatName("p1.deedlords.testnet", short), "p1.deedlords.testnet");
  // Not 64 hex digits: an account's name, however long.
  assert.equal(isGuestAccount("c2c30a0" + "0".repeat(56)), false);
});
