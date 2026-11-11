// Bàn cờ và thẻ của Cờ tỷ phú. The data (world cities ranked by real prime property prices, English card texts) lives in `shared/board.json`, shared with
// the Rust engine in `contracts/`; this file re-exports it with types and keeps the formulas of docs/ENGINE-RULES.md §6.
// Pure data, used by both the server and the browser.

import board from "../../shared/board.json" with { type: "json" };

export const START_CASH: number = board.constants.startCash;
export const SALARY: number = board.constants.salary;
export const JAIL_FINE: number = board.constants.jailFine;
export const JAIL: number = board.constants.jail;
export const BOARD_SIZE: number = board.constants.boardSize;

/** Colour groups, cheapest first. */
export const GROUPS: { name: string; color: string }[] = board.groups;

/** Token colours by seat, shared by the 2D board, the 3D board and the player chips. */
export const TOKEN_COLORS: string[] = board.tokenColors;

export type Deck = "chance" | "chest";

/** Display name of each deck ("Travel Alert", "Souvenir"). */
export const DECK_NAMES: Record<Deck, string> = { chance: board.decks.chance.name, chest: board.decks.chest.name };

export type Square =
  | { kind: "start" | "jail" | "rest" | "arrest"; name: string; short: string }
  | { kind: "city"; name: string; short: string; group: number; price: number }
  | { kind: "station" | "utility"; name: string; short: string; price: number }
  | { kind: "tax"; name: string; short: string; amount: number; verb: string }
  | { kind: "card"; name: string; short: string; deck: Deck };

/** Clockwise from Departure. */
export const SQUARES: Square[] = board.squares as Square[];

export const isOwnable = (square: Square): square is Extract<Square, { price: number }> => "price" in square;

/** Each house costs 50 on the first side, 100 on the second, then 150 and 200. A hotel is the fifth house. */
export function houseCost(index: number): number {
  return 50 * (Math.floor(index / 10) + 1);
}

/** Rent multipliers in tenths of the price: bare, 1 to 4 houses, hotel. */
const RENT_TENTHS = [1, 5, 15, 30, 40, 50];

/**
 * City rent by number of houses: index 0 is the bare rent, 1 to 4 houses, 5 is a hotel. Integers only:
 * `floor((price * m + 25) / 50) * 5`, the same as rounding `price * m / 10` to the nearest 5.
 */
export function cityRents(price: number): number[] {
  return RENT_TENTHS.map((m) => Math.floor((price * m + 25) / 50) * 5);
}

export const STATION_RENTS: number[] = board.constants.stationRents;
export const UTILITY_TIMES: number[] = board.constants.utilityTimes;

export type CardEffect =
  | { kind: "money"; amount: number }
  | { kind: "goto"; to: number }
  | { kind: "back"; steps: number }
  | { kind: "nearest"; type: "station" | "utility" }
  | { kind: "jail" }
  | { kind: "free" }
  | { kind: "each"; amount: number }
  | { kind: "repairs"; house: number; hotel: number };

export type Card = { text: string; effect: CardEffect };

export const CARDS: Record<Deck, Card[]> = board.cards as Record<Deck, Card[]>;

/** Squares of a colour group, in board order. */
export function groupSquares(group: number): number[] {
  return SQUARES.flatMap((square, i) => (square.kind === "city" && square.group === group ? [i] : []));
}

/** Indexes of every ownable square (cities, stations, utilities), ascending. */
export const OWNABLE_SQUARES: number[] = SQUARES.flatMap((square, i) => (isOwnable(square) ? [i] : []));
