// Free play: what the sponsor agrees to pay for (relayRules.ts), the table it opens (calls.ts), and what a room tells
// whoever sends its calls about the table they are for (room.ts). The bytes of a delegate action are pinned in
// chain-transaction.test.ts; the whole path is played on testnet, not here.

import assert from "node:assert/strict";
import { test } from "node:test";
import { freeTableCalls, FREE_AGENT_SEAT, STORAGE_DEPOSIT } from "../games/co-ty-phu/chain/calls.ts";
import { grantable, Refused, relayable, RELAY_MAX_GAS } from "../games/co-ty-phu/chain/relayRules.ts";
import { ed25519Signature } from "../lib/chain/nearAuth.ts";
import { encodeBase58 } from "../lib/chain/base58.ts";
import { implicitAccountId } from "../lib/chain/evmKey.ts";
import { parseSecretKey } from "../lib/chain/keys.ts";
import { type DelegateAction, type FunctionCall, jsonArgs, type KeyGrant, readSignedDelegate, signDelegateAction } from "../lib/chain/transaction.ts";

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
