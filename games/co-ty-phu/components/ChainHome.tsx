"use client";

import { CHAIN } from "@/lib/chain/config";
import { RULES_MODEL } from "../agent/llm";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { chainClient } from "@/lib/chain/shared";
import { formatBps, formatNear } from "../chain/adapt";
import {
  FREE_GUEST_SEAT,
  joinCalls,
  near,
  neededToOpen,
  newMatchId,
  openDuelCalls,
  ownStake,
  ROUND_CHOICES,
  roundsFor,
  roundsLabel,
  RULES,
  SEAT_COUNTS,
  SMALLEST_STAKE,
  SPLITS,
  STORAGE_DEPOSIT,
  TO_THE_END,
  TURN_SECONDS,
  winLine,
} from "../chain/calls";
import { devCreateMatch, useDevConfig, type DevConfig, type NewMatch } from "../chain/devSession";
import { openFreeTable, requestFreeTable, type FreeOpponent } from "../chain/free";
import type { ChainListed } from "../chain/types";
import { armAgent, useAgent } from "../chain/useAgent";
import { useFreeSponsor } from "../chain/useFree";
import { approvesInWindow, sendStake, usePlayer, type Player } from "../chain/usePlayer";
import { Arrow } from "@/components/landing/icons";
import { AgentStub, CheckIn, DeparturesBoard, Hall, PassengerStub } from "./Desk";
import { TopUp } from "./TopUp";

const REFRESH_MS = 3_000;
/** What a seat may cost in a match opened here, in NEAR; the contract's own cap cuts the list. */
const STAKES = [SMALLEST_STAKE, 0.1, 0.25, 0.5, 1];
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
          // A room everybody has left (or one only the house's agents sit in) is nobody's game: not listed. The
          // contract closes it 15 minutes after it was opened.
          setMatches(listed.filter((match) => match.status !== "lobby" || match.seats.some((seat) => seat.backer !== null && seat.backer !== match.creator) || match.seats.some((seat) => seat.backer === match.creator && match.stake !== "0")));
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
          <h1 className="fd-line">{player === null ? "Check in, then pick a flight." : "Pick a flight, or open one."}</h1>
          <p className="fd-lede">
            The contract holds every match on this board. Stakes are {CHAIN.network === "mainnet" ? "real NEAR" : "test NEAR"}
            {limits && limits.fee_bps > 0 ? `; it keeps ${formatBps(limits.fee_bps)} of each pot` : ""}.
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
          {player === null ? (
            // Nobody signed in: the club's one sign-in step lies on the desk. The stubs are dealt once it is done.
            <CheckIn state={state} helper={helper} />
          ) : (
            <>
              <PassengerStub state={state} helper={helper} freePlay={Boolean(sponsor)} compact />
              <FlightStub
                player={player ?? null}
                balance={state.balance}
                helper={helper}
                limits={limits}
                linkTo={linkTo}
                sponsor={sponsor ?? null}
                onFunded={() => void state.refreshBalance()}
              />
              <AgentStub desk={desk} signedIn={Boolean(player)} compact />
            </>
          )}
        </aside>
      </div>
    </Hall>
  );
}

/** The models this server offers for agents (GET /api/agent/playbook); empty while read, or when none is configured. */
function useOfferedModels(): string[] {
  const [models, setModels] = useState<string[]>([]);
  useEffect(() => {
    let stopped = false;
    fetch("/api/agent/playbook")
      .then((response) => (response.ok ? (response.json() as Promise<{ models: string[] }>) : { models: [] }))
      .then((answer) => !stopped && setModels(answer.models ?? []))
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, []);
  return models;
}

/** How a table is played: against the house's agents, with friends in a room, or for a stake. */
type Mode = "ai" | "friends" | "stake";
const MODES: Record<Mode, { name: string; line: string }> = {
  ai: { name: "vs AI", line: "Free" },
  friends: { name: "Friends", line: "Free room" },
  stake: { name: "Stake", line: "Win NEAR" },
};
const roundsWords = (rounds: number) => (rounds >= TO_THE_END ? "to the end" : `${rounds} rounds`);

/**
 * The stub that starts a game, built like a casual game's play screen: pick how to play, press one button. Everything
 * else has a default and folds under "Table options". Signed out, the button seats a guest first and then opens the
 * table. A helper's test account takes the helper's own stake.
 */
function FlightStub({
  player,
  balance,
  helper,
  limits,
  linkTo,
  sponsor,
  onFunded,
}: {
  player: Player | null;
  balance: bigint | null | undefined;
  helper: DevConfig | null;
  limits: Limits | null;
  linkTo: (id: string) => string;
  /** The account that pays for free tables, `null` when nobody does. */
  sponsor: string | null;
  /** NEAR was brought to the account: read its balance again. */
  onFunded: () => void;
}) {
  const router = useRouter();
  const modes: Mode[] = sponsor ? ["ai", "friends", "stake"] : ["stake"];
  const [picked, setPicked] = useState<Mode | null>(null);
  const mode = picked !== null && modes.includes(picked) ? picked : modes[0];
  // `null`: not chosen yet, so the first chip stands.
  const [chosen, setChosen] = useState<number | null>(null);
  // A stake of the visitor's own, typed in NEAR: it stands instead of the chips while it is filled in.
  const [typed, setTyped] = useState("");
  const [typing, setTyping] = useState(false);
  // `null`: not chosen, so the table is opened with the rounds that suit its seats.
  const [pickedRounds, setRounds] = useState<number | null>(null);
  const [seatCount, setSeatCount] = useState(SEAT_COUNTS[0]);
  // The house's agents at a free table: one model each, picked from what this server offers.
  const offered = useOfferedModels();
  const [agentModels, setAgentModels] = useState<string[]>([RULES_MODEL]);
  const pickable = [...offered, RULES_MODEL];
  // Until the visitor picks, the agents take the offered models in turn, so that two agents play two models: first
  // the ones NEAR AI runs in a TEE (`near:`), whose moves carry a proof anyone can check on /verify.
  const inTurn = [...offered.filter((model) => model.startsWith("near:")), ...offered.filter((model) => !model.startsWith("near:"))];
  const [pickedModels, setPickedModels] = useState(false);
  useEffect(() => {
    if (!pickedModels && offered.length > 0) setAgentModels((now) => now.map((_, i) => inTurn[i % inTurn.length]));
  }, [offered, pickedModels]);
  const setAgentCount = (count: number) => setAgentModels((now) => Array.from({ length: count }, (_, i) => now[i] ?? (offered.length ? inTurn[i % inTurn.length] : RULES_MODEL)));
  // A free room of friends may seat the house's agents too: the host, at least one seat for a friend, agents in the rest.
  const [roomBots, setRoomBots] = useState<string[]>([]);
  const setRoomBotCount = (count: number) => setRoomBots((now) => Array.from({ length: count }, (_, i) => now[i] ?? (offered.length ? inTurn[i % inTurn.length] : RULES_MODEL)));
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

  const stakes = STAKES.filter((amount) => limits === null || near(amount) <= BigInt(limits.max_stake));
  const largest = limits === null ? 1 : Number(BigInt(limits.max_stake) / 10n ** 21n) / 1000;
  const own = ownStake(typed, largest);
  const preset = chosen !== null && stakes.includes(chosen) ? chosen : (stakes[0] ?? STAKES[0]);
  const free = mode !== "stake";
  const ownTyped = typing && typed.trim() !== "";
  const stake = free ? 0 : ownTyped && "amount" in own ? own.amount : preset;
  const typedProblem = !free && ownTyped && "problem" in own ? own.problem : null;
  const opponent: FreeOpponent = mode === "ai" ? "agent" : "friend";
  const cost = near(stake) + STORAGE_DEPOSIT;
  // Against the house agent: the game starts as soon as the visitor sits. Any other table is a room: whoever opens it
  // hosts it, the seats fill as people come, and the game starts when the host says so.
  const room = mode !== "ai";
  const seats = room ? seatCount : 1 + agentModels.length;
  const rounds = pickedRounds ?? roundsFor(seats);
  const bots = mode === "friends" ? roomBots.slice(0, Math.max(0, seatCount - 2)) : [];
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
        const agents = opponent === "agent" ? agentModels : bots.length ? bots : undefined;
        if (player!.via === "key") return openFreeTable(player!.session, rounds, opponent, seats, agents);
        const id = await requestFreeTable(rounds, opponent, { host: player!.accountId, seats }, agents);
        await sendStake(player!, joinCalls(id, FREE_GUEST_SEAT, 0n));
        return id;
      }
      const id = newMatchId();
      await sendStake(player!, openDuelCalls(id, terms));
      return id;
    });
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

  const label = opening
    ? !player
      ? "Opening…"
      : player.via === "wallet"
        ? "Waiting for your wallet…"
        : approvesInWindow(player) && !free
          ? "Waiting for your approval…"
          : free
            ? "Opening your table…"
            : "Opening the match…"
    : mode === "ai"
      ? agentModels.length === 1
        ? "Play vs AI"
        : `Play vs ${agentModels.length} AIs`
      : mode === "friends"
        ? `Open a room of ${seats}`
        : `Open for ${formatNear(cost.toString())} NEAR`;
  const options = mode === "ai" ? `${agentModels.length} ${agentModels.length === 1 ? "AI" : "AIs"} · ${roundsWords(rounds)}` : `${seats} seats${bots.length ? ` · ${bots.length} ${bots.length === 1 ? "AI" : "AIs"}` : ""} · ${roundsWords(rounds)}`;

  return (
    <section className="fd-stub" aria-label="Start a game">
      <h2 className="fd-stub__title">New game</h2>
      {modes.length > 1 && (
        <div className="fd-modes" role="group" aria-label="How to play">
          {modes.map((entry) => (
            <button key={entry} type="button" aria-pressed={entry === mode} onClick={() => setPicked(entry)}>
              <b>{MODES[entry].name}</b>
              <small>{MODES[entry].line}</small>
            </button>
          ))}
        </div>
      )}
      {!free && (
        <div className="fd-pick fd-pick--stake">
          <span id="fd-stake">A seat costs</span>
          <div className="fd-segments" role="group" aria-labelledby="fd-stake">
            {stakes.map((amount) => (
              <button
                key={amount}
                type="button"
                aria-pressed={!ownTyped && amount === stake}
                onClick={() => {
                  setChosen(amount);
                  setTyping(false);
                }}
              >
                {amount}
              </button>
            ))}
            <button type="button" aria-pressed={ownTyped} aria-expanded={typing} onClick={() => setTyping(!typing)}>
              Other
            </button>
          </div>
        </div>
      )}
      {!free && typing && (
        <div className="fd-pick fd-own">
          <label htmlFor="fd-own-stake">Your own stake</label>
          <span className="fd-own__box">
            <input
              id="fd-own-stake"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              autoFocus
              placeholder={`${SMALLEST_STAKE} to ${largest}`}
              value={typed}
              aria-invalid={typedProblem ? true : undefined}
              aria-describedby={typedProblem ? "fd-own-problem" : undefined}
              onChange={(event) => setTyped(event.target.value.replace(",", "."))}
            />
            <span aria-hidden="true">NEAR</span>
          </span>
        </div>
      )}
      {typedProblem && (
        <p id="fd-own-problem" className="fd-problem fd-own__problem" role="alert">
          {typedProblem}
        </p>
      )}
      {!free && (
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
      <button type="button" className="fd-go" disabled={!player || opening || short || stakes.length === 0 || Boolean(typedProblem)} onClick={open}>
        {label}
        {!opening && <Arrow size={20} />}
      </button>
      <details className="fd-more">
        <summary>
          <span>
            <b>Table options</b>
            <small>{options}</small>
          </span>
        </summary>
        <div className="fd-more__body">
          {mode === "ai" && (
            <>
              <div className="fd-pick">
                <span id="fd-agents">AI opponents</span>
                <div className="fd-segments" role="group" aria-labelledby="fd-agents">
                  {[1, 2, 3].map((count) => (
                    <button key={count} type="button" aria-pressed={count === agentModels.length} onClick={() => setAgentCount(count)}>
                      {count}
                    </button>
                  ))}
                </div>
              </div>
              {agentModels.map((model, i) => (
                <label key={i} className="fd-field">
                  <span>AI {i + 1} plays by</span>
                  <select
                    value={pickable.includes(model) ? model : RULES_MODEL}
                    onChange={(event) => {
                      setPickedModels(true);
                      setAgentModels((now) => now.map((old, j) => (j === i ? event.target.value : old)));
                    }}
                  >
                    {pickable.map((name) => (
                      <option key={name} value={name}>
                        {name === RULES_MODEL ? "No model: house numbers" : name}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </>
          )}
          {mode === "friends" && free && (
            <>
              <div className="fd-pick">
                <span id="fd-bots">AI seats</span>
                <div className="fd-segments" role="group" aria-labelledby="fd-bots">
                  {Array.from({ length: seatCount - 1 }, (_, count) => (
                    <button key={count} type="button" aria-pressed={count === bots.length} onClick={() => setRoomBotCount(count)}>
                      {count}
                    </button>
                  ))}
                </div>
              </div>
              {bots.map((model, i) => (
                <label key={i} className="fd-field">
                  <span>AI {i + 1} plays by</span>
                  <select value={pickable.includes(model) ? model : RULES_MODEL} onChange={(event) => setRoomBots((now) => now.map((old, j) => (j === i ? event.target.value : old)))}>
                    {pickable.map((name) => (
                      <option key={name} value={name}>
                        {name === RULES_MODEL ? "No model: house numbers" : name}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </>
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
              {ROUND_CHOICES.map((count) => (
                <button key={count} type="button" aria-pressed={count === rounds} onClick={() => setRounds(count)}>
                  {roundsLabel(count)}
                </button>
              ))}
            </div>
          </div>
          <p className="fd-fine">{winLine({ blitz: RULES.blitz, maxRounds: rounds })}</p>
        </div>
      </details>
      {/* Too little on the account for this stake: the way to the missing NEAR, right here. */}
      {player && !free && short && !typedProblem ? (
        <TopUp player={player} balance={balance} needed={needed} onArrived={onFunded} />
      ) : (
        <p className="fd-fine">
          {mode === "ai"
            ? "Nothing staked, nothing won, no NEAR needed. The house opens the table, seats its AI and pays the gas; every move is still a transaction."
            : mode === "friends"
              ? "Nothing staked and the house pays the gas. You host the room: send its link, then start when everybody is in."
              : !player
                ? `A stake needs NEAR on your account: ${formatNear(cost.toString())} NEAR for this seat, with its storage deposit.`
                : `Your stake and a ${formatNear(STORAGE_DEPOSIT.toString())} NEAR storage deposit, which comes back at settlement, less about 0.012. ${approvesInWindow(player) ? "You approve the stake in the sign-in window. " : ""}You host the room: send its link, then start.`}
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
