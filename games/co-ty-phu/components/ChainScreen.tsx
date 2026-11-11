"use client";

import Link from "next/link";
import { useState, type CSSProperties, type ReactNode } from "react";
import { CHAIN } from "@/lib/chain/config";
import { TOKEN_COLORS } from "../board";
import { formatBps, formatNear, seatNames, shortAccount } from "../chain/adapt";
import { MOVE_HOLD, joinCalls, near, upfront } from "../chain/calls";
import { devJoin, devSeatAgent, useDevConfig, type DevConfig } from "../chain/devSession";
import type { ChainMatch, ChainResult } from "../chain/types";
import { useAgentNotes, useAutopilot } from "../chain/useAutopilot";
import { useChainRoom } from "../chain/useChainRoom";
import { sendStake, usePlayer, type PlayerState } from "../chain/usePlayer";
import { Ledger } from "./Ledger";
import { Icon, useSeatPortraits } from "./LobbyArt";
import { Passport } from "./Passport";
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
  const autopilot = useAutopilot(id, room, playTurn);
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
          autopilot: autopilot && { on: autopilot.on, thinking: autopilot.thinking, toggle: autopilot.toggle, note: autopilot.last ? `AI · ${autopilot.last.driver}: ${autopilot.last.reason}` : null },
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

/** The gate of a match: its terms as a boarding pass, the seats, and who is about to sit. The last seat starts the game. */
function Lobby({ match, state, helper, onJoined }: { match: ChainMatch; state: PlayerState; helper: DevConfig | null; onJoined: () => Promise<void> }) {
  const { meta } = match;
  const player = state.player ?? null;
  const accountId = player?.accountId ?? null;
  const names = seatNames(meta);
  const faces = useSeatPortraits(meta.seats.length);
  const [joining, setJoining] = useState<number | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [inviting, setInviting] = useState(false);
  const seated = accountId !== null && meta.seats.some((seat) => seat.backer === accountId);
  // In a match against the house the last free seat is the solo player's.
  const mayJoin = player !== null && !seated && (meta.solo_player === null || meta.solo_player === accountId);
  const stake = BigInt(meta.stake);
  const pot = stake * BigInt(meta.seats.length);
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
    setJoining(seat);
    setFailed(null);
    try {
      if (player.via === "helper") await devJoin(meta.id, seat, player.accountId);
      else await sendStake(player, joinCalls(meta.id, seat, stake));
      await onJoined();
      void state.refreshBalance();
    } catch (error) {
      setFailed(problemText(error));
    }
    setJoining(null);
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

  return (
    <main className="tp dl">
      <nav className="dl-back">
        <Link href="/play">← All matches</Link>
      </nav>
      <section className="dl-ticket" aria-label={`Match ${meta.id}`}>
        <div className="dl-ticket__main">
          <p className="dl-ticket__kicker">
            <Icon name="plane" size={16} /> Boarding · {open === 0 ? "starting" : `${open} seat${open > 1 ? "s" : ""} open`}
          </p>
          <h1 className="dl-ticket__code">{meta.id}</h1>
          <div className="dl-pot">
            <span>Pot</span>
            <strong>{formatNear(pot.toString())}</strong>
            <span>NEAR</span>
          </div>
          <div className="dl-split" aria-label="How the pot is shared">
            {meta.split.map((share, rank) => (
              <span key={rank} style={{ flexGrow: share } as CSSProperties} data-rank={rank}>
                {rank === 0 ? "1st" : rank === 1 ? "2nd" : rank === 2 ? "3rd" : "4th"} · {formatBps(share)}
              </span>
            ))}
          </div>
          {meta.fee_bps > 0 && <p className="dl-muted">The contract keeps {formatBps(meta.fee_bps)} of the pot; the ranks share the rest.</p>}
        </div>
        <ul className="dl-ticket__stub">
          <li>
            <Icon name="coins" size={18} />
            <span>
              <strong>{formatNear(meta.stake)} NEAR</strong>
              <small>a seat</small>
            </span>
          </li>
          <li>
            <Icon name="laps" size={18} />
            <span>
              <strong>{meta.rules.maxRounds}</strong>
              <small>{meta.rules.maxRounds === 1 ? "round" : "rounds"}</small>
            </span>
          </li>
          <li>
            <Icon name="clock" size={18} />
            <span>
              <strong>{meta.turn_seconds} s</strong>
              <small>a turn</small>
            </span>
          </li>
          <li>
            <Icon name="seat" size={18} />
            <span>
              <strong>{meta.rules.cash}</strong>
              <small>{meta.rules.blitz ? "Blitz start" : "to start"}</small>
            </span>
          </li>
        </ul>
      </section>

      <section className="dl-seats" aria-label="Seats">
        {meta.seats.map((seat) => {
          const free = seat.backer === null;
          return (
            <article key={seat.seat} className="dl-seat" data-free={free || undefined} style={{ "--seat": TOKEN_COLORS[seat.seat] } as CSSProperties}>
              <span className="dl-seat__face">{faces[seat.seat] ? <img src={faces[seat.seat]!} alt="" /> : <b>{seat.seat + 1}</b>}</span>
              <small>Seat {seat.seat + 1}</small>
              <strong>{free ? "Open" : names[seat.seat]}</strong>
              {free && mayJoin ? (
                <button type="button" className="tp-btn tp-btn--main tp-btn--small" disabled={joining !== null || short} onClick={() => take(seat.seat)}>
                  {joining !== seat.seat ? `Sit · ${formatNear(meta.stake)} NEAR` : player?.via === "wallet" ? "In your wallet…" : "Staking…"}
                </button>
              ) : (
                <span className="dl-seat__state">{free ? "waiting" : seat.backer === accountId ? "you" : seat.house ? "the house" : "seated"}</span>
              )}
            </article>
          );
        })}
      </section>

      <p className="dl-muted dl-center">
        {open === 0
          ? "Every seat is taken: the game is starting."
          : seated
            ? "You are in. The game starts by itself when the last seat is taken."
            : short
              ? `Your game account needs ${formatNear(needed.toString(), 2)} NEAR to sit here: the stake, and about 0.1 the network holds for gas while you play (it comes back).`
              : "The game starts by itself when the last seat is taken."}
      </p>
      {seated && open > 0 && (
        <button type="button" className="tp-btn dl-center" onClick={share}>
          <Icon name="copy" size={16} /> {copied ? "Link copied" : "Copy the invitation link"}
        </button>
      )}
      {open > 0 && helper?.agent && meta.solo_player === null && (
        <>
          <button type="button" className="tp-btn tp-btn--main dl-center" disabled={inviting} onClick={inviteAgent}>
            {inviting ? "The AI is taking its seat…" : "Play against the AI"}
          </button>
          <p className="dl-muted dl-center">A test account of the local helper stakes the open seat and plays it by an AI agent's plans, one transaction a turn.</p>
        </>
      )}
      {failed && (
        <p className="dl-problem dl-center" role="alert">
          {failed}
        </p>
      )}

      <Passport state={state} helper={helper} />
    </main>
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
