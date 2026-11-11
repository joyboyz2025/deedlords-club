// A game account from an EVM wallet. The wallet signs one fixed message; the signature is hashed into the seed of an
// ed25519 key, and that key is a NEAR implicit account (its id is the public key in hex). The same wallet signing the
// same message gives the same account on any device, so the wallet is the way back to the account: nothing is stored
// anywhere but in the browser. This is how near.com names an account after the key of whatever wallet signs in.
//
// Whoever gets this signature gets the game account, so the message says what it is for, and the account should hold
// little: a stake and some gas. A wallet that does not sign deterministically (some smart-contract wallets) would give
// a new account each time: `sameSignature` lets the page check that before anybody funds the account.

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { KeyPair } from "./keys.ts";

/** Order of the secp256k1 group: a signature (r, s) and (r, n - s) are both valid, so `s` is folded to the low half. */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const DOMAIN = new TextEncoder().encode("deedlords game account key v1");

/** What the wallet shows its owner. Changing a character of it changes every account derived from it. */
export function gameKeyMessage(network: string): string {
  return [
    "Deedlords: create the key of my game account.",
    "",
    "Sign this only on a Deedlords site you trust: whoever has this signature controls the game account.",
    "",
    `Network: ${network}`,
    "Version: 1",
  ].join("\n");
}

function bytesOf(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^([0-9a-fA-F]{2})+$/.test(clean)) throw new Error("not a hex string");
  return Uint8Array.from(clean.match(/.{2}/g)!, (byte) => parseInt(byte, 16));
}

const toHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** `r` and the low `s` of a 65-byte (or 64-byte) ECDSA signature. The recovery byte differs between wallets and is left out. */
function canonical(signatureHex: string): Uint8Array {
  const signature = bytesOf(signatureHex);
  if (signature.length !== 65 && signature.length !== 64) throw new Error("an EVM signature holds 64 or 65 bytes");
  let s = BigInt(`0x${toHex(signature.slice(32, 64))}`);
  if (s > N / 2n) s = N - s;
  const out = new Uint8Array(64);
  out.set(signature.slice(0, 32), 0);
  out.set(bytesOf(s.toString(16).padStart(64, "0")), 32);
  return out;
}

/** Whether two signatures of the same message are the same up to the forms a wallet may give them. */
export function sameSignature(a: string, b: string): boolean {
  return toHex(canonical(a)) === toHex(canonical(b));
}

/** The key of the game account behind a wallet's signature of `gameKeyMessage`. */
export function keyFromSignature(signatureHex: string): KeyPair {
  const body = canonical(signatureHex);
  const input = new Uint8Array(DOMAIN.length + body.length);
  input.set(DOMAIN, 0);
  input.set(body, DOMAIN.length);
  const seed = sha256(input);
  return { seed, publicKey: ed25519.getPublicKey(seed) };
}

/** The NEAR implicit account of a key: its 32 public bytes in hex. It exists on chain once somebody sends it NEAR. */
export function implicitAccountId(publicKey: Uint8Array): string {
  return toHex(publicKey);
}

/** `0x…` hex of a text, as `personal_sign` takes its message. */
export function hexOfText(text: string): string {
  return `0x${toHex(new TextEncoder().encode(text))}`;
}
