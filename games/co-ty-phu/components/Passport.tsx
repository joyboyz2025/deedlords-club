"use client";

import { useState } from "react";
import { CHAIN } from "@/lib/chain/config";
import { formatNear, shortAccount } from "../chain/adapt";
import { near } from "../chain/calls";
import { devFund, type DevConfig } from "../chain/devSession";
import { exportGameKey } from "../chain/keySession";
import type { Player, PlayerState } from "../chain/usePlayer";
import { AccountBadge, Icon } from "./LobbyArt";

/**
 * Below this a game account cannot open the smallest match (0.11 NEAR, and 0.12 more that a node holds for the gas
 * attached until the transaction has run), and the helper's faucet may top it up.
 */
const LOW_BALANCE = near(0.25);

const problemText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function sourceLine(player: Player): string {
  if (player.via === "wallet") return `NEAR wallet · ${player.walletName.replace(/-/g, " ")}`;
  if (player.via === "helper") return "Test account of the local helper";
  return player.source === "evm" ? `Game account · from ${player.evmAddress ? `${player.evmAddress.slice(0, 6)}…${player.evmAddress.slice(-4)}` : "your EVM wallet"}` : "Game account · guest key in this browser";
}

/**
 * Who plays here and how they got in: the ways to sign in for a visitor, the account and its balance for a player.
 * `helper` is the local helper's own description, when there is one: its test accounts and what its faucet gives.
 */
export function Passport({ state, helper }: { state: PlayerState; helper: DevConfig | null }) {
  const { player, balance, problem, busy } = state;
  const [note, setNote] = useState<string | null>(null);
  const [funding, setFunding] = useState(false);

  if (player === undefined) {
    return (
      <section className="dl-panel dl-pass" aria-live="polite">
        <p className="dl-muted">Signing in…</p>
      </section>
    );
  }

  if (player === null) {
    return (
      <section className="dl-panel dl-pass" aria-label="Sign in">
        <h2 className="dl-title">Board the game</h2>
        <p className="dl-muted">Pick how you hold your seat. Stakes are confirmed once; a move never asks for approval.</p>
        <div className="dl-ways">
          <button type="button" className="dl-way" disabled={busy} onClick={state.signInEvm}>
            <Icon name="evm" size={26} />
            <span>
              <strong>EVM wallet</strong>
              <small>MetaMask, Rabby, Coinbase… One signature makes your game account, the same on every device.</small>
            </span>
          </button>
          {CHAIN.wallets && (
            <button type="button" className="dl-way" disabled={busy} onClick={state.signInWallet}>
              <Icon name="near" size={26} />
              <span>
                <strong>NEAR wallet</strong>
                <small>Meteor, Intear, Nightly and others, through NEAR Connect. Your wallet approves each stake.</small>
              </span>
            </button>
          )}
          <button type="button" className="dl-way" disabled={busy} onClick={state.signInGuest}>
            <Icon name="guest" size={26} />
            <span>
              <strong>Guest</strong>
              <small>A new game account whose key stays in this browser. Quickest way to try a match.</small>
            </span>
          </button>
        </div>
        {helper && helper.players.length > 0 && <TestAccounts players={helper.players} current={null} onChange={state.playAs} />}
        {problem && (
          <p className="dl-problem" role="alert">
            {problem}
          </p>
        )}
      </section>
    );
  }

  const faucet = player.via === "key" && helper?.faucet ? helper.faucet : null;
  const low = balance === null || (balance !== undefined && balance < LOW_BALANCE);

  const copy = async (text: string, done: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNote(done);
    } catch {
      setNote(text);
    }
  };

  const fund = async () => {
    setFunding(true);
    setNote(null);
    try {
      const answer = await devFund(player.accountId);
      setNote(answer.funded ? `${formatNear(faucet ?? "0")} test NEAR is on its way.` : "This account already has enough to play.");
      // The transfer has run; the node asked next may still be a block behind it.
      for (let i = 0; i < 4; i++) {
        await new Promise((resolve) => setTimeout(resolve, 900));
        await state.refreshBalance();
      }
    } catch (error) {
      setNote(problemText(error));
    }
    setFunding(false);
  };

  const signOut = () => {
    const guest = player.via === "key" && player.source === "guest";
    if (guest && !window.confirm("This browser will forget the key of your guest account, and whatever the account holds goes with it. Copy the key first if you want to keep it. Sign out?")) return;
    state.signOut();
  };

  return (
    <section className="dl-panel dl-pass dl-pass--in" aria-label="Your account">
      <AccountBadge accountId={player.accountId} size={52} />
      <div className="dl-pass__who">
        <small>{sourceLine(player)}</small>
        <strong title={player.accountId}>{shortAccount(player.accountId)}</strong>
        <span className="dl-balance" data-low={low || undefined}>
          {balance === undefined ? "reading the balance…" : balance === null ? "not on chain yet" : `${formatNear(balance.toString())} NEAR`}
        </span>
      </div>
      <div className="dl-pass__acts">
        {faucet && low && (
          <button type="button" className="tp-btn tp-btn--small tp-btn--main" disabled={funding} onClick={fund}>
            {funding ? "Sending…" : `Get ${formatNear(faucet)} test NEAR`}
          </button>
        )}
        {player.via === "key" && (
          <button type="button" className="tp-btn tp-btn--small" onClick={() => copy(player.accountId, "Address copied: send NEAR to it from any NEAR account.")}>
            <Icon name="copy" size={15} /> Address
          </button>
        )}
        {player.via === "key" && player.source === "guest" && (
          <button type="button" className="tp-btn tp-btn--small" onClick={() => copy(exportGameKey() ?? "", "Key copied. Keep it somewhere safe: it is the account.")}>
            <Icon name="copy" size={15} /> Key
          </button>
        )}
        <button type="button" className="tp-btn tp-btn--small tp-btn--quiet" onClick={signOut}>
          Sign out
        </button>
      </div>
      {player.via === "key" && balance === null && (
        <p className="dl-muted dl-pass__wide">
          A game account appears on chain with its first NEAR. {faucet ? "Ask for test NEAR above, or send some to its address." : "Send some NEAR to its address to start."}
        </p>
      )}
      {player.via === "helper" && helper && <TestAccounts players={helper.players} current={player.accountId} onChange={state.playAs} />}
      {(note ?? problem) && (
        <p className="dl-muted dl-pass__wide" role="status">
          {note ?? problem}
        </p>
      )}
    </section>
  );
}

/** With a local helper only: play as one of its test accounts. */
function TestAccounts({ players, current, onChange }: { players: string[]; current: string | null; onChange: (accountId: string | null) => void }) {
  const choices = current !== null && !players.includes(current) ? [current, ...players] : players;
  return (
    <label className="dl-test dl-pass__wide">
      <span>Test account</span>
      <select className="tp-input" value={current ?? ""} onChange={(event) => onChange(event.target.value || null)}>
        <option value="">none</option>
        {choices.map((account) => (
          <option key={account} value={account}>
            {account}
          </option>
        ))}
      </select>
    </label>
  );
}
