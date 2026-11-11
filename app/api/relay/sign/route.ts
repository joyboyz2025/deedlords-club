// A signature for an account signed in through NEAR Auth, when its own NEAR is at stake: opening a staked match,
// taking a staked seat, or sending NEAR out of the account. POST { token, payload }: `payload` is the transaction
// (base64 of lib/chain/transaction.ts `encodeTransaction`), `token` the signing token Auth0 issued for exactly that
// transaction after the person approved it. Answers { signature }: the browser attaches it and sends the
// transaction itself, so the account pays its own gas and its own stake. The sponsor pays only for asking.
//
// What may be signed is decided by relayRules.ts `signable`.

import { clientKey } from "@/games/co-ty-phu/agent/rateLimit";
import { askNearAuth, isSigningToken } from "@/games/co-ty-phu/chain/authDesk";
import { jsonAnswer, limits } from "@/games/co-ty-phu/chain/freeDesk";
import { Refused, signable } from "@/games/co-ty-phu/chain/relayRules";
import { fromBase64, toBase64 } from "@/lib/chain/base58";
import { CHAIN } from "@/lib/chain/config";
import { NEAR_AUTH } from "@/lib/chain/nearAuth";
import { sponsor } from "@/lib/chain/sponsor";
import { readTransaction, type Transaction, withSignature } from "@/lib/chain/transaction";

export const dynamic = "force-dynamic";

/** Opening a match and taking its first seat is about 450 bytes. */
const MAX_PAYLOAD_TEXT = 8_192;
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
  if (typeof payloadText !== "string" || payloadText.length > MAX_PAYLOAD_TEXT) return jsonAnswer(400, { error: "payload: the transaction, base64" });

  let payload: Uint8Array;
  let tx: Transaction;
  try {
    payload = fromBase64(payloadText);
    tx = readTransaction(payload);
    signable(tx, CHAIN.contractId);
  } catch (error) {
    return error instanceof Refused ? jsonAnswer(403, { error: error.message }) : jsonAnswer(400, { error: `not a transaction: ${text(error)}` });
  }
  if (!limits.signPerIp.allow(clientKey(request)) || !limits.signPerAccount.allow(tx.signerId) || !limits.signGlobal.allow("*")) {
    return jsonAnswer(429, { error: "too many approvals from here in a short time: wait a few minutes" });
  }

  const answer = await askNearAuth(paying, auth, token, payload, tx.publicKey);
  if ("refused" in answer) return jsonAnswer(answer.status, { error: answer.refused, hash: answer.hash });
  try {
    withSignature(payload, answer.signature, tx.publicKey); // the key of the account it is sent from, or nothing
  } catch (error) {
    return jsonAnswer(502, { error: text(error), hash: answer.hash });
  }
  return jsonAnswer(200, { signature: toBase64(answer.signature), hash: answer.hash });
}
