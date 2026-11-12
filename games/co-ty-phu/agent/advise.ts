// One turn's advice for a seat: the model's plan when a model is configured and answers in time, the rule bot's
// otherwise. Whoever asks (a player's own tab, a runner holding an agent account) signs `turn(plan)` themselves.

import { fetchTeeProof, isNearAi, type TeeProof } from "../../../lib/teeProof.ts";
import type { ChainMatch } from "../chain/types.ts";
import { briefFor } from "./brief.ts";
import { evPlan } from "./ev.ts";
import { askLlm, type LlmConfig } from "./llm.ts";
import type { Plan } from "./plan.ts";
import { playbookPlan, playbookStyle, type Playbook } from "./playbook.ts";

/** A model gets this long. A turn on chain takes about two seconds on top. */
export const LLM_TIMEOUT_MS = 4_000;
/** A NEAR AI model gets this long: its enclave is slower to answer than a plain API, and the turn has 60 s. */
export const NEAR_AI_TIMEOUT_MS = 15_000;
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
  /** NEAR AI's signature over the exchange the plan came from, for the `turn` transaction to carry (lib/teeProof.ts). */
  proof?: TeeProof | null;
};

/** How long the signature of a completion is waited for: NEAR AI records it a moment after answering. */
export const PROOF_TIMEOUT_MS = 4_000;

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

  // A model in a NEAR AI enclave answers in a few seconds; it is given longer than a model behind a plain API.
  const timeoutMs = options.timeoutMs ?? (isNearAi(options.llm.baseUrl) ? NEAR_AI_TIMEOUT_MS : LLM_TIMEOUT_MS);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const { exchange, ...answer } = await askLlm(options.llm, brief, { style: style || undefined, signal: abort.signal, fetch: options.fetch });
    clearTimeout(timer);
    // A model NEAR AI serves signs what it answered: the proof goes on chain with the move. A move never waits long for it.
    const llm = options.llm;
    const proof =
      isNearAi(llm.baseUrl) && exchange.id
        ? await Promise.race([
            fetchTeeProof({ apiKey: llm.apiKey, model: llm.model, chatId: exchange.id, request: exchange.request, response: exchange.response, fetch: options.fetch }).catch(() => null),
            new Promise<null>((done) => setTimeout(() => done(null), PROOF_TIMEOUT_MS)),
          ])
        : null;
    return { ...answer, driver: llm.label, fallback: false, problem: null, ms: now() - started, proof };
  } catch (error) {
    const problem = abort.signal.aborted ? `no answer in ${timeoutMs / 1000} s` : error instanceof Error ? error.message : String(error);
    return { ...rule, driver: ruleDriver, fallback: true, problem, ms: now() - started };
  } finally {
    clearTimeout(timer);
  }
}
