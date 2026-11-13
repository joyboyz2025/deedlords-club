// Which account this browser plays poker as.
//
// Poker signs every step of a hand (a shuffle with its proof, the shares of a card, a bet) with a full-access key kept
// in the browser, so that no wallet prompt stops a hand. The club's game accounts have such a key: a guest's, and the
// one made from an EVM wallet's signature. Two kinds of club account do not: a NEAR wallet account (its key stays in
// the wallet) and a Google account (this browser holds a key that may only move a seat in the board game's contract).
// For those, poker is played with a game account of its own, kept beside the club account: signing in to the club
// with a wallet or with Google is not lost, and the board game goes on using it.

import { implicitAccountId } from "@/lib/chain/evmKey";
import { generateKeyPair, secretKeyText } from "@/lib/chain/keys";
import { readStored, writeStored } from "@/lib/storage";
import { exportGameKey, openKeySession } from "../co-ty-phu/chain/keySession";

const STORE = "deedlords:poker-account";
type Stored = { accountId: string; secretKey: string };

/** `apart`: a game account kept for poker alone, beside a club account that cannot sign a hand. */
export type PokerAccount = { accountId: string; secretKey: string; apart: boolean };

/** The account that signs at the poker tables, or `null` when this browser has none yet. */
export function pokerAccount(): PokerAccount | null {
  const club = openKeySession();
  const key = club && club.source !== "google" ? exportGameKey() : null;
  if (club && key) return { accountId: club.accountId, secretKey: key, apart: false };
  const kept = readStored<Stored>(STORE);
  return kept ? { ...kept, apart: true } : null;
}

/** Makes the game account poker is played with, for a club account that cannot sign a hand. Its key stays here. */
export function makePokerAccount(): void {
  if (readStored<Stored>(STORE)) return;
  const pair = generateKeyPair();
  writeStored(STORE, { accountId: implicitAccountId(pair.publicKey), secretKey: secretKeyText(pair) } satisfies Stored);
}
