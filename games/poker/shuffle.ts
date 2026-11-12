// A shuffle of the deck and the zero-knowledge proof that it is one: the new deck is the old one in another order,
// every card re-encrypted under the table key, and nothing about the order or the randomness is shown. The contract
// checks the proof before it takes the deck (contracts/poker/src/shuffle.rs), so a deck that is not an honest shuffle
// never reaches the table.
//
// The proof is the Terelius-Wikström proof of a shuffle in the form the CHVote specification gives it
// (GenShuffleProof / CheckShuffleProof), made non-interactive with sha256, over BN254 G1 written additively:
//
//   input cards (a_j, b_j) = (C2, C1), output card i = input card order[i] plus (r_i·PK, r_i·G)
//   c_j   = rc_j·G + h_i            for the i with order[i] = j: a commitment to the permutation
//   u_j   = H(seed, j)              seed = H(PK, input deck, output deck, c);  ũ_i = u_order[i]
//   ĉ_i   = rh_i·G + ũ_i·ĉ_(i-1)    ĉ_(-1) = h: a chain that commits to the product of the ũ
//   t-values for random ω, then the challenge x = H(seed, ĉ, t) and the responses s = ω + x·secret.
//
// The verifier needs h and h_0..h_51 to be points nobody knows a relation between: they are hashed to the curve from
// fixed text (`generators`), and contracts/poker/src/generators.bin holds the same 53 points.
//
// Imports only ./crypto.ts, so node can load this file as it is.

import { bn254 } from "@noble/curves/bn254.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { CARD, DECK, type G1, ORDER, POINT, Point, challenge, concat, decode, encode, randomBelow, randomScalar, scalarBytes, scalarOf } from "./crypto.ts";

const FIELD = bn254.fields.Fp.ORDER;
const text = new TextEncoder();
const u32 = (value: number): Uint8Array => Uint8Array.of(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);

function power(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  for (let b = base % modulus, e = exponent; e > 0n; e >>= 1n, b = (b * b) % modulus) if (e & 1n) result = (result * b) % modulus;
  return result;
}

/**
 * Generator `index`, hashed to the curve y² = x³ + 3: x is sha256("deedlords-poker/generator" ‖ index ‖ counter) with
 * the top three bits cleared (so it is below the field prime), for the first counter that gives a point; y is the
 * smaller of the two roots. Nobody chose these points, so nobody knows how one is a multiple of another.
 */
function generator(index: number): G1 {
  for (let counter = 0; ; counter++) {
    const hash = sha256(concat(text.encode("deedlords-poker/generator"), u32(index), u32(counter)));
    hash[31] &= 0x1f;
    const x = scalarOf(hash);
    const square = (x * x * x + 3n) % FIELD;
    // The field prime is 3 modulo 4, so a square's root is its ((p + 1) / 4)-th power.
    const y = power(square, (FIELD + 1n) / 4n, FIELD);
    if ((y * y) % FIELD === square) return Point.fromAffine({ x, y: y < FIELD - y ? y : FIELD - y });
  }
}

let known: G1[] | null = null;
/** h, then h_0..h_51. */
export function generators(): G1[] {
  known ??= Array.from({ length: DECK + 1 }, (_, index) => generator(index));
  return known;
}

/** The 53 generators as the contract holds them (contracts/poker/src/generators.bin). */
export const generatorBytes = (): Uint8Array => concat(...generators().map(encode));

const mod = (value: bigint): bigint => ((value % ORDER) + ORDER) % ORDER;
const scalars = (): bigint[] => Array.from({ length: DECK }, randomScalar);

/**
 * Shuffles `before` and re-encrypts every card under `key` with fresh randomness. `proof` is what the contract's
 * `shuffle` takes with the deck: c ‖ ĉ ‖ x ‖ s1..s4 ‖ ŝ ‖ s̃ (10,144 bytes).
 */
export function shuffle(before: Uint8Array, key: Uint8Array): { deck: Uint8Array; proof: Uint8Array } {
  const [h, ...hs] = generators();
  const G = Point.BASE;
  const pk = decode(key);
  const input = Array.from({ length: DECK }, (_, at) => ({ c1: decode(before.subarray(at * CARD, at * CARD + POINT)), c2: decode(before.subarray(at * CARD + POINT, (at + 1) * CARD)) }));

  // The shuffle itself: output card i is input card order[i], re-encrypted with randomness[i].
  const order = Array.from({ length: DECK }, (_, at) => at);
  for (let i = DECK - 1; i > 0; i--) {
    const j = randomBelow(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const randomness = scalars();
  const output = order.map((from, i) => ({ c1: input[from].c1.add(G.multiply(randomness[i])), c2: input[from].c2.add(pk.multiply(randomness[i])) }));
  const deck = concat(...output.flatMap((card) => [encode(card.c1), encode(card.c2)]));

  // The commitment to the permutation, one point per input card.
  const rc: bigint[] = new Array(DECK);
  const c: G1[] = new Array(DECK);
  order.forEach((from, i) => {
    rc[from] = randomScalar();
    c[from] = G.multiply(rc[from]).add(hs[i]);
  });
  const cBytes = concat(...c.map(encode));
  const seed = sha256(concat(text.encode("deedlords-poker/shuffle"), key, before, deck, cBytes));
  const u = Array.from({ length: DECK }, (_, j) => challenge(text.encode("deedlords-poker/shuffle/u"), seed, Uint8Array.of(j)));
  const ut = order.map((from) => u[from]);

  // The chain of commitments.
  const rh = scalars();
  const chain: G1[] = [];
  for (let i = 0; i < DECK; i++) chain.push(G.multiply(rh[i]).add((i === 0 ? h : chain[i - 1]).multiply(ut[i])));
  const chainBytes = concat(...chain.map(encode));

  // The announcements.
  const [w1, w2, w3, w4] = [randomScalar(), randomScalar(), randomScalar(), randomScalar()];
  const wh = scalars();
  const wt = scalars();
  const t1 = G.multiply(w1);
  const t2 = G.multiply(w2);
  const t3 = hs.reduce((sum, hi, i) => sum.add(hi.multiply(wt[i])), G.multiply(w3));
  const t41 = output.reduce((sum, card, i) => sum.add(card.c2.multiply(wt[i])), pk.multiply(w4).negate());
  const t42 = output.reduce((sum, card, i) => sum.add(card.c1.multiply(wt[i])), G.multiply(w4).negate());
  const th = chain.map((_, i) => G.multiply(wh[i]).add((i === 0 ? h : chain[i - 1]).multiply(wt[i])));
  const x = challenge(text.encode("deedlords-poker/shuffle/proof"), seed, chainBytes, encode(t1), encode(t2), encode(t3), encode(t41), encode(t42), ...th.map(encode));

  // The responses.
  const v: bigint[] = new Array(DECK);
  v[DECK - 1] = 1n;
  for (let i = DECK - 1; i > 0; i--) v[i - 1] = mod(ut[i] * v[i]);
  const dot = (left: bigint[], right: bigint[]) => left.reduce((sum, value, i) => mod(sum + value * right[i]), 0n);
  const s1 = mod(w1 + x * rc.reduce((sum, value) => mod(sum + value), 0n));
  const s2 = mod(w2 + x * dot(rh, v));
  const s3 = mod(w3 + x * dot(rc, u));
  const s4 = mod(w4 + x * dot(randomness, ut));
  const sh = wh.map((w, i) => mod(w + x * rh[i]));
  const st = wt.map((w, i) => mod(w + x * ut[i]));
  return { deck, proof: concat(cBytes, chainBytes, ...[x, s1, s2, s3, s4, ...sh, ...st].map(scalarBytes)) };
}
