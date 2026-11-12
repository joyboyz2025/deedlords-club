// Where the Poker contract for tables of two to nine seats lives (contracts/poker-table), for the page and for the
// server's routes alike (nothing here needs a browser).

import { CHAIN } from "@/lib/chain/config";

// On mainnet there is one poker contract, poker.deedlords.near: the one the page plays (contracts/sandbox/mainnet.js
// deploys it). It is this one once the page is the page for several seats, unless NEXT_PUBLIC_POKER_TABLE_CONTRACT
// names another.
const network: string = CHAIN.network;
export const TABLE_CONTRACT =
  process.env.NEXT_PUBLIC_POKER_TABLE_CONTRACT ?? (network === "sandbox" ? "pokertable.sandbox" : network === "mainnet" ? "poker.deedlords.near" : "pokertable.deedlords.testnet");
/** The chain configuration with the table contract as the one that is called. */
export const TABLE_CHAIN = { ...CHAIN, contractId: TABLE_CONTRACT };
/** A seat's stake: 0.1 NEAR for 100 chips, the least the contract takes. */
export const STAKE = 10n ** 23n;
/** What a seat pays on top of its stake for the table's permanent record (the contract's RECORD_FEE). */
export const RECORD_FEE = 2n * 10n ** 21n;
/**
 * What the host of a free table (a stake of nothing) attaches to open it (the contract's FREE_TABLE_DEPOSIT): it
 * covers the table's storage and the record of the seats taken there, and what is left comes back when the table closes.
 */
export const FREE_TABLE_DEPOSIT = 25n * 10n ** 22n;
/**
 * How many hands the host of a free table plays before it asks to leave: every hand costs the sponsor the gas of all
 * the seats' calls (about 0.07 NEAR for two seats, nearly all of it for checking the two shuffles).
 */
export const FREE_TABLE_HANDS = 10;
export const MAX_SEATS = 9;
const TGAS = 1_000_000_000_000n;
/** A decryption share with its proof, in bytes. */
const SHARE_BYTES = 224;

/**
 * An account must hold about 0.001 NEAR per Tgas it attaches, so a call attaches what it needs: checking a shuffle
 * proof burns about 215 Tgas, a share about 6 (a seat of nine deals sixteen at once), everything else under 10.
 */
export function gasFor(method: string, args: Record<string, unknown> = {}): bigint {
  if (method === "shuffle") return 260n * TGAS;
  const shares = typeof args.tokens === "string" ? Math.round((args.tokens.length * 3) / 4 / SHARE_BYTES) : 0;
  return BigInt(Math.max(40, 30 + 7 * shares)) * TGAS;
}
