// Signing in with Google (or email, or a passkey) through NEAR Auth, for somebody with no wallet. See
// lib/chain/nearAuth.ts for what NEAR Auth is. Two windows, each opened by a click:
//
//   1. `identify`: the sign-in itself. It tells who the person is, and from that the NEAR account that is theirs: the
//      implicit account of the key NEAR's MPC network derives for them. Nothing is signed yet.
//   2. `confirmGrant`: the person approves one thing, a key grant: this browser gets a key that can only move a seat
//      in the game. The sponsor has NEAR Auth sign it and adds it to the account (/api/relay/session).
//
// After that the browser's key signs every move, and the sponsor relays it: no window, no wallet, no NEAR. The grant
// is asked for once per browser: signing out parks the key, signing in again finds it (keySession.ts).

import type { Auth0Client } from "@auth0/auth0-spa-js";
import { toBase64 } from "@/lib/chain/base58";
import { CHAIN } from "@/lib/chain/config";
import { implicitAccountId } from "@/lib/chain/evmKey";
import { generateKeyPair, type KeyPair, parsePublicKey, publicKeyText } from "@/lib/chain/keys";
import { MPC_ED25519_DOMAIN, mpcPath, NEAR_AUTH, type NearAuth } from "@/lib/chain/nearAuth";
import { chainClient } from "@/lib/chain/shared";
import { encodeKeyGrant } from "@/lib/chain/transaction";
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

/** Step 2, from a click: the person approves the grant, the sponsor has it signed and added, and this browser plays. */
export async function confirmGrant(pending: PendingGrant): Promise<void> {
  const auth = setUp();
  const popup = openWindow();
  let token: string;
  try {
    const client = await auth0(auth);
    // The payload rides in the request; the token that comes back names it, and the contract checks that it does.
    await client.loginWithPopup({ authorizationParams: { audience: auth.signingAudience, scope: "transaction:sign", delegateAction: Array.from(pending.payload) } }, { popup });
    // The window has just put the token in the library's cache; ask the cache first, so nothing has to reach Auth0 again.
    const cached = await client.getTokenSilently({ authorizationParams: { audience: auth.signingAudience, scope: "transaction:sign" }, cacheMode: "cache-only" });
    const issued = cached ?? (await client.getTokenSilently({ authorizationParams: { audience: auth.signingAudience } }));
    if (!issued) throw new Error("the approval gave no token");
    token = issued;
  } catch (error) {
    if (!popup.closed) popup.close();
    throw readable(error);
  }
  await post("/api/relay/session", { token, payload: toBase64(pending.payload) });
  const { accountId, label } = pending.identity;
  const session = chainClient.session(accountId, pending.sessionPair);
  for (let i = 0; i < 20 && !(await session.ready()); i++) await sleep(300);
  keepGoogleAccount(accountId, pending.sessionPair, label);
}
