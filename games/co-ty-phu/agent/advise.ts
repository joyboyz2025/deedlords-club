// One turn's advice for a seat: the model's plan when a model is configured and answers in time, the rule bot's
// otherwise. Whoever asks (a player's own tab, a runner holding an agent account) signs `turn(plan)` themselves.

import type { ChainMatch } from "../chain/types.ts";
import { briefFor } from "./brief.ts";
import { evPlan } from "./ev.ts";
import { askLlm, type LlmConfig } from "./llm.ts";
import type { Plan } from "./plan.ts";

/** A model gets this long. A turn on chain takes about two seconds on top. */
export const LLM_TIMEOUT_MS = 4_000;
/** The name of the rule bot on the table. */
export const EV_DRIVER = "ev";

export type Advice = {
  plan: Plan;
  /** One sentence, shown next to the seat. */
  reason: string;
  /** Who made the plan: a model's label, or `ev`. */
  driver: string;
  /** A model was asked and the rule bot answered in its place. */
  fallback: boolean;
  /** Why, when `fallback`. */
  problem: string | null;
  /** How long the advice took. */
  ms: number;
};

export type AdviseOptions = { llm: LlmConfig | null; style?: string; timeoutMs?: number; fetch?: typeof fetch; now?: () => number };

/** `null` when `seat` is not a player of a game in progress. */
export async function advise(match: ChainMatch, seat: number, options: AdviseOptions): Promise<Advice | null> {
  const now = options.now ?? Date.now;
  const started = now();
  const brief = briefFor(match, seat);
  if (!brief) return null;
  const rule = evPlan(brief);
  if (!options.llm) return { ...rule, driver: EV_DRIVER, fallback: false, problem: null, ms: now() - started };

  const timeoutMs = options.timeoutMs ?? LLM_TIMEOUT_MS;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const answer = await askLlm(options.llm, brief, { style: options.style, signal: abort.signal, fetch: options.fetch });
    return { ...answer, driver: options.llm.label, fallback: false, problem: null, ms: now() - started };
  } catch (error) {
    const problem = abort.signal.aborted ? `no answer in ${timeoutMs / 1000} s` : error instanceof Error ? error.message : String(error);
    return { ...rule, driver: EV_DRIVER, fallback: true, problem, ms: now() - started };
  } finally {
    clearTimeout(timer);
  }
}
