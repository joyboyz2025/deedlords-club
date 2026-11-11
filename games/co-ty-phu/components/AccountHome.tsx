"use client";

import Link from "next/link";
import { Arrow } from "@/components/landing/icons";
import { CHAIN } from "@/lib/chain/config";
import { useDevConfig } from "../chain/devSession";
import { useAgent } from "../chain/useAgent";
import { useFreeSponsor } from "../chain/useFree";
import { usePlayer } from "../chain/usePlayer";
import { AgentStub, Hall, PassengerStub } from "./Desk";

/** What each game of the hall asks of an account. A Google account's key in the browser is granted for Deedlords only. */
const GAMES = [
  { href: "/play", name: "Deedlords", line: "Buy the world's priciest cities, collect rent, win the pot.", takes: "Any account. Free tables need no NEAR." },
  { href: "/poker", name: "Poker", line: "Heads-up Hold'em, dealt as mental poker: nobody holds the deck.", takes: "A guest or EVM-wallet game account, with test NEAR on it." },
  { href: "/arena", name: "Arena", line: "A sealed-bid market and a hex-grid fight with no dice.", takes: "A guest or EVM-wallet game account, with test NEAR on it." },
];

/**
 * The visitor's account, on a page of its own: connecting it, what it holds, NEAR in and out, its keys. One account
 * for every game of the hall: whoever is signed in here is signed in at each table.
 */
export function AccountHome() {
  const state = usePlayer();
  const { player } = state;
  const helper = useDevConfig();
  const sponsor = useFreeSponsor();
  const account = player === undefined ? undefined : player && { accountId: player.accountId, balance: state.balance };

  return (
    <Hall page="account" account={account}>
      <div className="fd-hall">
        <section className="fd-wall">
          <h1 className="fd-line">{player ? "Your account." : "Connect once, play anywhere here."}</h1>
          <p className="fd-lede">
            {player
              ? `This is who you are at every table of the hall, on NEAR ${CHAIN.network}. NEAR you send to it is yours to stake and to take out again.`
              : "A guest account, your Google sign-in, an EVM wallet or a NEAR wallet: whichever you pick is your account at every table of the hall."}
          </p>
          <section className="fd-board" aria-label="Games">
            <h2 className="fd-board__title">
              <span>Games</span>
            </h2>
            <ul className="fd-games">
              {GAMES.map((game) => (
                <li key={game.href}>
                  <Link href={game.href}>
                    <strong>{game.name}</strong>
                    <span>{game.line}</span>
                    <small>{game.takes}</small>
                    <Arrow size={20} />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </section>
        <aside className="fd-ticket" aria-label="Your account">
          <PassengerStub state={state} helper={helper} freePlay={Boolean(sponsor)} wallet />
        </aside>
      </div>
    </Hall>
  );
}

/** The visitor's agents, on a page of their own, with room to write what each is told. */
export function AgentsHome() {
  const state = usePlayer();
  const { player } = state;
  const desk = useAgent(player?.accountId ?? null);
  const account = player === undefined ? undefined : player && { accountId: player.accountId, balance: state.balance };

  return (
    <Hall page="agents" account={account}>
      <div className="fd-hall fd-hall--write">
        <section className="fd-wall">
          <h1 className="fd-line">Your agents, your words.</h1>
          <p className="fd-lede">
            Make as many as you like and name each one. Tell it how to play in a prompt as long as you need, and add rules one by one. At a table you hand your seat to the one you
            picked, and take it back whenever you want.
          </p>
          <ul className="fd-points">
            <li>
              <strong>What you tell it is yours.</strong> It is kept in this browser and goes to the model with each of your turns. The other players are shown that an AI plays
              your seat, never your prompt, your rules or what your agent says.
            </li>
            <li>
              <strong>It cannot cheat for you.</strong> An agent only chooses among moves the contract allows, and signs them with your own game key.
            </li>
            <li>
              <strong>It never stalls.</strong> If the model is slow or refuses, the agent plays that turn by its fallback numbers.
            </li>
          </ul>
          {!player && (
            <Link className="fd-jump" href="/account">
              Connect an account to make one
            </Link>
          )}
        </section>
        <aside className="fd-ticket" aria-label="Your agents">
          <AgentStub desk={desk} signedIn={Boolean(player)} roomy />
        </aside>
      </div>
    </Hall>
  );
}
