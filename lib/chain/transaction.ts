// A NEAR transaction with function-call actions, serialized (borsh) and signed by hand: the game needs nothing else,
// and this keeps a wallet SDK out of the bundle. tests/chain-transaction.test.ts pins the bytes to near-api-js output.

import { sha256 } from "@noble/hashes/sha2.js";
import { encodeBase58 } from "./base58.ts";
import { type KeyPair, sign } from "./keys.ts";

export type FunctionCall = { method: string; args: Uint8Array; gas: bigint; deposit: bigint };

export type Transaction = {
  signerId: string;
  publicKey: Uint8Array;
  nonce: bigint;
  receiverId: string;
  blockHash: Uint8Array;
  actions: FunctionCall[];
};

const ED25519 = 0;
const FUNCTION_CALL = 2;
const utf8 = new TextEncoder();

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function u64(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

function u128(value: bigint): Uint8Array {
  const out = new Uint8Array(16);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, value & 0xffff_ffff_ffff_ffffn, true);
  view.setBigUint64(8, value >> 64n, true);
  return out;
}

function text(value: string): Uint8Array[] {
  const bytes = utf8.encode(value);
  return [u32(bytes.length), bytes];
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function encodeTransaction(tx: Transaction): Uint8Array {
  if (tx.publicKey.length !== 32 || tx.blockHash.length !== 32) throw new Error("public key and block hash hold 32 bytes");
  const parts: Uint8Array[] = [
    ...text(tx.signerId),
    Uint8Array.of(ED25519),
    tx.publicKey,
    u64(tx.nonce),
    ...text(tx.receiverId),
    tx.blockHash,
    u32(tx.actions.length),
  ];
  for (const action of tx.actions) {
    parts.push(Uint8Array.of(FUNCTION_CALL), ...text(action.method), u32(action.args.length), action.args, u64(action.gas), u128(action.deposit));
  }
  return concat(parts);
}

/** The signature covers the sha256 of the serialized transaction; that hash, in base58, is the transaction id. */
export function signTransaction(tx: Transaction, pair: KeyPair): { hash: string; bytes: Uint8Array } {
  const encoded = encodeTransaction(tx);
  const hash = sha256(encoded);
  return { hash: encodeBase58(hash), bytes: concat([encoded, Uint8Array.of(ED25519), sign(pair, hash)]) };
}

export function jsonArgs(args: unknown): Uint8Array {
  return utf8.encode(JSON.stringify(args));
}
