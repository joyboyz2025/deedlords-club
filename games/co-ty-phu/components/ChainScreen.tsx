"use client";

import Link from "next/link";
import { useState, type CSSProperties, type ReactNode } from "react";
import { Arrow, Bot, Copy, Seat } from "@/components/landing/icons";
import { CHAIN } from "@/lib/chain/config";
import { TOKEN_COLORS } from "../board";
import { formatBps, formatNear, seatNames, shortAccount } from "../chain/adapt";
import { MOVE_HOLD, joinCalls, near, upfront } from "../chain/calls";
import { devJoin, devSeatAgent, useDevConfig, type DevConfig } from "../chain/devSession";
import type { ChainMatch, ChainResult } from "../chain/types";
import { armAgent, useAgent } from "../chain/useAgent";
import { useAgentNotes, useAutopilot } from "../chain/useAutopilot";
import { useChainRoom } from "../chain/useChainRoom";
import { sendStake, usePlayer, type PlayerState } from "../chain/usePlayer";
import { AgentStub, Flap, Hall, PassengerStub } from "./Desk";
import { Ledger } from "./Ledger";
import { useSeatPortraits } from "./LobbyArt";
import { TROPHY_ART } from "../scene/art";
import { Stage, type AgentTag } from "./TycoonScreen";

const problemText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * A match that lives in the Deedlords contract, on the same table as a room-server game. Whoever holds a seat plays
 * it: with a game account kept in this browser, a NEAR wallet, or a test account of a local helper. Anybody else watches.
 */
export function ChainScreen({ id }: { id: string }) {
  const state = usePlayer();
  const helper = useDevConfig();

  if (state.player === undefined) {
    return (
      <main className="tp tp--center">
        <p className="tp-lede" aria-live="polite">
          Signing in…
        </p>
      </main>
    );
  }
  return <Table id={id} state={state} helper={helper} />;
}

function Table({ id, state, helper }: { id: string; state: PlayerState; helper: DevConfig | null }) {
  const player = state.player ?? null;
  const room = useChainRoom(id, player?.session ?? null);
  const { view, match, result, seat, link, error, busy, notice, sent, send, playTurn, retry, refresh } = room;
  const accountId = player?.accountId ?? null;
  const autopilot = useAutopilot(id, room, playTurn, accountId);
  const notes = useAgentNotes(id, match?.meta.status === "playing");

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
            All matches
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
            names={result.seats.map(shortAccount)}
            accountId={accountId}
            ledger={(onClose) => (
              <Ledger
                id={id}
                sent={sent}
                nameOf={(account) => (result.seats.includes(account) ? `${shortAccount(account)}${account === accountId ? " (you)" : ""}` : null)}
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

  if (match.meta.status === "lobby") return <Lobby match={match} state={state} helper={helper} onJoined={refresh} />;

  const names = seatNames(match.meta);
  // A seat an agent played this round or the one before: its tag stays on the card. Older notes are history.
  const agents: Record<string, AgentTag> = {};
  for (const note of notes) {
    const playerId = match.meta.seats[note.seat]?.player;
    if (playerId && note.round >= match.game.round - 1) agents[playerId] = { driver: note.driver, reason: note.reason, fallback: note.fallback };
  }
  const own = seat === null ? null : match.meta.seats[seat].player;
  if (own && autopilot?.on && autopilot.last) agents[own] = { driver: autopilot.last.driver, reason: autopilot.last.reason, fallback: autopilot.last.fallback };
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
          label: `${CHAIN.network} · ${accountId === null ? "watching" : seat === null ? `${shortAccount(accountId)} (no seat here)` : `${shortAccount(accountId)}, seat ${seat + 1}`}`,
          busy,
          agents,
          autopilot: autopilot && {
            on: autopilot.on,
            thinking: autopilot.thinking,
            toggle: autopilot.toggle,
            note: autopilot.last ? `AI · ${autopilot.last.driver}: ${autopilot.last.reason}` : null,
          },
          ledger,
          result: (onClose) =>
            result ? (
              <div className="tp-result" role="dialog" aria-label="Result of the match">
                <Payout result={result} names={names} accountId={accountId} onClose={onClose} ledger={ledger} />
              </div>
            ) : (
              <div className="tp-result" role="status">
                <p className="tp-result__title">Game over</p>
                <p>The contract is paying out…</p>
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

/**
 * The gate of a match: who sits where on the wall, and on the desk the visitor's ticket, whose last stub is the boarding
 * pass of this match. The last seat taken starts the game.
 */
function Lobby({ match, state, helper, onJoined }: { match: ChainMatch; state: PlayerState; helper: DevConfig | null; onJoined: () => Promise<void> }) {
  const { meta } = match;
  const player = state.player ?? null;
  const accountId = player?.accountId ?? null;
  const desk = useAgent(accountId);
  const names = seatNames(meta);
  const faces = useSeatPortraits(meta.seats.length);
  const [joining, setJoining] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [inviting, setInviting] = useState(false);
  const seated = accountId !== null && meta.seats.some((seat) => seat.backer === accountId);
  // In a match against the house the last free seat is the solo player's.
  const mayJoin = player !== null && !seated && (meta.solo_player === null || meta.solo_player === accountId);
  const stake = BigInt(meta.stake);
  const pot = stake * BigInt(meta.seats.length);
  const free = meta.seats.find((seat) => seat.backer === null) ?? null;
  const open = meta.seats.filter((seat) => seat.backer === null).length;
  // What a game account must hold to sit: enough for the node to take the join, and enough left to make moves after it.
  const needed = (() => {
    const hold = upfront(joinCalls(meta.id, 0, stake));
    const after = stake + MOVE_HOLD + near(0.005);
    return hold > after ? hold : after;
  })();
  // A wallet shows its own balance and refuses what it cannot pay; a game account is checked here.
  const short = player?.via === "key" && state.balance !== undefined && (state.balance === null || state.balance < needed);

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
      else await sendStake(player, joinCalls(meta.id, seat, stake));
      armAgent(meta.id, player.accountId);
      await onJoined();
      void state.refreshBalance();
    } catch (error) {
      setFailed(problemText(error));
    }
    setJoining(false);
  };
  const share = async () => {
    const here = new URL(window.location.href);
    here.search = "";
    try {
      await navigator.clipboard.writeText(here.toString());
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const line = open === 0 ? "Every seat is taken." : seated ? "You are in. One seat to fill." : mayJoin ? "A seat is open. Sit down." : "Boarding now.";

  return (
    <Hall gate>
      <div className="fd-hall">
        <section className="fd-wall">
          <h1 className="fd-line">{line}</h1>
          <p className="fd-lede">
            Match <code className="fd-code">{meta.id}</code>, held by {CHAIN.contractId}. The game starts by itself when the last seat is taken.
          </p>
          <section className="fd-board" aria-label={`Seats of match ${meta.id}`}>
            <h2 className="fd-board__title">
              <Seat size={24} /> Gate
              <span className="fd-board__state">{open === 0 ? <Flap text="STARTING" /> : <span className="fd-chip">Boarding · {open} open</span>}</span>
            </h2>
            <ul className="fd-seats">
              {meta.seats.map((seat) => {
                const empty = seat.backer === null;
                return (
                  <li key={seat.seat} className="fd-seat" data-free={empty || undefined} style={{ "--seat": TOKEN_COLORS[seat.seat] } as CSSProperties}>
                    <span className="fd-seat__face">{faces[seat.seat] ? <img src={faces[seat.seat]!} alt="" /> : <b>{seat.seat + 1}</b>}</span>
                    <p>
                      <small>Seat {seat.seat + 1}</small>
                      <strong>{empty ? "Open" : seat.backer === accountId ? `${names[seat.seat]} (you)` : names[seat.seat]}</strong>
                    </p>
                    <Flap text={empty ? "WAITING" : seat.house ? "THE HOUSE" : "SEATED"} />
                  </li>
                );
              })}
            </ul>
            <dl className="fd-terms">
              <div>
                <dt>Rounds</dt>
                <dd>{meta.rules.maxRounds}</dd>
              </div>
              <div>
                <dt>A turn</dt>
                <dd>{meta.turn_seconds} s</dd>
              </div>
              <div>
                <dt>{meta.rules.blitz ? "Blitz start" : "Cash to start"}</dt>
                <dd>{meta.rules.cash}</dd>
              </div>
              <div>
                <dt>Late player</dt>
                <dd>moved by the contract</dd>
              </div>
            </dl>
          </section>
          <Link className="fd-back" href="/play">
            <Arrow size={18} /> All departures
          </Link>
        </section>

        <aside className="fd-ticket" aria-label="Your ticket">
          <section className="fd-stub" aria-label="Boarding pass">
            <h2 className="fd-stub__title">Boarding pass</h2>
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
            <div className="fd-split" aria-label="How the pot is shared">
              {meta.split.map((share, rank) => (
                <span key={rank} style={{ flexGrow: share } as CSSProperties} data-rank={rank}>
                  {rank === 0 ? "1st" : rank === 1 ? "2nd" : rank === 2 ? "3rd" : "4th"} · {formatBps(share)}
                </span>
              ))}
            </div>
            {meta.fee_bps > 0 && <p className="fd-fine">The contract keeps {formatBps(meta.fee_bps)} of the pot; the ranks share the rest.</p>}
            {free && mayJoin && (
              <button type="button" className="fd-go" disabled={joining || short} onClick={() => take(free.seat)}>
                {joining ? (player?.via === "wallet" ? "Waiting for your wallet…" : "Staking…") : `Take seat ${free.seat + 1} · ${formatNear(meta.stake)} NEAR`}
                {!joining && <Arrow size={20} />}
              </button>
            )}
            {free && !player && <p className="fd-small">Check in below to take the open seat.</p>}
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
            {seated && open > 0 && (
              <div className="fd-acts">
                <button type="button" className="fd-go" onClick={share}>
                  <Copy size={18} /> {copied ? "Link copied" : "Copy the invitation link"}
                </button>
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
          </section>
          <PassengerStub state={state} helper={helper} />
          <AgentStub desk={desk} signedIn={Boolean(player)} />
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
      <p className="tp-result__title">{winner === accountId ? "You win!" : `${names[result.ranking[0]] ?? shortAccount(winner)} wins`}</p>
      <p className="tp-result__line">{result.reason === "time" ? "Out of rounds: ranked by net worth." : "Everybody else went bankrupt."}</p>
      <ol className="tp-ranking">
        {result.ranking.map((seat, rank) => (
          <li key={seat}>
            <i className="tp-token" style={{ background: TOKEN_COLORS[seat] }} />
            <span>{names[seat] ?? shortAccount(result.backers[rank])}</span>
            <strong>{formatNear(result.payouts[rank], 5)} NEAR</strong>
          </li>
        ))}
      </ol>
      <p className="tp-hint">
        Pot {formatNear(result.pot)} NEAR{result.fee !== "0" && `, fee ${formatNear(result.fee)} NEAR (${formatBps(feeBps)})`}, paid by the contract at block {result.block_height}.
        {result.forfeited !== "0" && ` The house seat's ${formatNear(result.forfeited)} NEAR stays in the contract.`}
        {result.deed && ` Deed of this match minted to ${shortAccount(result.deed)}.`}
      </p>
      <div className="tp-row">
        <Link className="tp-btn tp-btn--main" href="/play">
          All matches
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
