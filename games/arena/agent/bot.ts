// The rule bot: a plan for one round from a playbook of four numbers. It is the default driver of an AI seat, the
// executor behind a language model's choices, and both sides of a sparring match.

import { C, UNITS } from "../data.ts";
import { CELLS, COLS, ROWS, WON, teamCap, type Match, type Plan, type Ref } from "../engine.ts";

export type Playbook = {
  /** Gold added on top of the cost when bidding for the unit it wants most. */
  overbid: number;
  /** Gold it tries to keep at the end of a round, for the interest. Ignored in the last round. */
  reserve: number;
  /** A guild and a role it leans towards, or -1. */
  guild: number;
  role: number;
};
export const DEFAULT_PLAYBOOK: Playbook = { overbid: 1, reserve: 0, guild: -1, role: -1 };

// Cells of the front row and of the back row, the middle column first.
const MIDDLE_OUT = [3, 2, 4, 1, 5, 0, 6];
const FRONT = MIDDLE_OUT;
const BACK = MIDDLE_OUT.map((col) => (ROWS - 1) * COLS + col);

export function planFor(match: Match, seat: number, book: Playbook = DEFAULT_PLAYBOOK): Plan {
  const me = match.seats[seat];
  const worth = (unit: number): number => {
    const def = UNITS[unit];
    const kin = me.pieces.filter((piece) => piece.unit !== unit);
    return def.cost * 10 + (def.guild === book.guild ? 8 : 0) + (def.role === book.role ? 6 : 0) + 4 * kin.filter((piece) => UNITS[piece.unit].guild === def.guild).length + 3 * kin.filter((piece) => UNITS[piece.unit].role === def.role).length;
  };
  const power = (unit: number, rank: number): number => UNITS[unit].cost * C.rankPercent[rank - 1];

  const slots = match.market.map((unit, slot) => ({ unit, slot })).sort((a, b) => worth(b.unit) - worth(a.unit) || a.slot - b.slot);
  let room = teamCap(match.round) + C.benchSize - me.pieces.length;
  let budget = Math.max(0, me.gold - (match.round < match.rounds ? book.reserve : 0));
  const sells: number[] = [];
  const weakest = [...me.pieces].sort((a, b) => power(a.unit, a.rank) - power(b.unit, b.rank) || a.id - b.id)[0];
  if (room === 0 && weakest && weakest.rank === 1 && worth(slots[0].unit) > worth(weakest.unit)) {
    sells.push(weakest.id);
    room++;
    budget += UNITS[weakest.unit].cost;
  }

  const bids = match.market.map(() => 0);
  for (const [index, { unit, slot }] of slots.entries()) {
    const bid = UNITS[unit].cost + (index === 0 ? book.overbid : 0);
    if (room === 0 || bid > budget) continue;
    bids[slot] = bid;
    budget -= bid;
    room--;
  }

  const kept = me.pieces.filter((piece) => !sells.includes(piece.id));
  const promotes: Ref[] = [];
  const best = [...kept].sort((a, b) => power(b.unit, b.rank) - power(a.unit, a.rank) || a.id - b.id)[0];
  if (best && best.rank < C.maxRank && UNITS[best.unit].cost * (best.rank + 1) <= budget) promotes.push(best.id);

  // Strongest first; melee to the front row, ranged to the back row, the middle column before the sides. A lost bid leaves its
  // cell to whoever comes later in the list with the same cell.
  const wanted = [
    ...kept.map((piece) => ({ ref: piece.id as Ref, unit: piece.unit, power: power(piece.unit, piece.rank) })),
    ...bids.flatMap((bid, slot) => (bid ? [{ ref: WON + slot, unit: match.market[slot], power: power(match.market[slot], 1) }] : [])),
  ].sort((a, b) => b.power - a.power || a.ref - b.ref);
  const free = new Set(Array.from({ length: CELLS }, (_, cell) => cell));
  const formation: [Ref, number][] = [];
  const spare: number[] = [];
  for (const { ref, unit } of wanted) {
    const order = UNITS[unit].ranged ? [...BACK, ...FRONT] : [...FRONT, ...BACK];
    const cell = order.find((c) => free.has(c)) ?? spare.shift();
    if (cell === undefined) continue;
    free.delete(cell);
    if (ref >= WON) spare.push(cell);
    formation.push([ref, cell]);
  }
  return { sells, bids, promotes, formation };
}
