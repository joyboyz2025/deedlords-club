// Ed25519 key pairs in NEAR's text form. A session key made here never leaves the browser: only its public half is
// handed out, to be added to the player's account as a function-call key for the game contract.

import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeBase58, encodeBase58 } from "./base58.ts";

const PREFIX = "ed25519:";

export type KeyPair = { seed: Uint8Array; publicKey: Uint8Array };

export function generateKeyPair(): KeyPair {
  const { secretKey, publicKey } = ed25519.keygen();
  return { seed: secretKey, publicKey };
}

/** `ed25519:<base58 of the 32 public bytes>`. */
export function publicKeyText(publicKey: Uint8Array): string {
  return PREFIX + encodeBase58(publicKey);
}

/** `ed25519:<base58 of seed + public key>`, the form near-cli and the wallets store. */
export function secretKeyText(pair: KeyPair): string {
  const both = new Uint8Array(64);
  both.set(pair.seed, 0);
  both.set(pair.publicKey, 32);
  return PREFIX + encodeBase58(both);
}

export function parseSecretKey(text: string): KeyPair {
  if (!text.startsWith(PREFIX)) throw new Error("only ed25519 keys are supported");
  const bytes = decodeBase58(text.slice(PREFIX.length));
  if (bytes.length !== 64 && bytes.length !== 32) throw new Error("an ed25519 secret key holds 32 or 64 bytes");
  const seed = bytes.slice(0, 32);
  return { seed, publicKey: ed25519.getPublicKey(seed) };
}

export function sign(pair: KeyPair, message: Uint8Array): Uint8Array {
  return ed25519.sign(message, pair.seed);
}

/** Whether `signature` is this public key's over `message`. False for anything malformed, never a throw. */
export function verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

/** A public key as NEAR writes it (`ed25519:…`), as its 32 bytes. Throws for anything else. */
export function parsePublicKey(text: string): Uint8Array {
  const [curve, encoded, ...rest] = text.split(":");
  const key = decodeBase58(encoded ?? "");
  if (curve !== "ed25519" || rest.length > 0 || key.length !== 32) throw new Error("not an ed25519 public key");
  return key;
}
