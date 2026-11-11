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
export type DuelTerms = { stake: bigint; maxRounds: number; turnSeconds: number; seats?: number; host?: string | null };

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
    rules: { salary: 200, cash: 1500, blitz: false, max_rounds: terms.maxRounds },
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
export function freeTableCalls(id: string, maxRounds: number, turnSeconds: number, withAgent: boolean, room: { host: string; seats: number } | null = null): FunctionCall[] {
  const create = createDuelCall(id, { stake: 0n, maxRounds, turnSeconds, seats: room?.seats, host: room?.host });
  return withAgent ? [create, ...joinCalls(id, FREE_AGENT_SEAT, 0n)] : [create];
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
 * What a game account must hold to open a duel on these terms: enough for a node to take the transaction (stake,
 * storage deposit and the hold on its gas), and enough left to make moves after it. One figure, wherever it is told.
 */
export function neededToOpen(terms: DuelTerms): bigint {
  const hold = upfront(openDuelCalls("m", terms));
  const after = terms.stake + STORAGE_DEPOSIT + MOVE_HOLD + near(0.005);
  return hold > after ? hold : after;
}
