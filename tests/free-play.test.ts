// Free play: what the sponsor agrees to pay for (relayRules.ts), the table it opens (calls.ts), and what a room tells
// whoever sends its calls about the table they are for (room.ts). The bytes of a delegate action are pinned in
// chain-transaction.test.ts; the whole path is played on testnet, not here.

import assert from "node:assert/strict";
import { test } from "node:test";
import { freeTableCalls, FREE_AGENT_SEAT, joinCalls, near, openDuelCalls, STORAGE_DEPOSIT } from "../games/co-ty-phu/chain/calls.ts";
import { tokenSubject } from "../games/co-ty-phu/chain/authDesk.ts";
import { grantable, Refused, relayable, RELAY_MAX_GAS, signable } from "../games/co-ty-phu/chain/relayRules.ts";
import { ed25519Signature } from "../lib/chain/nearAuth.ts";
import { encodeBase58 } from "../lib/chain/base58.ts";
import { implicitAccountId } from "../lib/chain/evmKey.ts";
import { parseSecretKey } from "../lib/chain/keys.ts";
import {
  type DelegateAction,
  encodeTransaction,
  type FunctionCall,
  jsonArgs,
  type KeyGrant,
  readSignedDelegate,
  readTransaction,
  signDelegateAction,
  signTransaction,
  type Transaction,
  withSignature,
} from "../lib/chain/transaction.ts";

const CONTRACT = "game.deedlords.testnet";
const pair = parseSecretKey(`ed25519:${encodeBase58(new Uint8Array(32).fill(7))}`);
const guest = implicitAccountId(pair.publicKey);
const move = (over: Partial<FunctionCall> = {}): FunctionCall => ({
  method: "play",
  args: jsonArgs({ id: "f-1", seat: 0, actions: [{ type: "roll" }] }),
  gas: RELAY_MAX_GAS,
  deposit: 0n,
  ...over,
});
const delegate = (over: Partial<DelegateAction> = {}): DelegateAction => ({
  senderId: guest,
  receiverId: CONTRACT,
  actions: [move()],
  nonce: 5n,
  maxBlockHeight: 100n,
  publicKey: pair.publicKey,
  ...over,
});

test("the sponsor pays for a game account's seat calls, and names the match they are for", () => {
  assert.deepEqual(relayable(delegate(), CONTRACT), { matchId: "f-1", method: "play", ownKey: true });
  for (const method of ["join", "leave", "set_driver", "turn", "timeout"]) assert.equal(relayable(delegate({ actions: [move({ method })] }), CONTRACT).method, method);
  // What a browser sends is what the relayer reads back: signed, then checked.
  assert.deepEqual(relayable(readSignedDelegate(signDelegateAction(delegate(), pair)), CONTRACT), { matchId: "f-1", method: "play", ownKey: true });
  // Signed by a key the account is not named after (one it granted, for a Google account): allowed, and flagged so
  // that whoever relays it checks the key on chain first.
  assert.equal(relayable(delegate({ senderId: "ab".repeat(32) }), CONTRACT).ownKey, false);
});

test("the sponsor refuses anything that could cost it more than a move's gas", () => {
  const refused = (action: DelegateAction, why: RegExp) =>
    assert.throws(
      () => relayable(action, CONTRACT),
      (error) => error instanceof Refused && why.test(error.message),
    );
  // A deposit would come out of the sponsor's pocket: the stake of a paid match, or a plain transfer in disguise.
  refused(delegate({ actions: [move({ method: "join", deposit: 1n })] }), /no deposit/);
  refused(delegate({ actions: [move({ gas: RELAY_MAX_GAS + 1n })] }), /too much gas/);
  refused(delegate({ actions: [move(), move()] }), /one call/);
  // Methods that are not a seat's: opening a match takes a storage deposit, and the owner's are not for sale.
  for (const method of ["create_match", "abandon", "withdraw_fees", "migrate", "new"]) refused(delegate({ actions: [move({ method })] }), /not a seat's call/);
  refused(delegate({ receiverId: "elsewhere.testnet" }), /only calls to/);
  // A named account has a wallet and NEAR of its own.
  refused(delegate({ senderId: "alice.testnet" }), /game account/);
  refused(delegate({ actions: [move({ args: new TextEncoder().encode("not json") })] }), /not JSON/);
  refused(delegate({ actions: [move({ args: jsonArgs({ seat: 0 }) })] }), /names no match/);
  refused(delegate({ actions: [move({ args: jsonArgs({ id: "../etc" }) })] }), /names no match/);
  refused(delegate({ actions: [move({ args: new Uint8Array(5000).fill(32) })] }), /too long/);
});

test("a free table stakes nothing; with an agent the sponsor also takes the second seat, for nothing", () => {
  const args = (call: FunctionCall) => JSON.parse(new TextDecoder().decode(call.args));
  const alone = freeTableCalls("f-1", 6, 60, false);
  assert.equal(alone.length, 1);
  assert.equal(alone[0].method, "create_match");
  assert.equal(alone[0].deposit, STORAGE_DEPOSIT);
  assert.deepEqual([args(alone[0]).stake, args(alone[0]).seats, args(alone[0]).rules.max_rounds, args(alone[0]).turn_seconds], ["0", 2, 6, 60]);
  const withAgent = freeTableCalls("f-1", 3, 60, true);
  assert.deepEqual(
    withAgent.map((call) => [call.method, call.deposit]),
    [
      ["create_match", STORAGE_DEPOSIT],
      ["join", 0n],
    ],
  );
  assert.deepEqual(args(withAgent[1]), { id: "f-1", seat: FREE_AGENT_SEAT });
});

const session = parseSecretKey(`ed25519:${encodeBase58(new Uint8Array(32).fill(5))}`);
const grant = (over: Partial<KeyGrant> = {}): KeyGrant => ({
  accountId: guest,
  accountKey: pair.publicKey,
  sessionKey: session.publicKey,
  contractId: CONTRACT,
  methods: ["join", "play", "turn", "timeout", "set_driver", "leave"],
  allowance: 250_000_000_000_000_000_000_000n,
  nonce: 5n,
  maxBlockHeight: 100n,
  ...over,
});

test("the sponsor has a key granted only if the key can do nothing but move a seat in the game", () => {
  grantable(grant(), CONTRACT);
  grantable(grant({ methods: ["turn"], allowance: 1n }), CONTRACT);
  const refused = (made: KeyGrant, why: RegExp) =>
    assert.throws(
      () => grantable(made, CONTRACT),
      (error) => error instanceof Refused && why.test(error.message),
    );
  refused(grant({ contractId: "elsewhere.testnet" }), /only keys for/);
  // No method named means every method of the contract.
  refused(grant({ methods: [] }), /seat's methods/);
  refused(grant({ methods: ["turn", "create_match"] }), /seat's methods/);
  refused(grant({ allowance: null }), /allowance/);
  refused(grant({ allowance: 10n ** 24n }), /allowance/);
  // The grant must be the account's own doing: an account is named after the key that signs for it.
  refused(grant({ accountId: "ab".repeat(32) }), /signing key names/);
});

test("the 64 bytes are read out of either shape NEAR Auth's sign has answered in, and nothing else passes for a signature", () => {
  const bytes = Array.from({ length: 64 }, (_, i) => i);
  assert.deepEqual(ed25519Signature({ scheme: "Ed25519", signature: bytes }), Uint8Array.from(bytes));
  const hex = (part: number[]) => part.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  assert.deepEqual(ed25519Signature({ big_r: { affine_point: `02${hex(bytes.slice(0, 32))}` }, s: { scalar: hex(bytes.slice(32)) } }), Uint8Array.from(bytes));
  // The contract answers `null` when its guard refuses the token.
  for (const nothing of [null, undefined, "", {}, { signature: bytes.slice(1) }, { signature: [...bytes.slice(1), 256] }, { big_r: { affine_point: "zz" }, s: { scalar: "00" } }])
    assert.equal(ed25519Signature(nothing), null);
});

const tx = (over: Partial<Transaction> = {}): Transaction => ({
  signerId: guest,
  publicKey: pair.publicKey,
  nonce: 9n,
  receiverId: CONTRACT,
  blockHash: new Uint8Array(32).fill(3),
  actions: openDuelCalls("m-1", { stake: near(0.05), maxRounds: 6, turnSeconds: 60 }),
  ...over,
});

test("a transaction is read back whole, and takes only its own key's signature", () => {
  for (const made of [tx(), tx({ receiverId: "alice.testnet", actions: [{ transfer: near(0.25) }] })]) assert.deepEqual(readTransaction(encodeTransaction(made)), made);
  const encoded = encodeTransaction(tx());
  assert.throws(() => readTransaction(encoded.subarray(0, encoded.length - 1)), /stops short/);
  assert.throws(() => readTransaction(Uint8Array.from([...encoded, 0])), /left over/);
  // What the account's key signs here and what comes back signed from elsewhere are the same bytes.
  const here = signTransaction(tx(), pair);
  assert.deepEqual(withSignature(encoded, here.bytes.subarray(here.bytes.length - 64), pair.publicKey), here);
  assert.throws(() => withSignature(encoded, signTransaction(tx(), session).bytes.subarray(-64), pair.publicKey), /not this key's/);
  assert.throws(() => withSignature(encodeTransaction(tx({ nonce: 10n })), here.bytes.subarray(here.bytes.length - 64), pair.publicKey), /not this key's/);
});

test("the sponsor carries to NEAR Auth a stake at the game or a withdrawal, and nothing else", () => {
  assert.equal(signable(tx(), CONTRACT), "stake");
  assert.equal(signable(tx({ actions: joinCalls("m-1", 1, near(0.05)) }), CONTRACT), "stake");
  assert.equal(signable(tx({ receiverId: "alice.testnet", actions: [{ transfer: near(0.25) }] }), CONTRACT), "withdraw");
  const refused = (made: Transaction, why: RegExp) =>
    assert.throws(
      () => signable(made, CONTRACT),
      (error) => error instanceof Refused && why.test(error.message),
    );
  // Somebody else's account, or a named one: the sponsor pays for the signing call, so it is not for everybody.
  refused(tx({ signerId: "alice.testnet" }), /game account's own/);
  refused(tx({ signerId: "ab".repeat(32) }), /game account's own/);
  refused(tx({ receiverId: "elsewhere.testnet" }), /only stakes at/);
  refused(tx({ actions: [{ method: "withdraw_fees", args: jsonArgs({}), gas: 1n, deposit: 1n }] }), /opening a match and taking a seat/);
  refused(tx({ actions: [...joinCalls("m-1", 0, 0n), ...joinCalls("m-2", 0, 0n), ...joinCalls("m-3", 0, 0n)] }), /too many calls/);
  // A transfer rides alone, to somebody else, and is of something.
  refused(tx({ receiverId: "alice.testnet", actions: [{ transfer: 1n }, { transfer: 1n }] }), /only stakes at/);
  refused(tx({ receiverId: guest, actions: [{ transfer: 1n }] }), /another account/);
  refused(tx({ receiverId: "alice.testnet", actions: [{ transfer: 0n }] }), /nothing to send/);
});

test("a signing token is believed only if the sign-in service signed it, for this payload, and it has not expired", async () => {
  const { publicKey, privateKey } = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", publicKey);
  const url = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const part = (value: unknown) => url(new TextEncoder().encode(JSON.stringify(value)));
  const mint = async (claims: Record<string, unknown>, key = privateKey, header: Record<string, unknown> = { alg: "RS256", kid: "k1" }) => {
    const signed = `${part(header)}.${part(claims)}`;
    return `${signed}.${url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signed))))}`;
  };
  const payload = encodeTransaction(tx());
  const now = 1_800_000_000_000;
  const expected = { issuer: "https://login.example/", audience: "guard.testnet", keys: [{ kid: "k1", kty: "RSA", n: jwk.n, e: jwk.e }], now };
  const claims = { iss: expected.issuer, aud: ["guard.testnet", "https://login.example/userinfo"], exp: now / 1000 + 60, sub: "google-oauth2|1", fatxn: Array.from(payload) };
  assert.equal(await tokenSubject(await mint(claims), payload, expected), "google-oauth2|1");

  const refused = async (token: string, why: RegExp, over: Partial<typeof expected> = {}, signedFor = payload) =>
    assert.rejects(tokenSubject(token, signedFor, { ...expected, ...over }), why);
  const other = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, [
    "sign",
    "verify",
  ]);
  await refused(await mint(claims, other.privateKey), /not signed by the sign-in service/);
  await refused(await mint(claims, privateKey, { alg: "none", kid: "k1" }), /not signed by the sign-in service/);
  await refused(await mint(claims, privateKey, { alg: "RS256", kid: "unknown" }), /not signed by the sign-in service/);
  await refused(await mint({ ...claims, exp: now / 1000 - 1 }), /expired/);
  await refused(await mint({ ...claims, aud: "https://login.example/userinfo" }), /not a signing approval/);
  await refused(await mint({ ...claims, iss: "https://evil.example/" }), /another sign-in service/);
  // Approved, but for another transaction: a token cannot be reused to get something else signed.
  await refused(await mint(claims), /something else/, {}, encodeTransaction(tx({ nonce: 10n })));
  await refused(await mint({ ...claims, fatxn: undefined }), /something else/);
  await refused("a.b.c", /cannot be read/);
});

test("a free table with three house agents goes in transactions that fit the gas", async () => {
  const { freeTableCalls, inTransactions } = await import("../games/co-ty-phu/chain/calls.ts");
  const calls = freeTableCalls("f-test", 3, 60, true, null, 3);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["create_match", "join", "join", "join"],
  );
  const batches = inTransactions(calls);
  assert.equal(batches.flat().length, 4, "every call is sent");
  for (const batch of batches) assert.ok(batch.reduce((sum, call) => sum + call.gas, 0n) <= 300n * 10n ** 12n, "no transaction carries more than 300 Tgas");
  const seats = calls.slice(1).map((call) => JSON.parse(new TextDecoder().decode(call.args)).seat);
  assert.deepEqual(seats, [1, 2, 3], "the agents take every seat but the visitor's");
});

test("a free table's id carries its house agents' models, for a server that remembers nothing between requests", async () => {
  const { houseSeatModel, idWithHouseSeats } = await import("../games/co-ty-phu/chain/freeDesk.ts");
  const { newMatchId } = await import("../games/co-ty-phu/chain/calls.ts");
  const offered = ["rules", "gpt-4.1-mini", "near:Qwen/Qwen3.6-35B-A3B-FP8", "near:z-ai/glm-5.3-flash"];
  const id = idWithHouseSeats(`f${newMatchId(1_794_466_922_224, () => 0.5).slice(1)}`, ["near:z-ai/glm-5.3-flash", "rules", "gpt-4.1-mini"], offered);
  assert.match(id, /^[A-Za-z0-9_-]{1,32}$/, "still a match id the contract takes");
  assert.equal(houseSeatModel(id, 1, offered), "near:z-ai/glm-5.3-flash");
  assert.equal(houseSeatModel(id, 2, offered), "rules");
  assert.equal(houseSeatModel(id, 3, offered), "gpt-4.1-mini");
  assert.equal(houseSeatModel(id, 0, offered), null, "the visitor's seat has no house model");
  // A model the server does not offer leaves the id as it was: that seat plays with the house model.
  assert.equal(idWithHouseSeats("f-abc-wxyz", ["unknown"], offered), "f-abc-wxyz");
  assert.equal(houseSeatModel("f-abc-wxyz", 1, offered), null);
});
