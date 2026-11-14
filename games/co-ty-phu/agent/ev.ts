// The rule bot: a plan from arithmetic alone. It is what plays when no model is configured, and what an LLM agent falls
// back to when the model is late or answers something that is not a plan.
//
// The game ends on net worth, where a square counts at its price and a house at its cost (three quarters in Blitz): so
// buying and building cost nothing in the ranking and every rent is a gain. What loses a game is running out of cash:
// a mortgage halves a square and the bank buys houses back at half. So the bot spends freely down to a reserve that
// covers the largest rent it could owe within two rolls.

import type { Brief, Holding } from "./brief.ts";
import type { Plan } from "./plan.ts";
import { ticketPlan } from "./tickets.ts";

/** Cash kept back when nothing threatens: enough for a tax square. */
const FLOOR = 150;

/** What a house earns before the end, per unit of its cost. */
function payback(holding: Holding): number {
  if (holding.houseCost === null || holding.rentWithHouse === null) return 0;
  return ((holding.rentWithHouse - holding.rent) * holding.visits) / holding.houseCost;
}

export function evPlan(brief: Brief): { plan: Plan; reason: string } {
  const reserve = Math.max(FLOOR, brief.threat?.amount ?? 0);
  // In Blitz a house is worth a quarter less than it costs, so it has to earn that back.
  const worthIt = brief.blitz ? 0.25 : 0;
  const build = brief.holdings
    .filter((holding) => holding.kind === "city" && payback(holding) > worthIt)
    .sort((a, b) => payback(b) - payback(a));
  // Out of custody while there is something left to buy and time to earn from it; otherwise custody is free shelter.
  const bail = brief.forSale >= 3 && (brief.turnsLeft === null || brief.turnsLeft > 1) && brief.cash - brief.fine >= reserve;
  // First to go when in debt: houses on what earns least, then the squares themselves, cheapest rent first.
  const liquidate = [...brief.holdings].sort((a, b) => a.rent * a.visits - b.rent * b.visits).map((holding) => holding.square);

  const parts = [
    brief.threat ? `Keep ${reserve} for ${brief.threat.name} (rent ${brief.threat.amount}, ${brief.threat.steps} ahead)` : `Nothing to fear within two rolls: keep ${reserve}`,
    "buy what leaves that much",
  ];
  if (build.length > 0) parts.push(`build ${build[0].name} first`);
  if (brief.inCustody) parts.push(bail ? "pay my way out" : "sit out in custody");
  const { tickets, says } = ticketPlan(brief, reserve);
  parts.push(...says);
  return {
    plan: { buy_reserve: reserve, build: build.map((holding) => holding.square), keep_reserve: reserve, bail, liquidate, ...(Object.keys(tickets).length > 0 ? { tickets } : {}) },
    reason: `${parts.join("; ")}.`,
  };
}
