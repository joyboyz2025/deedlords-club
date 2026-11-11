"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { chainClient } from "@/lib/chain/shared";
import { formatBps, formatNear } from "../chain/adapt";
import { FREE_GUEST_SEAT, joinCalls, near, neededToOpen, newMatchId, openDuelCalls, SEAT_COUNTS, SMALLEST_STAKE, SPLITS, STORAGE_DEPOSIT } from "../chain/calls";
import { devCreateMatch, useDevConfig, type DevConfig, type NewMatch } from "../chain/devSession";
import { openFreeTable, requestFreeTable, type FreeOpponent } from "../chain/free";
import type { ChainListed } from "../chain/types";
import { armAgent, useAgent } from "../chain/useAgent";
import { useFreeSponsor } from "../chain/useFree";
import { approvesInWindow, sendStake, usePlayer, type Player } from "../chain/usePlayer";
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
  const sponsor = useFreeSponsor();
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
    <Hall page="play" account={player === undefined ? undefined : player && { accountId: player.accountId, balance: state.balance }}>
      <div className="fd-hall">
        <section className="fd-wall">
          <h1 className="fd-line">Pick a flight, or open one.</h1>
          <p className="fd-lede">
            The contract holds every match on this board. Stakes are test NEAR{limits && limits.fee_bps > 0 ? `; it keeps ${formatBps(limits.fee_bps)} of each pot` : ""}.
            {sponsor && " A free table costs nothing and needs no NEAR: the house pays the gas."}
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
          <PassengerStub state={state} helper={helper} freePlay={Boolean(sponsor)} />
          <AgentStub desk={desk} signedIn={Boolean(player)} />
          <FlightStub player={player ?? null} balance={state.balance} helper={helper} limits={limits} linkTo={linkTo} sponsor={sponsor ?? null} />
        </aside>
      </div>
    </Hall>
  );
}

/**
 * The last stub: opening a match. A game account or a wallet picks the stake; a helper's test account takes the
 * helper's own. Where somebody sponsors play, the first choice is a free table: nothing staked, no NEAR needed.
 */
function FlightStub({
  player,
  balance,
  helper,
  limits,
  linkTo,
  sponsor,
}: {
  player: Player | null;
  balance: bigint | null | undefined;
  helper: DevConfig | null;
  limits: Limits | null;
  linkTo: (id: string) => string;
  /** The account that pays for free tables, `null` when nobody does. */
  sponsor: string | null;
}) {
  const router = useRouter();
  // `null`: not chosen yet, so the first offer stands: a free table where there is one.
  const [chosen, setChosen] = useState<number | null>(null);
  const [opponent, setOpponent] = useState<FreeOpponent>("agent");
  const [rounds, setRounds] = useState(ROUNDS[1]);
  const [seatCount, setSeatCount] = useState(SEAT_COUNTS[0]);
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

  const stakes = [...(sponsor ? [0] : []), ...STAKES.filter((amount) => limits === null || near(amount) <= BigInt(limits.max_stake))];
  const stake = chosen !== null && stakes.includes(chosen) ? chosen : (stakes[0] ?? STAKES[0]);
  const free = stake === 0;
  const cost = near(stake) + STORAGE_DEPOSIT;
  // Against the house agent: two seats, and the game starts as soon as the visitor sits. Any other table is a room:
  // whoever opens it hosts it, the seats fill as people come, and the game starts when the host says so.
  const room = !(free && opponent === "agent");
  const seats = room ? seatCount : 2;
  const terms = {
    stake: near(stake),
    maxRounds: rounds,
    turnSeconds: TURN_SECONDS,
    seats,
    host: room ? (player?.accountId ?? null) : null,
  };
  // What the account must hold: enough for the node to take the transaction, and enough left to make moves after it.
  const needed = neededToOpen(terms);
  // A wallet shows its own balance and refuses what it cannot pay; a game account is checked here.
  const short = !free && player?.via === "key" && balance !== undefined && (balance === null || balance < needed);
  const pot = near(stake) * BigInt(seats);
  const fee = limits ? (pot * BigInt(limits.fee_bps)) / 10_000n : 0n;
  const open = () =>
    run(async () => {
      if (free) {
        // The sponsor opens the table. A game account sits through the sponsor too; a wallet account signs its own seat.
        if (player!.via === "key") return openFreeTable(player!.session, rounds, opponent, seats);
        const id = await requestFreeTable(rounds, opponent, { host: player!.accountId, seats });
        await sendStake(player!, joinCalls(id, FREE_GUEST_SEAT, 0n));
        return id;
      }
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
            <button key={amount} type="button" aria-pressed={amount === stake} onClick={() => setChosen(amount)}>
              {amount === 0 ? "Free" : amount}
            </button>
          ))}
        </div>
      </div>
      {free && (
        <div className="fd-pick">
          <span id="fd-opponent">Opponent</span>
          <div className="fd-segments" role="group" aria-labelledby="fd-opponent">
            <button type="button" aria-pressed={opponent === "agent"} onClick={() => setOpponent("agent")}>
              AI agent
            </button>
            <button type="button" aria-pressed={opponent === "friend"} onClick={() => setOpponent("friend")}>
              A friend
            </button>
          </div>
        </div>
      )}
      {room && (
        <div className="fd-pick">
          <span id="fd-seats">Seats</span>
          <div className="fd-segments" role="group" aria-labelledby="fd-seats">
            {SEAT_COUNTS.map((count) => (
              <button key={count} type="button" aria-pressed={count === seatCount} onClick={() => setSeatCount(count)}>
                {count}
              </button>
            ))}
          </div>
        </div>
      )}
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
      {free ? (
        <dl className="fd-sum">
          <div>
            <dt>You pay</dt>
            <dd>Nothing</dd>
          </div>
          <div>
            <dt>Gas</dt>
            <dd>On the house</dd>
          </div>
        </dl>
      ) : (
        <dl className="fd-sum">
          <div>
            <dt>Pot for {seats} seats</dt>
            <dd>
              {formatNear(pot.toString())} <small>NEAR</small>
            </dd>
          </div>
          <div>
            <dt>Winner takes</dt>
            <dd>
              {formatNear((((pot - fee) * BigInt(SPLITS[seats][0])) / 10_000n).toString(), 3)} <small>NEAR</small>
            </dd>
          </div>
        </dl>
      )}
      <button type="button" className="fd-go" disabled={!player || opening || short || stakes.length === 0} onClick={open}>
        {!player
          ? free
            ? "Check in to play for free"
            : "Check in to open a match"
          : opening
            ? player.via === "wallet"
              ? "Waiting for your wallet…"
              : approvesInWindow(player) && !free
                ? "Waiting for your approval…"
                : free
                  ? "Opening your table…"
                  : "Opening the match…"
            : free
              ? "Open a free table"
              : `Open for ${formatNear(cost.toString())} NEAR`}
        {player && !opening && <Arrow size={20} />}
      </button>
      {free && (
        <p className="fd-fine">
          {opponent === "agent"
            ? "The same contract, the same dice, every move a transaction. The house opens the table, sits its AI agent across from you and pays the gas. Nothing is staked, so nothing is won."
            : "The house opens the table and pays the gas. You host the room: send its link, and start the game when everybody is in. Nothing is staked, so nothing is won."}
        </p>
      )}
      {player && !free && (
        <p className="fd-fine">
          {short
            ? `Your game account needs ${formatNear(needed.toString(), 2)} NEAR: the ${formatNear(near(stake).toString())} stake, a ${formatNear(STORAGE_DEPOSIT.toString())} storage deposit and about ${formatNear((needed - cost).toString(), 2)} the network holds for gas while you play. The deposit and the hold come back.`
            : `Your stake and a ${formatNear(STORAGE_DEPOSIT.toString())} NEAR storage deposit, which comes back when the match is settled, less about 0.012. ${approvesInWindow(player) ? "You approve the stake in the sign-in window. " : ""}You host the room: send its link, and start the game when everybody is in.`}
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
