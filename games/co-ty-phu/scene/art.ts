// Ảnh minh họa của bàn cờ: khu phố giữa bàn, bốn ô góc, hai bộ thẻ, và cúp. Tệp nằm trong `public/board`,
// cắt nền và thu nhỏ bằng `_notes/concepts/cut.py`. Tải không được thì bàn vẫn vẽ bằng nét như trước.

import type { Deck } from "../board";

const BASE = "/board";

export type CornerKind = "start" | "jail" | "rest" | "arrest";

export type BoardArt = {
  centre: HTMLImageElement;
  corners: Record<CornerKind, HTMLImageElement>;
  decks: Record<Deck, HTMLImageElement>;
};

/** Ảnh thẻ và cúp dùng lại ở giao diện ngoài bàn. */
export const DECK_ART: Record<Deck, string> = { chance: `${BASE}/deck-alert.webp`, chest: `${BASE}/deck-souvenir.webp` };
export const TROPHY_ART = `${BASE}/trophy.webp`;

function load(name: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.decoding = "async";
  image.src = `${BASE}/${name}.webp`;
  return image.decode().then(() => image);
}

let loading: Promise<BoardArt | null> | null = null;

/** Tải một lần cho cả trang; mở bàn khác thì dùng lại. `null`: tải không được. */
export function loadBoardArt(): Promise<BoardArt | null> {
  loading ??= Promise.all([
    load("centre"),
    load("corner-departure"),
    load("corner-customs"),
    load("corner-transit"),
    load("corner-denied"),
    load("deck-alert"),
    load("deck-souvenir"),
  ]).then(
    ([centre, start, jail, rest, arrest, chance, chest]) => ({ centre, corners: { start, jail, rest, arrest }, decks: { chance, chest } }),
    () => {
      // Lần sau thử lại, kẻo một lần rớt mạng thì cả phiên không có ảnh.
      loading = null;
      return null;
    },
  );
  return loading;
}
