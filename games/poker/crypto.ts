// Mental-poker cryptography for a seat: ElGamal over BN254 G1 and the proofs the Deedlords Poker contract checks
// (contracts/poker/src/curve.rs). Bytes are laid out as the NEAR host functions take them: a point is x then y, 32
// bytes little-endian each (all zeros is the point at infinity); a scalar is 32 bytes little-endian.
//
// No imports from the app, so node can load this file as it is (contracts/sandbox/poker-run.js does).

import { bn254 } from "@noble/curves/bn254.js";
import { sha256 } from "@noble/hashes/sha2.js";

const Point = bn254.G1.Point;
type G1 = ReturnType<typeof Point.fromAffine>;
const ORDER = bn254.fields.Fr.ORDER;

export const DECK = 52;
const POINT = 64;
const SCALAR = 32;
const CARD = 2 * POINT;

/** A seat's card key. The secret never leaves the browser. */
export type Keys = { secret: bigint; publicKey: Uint8Array };

const text = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function scalarBytes(value: bigint): Uint8Array {
  const out = new Uint8Array(SCALAR);
  for (let i = 0; i < SCALAR; i++) out[i] = Number((value >> BigInt(8 * i)) & 0xffn);
  return out;
}

function scalarOf(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i]);
  return value;
}

function encode(point: G1): Uint8Array {
  if (point.is0()) return new Uint8Array(POINT);
  const { x, y } = point.toAffine();
  return concat(scalarBytes(x), scalarBytes(y));
}

function decode(bytes: Uint8Array): G1 {
  if (bytes.every((byte) => byte === 0)) return Point.ZERO;
  const point = Point.fromAffine({ x: scalarOf(bytes.subarray(0, SCALAR)), y: scalarOf(bytes.subarray(SCALAR, POINT)) });
  point.assertValidity();
  return point;
}

/** A uniform scalar in 1..ORDER-1. */
function randomScalar(): bigint {
  return (scalarOf(crypto.getRandomValues(new Uint8Array(48))) % (ORDER - 1n)) + 1n;
}

/** A uniform integer in 0..below-1. */
function randomBelow(below: number): number {
  const limit = Math.floor(0x1_0000_0000 / below) * below;
  for (;;) {
    const value = crypto.getRandomValues(new Uint32Array(1))[0];
    if (value < limit) return value % below;
  }
}

/** sha256 over the parts with the top byte cleared, as a little-endian scalar: the contract's `challenge`. */
function challenge(...parts: Uint8Array[]): bigint {
  const hash = sha256(concat(...parts));
  hash[SCALAR - 1] = 0;
  return scalarOf(hash);
}

export function newKeys(): Keys {
  const secret = randomScalar();
  return { secret, publicKey: encode(Point.BASE.multiply(secret)) };
}

/** What a seat sends to sit down: its key, then a Schnorr proof (R ‖ z) that it knows the secret, bound to its account. */
export function keyProof(keys: Keys, accountId: string): Uint8Array {
  const nonce = randomScalar();
  const r = encode(Point.BASE.multiply(nonce));
  const c = challenge(text.encode("deedlords-poker/key"), text.encode(accountId), keys.publicKey, r);
  return concat(keys.publicKey, r, scalarBytes((nonce + c * keys.secret) % ORDER));
}

/** The key the deck is encrypted under: the sum of the seats' keys. */
export function tableKey(keys: Uint8Array[]): Uint8Array {
  return encode(keys.map(decode).reduce((sum, key) => sum.add(key)));
}

let cardPoints: G1[] | null = null;
/** Card `i` is the point `(i + 1)·G`. */
function points(): G1[] {
  cardPoints ??= Array.from({ length: DECK }, (_, card) => Point.BASE.multiply(BigInt(card + 1)));
  return cardPoints;
}

/** The deck nobody has shuffled yet: every card in order, in the clear. */
export function openDeck(): Uint8Array {
  return concat(...points().map((point) => concat(new Uint8Array(POINT), encode(point))));
}

/**
 * Shuffles `before` and re-encrypts every card under `key` with fresh randomness. `opening` (where each card came
 * from, then the 52 scalars) is what the contract's `audit` wants after the hand; until then it must stay secret.
 */
export function shuffle(before: Uint8Array, key: Uint8Array): { deck: Uint8Array; opening: Uint8Array } {
  const order = Array.from({ length: DECK }, (_, at) => at);
  for (let i = DECK - 1; i > 0; i--) {
    const j = randomBelow(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const tableKeyPoint = decode(key);
  const cards: Uint8Array[] = [];
  const scalars: Uint8Array[] = [];
  for (const from of order) {
    const scalar = randomScalar();
    const c1 = decode(before.subarray(from * CARD, from * CARD + POINT)).add(Point.BASE.multiply(scalar));
    const c2 = decode(before.subarray(from * CARD + POINT, (from + 1) * CARD)).add(tableKeyPoint.multiply(scalar));
    cards.push(encode(c1), encode(c2));
    scalars.push(scalarBytes(scalar));
  }
  return { deck: concat(...cards), opening: concat(Uint8Array.from(order), ...scalars) };
}

/** The seat's share of the decryption of the card at deck position `at`: `secret·C1`. */
export function token(keys: Keys, deck: Uint8Array, at: number): Uint8Array {
  return encode(decode(deck.subarray(at * CARD, at * CARD + POINT)).multiply(keys.secret));
}

/**
 * The shares the contract takes for the deck positions `at`: per card the token, then a Chaum-Pedersen proof
 * (A ‖ B ‖ z) that it was made with the seat's key.
 */
export function shares(keys: Keys, deck: Uint8Array, at: number[]): Uint8Array {
  return concat(
    ...at.map((position) => {
      const c1Bytes = deck.subarray(position * CARD, position * CARD + POINT);
      const c1 = decode(c1Bytes);
      const nonce = randomScalar();
      const share = encode(c1.multiply(keys.secret));
      const a = encode(Point.BASE.multiply(nonce));
      const b = encode(c1.multiply(nonce));
      const c = challenge(text.encode("deedlords-poker/token"), keys.publicKey, c1Bytes, share, a, b);
      return concat(share, a, b, scalarBytes((nonce + c * keys.secret) % ORDER));
    }),
  );
}

/** The card (0..51) at deck position `at` given every seat's token for it, or `null` when it decrypts to no card. */
export function cardAt(deck: Uint8Array, at: number, tokens: Uint8Array[]): number | null {
  const c2 = decode(deck.subarray(at * CARD + POINT, (at + 1) * CARD));
  const point = tokens.map(decode).reduce((rest, share) => rest.subtract(share), c2);
  const card = points().findIndex((candidate) => candidate.equals(point));
  return card < 0 ? null : card;
}

export function secretText(keys: Keys): string {
  return keys.secret.toString(16);
}

export function keysFromSecret(secret: string): Keys {
  const value = BigInt(`0x${secret}`);
  return { secret: value, publicKey: encode(Point.BASE.multiply(value)) };
}
