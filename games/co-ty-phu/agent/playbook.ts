// A playbook: the handful of rules an owner gives their agent. Each turn the rules are turned into the plan the
// contract takes (see plan.ts), with arithmetic alone, so an agent with a playbook and no model still plays, and a
// model that is asked gets the playbook as its owner's instructions. A model can also write a playbook from a wish in
// plain words; the owner then adjusts it by hand.

import { SQUARES, isOwnable } from "../board.ts";
import type { Brief, Holding } from "./brief.ts";
import type { Plan } from "./plan.ts";
import { ticketPlan, withPurchases } from "./tickets.ts";

export const BUILD_ORDERS = ["payback", "priciest", "cheapest", "none"] as const;
export const BAIL_RULES = ["smart", "always", "never"] as const;
export const SELL_ORDERS = ["least-earning", "cheapest", "priciest"] as const;
export type BuildOrder = (typeof BUILD_ORDERS)[number];
export type BailRule = (typeof BAIL_RULES)[number];
export type SellOrder = (typeof SELL_ORDERS)[number];

export type Playbook = {
  /** Cash kept back whatever happens: nothing is bought that would leave less. */
  reserve: number;
  /** How much of the largest rent within two rolls is covered: 0 ignores it, 1 keeps all of it, more keeps a margin. */
  caution: number;
  /** Which of the agent's cities get the next house first. */
  build: BuildOrder;
  /** Extra cash a house must leave on top of what buying must leave: above 0, squares come before houses. */
  cushion: number;
  /** Leaving custody. `smart`: pay while squares are still for sale and the game is not about to end. */
  bail: BailRule;
  /** What is sold and mortgaged first when a debt cannot be paid from cash. */
  sell: SellOrder;
};

export const MAX_RESERVE = 1000;
export const MAX_CAUTION = 2;
export const MAX_CUSHION = 500;

/** What the rule bot does (ev.ts), written as a playbook. */
export const DEFAULT_PLAYBOOK: Playbook = {
  reserve: 150,
  caution: 1,
  build: "payback",
  cushion: 0,
  bail: "smart",
  sell: "least-earning",
};

/** Starting points, for an owner with no model at hand or no wish yet. */
export const PRESETS: {
  id: string;
  name: string;
  line: string;
  book: Playbook;
}[] = [
  {
    id: "book",
    name: "By the book",
    line: "Cover the worst rent ahead, spend the rest.",
    book: DEFAULT_PLAYBOOK,
  },
  {
    id: "landlord",
    name: "Careful landlord",
    line: "A deep reserve; houses only where they pay back.",
    book: {
      reserve: 300,
      caution: 1.5,
      build: "payback",
      cushion: 100,
      bail: "smart",
      sell: "least-earning",
    },
  },
  {
    id: "grabber",
    name: "Land grabber",
    line: "Buy every square it can; houses wait.",
    book: {
      reserve: 0,
      caution: 0.5,
      build: "payback",
      cushion: 250,
      bail: "always",
      sell: "priciest",
    },
  },
  {
    id: "builder",
    name: "Builder",
    line: "Stack houses on the dearest cities first.",
    book: {
      reserve: 100,
      caution: 1,
      build: "priciest",
      cushion: 0,
      bail: "smart",
      sell: "cheapest",
    },
  },
];

const between = (value: unknown, max: number, step: number): number | null =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(0, Math.round(value / step) * step)) : null;

const oneOf = <T extends string>(value: unknown, list: readonly T[]): T | null => (list.includes(value as T) ? (value as T) : null);

/** A playbook from whatever a model or a saved profile holds; `null` when it is not one. Numbers are clamped and rounded. */
export function cleanPlaybook(raw: unknown): Playbook | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const answer = raw as Record<string, unknown>;
  const reserve = between(answer.reserve, MAX_RESERVE, 10);
  const caution = between(answer.caution, MAX_CAUTION, 0.25);
  const cushion = between(answer.cushion ?? 0, MAX_CUSHION, 10);
  const build = oneOf(answer.build, BUILD_ORDERS);
  const bail = oneOf(answer.bail, BAIL_RULES);
  const sell = oneOf(answer.sell, SELL_ORDERS);
  if (reserve === null || caution === null || cushion === null || !build || !bail || !sell) return null;
  return { reserve, caution, build, cushion, bail, sell };
}

/** What a house earns before the end, per unit of its cost. */
function payback(holding: Holding): number {
  if (holding.houseCost === null || holding.rentWithHouse === null) return 0;
  return ((holding.rentWithHouse - holding.rent) * holding.visits) / holding.houseCost;
}

const priceOf = (holding: Holding): number => {
  const square = SQUARES[holding.square];
  return isOwnable(square) ? square.price : 0;
};

/** This turn's plan under the playbook, and one sentence saying what it will do. */
export function playbookPlan(brief: Brief, book: Playbook): { plan: Plan; reason: string } {
  const covered = Math.round(book.caution * (brief.threat?.amount ?? 0));
  const reserve = Math.max(book.reserve, covered);
  const cities = brief.holdings.filter((holding) => holding.kind === "city" && holding.houseCost !== null);
  // In Blitz a house is worth a quarter less than it costs, so it has to earn that back.
  const worthIt = brief.blitz ? 0.25 : 0;
  const build =
    book.build === "none"
      ? []
      : book.build === "payback"
        ? cities.filter((holding) => payback(holding) > worthIt).sort((a, b) => payback(b) - payback(a))
        : [...cities].sort((a, b) => (book.build === "priciest" ? priceOf(b) - priceOf(a) : priceOf(a) - priceOf(b)));
  // `smart`: out of custody while there is something left to buy and time to earn from it; otherwise custody is free shelter.
  const bail =
    book.bail === "always"
      ? brief.releaseCards > 0 || brief.cash >= brief.fine
      : book.bail === "smart" && brief.forSale >= 3 && (brief.turnsLeft === null || brief.turnsLeft > 1) && brief.cash - brief.fine >= reserve;
  const liquidate = [...brief.holdings]
    .sort((a, b) => (book.sell === "least-earning" ? a.rent * a.visits - b.rent * b.visits : book.sell === "cheapest" ? priceOf(a) - priceOf(b) : priceOf(b) - priceOf(a)))
    .map((holding) => holding.square);

  const parts = [
    covered > book.reserve && brief.threat ? `Keep ${reserve} for ${brief.threat.name} (rent ${brief.threat.amount}, ${brief.threat.steps} ahead)` : `Keep ${reserve} back`,
    "buy what leaves that much",
  ];
  if (build.length > 0) parts.push(`build ${build[0].name} first`);
  if (brief.inCustody) parts.push(bail ? "pay my way out" : "sit out in custody");
  // In a match with tickets: the ones worth playing this turn (tickets.ts). A plan that plays none has no such key.
  const { tickets, says } = ticketPlan(brief, reserve);
  parts.push(...says);
  return {
    plan: {
      buy_reserve: reserve,
      build: withPurchases(brief, build.map((holding) => holding.square), book.build !== "none"),
      keep_reserve: reserve + book.cushion,
      bail,
      liquidate,
      ...(Object.keys(tickets).length > 0 ? { tickets } : {}),
    },
    reason: `${parts.join("; ")}.`,
  };
}

const BUILD_WORDS: Record<BuildOrder, string> = {
  payback: "Build where a house pays back most",
  priciest: "Build the dearest cities first",
  cheapest: "Build the cheapest cities first",
  none: "Never build",
};
const BAIL_WORDS: Record<BailRule, string> = {
  smart: "Pay bail while squares are for sale",
  always: "Always pay bail",
  never: "Sit out custody",
};
const SELL_WORDS: Record<SellOrder, string> = {
  "least-earning": "In debt, sell what earns least",
  cheapest: "In debt, sell the cheapest first",
  priciest: "In debt, sell the dearest first",
};

/** The playbook as short rules, for the owner to read at a glance. */
export function describePlaybook(book: Playbook): string[] {
  const rules = [`Keep ${book.reserve} in reserve`];
  if (book.caution > 0) rules.push(book.caution === 1 ? "Cover the worst rent ahead" : `Cover ${book.caution}× the worst rent ahead`);
  rules.push(book.cushion > 0 && book.build !== "none" ? `${BUILD_WORDS[book.build]}, leaving ${book.cushion} more` : BUILD_WORDS[book.build]);
  rules.push(BAIL_WORDS[book.bail], SELL_WORDS[book.sell]);
  return rules;
}

/** The playbook as one instruction to a model that plays the seat. */
export function playbookStyle(book: Playbook): string {
  return `${describePlaybook(book).join(". ")}.`;
}
