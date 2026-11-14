// The chibi characters: the catalogue the contract is generated from, the signed requests the sponsor acts on, and
// the one paid call a Google account may have signed (a box). The contract itself is tested in contracts/chibi
// (cargo test) and on a local near-sandbox (contracts/sandbox/chibi-run.js); the pages were played on testnet.

import assert from "node:assert/strict";
import { guestHandle } from "../lib/seatName.ts";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BASIC_ITEMS, BOX_ITEMS, CATALOG, catalogRust, isBasicLook, itemOfToken, kindOf, wornKinds } from "../games/chibi/catalog.ts";
import { characterOf, forget, remember } from "../games/chibi/known.ts";
import { NAMES_EN } from "../games/chibi/names.ts";
import { MAX_AGE_MS, minterCall, openRequest, Refused, signRequest, type ChibiRequest, type Signer } from "../games/chibi/proof.ts";
import { playerName, seatNames, toGame } from "../games/co-ty-phu/chain/adapt.ts";
import { BOX_MAX_DEPOSIT, Refused as RelayRefused, signable } from "../games/co-ty-phu/chain/relayRules.ts";
import { LOOK_CHOICES, lookFromSeat, rarityOf, starterLook, type Look, type LookPart } from "../games/ma-soi/look.ts";
import { encodeBase58 } from "../lib/chain/base58.ts";
import { implicitAccountId } from "../lib/chain/evmKey.ts";
import { parseSecretKey, sign } from "../lib/chain/keys.ts";
import { jsonArgs, type Transaction } from "../lib/chain/transaction.ts";

const WHERE = { contract: "chibi.deedlords.testnet", network: "testnet" };
const pair = parseSecretKey(`ed25519:${encodeBase58(new Uint8Array(32).fill(9))}`);
const other = parseSecretKey(`ed25519:${encodeBase58(new Uint8Array(32).fill(4))}`);
const guest = implicitAccountId(pair.publicKey);
const signer = (accountId = guest, key = pair): Signer => ({ accountId, publicKey: key.publicKey, signMessage: (message) => sign(key, message) });
const LOOK: Look = { body: 1, skin: 2, hair: 4, hairColor: 1, outfit: 1, robe: 5, neck: 1, hat: 5, face: 0, held: 3, shoes: 1, pet: 0, ride: 0 };
const NOW = 1_800_000_000_000;

test("every chibi part has an English name, and the contract's catalogue is generated from the game's", () => {
  for (const part of Object.keys(LOOK_CHOICES) as LookPart[]) assert.equal(NAMES_EN[part].length, LOOK_CHOICES[part].length, `${part}: one English name per choice`);
  assert.equal(readFileSync(new URL("../contracts/chibi/src/catalog.rs", import.meta.url), "utf8"), catalogRust(), "run `npm run chibi:catalog`");
  // Index 0 of each item part is the bare default, never a token; everything else is basic (free) or in a box.
  assert.ok(CATALOG.every((item) => item.index > 0));
  assert.equal(BASIC_ITEMS.length + BOX_ITEMS.length, CATALOG.length);
  for (const rarity of [1, 2, 3])
    assert.ok(
      BOX_ITEMS.some((item) => item.rarity === rarity),
      `a box can give rarity ${rarity}`,
    );
});

test("item tokens name their kind; a new character is basic", () => {
  assert.deepEqual(itemOfToken("hat:6:41"), { kind: "hat:6", part: "hat", index: 6, name: "Mandarin cap", rarity: 1 });
  assert.equal(itemOfToken("char:1"), undefined);
  assert.equal(itemOfToken("hat:0:1"), undefined);
  assert.equal(itemOfToken("hat:99:1"), undefined);
  assert.deepEqual(wornKinds(LOOK), ["outfit:1", "neck:1", "hat:5", "held:3", "shoes:1", "hair:4"]);
  assert.equal(kindOf("outfit", 5), "outfit:5");
  assert.ok(isBasicLook(LOOK));
  assert.ok(!isBasicLook({ ...LOOK, outfit: 5 }), "a dragon robe is Epic");
  for (let seed = 0; seed < 20; seed++) assert.ok(isBasicLook(starterLook(() => (seed * 0.37) % 1)), "a starter look is basic");
});

test("a signed request opens for the account whose key signed it", () => {
  const signed = signRequest(signer(), WHERE, { action: "create", name: "Cô Lồng Đèn", look: LOOK }, NOW);
  const opened = openRequest(signed, WHERE, NOW + 1_000);
  assert.equal(opened.accountId, guest);
  assert.ok(opened.ownKey, "the key the account is named after");
  assert.deepEqual(minterCall(opened), { method: "create_character", args: { owner: guest, name: "Cô Lồng Đèn", look: LOOK } });
  // A named account (a wallet, a Google key that is not its name): the route checks the key on chain.
  const named = openRequest(signRequest(signer("alice.testnet"), WHERE, { action: "claim", part: "hat", index: 4 }, NOW), WHERE, NOW);
  assert.equal(named.ownKey, false);
  assert.deepEqual(minterCall(named), { method: "claim", args: { owner: "alice.testnet", part: "hat", index: 4 } });
  const outfit = { body: 0, skin: 1, hairColor: 2, robe: 3, worn: ["hat:6:41", "hair:4:7"] };
  assert.deepEqual(minterCall(openRequest(signRequest(signer(), WHERE, { action: "equip", outfit }, NOW), WHERE, NOW)), { method: "equip", args: { owner: guest, outfit } });
});

test("a request is refused when it is not what its account signed, for here, now", () => {
  const refused = (body: unknown, why: RegExp, now = NOW) =>
    assert.throws(
      () => openRequest(body, WHERE, now),
      (error) => error instanceof Refused && why.test(error.message),
    );
  const create: ChibiRequest = { action: "create", name: "Alice", look: LOOK };
  const signed = signRequest(signer(), WHERE, create, NOW);
  refused({ ...signed, accountId: implicitAccountId(other.publicKey) }, /another account/);
  refused({ ...signed, payload: signed.payload.replace("Alice", "Mallory") }, /signature does not match/);
  // Another key, signing for the guest: opened, but not as the account's own key, so the route asks the chain.
  assert.equal(openRequest(signRequest(signer(guest, other), WHERE, create, NOW), WHERE, NOW).ownKey, false);
  refused({ ...signRequest(signer(), WHERE, create, NOW), publicKey: `ed25519:${encodeBase58(other.publicKey)}` }, /signature does not match/);
  refused(signRequest(signer(), { ...WHERE, contract: "chibi.someone.testnet" }, create, NOW), /another contract/);
  refused(signRequest(signer(), { ...WHERE, network: "mainnet" }, create, NOW), /another contract/);
  refused(signed, /too old/, NOW + MAX_AGE_MS + 1);
  refused(signRequest(signer(), WHERE, { ...create, look: { ...LOOK, outfit: 5 } }, NOW), /basic items/);
  refused(signRequest(signer(), WHERE, { action: "claim", part: "pet" as "hat", index: 1.5 }, NOW), /a part and an index/);
  refused(signRequest(signer(), WHERE, { action: "equip", outfit: { body: 0, skin: 0, hairColor: 0, robe: 0, worn: ["drop table"] } }, NOW), /item tokens/);
  refused(signRequest(signer(), WHERE, { action: "transfer" } as unknown as ChibiRequest, NOW), /create, claim or equip/);
  refused({ ...signed, accountId: "Not An Account" }, /a NEAR account/);
  refused("nonsense", /send/);
});

test("a Google account may have one box signed at the chibi contract, and nothing else there", () => {
  const box = (over: Partial<Transaction> = {}, deposit = 100_000_000_000_000_000_000_000n, method = "buy_box"): Transaction => ({
    signerId: guest,
    publicKey: pair.publicKey,
    nonce: 3n,
    receiverId: WHERE.contract,
    blockHash: new Uint8Array(32).fill(1),
    actions: [{ method, args: jsonArgs({}), gas: 30_000_000_000_000n, deposit }],
    ...over,
  });
  assert.equal(signable(box(), "game.deedlords.testnet", WHERE.contract), "box");
  const refused = (tx: Transaction, why: RegExp, chibi: string | null = WHERE.contract) =>
    assert.throws(
      () => signable(tx, "game.deedlords.testnet", chibi),
      (error) => error instanceof RelayRefused && why.test(error.message),
    );
  refused(box({}, 1n, "nft_transfer"), /only buying a box/);
  refused(box({}, BOX_MAX_DEPOSIT + 1n), /at most 1 NEAR/);
  refused(box({}, 0n), /at most 1 NEAR/);
  refused(box({ actions: [...box().actions, ...box().actions] }), /only buying a box/);
  refused(box({ signerId: "alice.testnet" }), /game account's own/);
  // A server that names no chibi contract signs nothing there.
  refused(box(), /only stakes at/, null);
});

test("a table shows a seat by its backer's character once read, and draws its look", () => {
  const meta = {
    id: "m-1",
    seats: [
      { seat: 0, player: "s0", backer: guest, driver: null, house: false },
      { seat: 1, player: "s1", backer: "bob.testnet", driver: null, house: false },
    ],
  };
  // A guest with no character yet is shown by its handle (lib/seatName), not by its hex digits.
  assert.deepEqual(seatNames(meta as never), [guestHandle(guest), "bob"]);
  remember(guest, { accountId: guest, tokenId: "char:1", name: "Cô Lồng Đèn", look: { ...LOOK, pet: 3, ride: 2 }, worn: {} });
  try {
    assert.deepEqual(seatNames(meta as never), ["Cô Lồng Đèn", "bob"]);
    assert.equal(playerName(guest), "Cô Lồng Đèn");
    assert.equal(characterOf(guest)?.tokenId, "char:1");
    const game = toGame({
      meta: { ...meta, rules: { salary: 200, cash: 1500, blitz: false, maxRounds: 6 }, turn_seconds: 60 },
      game: { phase: "lobby", players: [{ id: "s0" }, { id: "s1" }], order: [], props: {}, log: [] },
      log: [],
    } as never);
    // At a table: the character's look without its pet and ride; a seat with no character keeps its default.
    assert.deepEqual(game.players[0].look, { ...LOOK, pet: 0, ride: 0 });
    assert.deepEqual(game.players[1].look, lookFromSeat(1));
    assert.equal(rarityOf("hat", game.players[0].look.hat), 0);
  } finally {
    forget(guest);
  }
});
