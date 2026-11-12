// The chibi characters this page has read, by account: what the tables show in place of an account's id. Pure (no
// reading here: games/chibi/chain.ts fills it), so the match adapter, which also runs in tests, can look names up.

import type { Look } from "../ma-soi/look.ts";

export type KnownCharacter = { accountId: string; tokenId: string; name: string; look: Look; worn: Record<string, string> };

const known = new Map<string, { at: number; character: KnownCharacter | null }>();

/** What was read of an account and when: `undefined` when never read, `character: null` when it has none. */
export const knownEntry = (accountId: string): { at: number; character: KnownCharacter | null } | undefined => known.get(accountId);

/** The character of an account, if this page has read one. */
export const characterOf = (accountId: string | null | undefined): KnownCharacter | null => (accountId ? (known.get(accountId)?.character ?? null) : null);

export function remember(accountId: string, character: KnownCharacter | null, at = Date.now()): void {
  known.set(accountId, { at, character });
}

export function forget(accountId: string): void {
  known.delete(accountId);
}
