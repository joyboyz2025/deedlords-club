"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import type { Session } from "@/lib/chain/client";
import { CHAIN } from "@/lib/chain/config";
import { readStored, writeStored } from "@/lib/storage";
import { TOKEN_COLORS } from "../board";
import { formatBps, formatNear, seatNames, shortAccount } from "../chain/adapt";
import { AS_KEY, devConfig, devJoin, openDevSession } from "../chain/devSession";
import type { ChainMatch, ChainResult } from "../chain/types";
import { useChainRoom } from "../chain/useChainRoom";
import { Stage } from "./TycoonScreen";

const problemText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * A match that lives in the Deedlords contract, on the same table as a room-server game. On the local sandbox the
 * browser plays as a dev account (`?as=alice.sandbox`, or the one used last); on a real network it watches.
 */
export function ChainScreen({ id }: { id: string }) {
  // `undefined`: not known yet. `null`: nobody, just watching.
  const [accountId, setAccountId] = useState<string | null | undefined>(undefined);
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    // `?as=` with nothing after it: watch, whoever played here last.
    const asked = new URLSearchParams(window.location.search).get("as");
    setAccountId(CHAIN.devUrl ? (asked === null ? readStored<string>(AS_KEY) : asked || null) : null);
  }, []);

  useEffect(() => {
    if (accountId === undefined) return;
    setProblem(null);
    if (accountId === null) return setSession(null);
    let stale = false;
    setSession(undefined);
    openDevSession(accountId).then(
      (opened) => {
        if (stale) return;
        writeStored(AS_KEY, accountId);
        setSession(opened);
      },
      (error) => {
        if (stale) return;
        setProblem(`Could not sign in as ${accountId}: ${problemText(error)}`);
        setSession(null);
      },
    );
    return () => {
      stale = true;
    };
  }, [accountId]);

  if (accountId === undefined || session === undefined) {
    return (
      <main className="tp tp--center">
        <p className="tp-lede" aria-live="polite">
          Signing in…
        </p>
      </main>
    );
  }
  return <Table id={id} session={session} problem={problem} onPlayAs={setAccountId} />;
}

function Table({ id, session, problem, onPlayAs }: { id: string; session: Session | null; problem: string | null; onPlayAs: (accountId: string | null) => void }) {
  const { view, match, result, seat, link, error, busy, notice, send, retry, refresh } = useChainRoom(id, session);
  const accountId = session?.accountId ?? null;

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
          <Payout result={result} names={result.seats.map(shortAccount)} accountId={accountId} />
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

  if (match.meta.status === "lobby") return <Lobby match={match} accountId={accountId} problem={problem} onPlayAs={onPlayAs} onJoined={refresh} />;

  const names = seatNames(match.meta);
  return (
    <>
      <Stage
        view={view}
        offline={link === "offline"}
        send={send}
        chain={{
          busy,
          result: (onClose) =>
            result ? (
              <div className="tp-result" role="dialog" aria-label="Result of the match">
                <Payout result={result} names={names} accountId={accountId} onClose={onClose} />
              </div>
            ) : (
              <div className="tp-result" role="status">
                <p className="tp-result__title">Game over</p>
                <p>The contract is paying out…</p>
              </div>
            ),
        }}
      />
      <p className="tp-chain-badge">
        {CHAIN.network} · {accountId === null ? "watching" : seat === null ? `${shortAccount(accountId)} (no seat here)` : `${shortAccount(accountId)}, seat ${seat + 1}`}
      </p>
      {(notice ?? problem) && (
        <p className="tp-chain-note" role="alert">
          {notice ?? problem}
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

/** Seats still to fill. The contract starts the game by itself when the last one is taken. */
function Lobby({
  match,
  accountId,
  problem,
  onPlayAs,
  onJoined,
}: {
  match: ChainMatch;
  accountId: string | null;
  problem: string | null;
  onPlayAs: (accountId: string | null) => void;
  onJoined: () => Promise<void>;
}) {
  const { meta } = match;
  const names = seatNames(meta);
  const [joining, setJoining] = useState<number | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const seated = accountId !== null && meta.seats.some((seat) => seat.backer === accountId);
  // In a match against the house the last free seat is the solo player's.
  const mayJoin = accountId !== null && !seated && (meta.solo_player === null || meta.solo_player === accountId);
  const pot = (BigInt(meta.stake) * BigInt(meta.seats.length)).toString();

  const take = async (seat: number) => {
    if (accountId === null) return;
    setJoining(seat);
    setFailed(null);
    try {
      await devJoin(meta.id, seat, accountId);
      await onJoined();
    } catch (error) {
      setFailed(problemText(error));
    }
    setJoining(null);
  };

  return (
    <main className="tp tp--center">
      <div className="tp-join">
        <h1 className="tp-join__title">Match {meta.id}</h1>
        <p className="tp-lede">
          Stake {formatNear(meta.stake)} NEAR a seat. Pot {formatNear(pot)} NEAR{meta.fee_bps > 0 ? `, less the contract's ${formatBps(meta.fee_bps)} fee` : ""}, split{" "}
          {meta.split.map(formatBps).join(" / ")} by rank.
        </p>
        <p className="tp-hint">
          {meta.rules.blitz ? "Blitz. " : ""}Start with {meta.rules.cash}, {meta.rules.salary} each lap, {meta.rules.maxRounds} {meta.rules.maxRounds === 1 ? "round" : "rounds"}, {meta.turn_seconds} s a turn.
        </p>
        <ul className="tp-seats tp-chain-seats">
          {meta.seats.map((seat) => (
            <li key={seat.seat} className="tp-seat">
              <i className="tp-token tp-token--big" style={{ background: TOKEN_COLORS[seat.seat] }} />
              <span>{seat.backer === null ? "Open seat" : names[seat.seat]}</span>
              {seat.backer === null && mayJoin && CHAIN.devUrl && (
                <button type="button" className="tp-btn tp-btn--small tp-btn--main" disabled={joining !== null} onClick={() => take(seat.seat)}>
                  {joining === seat.seat ? "Staking…" : `Take it for ${formatNear(meta.stake)} NEAR`}
                </button>
              )}
            </li>
          ))}
        </ul>
        <p className="tp-hint">The game starts on its own when the last seat is taken.</p>
        {CHAIN.devUrl ? <PlayAs accountId={accountId} onChange={onPlayAs} /> : <p className="tp-hint">Taking a seat needs a NEAR wallet: not built into this page yet.</p>}
        {(failed ?? problem) && <p className="tp-problem">{failed ?? problem}</p>}
        <Link className="tp-btn tp-btn--quiet" href="/play">
          All matches
        </Link>
      </div>
    </main>
  );
}

/** Sandbox only: which dev account this browser plays as. */
export function PlayAs({ accountId, onChange }: { accountId: string | null; onChange: (accountId: string | null) => void }) {
  const [players, setPlayers] = useState<string[]>([]);
  useEffect(() => {
    devConfig().then(
      (config) => setPlayers(config.players),
      () => setPlayers([]),
    );
  }, []);
  const choices = accountId !== null && !players.includes(accountId) ? [accountId, ...players] : players;
  return (
    <label className="tp-chain-as">
      Play as
      <select className="tp-input tp-input--small" value={accountId ?? ""} onChange={(event) => onChange(event.target.value || null)}>
        <option value="">nobody (watch)</option>
        {choices.map((player) => (
          <option key={player} value={player}>
            {player}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Who won and what the contract paid, from `get_result`. `names` is by seat. */
function Payout({ result, names, accountId, onClose }: { result: ChainResult; names: string[]; accountId: string | null; onClose?: () => void }) {
  const winner = result.backers[0];
  const pot = BigInt(result.pot);
  // The contract reports the amount; the rate is read back from it for the label.
  const feeBps = pot > 0n ? Number((BigInt(result.fee) * 10_000n) / pot) : 0;
  return (
    <>
      <p className="tp-result__title">{winner === accountId ? "You win!" : `${names[result.ranking[0]] ?? shortAccount(winner)} wins`}</p>
      <p className="tp-result__line">{result.reason === "time" ? "Out of rounds: ranked by net worth." : "Everybody else went bankrupt."}</p>
      <ol className="tp-ranking">
        {result.ranking.map((seat, rank) => (
          <li key={seat}>
            <i className="tp-token" style={{ background: TOKEN_COLORS[seat] }} />
            <span>{names[seat] ?? shortAccount(result.backers[rank])}</span>
            <strong>{formatNear(result.payouts[rank])} NEAR</strong>
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
        {onClose && (
          <button type="button" className="tp-btn" onClick={onClose}>
            View the board
          </button>
        )}
      </div>
    </>
  );
}
