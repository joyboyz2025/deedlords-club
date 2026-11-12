// The house's seat at a poker table (games/poker/house.ts). GET: the account that plays it, or null when this server
// has none. POST { id, deal? }: one step: the house takes the open seat of table `id`, or does what that table is
// waiting for from it; `deal: true` tells it the player wants the next hand dealt. The tab that has the table open
// asks, for speed; the house also looks at its tables by itself, so it does not depend on being asked.

import { clientKey, rateLimiter } from "@/games/co-ty-phu/agent/rateLimit";
import { STAKE } from "@/games/poker/contract";
import { house, houseStep, watch } from "@/games/poker/house";

export const dynamic = "force-dynamic";

const MATCH_ID = /^[A-Za-z0-9_-]{1,32}$/;
// Every table the house joins holds a stake of its money until the table is settled.
const joinsPerIp = rateLimiter(6, 10 * 60_000);
const joinsInAll = rateLimiter(60, 60 * 60_000);
const fresh = { "cache-control": "no-store" };

export function GET(): Response {
  watch();
  return Response.json({ house: house()?.accountId ?? null, stake: STAKE.toString(), model: process.env.DEEDLORDS_HOUSE_MODEL?.trim() || null }, { headers: fresh });
}

export async function POST(request: Request): Promise<Response> {
  if (!house()) return Response.json({ error: "no house plays on this server" }, { status: 503, headers: fresh });
  let body: { id?: unknown; deal?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // No body: refused below.
  }
  const { id, deal } = body;
  if (typeof id !== "string" || !MATCH_ID.test(id)) return Response.json({ error: "send JSON: { id }" }, { status: 400, headers: fresh });
  watch();
  const mayJoin = () => joinsPerIp.allow(clientKey(request)) && joinsInAll.allow("*");
  return Response.json(await houseStep(id, { mayJoin, deal: deal === true }), { headers: fresh });
}
