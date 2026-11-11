"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { chainClient } from "@/lib/chain/shared";
import { formatBps, formatNear } from "../chain/adapt";
import { near, neededToOpen, newMatchId, openDuelCalls, SMALLEST_STAKE, STORAGE_DEPOSIT } from "../chain/calls";
import { devCreateMatch, useDevConfig, type DevConfig, type NewMatch } from "../chain/devSession";
import type { ChainListed } from "../chain/types";
import { armAgent, useAgent } from "../chain/useAgent";
import { sendStake, usePlayer, type Player } from "../chain/usePlayer";
import { Arrow } from "@/components/landing/icons";
import { AgentStub, DeparturesBoard, Hall, PassengerStub } from "./Desk";

const REFRESH_MS = 3_000;
/** What a seat may cost in a match opened here, in NEAR; the contract's own cap cuts the list. */
const STAKES = [SMALLEST_STAKE, 0.1, 0.25, 0.5, 1];
const ROUNDS = [3, 6, 12];
const TURN_SECONDS = 60;
type Limits = { max_stake: string; fee_bps: number };

const problemText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The front desk of the game: the matches the contract holds on the wall, and the visitor's own ticket on the desk. */
export function ChainHome() {
  const state = usePlayer();
  const { player } = state;
  const helper = useDevConfig();
  const desk = useAgent(player?.accountId ?? null);
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
  const boarding = matches?.filter((match) => match.status === "lobby" && match.seats.some((seat) => seat.backer === null)).length ?? 0;

  return (
    <Hall>
      <div className="fd-hall">
        <section className="fd-wall">
          <h1 className="fd-line">Pick a flight, or open one.</h1>
          <p className="fd-lede">
            The contract holds every match on this board. Stakes are test NEAR{limits && limits.fee_bps > 0 ? `; it keeps ${formatBps(limits.fee_bps)} of each pot` : ""}.
          </p>
          <a className="fd-jump" href="#departures">
            {matches === null
              ? "Reading the board"
              : boarding > 0
                ? `${boarding} ${boarding === 1 ? "match is" : "matches are"} boarding`
                : matches.length > 0
                  ? `${matches.length} ${matches.length === 1 ? "match" : "matches"} in play`
                  : "No match open yet"}
          </a>
          <DeparturesBoard matches={matches} offline={offline} linkTo={linkTo} you={player?.accountId ?? null} />
        </section>
        <aside className="fd-ticket" aria-label="Your ticket">
          <PassengerStub state={state} helper={helper} />
          <AgentStub desk={desk} signedIn={Boolean(player)} />
          <FlightStub player={player ?? null} balance={state.balance} helper={helper} limits={limits} linkTo={linkTo} />
        </aside>
      </div>
    </Hall>
  );
}

/** The last stub: opening a match. A game account or a wallet picks the stake; a helper's test account takes the helper's own. */
function FlightStub({
  player,
  balance,
  helper,
  limits,
  linkTo,
}: {
  player: Player | null;
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
      const id = await open();
      armAgent(id, player?.accountId ?? null);
      router.push(linkTo(id));
    } catch (error) {
      setProblem(problemText(error));
      setOpening(false);
    }
  };

  if (player?.via === "helper") {
    const withHelper = (match: NewMatch) => run(async () => (await devCreateMatch({ ...match, player: player.accountId })).id);
    return (
      <section className="fd-stub" aria-label="Open a match">
        <h2 className="fd-stub__title">Flight</h2>
        <p className="fd-small">
          The helper on this machine signs for its test accounts
          {helper ? `: ${formatNear(helper.stake)} NEAR a seat.` : "."}
        </p>
        <button type="button" className="fd-go" disabled={opening} onClick={() => withHelper({ kind: "duel", open: true })}>
          {opening ? "Opening…" : "Open a duel"} <Arrow size={20} />
        </button>
        {helper?.solo && (
          <button type="button" className="fd-pill" disabled={opening} onClick={() => withHelper({ kind: "solo" })}>
            Play the house instead
          </button>
        )}
        {problem && (
          <p className="fd-problem" role="alert">
            {problem}
          </p>
        )}
      </section>
    );
  }

  const stakes = STAKES.filter((amount) => limits === null || near(amount) <= BigInt(limits.max_stake));
  const cost = near(stake) + STORAGE_DEPOSIT;
  const terms = {
    stake: near(stake),
    maxRounds: rounds,
    turnSeconds: TURN_SECONDS,
  };
  // What the account must hold: enough for the node to take the transaction, and enough left to make moves after it.
  const needed = neededToOpen(terms);
  // A wallet shows its own balance and refuses what it cannot pay; a game account is checked here.
  const short = player?.via === "key" && balance !== undefined && (balance === null || balance < needed);
  const pot = near(stake) * 2n;
  const fee = limits ? (pot * BigInt(limits.fee_bps)) / 10_000n : 0n;
  const open = () =>
    run(async () => {
      const id = newMatchId();
      await sendStake(player!, openDuelCalls(id, terms));
      return id;
    });

  return (
    <section className="fd-stub" aria-label="Open a match">
      <h2 className="fd-stub__title">Flight</h2>
      <div className="fd-pick">
        <span id="fd-stake">Stake a seat</span>
        <div className="fd-segments" role="group" aria-labelledby="fd-stake">
          {stakes.map((amount) => (
            <button key={amount} type="button" aria-pressed={amount === stake} onClick={() => setStake(amount)}>
              {amount}
            </button>
          ))}
        </div>
      </div>
      <div className="fd-pick">
        <span id="fd-rounds">Rounds</span>
        <div className="fd-segments" role="group" aria-labelledby="fd-rounds">
          {ROUNDS.map((count) => (
            <button key={count} type="button" aria-pressed={count === rounds} onClick={() => setRounds(count)}>
              {count}
            </button>
          ))}
        </div>
      </div>
      <dl className="fd-sum">
        <div>
          <dt>Pot for two seats</dt>
          <dd>
            {formatNear(pot.toString())} <small>NEAR</small>
          </dd>
        </div>
        <div>
          <dt>Winner takes</dt>
          <dd>
            {formatNear((((pot - fee) * 70n) / 100n).toString(), 3)} <small>NEAR</small>
          </dd>
        </div>
      </dl>
      <button type="button" className="fd-go" disabled={!player || opening || short} onClick={open}>
        {!player
          ? "Check in to open a match"
          : opening
            ? player.via === "wallet"
              ? "Waiting for your wallet…"
              : "Opening the match…"
            : `Open for ${formatNear(cost.toString())} NEAR`}
        {player && !opening && <Arrow size={20} />}
      </button>
      {player && (
        <p className="fd-fine">
          {short
            ? `Your game account needs ${formatNear(needed.toString(), 2)} NEAR: the ${formatNear(near(stake).toString())} stake, a ${formatNear(STORAGE_DEPOSIT.toString())} storage deposit and about ${formatNear((needed - cost).toString(), 2)} the network holds for gas while you play. The deposit and the hold come back.`
            : `Your stake and a ${formatNear(STORAGE_DEPOSIT.toString())} NEAR storage deposit, which comes back when the match is settled, less about 0.012. You get a link to send to a friend.`}
        </p>
      )}
      {problem && (
        <p className="fd-problem" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
