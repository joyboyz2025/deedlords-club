"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatNear, seatNames } from "@/games/co-ty-phu/chain/adapt";
import type { ChainListed } from "@/games/co-ty-phu/chain/types";
import { CHAIN } from "@/lib/chain/config";
import { chainClient } from "@/lib/chain/shared";
import { Arrow, Die } from "./icons";

const EVERY_MS = 5_000;
/** A match in play is listed while somebody has moved in it this lately; one its players walked away from is not a departure. */
const LIVE_NS = 15n * 60n * 1_000_000_000n;

/** The matches the contract holds right now, read from the chain by the visitor's own browser. */
export function Departures() {
  const [matches, setMatches] = useState<ChainListed[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let stopped = false;
    const load = () =>
      chainClient.view<ChainListed[]>("list_matches", { from_index: 0, limit: 30 }).then(
        (listed) => {
          if (stopped) return;
          const now = BigInt(Date.now()) * 1_000_000n;
          setMatches(listed.filter((match) => match.status === "lobby" || (match.status === "playing" && now - BigInt(match.last_activity) < LIVE_NS)));
          setFailed(false);
        },
        () => !stopped && setFailed(true),
      );
    void load();
    const timer = setInterval(() => document.visibilityState !== "hidden" && void load(), EVERY_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="lp-board-table" role="table" aria-label={`Matches boarding or in play on ${CHAIN.contractId}`}>
      <div className="lp-row lp-row--head" role="row">
        <span role="columnheader">Match</span>
        <span role="columnheader">Seats</span>
        <span role="columnheader">Stake</span>
        <span role="columnheader">Status</span>
      </div>
      {matches === null ? (
        <p className="lp-row lp-row--note" role="row">
          {failed ? `Cannot reach NEAR ${CHAIN.network} right now. The list is read live from the contract; trying again.` : `Reading ${CHAIN.contractId}…`}
        </p>
      ) : matches.length === 0 ? (
        <Link className="lp-row lp-row--note" role="row" href="/play">
          No match is boarding right now. Open one: it takes a single confirmation. <Arrow size={20} />
        </Link>
      ) : (
        matches.slice(0, 6).map((match) => {
          const taken = match.seats.filter((seat) => seat.backer !== null).length;
          const names = seatNames(match);
          const boarding = match.status === "lobby";
          return (
            <Link key={match.id} className="lp-row" role="row" href={`/play/${encodeURIComponent(match.id)}`}>
              <span role="cell" className="lp-row__game">
                <Die /> <span>{match.id}</span>
              </span>
              <span role="cell" title={match.seats.map((seat) => (seat.backer === null ? "open seat" : names[seat.seat])).join(", ")}>
                {taken} / {match.seats.length}
              </span>
              <span role="cell">
                <b>{formatNear(match.stake)}</b> NEAR
              </span>
              <span role="cell">
                <i className="lp-status" data-live={!boarding || undefined}>
                  {boarding ? "Boarding" : `In play · ${Math.min(match.round + 1, match.rules.maxRounds)}/${match.rules.maxRounds}`}
                </i>
              </span>
              <Arrow size={20} />
            </Link>
          );
        })
      )}
    </div>
  );
}
