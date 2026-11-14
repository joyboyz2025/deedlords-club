// The contract calls that carry a deposit: opening a match and taking a seat. A session key a wallet added cannot sign
// them, so a wallet does (walletSession.ts); a game account signs them with its own key (keySession.ts); the local
// helpers make the same calls with the keys of their test accounts.

import { type FunctionCall, jsonArgs } from "../../../lib/chain/transaction.ts";

/** What a session key may call: the moves of a match. None of them takes a deposit, and such a key cannot attach one. */
export const SESSION_METHODS = ["play", "turn", "timeout", "set_driver", "leave"] as const;
/** What a session key may burn in gas over its life, in yoctoNEAR: 0.25 NEAR, about 600 moves. */
export const SESSION_ALLOWANCE = "250000000000000000000000";

/**
 * What the key of an account signed in through NEAR Auth may call: the moves, and taking a seat. Such a key cannot
 * attach a deposit, so the only seats it can take are those of a table that costs nothing.
 */
export const GRANT_METHODS = ["join", ...SESSION_METHODS] as const;

const TGAS = 1_000_000_000_000n;
/**
 * `join` may start the game and draw the turn order, so the contract wants at least 100 Tgas on it. Not a gas more:
 * a node sets aside the price of all the gas attached before it runs anything (see `upfront`).
 */
const JOIN_GAS = 100n * TGAS;
/** `create_match` burns about 3 Tgas. */
const CREATE_GAS = 20n * TGAS;
/** What a move attaches: the contract's floor (`MIN_MOVE_GAS`). */
const MOVE_GAS = 100n * TGAS;
/**
 * What a node sets aside per unit of attached gas before it accepts a transaction, in yoctoNEAR: about ten times what
 * the gas ends up costing (seen on testnet, 2026-11-11: 180 Tgas attached, 0.1817 NEAR required). The rest comes back
 * within the same transaction, but the account must have it.
 */
const GAS_HOLD = 1_010_000_000n;
/**
 * Paid by whoever opens a match, for its storage. The contract asks for the measured size plus 4,500 bytes (about
 * 0.05 NEAR at 10^19 yocto a byte) and returns it at settlement, less the bytes of the permanent result.
 */
export const STORAGE_DEPOSIT = 60_000_000_000_000_000_000_000n;

/**
 * `seats`: 2 when not said. `host`: the account that starts the game once every seat is taken; without one the game
 * starts by itself with the last seat.
 */
export type DuelTerms = { stake: bigint; maxRounds: number; turnSeconds: number; seats?: number; host?: string | null; extras?: Extras };

/**
 * The rules a match may be opened with on top of `RULES`, when the contract has them: special tickets, and double rent
 * for whoever leads on net worth (docs/ENGINE-RULES.md §10). A contract deployed before them ignores the fields, so
 * they are sent only to a contract that lists them (`extrasOf`).
 */
export type Extras = { tickets: boolean; leaderRent: boolean };
export const NO_EXTRAS: Extras = { tickets: false, leaderRent: false };

/**
 * What a match is opened with here, from the contract's `get_config`: `features` lists the opt-in rules it knows; an
 * older contract has no such list, and gets today's match. `NEXT_PUBLIC_DEEDLORDS_EXTRAS=off` keeps a deployment of
 * the page on today's match whatever the contract knows (matches already open with the rules play on with them).
 */
export function extrasOf(config: { features?: unknown } | null | undefined, off: boolean = process.env.NEXT_PUBLIC_DEEDLORDS_EXTRAS === "off"): Extras {
  const features = !off && Array.isArray(config?.features) ? config.features : [];
  return { tickets: features.includes("tickets"), leaderRent: features.includes("leaderRent") };
}

/**
 * The rules of every match opened from the web page: Blitz. Each seat is dealt five squares, paid at their price out
 * of `cash`; on its turn a seat may put one house on each of its cities; a match that runs out of rounds is ranked by
 * net worth. They are the rules the contract's own tests play Blitz by. With nothing dealt and a house only where the
 * piece stops (the rules before), a match to the end took about a hundred rounds, forty minutes and more for two, and
 * a house or two went up in twelve rounds: scripts/co-ty-phu-sim.ts measures both.
 */
export const RULES = { salary: 200, cash: 2000, blitz: true } as const;

/** How the pot is shared by rank, in basis points, for a table of that many seats. */
export const SPLITS: Record<number, number[]> = { 2: [7000, 3000], 3: [6000, 3000, 1000], 4: [5000, 3000, 1500, 500] };
export const SEAT_COUNTS = [2, 3, 4];

/** Opens a match. Whoever sends it pays the storage deposit and gets it back at settlement. */
export function createDuelCall(id: string, terms: DuelTerms): FunctionCall {
  const seats = terms.seats ?? 2;
  const create = {
    id,
    seats,
    stake: terms.stake.toString(),
    split: SPLITS[seats] ?? SPLITS[2],
    rules: { ...RULES, max_rounds: terms.maxRounds, ...(terms.extras?.tickets ? { tickets: true } : {}), ...(terms.extras?.leaderRent ? { leaderRent: true } : {}) },
    solo_player: null,
    turn_seconds: terms.turnSeconds,
    ...(terms.host ? { host: terms.host } : {}),
  };
  return { method: "create_match", args: jsonArgs(create), gas: CREATE_GAS, deposit: STORAGE_DEPOSIT };
}

/** One transaction, two calls: open a match and take its first seat. */
export function openDuelCalls(id: string, terms: DuelTerms): FunctionCall[] {
  return [createDuelCall(id, terms), ...joinCalls(id, 0, terms.stake)];
}

/**
 * The host of a hosted match says go, once every seat is taken. Sent as a move (`play` with the one action `Start`),
 * so a key that may only make moves, a session key, can send it.
 */
export function startCall(id: string, seat: number): { method: "play"; args: { id: string; seat: number; actions: ["Start"] } } {
  return { method: "play", args: { id, seat, actions: ["Start"] } };
}

/** The seat a free table's opener leaves to its guest; the house agent, when there is one, takes the other. */
export const FREE_GUEST_SEAT = 0;
export const FREE_AGENT_SEAT = 1;

/**
 * A free table, as the sponsor opens it (see free.ts): nothing is staked, so nothing is won. `withAgent`: the sponsor
 * also sits in the second seat, which its agent plays. `room`: a table for friends, of that many seats, which the
 * visitor who asked for it hosts: it starts when they say so.
 */
export function freeTableCalls(
  id: string,
  maxRounds: number,
  turnSeconds: number,
  withAgent: boolean,
  room: { host: string; seats: number } | null = null,
  agents = 1,
  extras: Extras = NO_EXTRAS,
): FunctionCall[] {
  const seats = withAgent ? 1 + agents : room?.seats;
  const create = createDuelCall(id, { stake: 0n, maxRounds, turnSeconds, seats, host: room?.host, extras });
  // Against the house, its agents take every seat but the visitor's: the last seat taken, the visitor's, starts the
  // game. In a room of friends they take the seats after the host's (`agents` of them, none unless asked for), the
  // friends take the rest, and the host starts it.
  const taken = withAgent ? agents : room ? Math.min(agents, room.seats - 1) : 0;
  return [create, ...Array.from({ length: taken }, (_, i) => joinCalls(id, FREE_AGENT_SEAT + i, 0n)).flat()];
}

/** The most gas one transaction may carry. */
const TX_GAS = 300n * TGAS;

/** Calls in order, cut into transactions that each fit the gas one transaction may carry. */
export function inTransactions(calls: FunctionCall[]): FunctionCall[][] {
  const batches: FunctionCall[][] = [];
  for (const call of calls) {
    const last = batches.at(-1);
    if (last && last.reduce((sum, one) => sum + one.gas, 0n) + call.gas <= TX_GAS) last.push(call);
    else batches.push([call]);
  }
  return batches;
}

export function joinCalls(id: string, seat: number, stake: bigint): FunctionCall[] {
  return [{ method: "join", args: jsonArgs({ id, seat }), gas: JOIN_GAS, deposit: stake }];
}

/** A match id nobody else is likely to pick: the time and a few random letters. The contract takes 1 to 32 of `[A-Za-z0-9_-]`. */
export function newMatchId(now: number = Date.now(), random: () => number = Math.random): string {
  const letters = Array.from({ length: 4 }, () => "abcdefghijkmnpqrstuvwxyz"[Math.floor(random() * 24)]).join("");
  return `m-${now.toString(36)}-${letters}`;
}

/**
 * What an account must hold for a node to accept these calls in one transaction: the deposits, plus the price set
 * aside for all the gas attached. Most of the gas part is refunded once the transaction has run.
 */
export function upfront(calls: FunctionCall[]): bigint {
  return calls.reduce((sum, call) => sum + call.deposit + call.gas * GAS_HOLD, 0n);
}

/**
 * What a game account must keep to make a move: the hold on the 100 Tgas a move attaches (about 0.1 NEAR), of which
 * a move burns some 0.0004. An account that drops below it cannot play its seat until it is topped up.
 */
export const MOVE_HOLD = MOVE_GAS * GAS_HOLD;

/** NEAR as yoctoNEAR, for amounts with at most three decimals. */
export const near = (amount: number): bigint => BigInt(Math.round(amount * 1000)) * 1_000_000_000_000_000_000_000n;

/** The smallest stake a seat may cost in a match opened from the web page, in NEAR. */
export const SMALLEST_STAKE = 0.05;

/**
 * "To the end": the contract's longest match, 255 rounds. The game is over long before, when all but one seat are
 * bankrupt; the contract asks for a limit so that stakes can never stay locked in a match nobody finishes.
 */
export const TO_THE_END = 255;
/** How many rounds a match opened from the web page may last. */
export const ROUND_CHOICES = [8, 12, 16, 20, TO_THE_END];
/**
 * The rounds a table of that many seats is opened with unless its opener picks: 40 to 48 turns in all. The simulation
 * (scripts/co-ty-phu-sim.ts) puts that at 7 to 8 minutes for one person against agents and 11 to 13 for a table of
 * people, a few minutes more when everybody takes their time.
 */
export const roundsFor = (seats: number): number => (seats <= 2 ? 20 : seats === 3 ? 16 : 12);
/** A round limit as the pages say it. */
export const roundsLabel = (maxRounds: number): string => (maxRounds >= TO_THE_END ? "To the end" : String(maxRounds));
/** "ROUND 3/12", or "ROUND 3" in a match played to the end. `round` counts the rounds completed. */
export const roundOf = (round: number, maxRounds: number): string => (maxRounds >= TO_THE_END ? `${round + 1}` : `${Math.min(round + 1, maxRounds)}/${maxRounds}`);
/** How a match with these rules is won, in one sentence, for the gate and the table's rules. */
export function winLine(rules: { blitz: boolean; maxRounds: number }): string {
  const worth = `cash, properties at their price (half when mortgaged) and houses at ${rules.blitz ? "three quarters of " : ""}their cost`;
  return rules.maxRounds >= TO_THE_END
    ? `The last seat standing wins. Should round ${TO_THE_END} ever end, the highest net worth wins: ${worth}.`
    : `The last seat standing wins; after round ${rules.maxRounds} the highest net worth wins: ${worth}.`;
}
/** One ticket as the table, the rules sheet and the gate say it. */
export type TicketLine = { ticket: "waiver" | "steps" | "takeover" | "festival"; name: string; when: string; does: string };
export const TICKET_LINES: TicketLine[] = [
  { ticket: "waiver", name: "Rent waiver", when: "Before you throw", does: "The next rent you would owe this turn is not charged. Unused, it is gone when your turn ends." },
  { ticket: "steps", name: "Pick your steps", when: "Instead of a throw", does: "Move any number of steps from 2 to 12 instead of rolling. A chosen double gives no second throw." },
  { ticket: "takeover", name: "Takeover", when: "After you land", does: "Buy the city you stand on from its owner for twice its price. Only a city with no house, not mortgaged." },
  { ticket: "festival", name: "Festival", when: "Before you throw", does: "Your cities charge double rent until your next turn starts." },
];
/** How tickets come and go, in two sentences. */
export const TICKETS_LINE = "Every seat starts with one random ticket and draws another each time it passes Departure, never holding more than two. A ticket is played on your own turn and is then used up.";
/** The leader's rent, in one sentence. */
export const LEADER_LINE = "Whoever leads on net worth pays double rent (a tie for the lead: nobody does). On a city with a Festival the leader pays triple.";

/**
 * A turn's clock, in seconds, in matches opened from the web page: after it the contract moves for whoever is late
 * (`timeout`). Long enough for an AI seat's model to answer and its transaction to land.
 */
export const TURN_SECONDS = 30;

/**
 * A stake typed by the visitor, in NEAR: from the smallest the page opens with to the largest the contract allows, in
 * thousandths of a NEAR at most (what `near()` turns into yoctoNEAR exactly).
 */
export function ownStake(text: string, largest: number, smallest: number = SMALLEST_STAKE): { amount: number } | { problem: string } {
  const clean = text.trim();
  if (!/^\d*(\.\d*)?$/.test(clean) || clean === "" || clean === ".") return { problem: "Type an amount in NEAR, like 0.3" };
  if (!/^\d*(\.\d{0,3})?$/.test(clean)) return { problem: "At most three decimals, like 0.125" };
  const amount = Number(clean);
  if (amount < smallest) return { problem: `The smallest stake is ${smallest} NEAR` };
  if (amount > largest) return { problem: `This contract takes at most ${largest} NEAR a seat` };
  return { amount };
}

/**
 * What a game account must hold to open a duel on these terms: enough for a node to take the transaction (stake,
 * storage deposit and the hold on its gas), and enough left to make moves after it. One figure, wherever it is told.
 */
export function neededToOpen(terms: DuelTerms): bigint {
  const hold = upfront(openDuelCalls("m", terms));
  const after = terms.stake + STORAGE_DEPOSIT + MOVE_HOLD + near(0.005);
  return hold > after ? hold : after;
}
