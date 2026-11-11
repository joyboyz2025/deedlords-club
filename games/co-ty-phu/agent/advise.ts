// One turn's advice for a seat: the model's plan when a model is configured and answers in time, the rule bot's
// otherwise. Whoever asks (a player's own tab, a runner holding an agent account) signs `turn(plan)` themselves.

import type { ChainMatch } from "../chain/types.ts";
import { briefFor } from "./brief.ts";
import { evPlan } from "./ev.ts";
import { askLlm, type LlmConfig } from "./llm.ts";
import type { Plan } from "./plan.ts";
import { playbookPlan, playbookStyle, type Playbook } from "./playbook.ts";

/** A model gets this long. A turn on chain takes about two seconds on top. */
export const LLM_TIMEOUT_MS = 4_000;
/** The name of the rule bot on the table. */
export const EV_DRIVER = "ev";
/** The name on the table of a seat played from its owner's playbook with no model. */
export const PLAYBOOK_DRIVER = "playbook";

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

/** `playbook`: the owner's rules. They make the plan when no model is asked or the model fails, and a model asked gets them as instructions. */
export type AdviseOptions = { llm: LlmConfig | null; style?: string; playbook?: Playbook; timeoutMs?: number; fetch?: typeof fetch; now?: () => number };

/** `null` when `seat` is not a player of a game in progress. */
export async function advise(match: ChainMatch, seat: number, options: AdviseOptions): Promise<Advice | null> {
  const now = options.now ?? Date.now;
  const started = now();
  const brief = briefFor(match, seat);
  if (!brief) return null;
  const rule = options.playbook ? playbookPlan(brief, options.playbook) : evPlan(brief);
  const ruleDriver = options.playbook ? PLAYBOOK_DRIVER : EV_DRIVER;
  if (!options.llm) return { ...rule, driver: ruleDriver, fallback: false, problem: null, ms: now() - started };
  const style = [options.playbook ? playbookStyle(options.playbook) : "", options.style?.trim() ?? ""].filter(Boolean).join(" ");

  const timeoutMs = options.timeoutMs ?? LLM_TIMEOUT_MS;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const answer = await askLlm(options.llm, brief, { style: style || undefined, signal: abort.signal, fetch: options.fetch });
    return { ...answer, driver: options.llm.label, fallback: false, problem: null, ms: now() - started };
  } catch (error) {
    const problem = abort.signal.aborted ? `no answer in ${timeoutMs / 1000} s` : error instanceof Error ? error.message : String(error);
    return { ...rule, driver: ruleDriver, fallback: true, problem, ms: now() - started };
  } finally {
    clearTimeout(timer);
  }
}
