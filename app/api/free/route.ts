// Opening a free table. POST { rounds?, opponent? }: the sponsor creates a two-seat match with nothing staked and
// answers its id; the visitor then takes the first seat through the relayer (/api/relay). `opponent: "agent"`: the
// sponsor also sits in the second seat and its agent plays it (/api/free/move); otherwise the seat waits for whoever
// gets the link.
//
// The sponsor pays a table's storage deposit and gets it back when the match is settled, or when a lobby nobody
// joined is abandoned, which this route does for its own old lobbies before it opens another.

import { clientKey } from "@/games/co-ty-phu/agent/rateLimit";
import { freeTableCalls, newMatchId } from "@/games/co-ty-phu/chain/calls";
import { MAX_FREE_TABLES, jsonAnswer, limits, rememberSponsored, sponsoredTables } from "@/games/co-ty-phu/chain/freeDesk";
import { CHAIN } from "@/lib/chain/config";
import { sponsor } from "@/lib/chain/sponsor";

export const dynamic = "force-dynamic";

const ROUNDS = [3, 6, 12];
const TURN_SECONDS = 60;
/** The contract lets anyone abandon a lobby 15 minutes after it was created; a little longer, for clocks that differ. */
const ABANDON_AFTER_MS = 16 * 60_000;
const ABANDON_GAS = 30_000_000_000_000n;
const text = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function POST(request: Request): Promise<Response> {
  const paying = sponsor();
  if (!paying) return jsonAnswer(503, { error: "nobody sponsors play on this server" });
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed === "object" && parsed !== null) body = parsed as Record<string, unknown>;
  } catch {
    // No body: the defaults.
  }
  const rounds = body.rounds === undefined ? 6 : body.rounds;
  if (typeof rounds !== "number" || !ROUNDS.includes(rounds)) return jsonAnswer(400, { error: `rounds: one of ${ROUNDS.join(", ")}` });
  if (body.opponent !== undefined && body.opponent !== "agent" && body.opponent !== "friend") return jsonAnswer(400, { error: "opponent: agent or friend" });
  const withAgent = body.opponent !== "friend";
  if (!limits.tablePerIp.allow(clientKey(request)) || !limits.tableGlobal.allow("*"))
    return jsonAnswer(429, { error: "too many free tables opened from here: wait a few minutes" });

  try {
    const tables = await sponsoredTables(paying);
    const stale = tables.filter((meta) => meta.status === "lobby" && Number(BigInt(meta.created_at) / 1_000_000n) + ABANDON_AFTER_MS < Date.now());
    const closed = await Promise.allSettled(stale.slice(0, 4).map((meta) => paying.session.call("abandon", { id: meta.id }, ABANDON_GAS)));
    const open = tables.length - closed.filter((result) => result.status === "fulfilled").length;
    if (open >= MAX_FREE_TABLES) return jsonAnswer(429, { error: "every free table is taken right now: join one from the board, or try again in a few minutes" });
  } catch {
    return jsonAnswer(502, { error: `cannot reach ${CHAIN.network}` });
  }

  const id = `f${newMatchId().slice(1)}`;
  try {
    const outcome = await paying.session.transact(freeTableCalls(id, rounds, TURN_SECONDS, withAgent));
    rememberSponsored(id, paying);
    return jsonAnswer(200, { id, opponent: withAgent ? "agent" : "friend", sponsor: paying.accountId, hash: outcome.hash });
  } catch (error) {
    return jsonAnswer(502, { error: `the sponsor could not open a table: ${text(error)}` });
  }
}
