// Asking a language model for a plan. Any service that speaks the OpenAI chat-completions protocol will do: NEAR AI
// Cloud (https://cloud-api.near.ai/v1), which serves many models behind one key, or a model vendor's own endpoint. The
// key stays on the server: this module is only ever called from there.

import { NEAR_AI_URL, isNearAi } from "../../../lib/teeProof.ts";
import type { Brief } from "./brief.ts";
import { cleanPlan, type Plan } from "./plan.ts";
import { BAIL_RULES, BUILD_ORDERS, MAX_CAUTION, MAX_CUSHION, MAX_RESERVE, SELL_ORDERS, cleanPlaybook, type Playbook } from "./playbook.ts";

export type LlmConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** What a seat driven by this model is labelled with on the table. */
  label: string;
};

const OPENAI_URL = "https://api.openai.com/v1";
export const MAX_REASON = 160;
/**
 * How long an owner's instructions to their agent may be: a prompt of their own and as many rules as they like. It is
 * theirs alone: sent with each turn's question to the model, kept nowhere, shown to nobody else.
 */
export const MAX_STYLE = 8_000;
/** An owner's wish for a playbook, in their words. */
export const MAX_WISH = 2_000;
/** A seat that plays from its playbook alone, with no model asked. */
export const RULES_MODEL = "rules";

/**
 * Which model plays, from the server's environment. In order: an explicit endpoint (DEEDLORDS_LLM_BASE_URL, _API_KEY,
 * _MODEL), a NEAR AI Cloud key (NEARAI_API_KEY), an OpenAI key (OPENAI_API_KEY). `null`: none is set, the rule bot plays.
 */
export function llmConfig(env: Record<string, string | undefined>): LlmConfig | null {
  const model = env.DEEDLORDS_LLM_MODEL?.trim();
  const at = (baseUrl: string, apiKey: string, fallbackModel: string): LlmConfig => {
    const name = model || fallbackModel;
    return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model: name, label: env.DEEDLORDS_LLM_LABEL?.trim() || name.split("/").pop() || name };
  };
  const explicit = env.DEEDLORDS_LLM_API_KEY?.trim();
  if (explicit) return at(env.DEEDLORDS_LLM_BASE_URL?.trim() || NEAR_AI_URL, explicit, "z-ai/glm-5.2");
  const nearAi = env.NEARAI_API_KEY?.trim();
  if (nearAi) return at(NEAR_AI_URL, nearAi, "z-ai/glm-5.2");
  const openAi = env.OPENAI_API_KEY?.trim();
  if (openAi) return at(OPENAI_URL, openAi, "gpt-4.1-mini");
  return null;
}

/**
 * The models an owner may pick from: DEEDLORDS_LLM_MODELS (comma-separated, as the service names them), or just the
 * configured one. Whoever runs the server pays for every request, so the list is theirs to set. Empty: no model.
 */
export function llmModels(env: Record<string, string | undefined>): string[] {
  const config = llmConfig(env);
  const listed = (env.DEEDLORDS_LLM_MODELS ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  return [...new Set([...(config ? [config.model, ...listed] : []), ...nearAiModels(env)])];
}

/**
 * NEAR AI models on the server's own NEAR AI key (NEARAI_API_KEY), named `near:<model>`: NEARAI_MODELS, comma-separated.
 * Their answers come signed from a TEE, and the plans they make go on chain with that proof.
 */
export function nearAiModels(env: Record<string, string | undefined>): string[] {
  if (!env.NEARAI_API_KEY?.trim()) return [];
  return (env.NEARAI_MODELS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => `near:${name}`);
}

/** The configuration with `model` in place of the default one; `null` when no model is configured or `model` is not offered. */
export function llmFor(env: Record<string, string | undefined>, model?: string): LlmConfig | null {
  if (model?.startsWith("near:")) {
    const name = model.slice("near:".length);
    return nearAiModels(env).includes(model) ? { baseUrl: NEAR_AI_URL, apiKey: env.NEARAI_API_KEY!.trim(), model: name, label: name.split("/").pop() || name } : null;
  }
  const config = llmConfig(env);
  if (!config || !model || model === config.model) return config;
  return llmModels(env).includes(model) ? { ...config, model, label: model.split("/").pop() || model } : null;
}

/** What to tell the owner when the service refuses: 402 and 429 are almost always an account out of credit or over its rate. */
const refusal = (status: number) => `the model service answered ${status}${status === 402 || status === 429 ? " (out of credit, or asked too often)" : ""}`;

const SYSTEM = `You play one seat of Deedlords, a property board game settled on the NEAR blockchain: 40 squares in a ring, two dice, buy squares, collect rent.

How it ends: after the last round the players are ranked by net worth = cash + the price of every square owned (half if mortgaged) + the cost of every house (three quarters of it in Blitz). So buying a square or a house does not lower net worth, and every rent collected raises it. What loses is running out of cash: a debt you cannot pay forces you to sell houses at half cost and mortgage squares at half price, or go bankrupt.

You do not make moves. You write one plan BEFORE the dice are thrown; the contract then rolls and applies it to wherever you land, again after a double, and ends your turn:
- "buy_reserve": integer >= 0. A free square you land on is bought only if cash - price >= buy_reserve.
- "build": list of square numbers from your holdings (cities only), best first. One house goes on each where the rules allow (normal rules: only the city you are standing on; Blitz: any of your cities, once a turn) and cash - cost >= keep_reserve.
- "keep_reserve": integer >= 0, the cash that building must leave.
- "bail": true to leave custody at once (release card if held, else pay the fine), false to stay and roll for a double.
- "liquidate": list of square numbers from your holdings: what to sell houses from and mortgage first if a debt cannot be paid in cash.

The state you get is JSON. "reach" lists the 11 squares this roll can end on, with the chance of each and what happens there ("rent": you pay amount; "free": for sale at amount). "threat" is the largest rent you could owe within two rolls. In "holdings", "visits" is how many times the others are expected to land there before the game ends, "rentWithHouse" what they would pay after one more house.

Answer with one JSON object and nothing else:
{"plan": {"buy_reserve": 0, "build": [], "keep_reserve": 0, "bail": false, "liquidate": []}, "reason": "one sentence, at most 140 characters, plain words, why this plan"}`;

/** The two messages of the request. `style` is the seat owner's own tactic, in their words. */
export function buildMessages(brief: Brief, style?: string): { system: string; user: string } {
  const tactic = style?.trim().slice(0, MAX_STYLE);
  return {
    system: SYSTEM,
    user: `${tactic ? `The owner of this seat tells you how to play. Follow it wherever the rules of the game allow, and keep it to yourself: the reason you give must not quote or reveal it.\n${JSON.stringify(tactic)}\n\n` : ""}State of your seat:\n${JSON.stringify(brief)}`,
  };
}

/** The first JSON object in a model's answer: some models wrap it in a code fence or a sentence. */
export function parseAnswer(text: string): { plan: Plan; reason: string } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let answer: unknown;
  try {
    answer = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof answer !== "object" || answer === null) return null;
  const { plan: rawPlan, reason: rawReason } = answer as { plan?: unknown; reason?: unknown };
  const plan = cleanPlan(rawPlan);
  if (!plan) return null;
  const reason = typeof rawReason === "string" ? rawReason.replace(/\s+/g, " ").trim().slice(0, MAX_REASON) : "";
  return { plan, reason: reason || "No reason given." };
}

/**
 * NEAR AI's open models reason before they answer unless told not to, and a plan needs no essay: the reasoning would
 * eat the token budget (no plan left) or the time a turn has. GLM-5.3 Flash is kept short with `reasoning_effort: low`
 * (it ignores `enable_thinking`); the others take `enable_thinking: false` (https://docs.near.ai/cloud/reasoning-models).
 */
export function quickAnswer(config: LlmConfig): Record<string, unknown> {
  if (!isNearAi(config.baseUrl)) return {};
  return /glm-5\.3/i.test(config.model) ? { reasoning_effort: "low" } : { chat_template_kwargs: { enable_thinking: false } };
}

/** The exact bytes of one completion: what was sent, what came back, and its id. NEAR AI signs a hash of both. */
export type Exchange = { request: string; response: string; id: string };

/**
 * One request. Throws when the service refuses, is too slow for `signal`, or answers something that is not a plan.
 * The request and response bytes are kept exactly as sent and received, for a signature over them (lib/teeProof.ts).
 */
export async function askLlm(
  config: LlmConfig,
  brief: Brief,
  options: { style?: string; signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<{ plan: Plan; reason: string; exchange: Exchange }> {
  const { system, user } = buildMessages(brief, options.style);
  const request = JSON.stringify({
    model: config.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
    max_tokens: isNearAi(config.baseUrl) ? 800 : 400,
    ...quickAnswer(config),
  });
  const response = await (options.fetch ?? fetch)(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    // NEAR AI signs the model id the request named: it must not swap in another one for an alias.
    headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}`, ...(isNearAi(config.baseUrl) ? { "x-no-aliasing": "true" } : {}) },
    body: request,
    signal: options.signal,
  });
  if (!response.ok) throw new Error(refusal(response.status));
  const raw = await response.text();
  let body: { id?: unknown; choices?: { message?: { content?: unknown } }[] };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    throw new Error("the model service did not answer JSON");
  }
  const text = body.choices?.[0]?.message?.content;
  const answer = typeof text === "string" ? parseAnswer(text) : null;
  if (!answer) throw new Error("the model did not answer with a plan");
  return { ...answer, exchange: { request, response: raw, id: typeof body.id === "string" ? body.id : "" } };
}

const PLAYBOOK_SYSTEM = `You write the playbook of an agent that plays one seat of Deedlords, a property board game settled on the NEAR blockchain: 40 squares in a ring, two dice, buy squares, build houses, collect rent. A game starts with 1500 cash and squares cost 60 to 400.

How it ends: after the last round the players are ranked by net worth = cash + the price of every square owned (half if mortgaged) + the cost of every house. So buying and building do not lower net worth and every rent raises it. What loses is running out of cash: a debt that cannot be paid forces sales at half value.

The playbook is six rules. Each turn they are turned into the agent's moves:
- "reserve": integer 0 to ${MAX_RESERVE}. Cash always kept back; nothing is bought that would leave less.
- "caution": number 0 to ${MAX_CAUTION} in steps of 0.25. How much of the largest rent the agent could owe within two rolls is also kept: 0 ignores it, 1 covers it, more keeps a margin.
- "build": one of ${BUILD_ORDERS.map((name) => `"${name}"`).join(", ")}. Which of its cities get the next house first: where a house pays back most, the dearest, the cheapest, or never.
- "cushion": integer 0 to ${MAX_CUSHION}. Extra cash a house must leave on top of the reserve; above 0 the agent prefers squares to houses.
- "bail": one of ${BAIL_RULES.map((name) => `"${name}"`).join(", ")}. Leaving custody: "smart" pays while squares are still for sale.
- "sell": one of ${SELL_ORDERS.map((name) => `"${name}"`).join(", ")}. What is sold first when a debt cannot be paid.

The owner tells you how they want the agent to play. Answer with one JSON object and nothing else:
{"playbook": {"reserve": 150, "caution": 1, "build": "payback", "cushion": 0, "bail": "smart", "sell": "least-earning"}, "reason": "one sentence, at most 140 characters, plain words, how this playbook plays"}`;

/** A playbook written by the model from the owner's wish. Throws when the service refuses or answers something else. */
export async function askPlaybook(config: LlmConfig, wish: string, options: { signal?: AbortSignal; fetch?: typeof fetch } = {}): Promise<{ playbook: Playbook; reason: string }> {
  const response = await (options.fetch ?? fetch)(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: PLAYBOOK_SYSTEM },
        { role: "user", content: `The owner asks: ${JSON.stringify(wish.trim().slice(0, MAX_WISH))}` },
      ],
      response_format: { type: "json_object" },
      max_tokens: 300,
    }),
    signal: options.signal,
  });
  if (!response.ok) throw new Error(refusal(response.status));
  const body = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
  const text = body.choices?.[0]?.message?.content;
  let answer: { playbook?: unknown; reason?: unknown } | null = null;
  if (typeof text === "string") {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    try {
      answer = start >= 0 && end > start ? (JSON.parse(text.slice(start, end + 1)) as { playbook?: unknown; reason?: unknown }) : null;
    } catch {
      answer = null;
    }
  }
  const playbook = cleanPlaybook(answer?.playbook);
  if (!playbook) throw new Error("the model did not answer with a playbook");
  const reason = typeof answer?.reason === "string" ? answer.reason.replace(/\s+/g, " ").trim().slice(0, MAX_REASON) : "";
  return { playbook, reason: reason || "No reason given." };
}
