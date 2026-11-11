// What an agent is told before it plans a turn: the seat's own position and money, what the next roll can land on and
// with what chance, what it owns and what a house there would earn, and where the others stand. Built from the
// contract's answer with the reference engine, so every number is one the rules would produce. No account names go in:
// seats are numbers, squares are the board's own names.

import { JAIL_FINE, SQUARES, cityRents, houseCost, isOwnable } from "../board.ts";
import { netWorth, rentFor, type Game } from "../engine.ts";
import { toGame } from "../chain/adapt.ts";
import type { ChainMatch } from "../chain/types.ts";

/** Chance of each total of two dice, 2 to 12. */
export const diceChance = (total: number): number => (total < 2 || total > 12 ? 0 : (6 - Math.abs(7 - total)) / 36);
/** A token lands on a given square about this often per turn once it has gone round (doubles roll again). */
const LANDING_PER_TURN = 0.028;
/** The total a utility's rent is worked out with here: the likeliest one. */
const TYPICAL_ROLL = 7;

export type Reach = {
  steps: number;
  square: number;
  name: string;
  /** Chance that this roll ends there. */
  chance: number;
  /** `rent`: somebody else's, you pay `amount`. `free`: for sale at `amount`. `tax`: you pay `amount`. */
  what: "rent" | "free" | "yours" | "tax" | "card" | "arrest" | "nothing";
  amount: number;
};

export type Holding = {
  square: number;
  name: string;
  kind: "city" | "station" | "utility";
  houses: number;
  mortgaged: boolean;
  /** What a visitor pays now. */
  rent: number;
  /** Cities only: what the next house costs and what a visitor would pay with it; `null` on a hotel. */
  houseCost: number | null;
  rentWithHouse: number | null;
  /** How many times the others are expected to land here before the game ends. */
  visits: number;
};

export type Rival = { seat: number; cash: number; netWorth: number; position: number; inCustody: boolean };

export type Brief = {
  seat: number;
  cash: number;
  netWorth: number;
  position: number;
  square: string;
  inCustody: boolean;
  releaseCards: number;
  fine: number;
  salary: number;
  blitz: boolean;
  /** Turns this seat still has, this one included. `null`: the game has no round limit. */
  turnsLeft: number | null;
  /** The largest rent this seat could owe on the squares within two rolls (2 to 24 steps). */
  threat: { amount: number; square: number; name: string; steps: number } | null;
  reach: Reach[];
  holdings: Holding[];
  rivals: Rival[];
  /** Squares still for sale on the whole board. */
  forSale: number;
};

const round2 = (value: number) => Math.round(value * 100) / 100;

function seatOfPlayer(match: ChainMatch, playerId: string): number {
  return match.meta.seats.find((seat) => seat.player === playerId)?.seat ?? -1;
}

/** What `playerId` would pay landing on `index` now. Utilities are worked out with the likeliest total. */
function rentTo(game: Game, playerId: string, index: number, total = TYPICAL_ROLL): number {
  const owned = game.props[index];
  return owned && owned.owner !== playerId ? rentFor(game, index, total) : 0;
}

/** `null` when `seat` is not a player of a game in progress. */
export function briefFor(match: ChainMatch, seat: number): Brief | null {
  const game = toGame(match);
  const playerId = match.meta.seats[seat]?.player;
  const me = game.players.find((player) => player.id === playerId);
  if (game.phase !== "playing" || !playerId || !me || me.bankrupt) return null;
  const size = SQUARES.length;
  const others = game.players.filter((player) => player.id !== playerId && !player.bankrupt);
  const maxRounds = match.meta.rules.maxRounds;
  const turnsLeft = maxRounds > 0 ? Math.max(1, maxRounds - game.round) : null;
  // Turns the others still have after this seat's: the same count, less one for those who move before it in a round.
  const laterTurns = turnsLeft === null ? 12 : turnsLeft;

  const reach: Reach[] = [];
  for (let steps = 2; steps <= 12; steps++) {
    const index = (me.position + steps) % size;
    const square = SQUARES[index];
    const owned = game.props[index];
    let what: Reach["what"] = "nothing";
    let amount = 0;
    if (isOwnable(square)) {
      if (!owned) [what, amount] = ["free", square.price];
      else if (owned.owner === playerId) what = "yours";
      else [what, amount] = ["rent", rentTo(game, playerId, index, steps)];
    } else if (square.kind === "tax") [what, amount] = ["tax", square.amount];
    else if (square.kind === "card") what = "card";
    else if (square.kind === "arrest") what = "arrest";
    reach.push({ steps, square: index, name: square.name, chance: round2(diceChance(steps)), what, amount });
  }

  let threat: Brief["threat"] = null;
  for (let steps = 2; steps <= 24; steps++) {
    const index = (me.position + steps) % size;
    const amount = rentTo(game, playerId, index, Math.min(steps, 12));
    if (amount > (threat?.amount ?? 0)) threat = { amount, square: index, name: SQUARES[index].name, steps };
  }

  const holdings: Holding[] = [];
  for (const [key, owned] of Object.entries(game.props)) {
    const index = Number(key);
    const square = SQUARES[index];
    if (owned.owner !== playerId || !isOwnable(square)) continue;
    const city = square.kind === "city";
    const canGrow = city && !owned.mortgaged && owned.houses < 5;
    // Each of the others: the chance of their next roll, then the long-run rate for the turns after it.
    const visits = others.reduce((sum, other) => {
      const steps = (index - other.position + size) % size;
      return sum + (other.jail === null ? diceChance(steps) : 0) + Math.max(0, laterTurns - 1) * LANDING_PER_TURN;
    }, 0);
    holdings.push({
      square: index,
      name: square.name,
      kind: square.kind,
      houses: owned.houses,
      mortgaged: owned.mortgaged,
      rent: rentFor(game, index, TYPICAL_ROLL),
      houseCost: canGrow ? houseCost(index) : null,
      rentWithHouse: canGrow ? cityRents(square.price)[owned.houses + 1] : null,
      visits: round2(visits),
    });
  }
  holdings.sort((a, b) => a.square - b.square);

  return {
    seat,
    cash: me.cash,
    netWorth: netWorth(game, playerId),
    position: me.position,
    square: SQUARES[me.position].name,
    inCustody: me.jail !== null,
    releaseCards: me.freeCards.length,
    fine: JAIL_FINE,
    salary: match.meta.rules.salary,
    blitz: match.meta.rules.blitz,
    turnsLeft,
    threat,
    reach,
    holdings,
    rivals: others.map((other) => ({
      seat: seatOfPlayer(match, other.id),
      cash: other.cash,
      netWorth: netWorth(game, other.id),
      position: other.position,
      inCustody: other.jail !== null,
    })),
    forSale: SQUARES.filter((square, index) => isOwnable(square) && !game.props[index]).length,
  };
}
