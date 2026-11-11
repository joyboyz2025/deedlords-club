// Writing a playbook. GET: the models this server offers an owner (empty when none is configured). POST { wish, model? }:
// a playbook written by that model from the owner's wish in plain words, for the owner to adjust by hand.
//
// It only writes: nothing is stored here. The owner's browser keeps the playbook and sends it along with each turn.

import { MAX_WISH, askPlaybook, llmConfig, llmFor, llmModels } from "@/games/co-ty-phu/agent/llm";

export const dynamic = "force-dynamic";

/** A playbook is written once, not every turn: a slower model is given time. */
const WRITE_TIMEOUT_MS = 20_000;
const fresh = { "cache-control": "no-store" };
const refuse = (status: number, error: string) => Response.json({ error }, { status, headers: fresh });

export function GET(): Response {
  return Response.json({ models: llmModels(process.env), default: llmConfig(process.env)?.model ?? null }, { headers: fresh });
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return refuse(400, "send JSON: { wish }");
  }
  const { wish, model } = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (typeof wish !== "string" || wish.trim().length < 3 || wish.length > MAX_WISH) return refuse(400, `wish: 3 to ${MAX_WISH} characters`);
  if (model !== undefined && typeof model !== "string") return refuse(400, "model: a name from GET");
  const llm = llmFor(process.env, model as string | undefined);
  if (!llm) return refuse(llmConfig(process.env) ? 400 : 503, llmConfig(process.env) ? `model ${model} is not offered here` : "no model is configured on this server");

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), WRITE_TIMEOUT_MS);
  try {
    const answer = await askPlaybook(llm, wish, { signal: abort.signal });
    return Response.json({ ...answer, driver: llm.label }, { headers: fresh });
  } catch (error) {
    return refuse(502, abort.signal.aborted ? `${llm.label} did not answer in ${WRITE_TIMEOUT_MS / 1000} s` : error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}
