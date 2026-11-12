// What a seat of the Deedlords Poker contract must send next, and what it can see. Everything a hand needs besides the
// bets is worked out here from the match on chain, so the page and the test script (contracts/sandbox/poker-run.js)
// play through the same code.
//
// Imports only ./crypto.ts, so node can load this file as it is.

import { type Keys, cardAt, openDeck, shares, tableKey, token } from "./crypto.ts";
import { shuffle } from "./shuffle.ts";

export type Outcome = { won: number } | "split" | "void";
export type Phase = "lobby" | "shuffle" | "deal" | "bet" | "open" | "showdown";

/** `get_match` of the contract. Byte strings are base64. */
export type MatchView = {
  id: string;
  phase: Phase;
  stake: string;
  players: string[];
  keys: string[];
  turnSeconds: number;
  deadline: string;
  chips: [number, number];
  hand: number;
  button: number;
  shuffled: number;
  street: number;
  toAct: number;
  awaited: number[];
  put: [number, number];
  bet: [number, number];
  done: [boolean, boolean];
  /** Decryption shares at `seat * 9 + position`; "" until given. */
  tokens: string[];
  board: number[];
  hole: number[][];
  last: { number: number; board: number[]; hole: number[][]; outcome: Outcome; pot: number } | null;
  /** Counts the changes stored for the match: of two views, the one with the higher number is the newer. */
  seq: number;
};

export type Call = { method: string; args: Record<string, unknown> };

/** Where a seat reads the decks from. */
export type SeatStore = {
  /** The deck after shuffle `step` of hand `hand` (0: the first seat's, kept until the second shuffles; 1: the deck dealt). */
  deck(hand: number, step: number): Promise<Uint8Array>;
};

export const toBase64 = (bytes: Uint8Array): string => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
export const fromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

/** Deck positions of a seat's two hole cards, and of the board cards a street turns up. */
export const holeAt = (seat: number): number[] => [2 * seat, 2 * seat + 1];
export const streetAt = (street: number): number[] => (street === 1 ? [4, 5, 6] : street === 2 ? [7] : [8]);

/**
 * The call `seat` owes the table now that needs no decision: its shuffle with the proof that it is one, or its
 * decryption shares. `null` when the table is not waiting for this seat, or is waiting for its bet.
 */
export async function duty(view: MatchView, seat: number, keys: Keys, store: SeatStore): Promise<Call | null> {
  if (!view.awaited.includes(seat) || view.phase === "bet" || view.phase === "lobby") return null;
  if (view.phase === "shuffle") {
    const before = view.shuffled === 0 ? openDeck() : await store.deck(view.hand, 0);
    const { deck, proof } = shuffle(before, tableKey(view.keys.map(fromBase64)));
    return { method: "shuffle", args: { id: view.id, seat, deck: toBase64(deck), proof: toBase64(proof) } };
  }
  const at = view.phase === "deal" ? holeAt(1 - seat) : view.phase === "open" ? streetAt(view.street) : holeAt(seat);
  const tokens = shares(keys, await store.deck(view.hand, 1), at);
  return { method: view.phase === "showdown" ? "show" : view.phase, args: { id: view.id, seat, tokens: toBase64(tokens) } };
}

/** The seat's own hole cards, once the other seat has dealt them: `null` before that, or for a card that is no card. */
export function holeCards(view: MatchView, seat: number, keys: Keys, deck: Uint8Array): (number | null)[] | null {
  const theirs = holeAt(seat).map((at) => view.tokens[(1 - seat) * 9 + at]);
  if (theirs.some((share) => !share)) return null;
  return holeAt(seat).map((at, index) => cardAt(deck, at, [fromBase64(theirs[index]), token(keys, deck, at)]));
}

/** What the seat to act may do: how much a call costs, and the smallest and largest bet it may raise to (`null`: no raise). */
export function betOptions(view: MatchView, seat: number): { owed: number; raise: { min: number; max: number } | null } {
  const other = 1 - seat;
  const max = Math.min(view.bet[seat] + view.chips[seat], view.bet[other] + view.chips[other]);
  const min = Math.min(view.bet[other] + 2, max);
  return { owed: view.bet[other] - view.bet[seat], raise: max > view.bet[other] ? { min, max } : null };
}
