"use client";

import { useCallback, useEffect, useState } from "react";
import type { Session } from "@/lib/chain/client";
import { CHAIN } from "@/lib/chain/config";
import { chainClient } from "@/lib/chain/shared";
import type { FunctionCall } from "@/lib/chain/transaction";
import { readStored, writeStored } from "@/lib/storage";
import { AS_KEY, openDevSession } from "./devSession";
import { GRANT_METHODS } from "./calls";
import { confirmGrant, identify, prepareGrant, resumeGoogle, sendWithNearAuth, type PendingGrant } from "./googleSession";
import { hasKeyAccount, type KeySource, openKeySession, signInAsGuest, signInWithEvm, signOutOfKey } from "./keySession";
import { hasWalletAccount, openWalletSession, sendWithWallet, signInWithNearWallet, signOutOfWallet } from "./walletSession";

/**
 * Whoever this browser plays as.
 * `key`: a game account whose key is here (from an EVM wallet's signature, or a guest's). It signs everything itself.
 *   A Google account (`source: "google"`) is one too, with a lesser key here: it moves a seat, and what spends the
 *   account's NEAR (a stake, a withdrawal) is approved in the sign-in window each time.
 * `wallet`: an account of a NEAR wallet; a session key here signs the moves, the wallet approves the stakes.
 * `helper`: a test account of the local helper, which signs what carries a deposit.
 */
export type Player =
  | { via: "key"; accountId: string; session: Session; source: KeySource; evmAddress: string | null; label: string | null }
  | { via: "wallet"; accountId: string; session: Session; walletName: string }
  | { via: "helper"; accountId: string; session: Session };

type Choice = { via: "helper"; accountId: string } | { via: "key" } | { via: "wallet" } | { via: "nobody" };

const text = (error: unknown) => (error instanceof Error ? error.message : String(error));
const BALANCE_EVERY_MS = 6_000;

/** Whether this player's stakes and withdrawals are approved in the NEAR Auth window, one by one. */
export const approvesInWindow = (player: Player | null): boolean => player?.via === "key" && player.source === "google";

/**
 * Signs and sends calls that carry a deposit, the way this player can: a game account with its own key, a wallet
 * account through the wallet. A helper's test account does not come here: the helper has its own requests.
 */
export async function sendStake(player: Player, calls: FunctionCall[]): Promise<void> {
  // What the browser's key of a Google account can sign itself (a seat that costs nothing) needs no approval.
  const withinGrant = calls.every((call) => call.deposit === 0n && (GRANT_METHODS as readonly string[]).includes(call.method));
  if (approvesInWindow(player) && !withinGrant) await sendWithNearAuth(player.accountId, CHAIN.contractId, calls);
  else if (player.via === "key") await player.session.transact(calls);
  else if (player.via === "wallet") await sendWithWallet(player.accountId, calls);
  else throw new Error("a helper's test account stakes through the helper");
}

/**
 * Sends NEAR out of a game account, to any NEAR account. A guest's or an EVM wallet's key signs it here; a Google
 * account's is approved in the sign-in window. Resolves to the transaction's hash.
 */
export async function withdraw(player: Player, receiverId: string, amount: bigint): Promise<string> {
  if (player.via !== "key") throw new Error("a wallet account withdraws in its wallet");
  const sent = approvesInWindow(player) ? sendWithNearAuth(player.accountId, receiverId, [{ transfer: amount }]) : player.session.sendTo(receiverId, [{ transfer: amount }]);
  return (await sent).hash;
}

/**
 * Who plays here, decided once per page: `?as=<account>` (a test account of the local helper), `?as=` (nobody: just
 * watch), else the game account kept in this browser, else the connected NEAR wallet, else the test account used last.
 */
export function usePlayer() {
  const [choice, setChoice] = useState<Choice | undefined>(undefined);
  // `undefined`: still finding out. `null`: nobody, watching.
  const [player, setPlayer] = useState<Player | null | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // `undefined`: not read yet. `null`: the account does not exist on chain (nobody has sent it anything).
  const [balance, setBalance] = useState<bigint | null | undefined>(undefined);
  // A Google sign-in halfway: the person is known, and the grant that lets this browser play waits for their approval.
  const [grant, setGrant] = useState<PendingGrant | null>(null);

  useEffect(() => {
    const asked = new URLSearchParams(window.location.search).get("as");
    if (asked === "") return setChoice({ via: "nobody" });
    if (asked && CHAIN.devUrl) return setChoice({ via: "helper", accountId: asked });
    if (hasKeyAccount()) return setChoice({ via: "key" });
    if (CHAIN.wallets && hasWalletAccount()) return setChoice({ via: "wallet" });
    const last = CHAIN.devUrl ? readStored<string>(AS_KEY) : null;
    setChoice(last ? { via: "helper", accountId: last } : { via: "nobody" });
  }, []);

  useEffect(() => {
    if (!choice) return;
    setBalance(undefined);
    if (choice.via === "nobody") return setPlayer(null);
    if (choice.via === "key") {
      const account = openKeySession();
      return setPlayer(account && { ...account, via: "key" });
    }
    let stale = false;
    setPlayer(undefined);
    const opening: Promise<Player | null> =
      choice.via === "helper"
        ? openDevSession(choice.accountId).then((session) => {
            writeStored(AS_KEY, choice.accountId);
            return { via: "helper", accountId: choice.accountId, session };
          })
        : openWalletSession().then((account) => account && { ...account, via: "wallet" });
    opening.then(
      (opened) => {
        if (stale) return;
        if (!opened) setProblem("The session key is not on your account: connect the wallet again.");
        setPlayer(opened);
      },
      (error) => {
        if (stale) return;
        setProblem(`Could not sign in${choice.via === "helper" ? ` as ${choice.accountId}` : ""}: ${text(error)}`);
        setPlayer(null);
      },
    );
    return () => {
      stale = true;
    };
  }, [choice]);

  const accountId = player?.accountId ?? null;
  const refreshBalance = useCallback(async () => {
    if (!accountId) return;
    await chainClient.balance(accountId).then(setBalance, () => undefined);
  }, [accountId]);

  useEffect(() => {
    if (!accountId) return;
    void refreshBalance();
    const timer = setInterval(() => document.visibilityState !== "hidden" && void refreshBalance(), BALANCE_EVERY_MS);
    return () => clearInterval(timer);
  }, [accountId, refreshBalance]);

  /** Runs a sign-in that may open a wallet, then plays as what it left. */
  const signIn = useCallback(async (via: "key" | "wallet", start: () => Promise<void> | void) => {
    setBusy(true);
    setProblem(null);
    try {
      await start();
      setChoice({ via });
    } catch (error) {
      setProblem(text(error));
    }
    setBusy(false);
  }, []);

  const signInEvm = useCallback(() => signIn("key", signInWithEvm), [signIn]);
  const signInGuest = useCallback(() => signIn("key", signInAsGuest), [signIn]);
  const signInWallet = useCallback(() => signIn("wallet", signInWithNearWallet), [signIn]);

  /** The first of two clicks: the sign-in window. Each opens its window at once, so neither waits on anything first. */
  const signInGoogle = useCallback(async () => {
    setBusy(true);
    setProblem(null);
    try {
      const identity = await identify();
      if (await resumeGoogle(identity)) setChoice({ via: "key" });
      else setGrant(await prepareGrant(identity));
    } catch (error) {
      setProblem(text(error));
    }
    setBusy(false);
  }, []);

  /** The second click: the person approves the key for this browser. */
  const confirmGoogle = useCallback(async () => {
    if (!grant) return;
    setBusy(true);
    setProblem(null);
    try {
      await confirmGrant(grant);
      setGrant(null);
      setChoice({ via: "key" });
    } catch (error) {
      setProblem(text(error));
    }
    setBusy(false);
  }, [grant]);

  const cancelGoogle = useCallback(() => {
    setGrant(null);
    setProblem(null);
  }, []);

  /** Play as a test account of the local helper, or as nobody. */
  const playAs = useCallback((helperAccount: string | null) => {
    setProblem(null);
    if (!helperAccount) writeStored(AS_KEY, null);
    setChoice(helperAccount ? { via: "helper", accountId: helperAccount } : { via: "nobody" });
  }, []);

  const signOut = useCallback(() => {
    setProblem(null);
    if (player?.via === "key") signOutOfKey();
    if (player?.via === "wallet") void signOutOfWallet();
    if (player?.via === "helper") writeStored(AS_KEY, null);
    setChoice({ via: "nobody" });
  }, [player]);

  return { player, balance, problem, busy, grant, refreshBalance, signInEvm, signInGuest, signInWallet, signInGoogle, confirmGoogle, cancelGoogle, playAs, signOut };
}

export type PlayerState = ReturnType<typeof usePlayer>;
