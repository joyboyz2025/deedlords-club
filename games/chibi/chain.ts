// The browser's side of the chibi contract (contracts/chibi): reading characters, bags and the box, and the calls.
// Free things (a character, a basic item, dressing up) are signed here with the account's key and made by the server's
// sponsor (/api/chibi). A box is bought with the account's own NEAR, signed the way this player signs a stake.

import { CHAIN } from "../../lib/chain/config.ts";
import { chainClient } from "../../lib/chain/shared.ts";
import { type FunctionCall, jsonArgs } from "../../lib/chain/transaction.ts";
import { cleanLook, type Look } from "../ma-soi/look.ts";
import { itemOfToken, type CatalogItem } from "./catalog.ts";
import { forget, knownEntry, remember, type KnownCharacter } from "./known.ts";
import { signRequest, type ChibiRequest, type Outfit, type Signer } from "./proof.ts";

export type Character = KnownCharacter;
export type ItemToken = CatalogItem & { tokenId: string };
export type BoxInfo = { price: bigint; rareBp: number; epicBp: number; legendaryBp: number; epicPity: number; legendaryPity: number };
export type BoxCount = { opened: number; sinceEpic: number; sinceLegendary: number };
export type BoxOpened = { tokenId: string; part: string; index: number; rarity: number; name: string };

const view = <T>(method: string, args: unknown = {}) => chainClient.viewOf<T>(CHAIN.chibiId, method, args);

/** A box burns about 7 Tgas; the account must hold about 0.001 NEAR for every Tgas attached. */
export const BOX_GAS = 30_000_000_000_000n;
const READ_TTL_MS = 60_000;
const BATCH = 50;

function cleanCharacter(value: unknown): Character | null {
  if (typeof value !== "object" || value === null) return null;
  const { accountId, tokenId, name, look, worn } = value as Record<string, unknown>;
  const clean = cleanLook(look);
  if (typeof accountId !== "string" || typeof tokenId !== "string" || typeof name !== "string" || !clean) return null;
  return { accountId, tokenId, name, look: clean, worn: typeof worn === "object" && worn !== null ? (worn as Record<string, string>) : {} };
}

// ----- characters, cached: every table of the hall asks for the same few accounts -----

const listeners = new Set<() => void>();

/** Called whenever a character read here changed (made, dressed): the hooks read again. */
export function onCharactersChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Forgets what was read of an account (after it changed), or keeps `now` for it, and tells everyone listening. */
export function forgetCharacter(accountId: string, now?: Character | null): void {
  if (now === undefined) forget(accountId);
  else remember(accountId, now);
  for (const listener of listeners) listener();
}

/**
 * The characters of these accounts (`null`: none yet), read from the chain at most once a minute each. An account
 * that cannot be read (the node did not answer) is left out of the answer.
 */
export async function readCharacters(accountIds: readonly string[]): Promise<Map<string, Character | null>> {
  const answer = new Map<string, Character | null>();
  const stale: string[] = [];
  for (const id of new Set(accountIds)) {
    const hit = knownEntry(id);
    if (hit && Date.now() - hit.at < READ_TTL_MS) answer.set(id, hit.character);
    else stale.push(id);
  }
  for (let from = 0; from < stale.length; from += BATCH) {
    const ids = stale.slice(from, from + BATCH);
    try {
      const read = await view<unknown[]>("characters_of", { account_ids: ids });
      ids.forEach((id, i) => {
        const character = cleanCharacter(read[i]);
        remember(id, character);
        answer.set(id, character);
      });
    } catch {
      // Not now: whoever asked shows the account as it is, and asks again later.
    }
  }
  return answer;
}

export async function readCharacter(accountId: string): Promise<Character | null> {
  const read = await readCharacters([accountId]);
  if (!read.has(accountId)) throw new Error(`cannot read ${CHAIN.chibiId}`);
  return read.get(accountId) ?? null;
}

// ----- the bag, the shop, the box -----

type RawToken = { token_id: string; owner_id: string };

/** Every item token the account holds (not its character), in the order minted. */
export async function readBag(accountId: string): Promise<ItemToken[]> {
  const items: ItemToken[] = [];
  for (let from = 0; from < 2_000; from += 100) {
    const page = await view<RawToken[]>("nft_tokens_for_owner", { account_id: accountId, from_index: String(from), limit: 100 });
    for (const token of page) {
      const item = itemOfToken(token.token_id);
      if (item) items.push({ ...item, tokenId: token.token_id });
    }
    if (page.length < 100) break;
  }
  return items;
}

/** The basic kinds (`hat:4`) the account already took, out of `kinds`. */
export async function readClaimed(accountId: string, kinds: readonly string[]): Promise<Set<string>> {
  const taken = new Set<string>();
  for (let from = 0; from < kinds.length; from += 200) {
    const part = kinds.slice(from, from + 200);
    const read = await view<boolean[]>("claimed_of", { account_id: accountId, kinds: part });
    part.forEach((kind, i) => read[i] && taken.add(kind));
  }
  return taken;
}

export async function readBoxInfo(): Promise<BoxInfo> {
  const info = await view<{ price: string; rareBp: number; epicBp: number; legendaryBp: number; epicPity: number; legendaryPity: number }>("box_info");
  return { ...info, price: BigInt(info.price) };
}

export const readBoxCount = (accountId: string): Promise<BoxCount> => view<BoxCount>("box_count_of", { account_id: accountId });

export const isNameTaken = (name: string): Promise<boolean> => view<boolean>("name_taken", { name });

// ----- calls -----

async function askSponsor(signer: Signer, request: ChibiRequest): Promise<unknown> {
  const signed = signRequest(signer, { contract: CHAIN.chibiId, network: CHAIN.network }, request);
  const response = await fetch("/api/chibi", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signed) });
  const answer = (await response.json().catch(() => ({}))) as { value?: unknown; error?: string };
  if (!response.ok) throw new Error(answer.error ?? `the server answered ${response.status}`);
  return answer.value;
}

/** Makes this account's character, free: the sponsor mints it and the basic items it wears. */
export async function createCharacter(signer: Signer, name: string, look: Look): Promise<Character> {
  const made = cleanCharacter(await askSponsor(signer, { action: "create", name, look }));
  if (!made) throw new Error("the character was made but could not be read back: reload the page");
  forgetCharacter(signer.accountId, made);
  return made;
}

/** Takes one basic item, free. Resolves to its token id. */
export async function claimItem(signer: Signer, part: CatalogItem["part"], index: number): Promise<string> {
  return String(await askSponsor(signer, { action: "claim", part, index }));
}

/** Dresses the character, free. */
export async function equip(signer: Signer, outfit: Outfit): Promise<Character> {
  const dressed = cleanCharacter(await askSponsor(signer, { action: "equip", outfit }));
  if (!dressed) throw new Error("dressed, but could not be read back: reload the page");
  forgetCharacter(signer.accountId, dressed);
  return dressed;
}

/** The call that buys one box at `price`. */
export const boxCall = (price: bigint): FunctionCall => ({ method: "buy_box", args: jsonArgs({}), gas: BOX_GAS, deposit: price });

/** What a box returned, or `null` when the way it was sent does not say (a NEAR wallet): read the bag instead. */
export function boxOpened(value: unknown): BoxOpened | null {
  if (typeof value !== "object" || value === null) return null;
  const { tokenId, part, index, rarity, name } = value as Record<string, unknown>;
  return typeof tokenId === "string" && typeof part === "string" && typeof index === "number" && typeof rarity === "number" && typeof name === "string"
    ? { tokenId, part, index, rarity, name }
    : null;
}

/** The outfit a character wears now, as `equip` takes it, with `change` applied. */
export function outfitOf(
  character: Character,
  change: { traits?: Partial<Pick<Look, "body" | "skin" | "hairColor" | "robe">>; worn?: Record<string, string | null> } = {},
): Outfit {
  const worn: Record<string, string | null> = { ...character.worn, ...(change.worn ?? {}) };
  const traits = { body: character.look.body, skin: character.look.skin, hairColor: character.look.hairColor, robe: character.look.robe, ...(change.traits ?? {}) };
  return { ...traits, worn: Object.values(worn).filter((id): id is string => typeof id === "string") };
}
