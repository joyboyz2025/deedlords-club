// Where the Poker contract lives, for the page and for the server's routes alike (nothing here needs a browser).

import { CHAIN } from "@/lib/chain/config";

// On mainnet the contract is poker.deedlords.near unless NEXT_PUBLIC_POKER_CONTRACT names another.
const network: string = CHAIN.network;
export const POKER_CONTRACT = process.env.NEXT_PUBLIC_POKER_CONTRACT ?? (network === "sandbox" ? "poker.sandbox" : network === "mainnet" ? "poker.deedlords.near" : "poker.deedlords.testnet");
/** The chain configuration with the Poker contract as the one that is called. */
export const POKER_CHAIN = { ...CHAIN, contractId: POKER_CONTRACT };
/** A seat's stake: 0.1 NEAR for 100 chips, the least the contract takes. */
export const STAKE = 10n ** 23n;
/** What a seat pays on top of its stake for the match's permanent record (the contract's RECORD_FEE). */
export const RECORD_FEE = 2n * 10n ** 21n;
const TGAS = 1_000_000_000_000n;
/**
 * An account must hold about 0.001 NEAR per Tgas it attaches, so calls attach what they need: checking a shuffle
 * proof burns about 215 Tgas, everything else stays under 20.
 */
export const gasFor = (method: string): bigint => (method === "shuffle" ? 260n : 40n) * TGAS;
