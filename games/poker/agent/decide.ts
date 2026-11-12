// A poker agent's decision for the seat to act: fold, call (a check when nothing is owed) or raise. It is asked of a
// language model with the owner's own instructions, or worked out from the odds alone ("by the book") when no model is
// asked, or when the model is slow, refuses, or answers something that is no legal bet. Whoever asks signs the bet
// themselves: this only advises.
//
// The agent knows what its own seat knows and no more: its two cards, the board, the bets. It never sees the other
// seat's cards, because nobody but that seat can decrypt them.

import { MAX_REASON, MAX_STYLE, type LlmConfig } from "../../co-ty-phu/agent/llm.ts";
import type { MatchView } from "../seat.ts";
import { madeHand, winChance } from "./hands.ts";

export type Decision = { action: "fold" | "call" | "raise"; amount?: number };
export type Advice = Decision & {
  /** One sentence, the agent's own words. */
  reason: string;
  /** Who decided: a model's label, or "the book". */
  driver: string;
  /** A model was asked and the book answered instead; `problem` says why. */
  fallback?: boolean;
  problem?: string;
};

/** What the seat to act is told. Everything in it is what that seat can see. */
export type Brief = {
  street: "pre-flop" | "flop" | "turn" | "river";
  hand: number;
  /** The button posts the small blind and acts first before the flop; the other seat acts first after it. */
  youHaveTheButton: boolean;
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
  /** The chance of winning against one hand dealt at random, from 0 to 1. */
  winChance: number;
  yourChips: number;
  theirChips: number;
  yourBet: number;
  theirBet: number;
  /** The whole bet this street a raise may make it: at least `min`, at most `max`. `null`: no raise is possible. */
  raiseTo: { min: number; max: number } | null;
  blinds: [number, number];
};

const STREETS = ["pre-flop", "flop", "turn", "river"] as const;
export const cardName = (card: number): string => "23456789TJQKA"[card % 13] + "cdhs"[Math.floor(card / 13)];
const percent = (share: number): string => `${Math.round(share * 100)}%`;

/** `samples`: how many random deals the chance of winning is taken from. */
export function briefFor(view: MatchView, seat: number, hole: number[], options: { samples?: number; random?: () => number } = {}): Brief {
  const other = 1 - seat;
  const most = Math.min(view.bet[seat] + view.chips[seat], view.bet[other] + view.chips[other]);
  const [pot, toCall] = [view.put[0] + view.put[1], view.bet[other] - view.bet[seat]];
  return {
    street: STREETS[view.street],
    hand: view.hand + 1,
    youHaveTheButton: view.button === seat,
    yourCards: hole.map(cardName),
    board: view.board.map(cardName),
    youHold: madeHand(hole, view.board),
    pot,
    toCall,
    potOdds: Math.round((toCall / (pot + toCall)) * 100) / 100,
    winChance: Math.round(winChance(hole, view.board, options.samples ?? 1_500, options.random) * 100) / 100,
    yourChips: view.chips[seat],
    theirChips: view.chips[other],
    yourBet: view.bet[seat],
    theirBet: view.bet[other],
    raiseTo: most > view.bet[other] ? { min: Math.min(view.bet[other] + 2, most), max: most } : null,
    blinds: [1, 2],
  };
}

/** A raise that adds `share` of the pot to the bet it answers, inside what a raise may be. */
function raiseBy(brief: Brief, share: number): Decision {
  const { min, max } = brief.raiseTo!;
  return { action: "raise", amount: Math.max(min, Math.min(max, brief.theirBet + Math.max(2, Math.round(brief.pot * share)))) };
}

/**
 * The odds alone: raise a hand that wins most of the time, call when the chance of winning pays for the call with a
 * little to spare, never fold what costs nothing, fold the rest.
 */
export function byTheBook(brief: Brief): Decision & { reason: string } {
  const chance = percent(brief.winChance);
  if (brief.toCall === 0) {
    if (brief.raiseTo && brief.winChance >= 0.65) return { ...raiseBy(brief, 0.6), reason: `Wins about ${chance} of the time against a random hand: bet for value.` };
    return { action: "call", reason: `Wins about ${chance} of the time: not enough to bet, and a check is free.` };
  }
  if (brief.raiseTo && brief.winChance >= 0.8) return { ...raiseBy(brief, 0.75), reason: `Wins about ${chance} of the time: raise.` };
  if (brief.winChance >= brief.potOdds + 0.05) return { action: "call", reason: `Wins about ${chance} of the time and the call needs ${percent(brief.potOdds)}: call.` };
  return { action: "fold", reason: `Wins about ${chance} of the time and the call needs ${percent(brief.potOdds)}: fold.` };
}

/**
 * What somebody answered, as a bet the contract takes, or `null` when it is none. A check is a call that owes
 * nothing; a fold that would give up a free check becomes the check; a raise is held inside its bounds, and is a
 * call when no raise is possible.
 */
export function legal(answer: unknown, brief: Brief): Decision | null {
  if (typeof answer !== "object" || answer === null) return null;
  const { action, amount } = answer as { action?: unknown; amount?: unknown };
  if (action === "check") return brief.toCall === 0 ? { action: "call" } : null;
  if (action === "call") return { action: "call" };
  if (action === "fold") return brief.toCall === 0 ? { action: "call" } : { action: "fold" };
  if (action !== "raise" && action !== "bet" && action !== "all-in") return null;
  if (!brief.raiseTo) return { action: "call" };
  if (action === "all-in") return { action: "raise", amount: brief.raiseTo.max };
  if (typeof amount !== "number" || !Number.isFinite(amount)) return null;
  return { action: "raise", amount: Math.max(brief.raiseTo.min, Math.min(brief.raiseTo.max, Math.round(amount))) };
}

const SYSTEM = `You play one seat of heads-up no-limit Texas Hold'em for chips that are worth real stakes. Two seats start with 100 chips each; blinds are 1 and 2; the button posts the small blind and acts first before the flop, the other seat acts first after it. A bet can never be more than the other seat can call, so there are no side pots.

You are told only what your seat can see: your two cards, the board, the pot and the bets. Cards are written rank then suit: "As" is the ace of spades, "Td" the ten of diamonds. "winChance" is your chance of winning against one hand dealt at random (your opponent's real hand is usually better than random when they bet or raise). "potOdds" is the chance of winning that a call needs to break even. "raiseTo" is the range your whole bet on this street may be raised to; null means you cannot raise.

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

/** The first JSON object in a model's answer, as a legal bet with its reason; `null` when there is none. */
export function parseAnswer(text: string, brief: Brief): (Decision & { reason: string }) | null {
  const [start, end] = [text.indexOf("{"), text.lastIndexOf("}")];
  if (start < 0 || end <= start) return null;
  let answer: unknown;
  try {
    answer = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const decision = legal(answer, brief);
  if (!decision) return null;
  const { reason: said, action } = answer as { reason?: unknown; action?: unknown };
  // A fold that became a check: the reason given was for folding, and would read wrong beside a check.
  if (action === "fold" && decision.action === "call") return { ...decision, reason: "Would fold to a bet; there is none, so it checks." };
  const reason = typeof said === "string" ? said.replace(/\s+/g, " ").trim().slice(0, MAX_REASON) : "";
  return { ...decision, reason: reason || "No reason given." };
}

/** One request to a service that speaks the OpenAI chat-completions protocol. Throws when it refuses or does not answer with a bet. */
export async function askModel(config: LlmConfig, brief: Brief, options: { style?: string; signal?: AbortSignal; fetch?: typeof fetch } = {}): Promise<Decision & { reason: string }> {
  const { system, user } = messages(brief, options.style);
  const response = await (options.fetch ?? fetch)(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      max_tokens: 300,
    }),
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`the model service answered ${response.status}${response.status === 402 || response.status === 429 ? " (out of credit, or asked too often)" : ""}`);
  const body = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
  const text = body.choices?.[0]?.message?.content;
  const answer = typeof text === "string" ? parseAnswer(text, brief) : null;
  if (!answer) throw new Error("the model did not answer with a bet");
  return answer;
}

/** A model gets this long; a seat's clock keeps running while it thinks. */
const MODEL_TIMEOUT_MS = 12_000;

/**
 * The bet for `seat`, which must be the seat to act and hold `hole`. With `llm` the model is asked and the book
 * answers if it fails; without, the book answers.
 */
export async function advise(
  view: MatchView,
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
    return { ...(await askModel(options.llm, brief, { style: options.style, signal: abort.signal, fetch: options.fetch })), driver: options.llm.label };
  } catch (error) {
    const problem = abort.signal.aborted ? `${options.llm.label} did not answer in time` : error instanceof Error ? error.message : String(error);
    return { ...book(), fallback: true, problem };
  } finally {
    clearTimeout(timer);
  }
}
