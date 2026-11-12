"use client";

// Hooks for the chibi characters, for any page of the hall (and for Poker and the Arena, which may call them too):
// the characters of some accounts, a character's portrait, and buying a box the way the signed-in player signs.

import { useCallback, useEffect, useMemo, useState } from "react";
import { CHAIN } from "@/lib/chain/config";
import { sendWithNearAuth } from "../co-ty-phu/chain/googleSession";
import { approvesInWindow, type Player } from "../co-ty-phu/chain/usePlayer";
import { sendWithWallet } from "../co-ty-phu/chain/walletSession";
import { lookKey, type Look } from "../ma-soi/look";
import { boxCall, boxOpened, onCharactersChanged, readCharacters, type BoxOpened, type Character } from "./chain";

const REREAD_MS = 60_000;

/**
 * The characters of these accounts: a map with an entry once read (`null`: the account has none yet). Empty and
 * repeated ids are ignored. Reads again when a character changes on this page, and once a minute.
 */
export function useCharacters(accountIds: readonly (string | null | undefined)[]): Map<string, Character | null> {
  const key = [...new Set(accountIds.filter((id): id is string => typeof id === "string" && id.length > 0))].sort().join(",");
  const [read, setRead] = useState<Map<string, Character | null>>(() => new Map());
  useEffect(() => {
    if (!key) return;
    let stale = false;
    const ids = key.split(",");
    const load = () =>
      void readCharacters(ids).then((answer) => {
        if (!stale) setRead(answer);
      });
    load();
    const off = onCharactersChanged(load);
    const timer = setInterval(() => document.visibilityState !== "hidden" && load(), REREAD_MS);
    return () => {
      stale = true;
      off();
      clearInterval(timer);
    };
  }, [key]);
  return read;
}

/** One account's character: `undefined` while reading, `null` when it has none. */
export function useCharacter(accountId: string | null | undefined): Character | null | undefined {
  const read = useCharacters([accountId]);
  return accountId ? read.get(accountId) : null;
}

const drawn = new Map<string, Promise<string | null>>();

/**
 * Pictures of these looks, drawn by the same code as the 3D table (Three.js, loaded on demand): `portrait` is head and
 * shoulders, `figure` the whole body with a pet and a ride. `null` until drawn, and for a machine that cannot draw.
 */
export function useLookPictures(looks: readonly (Look | null | undefined)[], px = 160, kind: "portrait" | "figure" = "portrait"): (string | null)[] {
  const keys = looks.map((look) => (look ? `${kind}:${px}:${lookKey(look)}` : ""));
  const joined = keys.join("|");
  const [urls, setUrls] = useState<Map<string, string | null>>(() => new Map());
  useEffect(() => {
    let stale = false;
    const wanted = looks.flatMap((look, i) => (look ? [{ look, key: keys[i] }] : []));
    if (wanted.length === 0) return;
    import("../town/chibi-draw")
      .then(({ drawFigure, drawPortrait }) =>
        Promise.all(
          wanted.map(async ({ look, key }) => {
            let job = drawn.get(key);
            if (!job) {
              job = (kind === "figure" ? drawFigure(look, px) : drawPortrait(look, px)).catch(() => null);
              drawn.set(key, job);
            }
            const url = await job;
            if (!stale) setUrls((before) => (before.get(key) === url ? before : new Map(before).set(key, url)));
          }),
        ),
      )
      .catch(() => undefined);
    return () => {
      stale = true;
    };
    // `joined` stands for the looks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined, px, kind]);
  return useMemo(() => keys.map((key) => (key ? (urls.get(key) ?? null) : null)), [joined, urls]); // eslint-disable-line react-hooks/exhaustive-deps
}

export const useLookPicture = (look: Look | null | undefined, px = 160, kind: "portrait" | "figure" = "portrait"): string | null => useLookPictures([look], px, kind)[0];

/**
 * Buys one box with the player's own NEAR: a guest's or an EVM wallet's key signs it here, a Google account approves
 * it in the NEAR Auth window, a NEAR wallet in the wallet. Resolves to what came out, or `null` when the way it was
 * sent does not say (a wallet): the bag shows it.
 */
export async function buyBox(player: Player, price: bigint): Promise<BoxOpened | null> {
  const call = boxCall(price);
  if (approvesInWindow(player)) return boxOpened((await sendWithNearAuth(player.accountId, CHAIN.chibiId, [call])).value);
  if (player.via === "wallet") {
    await sendWithWallet(player.accountId, [call], CHAIN.chibiId);
    return null;
  }
  return boxOpened((await player.session.sendTo(CHAIN.chibiId, [call])).value);
}

/** Reloads on demand: a counter to put in an effect's dependencies. */
export function useReload(): [number, () => void] {
  const [round, setRound] = useState(0);
  return [round, useCallback(() => setRound((n) => n + 1), [])];
}
