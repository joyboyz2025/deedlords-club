// NEAR Auth (auth.near.org, the relaunched FastAuth): a Google, email or passkey sign-in that stands for a NEAR
// account. Auth0 does the sign-in; the NEAR Auth contract checks Auth0's token on chain and has NEAR's MPC network
// sign with a key derived from the person's identity. Nobody holds that key: not this app, not the browser.
//
// Every signature is a trip through the sign-in page and a call somebody must pay for, so the game asks for exactly
// one: a grant that adds a function-call key kept in this browser (lib/chain/transaction.ts `KeyGrant`). After that
// the browser's key signs the moves like any other session key.
//
// This file is what the SDK (@fast-auth-near/browser-sdk 1.4.2) does, kept to the three facts the game needs: where
// to sign in, which path an identity signs under, and which contract to ask. Testnet only for now: mainnet needs the
// app to be approved (docs.auth.near.org/home/apply).

import { CHAIN } from "./config.ts";

export type NearAuth = {
  /** The Auth0 application that signs people in. A public value: it identifies the app, it is not a secret. */
  clientId: string;
  domain: string;
  /** The audience of a token that asks for a signature: the guard contract that will read it. */
  signingAudience: string;
  /** The contract that checks the token and asks the MPC network to sign. */
  contractId: string;
  mpcContractId: string;
  /** How the NEAR Auth contract names the guard for this sign-in service. */
  guardId: string;
};

const clientId = process.env.NEXT_PUBLIC_NEAR_AUTH_CLIENT_ID?.trim() ?? "";
const domain = process.env.NEXT_PUBLIC_NEAR_AUTH_DOMAIN?.trim() || "login.testnet.fast-auth.com";

/** `null`: no sign-in through NEAR Auth here (no client named, or a network it is not set up for). */
export const NEAR_AUTH: NearAuth | null =
  CHAIN.network === "testnet" && clientId
    ? {
        clientId,
        domain,
        signingAudience: "auth0.jwt.fast-auth.testnet",
        contractId: "fast-auth.testnet",
        mpcContractId: "v1.signer-prod.testnet",
        guardId: `jwt#https://${domain}/`,
      }
    : null;

/** The MPC network's ed25519 keys. */
export const MPC_ED25519_DOMAIN = 1;

/** The path the MPC network derives a person's key from: the guard, then who Auth0 says they are (`sub`). */
export const mpcPath = (auth: NearAuth, subject: string): string => `${auth.guardId}#${subject}`;

/**
 * The 64 bytes out of what the NEAR Auth contract's `sign` returned for an ed25519 request, `null` when it signed
 * nothing (the token was refused, or the MPC network did not answer). The network has answered in two shapes.
 */
export function ed25519Signature(value: unknown): Uint8Array | null {
  if (typeof value !== "object" || value === null) return null;
  const { signature, big_r: bigR, s } = value as { signature?: unknown; big_r?: { affine_point?: string }; s?: { scalar?: string } };
  if (Array.isArray(signature) && signature.length === 64 && signature.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255))
    return Uint8Array.from(signature as number[]);
  const hex = (text: string | undefined) => (text && /^(?:[0-9a-f]{2})+$/i.test(text) ? Uint8Array.from(text.match(/../g)!.map((pair) => Number.parseInt(pair, 16))) : null);
  const r = hex(bigR?.affine_point);
  const scalar = hex(s?.scalar);
  if (!r || !scalar || r.length < 32 || scalar.length !== 32) return null;
  return Uint8Array.from([...r.subarray(r.length - 32), ...scalar]);
}
