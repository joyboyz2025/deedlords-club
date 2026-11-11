"use client";

// The deck of Deedlords Poker, drawn in the page: faces cut from cream stock with pips in red ink and ink, court cards
// set in the slab face, and a red back with a gold lattice (public/poker/card-back.svg). A card sizes everything inside
// it from its own width, so the same card serves a phone and a desk.

import { type CSSProperties, useLayoutEffect, useRef } from "react";

export const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"] as const;
const RANK_WORDS = ["two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "jack", "queen", "king", "ace"];
/** Suits in the contract's order. */
const SUITS = ["clubs", "diamonds", "hearts", "spades"] as const;

/** The four suits on a 24 by 24 grid. */
function SuitShape({ suit }: { suit: number }) {
  if (suit === 0) {
    return (
      <>
        <circle cx="12" cy="7.2" r="4.3" />
        <circle cx="6.9" cy="13.6" r="4.3" />
        <circle cx="17.1" cy="13.6" r="4.3" />
        <circle cx="12" cy="12" r="2.6" />
        <path d="M12 11.5c0 4.2-.7 7.3-2.6 10h5.200c-1.900-2.700-2.600-5.800-2.600-10Z" />
      </>
    );
  }
  if (suit === 1) return <path d="M12 1.800c1.700 3.900 4.100 7.300 7.200 10.200-3.100 2.900-5.500 6.300-7.200 10.200C10.300 18.300 7.900 14.900 4.800 12 7.900 9.100 10.300 5.700 12 1.800Z" />;
  if (suit === 2) return <path d="M12 21.300S4.400 16.600 2.600 11.500C1.300 7.700 3.500 4 7 4c2 0 3.800 1.100 5 3 1.200-1.900 3-3 5-3 3.500 0 5.700 3.700 4.400 7.500C19.600 16.600 12 21.300 12 21.300Z" />;
  return <path d="M12 2c-1.700 3.500-4.400 5.700-6.700 8.100-2.200 2.300-2.300 6 1.300 6.800 1.800.4 3.400-.4 4.400-1.800-.2 2.400-.9 4.300-2.200 5.900h6.400c-1.300-1.600-2-3.500-2.200-5.900 1 1.400 2.600 2.200 4.400 1.800 3.600-.8 3.500-4.500 1.300-6.800C16.400 7.700 13.700 5.500 12 2Z" />;
}

export const Suit = ({ suit, className }: { suit: number; className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <SuitShape suit={suit} />
  </svg>
);

/** Where the pips of a number card sit: [column, row] with columns 0 to 2 and rows 0 (top) to 1 (bottom). */
const COLUMN = [31, 50, 69];
const PIPS: Record<number, [number, number][]> = {
  0: [[1, 0], [1, 1]],
  1: [[1, 0], [1, 0.5], [1, 1]],
  2: [[0, 0], [2, 0], [0, 1], [2, 1]],
  3: [[0, 0], [2, 0], [1, 0.5], [0, 1], [2, 1]],
  4: [[0, 0], [2, 0], [0, 0.5], [2, 0.5], [0, 1], [2, 1]],
  5: [[0, 0], [2, 0], [1, 0.25], [0, 0.5], [2, 0.5], [0, 1], [2, 1]],
  6: [[0, 0], [2, 0], [1, 0.25], [0, 0.5], [2, 0.5], [1, 0.75], [0, 1], [2, 1]],
  7: [[0, 0], [2, 0], [0, 1 / 3], [2, 1 / 3], [1, 0.5], [0, 2 / 3], [2, 2 / 3], [0, 1], [2, 1]],
  8: [[0, 0], [2, 0], [1, 1 / 6], [0, 1 / 3], [2, 1 / 3], [0, 2 / 3], [2, 2 / 3], [1, 5 / 6], [0, 1], [2, 1]],
};

function Face({ card }: { card: number }) {
  const rank = card % 13;
  const suit = Math.floor(card / 13);
  const index = (
    <>
      <b>{RANKS[rank]}</b>
      <Suit suit={suit} />
    </>
  );
  return (
    <span className="pk-card__face" data-red={suit === 1 || suit === 2 || undefined} data-court={(rank >= 9 && rank <= 11) || undefined}>
      <span className="pk-card__index">{index}</span>
      <span className="pk-card__index pk-card__index--low" aria-hidden="true">
        {index}
      </span>
      {rank <= 8 ? (
        <span className="pk-card__pips">
          {PIPS[rank].map(([column, row], at) => (
            <i key={at} data-low={row > 0.5 || undefined} style={{ left: `${COLUMN[column]}%`, top: `${row * 100}%` }}>
              <Suit suit={suit} />
            </i>
          ))}
        </span>
      ) : rank === 12 ? (
        <span className="pk-card__ace">
          <Suit suit={suit} />
        </span>
      ) : (
        <span className="pk-card__court">
          <b>{RANKS[rank]}</b>
          <Suit suit={suit} />
          <b aria-hidden="true">{RANKS[rank]}</b>
          <Suit suit={suit} />
        </span>
      )}
      {/* On a card too small for its pips: one large suit under the index. */}
      <span className="pk-card__big">
        <Suit suit={suit} />
      </span>
    </span>
  );
}

export const cardName = (card: number | null | undefined): string =>
  card === undefined ? "a card face down" : card === null ? "no card: this position did not decrypt" : `${RANK_WORDS[card % 13]} of ${SUITS[Math.floor(card / 13)]}`;

export type Mark = { seat: number; given: boolean };

/**
 * One playing card. `undefined` lies face down, `null` is a deck position that decrypted to no card. A card that is
 * `dealt` travels in from the deck of its table when it is first drawn; one that learns its face turns over.
 * `marks` are the two seats' decryption shares for a card still face down.
 */
export function PlayingCard({ card, dealt = false, order = 0, marks, dim = false, lit = false }: { card: number | null | undefined; dealt?: boolean; order?: number; marks?: Mark[]; dim?: boolean; lit?: boolean }) {
  const element = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const self = element.current;
    if (!dealt || !self || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const deck = self.closest(".pk-table")?.querySelector("[data-pk-deck]");
    if (!deck) return;
    const from = deck.getBoundingClientRect();
    const to = self.getBoundingClientRect();
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    const scale = from.width / Math.max(1, to.width);
    self.animate(
      [{ transform: `translate(${dx}px, ${dy}px) rotate(-14deg) scale(${scale})` }, { transform: "translate(0, 0) rotate(0deg) scale(1)" }],
      { duration: 560, delay: order * 110, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "backwards" },
    );
    // Only when the card is first drawn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const up = typeof card === "number";
  return (
    <span ref={element} className="pk-card" role="img" aria-label={cardName(card)} data-up={up || undefined} data-void={card === null || undefined} data-dim={dim || undefined} data-lit={lit || undefined}>
      <span className="pk-card__turn">
        <span className="pk-card__back">
          {card === null && <b>no card</b>}
          {card === undefined && marks && (
            <span className="pk-card__marks">
              {marks.map((mark) => (
                <i key={mark.seat} data-given={mark.given || undefined} style={{ "--seat": `var(--seat-${mark.seat})` } as CSSProperties} />
              ))}
            </span>
          )}
        </span>
        {up && <Face card={card} />}
      </span>
    </span>
  );
}

/** An empty place for a card: a dashed outline, as everything that is not there yet. */
export const CardPlace = () => <span className="pk-card pk-card--place" aria-hidden="true" />;
