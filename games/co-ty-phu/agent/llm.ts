// Asking a language model for a plan. Any service that speaks the OpenAI chat-completions protocol will do: NEAR AI
// Cloud (https://cloud-api.near.ai/v1), which serves many models behind one key, or a model vendor's own endpoint. The
// key stays on the server: this module is only ever called from there.

import type { Brief } from "./brief.ts";
import { cleanPlan, type Plan } from "./plan.ts";

export type LlmConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** What a seat driven by this model is labelled with on the table. */
  label: string;
};

const NEAR_AI_URL = "https://cloud-api.near.ai/v1";
const OPENAI_URL = "https://api.openai.com/v1";
export const MAX_REASON = 160;
export const MAX_STYLE = 280;

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
    user: `${tactic ? `The owner of this seat asks you to play like this: ${JSON.stringify(tactic)}\n\n` : ""}State of your seat:\n${JSON.stringify(brief)}`,
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

/** One request. Throws when the service refuses, is too slow for `signal`, or answers something that is not a plan. */
export async function askLlm(
  config: LlmConfig,
  brief: Brief,
  options: { style?: string; signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<{ plan: Plan; reason: string }> {
  const { system, user } = buildMessages(brief, options.style);
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
      max_tokens: 400,
    }),
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`the model service answered ${response.status}`);
  const body = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
  const text = body.choices?.[0]?.message?.content;
  const answer = typeof text === "string" ? parseAnswer(text) : null;
  if (!answer) throw new Error("the model did not answer with a plan");
  return answer;
}
