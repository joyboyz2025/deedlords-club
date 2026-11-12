"use client";

import type { CSSProperties } from "react";
import { shortAccount } from "../../co-ty-phu/chain/adapt";
import type { Character } from "../chain";
import { useCharacter, useLookPicture } from "../useChibi";

// An account as a table shows it: its character's face and name, or its short id while it has no character. For any
// game of the hall: `<CharacterTag accountId="…" />`, or `useCharacters` and `useLookPictures` for a whole table.

/** A character's face in a circle (`size` px). Without a character, or before it is drawn, `fallback` stands there. */
export function ChibiFace({ character, size = 40, fallback = null }: { character: Character | null | undefined; size?: number; fallback?: string | null }) {
  const picture = useLookPicture(character?.look, Math.max(96, size * 2));
  return (
    <span className="cb-face" style={{ "--size": `${size}px` } as CSSProperties} aria-hidden="true">
      {picture ? <img src={picture} alt="" /> : <b>{fallback ?? (character ? character.name.slice(0, 1) : "?")}</b>}
    </span>
  );
}

export function CharacterTag({ accountId, size = 32, you = false }: { accountId: string; size?: number; you?: boolean }) {
  const character = useCharacter(accountId);
  const name = character?.name ?? shortAccount(accountId);
  return (
    <span className="cb-tag" title={accountId}>
      <ChibiFace character={character} size={size} fallback={name.slice(0, 1).toUpperCase()} />
      <span>
        {name}
        {you && " (you)"}
      </span>
    </span>
  );
}
