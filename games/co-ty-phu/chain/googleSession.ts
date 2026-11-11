// Signing in with Google (or email, or a passkey) through NEAR Auth, for somebody with no wallet. See
// lib/chain/nearAuth.ts for what NEAR Auth is. Two windows, each opened by a click:
//
//   1. `identify`: the sign-in itself. It tells who the person is, and from that the NEAR account that is theirs: the
//      implicit account of the key NEAR's MPC network derives for them. Nothing is signed yet.
//   2. `confirmGrant`: the person approves one thing, a key grant: this browser gets a key that can only move a seat
//      in the game. The sponsor has NEAR Auth sign it and adds it to the account (/api/relay/session).
//
// After that the browser's key signs every move: no window, no wallet, and at a free table no NEAR. The grant is
// asked for once per browser: signing out parks the key, signing in again finds it (keySession.ts).
//
// The account is a NEAR account like any other: NEAR can be sent to it. Spending that NEAR is the one thing the
// browser's key cannot do, so a stake or a withdrawal is approved in the window each time (`sendWithNearAuth`).

import type { Auth0Client } from "@auth0/auth0-spa-js";
import { fromBase64, toBase64 } from "@/lib/chain/base58";
import type { Outcome } from "@/lib/chain/client";
import { CHAIN } from "@/lib/chain/config";
import { implicitAccountId } from "@/lib/chain/evmKey";
import { generateKeyPair, type KeyPair, parsePublicKey, publicKeyText } from "@/lib/chain/keys";
import { MPC_ED25519_DOMAIN, mpcPath, NEAR_AUTH, type NearAuth } from "@/lib/chain/nearAuth";
import { chainClient } from "@/lib/chain/shared";
import { encodeKeyGrant, encodeTransaction, type FunctionCall, type Transfer, withSignature } from "@/lib/chain/transaction";
import { GRANT_METHODS, SESSION_ALLOWANCE } from "./calls";
import { post } from "./free";
import { keepGoogleAccount, parkedGoogleKey } from "./keySession";

export type GoogleIdentity = { accountId: string; accountKey: Uint8Array; /** A name to show: theirs, or their address. */ label: string };
/** A key grant ready to be approved: all that is left is the person's click. */
export type PendingGrant = { identity: GoogleIdentity; payload: Uint8Array; sessionPair: KeyPair };

/** How long the approved grant stays sendable, in blocks: about half an hour on testnet, for somebody slow to approve. */
const GRANT_BLOCKS = 3_000n;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let made: Promise<Auth0Client> | null = null;

function auth0(auth: NearAuth): Promise<Auth0Client> {
  made ??= import("@auth0/auth0-spa-js").then(({ Auth0Client }) => new Auth0Client({ domain: auth.domain, clientId: auth.clientId, authorizationParams: {} }));
  return made;
}

export const googleSignInOffered = (): boolean => NEAR_AUTH !== null;

/** Loads the sign-in library ahead of the click, so the click has nothing to wait for. */
export function warmGoogleSignIn(): void {
  if (NEAR_AUTH) void auth0(NEAR_AUTH).catch(() => (made = null));
}

function setUp(): NearAuth {
  if (!NEAR_AUTH) throw new Error("Signing in with Google is not set up here.");
  return NEAR_AUTH;
}

/** The sign-in window. Opened first thing in the click that asked for it, or the browser blocks it. */
function openWindow(): Window {
  const left = Math.max(0, window.screenX + (window.outerWidth - 440) / 2);
  const top = Math.max(0, window.screenY + (window.outerHeight - 700) / 2);
  const opened = window.open("", "deedlords-near-auth", `width=440,height=700,left=${left},top=${top}`);
  if (!opened) throw new Error("The browser blocked the sign-in window. Allow pop-ups for this page and try again.");
  return opened;
}

function readable(error: unknown): Error {
  const code = (error as { error?: string }).error;
  if (code === "cancelled") return new Error("The sign-in window was closed before it finished.");
  if (code === "timeout") return new Error("The sign-in window took too long. Try again.");
  const message = (error as { error_description?: string }).error_description ?? (error instanceof Error ? error.message : String(error));
  return new Error(`The sign-in did not go through: ${message}`);
}

/** Step 1, from a click: who is this, and which NEAR account is theirs. */
export async function identify(): Promise<GoogleIdentity> {
  const auth = setUp();
  const popup = openWindow();
  try {
    const client = await auth0(auth);
    await client.loginWithPopup({ authorizationParams: {} }, { popup });
    const claims = await client.getIdTokenClaims();
    if (!claims?.sub) throw new Error("the sign-in gave no identity");
    const keyText = await chainClient.viewOf<string>(auth.mpcContractId, "derived_public_key", {
      path: mpcPath(auth, claims.sub),
      predecessor: auth.contractId,
      domain_id: MPC_ED25519_DOMAIN,
    });
    const accountKey = parsePublicKey(keyText);
    return { accountId: implicitAccountId(accountKey), accountKey, label: claims.name || claims.nickname || claims.email || "Google account" };
  } catch (error) {
    if (!popup.closed) popup.close();
    throw readable(error);
  }
}

/** Whether this browser already holds a key that account granted and still has. If so, plays as the account. */
export async function resumeGoogle(identity: GoogleIdentity): Promise<boolean> {
  const pair = parkedGoogleKey(identity.accountId);
  if (!pair || !(await chainClient.session(identity.accountId, pair).ready())) return false;
  keepGoogleAccount(identity.accountId, pair, identity.label);
  return true;
}

/**
 * Between the two windows, with no click needed: has the sponsor bring the account into existence if nobody has yet,
 * makes this browser's key, and writes the grant for it.
 */
export async function prepareGrant(identity: GoogleIdentity): Promise<PendingGrant> {
  const readNonce = () => chainClient.accessKeyNonce(identity.accountId, identity.accountKey);
  let nonce = await readNonce();
  if (nonce === null) {
    await post("/api/relay", { open: publicKeyText(identity.accountKey) });
    // The node that answers may be a block behind the one that took the transfer.
    for (let i = 0; i < 20 && nonce === null; i++) {
      await sleep(300);
      nonce = await readNonce();
    }
  }
  if (nonce === null) throw new Error("Your account is not on NEAR yet. Try again in a moment.");
  const sessionPair = generateKeyPair();
  const payload = encodeKeyGrant({
    accountId: identity.accountId,
    accountKey: identity.accountKey,
    sessionKey: sessionPair.publicKey,
    contractId: CHAIN.contractId,
    methods: [...GRANT_METHODS],
    allowance: BigInt(SESSION_ALLOWANCE),
    nonce: nonce + 1n,
    maxBlockHeight: (await chainClient.blockHeight(true)) + GRANT_BLOCKS,
  });
  return { identity, payload, sessionPair };
}

/**
 * One approval: the window asks the person to approve exactly `payload` (a key grant, or a transaction), and Auth0
 * answers with a token that names it. The token is what the NEAR Auth contract checks before anything is signed.
 */
async function approve(auth: NearAuth, popup: Window, payload: Uint8Array, as: "delegateAction" | "transaction"): Promise<string> {
  try {
    const client = await auth0(auth);
    await client.loginWithPopup({ authorizationParams: { audience: auth.signingAudience, scope: "transaction:sign", [as]: Array.from(payload) } }, { popup });
    // The window has just put the token in the library's cache; ask the cache first, so nothing has to reach Auth0 again.
    const cached = await client.getTokenSilently({ authorizationParams: { audience: auth.signingAudience, scope: "transaction:sign" }, cacheMode: "cache-only" });
    const token = cached ?? (await client.getTokenSilently({ authorizationParams: { audience: auth.signingAudience } }));
    if (!token) throw new Error("the approval gave no token");
    // A token kept from an earlier approval names an earlier payload: the contract would refuse it, so say so here.
    if (!names(token, payload)) throw new Error("the approval that came back is for something else; try once more");
    return token;
  } catch (error) {
    if (!popup.closed) popup.close();
    throw readable(error);
  }
}

/** Whether the signing token is for this payload (its `fatxn` claim). A token that cannot be read is left to the contract. */
function names(token: string, payload: Uint8Array): boolean {
  try {
    const body = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const claimed = (JSON.parse(atob(body)) as { fatxn?: unknown }).fatxn;
    if (!Array.isArray(claimed)) return true;
    return claimed.length === payload.length && claimed.every((byte, i) => byte === payload[i]);
  } catch {
    return true;
  }
}

/** Step 2, from a click: the person approves the grant, the sponsor has it signed and added, and this browser plays. */
export async function confirmGrant(pending: PendingGrant): Promise<void> {
  const auth = setUp();
  const token = await approve(auth, openWindow(), pending.payload, "delegateAction");
  await post("/api/relay/session", { token, payload: toBase64(pending.payload) });
  const { accountId, label } = pending.identity;
  const session = chainClient.session(accountId, pending.sessionPair);
  for (let i = 0; i < 20 && !(await session.ready()); i++) await sleep(300);
  keepGoogleAccount(accountId, pending.sessionPair, label);
}

/**
 * From a click: a transaction of the account's own, with its own NEAR in it (a stake, a withdrawal). The key this
 * browser holds cannot sign that, so the person approves this one transaction in the sign-in window, NEAR Auth signs
 * it, and the browser sends it: the account pays its own gas and whatever the transaction attaches.
 */
export async function sendWithNearAuth(accountId: string, receiverId: string, actions: (FunctionCall | Transfer)[]): Promise<Outcome> {
  const auth = setUp();
  const popup = openWindow();
  let payload: Uint8Array;
  let accountKey: Uint8Array;
  try {
    // An account signed in this way is named after its key: the name is the key, in hex.
    accountKey = Uint8Array.from(accountId.match(/../g)!.map((pair) => Number.parseInt(pair, 16)));
    const nonce = await chainClient.accessKeyNonce(accountId, accountKey);
    if (nonce === null) throw new Error("this account is not on NEAR yet");
    payload = encodeTransaction({ signerId: accountId, publicKey: accountKey, nonce: nonce + 1n, receiverId, blockHash: await chainClient.blockHash(true), actions });
  } catch (error) {
    popup.close();
    throw error;
  }
  const token = await approve(auth, popup, payload, "transaction");
  const { signature } = await post<{ signature: string }>("/api/relay/sign", { token, payload: toBase64(payload) });
  const { hash, bytes } = withSignature(payload, fromBase64(signature), accountKey);
  return chainClient.broadcast(bytes, hash, accountId);
}
