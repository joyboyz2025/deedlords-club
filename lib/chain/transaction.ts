// A NEAR transaction, serialized (borsh) and signed by hand: the game needs nothing else, and this keeps a wallet SDK
// out of the bundle. tests/chain-transaction.test.ts pins the bytes to near-api-js output.
//
// Three kinds of action: a function call (every move of the game), a transfer, and a delegate action (NEP-366): what
// a player signs so that somebody else, a relayer, sends it and pays its gas. The player signs the `DelegateAction`;
// the relayer puts the signed bytes in a transaction of its own, addressed to the player's account.

import { sha256 } from "@noble/hashes/sha2.js";
import { encodeBase58 } from "./base58.ts";
import { type KeyPair, sign, verify } from "./keys.ts";

export type FunctionCall = { method: string; args: Uint8Array; gas: bigint; deposit: bigint };
/** Sends yoctoNEAR to the receiver; to an implicit account that does not exist yet, it also creates it. */
export type Transfer = { transfer: bigint };
/** A player's signed delegate action (`signDelegateAction`), carried by a relayer's transaction. */
export type Delegated = { delegate: Uint8Array };
export type Action = FunctionCall | Transfer | Delegated;

export type Transaction = {
  signerId: string;
  publicKey: Uint8Array;
  nonce: bigint;
  receiverId: string;
  blockHash: Uint8Array;
  actions: Action[];
};

const ED25519 = 0;
const FUNCTION_CALL = 2;
const TRANSFER = 3;
const DELEGATE = 8;
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
  for (const action of tx.actions) parts.push(...encodeAction(action));
  return concat(parts);
}

function encodeAction(action: Action): Uint8Array[] {
  if ("delegate" in action) return [Uint8Array.of(DELEGATE), action.delegate];
  if ("transfer" in action) return [Uint8Array.of(TRANSFER), u128(action.transfer)];
  return [Uint8Array.of(FUNCTION_CALL), ...text(action.method), u32(action.args.length), action.args, u64(action.gas), u128(action.deposit)];
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

/**
 * What a player signs for a relayer to send: calls to one receiver, the player's key and its next nonce, and the block
 * height after which nobody may send it any more.
 */
export type DelegateAction = {
  senderId: string;
  receiverId: string;
  actions: FunctionCall[];
  nonce: bigint;
  maxBlockHeight: bigint;
  publicKey: Uint8Array;
};

/** NEP-461: a delegate action is signed with this number in front, so its signature can never pass for a transaction's. */
const DELEGATE_PREFIX = u32(2 ** 30 + 366);

export function encodeDelegateAction(action: DelegateAction): Uint8Array {
  if (action.publicKey.length !== 32) throw new Error("a public key holds 32 bytes");
  return concat([
    ...text(action.senderId),
    ...text(action.receiverId),
    u32(action.actions.length),
    ...action.actions.flatMap(encodeAction),
    u64(action.nonce),
    u64(action.maxBlockHeight),
    Uint8Array.of(ED25519),
    action.publicKey,
  ]);
}

const delegateHash = (encoded: Uint8Array) => sha256(concat([DELEGATE_PREFIX, encoded]));

/** The delegate action and the player's signature over it: the bytes a relayer wraps (`{ delegate }`). */
export function signDelegateAction(action: DelegateAction, pair: KeyPair): Uint8Array {
  const encoded = encodeDelegateAction(action);
  return concat([encoded, Uint8Array.of(ED25519), sign(pair, delegateHash(encoded))]);
}

/**
 * Reads back what `signDelegateAction` wrote, for a relayer that must know what it is asked to pay for. Throws on
 * anything else: another key type, an action that is not a function call, bytes left over, a signature that is not
 * the key's over these very bytes.
 */
export function readSignedDelegate(bytes: Uint8Array): DelegateAction {
  const read = reader(bytes);
  const senderId = read.text();
  const receiverId = read.text();
  const count = read.u32();
  if (count < 1 || count > 4) throw new Error("a delegate action holds 1 to 4 calls");
  const actions: FunctionCall[] = [];
  for (let i = 0; i < count; i++) {
    if (read.byte() !== FUNCTION_CALL) throw new Error("only function calls can be relayed");
    const method = read.text();
    const args = read.take(read.u32()).slice();
    const gas = read.u64();
    actions.push({ method, args, gas, deposit: read.u128() });
  }
  const nonce = read.u64();
  const maxBlockHeight = read.u64();
  if (read.byte() !== ED25519) throw new Error("only ed25519 keys are supported");
  const publicKey = read.take(32).slice();
  const signedBytes = bytes.subarray(0, read.at());
  if (read.byte() !== ED25519) throw new Error("only ed25519 signatures are supported");
  const signature = read.take(64);
  read.end();
  if (!verify(publicKey, delegateHash(signedBytes), signature)) throw new Error("the signature is not this key's");
  return { senderId, receiverId, actions, nonce, maxBlockHeight, publicKey };
}

/** Reads borsh from the front of `bytes`, and throws rather than read past their end. */
function reader(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let at = 0;
  const take = (length: number): Uint8Array => {
    if (length < 0 || at + length > bytes.length) throw new Error("a delegate action that stops short");
    at += length;
    return bytes.subarray(at - length, at);
  };
  const u32 = () => (take(4), view.getUint32(at - 4, true));
  const u64 = () => (take(8), view.getBigUint64(at - 8, true));
  return {
    take,
    u32,
    u64,
    byte: () => take(1)[0],
    u128: () => {
      const low = u64();
      return (u64() << 64n) | low;
    },
    text: () => decoder.decode(take(u32())),
    at: () => at,
    end: () => {
      if (at !== bytes.length) throw new Error("bytes left over after the delegate action");
    },
  };
}

/**
 * A delegate action of one particular shape: an account adds, to itself, a key that may only call some methods of one
 * contract. It is how an account whose own key is not in the browser (one that NEAR Auth signs for, after a Google
 * sign-in) gives this browser a key to play with. `accountKey` is the account's key, the one that signs the grant.
 */
export type KeyGrant = {
  accountId: string;
  accountKey: Uint8Array;
  /** The key being added, and what it may call. */
  sessionKey: Uint8Array;
  contractId: string;
  methods: string[];
  /** What the key may burn in gas over its life, in yoctoNEAR. `null`: no limit. */
  allowance: bigint | null;
  nonce: bigint;
  maxBlockHeight: bigint;
};

const ADD_KEY = 5;
const FUNCTION_CALL_KEY = 0;

/** The bytes whose sha256 the account's key signs: the NEP-461 prefix, then the delegate action. */
export function encodeKeyGrant(grant: KeyGrant): Uint8Array {
  if (grant.accountKey.length !== 32 || grant.sessionKey.length !== 32) throw new Error("a public key holds 32 bytes");
  return concat([
    DELEGATE_PREFIX,
    ...text(grant.accountId),
    ...text(grant.accountId),
    u32(1),
    Uint8Array.of(ADD_KEY, ED25519),
    grant.sessionKey,
    u64(0n), // the new key's nonce: the chain sets its own
    Uint8Array.of(FUNCTION_CALL_KEY),
    ...(grant.allowance === null ? [Uint8Array.of(0)] : [Uint8Array.of(1), u128(grant.allowance)]),
    ...text(grant.contractId),
    u32(grant.methods.length),
    ...grant.methods.flatMap(text),
    u64(grant.nonce),
    u64(grant.maxBlockHeight),
    Uint8Array.of(ED25519),
    grant.accountKey,
  ]);
}

/** Reads back what `encodeKeyGrant` wrote, and nothing else: any other delegate action throws. */
export function readKeyGrant(payload: Uint8Array): KeyGrant {
  const read = reader(payload);
  if (read.u32() !== 2 ** 30 + 366) throw new Error("not a delegate action");
  const accountId = read.text();
  if (read.text() !== accountId) throw new Error("a key is granted on the account's own behalf");
  if (read.u32() !== 1 || read.byte() !== ADD_KEY) throw new Error("not a key grant");
  if (read.byte() !== ED25519) throw new Error("only ed25519 keys are supported");
  const sessionKey = read.take(32).slice();
  read.u64();
  if (read.byte() !== FUNCTION_CALL_KEY) throw new Error("only a function-call key can be granted");
  const allowance = read.byte() === 0 ? null : read.u128();
  const contractId = read.text();
  const count = read.u32();
  if (count > 32) throw new Error("too many methods");
  const methods = Array.from({ length: count }, () => read.text());
  const nonce = read.u64();
  const maxBlockHeight = read.u64();
  if (read.byte() !== ED25519) throw new Error("only ed25519 keys are supported");
  const accountKey = read.take(32).slice();
  read.end();
  return { accountId, accountKey, sessionKey, contractId, methods, allowance, nonce, maxBlockHeight };
}

/**
 * The grant with its signature, as a relayer wraps it (`{ delegate }`). Throws unless `signature` is the account
 * key's over this very payload.
 */
export function signedKeyGrant(payload: Uint8Array, signature: Uint8Array): Uint8Array {
  const grant = readKeyGrant(payload);
  if (signature.length !== 64 || !verify(grant.accountKey, sha256(payload), signature)) throw new Error("the signature is not the account key's over this grant");
  return concat([payload.subarray(DELEGATE_PREFIX.length), Uint8Array.of(ED25519), signature]);
}
