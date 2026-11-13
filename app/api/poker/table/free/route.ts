// Free poker tables (games/poker/table/house.ts): a stake of nothing, opened and hosted by the account that sponsors
// free play, which also holds seat 0 and plays it. POST { seats, model? }: opens one and answers its id; the visitor
// then takes a seat with a call the sponsor sends for them (app/api/relay). POST { id, start: true }: the host starts
// a table that is not full, which only the host can. Each open table holds 0.25 NEAR of the sponsor's until it
// closes, and a hand costs it the gas of every seat's calls, a shuffle most of all: hence the limits.

import { clientKey, intEnv, rateLimiter } from "@/games/co-ty-phu/agent/rateLimit";
import { FREE_TURN_SECONDS, MAX_SEATS } from "@/games/poker/table/contract";
import { freeHost, houseModels, openFreeTable, startFreeTable } from "@/games/poker/table/house";

export const dynamic = "force-dynamic";
/** Room for a transaction and a re-read after a node's timeout, on a host that limits how long a request may run. */
export const maxDuration = 60;

const TABLE_ID = /^[A-Za-z0-9_-]{1,32}$/;
const tablesPerIp = rateLimiter(intEnv(process.env.POKER_FREE_IP_LIMIT, 4), 10 * 60_000);
const tablesInAll = rateLimiter(intEnv(process.env.POKER_FREE_GLOBAL_LIMIT, 40), 60 * 60_000);
const startsPerIp = rateLimiter(20, 10 * 60_000);
const fresh = { "cache-control": "no-store" };
const answer = (status: number, body: unknown) => Response.json(body, { status, headers: fresh });
const text = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function GET(): Response {
  return answer(200, { host: freeHost()?.accountId ?? null, models: houseModels() });
}

export async function POST(request: Request): Promise<Response> {
  if (!freeHost()) return answer(503, { error: "no free tables on this server" });
  let body: { seats?: unknown; model?: unknown; id?: unknown; start?: unknown } = {};
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed === "object" && parsed !== null) body = parsed as typeof body;
  } catch {
    // No body: a table of two.
  }
  if (body.start === true) {
    if (typeof body.id !== "string" || !TABLE_ID.test(body.id)) return answer(400, { error: "send JSON: { id, start: true }" });
    if (!startsPerIp.allow(clientKey(request))) return answer(429, { error: "asked too often: wait a few minutes" });
    try {
      return answer(200, await startFreeTable(body.id));
    } catch (error) {
      return answer(502, { error: `the host could not start the table: ${text(error)}` });
    }
  }
  const seats = body.seats === undefined ? 2 : body.seats;
  if (typeof seats !== "number" || !Number.isInteger(seats) || seats < 2 || seats > MAX_SEATS) return answer(400, { error: `seats: 2 to ${MAX_SEATS}` });
  if (body.model !== undefined && (typeof body.model !== "string" || !houseModels().includes(body.model)))
    return answer(400, { error: `model: one of ${houseModels().join(", ")}` });
  if (!tablesPerIp.allow(clientKey(request)) || !tablesInAll.allow("*")) return answer(429, { error: "too many free tables opened from here: wait a few minutes" });
  try {
    return answer(200, await openFreeTable(seats, body.model as string | undefined, FREE_TURN_SECONDS));
  } catch (error) {
    const why = text(error);
    const told = /every free table is taken|out of NEAR for free tables/.test(why);
    return answer(told ? 429 : 502, { error: told ? why : `the host could not open a table: ${why}` });
  }
}
