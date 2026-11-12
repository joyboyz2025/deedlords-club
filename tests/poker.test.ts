// Deedlords Poker in the browser's own code: what a seat shuffles, shares and decrypts (games/poker). The proofs
// themselves are checked by the contract (contracts/poker, and contracts/sandbox/poker-run.js with this same code);
// here it is the cards: two seats shuffle, and what they decrypt together must be the 52 cards, each once.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DECK, cardAt, keyProof, keysFromSecret, newKeys, openDeck, secretText, shares, tableKey, token } from "../games/poker/crypto.ts";
import { type MatchView, betOptions, duty, fromBase64, holeAt, holeCards, streetAt, toBase64 } from "../games/poker/seat.ts";
import { generatorBytes, shuffle } from "../games/poker/shuffle.ts";

const seats = [newKeys(), newKeys()];
const key = tableKey(seats.map((seat) => seat.publicKey));

test("the generators the contract holds are the ones the page hashes", () => {
  assert.deepEqual(new Uint8Array(readFileSync(new URL("../contracts/poker/src/generators.bin", import.meta.url))), generatorBytes());
});

test("two shuffles leave the 52 cards, each once, and only both seats together can read one", () => {
  const first = shuffle(openDeck(), key);
  const second = shuffle(first.deck, key);
  assert.equal(second.deck.length, DECK * 128);
  assert.equal(second.proof.length, 10_144);
  assert.notDeepEqual(first.deck, second.deck);
  const cards = Array.from({ length: DECK }, (_, at) => cardAt(second.deck, at, seats.map((seat) => token(seat, second.deck, at))));
  assert.deepEqual([...cards].sort((a, b) => a! - b!), Array.from({ length: DECK }, (_, card) => card));
  // One seat's share alone opens nothing, and a share of another card opens nothing either.
  assert.equal(cardAt(second.deck, 0, [token(seats[0], second.deck, 0)]), null);
  assert.equal(cardAt(second.deck, 0, [token(seats[0], second.deck, 0), token(seats[1], second.deck, 1)]), null);
  // The open deck is the cards in order.
  assert.deepEqual(Array.from({ length: DECK }, (_, at) => cardAt(openDeck(), at, [])), Array.from({ length: DECK }, (_, card) => card));
});

test("a card key survives being stored as text", () => {
  const again = keysFromSecret(secretText(seats[0]));
  assert.equal(again.secret, seats[0].secret);
  assert.deepEqual(again.publicKey, seats[0].publicKey);
  assert.equal(keyProof(seats[0], "someone.testnet").length, 160);
  assert.equal(shares(seats[0], openDeck(), [3, 4, 5]).length, 3 * 224);
});

/** A match as `get_match` gives it, at the first bet of a hand whose deck is `deck`. */
function view(deck: Uint8Array, more: Partial<MatchView> = {}): MatchView {
  const tokens: string[] = new Array(18).fill("");
  // The deal: each seat's shares of the other's hole cards.
  for (const seat of [0, 1]) for (const at of holeAt(1 - seat)) tokens[seat * 9 + at] = toBase64(token(seats[seat], deck, at));
  return {
    id: "t",
    phase: "bet",
    stake: "100000000000000000000000",
    players: ["a.testnet", "b.testnet"],
    keys: seats.map((seat) => toBase64(seat.publicKey)),
    turnSeconds: 300,
    deadline: "0",
    chips: [99, 98],
    hand: 0,
    button: 0,
    shuffled: 2,
    street: 0,
    toAct: 0,
    awaited: [0],
    put: [1, 2],
    bet: [1, 2],
    done: [false, false],
    tokens,
    board: [],
    hole: [[], []],
    last: null,
    seq: 6,
    ...more,
  };
}

test("a seat reads its own hole cards and nobody else's", () => {
  const { deck } = shuffle(shuffle(openDeck(), key).deck, key);
  const all = Array.from({ length: DECK }, (_, at) => cardAt(deck, at, seats.map((seat) => token(seat, deck, at))));
  const now = view(deck);
  assert.deepEqual(holeCards(now, 0, seats[0], deck), [all[0], all[1]]);
  assert.deepEqual(holeCards(now, 1, seats[1], deck), [all[2], all[3]]);
  // With the wrong key the cards are no cards at all.
  assert.deepEqual(holeCards(now, 0, seats[1], deck), [null, null]);
  // Before the other seat has dealt there is nothing to read.
  assert.equal(holeCards({ ...now, tokens: new Array(18).fill("") }, 0, seats[0], deck), null);
});

test("a seat owes the table its shuffle, then its shares, and nothing while it is not awaited", async () => {
  const first = shuffle(openDeck(), key);
  const { deck } = shuffle(first.deck, key);
  const store = { deck: async (_hand: number, step: number) => (step === 0 ? first.deck : deck) };
  const now = view(deck);
  assert.equal(await duty(now, 0, seats[0], store), null, "a bet is the player's to make");
  assert.equal(await duty({ ...now, phase: "deal", awaited: [1] }, 0, seats[0], store), null, "not awaited");

  const shuffled = await duty({ ...now, phase: "shuffle", shuffled: 1, awaited: [1] }, 1, seats[1], store);
  assert.equal(shuffled?.method, "shuffle");
  assert.equal(fromBase64(shuffled!.args.deck as string).length, DECK * 128);
  assert.equal(fromBase64(shuffled!.args.proof as string).length, 10_144);

  const expected: [MatchView["phase"], number, string, number[]][] = [
    ["deal", 0, "deal", holeAt(1)],
    ["open", 1, "open", [4, 5, 6]],
    ["open", 2, "open", [7]],
    ["open", 3, "open", [8]],
    ["showdown", 3, "show", holeAt(0)],
  ];
  for (const [phase, street, method, at] of expected) {
    const call = await duty({ ...now, phase, street, awaited: [0, 1] }, 0, seats[0], store);
    assert.equal(call?.method, method);
    const bytes = fromBase64(call!.args.tokens as string);
    assert.equal(bytes.length, at.length * 224);
    // Each share starts with the seat's token for that very card.
    at.forEach((position, index) => assert.deepEqual(bytes.subarray(index * 224, index * 224 + 64), token(seats[0], deck, position)));
  }
  assert.deepEqual([streetAt(1), streetAt(2), streetAt(3)], [[4, 5, 6], [7], [8]]);
});

test("the bets a seat is offered are the bets the contract takes", () => {
  const deck = openDeck();
  // The button owes 1 and may raise to 4 at least, 100 at most.
  assert.deepEqual(betOptions(view(deck), 0), { owed: 1, raise: { min: 4, max: 100 } });
  // Facing an all-in for exactly what the seat has left: it can call or fold, and there is no raise.
  assert.deepEqual(betOptions(view(deck, { chips: [30, 0], bet: [0, 30], put: [70, 100] }), 0), { owed: 30, raise: null });
  // The other seat has 3 chips left: the most a raise can be is what it can call, even under the usual minimum.
  assert.deepEqual(betOptions(view(deck, { chips: [90, 1], bet: [2, 2], put: [10, 109] }), 0), { owed: 0, raise: { min: 3, max: 3 } });
});
