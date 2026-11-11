// The agent's desk. POST { id, seat, style? }: a plan for the seat whose turn it is in match `id`, from the model the
// server is configured with (see games/co-ty-phu/agent/llm.ts) or from the rule bot. GET ?id=: who drives which seat of
// the match and the sentence each gave last.
//
// It only advises. The match is read from the chain here, not taken from the caller, and whoever asked signs
// `turn(id, seat, plan)` with their own key: a seat's owner in their tab, or a runner holding an agent account. A
// turn is answered once however often it is asked, so a model is asked at most once per turn played on chain.

import { advise, type Advice } from "@/games/co-ty-phu/agent/advise";
import { AdviceBook } from "@/games/co-ty-phu/agent/book";
import { MAX_STYLE, llmConfig } from "@/games/co-ty-phu/agent/llm";
import type { ChainMatch } from "@/games/co-ty-phu/chain/types";
import { CHAIN } from "@/lib/chain/config";
import { chainClient } from "@/lib/chain/shared";

export const dynamic = "force-dynamic";

const MATCH_ID = /^[A-Za-z0-9_-]{1,32}$/;
// One book for the process, kept across the reloads of a dev server.
const shelf = globalThis as { deedlordsAdvice?: AdviceBook; deedlordsAsking?: Map<string, Promise<Advice | null>> };
const book = (shelf.deedlordsAdvice ??= new AdviceBook());
const asking = (shelf.deedlordsAsking ??= new Map());

const refuse = (status: number, error: string) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return refuse(400, "send JSON: { id, seat }");
  }
  const { id, seat, style } = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (typeof id !== "string" || !MATCH_ID.test(id) || typeof seat !== "number" || !Number.isInteger(seat) || seat < 0 || seat > 5) return refuse(400, "send JSON: { id, seat }");
  if (style !== undefined && (typeof style !== "string" || style.length > MAX_STYLE)) return refuse(400, `style: at most ${MAX_STYLE} characters`);

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
    const live = match;
    pending = advise(live, seat, { llm: llmConfig(process.env), style: style as string | undefined })
      .then((advice) => {
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
