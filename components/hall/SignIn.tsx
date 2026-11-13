"use client";

import { useEffect, type CSSProperties, type ReactNode } from "react";
import paper from "@/assets/plates/strip-paper.png";
import { Gem, NearMark, User } from "@/components/landing/icons";
import { shortAccount } from "@/games/co-ty-phu/chain/adapt";
import { googleSignInOffered, warmGoogleSignIn } from "@/games/co-ty-phu/chain/googleSession";
import { useFreeSponsor } from "@/games/co-ty-phu/chain/useFree";
import type { PlayerState } from "@/games/co-ty-phu/chain/usePlayer";
import { CHAIN } from "@/lib/chain/config";
import "./sign-in.css";

// The club's one sign-in step. Every page that needs an account shows this same ticket, with every way in the club
// has; once somebody is in, every page plays as that account and none asks again. Its styles are its own
// (sign-in.css), so it looks the same on the desk, at the poker tables and on the account page.

/**
 * `state`: the page's `usePlayer()`. `onWatch`: where looking on without an account makes sense (a table, a match),
 * the way past this step. `extra`: what a page adds under the ways in (the local helper's test accounts).
 */
export function SignIn({ state, onWatch, extra }: { state: PlayerState; onWatch?: () => void; extra?: ReactNode }) {
  const { busy, problem, grant } = state;
  // Google sign-in rests on the sponsor: it pays for the one signature and for every move after it.
  const sponsor = useFreeSponsor();
  const google = Boolean(sponsor) && googleSignInOffered();
  useEffect(() => {
    if (google) warmGoogleSignIn();
  }, [google]);
  const style = { "--si-paper": `url(${paper.src})` } as CSSProperties;

  // A Google sign-in halfway: the person is known, the key that lets this browser play waits for their approval.
  if (grant) {
    return (
      <section className="si" style={style} aria-label="Finish signing in">
        <h2 className="si-title">Check in</h2>
        <p className="si-who">
          <strong title={grant.identity.accountId}>{grant.identity.label}</strong>
          <small>Your NEAR account: {shortAccount(grant.identity.accountId)}</small>
        </p>
        <p className="si-lede">
          One approval and this browser can play for you. It gets a key that moves your seat in Deedlords and nothing else: it cannot spend, and you are not asked again.
        </p>
        <button type="button" className="si-go" disabled={busy} onClick={state.confirmGoogle}>
          {busy ? "Waiting for your approval…" : "Approve this browser"}
        </button>
        <button type="button" className="si-quiet" disabled={busy} onClick={state.cancelGoogle}>
          Cancel
        </button>
        {problem && (
          <p className="si-problem" role="alert">
            {problem}
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="si" style={style} aria-label="Sign in">
      <h2 className="si-title">Check in</h2>
      <p className="si-lede">One sign-in for the whole club. It opens every table, Deedlords and Poker, and no page asks again.</p>
      <button type="button" className="si-go" disabled={busy} onClick={state.signInGuest}>
        <User size={20} /> Play as a guest
      </button>
      <p className="si-fine">A new game account, its key kept in this browser. Nothing to install, and free tables need no NEAR.</p>
      <div className="si-ways">
        {google && (
          <button type="button" className="si-way" disabled={busy} onClick={state.signInGoogle}>
            <b className="si-way__g" aria-hidden="true">
              G
            </b>
            <span>
              <strong>{busy ? "Signing you in…" : "Google"}</strong>
              <small>A NEAR account of your own. Poker adds a game account</small>
            </span>
          </button>
        )}
        <button type="button" className="si-way" disabled={busy} onClick={state.signInEvm}>
          <Gem size={20} />
          <span>
            <strong>EVM wallet</strong>
            <small>MetaMask, Rabby, Coinbase. Both games</small>
          </span>
        </button>
        {CHAIN.wallets && (
          <button type="button" className="si-way" disabled={busy} onClick={state.signInWallet}>
            <NearMark size={20} />
            <span>
              <strong>NEAR wallet</strong>
              <small>Meteor, Intear, Nightly. Poker adds a game account</small>
            </span>
          </button>
        )}
      </div>
      {extra}
      {onWatch && (
        <button type="button" className="si-quiet" disabled={busy} onClick={onWatch}>
          Just watch, without signing in
        </button>
      )}
      {problem && (
        <p className="si-problem" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
