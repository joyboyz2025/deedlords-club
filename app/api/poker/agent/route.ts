// The poker agent's desk. POST { id, seat, hole, model?, style? }: a bet for the seat to act at table `id`, from a
// model the server offers (with the owner's own instructions) or from the odds alone. GET: the models offered.
//
// It only advises: whoever asked signs `act` with their own key. The table is read from the chain here, not taken
// from the caller. The caller's two hole cards are the one thing the chain cannot give: only that seat can decrypt
// them, so the seat's own browser sends them along. They are used for this answer and kept nowhere. An agent asked
// through this desk therefore knows exactly what its seat knows, and this server learns that seat's cards, no other's.

import { MAX_STYLE, RULES_MODEL, llmConfig, llmFor, llmModels } from "@/games/co-ty-phu/agent/llm";
import { clientKey, intEnv, rateLimiter, underBudget } from "@/games/co-ty-phu/agent/rateLimit";
import { type Advice, advise } from "@/games/poker/agent/decide";
import { POKER_CHAIN } from "@/games/poker/contract";
import type { MatchView } from "@/games/poker/seat";
import { ChainClient } from "@/lib/chain/client";

export const dynamic = "force-dynamic";

const MATCH_ID = /^[A-Za-z0-9_-]{1,32}$/;
const client = new ChainClient(POKER_CHAIN);
// The same ceilings as the board game's desk (app/api/agent/route.ts): past them the odds alone answer.
const perIpLimiter = rateLimiter(intEnv(process.env.DEEDLORDS_LLM_IP_LIMIT, 20), 10 * 60_000);
const globalLimiter = rateLimiter(intEnv(process.env.DEEDLORDS_LLM_GLOBAL_LIMIT, 300), 60 * 60_000);
// A bet asked again (a page that reloads, a retry) is the same answer, not a second request to the model.
const shelf = globalThis as { deedlordsPokerAdviceV1?: Map<string, Promise<Advice>> };
const asked = (shelf.deedlordsPokerAdviceV1 ??= new Map());

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
    return refuse(400, "send JSON: { id, seat, hole }");
  }
  const { id, seat, hole, model, style } = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (typeof id !== "string" || !MATCH_ID.test(id) || (seat !== 0 && seat !== 1)) return refuse(400, "send JSON: { id, seat, hole }");
  if (!Array.isArray(hole) || hole.length !== 2 || hole[0] === hole[1] || !hole.every((card) => Number.isInteger(card) && card >= 0 && card < 52)) return refuse(400, "hole: your two cards, 0 to 51");
  if (style !== undefined && (typeof style !== "string" || style.length > MAX_STYLE)) return refuse(400, `style: at most ${MAX_STYLE} characters`);
  if (model !== undefined && typeof model !== "string") return refuse(400, "model: a name from GET /api/poker/agent");
  // A model the server does not offer is refused rather than swapped for another: its owner asked for that one.
  const llm = model === undefined || model === RULES_MODEL ? null : llmFor(process.env, model);
  if (model !== undefined && model !== RULES_MODEL && !llm && llmConfig(process.env)) return refuse(400, `model ${model} is not offered here`);

  let view: MatchView | null;
  try {
    view = await client.view<MatchView | null>("get_match", { id });
  } catch {
    return refuse(502, `cannot reach ${POKER_CHAIN.network}`);
  }
  if (!view) return refuse(404, `no open table ${id}`);
  if (view.phase !== "bet" || view.toAct !== seat) return refuse(409, "it is not this seat's bet");
  if ((hole as number[]).some((card) => view.board.includes(card))) return refuse(400, "hole: a card that lies on the board");

  const ticket = `${id}:${seat}:${view.seq}:${await digest(JSON.stringify([llm?.model ?? RULES_MODEL, style ?? "", hole]))}`;
  let pending = asked.get(ticket);
  if (!pending) {
    // Over budget: the odds alone answer this bet, the same as when a model fails.
    const overBudget = llm !== null && !underBudget(perIpLimiter, globalLimiter, clientKey(request));
    pending = advise(view, seat, hole as number[], { llm: overBudget ? null : llm, style: style as string | undefined }).then((advice) =>
      overBudget ? { ...advice, fallback: true, problem: "the model is answering too many requests right now" } : advice,
    );
    asked.set(ticket, pending);
    if (asked.size > 500) for (const key of [...asked.keys()].slice(0, 250)) asked.delete(key);
  }
  return Response.json(await pending, { headers: fresh });
}

async function digest(text: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(hash.subarray(0, 12), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
