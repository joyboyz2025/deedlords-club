"use client";

import Link from "next/link";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Arrow, Bot, Copy, Seat } from "@/components/landing/icons";
import { chainClient } from "@/lib/chain/shared";
import { CHAIN } from "@/lib/chain/config";
import { PLAYBOOK_DRIVER } from "../agent/advise";
import { TOKEN_COLORS } from "../board";
import { BLITZ_DEAL } from "../engine";
import { accountLabel, formatBps, formatNear, playerName, seatNames } from "../chain/adapt";
import { LEADER_LINE, MOVE_HOLD, TICKETS_LINE, TICKET_LINES, joinCalls, near, roundsLabel, startCall, upfront, winLine } from "../chain/calls";
import { devJoin, devSeatAgent, useDevConfig, type DevConfig } from "../chain/devSession";
import type { ChainMatch, ChainResult } from "../chain/types";
import { armAgent, useAgent } from "../chain/useAgent";
import { useAgentNotes, useAutopilot } from "../chain/useAutopilot";
import { useChainRoom } from "../chain/useChainRoom";
import { isFreeTable, seatCaller, seatHouseAgent, takeFreeSeat } from "../chain/free";
import { useFreeSponsor, useHouseAgent, useHouseModels } from "../chain/useFree";
import { approvesInWindow, sendStake, usePlayer, type PlayerState } from "../chain/usePlayer";
import { AgentStub, CheckIn, Flap, Hall, PassengerStub } from "./Desk";
import { Ledger } from "./Ledger";
import { useCharacters, useLookPictures } from "../../chibi/useChibi";
import { lookFromSeat } from "../../ma-soi/look";
import { TROPHY_ART } from "../scene/art";
import { Stage, type AgentTag } from "./TycoonScreen";

const problemText = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** A figure in the waiting room is drawn this large (square), enough for a two-seat room on a dense screen. */
const FIGURE_PX = 560;

/**
 * A match that lives in the Deedlords contract, on the same table as a room-server game. Whoever holds a seat plays
 * it: with a game account kept in this browser, a NEAR wallet, or a test account of a local helper. Anybody else watches.
 */
export function ChainScreen({ id }: { id: string }) {
  const state = usePlayer();
  const helper = useDevConfig();
  const [watching, setWatching] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("as") === "") setWatching(true);
  }, []);

  if (state.player === undefined) {
    return (
      <main className="tp tp--center">
        <p className="tp-lede" aria-live="polite">
          Signing in…
        </p>
      </main>
    );
  }
  // Nobody signed in: the club's one sign-in step comes first. A match can also be looked at without an account
  // (and a link with `?as=` asks for just that).
  if (state.player === null && !watching) {
    return (
      <Hall page="gate" account={null}>
        <div className="si-page">
          <h1 className="si-page__line">Check in to board this flight.</h1>
          <CheckIn state={state} helper={helper} onWatch={() => setWatching(true)} />
        </div>
      </Hall>
    );
  }
  return <Table id={id} state={state} helper={helper} onSignIn={() => setWatching(false)} />;
}

function Table({ id, state, helper, onSignIn }: { id: string; state: PlayerState; helper: DevConfig | null; onSignIn: () => void }) {
  const player = state.player ?? null;
  const room = useChainRoom(id, player?.session ?? null);
  const { view, match, result, seat, link, error, busy, notice, sent, send, playTurn, retry, refresh } = room;
  // The players' chibi characters: once read, the table shows their names and draws their looks (chain/adapt.ts).
  useCharacters(match?.meta.seats.map((s) => (s.house ? null : s.backer)) ?? []);
  const accountId = player?.accountId ?? null;
  const autopilot = useAutopilot(id, room, playTurn, accountId);
  // While the player's agent has the seat it plays whole turns: the room does not throw the dice or end a turn itself.
  // And while the board is still playing rolls the chain has already made (TycoonScreen `useRollPace`) the room is
  // told so: the dice are thrown for somebody who has seen their turn come and let it wait, not for somebody still
  // watching the turn before.
  const { hold, watch } = room;
  const handed = Boolean(autopilot?.on);
  const [behind, setBehind] = useState(false);
  useEffect(() => hold(handed), [hold, handed]);
  useEffect(() => watch(behind), [watch, behind]);
  const notes = useAgentNotes(id, match?.meta.status === "playing");
  const sponsor = useFreeSponsor();
  // At a free table the house agent moves when somebody with the match open asks the server for its turn.
  useHouseAgent(id, room, sponsor);
  // Its agents' seats are named by the model each plays with.
  useHouseModels(id, room, sponsor);

  if (error) {
    return (
      <Notice title={error === "abandoned" ? `Match ${id} was closed` : `No match ${id}`}>
        <p className="tp-lede">
          {error === "abandoned" ? "Nobody took the last seat, so every stake went back to its player." : `${CHAIN.contractId} has no open match and no result under this name.`}
        </p>
        <div className="tp-row">
          {error === "no-match" && (
            <button type="button" className="tp-btn" onClick={retry}>
              Look again
            </button>
          )}
          <Link className="tp-btn tp-btn--main" href="/play">
            Back to the lobby
          </Link>
          <Link className="tp-btn" href="/">
            Club menu
          </Link>
        </div>
      </Notice>
    );
  }

  // Opened after the payout: the contract no longer has the board, only the result.
  if (result && !view) {
    return (
      <main className="tp tp--center">
        <div className="tp-result tp-result--page">
          <Payout
            result={result}
            names={result.seats.map(playerName)}
            accountId={accountId}
            ledger={(onClose) => (
              <Ledger
                id={id}
                sent={sent}
                nameOf={(account) => (result.seats.includes(account) ? `${playerName(account)}${account === accountId ? " (you)" : ""}` : null)}
                onClose={onClose}
              />
            )}
          />
        </div>
      </main>
    );
  }

  if (!view || !match) {
    return (
      <Notice title={`Match ${id}`}>
        <p className="tp-lede" aria-live="polite">
          {link === "offline" ? `Cannot reach ${CHAIN.network} right now, trying again…` : "Reading the match from NEAR…"}
        </p>
      </Notice>
    );
  }

  if (match.meta.status === "lobby") return <Lobby match={match} state={state} helper={helper} sponsor={sponsor ?? null} onJoined={refresh} onSignIn={onSignIn} />;

  const names = seatNames(match.meta);
  // A seat an agent played this round or the one before: what its model said stays on the card. Older notes are
  // history. A turn played by the playbook's arithmetic says the same rule every time ("Keep 150 back; buy what
  // leaves that much"): that is not shown, it only covered the board, most of all on a phone.
  const agents: Record<string, AgentTag> = {};
  const said = (note: { driver: string }) => note.driver !== PLAYBOOK_DRIVER;
  for (const note of notes) {
    const playerId = match.meta.seats[note.seat]?.player;
    if (playerId && note.round >= match.game.round - 1) {
      if (said(note)) agents[playerId] = { driver: note.driver, reason: note.reason, fallback: note.fallback };
      else delete agents[playerId];
    }
  }
  const own = seat === null ? null : match.meta.seats[seat].player;
  if (own && autopilot?.on && autopilot.last && said(autopilot.last)) agents[own] = { driver: autopilot.last.driver, reason: autopilot.last.reason, fallback: autopilot.last.fallback };
  else if (own && !autopilot?.on) delete agents[own];
  const nameOf = (account: string) => {
    const at = match.meta.seats.find((s) => s.backer === account || s.driver === account);
    return at ? `${names[at.seat]}${at.backer === accountId ? " (you)" : ""}` : null;
  };
  const ledger = (onClose?: () => void) => <Ledger id={id} sent={sent} nameOf={nameOf} onClose={onClose} />;
  return (
    <>
      <Stage
        view={view}
        offline={link === "offline"}
        send={send}
        chain={{
          // In the menu, not floating over the table: the corners belong to the players' cards.
          label: `${CHAIN.network} · ${accountId === null ? "watching" : seat === null ? `${playerName(accountId)} (no seat here)` : `${playerName(accountId)}, seat ${seat + 1}`}`,
          busy,
          onBehind: setBehind,
          here: room.here,
          choosing: room.choose,
          agents,
          autopilot: autopilot && {
            on: autopilot.on,
            thinking: autopilot.thinking,
            toggle: autopilot.toggle,
            note: autopilot.last ? `AI · ${autopilot.last.driver}: ${autopilot.last.reason}` : null,
          },
          ledger,
          // Giving up is a move like any other: the contract takes it on anybody's turn and settles what is left.
          resign: seat === null ? undefined : () => send({ t: "resign" }),
          exit: { lobby: "/play", menu: "/" },
          result: (onClose) =>
            result ? (
              <div className="tp-result" role="dialog" aria-label="Result of the match">
                <Payout result={result} names={names} accountId={accountId} onClose={onClose} ledger={ledger} />
              </div>
            ) : (
              <div className="tp-result" role="status">
                <p className="tp-result__title">Game over</p>
                <p>The contract is paying out…</p>
                <div className="tp-row">
                  <Link className="tp-btn" href="/play">
                    Back to the lobby
                  </Link>
                </div>
              </div>
            ),
        }}
      />
      {(notice ?? state.problem) && (
        <p className="tp-chain-note" role="alert">
          {notice ?? state.problem}
        </p>
      )}
    </>
  );
}

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="tp tp--center">
      <div className="tp-join">
        <h1 className="tp-join__title">{title}</h1>
        {children}
      </div>
    </main>
  );
}

/** As in the contract (HOST_GRACE_NS): how long a full room waits for its host before anyone seated may start it. */
const HOST_GRACE_MS = 30_000;

/**
 * The gate of a match: who sits where on the wall, and on the desk the visitor's ticket, whose last stub is the boarding
 * pass of this match. The last seat taken starts the game.
 */
function Lobby({
  match,
  state,
  helper,
  sponsor,
  onJoined,
  onSignIn,
}: {
  match: ChainMatch;
  state: PlayerState;
  helper: DevConfig | null;
  /** The account that pays for free tables here, `null` when nobody does. */
  sponsor: string | null;
  onJoined: () => Promise<void>;
  /** For somebody looking on without an account: back to the club's sign-in step. */
  onSignIn: () => void;
}) {
  const { meta } = match;
  const player = state.player ?? null;
  const accountId = player?.accountId ?? null;
  const desk = useAgent(accountId);
  // Each seat by its backer's chibi character (name and face) once read; an open seat, or one with no character, by default.
  const characters = useCharacters(meta.seats.map((seat) => (seat.house ? null : seat.backer)));
  const names = seatNames(meta);
  // Whoever sits stands in the room whole: their own character, or the seat's stock figure for the house and for an
  // account that has made none. An open seat has no figure.
  const figures = useLookPictures(
    meta.seats.map((seat) => (seat.backer === null ? null : (!seat.house && characters.get(seat.backer)?.look) || lookFromSeat(seat.seat))),
    FIGURE_PX,
    "figure",
  );
  const [joining, setJoining] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [starting, setStarting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [leaving, setLeaving] = useState(false);
  // A full room its host does not start: on a contract that has the rule, anyone seated may start it half a minute
  // after the last seat was taken. The clock here only says when to offer the button; the contract decides.
  const [hostGrace, setHostGrace] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    let alive = true;
    chainClient.view<{ features?: unknown }>("get_config").then(
      (config) => alive && setHostGrace(Array.isArray(config?.features) && config.features.includes("hostGrace")),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);
  const seated = accountId !== null && meta.seats.some((seat) => seat.backer === accountId);
  // In a match against the house the last free seat is the solo player's.
  const mayJoin = player !== null && !seated && (meta.solo_player === null || meta.solo_player === accountId);
  const stake = BigInt(meta.stake);
  const pot = stake * BigInt(meta.seats.length);
  // Nothing staked: nothing to share out. `sponsored`: the house opened it and pays the gas of a game account's moves.
  const unstaked = stake === 0n;
  const sponsored = isFreeTable(meta, sponsor);
  const relayed = sponsored && player?.via === "key";
  const free = meta.seats.find((seat) => seat.backer === null) ?? null;
  const open = meta.seats.filter((seat) => seat.backer === null).length;
  // What a game account must hold to sit: enough for the node to take the join, and enough left to make moves after it.
  const needed = (() => {
    const hold = upfront(joinCalls(meta.id, 0, stake));
    const after = stake + MOVE_HOLD + near(0.005);
    return hold > after ? hold : after;
  })();
  // A wallet shows its own balance and refuses what it cannot pay; a game account is checked here.
  const short = !relayed && player?.via === "key" && state.balance !== undefined && (state.balance === null || state.balance < needed);

  const inviteAgent = async () => {
    setInviting(true);
    setFailed(null);
    try {
      await devSeatAgent(meta.id);
      await onJoined();
    } catch (error) {
      setFailed(problemText(error));
    }
    setInviting(false);
  };
  const take = async (seat: number) => {
    if (!player) return;
    setJoining(true);
    setFailed(null);
    try {
      if (player.via === "helper") await devJoin(meta.id, seat, player.accountId);
      else if (relayed) await takeFreeSeat(player.session, meta.id, seat);
      else await sendStake(player, joinCalls(meta.id, seat, stake));
      armAgent(meta.id, player.accountId);
      await onJoined();
      void state.refreshBalance();
    } catch (error) {
      setFailed(problemText(error));
    }
    setJoining(false);
  };
  const invitation = (() => {
    if (typeof window === "undefined") return "";
    const here = new URL(window.location.href);
    here.search = "";
    return here.toString();
  })();
  // On a phone the system's share sheet sends the link to a chat; elsewhere it is copied.
  const share = async () => {
    if (typeof navigator.share === "function" && window.matchMedia("(pointer: coarse)").matches) {
      try {
        await navigator.share({ title: "Deedlords", text: "Sit at my Deedlords table", url: invitation });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(invitation);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  // A hosted room: the seats fill as people come, and nothing starts until its host says so.
  const host = meta.host ?? null;
  const isHost = host !== null && host === accountId;
  // When the room filled (the contract's clock), and from when somebody other than the host may start it.
  const startsFrom = Number(BigInt(meta.last_activity) / 1_000_000n) + HOST_GRACE_MS;
  const waitingForHost = hostGrace && host !== null && !isHost && open === 0 && meta.seats.some((seat) => seat.backer === accountId);
  const graceLeft = waitingForHost ? Math.max(0, Math.ceil((startsFrom + 2_000 - clock) / 1000)) : 0;
  useEffect(() => {
    if (!waitingForHost) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [waitingForHost]);
  const toFill = `${open} ${open === 1 ? "seat" : "seats"} to fill`;
  const line =
    open === 0
      ? host
        ? isHost
          ? "Everybody is in. Start the game."
          : "Everybody is in. Waiting for the host."
        : "Every seat is taken."
      : seated
        ? `You are in. ${toFill[0].toUpperCase()}${toFill.slice(1)}.`
        : mayJoin
          ? "A seat is open. Sit down."
          : "Boarding now.";
  // A free room whose friends do not come: the house's agent takes a seat when asked, up to three of them.
  const mayAddAgent = sponsored && seated && open > 0 && meta.seats.filter((seat) => seat.backer === sponsor).length < 3;
  const addAgent = async () => {
    setAdding(true);
    setFailed(null);
    try {
      await seatHouseAgent(meta.id);
      await onJoined();
    } catch (error) {
      setFailed(problemText(error));
    }
    setAdding(false);
  };
  // Out of the room before it starts: the seat is free again and a stake comes back. A room nobody starts is closed
  // by the contract's own rule, fifteen minutes after it was opened, with every stake returned.
  const leave = async () => {
    if (!player) return;
    const mine = meta.seats.find((seat) => seat.backer === accountId);
    if (!mine) return;
    setLeaving(true);
    setFailed(null);
    try {
      await seatCaller(player.session).call("leave", { id: meta.id, seat: mine.seat }, { stake: meta.stake, creator: meta.creator });
      void state.refreshBalance();
      window.location.assign("/play");
    } catch (error) {
      setFailed(problemText(error));
      setLeaving(false);
    }
  };
  const start = async () => {
    if (!player) return;
    setStarting(true);
    setFailed(null);
    try {
      const mine = meta.seats.find((seat) => seat.backer === accountId)?.seat ?? 0;
      const { method, args } = startCall(meta.id, mine);
      await seatCaller(player.session).call(method, args, { stake: meta.stake, creator: meta.creator });
      await onJoined();
    } catch (error) {
      setFailed(problemText(error));
    }
    setStarting(false);
  };

  return (
    <Hall page="gate" account={player && { accountId: player.accountId, balance: state.balance }}>
      <div className="fd-hall">
        <section className="fd-wall">
          <h1 className="fd-line">{line}</h1>
          <p className="fd-lede">
            Room <code className="fd-code">{meta.id}</code>, held by {CHAIN.contractId}.{" "}
            {host ? "Its host starts the game once every seat is taken." : "The game starts by itself when the last seat is taken."}
          </p>
          <section className="fd-board" aria-label={`Seats of match ${meta.id}`}>
            <h2 className="fd-board__title">
              <Seat size={24} /> Gate
              <span className="fd-board__state">{open === 0 ? <Flap text={host ? "READY" : "STARTING"} /> : <span className="fd-chip">Boarding · {open} open</span>}</span>
            </h2>
            <ul className="fd-lounge" style={{ "--seats": meta.seats.length } as CSSProperties}>
              {meta.seats.map((seat) => {
                const empty = seat.backer === null;
                const mine = !empty && seat.backer === accountId;
                return (
                  <li
                    key={seat.seat}
                    className="fd-guest"
                    data-free={empty || undefined}
                    data-you={mine || undefined}
                    style={{ "--seat": TOKEN_COLORS[seat.seat] } as CSSProperties}
                  >
                    <span className="fd-guest__figure">
                      {empty ? <i className="fd-guest__ghost" aria-hidden="true" /> : figures[seat.seat] ? <img src={figures[seat.seat]!} alt="" /> : <b>{seat.seat + 1}</b>}
                    </span>
                    <p>
                      <small>Seat {seat.seat + 1}</small>
                      <strong>{empty ? "Open seat" : mine ? `${names[seat.seat]} (you)` : names[seat.seat]}</strong>
                    </p>
                    <Flap text={empty ? "WAITING" : seat.house ? "THE HOUSE" : sponsored && seat.backer === sponsor ? "AI AGENT" : seat.backer === host ? "HOST" : "SEATED"} />
                  </li>
                );
              })}
            </ul>
            <dl className="fd-terms">
              <div>
                <dt>Rounds</dt>
                <dd>{roundsLabel(meta.rules.maxRounds)}</dd>
              </div>
              <div>
                <dt>A turn</dt>
                <dd>{meta.turn_seconds} s</dd>
              </div>
              <div>
                <dt>{meta.rules.blitz ? "To start" : "Cash to start"}</dt>
                <dd>{meta.rules.blitz ? `${BLITZ_DEAL} properties dealt, paid out of ${meta.rules.cash}` : meta.rules.cash}</dd>
              </div>
              <div>
                <dt>Late player</dt>
                <dd>moved by the contract</dd>
              </div>
              <div className="fd-terms__wide">
                <dt>How it is won</dt>
                <dd>{winLine(meta.rules)}</dd>
              </div>
              {meta.rules.leaderRent && (
                <div className="fd-terms__wide">
                  <dt>The leader</dt>
                  <dd>{LEADER_LINE}</dd>
                </div>
              )}
              {meta.rules.tickets && (
                <div className="fd-terms__wide">
                  <dt>Special tickets</dt>
                  <dd>
                    {TICKETS_LINE}
                    <ul className="fd-specials">
                      {TICKET_LINES.map((line) => (
                        <li key={line.ticket}>
                          <b>{line.name}.</b> {line.does}
                        </li>
                      ))}
                    </ul>
                  </dd>
                </div>
              )}
            </dl>
          </section>
          <Link className="fd-back" href="/play">
            <Arrow size={18} /> All departures
          </Link>
        </section>

        <aside className="fd-ticket" aria-label="Your ticket">
          <section className="fd-stub" aria-label="Boarding pass">
            <h2 className="fd-stub__title">Boarding pass</h2>
            {unstaked ? (
              <dl className="fd-sum fd-sum--top">
                <div>
                  <dt>A seat</dt>
                  <dd>Free</dd>
                </div>
                <div>
                  <dt>Gas</dt>
                  <dd>{sponsored ? "On the house" : "Yours"}</dd>
                </div>
              </dl>
            ) : (
              <dl className="fd-sum fd-sum--top">
                <div>
                  <dt>Pot</dt>
                  <dd>
                    {formatNear(pot.toString())} <small>NEAR</small>
                  </dd>
                </div>
                <div>
                  <dt>A seat</dt>
                  <dd>
                    {formatNear(meta.stake)} <small>NEAR</small>
                  </dd>
                </div>
              </dl>
            )}
            {unstaked ? (
              <p className="fd-fine">
                Nothing is staked, so nothing is paid out; the contract still rolls the dice{sponsored ? ", and the house pays the gas: no NEAR needed to sit here." : "."}
              </p>
            ) : (
              <>
                <div className="fd-split" aria-label="How the pot is shared">
                  {meta.split.map((share, rank) => (
                    <span key={rank} style={{ flexGrow: share } as CSSProperties} data-rank={rank}>
                      {rank === 0 ? "1st" : rank === 1 ? "2nd" : rank === 2 ? "3rd" : "4th"} · {formatBps(share)}
                    </span>
                  ))}
                </div>
                {meta.fee_bps > 0 && <p className="fd-fine">The contract keeps {formatBps(meta.fee_bps)} of the pot; the ranks share the rest.</p>}
              </>
            )}
            {free && mayJoin && (
              <button type="button" className="fd-go" disabled={joining || short} onClick={() => take(free.seat)}>
                {joining
                  ? player?.via === "wallet"
                    ? "Waiting for your wallet…"
                    : approvesInWindow(player) && !unstaked
                      ? "Waiting for your approval…"
                      : unstaked
                        ? "Taking the seat…"
                        : "Staking…"
                  : unstaked
                    ? `Take seat ${free.seat + 1} · Free`
                    : `Take seat ${free.seat + 1} · ${formatNear(meta.stake)} NEAR`}
                {!joining && <Arrow size={20} />}
              </button>
            )}
            {free && !player && (
              <button type="button" className="fd-go" onClick={onSignIn}>
                Sign in to take seat {free.seat + 1}
                <Arrow size={20} />
              </button>
            )}
            {short && free && mayJoin && (
              <p className="fd-fine">
                Your game account needs {formatNear(needed.toString(), 2)} NEAR to sit here: the {formatNear(meta.stake)} stake and about{" "}
                {formatNear((needed - stake).toString(), 2)} the network holds for gas while you play. The hold comes back.
                {CHAIN.network === "testnet" && (
                  <>
                    {" "}
                    No NEAR wallet yet?{" "}
                    <a href="https://docs.near.org/getting-started/faucet" target="_blank" rel="noreferrer noopener">
                      Ask a testnet faucet
                    </a>
                    .
                  </>
                )}
              </p>
            )}
            {isHost && open === 0 && (
              <button type="button" className="fd-go" disabled={starting} onClick={start}>
                {starting ? "Starting…" : "Start the game"}
                {!starting && <Arrow size={20} />}
              </button>
            )}
            {host && !isHost && open === 0 && !waitingForHost && <p className="fd-small">Everybody is in. The host starts the game.</p>}
            {waitingForHost && graceLeft > 0 && <p className="fd-small">Everybody is in. The host starts the game; if they do not, you can in {graceLeft} s.</p>}
            {waitingForHost && graceLeft === 0 && (
              <>
                <button type="button" className="fd-go" disabled={starting} onClick={start}>
                  {starting ? "Starting…" : "Start the game"}
                  {!starting && <Arrow size={20} />}
                </button>
                <p className="fd-fine">The host has not started it: anyone seated may now.</p>
              </>
            )}
            {seated && open > 0 && (
              <div className="fd-acts">
                <button type="button" className="fd-go" onClick={share}>
                  <Copy size={18} /> {copied ? "Link copied: send it to a friend" : open === 1 ? "Invite a friend" : "Invite friends"}
                </button>
                <p className="fd-invite" title={invitation}>
                  {invitation}
                </p>
                {mayAddAgent && (
                  <button type="button" className="fd-pill" disabled={adding} onClick={addAgent}>
                    <Bot size={16} /> {adding ? "The AI is taking a seat…" : "Add an AI to a free seat"}
                  </button>
                )}
                {host && <p className="fd-fine">{isHost ? "You start the game once every seat is taken." : "The host starts the game once every seat is taken."}</p>}
                {helper?.agent && meta.solo_player === null && (
                  <button type="button" className="fd-pill" disabled={inviting} onClick={inviteAgent}>
                    <Bot size={16} /> {inviting ? "The AI is taking its seat…" : "Play against the AI"}
                  </button>
                )}
              </div>
            )}
            {seated && open > 0 && helper?.agent && meta.solo_player === null && (
              <p className="fd-fine">A test account of the local helper stakes the open seat and plays it by an AI agent&rsquo;s plans, one transaction a turn.</p>
            )}
            {failed && (
              <p className="fd-problem" role="alert">
                {failed}
              </p>
            )}
            {seated && player?.via !== "helper" && (
              <>
                <button type="button" className="fd-pill" disabled={leaving} onClick={leave}>
                  {leaving ? "Leaving…" : isHost ? "Leave and close the room" : "Leave the room"}
                </button>
                <p className="fd-fine">
                  {unstaked ? "Your seat is free again." : "Your stake comes back and your seat is free again."}{" "}
                  {isHost
                    ? hostGrace
                      ? "The room stays open: once it is full, anyone seated can start it. A room nobody starts is closed by the contract 15 minutes after it was opened."
                      : "Nobody else can start this room: the contract closes it 15 minutes after it was opened and returns every stake."
                    : ""}
                </p>
              </>
            )}
          </section>
          <PassengerStub state={state} helper={helper} freePlay={Boolean(sponsor)} compact onSignIn={onSignIn} />
          <AgentStub desk={desk} signedIn={Boolean(player)} compact />
        </aside>
      </div>
    </Hall>
  );
}

/** Who won and what the contract paid, from `get_result`. `names` is by seat. */
function Payout({
  result,
  names,
  accountId,
  onClose,
  ledger,
}: {
  result: ChainResult;
  names: string[];
  accountId: string | null;
  onClose?: () => void;
  /** The match's transactions, shown in place of the result when asked for. */
  ledger?: (onClose: () => void) => ReactNode;
}) {
  const [listing, setListing] = useState(false);
  const winner = result.backers[0];
  const pot = BigInt(result.pot);
  // The contract reports the amount; the rate is read back from it for the label.
  const feeBps = pot > 0n ? Number((BigInt(result.fee) * 10_000n) / pot) : 0;
  if (listing && ledger) return <>{ledger(() => setListing(false))}</>;
  return (
    <>
      <img className="tp-result__trophy" src={TROPHY_ART} alt="" width={132} height={132} />
      <p className="tp-result__title">{winner === accountId ? "You win!" : `${names[result.ranking[0]] ?? playerName(winner)} wins`}</p>
      <p className="tp-result__line">{result.reason === "time" ? "Out of rounds: ranked by net worth." : "Everybody else went bankrupt or gave up."}</p>
      <ol className="tp-ranking">
        {result.ranking.map((seat, rank) => (
          <li key={seat}>
            <i className="tp-token" style={{ background: TOKEN_COLORS[seat] }} />
            <span>{names[seat] ?? playerName(result.backers[rank])}</span>
            <strong>{pot > 0n ? `${formatNear(result.payouts[rank], 5)} NEAR` : rank === 0 ? "1st" : rank === 1 ? "2nd" : rank === 2 ? "3rd" : "4th"}</strong>
          </li>
        ))}
      </ol>
      <p className="tp-hint">
        {pot > 0n
          ? `Pot ${formatNear(result.pot)} NEAR${result.fee !== "0" ? `, fee ${formatNear(result.fee)} NEAR (${formatBps(feeBps)})` : ""}, paid by the contract at block ${result.block_height}.`
          : `A free table: nothing was staked. Ranked and recorded by the contract at block ${result.block_height}.`}
        {result.forfeited !== "0" && ` The house seat's ${formatNear(result.forfeited)} NEAR stays in the contract.`}
        {result.deed && ` Deed of this match minted to ${accountLabel(result.deed)}.`}
      </p>
      <div className="tp-row tp-row--exit">
        <Link className="tp-btn tp-btn--main tp-btn--big" href="/play">
          Back to the lobby
        </Link>
      </div>
      <div className="tp-row">
        <Link className="tp-btn" href="/">
          Club menu
        </Link>
        {ledger && (
          <button type="button" className="tp-btn" onClick={() => setListing(true)}>
            Transactions
          </button>
        )}
        {onClose && (
          <button type="button" className="tp-btn" onClick={onClose}>
            View the board
          </button>
        )}
      </div>
    </>
  );
}
