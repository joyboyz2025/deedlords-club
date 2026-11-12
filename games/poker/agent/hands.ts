// Poker hands for an agent that has to judge its own: the same ranking the contract pays by
// (contracts/poker/src/cards.rs), and the chance that two hole cards win against one unknown hand.
//
// A card is 0..51: its rank is `card % 13` (0 is a two, 12 an ace), its suit `Math.floor(card / 13)` in the order
// clubs, diamonds, hearts, spades. No imports, so node can load this file as it is.

export const CATEGORIES = ["high card", "a pair", "two pair", "three of a kind", "a straight", "a flush", "a full house", "four of a kind", "a straight flush"];

/** Strength of five cards: a higher number beats a lower one, equal numbers split. The category is `score >> 20`. */
export function rank5(cards: number[]): number {
  const ranks = cards.map((card) => card % 13).sort((a, b) => b - a);
  const flush = cards.every((card) => Math.floor(card / 13) === Math.floor(cards[0] / 13));
  // Groups of equal ranks as [count, rank], the biggest group first and then the highest rank.
  const groups: [number, number][] = [];
  for (const rank of ranks) {
    const last = groups[groups.length - 1];
    if (last && last[1] === rank) last[0] += 1;
    else groups.push([1, rank]);
  }
  groups.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const wheel = ranks.join() === "12,3,2,1,0";
  const straight = groups.length === 5 && (ranks[0] - ranks[4] === 4 || wheel);
  const [most, next] = [groups[0][0], groups[1]?.[0] ?? 0];
  const category = straight && flush ? 8 : most === 4 ? 7 : most === 3 && next === 2 ? 6 : flush ? 5 : straight ? 4 : most === 3 ? 3 : most === 2 && next === 2 ? 2 : most === 2 ? 1 : 0;
  // A straight is decided by its top card alone; in the wheel (A-2-3-4-5) that is the five.
  const ties = straight ? [wheel ? 3 : ranks[0]] : groups.map((group) => group[1]);
  return ties.reduce((score, rank) => score * 16 + rank, category) * 16 ** (5 - ties.length);
}

/** The best five of seven cards (or of six, or the five themselves). */
export function best(cards: number[]): number {
  if (cards.length === 5) return rank5(cards);
  let top = 0;
  for (let skip = 0; skip < cards.length; skip++) top = Math.max(top, best(cards.filter((_, index) => index !== skip)));
  return top;
}

/** What a seat holds right now, in words: "a pair", "a flush"... `null` before the flop. */
export const madeHand = (hole: number[], board: number[]): string | null => (board.length < 3 ? null : CATEGORIES[best([...hole, ...board]) >> 20]);

/**
 * The share of the pot `hole` expects against `opponents` hands it cannot see, on this `board`: the other hands and
 * the cards still to come are dealt at random `samples` times; a win counts 1, a tie its share of the split.
 */
export function winChance(hole: number[], board: number[], samples: number, random: () => number = Math.random, opponents = 1): number {
  const rest = Array.from({ length: 52 }, (_, card) => card).filter((card) => !hole.includes(card) && !board.includes(card));
  const need = 2 * opponents + 5 - board.length;
  let won = 0;
  for (let sample = 0; sample < samples; sample++) {
    // The first `need` places of a shuffle are enough.
    for (let i = 0; i < need; i++) {
      const j = i + Math.floor(random() * (rest.length - i));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    const table = [...board, ...rest.slice(2 * opponents, need)];
    const mine = best([...hole, ...table]);
    let tied = 0;
    for (let other = 0; other < opponents && tied >= 0; other++) {
      const theirs = best([rest[2 * other], rest[2 * other + 1], ...table]);
      tied = theirs > mine ? -1 : tied + Number(theirs === mine);
    }
    won += tied < 0 ? 0 : 1 / (tied + 1);
  }
  return won / samples;
}
