"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import goldFoil from "@/assets/plates/gold-foil.webp";
import { Chain, User } from "@/components/landing/icons";
import { NET_NAME, OTHER_NET } from "@/components/landing/net";
import type { Character } from "@/games/chibi/chain";
import { ChibiFace } from "@/games/chibi/components/CharacterTag";
import { useCharacter } from "@/games/chibi/useChibi";
import { formatNear, shortAccount } from "@/games/co-ty-phu/chain/adapt";
import { openKeySession, signOutOfKey } from "@/games/co-ty-phu/chain/keySession";
import { signOutOfWallet, storedWalletAccount } from "@/games/co-ty-phu/chain/walletSession";
import { chainClient } from "@/lib/chain/shared";
import "./hall-bar.css";

// The one top row of Deedlords Club, the same on every page: the wordmark, the three games, the visitor's own pages,
// the network, and who is signed in (their character's face, their name, what they hold, and the way out).
// Its styles are its own (hall-bar.css): it does not lean on the stylesheet of the page it sits on.

export type HallPlace = "home" | "play" | "poker" | "arena" | "character" | "shop" | "bag" | "agents" | "account";
export type HallAccount = { accountId: string; balance?: bigint | null };

const GAMES: { place: HallPlace; href: string; name: string }[] = [
  { place: "play", href: "/play", name: "Deedlords" },
  { place: "poker", href: "/poker/tables", name: "Poker" },
  { place: "arena", href: "/arena", name: "Arena" },
];
const OWN: { place: HallPlace; href: string; name: string }[] = [
  { place: "character", href: "/character", name: "Character" },
  { place: "shop", href: "/shop", name: "Shop" },
  { place: "bag", href: "/bag", name: "Bag" },
  { place: "agents", href: "/agents", name: "Agents" },
];

/** A page that signs somebody in or out without loading again says so, and the bar reads the account anew. */
const ACCOUNT_EVENT = "deedlords:account";
export const announceAccount = (): void => void window.dispatchEvent(new Event(ACCOUNT_EVENT));

/** The account this browser plays as, read from what it keeps: a game account's key first, else a connected NEAR wallet. */
function useOwnAccount(skip: boolean): string | null | undefined {
  const [accountId, setAccountId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (skip) return;
    const read = () => setAccountId(openKeySession()?.accountId ?? storedWalletAccount() ?? null);
    read();
    // Signed in or out in another tab, or on the page behind this one.
    window.addEventListener("storage", read);
    window.addEventListener("focus", read);
    window.addEventListener(ACCOUNT_EVENT, read);
    return () => {
      window.removeEventListener("storage", read);
      window.removeEventListener("focus", read);
      window.removeEventListener(ACCOUNT_EVENT, read);
    };
  }, [skip]);
  return skip ? undefined : accountId;
}

/** What the account holds, read here when the page does not hand it over. `null`: not on chain yet. */
function useOwnBalance(accountId: string | null, skip: boolean): bigint | null | undefined {
  const [balance, setBalance] = useState<bigint | null | undefined>(undefined);
  useEffect(() => {
    if (skip || !accountId) return;
    let stopped = false;
    const read = () =>
      document.visibilityState !== "hidden" &&
      chainClient.balance(accountId).then(
        (held) => !stopped && setBalance(held),
        () => undefined,
      );
    void read();
    const timer = setInterval(read, 12_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [accountId, skip]);
  return skip || !accountId ? undefined : balance;
}

/**
 * `current`: the page the bar is on. `account`: who is signed in, when the page already knows (`null`: nobody);
 * left out, the bar finds out by itself. `padded`: on a page whose ground has no side padding of its own.
 */
export function HallBar({ current, account, padded = false }: { current?: HallPlace; account?: HallAccount | null; padded?: boolean }) {
  const found = useOwnAccount(account !== undefined);
  const accountId = account === undefined ? found : (account?.accountId ?? null);
  const handed = account != null && "balance" in account;
  const read = useOwnBalance(accountId ?? null, handed);
  const balance = handed ? account.balance : read;
  const character = useCharacter(accountId ?? null);
  const here = (place: HallPlace) => (current === place ? "page" : undefined);
  return (
    <header className="hb" data-padded={padded || undefined} data-twonets={Boolean(OTHER_NET.url) || undefined} style={{ "--hb-foil": `url(${goldFoil.src})` } as CSSProperties}>
      <Link className="hb-mark" href="/" aria-label="Deedlords Club, home">
        Deedlords <small>Club</small>
      </Link>
      <nav aria-label="Deedlords Club">
        {GAMES.map((entry) => (
          <Link key={entry.place} href={entry.href} aria-current={here(entry.place)}>
            {entry.name}
          </Link>
        ))}
        <i aria-hidden="true" />
        {OWN.map((entry) => (
          <Link
            key={entry.place}
            href={entry.href}
            aria-current={here(entry.place)}
            // Signed in with no character yet: the link that makes one is marked.
            data-ask={(entry.place === "character" && Boolean(accountId) && character === null) || undefined}
            title={entry.place === "character" && accountId && character === null ? "Make your character, free" : undefined}
          >
            {entry.name}
          </Link>
        ))}
        {OTHER_NET.url && (
          <a className="hb-othernet" href={OTHER_NET.url}>
            {OTHER_NET.name}
          </a>
        )}
      </nav>
      <div className="hb-end">
        <span className="hb-net" title={`This page plays on ${NET_NAME}`}>
          <span aria-current="true">
            <Chain size={16} /> <i>NEAR </i>
            {NET_NAME.replace("NEAR ", "")}
          </span>
        </span>
        {accountId ? (
          <AccountMenu accountId={accountId} balance={balance} current={current} character={character} />
        ) : (
          accountId === null && (
            <Link className="hb-acct hb-acct--in" href="/account" aria-current={here("account")}>
              <User size={16} /> Sign in
            </Link>
          )
        )}
      </div>
    </header>
  );
}

/** Who is signed in: the character's face and name; pressed, the wallet, the character and the way out. */
function AccountMenu({
  accountId,
  balance,
  current,
  character,
}: {
  accountId: string;
  balance: bigint | null | undefined;
  current?: HallPlace;
  character: Character | null | undefined;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const name = character?.name ?? shortAccount(accountId);
  const initials = accountId
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 2)
    .toUpperCase();
  // The menu closes on a press anywhere else, and on Escape.
  useEffect(() => {
    const close = (event: Event) => {
      const open = menu.current;
      if (!open?.open) return;
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !open.contains(event.target as Node)) open.open = false;
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, []);
  const signOut = () => {
    const key = openKeySession();
    if (
      key?.source === "guest" &&
      !window.confirm(
        "This browser will forget the key of your guest account, and whatever the account holds goes with it. Back up the key on your account page first if you want to keep it. Sign out?",
      )
    )
      return;
    const leave = key ? Promise.resolve(signOutOfKey()) : signOutOfWallet();
    // Every page reads who plays when it loads: loading it again is the one way all of them agree.
    void leave.finally(() => window.location.reload());
  };
  return (
    <details className="hb-menu" ref={menu}>
      <summary className="hb-acct" title={accountId} aria-label={`Your account: ${name}`}>
        <ChibiFace character={character} size={28} fallback={initials} />
        <b>{name}</b>
        {typeof balance === "bigint" && <small>{formatNear(balance.toString(), 2)} NEAR</small>}
      </summary>
      <div className="hb-menu__list">
        <p>
          <strong>{name}</strong>
          {character && <small title={accountId}>{shortAccount(accountId)}</small>}
          <small>{balance === undefined ? "reading the balance…" : balance === null ? "0 NEAR · not on chain yet" : `${formatNear(balance.toString())} NEAR`}</small>
        </p>
        <Link href="/account" aria-current={current === "account" ? "page" : undefined}>
          Account and wallet
        </Link>
        <Link href="/character" aria-current={current === "character" ? "page" : undefined}>
          {character === null ? "Make your character" : "Character"}
        </Link>
        <Link href="/agents" aria-current={current === "agents" ? "page" : undefined}>
          My AI agents
        </Link>
        {OTHER_NET.url && <a href={OTHER_NET.url}>Switch to {OTHER_NET.name}</a>}
        <button type="button" onClick={signOut}>
          Sign out
        </button>
      </div>
    </details>
  );
}
