// NEAR between a club account and the poker game account kept beside it (pokerAccount.ts).
//
// A NEAR wallet account, or a Google account, cannot sign the steps of a hand, so poker is played with a game account
// of its own. That account starts empty. Rather than have the player copy an address and send NEAR to themselves, a
// table with a stake is opened in one go: the club account sends what the seat needs (one approval, in the wallet or
// in the sign-in window), the page waits for it to land, and the table opens. What is left afterwards goes back the
// same way round with no approval at all: the poker account's key is here.

import type { Session } from "@/lib/chain/client";
import type { Player } from "../co-ty-phu/chain/usePlayer";

const HUNDREDTH = 10n ** 22n;

/**
 * What to move to an account that holds `balance` and needs `needed`: the difference and a twentieth more (the price
 * of gas moves), in whole hundredths of a NEAR. 0 when it holds enough.
 */
export function amountToMove(needed: bigint, balance: bigint | null | undefined): bigint {
  const missing = needed - (balance ?? 0n);
  if (missing <= 0n) return 0n;
  return (((missing * 105n) / 100n + HUNDREDTH - 1n) / HUNDREDTH) * HUNDREDTH;
}

export type FundStep = "approve" | "moving";

/** What `fundPoker` reads the chain and sends with; the page's own unless a test stands something else in. */
export type FundWith = {
  /** What an account holds, in yoctoNEAR; `null` when it is not on chain. */
  balance(accountId: string): Promise<bigint | null>;
  /** Sends `amount` from the club account to `to`, approved by its owner. */
  send(backer: Player, to: string, amount: bigint): Promise<unknown>;
  sleep(ms: number): Promise<unknown>;
};

async function pageTools(): Promise<FundWith> {
  const [{ tableClient }, { withdraw }] = await Promise.all([import("./table/chain"), import("../co-ty-phu/chain/usePlayer")]);
  return { balance: (accountId) => tableClient.balance(accountId), send: withdraw, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
}

/**
 * Brings the poker account `pokerId` up to `needed` from the club account `backer`, and resolves once the chain shows
 * it. `onStep`: `approve` while the player is asked (wallet, or sign-in window), `moving` while the transfer lands.
 * An account that already holds enough is left alone: nothing is asked and nothing is sent.
 */
export async function fundPoker(backer: Player, pokerId: string, needed: bigint, onStep: (step: FundStep) => void = () => {}, tools?: FundWith): Promise<void> {
  const { balance, send, sleep } = tools ?? (await pageTools());
  const amount = amountToMove(needed, await balance(pokerId));
  if (amount === 0n) return;
  onStep("approve");
  await send(backer, pokerId, amount);
  onStep("moving");
  // A public node answers from several nodes, some a block behind: read until the one that answers has it.
  for (let tries = 0; tries < 40; tries++) {
    const now = await balance(pokerId).catch(() => null);
    if (now !== null && now >= needed) return;
    await sleep(1_500);
  }
  throw new Error("The NEAR was sent but this page has not seen it land yet. Wait a few seconds and press the button again: nothing is sent twice.");
}

/** What stays on the poker account when the rest goes back: the gas of the transfer itself, with room to spare. */
export const KEPT_BACK = 2n * 10n ** 21n;

/** Sends what the poker account holds back to the club account `to`, signed here with the poker account's own key. Resolves to what was sent. */
export async function sendBack(session: Pick<Session, "sendTo">, to: string, balance: bigint): Promise<bigint> {
  const amount = balance - KEPT_BACK;
  if (amount <= 0n) throw new Error("There is nothing to send back.");
  await session.sendTo(to, [{ transfer: amount }]);
  return amount;
}
