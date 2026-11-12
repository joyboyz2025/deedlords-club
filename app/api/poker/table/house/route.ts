// The house's seats at a poker table of two to nine seats (games/poker/table/house.ts). GET: the accounts that play
// them (none when this server has no house), the models a house seat may be given, and with `?id=` the model of each
// house seat at that table. POST { id, add?, model? }: one step: with `add: true` a house account takes a free seat
// of table `id`, betting by `model` (one of those offered; the server's house model when not given); otherwise the
// house's seats there do what the table is waiting for from them. The tab that has the table open asks, for speed;
// the house also looks at its tables by itself.

import { clientKey, rateLimiter } from "@/games/co-ty-phu/agent/rateLimit";
import { STAKE } from "@/games/poker/table/contract";
import { houseModels, houseStep, houses, modelsAt, watch } from "@/games/poker/table/house";

export const dynamic = "force-dynamic";

const TABLE_ID = /^[A-Za-z0-9_-]{1,32}$/;
// Every seat the house takes holds a stake of its money until the seat is given up.
const joinsPerIp = rateLimiter(12, 10 * 60_000);
const joinsInAll = rateLimiter(90, 60 * 60_000);
const fresh = { "cache-control": "no-store" };

export function GET(request: Request): Response {
  watch();
  const accounts = houses().map((one) => one.accountId);
  const id = new URL(request.url).searchParams.get("id");
  const seats = id && TABLE_ID.test(id) ? modelsAt(id, accounts) : undefined;
  return Response.json({ houses: accounts, stake: STAKE.toString(), model: process.env.DEEDLORDS_HOUSE_MODEL?.trim() || null, models: houseModels(), seats }, { headers: fresh });
}

export async function POST(request: Request): Promise<Response> {
  if (!houses().length) return Response.json({ error: "no house plays on this server" }, { status: 503, headers: fresh });
  let body: { id?: unknown; add?: unknown; model?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // No body: refused below.
  }
  const { id, add, model } = body;
  if (typeof id !== "string" || !TABLE_ID.test(id)) return Response.json({ error: "send JSON: { id }" }, { status: 400, headers: fresh });
  if (model !== undefined && (typeof model !== "string" || !houseModels().includes(model))) return Response.json({ error: `model: one of ${houseModels().join(", ")}` }, { status: 400, headers: fresh });
  watch();
  const mayJoin = () => joinsPerIp.allow(clientKey(request)) && joinsInAll.allow("*");
  return Response.json(await houseStep(id, { add: add === true, model: model as string | undefined, mayJoin }), { headers: fresh });
}
