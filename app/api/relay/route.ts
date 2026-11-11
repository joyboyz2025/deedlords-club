// The relayer of free play. GET: which account sponsors it here (`null`: none). POST { delegate }: a player's signed
// call for a free table (base64 of lib/chain/transaction.ts `signDelegateAction`), which the sponsor sends as a
// meta-transaction (NEP-366) and pays the gas of; the contract still sees the player as the caller. POST { open }: a
// game account's public key, to bring the account into existence on chain so that its key has a nonce to sign with.
//
// The sponsor's money is at stake in every line here: what may be sent is decided by relayRules.ts (one deposit-free
// seat call from a game account's own key) and freeDesk.ts (only for tables the sponsor itself opened, under limits).

import { clientKey } from "@/games/co-ty-phu/agent/rateLimit";
import { isGrantedKey, isSponsored, jsonAnswer, limits } from "@/games/co-ty-phu/chain/freeDesk";
import { Refused, relayable } from "@/games/co-ty-phu/chain/relayRules";
import { fromBase64 } from "@/lib/chain/base58";
import { ContractFailure } from "@/lib/chain/client";
import { CHAIN } from "@/lib/chain/config";
import { implicitAccountId } from "@/lib/chain/evmKey";
import { parsePublicKey } from "@/lib/chain/keys";
import { chainClient } from "@/lib/chain/shared";
import { type Sponsor, sponsor } from "@/lib/chain/sponsor";
import { type DelegateAction, readSignedDelegate } from "@/lib/chain/transaction";

export const dynamic = "force-dynamic";

/** A signed delegate action for one move is about 400 bytes; the longest `play` about 3,000. */
const MAX_DELEGATE_TEXT = 8_192;
/** All a game account needs to exist: an account this small pays no storage. */
const OPENING_YOCTO = 1n;

const text = (error: unknown) => (error instanceof Error ? error.message : String(error));
const opening = new Map<string, Promise<string>>();

export function GET(): Response {
  return jsonAnswer(200, { sponsor: sponsor()?.accountId ?? null, contract: CHAIN.contractId, network: CHAIN.network });
}

export async function POST(request: Request): Promise<Response> {
  const paying = sponsor();
  if (!paying) return jsonAnswer(503, { error: "nobody sponsors play on this server" });
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return jsonAnswer(400, { error: "send JSON: { delegate } or { open }" });
  }
  const ip = clientKey(request);
  if (typeof body.open === "string") return open(paying, body.open, ip);
  if (typeof body.delegate !== "string" || body.delegate.length > MAX_DELEGATE_TEXT) return jsonAnswer(400, { error: "send JSON: { delegate } or { open }" });

  let bytes: Uint8Array;
  let action: DelegateAction;
  let what: { matchId: string; method: string; ownKey: boolean };
  try {
    bytes = fromBase64(body.delegate);
    action = readSignedDelegate(bytes);
    what = relayable(action, CHAIN.contractId);
  } catch (error) {
    return error instanceof Refused ? jsonAnswer(403, { error: error.message }) : jsonAnswer(400, { error: `not a signed call: ${text(error)}` });
  }
  if (!limits.relayPerIp.allow(ip) || !limits.relayPerAccount.allow(action.senderId) || !limits.relayGlobal.allow("*")) {
    return jsonAnswer(429, { error: "too many moves from here in a short time: wait a few minutes" });
  }
  try {
    if (!what.ownKey && !(await isGrantedKey(action.senderId, action.publicKey))) return jsonAnswer(403, { error: "this key is not one the account granted for the game" });
    if (!(await isSponsored(what.matchId, paying))) return jsonAnswer(403, { error: `${what.matchId} is not an open free table of this server` });
  } catch {
    return jsonAnswer(502, { error: `cannot reach ${CHAIN.network}` });
  }
  try {
    // To the player's own account: that is where a delegate action is checked (key, nonce, expiry) and turned into
    // the player's call to the game contract.
    return jsonAnswer(200, await paying.session.sendTo(action.senderId, [{ delegate: bytes }]));
  } catch (error) {
    if (error instanceof ContractFailure) return jsonAnswer(200, { hash: error.hash, failed: error.message });
    return jsonAnswer(502, { error: `the sponsor could not send it: ${text(error)}` });
  }
}

/** Brings a game account into existence: an implicit account appears with its key the first time anything is sent to it. */
async function open(paying: Sponsor, keyText: string, ip: string): Promise<Response> {
  let accountId: string;
  try {
    accountId = implicitAccountId(parsePublicKey(keyText));
  } catch {
    return jsonAnswer(400, { error: "open: a public key, ed25519:…" });
  }
  try {
    if ((await chainClient.balance(accountId)) !== null) return jsonAnswer(200, { accountId, existed: true });
  } catch {
    return jsonAnswer(502, { error: `cannot reach ${CHAIN.network}` });
  }
  let pending = opening.get(accountId);
  if (!pending) {
    if (!limits.openPerIp.allow(ip) || !limits.openGlobal.allow("*")) return jsonAnswer(429, { error: "too many new accounts from here in a short time: wait a few minutes" });
    pending = paying.session
      .sendTo(accountId, [{ transfer: OPENING_YOCTO }])
      .then((outcome) => outcome.hash)
      .finally(() => opening.delete(accountId));
    opening.set(accountId, pending);
  }
  try {
    return jsonAnswer(200, { accountId, existed: false, hash: await pending });
  } catch (error) {
    return jsonAnswer(502, { error: `the sponsor could not open the account: ${text(error)}` });
  }
}
