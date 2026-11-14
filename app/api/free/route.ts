// Opening a free table. POST { rounds?, opponent?, agents?, host?, seats? }: the sponsor creates a match with nothing staked and
// answers its id; the visitor then takes the first seat through the relayer (/api/relay). `opponent: "agent"`: the
// sponsor also sits in every other seat and its agents play them (/api/free/move), one to three of them, each with
// the model named in `agents` (a model this server offers, or "rules"); otherwise the seat waits for whoever gets the
// link. With `host` (and up to four `seats`) that table is a room: it starts when its host says so.
// POST { seatAgentAt: <id> }: the sponsor's agent takes a free seat of a free room that is still boarding, for whoever
// is waiting there for friends who do not come. It plays by the server's house model.
//
// The sponsor pays a table's storage deposit and gets it back when the match is settled, or when a lobby nobody
// joined is abandoned, which this route does for its own old lobbies before it opens another.

import { clientKey } from "@/games/co-ty-phu/agent/rateLimit";
import { RULES_MODEL, llmModels } from "@/games/co-ty-phu/agent/llm";
import { freeTableCalls, inTransactions, joinCalls, newMatchId, ROUND_CHOICES, roundsFor, SEAT_COUNTS, TURN_SECONDS } from "@/games/co-ty-phu/chain/calls";
import {
  MAX_FREE_TABLES,
  MAX_HOUSE_AGENTS,
  idWithHouseSeats,
  jsonAnswer,
  limits,
  rememberHouseSeats,
  rememberSponsored,
  sponsoredTables,
  tidyFreeTables,
} from "@/games/co-ty-phu/chain/freeDesk";
import { CHAIN, MOVE_GAS } from "@/lib/chain/config";
import { chainClient } from "@/lib/chain/shared";
import type { ChainMatch } from "@/games/co-ty-phu/chain/types";
import { sponsor } from "@/lib/chain/sponsor";

export const dynamic = "force-dynamic";
/** Room for up to two transactions and a re-read after a node's timeout, on a host that limits how long a request may run. */
export const maxDuration = 60;

const ACCOUNT_ID = /^(?:[0-9a-f]{64}|(?=.{2,64}$)[a-z0-9]+(?:[-_.][a-z0-9]+)*)$/;
/** The contract lets anyone abandon a lobby 15 minutes after it was created; a little longer, for clocks that differ. */
const ABANDON_GAS = 30_000_000_000_000n;
/**
 * How long whoever asked for a table waits while older tables are tidied. The sponsor's key sends one transaction at a
 * time, a couple of seconds each, so seven of them ahead of a new table once ran the request past its time limit (a
 * gateway's 504 instead of a table). What is left is tidied for the next visitor.
 */
const TIDY_BUDGET_MS = 6_000;
const text = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Whether every call of `batch` shows on the table: it was created, and each seat it joins is the sponsor's. */
async function landed(id: string, batch: { method: string; args: Uint8Array }[], sponsorId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise((done) => setTimeout(done, 2_000));
    const match = await chainClient.view<ChainMatch | null>("get_match", { id }).catch(() => null);
    if (!match) continue;
    const seats = batch.filter((call) => call.method === "join").map((call) => (JSON.parse(new TextDecoder().decode(call.args)) as { seat: number }).seat);
    if (seats.every((seat) => match.meta.seats[seat]?.backer === sponsorId)) return true;
  }
  return false;
}

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
  if (body.seatAgentAt !== undefined) return seatAgent(paying, body.seatAgentAt, request);
  if (body.opponent !== undefined && body.opponent !== "agent" && body.opponent !== "friend") return jsonAnswer(400, { error: "opponent: agent or friend" });
  const withAgent = body.opponent !== "friend";
  // Against the house: one agent per model asked for (one with the house model when none is), each in its own seat.
  const offered = new Set([RULES_MODEL, ...llmModels(process.env)]);
  const houseModel = process.env.DEEDLORDS_HOUSE_MODEL?.trim() || RULES_MODEL;
  // In a room of friends the house plays no seat unless asked to: `agents` names the model of each seat it takes.
  const agents = body.agents === undefined ? (withAgent ? [houseModel] : []) : body.agents;
  if (!Array.isArray(agents) || agents.length < (withAgent ? 1 : 0) || agents.length > MAX_HOUSE_AGENTS || agents.some((model) => typeof model !== "string" || !offered.has(model)))
    return jsonAnswer(400, { error: `agents: ${withAgent ? 1 : 0} to ${MAX_HOUSE_AGENTS} of ${[...offered].join(", ")}` });
  // A table for friends is a room: whoever asked for it hosts it, and it may seat up to four.
  const seats = withAgent ? 1 + (agents as string[]).length : body.seats === undefined ? 2 : body.seats;
  if (typeof seats !== "number" || !SEAT_COUNTS.includes(seats)) return jsonAnswer(400, { error: "seats: 2, 3 or 4" });
  const rounds = body.rounds === undefined ? roundsFor(seats) : body.rounds;
  if (typeof rounds !== "number" || !ROUND_CHOICES.includes(rounds)) return jsonAnswer(400, { error: `rounds: one of ${ROUND_CHOICES.join(", ")}` });
  if (body.host !== undefined && (typeof body.host !== "string" || !ACCOUNT_ID.test(body.host))) return jsonAnswer(400, { error: "host: a NEAR account" });
  const room = !withAgent && typeof body.host === "string" ? { host: body.host, seats } : null;
  if (!withAgent && seats !== 2 && !room) return jsonAnswer(400, { error: "a table of more than two seats needs a host" });
  // A room keeps a seat for its host and one for a friend: with every other seat an agent's, it is a table against the house.
  if (!withAgent && agents.length > 0 && (!room || agents.length > seats - 2)) return jsonAnswer(400, { error: "agents in a room: its host, at least one free seat, and the rest" });
  if (!limits.tablePerIp.allow(clientKey(request)) || !limits.tableGlobal.allow("*"))
    return jsonAnswer(429, { error: "too many free tables opened from here: wait a few minutes" });

  try {
    const tables = await sponsoredTables(paying);
    // Tables people left hold the sponsor's deposit and a place each: lobbies are abandoned, and at tables under way
    // the house gives up its seats, which ends them. A few at a time, while somebody waits for a table.
    const { abandon, resign, open } = tidyFreeTables(tables, paying.accountId, Date.now());
    const tidying: (() => Promise<unknown>)[] = [
      ...abandon.slice(0, 4).map((id) => () => paying.session.call("abandon", { id }, ABANDON_GAS)),
      ...resign.slice(0, 3).flatMap(({ id, seats }) => seats.map((seat) => () => paying.session.call("play", { id, seat, actions: ["Resign"] }, MOVE_GAS))),
    ];
    const until = Date.now() + TIDY_BUDGET_MS;
    for (const tidy of tidying) {
      if (Date.now() >= until) break;
      await tidy().catch(() => undefined);
    }
    if (open >= MAX_FREE_TABLES) return jsonAnswer(429, { error: "every free table is taken right now: join one from the board, or try again in a few minutes" });
  } catch {
    return jsonAnswer(502, { error: `cannot reach ${CHAIN.network}` });
  }

  const models = agents as string[];
  const id = idWithHouseSeats(`f${newMatchId().slice(1)}`, models, [...offered]);
  try {
    // Three agents' seats and the table do not fit the gas of one transaction: they go in turn.
    let hash = "";
    for (const batch of inTransactions(freeTableCalls(id, rounds, TURN_SECONDS, withAgent, room, models.length))) {
      try {
        const outcome = await paying.session.transact(batch);
        hash ||= outcome.hash;
      } catch (error) {
        // A public node may give up waiting (HTTP 408, a timeout) on a transaction that did land: read the table.
        if (!(await landed(id, batch, paying.accountId))) throw error;
      }
    }
    rememberSponsored(id, paying);
    if (models.length) rememberHouseSeats(id, Object.fromEntries(models.map((model, i) => [1 + i, model])));
    return jsonAnswer(200, { id, opponent: withAgent ? "agent" : "friend", sponsor: paying.accountId, hash, agents: models });
  } catch (error) {
    return jsonAnswer(502, { error: `the sponsor could not open a table: ${text(error)}` });
  }
}

const MATCH_ID = /^[A-Za-z0-9_-]{1,32}$/;

/** The sponsor's agent takes the first free seat of a free room of the sponsor's that has not started. */
async function seatAgent(paying: NonNullable<ReturnType<typeof sponsor>>, id: unknown, request: Request): Promise<Response> {
  if (typeof id !== "string" || !MATCH_ID.test(id)) return jsonAnswer(400, { error: "seatAgentAt: a match id" });
  if (!limits.tablePerIp.allow(clientKey(request)) || !limits.tableGlobal.allow("*")) return jsonAnswer(429, { error: "too many seats asked for from here: wait a few minutes" });
  let match: ChainMatch | null;
  try {
    match = await chainClient.view<ChainMatch | null>("get_match", { id });
  } catch {
    return jsonAnswer(502, { error: `cannot reach ${CHAIN.network}` });
  }
  if (!match || match.meta.stake !== "0" || match.meta.creator !== paying.accountId) return jsonAnswer(403, { error: `${id} is not a free table of this server` });
  if (match.meta.status !== "lobby") return jsonAnswer(409, { error: "the game has started" });
  const { seats } = match.meta;
  const free = seats.find((seat) => seat.backer === null);
  if (!free) return jsonAnswer(409, { error: "every seat is taken" });
  // The house keeps people company: it does not sit at a table nobody is at, nor take more seats than a table against it has.
  if (!seats.some((seat) => seat.backer !== null && seat.backer !== paying.accountId)) return jsonAnswer(409, { error: "the house sits down with players, not alone" });
  if (seats.filter((seat) => seat.backer === paying.accountId).length >= MAX_HOUSE_AGENTS) return jsonAnswer(409, { error: `the house plays at most ${MAX_HOUSE_AGENTS} seats of a table` });
  try {
    const outcome = await paying.session.transact(joinCalls(id, free.seat, 0n));
    rememberSponsored(id, paying);
    return jsonAnswer(200, { id, seat: free.seat, hash: outcome.hash });
  } catch (error) {
    return jsonAnswer(502, { error: `the house could not take the seat: ${text(error)}` });
  }
}
