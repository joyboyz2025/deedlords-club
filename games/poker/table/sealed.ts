// What a house seat thought when it bet, kept from the table until the hand is over.
//
// A model's sentence for a bet names what it holds ("pocket kings, 83 percent"). Shown at once, it deals the house's
// cards to the seat it is playing against, so the server never sends it during the hand. It sends it sealed instead:
// encrypted under a key only the server has (made from the house account's own secret), with the table and the hand
// written inside. The page keeps the sealed note and hands it back when the hand is over; the server opens it only
// after reading on chain that this hand is over (house.ts `openThought`). Nothing is stored between requests, so it
// works on a host that keeps nothing.

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

export type Thought = { id: string; hand: number; seat: number; what: string; reason: string; driver?: string };

const IV = 12;
const TAG = 16;
/** A sentence of 140 characters seals to about 400: anything much longer is not one of ours. */
export const MAX_SEALED = 2_000;

const keyOf = (secret: string): Buffer => createHmac("sha256", secret).update("deedlords poker: what a house seat thought").digest();

/** `thought`, readable only with `secret`: base64url of nonce ‖ tag ‖ AES-256-GCM of its JSON. */
export function sealThought(secret: string, thought: Thought): string {
  const iv = randomBytes(IV);
  const cipher = createCipheriv("aes-256-gcm", keyOf(secret), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(thought), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

/** The thought in `sealed`, or `null` when it was not sealed with `secret` or was changed on the way. */
export function readThought(secret: string, sealed: string): Thought | null {
  if (sealed.length > MAX_SEALED) return null;
  try {
    const raw = Buffer.from(sealed, "base64url");
    if (raw.length <= IV + TAG) return null;
    const decipher = createDecipheriv("aes-256-gcm", keyOf(secret), raw.subarray(0, IV));
    decipher.setAuthTag(raw.subarray(IV, IV + TAG));
    const thought = JSON.parse(Buffer.concat([decipher.update(raw.subarray(IV + TAG)), decipher.final()]).toString("utf8")) as Partial<Thought> | null;
    if (
      !thought ||
      typeof thought.id !== "string" ||
      typeof thought.hand !== "number" ||
      typeof thought.seat !== "number" ||
      typeof thought.what !== "string" ||
      typeof thought.reason !== "string"
    )
      return null;
    return {
      id: thought.id,
      hand: thought.hand,
      seat: thought.seat,
      what: thought.what,
      reason: thought.reason,
      ...(typeof thought.driver === "string" ? { driver: thought.driver } : {}),
    };
  } catch {
    return null;
  }
}

/** Whether the hand a thought was sealed in is over at a table seen as `view` (`null`: the table is closed). */
export const handIsOver = (view: { hand: number; phase: string } | null, hand: number): boolean => !view || view.hand > hand || view.phase === "lobby";
