// The agent's desk. POST { id, seat, style?, model?, playbook? }: a plan for the seat whose turn it is in match `id`,
// from a model the server offers (see games/co-ty-phu/agent/llm.ts), from the owner's playbook, or from the rule bot. GET ?id=: who drives which seat of
// the match and the sentence each gave last.
//
// It only advises. The match is read from the chain here, not taken from the caller, and whoever asked signs
// `turn(id, seat, plan)` with their own key: a seat's owner in their tab, or a runner holding an agent account. A
// turn is answered once however often it is asked, so a model is asked at most once per turn played on chain.

import { advise } from "@/games/co-ty-phu/agent/advise";
import { MAX_STYLE, RULES_MODEL, llmConfig, llmFor } from "@/games/co-ty-phu/agent/llm";
import { cleanPlaybook } from "@/games/co-ty-phu/agent/playbook";
import { clientKey, intEnv, rateLimiter, underBudget } from "@/games/co-ty-phu/agent/rateLimit";
import { asking, book } from "@/games/co-ty-phu/agent/shelf";
import type { ChainMatch } from "@/games/co-ty-phu/chain/types";
import { CHAIN } from "@/lib/chain/config";
import { chainClient } from "@/lib/chain/shared";

export const dynamic = "force-dynamic";

const MATCH_ID = /^[A-Za-z0-9_-]{1,32}$/;

// A model call costs the server's owner money; a turn is already asked at most once (the book above dedups by turn),
// but a public deployment still wants a ceiling on how many *different* turns pay for a model. Past it, the playbook
// or the rule bot plays instead: the move is never refused, only made without a model's help. Defaults are generous
// for one person testing and tight enough that a forgotten public demo cannot run away; both are one env var to raise.
const perIpLimiter = rateLimiter(intEnv(process.env.DEEDLORDS_LLM_IP_LIMIT, 20), 10 * 60_000);
const globalLimiter = rateLimiter(intEnv(process.env.DEEDLORDS_LLM_GLOBAL_LIMIT, 300), 60 * 60_000);

const refuse = (status: number, error: string) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return refuse(400, "send JSON: { id, seat }");
  }
  const { id, seat, style, model, playbook: rawPlaybook } = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (typeof id !== "string" || !MATCH_ID.test(id) || typeof seat !== "number" || !Number.isInteger(seat) || seat < 0 || seat > 5) return refuse(400, "send JSON: { id, seat }");
  if (style !== undefined && (typeof style !== "string" || style.length > MAX_STYLE)) return refuse(400, `style: at most ${MAX_STYLE} characters`);
  if (model !== undefined && typeof model !== "string") return refuse(400, "model: a name from GET /api/agent/playbook");
  const playbook = rawPlaybook === undefined ? undefined : cleanPlaybook(rawPlaybook);
  if (playbook === null) return refuse(400, "playbook: not a playbook");
  // A model the server does not offer is refused rather than swapped for another: its owner asked for that one.
  const llm = model === RULES_MODEL ? null : llmFor(process.env, model);
  if (model !== undefined && model !== RULES_MODEL && !llm && llmConfig(process.env)) return refuse(400, `model ${model} is not offered here`);

  let match: ChainMatch | null;
  try {
    match = await chainClient.view<ChainMatch | null>("get_match", { id });
  } catch {
    return refuse(502, `cannot reach ${CHAIN.network}`);
  }
  if (!match) return refuse(404, `no open match ${id}`);
  if (match.meta.status !== "playing" || match.meta.current_seat !== seat) return refuse(409, "it is not this seat's turn");

  const turnKey = `${match.game.rolls}:${match.game.round}:${match.game.stage}`;
  const known = book.recall(id, seat, turnKey);
  if (known) return Response.json(known, { headers: { "cache-control": "no-store" } });
  // Asked again while the model is still thinking: the same answer, not a second request.
  const ticket = `${id}:${seat}:${turnKey}`;
  let pending = asking.get(ticket);
  if (!pending) {
    // Over budget: the playbook or the rule bot plays this turn instead of a model, same as a model that failed.
    const overBudget = llm !== null && !underBudget(perIpLimiter, globalLimiter, clientKey(request));
    const live = match;
    pending = advise(live, seat, { llm: overBudget ? null : llm, style: style as string | undefined, playbook })
      .then((advice) => {
        if (advice && overBudget) Object.assign(advice, { fallback: true, problem: "the model is answering too many requests right now" });
        if (advice) book.remember(id, seat, turnKey, live.game.round, advice, Date.now());
        return advice;
      })
      .finally(() => asking.delete(ticket));
    asking.set(ticket, pending);
  }
  const advice = await pending;
  if (!advice) return refuse(409, "this seat is not in the game");
  return Response.json(advice, { headers: { "cache-control": "no-store" } });
}

export function GET(request: Request): Response {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!MATCH_ID.test(id)) return refuse(400, "ask with ?id=<match>");
  return Response.json({ notes: book.notes(id), model: llmConfig(process.env)?.label ?? null }, { headers: { "cache-control": "no-store" } });
}
