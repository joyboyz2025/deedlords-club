// The Arena contract from the browser: open a table, take a seat, and play a round with sealed plans. The signer is the
// game account kept in this browser (games/co-ty-phu/chain/keySession.ts): its own full-access key, so the page signs
// stakes and moves itself with no wallet prompt.

import { sha256 } from "@noble/hashes/sha2.js";
import { ChainClient, type ContractEvent, type Session } from "@/lib/chain/client";
import { CHAIN } from "@/lib/chain/config";
import { parseSecretKey } from "@/lib/chain/keys";
import { type FunctionCall, jsonArgs } from "@/lib/chain/transaction";
import { readStored, writeStored } from "@/lib/storage";
import { exportGameKey, openKeySession } from "../../co-ty-phu/chain/keySession";
import { resolveRound, type Match, type Plan } from "../engine";

export const ARENA_CONTRACT = process.env.NEXT_PUBLIC_ARENA_CONTRACT ?? (CHAIN.network === "sandbox" ? "arena.sandbox" : "arena.deedlords.testnet");
export const arenaClient = new ChainClient({ ...CHAIN, contractId: ARENA_CONTRACT });

export type ChainSeat = { backer: string; driver: string | null; committed: boolean; revealed: boolean };
export type ChainMatch = { id: string; status: "lobby" | "playing"; stake: string; rounds: number; turnSeconds: number; deadline: string; phase: "lobby" | "commit" | "reveal"; seats: ChainSeat[]; game: Match | null };
export type ChainResult = { id: string; stake: string; ranking: number[]; backers: string[]; payouts: string[]; fee: string; points: number[]; gold: number[]; roundsPlayed: number };

const TGAS = 1_000_000_000_000n;
/** `join`, `reveal` and `timeout` may draw a market; the contract wants at least 60 Tgas on them. */
const MOVE_GAS = 100n * TGAS;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** This browser's game account as a signer for the Arena contract, or `null` when there is none. */
export function arenaSession(): Session | null {
  const account = openKeySession();
  const key = exportGameKey();
  return account && key ? arenaClient.session(account.accountId, parseSecretKey(key)) : null;
}

export const viewMatch = (id: string) => arenaClient.view<ChainMatch | null>("get_match", { id });
export const viewResult = (id: string) => arenaClient.view<ChainResult | null>("get_result", { id });
export const explorerLink = (hash: string): string | null => (CHAIN.explorerUrl ? `${CHAIN.explorerUrl}/txns/${hash}` : null);
export const newTableId = (): string => `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** Opens a match and takes seat 0; with `bothSeats` the same account takes seat 1 too, in the same transaction. */
export function openTable(session: Session, id: string, rounds: number, stake: bigint, bothSeats: boolean) {
  const calls: FunctionCall[] = [{ method: "create_match", args: jsonArgs({ id, rounds, stake: stake.toString(), turn_seconds: 120 }), gas: 30n * TGAS, deposit: stake }];
  if (bothSeats) calls.push({ method: "join", args: jsonArgs({ id }), gas: MOVE_GAS, deposit: stake });
  return session.transact(calls);
}

export const takeSeat = (session: Session, id: string, stake: bigint) => session.transact([{ method: "join", args: jsonArgs({ id }), gas: MOVE_GAS, deposit: stake }]);

type Sealed = { text: string; salt: string };
/** A sealed plan is kept here until it is revealed, so a reloaded page can still open it. */
const sealedKey = (id: string, round: number, seat: number) => `deedlords:arena:${CHAIN.network}:${id}:${round}:${seat}`;
/** What the contract checks a reveal against: `sha256(plan ‖ "|" ‖ salt)` over the exact text of the plan. */
export const seal = ({ text, salt }: Sealed): string => hex(sha256(new TextEncoder().encode(`${text}|${salt}`)));

/** JSON with the keys of every object in order, so two values can be compared whatever order they were written in. */
const canon = (value: unknown): string =>
  JSON.stringify(value, (_, v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));

type RoundEvent = { plans: Plan[]; result: Match["last"]; next: { round: number; market: number[]; done: boolean } };

/**
 * Plays one round for the seats this account backs (`plans`, by seat): commits them, waits until every seat has
 * committed, reveals, and waits for the round to be played. Returns the match after the round. `say` is told each
 * step, with the transaction that made it when there is one.
 */
export async function playRound(session: Session, id: string, match: Match, plans: Map<number, Plan>, say: (note: string, hash?: string) => void): Promise<Match> {
  const round = match.round;
  const sealed = new Map<number, Sealed>();
  let seen = await viewMatch(id);
  for (const [seat, plan] of plans) {
    const kept = readStored<Sealed>(sealedKey(id, round, seat));
    const mine = seen?.seats[seat].committed && kept ? kept : { text: JSON.stringify(plan), salt: hex(crypto.getRandomValues(new Uint8Array(16))) };
    writeStored(sealedKey(id, round, seat), mine);
    sealed.set(seat, mine);
    if (seen?.seats[seat].committed) continue;
    const outcome = await session.call("commit", { id, seat, hash: seal(mine) }, 30n * TGAS);
    say(`Seat ${seat + 1}: plan sealed.`, outcome.hash);
  }

  /** Reads the match until `ready` says so; past the deadline it asks the contract to move on. */
  const waitFor = async (ready: (now: ChainMatch | null) => boolean): Promise<ChainMatch | null> => {
    for (;;) {
      const now = await viewMatch(id);
      if (ready(now)) return now;
      if (now && Date.now() * 1_000_000 > Number(now.deadline) + 2_000_000_000) {
        const outcome = await session.call("timeout", { id }, MOVE_GAS).catch(() => null);
        if (outcome) say("The other seat ran out of time.", outcome.hash);
      }
      await sleep(CHAIN.pollMs);
    }
  };
  const moved = (now: ChainMatch | null) => now === null || now.game!.round > round;

  say("Waiting for every seat to seal its plan…");
  seen = await waitFor((now) => moved(now) || now!.phase === "reveal");
  let played: ContractEvent | undefined;
  for (const [seat, mine] of sealed) {
    if (moved(seen) || seen!.seats[seat].revealed) continue;
    const outcome = await session.call("reveal", { id, seat, plan: mine.text, salt: mine.salt }, MOVE_GAS);
    say(`Seat ${seat + 1}: plan opened.`, outcome.hash);
    played = outcome.events.find((event) => event.event === "round") ?? played;
    seen = await viewMatch(id);
  }
  if (played) {
    // This account sent the reveal that played the round: its event has both plans and the next market, and the
    // engine here must reach the result the contract logged.
    const event = played.data as unknown as RoundEvent;
    const next = resolveRound(match, event.plans, event.next.market);
    if (canon(next.last) !== canon(event.result)) throw new Error("the contract and this page disagree about the round");
    return next;
  }
  say("Waiting for the other seat to open its plan…");
  const after = await waitFor(moved);
  // Settled by the other seat's reveal: the match is gone from the contract and only its summary is left.
  return after?.game ?? { ...match, done: true };
}
