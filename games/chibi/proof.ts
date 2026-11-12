// What a browser asks the server's sponsor to do at the chibi contract for free (make a character, take a basic item,
// dress up), signed with a key of the account it is for, so that nobody can do it for an account that is not theirs.
// Nothing here is sent to the chain: the server reads the request, checks the signature and the key, and the sponsor
// (the contract's minter) makes the call for the account. Pure, so the browser, the server and the tests share it.

import { fromBase64, toBase64 } from "../../lib/chain/base58.ts";
import { implicitAccountId } from "../../lib/chain/evmKey.ts";
import { parsePublicKey, publicKeyText, verify } from "../../lib/chain/keys.ts";
import { ITEM_PARTS, cleanLook, type ItemPart, type Look } from "../ma-soi/look.ts";
import { isBasicLook } from "./catalog.ts";

/** What `equip` takes: the character's own traits and the item tokens it wears. */
export type Outfit = { body: number; skin: number; hairColor: number; robe: number; worn: string[] };

export type ChibiRequest = { action: "create"; name: string; look: Look } | { action: "claim"; part: ItemPart; index: number } | { action: "equip"; outfit: Outfit };

/** The request as sent: who it is for, the key that signed it, the text signed and the signature. */
export type SignedRequest = { accountId: string; publicKey: string; payload: string; signature: string };

/** A request the server accepted, with whether the key is the one the account is named after (no chain lookup needed). */
export type OpenedRequest = { accountId: string; publicKey: Uint8Array; ownKey: boolean; request: ChibiRequest };

export type Signer = { accountId: string; publicKey: Uint8Array; signMessage(message: Uint8Array): Uint8Array };

const PREFIX = "deedlords-chibi/1\n";
/** A signed request is good this long either side of the server's clock. */
export const MAX_AGE_MS = 5 * 60_000;
export const MAX_PAYLOAD = 2_048;
const ACCOUNT_ID = /^(?:[0-9a-f]{64}|(?=.{2,64}$)[a-z0-9]+(?:[-_.][a-z0-9]+)*)$/;
const TOKEN_ID = /^[a-zA-Z]+:\d{1,3}:\d{1,12}$/;
const utf8 = new TextEncoder();

/** The server says no, and why. Nothing was sent. */
export class Refused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Refused";
  }
}

export function signRequest(signer: Signer, where: { contract: string; network: string }, request: ChibiRequest, now = Date.now()): SignedRequest {
  const payload = PREFIX + JSON.stringify({ account: signer.accountId, contract: where.contract, network: where.network, at: now, ...request });
  return { accountId: signer.accountId, publicKey: publicKeyText(signer.publicKey), payload, signature: toBase64(signer.signMessage(utf8.encode(payload))) };
}

const isIndex = (value: unknown, below = 256): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) < below;

function cleanOutfit(value: unknown): Outfit | null {
  if (typeof value !== "object" || value === null) return null;
  const { body, skin, hairColor, robe, worn } = value as Record<string, unknown>;
  if (![body, skin, hairColor, robe].every((n) => isIndex(n))) return null;
  if (!Array.isArray(worn) || worn.length > ITEM_PARTS.length || !worn.every((id) => typeof id === "string" && TOKEN_ID.test(id))) return null;
  return { body: body as number, skin: skin as number, hairColor: hairColor as number, robe: robe as number, worn: worn as string[] };
}

/** The request inside a payload, checked for shape only: the contract checks the rest (names taken, items owned). */
export function cleanRequest(value: Record<string, unknown>): ChibiRequest {
  switch (value.action) {
    case "create": {
      const look = cleanLook(value.look);
      if (typeof value.name !== "string" || value.name.length === 0 || value.name.length > 40) throw new Refused("name: 2 to 20 characters");
      if (!look || !isBasicLook(look)) throw new Refused("look: a look of basic items");
      return { action: "create", name: value.name, look };
    }
    case "claim":
      if (!(ITEM_PARTS as readonly unknown[]).includes(value.part) || !isIndex(value.index)) throw new Refused("claim: a part and an index");
      return { action: "claim", part: value.part as ItemPart, index: value.index as number };
    case "equip": {
      const outfit = cleanOutfit(value.outfit);
      if (!outfit) throw new Refused("equip: traits and up to nine item tokens");
      return { action: "equip", outfit };
    }
    default:
      throw new Refused("action: create, claim or equip");
  }
}

/** Checks a signed request: its form, its signature, that it is meant for this contract and is recent. Throws `Refused`. */
export function openRequest(body: unknown, where: { contract: string; network: string }, now = Date.now()): OpenedRequest {
  if (typeof body !== "object" || body === null) throw new Refused("send { accountId, publicKey, payload, signature }");
  const { accountId, publicKey: keyText, payload, signature } = body as Record<string, unknown>;
  if (typeof accountId !== "string" || !ACCOUNT_ID.test(accountId)) throw new Refused("accountId: a NEAR account");
  if (typeof payload !== "string" || payload.length > MAX_PAYLOAD || !payload.startsWith(PREFIX)) throw new Refused("payload: a chibi request");
  if (typeof keyText !== "string" || typeof signature !== "string") throw new Refused("publicKey and signature");
  let publicKey: Uint8Array;
  let signed: Uint8Array;
  try {
    publicKey = parsePublicKey(keyText);
    signed = fromBase64(signature);
  } catch {
    throw new Refused("publicKey and signature");
  }
  if (!verify(publicKey, utf8.encode(payload), signed)) throw new Refused("the signature does not match");
  let fields: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(payload.slice(PREFIX.length));
    fields = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new Refused("payload: not JSON");
  }
  if (fields.account !== accountId) throw new Refused("the request is for another account");
  if (fields.contract !== where.contract || fields.network !== where.network) throw new Refused(`the request is for another contract than ${where.contract}`);
  if (typeof fields.at !== "number" || Math.abs(now - fields.at) > MAX_AGE_MS) throw new Refused("the request is too old: check this computer's clock");
  return { accountId, publicKey, ownKey: implicitAccountId(publicKey) === accountId, request: cleanRequest(fields) };
}

/** The contract call a request becomes, made by the minter for the account. */
export function minterCall(opened: OpenedRequest): { method: string; args: Record<string, unknown> } {
  const owner = opened.accountId;
  const { request } = opened;
  if (request.action === "create") return { method: "create_character", args: { owner, name: request.name, look: request.look } };
  if (request.action === "claim") return { method: "claim", args: { owner, part: request.part, index: request.index } };
  return { method: "equip", args: { owner, outfit: request.outfit } };
}
