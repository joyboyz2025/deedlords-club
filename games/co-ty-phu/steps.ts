// One state of the chain, cut into the rolls that made it.
//
// On chain an agent plays its whole turn in one transaction: a double and the roll after it, a card that sends the
// piece on. The state that comes back shows the last dice only, with the piece already where it ended, so the board
// threw 5+6 and the piece walked nineteen squares. From the rolls the contract logged (`trail`) the steps in between
// are rebuilt: for each roll its own dice and the square they lead to, and, when the piece did not stay where the last
// dice put it (a card, Customs), that square first and the real state after it (`step` 1: the same roll, a second
// leg). The screen shows them one at a time (TycoonScreen `useRollPace`). Whatever cannot be rebuilt with certainty
// is left as it came: the last state is always the chain's own.

import { BOARD_SIZE } from "./board.ts";
import type { View } from "./view.ts";

export type RollNote = { player: string; dice: [number, number] };
/** A view with what the pacing needs: the rolls the chain has logged, oldest first, and which leg of a roll this is. */
export type PacedView = View & { trail?: RollNote[]; step?: number };

/** What the board plays as one thing: a roll, or the second leg of one. */
export const beatOf = (view: PacedView): string => `${view.rolls}:${view.step ?? 0}`;

/** The most rolls one state is cut into: more than that and the page was away, not watching. */
const MOST = 6;

/** The states to show, in order, to get from `from` (what was shown last) to `to` (what the chain says now). Ends with `to`. */
export function rollSteps(from: PacedView, to: PacedView): PacedView[] {
  const made = to.rolls - from.rolls;
  const trail = to.trail ?? [];
  if (from.phase !== "playing" || to.phase !== "playing" || made < 1 || made > MOST || trail.length < made) return [to];
  const rolls = trail.slice(-made);
  const at = new Map(from.players.map((player) => [player.id, player.position]));
  const thrown = new Map<string, number>();
  const steps: PacedView[] = [];
  let players = from.players;
  for (const [i, { player, dice }] of rolls.entries()) {
    const before = from.players.find((one) => one.id === player);
    // The viewer's own rolls come one transaction each and are shown as they are. Somebody in Customs may not move at all.
    if (!before || player === to.you.id || before.jail !== null || before.bankrupt || before.color === null) return [to];
    const landing = ((at.get(player) ?? 0) + dice[0] + dice[1]) % BOARD_SIZE;
    at.set(player, landing);
    thrown.set(player, (thrown.get(player) ?? 0) + 1);
    players = players.map((one) => (one.id === player ? { ...one, position: landing } : one));
    steps.push({ ...from, players, dice, rolls: from.rolls + i + 1, current: player, card: null, autoInMs: null, step: 0 });
  }
  // Where the dice alone lead against where the chain says each thrower is.
  const elsewhere = (id: string) => {
    const now = to.players.find((one) => one.id === id);
    return !now || now.position !== at.get(id) || now.jail !== null;
  };
  const last = rolls[made - 1].player;
  for (const [id, times] of thrown) {
    // Sent on between two rolls of its own, or while somebody else threw after it: the squares in between are unknown.
    if (elsewhere(id) && (times > 1 || id !== last)) return [to];
  }
  if (!elsewhere(last)) return [...steps.slice(0, -1), to];
  return [...steps, { ...to, step: 1 }];
}
