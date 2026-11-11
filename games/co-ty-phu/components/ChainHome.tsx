"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CHAIN } from "@/lib/chain/config";
import { chainClient } from "@/lib/chain/shared";
import { formatBps, formatNear, seatNames } from "../chain/adapt";
import { MOVE_HOLD, STORAGE_DEPOSIT, near, newMatchId, openDuelCalls, upfront } from "../chain/calls";
import { devCreateMatch, useDevConfig, type DevConfig, type NewMatch } from "../chain/devSession";
import type { ChainListed } from "../chain/types";
import { sendStake, usePlayer, type Player } from "../chain/usePlayer";
import { BoardArt, Icon } from "./LobbyArt";
import { Passport } from "./Passport";

const REFRESH_MS = 3_000;
/** What a seat may cost in a match opened here, in NEAR; the contract's own cap cuts the list. */
const STAKES = [0.05, 0.1, 0.25, 0.5, 1];
const ROUNDS = [3, 6, 12];
const TURN_SECONDS = 60;
type Limits = { max_stake: string; fee_bps: number };

const problemText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The front desk of the game: the board, who you are, a match to open, and the matches the contract holds right now. */
export function ChainHome() {
  const state = usePlayer();
  const { player } = state;
  const helper = useDevConfig();
  const [matches, setMatches] = useState<ChainListed[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [limits, setLimits] = useState<Limits | null>(null);

  useEffect(() => {
    let stopped = false;
    const load = () =>
      chainClient.view<ChainListed[]>("list_matches", { from_index: 0, limit: 50 }).then(
        (listed) => {
          if (stopped) return;
          setMatches(listed);
          setOffline(false);
        },
        () => !stopped && setOffline(true),
      );
    void load();
    chainClient.view<Limits>("get_config").then(
      (config) => !stopped && setLimits(config),
      () => undefined,
    );
    const timer = setInterval(() => document.visibilityState !== "hidden" && void load(), REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  const linkTo = (id: string) => `/play/${encodeURIComponent(id)}${player?.via === "helper" ? `?as=${encodeURIComponent(player.accountId)}` : ""}`;

  return (
    <main className="tp dl">
      <header className="dl-hero">
        <BoardArt />
        <h1 className="dl-logo">Deedlords</h1>
        <p className="dl-tagline">Buy the world's priciest cities, collect rent, take the pot. The rules, the dice and the stakes live in a NEAR contract.</p>
        <p className="dl-chips">
          <span className="dl-chip">{CHAIN.contractId}</span>
          <span className="dl-chip">NEAR {CHAIN.network}</span>
          {limits && limits.fee_bps > 0 && <span className="dl-chip">{formatBps(limits.fee_bps)} of the pot is the fee</span>}
        </p>
      </header>

      <Passport state={state} helper={helper} />
      {player && <OpenMatch player={player} balance={state.balance} helper={helper} limits={limits} linkTo={linkTo} />}

      <section className="dl-panel dl-departures" aria-label="Matches">
        <h2 className="dl-title">
          <Icon name="plane" /> Departures
        </h2>
        {offline && <p className="dl-problem">Cannot reach {CHAIN.network} right now, trying again…</p>}
        {matches === null ? (
          !offline && <p className="dl-muted">Reading the contract…</p>
        ) : matches.length === 0 ? (
          <p className="dl-muted">No match is open. Open one above and send the link to a friend.</p>
        ) : (
          <ul className="dl-flights">
            {matches.map((match) => {
              const names = seatNames(match);
              const open = match.seats.filter((seat) => seat.backer === null).length;
              return (
                <li key={match.id}>
                  <Link className="dl-flight" href={linkTo(match.id)}>
                    <span className="dl-flight__code">{match.id}</span>
                    <span className="dl-flight__who">{match.seats.map((seat) => (seat.backer === null ? "open seat" : names[seat.seat])).join("  ·  ")}</span>
                    <span className="dl-flight__stake">{formatNear(match.stake)} NEAR</span>
                    <span className="dl-flight__status" data-open={open > 0 || undefined}>
                      {match.status === "lobby" ? (open > 0 ? "Boarding" : "Starting") : `Round ${Math.min(match.round + 1, match.rules.maxRounds)}/${match.rules.maxRounds}`}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}

/** Opening a match. A game account or a wallet picks the stake; a helper's test account takes the helper's own. */
function OpenMatch({
  player,
  balance,
  helper,
  limits,
  linkTo,
}: {
  player: Player;
  balance: bigint | null | undefined;
  helper: DevConfig | null;
  limits: Limits | null;
  linkTo: (id: string) => string;
}) {
  const router = useRouter();
  const [stake, setStake] = useState(STAKES[0]);
  const [rounds, setRounds] = useState(ROUNDS[1]);
  const [opening, setOpening] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const run = async (open: () => Promise<string>) => {
    setOpening(true);
    setProblem(null);
    try {
      router.push(linkTo(await open()));
    } catch (error) {
      setProblem(problemText(error));
      setOpening(false);
    }
  };

  if (player.via === "helper") {
    const withHelper = (match: NewMatch) => run(async () => (await devCreateMatch({ ...match, player: player.accountId })).id);
    return (
      <section className="dl-panel dl-open" aria-label="Open a match">
        <h2 className="dl-title">Open a match</h2>
        <div className="tp-row">
          {helper?.solo && (
            <button type="button" className="tp-btn tp-btn--main" disabled={opening} onClick={() => withHelper({ kind: "solo" })}>
              Play the house
            </button>
          )}
          <button type="button" className={helper?.solo ? "tp-btn" : "tp-btn tp-btn--main"} disabled={opening} onClick={() => withHelper({ kind: "duel", open: true })}>
            {opening ? "Opening…" : "Open a duel"}
          </button>
        </div>
        <p className="dl-muted">The helper on this machine signs for its test accounts{helper ? `: ${formatNear(helper.stake)} NEAR a seat.` : "."}</p>
        {problem && (
          <p className="dl-problem" role="alert">
            {problem}
          </p>
        )}
      </section>
    );
  }

  const stakes = STAKES.filter((amount) => limits === null || near(amount) <= BigInt(limits.max_stake));
  const cost = near(stake) + STORAGE_DEPOSIT;
  const terms = { stake: near(stake), maxRounds: rounds, turnSeconds: TURN_SECONDS };
  // What the account must hold: enough for the node to take the transaction, and enough left to make moves after it.
  const needed = (() => {
    const hold = upfront(openDuelCalls("m", terms));
    const after = cost + MOVE_HOLD + near(0.005);
    return hold > after ? hold : after;
  })();
  // A wallet shows its own balance and refuses what it cannot pay; a game account is checked here.
  const short = player.via === "key" && balance !== undefined && (balance === null || balance < needed);
  const open = () =>
    run(async () => {
      const id = newMatchId();
      await sendStake(player, openDuelCalls(id, terms));
      return id;
    });

  return (
    <section className="dl-panel dl-open" aria-label="Open a match">
      <h2 className="dl-title">Open a duel</h2>
      <div className="dl-field">
        <span>Stake a seat</span>
        <div className="dl-segments" role="group" aria-label="Stake a seat">
          {stakes.map((amount) => (
            <button key={amount} type="button" aria-pressed={amount === stake} onClick={() => setStake(amount)}>
              {amount}
            </button>
          ))}
        </div>
      </div>
      <div className="dl-field">
        <span>Rounds</span>
        <div className="dl-segments" role="group" aria-label="Rounds">
          {ROUNDS.map((count) => (
            <button key={count} type="button" aria-pressed={count === rounds} onClick={() => setRounds(count)}>
              {count}
            </button>
          ))}
        </div>
      </div>
      <p className="dl-sum">
        <span>
          Pot <strong>{formatNear((near(stake) * 2n).toString())} NEAR</strong>
        </span>
        <span>
          Winner takes <strong>70%</strong>
          {limits && limits.fee_bps > 0 ? ` after the ${formatBps(limits.fee_bps)} fee` : ""}
        </span>
      </p>
      <button type="button" className="tp-btn tp-btn--main tp-btn--big" disabled={opening || short} onClick={open}>
        {opening ? (player.via === "wallet" ? "Waiting for your wallet…" : "Opening the match…") : `Open for ${formatNear(cost.toString())} NEAR`}
      </button>
      <p className="dl-muted">
        {short
          ? `Your game account needs ${formatNear(needed.toString(), 2)} NEAR for this: the ${formatNear(cost.toString())} above, and about 0.1 the network holds for gas while you play (it comes back).`
          : `That is your stake and a ${formatNear(STORAGE_DEPOSIT.toString())} NEAR storage deposit, which comes back when the match is settled, less about 0.012.`}
      </p>
      {problem && (
        <p className="dl-problem" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
