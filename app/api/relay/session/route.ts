// Giving a browser a key to play with, for an account signed in through NEAR Auth (Google, email, passkey).
// POST { token, payload }: `payload` is a key grant (base64 of lib/chain/transaction.ts `encodeKeyGrant`), `token` the
// signing token Auth0 issued for exactly that payload after the person approved it. The sponsor:
//   1. calls the NEAR Auth contract's `sign` with both (its gas: the contract checks the token on chain and has the MPC
//      network sign the grant with the person's key);
//   2. sends the signed grant to the person's account as a meta-transaction (its gas again), which adds the key.
// The sponsor's own key signs nothing on the person's behalf: it carries their token to the contract and pays.
//
// What may be granted is decided by relayRules.ts `grantable`: a key that can only move a seat on the game contract.

import { clientKey } from "@/games/co-ty-phu/agent/rateLimit";
import { askNearAuth, isSigningToken } from "@/games/co-ty-phu/chain/authDesk";
import { jsonAnswer, limits } from "@/games/co-ty-phu/chain/freeDesk";
import { grantable, Refused } from "@/games/co-ty-phu/chain/relayRules";
import { fromBase64 } from "@/lib/chain/base58";
import { isContractFailure } from "@/lib/chain/client";
import { CHAIN } from "@/lib/chain/config";
import { NEAR_AUTH } from "@/lib/chain/nearAuth";
import { chainClient } from "@/lib/chain/shared";
import { sponsor } from "@/lib/chain/sponsor";
import { type KeyGrant, readKeyGrant, signedKeyGrant } from "@/lib/chain/transaction";

export const dynamic = "force-dynamic";

/** A grant is about 350 bytes. */
const MAX_PAYLOAD_TEXT = 1_024;
const text = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function POST(request: Request): Promise<Response> {
  const auth = NEAR_AUTH;
  const paying = sponsor();
  if (!auth || !paying) return jsonAnswer(503, { error: "signing in through NEAR Auth is not set up on this server" });
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return jsonAnswer(400, { error: "send JSON: { token, payload }" });
  }
  const { token, payload: payloadText } = body;
  if (!isSigningToken(token)) return jsonAnswer(400, { error: "token: the signing token" });
  if (typeof payloadText !== "string" || payloadText.length > MAX_PAYLOAD_TEXT) return jsonAnswer(400, { error: "payload: the key grant, base64" });

  let payload: Uint8Array;
  let grant: KeyGrant;
  try {
    payload = fromBase64(payloadText);
    grant = readKeyGrant(payload);
    grantable(grant, CHAIN.contractId);
  } catch (error) {
    return error instanceof Refused ? jsonAnswer(403, { error: error.message }) : jsonAnswer(400, { error: `not a key grant: ${text(error)}` });
  }
  if (!limits.grantPerIp.allow(clientKey(request)) || !limits.grantGlobal.allow("*"))
    return jsonAnswer(429, { error: "too many sign-ins from here in a short time: wait a few minutes" });

  try {
    // The grant is signed with the account's key, which exists on chain only once the account does (see /api/relay `open`).
    if ((await chainClient.accessKeyNonce(grant.accountId, grant.accountKey)) === null) return jsonAnswer(409, { error: "the account is not on chain yet" });
  } catch {
    return jsonAnswer(502, { error: `cannot reach ${CHAIN.network}` });
  }

  const answer = await askNearAuth(paying, auth, token, payload, grant.accountKey);
  if ("refused" in answer) return jsonAnswer(answer.status, { error: answer.refused, hash: answer.hash });
  let signed: Uint8Array;
  try {
    signed = signedKeyGrant(payload, answer.signature);
  } catch (error) {
    return jsonAnswer(502, { error: text(error), hash: answer.hash });
  }
  try {
    const outcome = await paying.session.sendTo(grant.accountId, [{ delegate: signed }], { delegatedTo: grant.accountId });
    return jsonAnswer(200, { accountId: grant.accountId, hash: outcome.hash });
  } catch (error) {
    if (isContractFailure(error)) return jsonAnswer(422, { error: `the account did not take the key: ${error.message}`, hash: error.hash });
    return jsonAnswer(502, { error: `the sponsor could not send the grant: ${text(error)}` });
  }
}
