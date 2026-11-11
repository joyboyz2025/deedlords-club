// The plan an agent hands the contract with `turn(id, seat, plan)`: one transaction rolls, applies the plan and ends
// the turn (contracts/deedlords/src/autoplay.rs). A plan is written before the dice are thrown, so it holds thresholds
// and orders, not moves.

import { SQUARES, isOwnable } from "../board.ts";

export type Plan = {
  /** Buy the square landed on only if `cash - price >= buy_reserve`. */
  buy_reserve: number;
  /** Own cities to put one house on, tried in this order; the ones the rules do not allow are skipped. */
  build: number[];
  /** Skip a house if `cash - cost < keep_reserve`. */
  keep_reserve: number;
  /** In custody at the start of a roll: use a release card if held, else pay the fine. */
  bail: boolean;
  /** Squares to sell houses from, then mortgage, first, when a debt cannot be paid from cash. */
  liquidate: number[];
};

/** The contract takes lists of at most this many squares. */
export const MAX_PLAN_LIST = 40;
/** No reserve above this means anything: nobody ever holds that much. */
const MAX_RESERVE = 1_000_000;

/** What the contract's defaults would do, spelled out: buy whatever is affordable, build nothing, stay in custody. */
export const DEFAULT_PLAN: Plan = { buy_reserve: 0, build: [], keep_reserve: 0, bail: false, liquidate: [] };

const reserve = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(MAX_RESERVE, Math.max(0, Math.round(value))) : null;

function squares(value: unknown, allowed: (index: number) => boolean): number[] | null {
  if (!Array.isArray(value)) return null;
  const list: number[] = [];
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 0 || entry >= SQUARES.length) return null;
    if (allowed(entry) && !list.includes(entry)) list.push(entry);
  }
  return list.slice(0, MAX_PLAN_LIST);
}

/**
 * A plan as the contract accepts it, from whatever a model answered: `null` when the answer is not a plan at all (the
 * caller then falls back to the rule bot). Squares that can never be built on or sold are dropped, numbers are rounded.
 */
export function cleanPlan(raw: unknown): Plan | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const answer = raw as Record<string, unknown>;
  const buy = reserve(answer.buy_reserve);
  const keep = reserve(answer.keep_reserve ?? answer.buy_reserve);
  const build = squares(answer.build ?? [], (i) => SQUARES[i].kind === "city");
  const liquidate = squares(answer.liquidate ?? [], (i) => isOwnable(SQUARES[i]));
  if (buy === null || keep === null || build === null || liquidate === null) return null;
  if (answer.bail !== undefined && typeof answer.bail !== "boolean") return null;
  return { buy_reserve: buy, build, keep_reserve: keep, bail: answer.bail === true, liquidate };
}
