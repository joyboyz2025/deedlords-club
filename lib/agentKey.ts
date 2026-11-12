// A player's own NEAR AI Cloud key (https://docs.near.ai), for their own agents. It is kept in this browser only and
// sent to nobody but NEAR AI: the gateway at cloud-api.near.ai answers a browser directly, so an agent that runs on
// the player's key is asked from the player's tab, never through this site's server. The player pays NEAR AI for what
// their agents ask, and may pick any model NEAR AI serves rather than only the ones this server offers.
//
// An agent's model names the key it runs on: `near:<model>` is NEAR AI on the player's key (`near:openai/gpt-5-mini`),
// a bare name is a model this server offers on its own key, and `rules` asks no model.

import type { LlmConfig } from "@/games/co-ty-phu/agent/llm";

export const NEAR_AI_URL = "https://cloud-api.near.ai/v1";
export const OWN_PREFIX = "near:";
const STORE = "deedlords:nearai-key";

export const isOwnModel = (model: string): boolean => model.startsWith(OWN_PREFIX);
export const ownModelName = (model: string): string => model.slice(OWN_PREFIX.length);
/** How a model is shown: its last path part, and "your key" for one on the player's key. */
export const modelLabel = (model: string): string => (isOwnModel(model) ? `${ownModelName(model).split("/").pop()} · your key` : (model.split("/").pop() ?? model));

export function readNearAiKey(): string | null {
  try {
    return localStorage.getItem(STORE)?.trim() || null;
  } catch {
    return null;
  }
}

export function writeNearAiKey(key: string | null): void {
  try {
    if (key?.trim()) localStorage.setItem(STORE, key.trim());
    else localStorage.removeItem(STORE);
  } catch {
    // A private window: the key lasts as long as the page.
  }
}

/** The model client for an agent on the player's own key, or `null` without a key. */
export function ownLlm(model: string): LlmConfig | null {
  const apiKey = readNearAiKey();
  if (!apiKey || !isOwnModel(model)) return null;
  const name = ownModelName(model);
  return { baseUrl: NEAR_AI_URL, apiKey, model: name, label: modelLabel(model) };
}

export type NearAiModel = { id: string; inPerMillion: number; outPerMillion: number };

/** Families that answer chat with text; the catalogue also lists embedders, rerankers, image and audio models. */
const NOT_CHAT = /embed|rerank|whisper|flux|privacy-filter|abliterated|jev-|-vl-/i;

/** NEAR AI's chat models and their prices in USD per million tokens, cheapest first. The list is public: no key needed. */
export async function nearAiModels(): Promise<NearAiModel[]> {
  const response = await fetch(`${NEAR_AI_URL}/models`);
  if (!response.ok) throw new Error(`NEAR AI answered ${response.status}`);
  const body = (await response.json()) as { data?: { id: string; pricing?: { input?: number; output?: number } }[] };
  return (body.data ?? [])
    .filter((model) => typeof model.id === "string" && !NOT_CHAT.test(model.id))
    .map((model) => ({ id: model.id, inPerMillion: Number(model.pricing?.input ?? 0), outPerMillion: Number(model.pricing?.output ?? 0) }))
    .sort((a, b) => a.inPerMillion + a.outPerMillion - (b.inPerMillion + b.outPerMillion));
}

/** Asks NEAR AI one tiny question with `key`. `null` when the key works, else what NEAR AI said. */
export async function checkNearAiKey(key: string, model = "google/gemini-2.5-flash-lite"): Promise<string | null> {
  try {
    const response = await fetch(`${NEAR_AI_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key.trim()}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Say OK." }], max_tokens: 8 }),
      signal: AbortSignal.timeout(20_000),
    });
    if (response.ok) return null;
    if (response.status === 401 || response.status === 403) return "NEAR AI does not know this key.";
    if (response.status === 402) return "The key works, but its account has no credit left.";
    if (response.status === 429) return "The key works, but NEAR AI says it is asked too often right now.";
    return `NEAR AI answered ${response.status}.`;
  } catch {
    return "NEAR AI did not answer.";
  }
}
