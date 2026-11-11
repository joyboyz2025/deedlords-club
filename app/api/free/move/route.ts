// The house agent's turn at a free table. POST { id }: when the seat to move is the sponsor's, plans its turn (a model
// when DEEDLORDS_HOUSE_MODEL names one the server offers, else the default playbook) and signs `turn` with the
// sponsor's key. Nothing runs between requests: whoever has the match open asks, and a turn is played once however
// many ask. That makes an opponent for a visitor who came alone, on a server that keeps no process running.

import { advise, type Advice } from "@/games/co-ty-phu/agent/advise";
import { llmFor, RULES_MODEL } from "@/games/co-ty-phu/agent/llm";
import { DEFAULT_PLAYBOOK } from "@/games/co-ty-phu/agent/playbook";
import { clientKey, intEnv, rateLimiter } from "@/games/co-ty-phu/agent/rateLimit";
import { book } from "@/games/co-ty-phu/agent/shelf";
import { isFreeTable, jsonAnswer, limits } from "@/games/co-ty-phu/chain/freeDesk";
import { MATCH_ID } from "@/games/co-ty-phu/chain/relayRules";
import type { ChainMatch } from "@/games/co-ty-phu/chain/types";
import { isContractFailure } from "@/lib/chain/client";
import { CHAIN } from "@/lib/chain/config";
import { chainClient } from "@/lib/chain/shared";
import { sponsor } from "@/lib/chain/sponsor";

export const dynamic = "force-dynamic";

type Played = { played: true; hash: string; driver: string; reason: string } | { played: false; why: string };

// A turn on its way, and the turns just played: a node may answer from the block before for a moment, and the same
// turn must not be planned (or paid for) twice.
const playing = new Map<string, Promise<Played>>();
const done = new Map<string, number>();
const DONE_FOR_MS = 20_000;
/** The house agent's own ceiling on model calls an hour; past it, it plays by its playbook. */
const modelBudget = rateLimiter(intEnv(process.env.DEEDLORDS_LLM_GLOBAL_LIMIT, 300), 60 * 60_000);
const text = (error: unknown) => (error instanceof Error ? error.message : String(error));

function houseModel() {
  const name = process.env.DEEDLORDS_HOUSE_MODEL?.trim();
  return !name || name === RULES_MODEL ? null : llmFor(process.env, name);
}

export async function POST(request: Request): Promise<Response> {
  const paying = sponsor();
  if (!paying) return jsonAnswer(503, { error: "nobody sponsors play on this server" });
  let id: unknown;
  try {
    id = ((await request.json()) as { id?: unknown } | null)?.id;
  } catch {
    id = undefined;
  }
  if (typeof id !== "string" || !MATCH_ID.test(id)) return jsonAnswer(400, { error: "send JSON: { id }" });
  if (!limits.movePerIp.allow(clientKey(request))) return jsonAnswer(429, { error: "asked too often: wait a few minutes" });

  let match: ChainMatch | null;
  try {
    match = await chainClient.view<ChainMatch | null>("get_match", { id });
  } catch {
    return jsonAnswer(502, { error: `cannot reach ${CHAIN.network}` });
  }
  if (!match) return jsonAnswer(404, { error: `no open match ${id}` });
  if (!isFreeTable(match.meta, paying)) return jsonAnswer(403, { error: `${id} is not a free table of this server` });
  const seat = match.meta.current_seat;
  if (match.meta.status !== "playing" || seat === null || match.meta.seats[seat]?.backer !== paying.accountId)
    return jsonAnswer(200, { played: false, why: "it is not the house agent's turn" } satisfies Played);

  const turnKey = `${match.game.rolls}:${match.game.round}:${match.game.stage}`;
  const ticket = `${id}:${seat}:${turnKey}`;
  if ((done.get(ticket) ?? 0) > Date.now()) return jsonAnswer(200, { played: false, why: "that turn is already played" } satisfies Played);
  let pending = playing.get(ticket);
  if (!pending) {
    const live = match;
    pending = (async (): Promise<Played> => {
      const model = houseModel();
      const advice: Advice | null = await advise(live, seat, { llm: model && modelBudget.allow("*") ? model : null, playbook: DEFAULT_PLAYBOOK });
      if (!advice) return { played: false, why: "the house agent is out of the game" };
      try {
        const outcome = await paying.session.call("turn", { id, seat, plan: advice.plan });
        book.remember(id, seat, turnKey, live.game.round, advice, Date.now(), { open: true });
        if (done.size > 500) for (const [key, until] of done) if (until <= Date.now()) done.delete(key);
        done.set(ticket, Date.now() + DONE_FOR_MS);
        return { played: true, hash: outcome.hash, driver: advice.driver, reason: advice.reason };
      } catch (error) {
        // Refused by the contract (somebody forced the turn first, say): nothing changed, and the next request reads the match again.
        return { played: false, why: isContractFailure(error) ? `the contract refused the turn: ${error.message}` : `the turn could not be sent: ${text(error)}` };
      }
    })().finally(() => playing.delete(ticket));
    playing.set(ticket, pending);
  }
  return jsonAnswer(200, await pending);
}
