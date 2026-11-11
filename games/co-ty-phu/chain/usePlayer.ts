"use client";

import { useCallback, useEffect, useState } from "react";
import type { Session } from "@/lib/chain/client";
import { CHAIN } from "@/lib/chain/config";
import { chainClient } from "@/lib/chain/shared";
import type { FunctionCall } from "@/lib/chain/transaction";
import { readStored, writeStored } from "@/lib/storage";
import { AS_KEY, openDevSession } from "./devSession";
import { hasKeyAccount, openKeySession, signInAsGuest, signInWithEvm, signOutOfKey } from "./keySession";
import { hasWalletAccount, openWalletSession, sendWithWallet, signInWithNearWallet, signOutOfWallet } from "./walletSession";

/**
 * Whoever this browser plays as.
 * `key`: a game account whose key is here (from an EVM wallet's signature, or a guest's). It signs everything itself.
 * `wallet`: an account of a NEAR wallet; a session key here signs the moves, the wallet approves the stakes.
 * `helper`: a test account of the local helper, which signs what carries a deposit.
 */
export type Player =
  | { via: "key"; accountId: string; session: Session; source: "evm" | "guest"; evmAddress: string | null }
  | { via: "wallet"; accountId: string; session: Session; walletName: string }
  | { via: "helper"; accountId: string; session: Session };

type Choice = { via: "helper"; accountId: string } | { via: "key" } | { via: "wallet" } | { via: "nobody" };

const text = (error: unknown) => (error instanceof Error ? error.message : String(error));
const BALANCE_EVERY_MS = 6_000;

/**
 * Signs and sends calls that carry a deposit, the way this player can: a game account with its own key, a wallet
 * account through the wallet. A helper's test account does not come here: the helper has its own requests.
 */
export async function sendStake(player: Player, calls: FunctionCall[]): Promise<void> {
  if (player.via === "key") await player.session.transact(calls);
  else if (player.via === "wallet") await sendWithWallet(player.accountId, calls);
  else throw new Error("a helper's test account stakes through the helper");
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

  return { player, balance, problem, busy, refreshBalance, signInEvm, signInGuest, signInWallet, playAs, signOut };
}

export type PlayerState = ReturnType<typeof usePlayer>;
