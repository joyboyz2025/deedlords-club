// The contract calls that carry a deposit: opening a match and taking a seat. A session key a wallet added cannot sign
// them, so a wallet does (walletSession.ts); a game account signs them with its own key (keySession.ts); the local
// helpers make the same calls with the keys of their test accounts.

import { type FunctionCall, jsonArgs } from "../../../lib/chain/transaction.ts";

/** What a session key may call: the moves of a match. None of them takes a deposit, and such a key cannot attach one. */
export const SESSION_METHODS = ["play", "turn", "timeout", "set_driver", "leave"] as const;
/** What a session key may burn in gas over its life, in yoctoNEAR: 0.25 NEAR, about 600 moves. */
export const SESSION_ALLOWANCE = "250000000000000000000000";

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

export type DuelTerms = { stake: bigint; maxRounds: number; turnSeconds: number };

/** One transaction, two calls: open a two-seat match and take its first seat. */
export function openDuelCalls(id: string, terms: DuelTerms): FunctionCall[] {
  const create = {
    id,
    seats: 2,
    stake: terms.stake.toString(),
    split: [7000, 3000],
    rules: { salary: 200, cash: 1500, blitz: false, max_rounds: terms.maxRounds },
    solo_player: null,
    turn_seconds: terms.turnSeconds,
  };
  return [{ method: "create_match", args: jsonArgs(create), gas: CREATE_GAS, deposit: STORAGE_DEPOSIT }, ...joinCalls(id, 0, terms.stake)];
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
