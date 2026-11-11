// Getting something signed by NEAR Auth, on the server: the sponsor carries a person's signing token and the payload it
// was issued for to the NEAR Auth contract, which checks the token on chain and has the MPC network sign the payload's
// sha256 with the person's key. The sponsor pays for that call and decides nothing: without the person's token, issued
// for exactly this payload after they approved it, the contract signs nothing.
//
// The contract would refuse a bad token, but the sponsor would have paid for asking. So the same checks are made here
// first, for free: the token is the sign-in service's (its RSA signature), still valid, for this guard, for this very
// payload, and from the person whose key the payload names.

import { isContractFailure } from "../../../lib/chain/client.ts";
import { parsePublicKey } from "../../../lib/chain/keys.ts";
import { ed25519Signature, MPC_ED25519_DOMAIN, mpcPath, type NearAuth } from "../../../lib/chain/nearAuth.ts";
import { chainClient } from "../../../lib/chain/shared.ts";
import type { Sponsor } from "../../../lib/chain/sponsor.ts";
import { jsonArgs } from "../../../lib/chain/transaction.ts";

/** A signing token is a JWT of about 1,500 characters. */
const TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_TOKEN = 6_000;
/** What NEAR Auth's own SDK attaches to `sign`: the token is verified (RSA) and the MPC network asked, all on chain. */
const SIGN_GAS = 300_000_000_000_000n;
/** The MPC network asks for a token deposit; the contract sends it back. */
const SIGN_DEPOSIT = 1n;
const KEYS_FOR_MS = 60 * 60_000;

export const isSigningToken = (token: unknown): token is string => typeof token === "string" && token.length <= MAX_TOKEN && TOKEN.test(token);

/** A public key of the sign-in service, as it publishes them (JWKS). */
export type ServiceKey = { kid?: string; kty?: string; n?: string; e?: string };

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const raw = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Who a signing token is from (`sub`), once it has been checked the way the NEAR Auth guard will check it: signed by
 * the sign-in service (RS256, one of `keys`), not expired, for `audience`, and naming exactly `payload`. Throws with
 * the reason otherwise.
 */
export async function tokenSubject(token: string, payload: Uint8Array, expected: { issuer: string; audience: string; keys: ServiceKey[]; now: number }): Promise<string> {
  const [head, body, signature] = token.split(".");
  let header: { alg?: string; kid?: string };
  let claims: { iss?: unknown; aud?: unknown; exp?: unknown; sub?: unknown; fatxn?: unknown };
  try {
    header = JSON.parse(new TextDecoder().decode(fromBase64Url(head)));
    claims = JSON.parse(new TextDecoder().decode(fromBase64Url(body)));
  } catch {
    throw new Error("the token cannot be read");
  }
  const key = expected.keys.find((candidate) => candidate.kid === header.kid && candidate.kty === "RSA");
  if (header.alg !== "RS256" || !key) throw new Error("the token is not signed by the sign-in service");
  const imported = await crypto.subtle.importKey("jwk", { kty: "RSA", n: key.n, e: key.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
    "verify",
  ]);
  const genuine = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", imported, fromBase64Url(signature), new TextEncoder().encode(`${head}.${body}`));
  if (!genuine) throw new Error("the token is not signed by the sign-in service");
  if (claims.iss !== expected.issuer) throw new Error("the token is from another sign-in service");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(expected.audience)) throw new Error("the token is not a signing approval");
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= expected.now) throw new Error("the approval has expired");
  const named = claims.fatxn;
  if (!Array.isArray(named) || named.length !== payload.length || !named.every((byte, i) => byte === payload[i])) throw new Error("the approval is for something else");
  if (typeof claims.sub !== "string" || claims.sub === "") throw new Error("the token names nobody");
  return claims.sub;
}

const published = new Map<string, { at: number; keys: ServiceKey[] }>();

async function serviceKeys(domain: string, fresh: boolean): Promise<ServiceKey[]> {
  const known = published.get(domain);
  if (!fresh && known && Date.now() - known.at < KEYS_FOR_MS) return known.keys;
  const response = await fetch(`https://${domain}/.well-known/jwks.json`, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`the sign-in service answered ${response.status}`);
  const keys = ((await response.json()) as { keys?: ServiceKey[] }).keys ?? [];
  published.set(domain, { at: Date.now(), keys });
  return keys;
}

export type Signed = { signature: Uint8Array; hash: string } | { refused: string; hash: string | null; status: 403 | 422 | 502 };

/**
 * The 64 bytes of the person's signature over `payload`, or why there are none. `accountKey` is the key the payload
 * is to be signed with: the token must be from the person NEAR's MPC network derives that key for.
 */
export async function askNearAuth(paying: Sponsor, auth: NearAuth, token: string, payload: Uint8Array, accountKey: Uint8Array): Promise<Signed> {
  try {
    const expected = { issuer: `https://${auth.domain}/`, audience: auth.signingAudience, now: Date.now() };
    let subject: string;
    try {
      subject = await tokenSubject(token, payload, { ...expected, keys: await serviceKeys(auth.domain, false) });
    } catch {
      // The service may have changed its keys since they were last read: once more against fresh ones.
      subject = await tokenSubject(token, payload, { ...expected, keys: await serviceKeys(auth.domain, true) });
    }
    const theirs = parsePublicKey(
      await chainClient.viewOf<string>(auth.mpcContractId, "derived_public_key", { path: mpcPath(auth, subject), predecessor: auth.contractId, domain_id: MPC_ED25519_DOMAIN }),
    );
    if (theirs.length !== accountKey.length || !theirs.every((byte, i) => byte === accountKey[i])) throw new Error("the approval is from another account");
  } catch (error) {
    return { refused: `not approved: ${error instanceof Error ? error.message : String(error)}`, hash: null, status: 403 };
  }
  try {
    const args = { guard_id: auth.guardId, verify_payload: token, sign_payload: Array.from(payload), algorithm: "eddsa" };
    const outcome = await paying.session.sendTo(auth.contractId, [{ method: "sign", args: jsonArgs(args), gas: SIGN_GAS, deposit: SIGN_DEPOSIT }]);
    const signature = ed25519Signature(outcome.value);
    // The contract answers nothing when its guard refuses the token after all.
    if (!signature) return { refused: "NEAR Auth did not sign: the approval may have expired, try again", hash: outcome.hash, status: 422 };
    return { signature, hash: outcome.hash };
  } catch (error) {
    if (isContractFailure(error)) return { refused: `NEAR Auth refused: ${error.message}`, hash: error.hash, status: 422 };
    return { refused: `could not get it signed: ${error instanceof Error ? error.message : String(error)}`, hash: null, status: 502 };
  }
}
