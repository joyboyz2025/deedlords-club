// The tickets a rule-based agent plays (docs/ENGINE-RULES.md §10), from the same brief a model gets. It is what the
// playbook and the rule bot add to their plan in a match with tickets, so a seat with no model, or whose model is
// late, still plays them. A plan is written before the dice are thrown: it says which tickets to play before the
// throw, how many steps to take instead of it, and which cities to take over should the seat stop on one.

import { SQUARES } from "../board.ts";
import { diceChance, type Brief, type Reach } from "./brief.ts";
import type { TicketPlan } from "./plan.ts";

/** A roll must be expected to cost this much rent before a Rent waiver is spent on it. */
const WAIVER_WORTH = 40;
/** Choosing the steps must beat the dice by this much before the ticket is spent. */
const STEPS_WORTH = 80;
/** The others' next rolls must be expected to pay this much rent before a Festival is called. */
const FESTIVAL_WORTH = 15;
/** Being sent to custody, in coins: a turn or two without moving. */
const ARREST_COST = 150;
/** A square for sale that the seat can afford is worth this share of its price to land on. */
const FREE_SHARE = 0.25;
/** A Takeover in Blitz: only with this many turns left to build on the city and earn from it. */
const TAKEOVER_TURNS = 4;

/** What ending a throw on `reach` is worth to the seat, in coins. */
function worth(brief: Brief, reach: Reach, reserve: number): number {
  const lap = brief.position + reach.steps >= SQUARES.length ? brief.salary : 0;
  if (reach.what === "rent" || reach.what === "tax") return lap - reach.amount;
  if (reach.what === "arrest") return -ARREST_COST;
  if (reach.what === "free") return lap + (brief.cash - reach.amount >= reserve ? Math.round(reach.amount * FREE_SHARE) : 0);
  return lap;
}

/** The tickets to play this turn, and a few words for each one played. Nothing when the seat holds none. */
export function ticketPlan(brief: Brief, reserve: number): { tickets: TicketPlan; says: string[] } {
  const state = brief.tickets;
  if (!state || state.held.length === 0) return { tickets: {}, says: [] };
  const tickets: TicketPlan = {};
  const says: string[] = [];
  const holds = (ticket: (typeof state.held)[number]) => state.held.includes(ticket);
  // A ticket not played is lost when the match ends, and a hand of two draws nothing at Departure.
  const spend = state.held.length >= 2 || (brief.turnsLeft !== null && brief.turnsLeft <= 1);
  const rents = brief.reach.filter((reach) => reach.what === "rent");
  const expected = rents.reduce((sum, reach) => sum + reach.chance * reach.amount, 0);
  const worst = rents.reduce((most, reach) => Math.max(most, reach.amount), 0);

  if (holds("steps") && !brief.inCustody) {
    const dice = brief.reach.reduce((sum, reach) => sum + diceChance(reach.steps) * worth(brief, reach, reserve), 0);
    const best = brief.reach.reduce((top, reach) => (worth(brief, reach, reserve) >= worth(brief, top, reserve) ? reach : top), brief.reach[0]);
    const gain = worth(brief, best, reserve) - dice;
    if (gain >= STEPS_WORTH || (spend && gain > 0)) {
      tickets.steps = best.steps;
      says.push(`pick ${best.steps} steps to ${best.name}`);
    }
  }
  // With the steps chosen the square is known, and it is never one that charges rent when another is to be had.
  if (holds("waiver") && tickets.steps === undefined && !brief.inCustody && (expected >= WAIVER_WORTH || worst >= brief.cash || (spend && expected > 0))) {
    tickets.waiver = true;
    says.push("play the Rent waiver");
  }
  if (holds("festival") && !state.festivalOn) {
    const cities = brief.holdings.filter((holding) => holding.kind === "city" && !holding.mortgaged);
    const income = brief.rivals.reduce(
      (sum, rival) => sum + (rival.inCustody ? 0 : cities.reduce((own, city) => own + diceChance((city.square - rival.position + SQUARES.length) % SQUARES.length) * city.rent, 0)),
      0,
    );
    if (cities.length > 0 && (income >= FESTIVAL_WORTH || spend)) {
      tickets.festival = true;
      says.push("call a Festival");
    }
  }
  if (holds("takeover")) {
    // Paying double is a loss on net worth at first, made good by what is built there: in Blitz any city the reserve
    // allows, while there are turns left to build on it (a city with a house cannot be taken, so the chance is rare: the
    // simulation sees one Takeover in fifteen to thirty matches); in classic rules only a colour group it completes.
    const wanted = state.takeover.filter(
      (city) => brief.cash - city.cost >= reserve && (brief.blitz ? brief.turnsLeft === null || brief.turnsLeft >= TAKEOVER_TURNS : city.completesGroup),
    );
    if (wanted.length > 0) {
      tickets.takeover = wanted.map((city) => city.square);
      says.push("take over a city if I stop on one I can afford");
    }
  }
  return { tickets, says };
}

/**
 * In a match where a city takes its first house in the stop it is bought in: the free cities this roll can reach go
 * on the build list too, after the seat's own (a house there is built only if the city is bought and the reserve allows).
 */
export function withPurchases(brief: Brief, build: number[], builds = true): number[] {
  if (!brief.buildOnBuy || !builds) return build;
  const reachable = brief.reach.filter((spot) => spot.what === "free" && SQUARES[spot.square].kind === "city").map((spot) => spot.square);
  return [...build, ...reachable.filter((square, i) => !build.includes(square) && reachable.indexOf(square) === i)];
}
