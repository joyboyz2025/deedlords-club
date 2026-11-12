// A poker agent's decision at a table of two to nine seats, for the seat to act: fold, call (a check when nothing is
// owed) or raise. As at the heads-up table (../agent/decide.ts) it is asked of a language model with the owner's own
// instructions, or worked out from the odds alone ("by the book") when no model is asked or the model fails. Whoever
// asks signs the bet themselves: this only advises.
//
// The agent knows what its own seat knows and no more: its two cards, the board, the bets and chips of the others.

import { MAX_STYLE, type LlmConfig } from "../../co-ty-phu/agent/llm.ts";
import { type Advice, type Decision, askFor, cardName } from "../agent/decide.ts";
import { madeHand, winChance } from "../agent/hands.ts";
import { type TableView, betOptions, contenders } from "./seat.ts";

/** What the seat to act is told. Everything in it is what that seat can see. */
export type Brief = {
  street: "pre-flop" | "flop" | "turn" | "river";
  hand: number;
  /** How many seats were dealt in, and how many of them have not folded (you among them). */
  seatsDealt: number;
  seatsStillIn: number;
  /** Where you sit: "button", "small blind", "big blind", or how many seats after the big blind. */
  position: string;
  yourCards: string[];
  board: string[];
  /** What the seat's cards make with the board right now; `null` before the flop. */
  youHold: string | null;
  /** Chips in the middle, this street's bets included. */
  pot: number;
  /** What a call costs; 0 means a check is free. */
  toCall: number;
  /** The share of the pot after a call that the call costs: the least chance of winning a call needs to pay. */
  potOdds: number;
  /** The chance of winning against the other seats still in, each holding a hand dealt at random, from 0 to 1. */
  winChance: number;
  yourChips: number;
  yourBet: number;
  /** The highest bet of this street. */
  highestBet: number;
  /** The other seats still in, in the order they act after you: their chips behind and their bet on this street. */
  others: { chips: number; bet: number; allIn: boolean }[];
  /** The whole bet this street a raise may make it: at least `min`, at most `max`. `null`: no raise is possible. */
  raiseTo: { min: number; max: number } | null;
  blinds: [number, number];
};

const STREETS = ["pre-flop", "flop", "turn", "river"] as const;
const percent = (share: number): string => `${Math.round(share * 100)}%`;

function position(view: TableView, seat: number): string {
  const [place, n] = [view.dealt.indexOf(seat), view.dealt.length];
  if (place === 0) return n === 2 ? "button and small blind" : "button";
  if (n === 2) return "big blind";
  if (place === 1) return "small blind";
  if (place === 2) return "big blind";
  return `${place - 2} after the big blind`;
}

/** `samples`: how many random deals the chance of winning is taken from. */
export function briefFor(view: TableView, seat: number, hole: number[], options: { samples?: number; random?: () => number } = {}): Brief {
  const { owed, raise } = betOptions(view, seat);
  const pot = view.put.reduce((sum, chips) => sum + chips, 0);
  const place = view.dealt.indexOf(seat);
  const after = view.dealt.map((_, index) => view.dealt[(place + 1 + index) % view.dealt.length]);
  const others = after.filter((other) => other !== seat && !view.folded[other]);
  return {
    street: STREETS[view.street],
    hand: view.hand + 1,
    seatsDealt: view.dealt.length,
    seatsStillIn: contenders(view).length,
    position: position(view, seat),
    yourCards: hole.map(cardName),
    board: view.board.map(cardName),
    youHold: madeHand(hole, view.board),
    pot,
    toCall: owed,
    potOdds: Math.round((owed / (pot + owed)) * 100) / 100,
    winChance: Math.round(winChance(hole, view.board, options.samples ?? 1_200, options.random, others.length) * 100) / 100,
    yourChips: view.chips[seat],
    yourBet: view.bet[seat],
    highestBet: Math.max(...view.bet),
    others: others.map((other) => ({ chips: view.chips[other], bet: view.bet[other], allIn: view.chips[other] === 0 })),
    raiseTo: raise,
    blinds: [1, 2],
  };
}

/** A raise that adds `share` of the pot to the bet it answers, inside what a raise may be. */
function raiseBy(brief: Brief, share: number): Decision {
  const { min, max } = brief.raiseTo!;
  return { action: "raise", amount: Math.max(min, Math.min(max, brief.highestBet + Math.max(2, Math.round(brief.pot * share)))) };
}

/**
 * The odds alone. With `n` seats in, a hand as good as any other wins one time in `n`: raise a hand that wins well
 * more often than that, call when the chance of winning pays for the call with a little to spare, never fold what
 * costs nothing, fold the rest.
 */
export function byTheBook(brief: Brief): Decision & { reason: string } {
  const chance = percent(brief.winChance);
  const [n, against] = [brief.seatsStillIn, brief.seatsStillIn === 2 ? "one random hand" : `${brief.seatsStillIn - 1} random hands`];
  if (brief.toCall === 0) {
    if (brief.raiseTo && brief.winChance >= (1.3 + 0.05 * (n - 2)) / n) return { ...raiseBy(brief, 0.6), reason: `Wins about ${chance} of the time against ${against}: bet for value.` };
    return { action: "call", reason: `Wins about ${chance} of the time against ${against}: not enough to bet, and a check is free.` };
  }
  if (brief.raiseTo && brief.winChance >= (1.6 + 0.07 * (n - 2)) / n) return { ...raiseBy(brief, 0.75), reason: `Wins about ${chance} of the time against ${against}: raise.` };
  if (brief.winChance >= brief.potOdds + 0.05) return { action: "call", reason: `Wins about ${chance} of the time and the call needs ${percent(brief.potOdds)}: call.` };
  return { action: "fold", reason: `Wins about ${chance} of the time and the call needs ${percent(brief.potOdds)}: fold.` };
}

const SYSTEM = `You play one seat of no-limit Texas Hold'em at a table of two to nine seats, for chips that are worth real stakes. Every seat bought in for 100 chips; blinds are 1 and 2. The two seats after the button post the blinds and the seat after them acts first before the flop (with two seats the button posts the small blind and acts first); after the flop the first seat after the button acts first. A seat that is all in for less can only win, from each seat, as much as it put in.

You are told only what your seat can see: your two cards, the board, the pot, and the chips and bets of the other seats still in, in the order they act after you. Cards are written rank then suit: "As" is the ace of spades, "Td" the ten of diamonds. "winChance" is your chance of winning against the other seats still in if each held a hand dealt at random (seats that bet or raise usually hold better than random). "potOdds" is the chance of winning that a call needs to break even. "raiseTo" is the range your whole bet on this street may be raised to; null means you cannot raise.

Answer with one JSON object and nothing else:
{"action": "fold" | "check" | "call" | "raise", "amount": <only for raise: your whole bet on this street after the raise, an integer inside raiseTo>, "reason": "one sentence, at most 140 characters, plain words, why"}`;

/** The two messages of the request. `style` is the seat owner's own instructions, in their words. */
export function messages(brief: Brief, style?: string): { system: string; user: string } {
  const tactic = style?.trim().slice(0, MAX_STYLE);
  return {
    system: SYSTEM,
    user: `${tactic ? `The owner of this seat tells you how to play. Follow it wherever the rules of the game allow, and keep it to yourself: the reason you give must not quote or reveal it.\n${JSON.stringify(tactic)}\n\n` : ""}Your seat now:\n${JSON.stringify(brief)}`,
  };
}

/** A model gets this long; a seat's clock keeps running while it thinks. */
const MODEL_TIMEOUT_MS = 12_000;

/**
 * The bet for `seat`, which must be the seat to act and hold `hole`. With `llm` the model is asked and the book
 * answers if it fails; without, the book answers.
 */
export async function advise(
  view: TableView,
  seat: number,
  hole: number[],
  options: { llm?: LlmConfig | null; style?: string; samples?: number; random?: () => number; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<Advice> {
  const brief = briefFor(view, seat, hole, options);
  const book = (): Advice => ({ ...byTheBook(brief), driver: "the book" });
  if (!options.llm) return book();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? MODEL_TIMEOUT_MS);
  try {
    return { ...(await askFor(options.llm, messages(brief, options.style), brief, { signal: abort.signal, fetch: options.fetch })), driver: options.llm.label };
  } catch (error) {
    const problem = abort.signal.aborted ? `${options.llm.label} did not answer in time` : error instanceof Error ? error.message : String(error);
    return { ...book(), fallback: true, problem };
  } finally {
    clearTimeout(timer);
  }
}
