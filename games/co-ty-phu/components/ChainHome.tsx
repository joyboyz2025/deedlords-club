"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CHAIN } from "@/lib/chain/config";
import { chainClient } from "@/lib/chain/shared";
import { readStored, writeStored } from "@/lib/storage";
import { formatNear, seatNames } from "../chain/adapt";
import { AS_KEY, devCreateMatch, type NewMatch } from "../chain/devSession";
import type { ChainListed } from "../chain/types";
import { PlayAs } from "./ChainScreen";

const REFRESH_MS = 3_000;

/** The open matches of the contract. On the local sandbox, also where a dev account opens one. */
export function ChainHome() {
  const router = useRouter();
  const [matches, setMatches] = useState<ChainListed[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (CHAIN.devUrl) setAccountId(readStored<string>(AS_KEY));
  }, []);

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
    const timer = setInterval(() => document.visibilityState !== "hidden" && void load(), REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  const playAs = (next: string | null) => {
    setAccountId(next);
    writeStored(AS_KEY, next);
  };
  const linkTo = (id: string) => `/play/${encodeURIComponent(id)}${accountId ? `?as=${encodeURIComponent(accountId)}` : ""}`;

  const create = async (match: NewMatch) => {
    if (accountId === null) return;
    setCreating(true);
    setProblem(null);
    try {
      const { id } = await devCreateMatch({ ...match, player: accountId });
      router.push(linkTo(id));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      setCreating(false);
    }
  };

  return (
    <main className="tp tp--center">
      <div className="tp-join tp-chain-home">
        <h1 className="tp-logo">Deedlords</h1>
        <p className="tp-lede">
          Matches held by <strong>{CHAIN.contractId}</strong> on NEAR {CHAIN.network}.
        </p>
        {offline && <p className="tp-problem">Cannot reach {CHAIN.network} right now, trying again…</p>}
        {matches === null ? (
          !offline && <p className="tp-hint">Reading the contract…</p>
        ) : matches.length === 0 ? (
          <p className="tp-hint">No open match.</p>
        ) : (
          <ul className="tp-seats tp-chain-matches">
            {matches.map((match) => (
              <li key={match.id}>
                <Link className="tp-seat" href={linkTo(match.id)}>
                  <span>
                    <strong>{seatNames(match).map((name, seat) => (match.seats[seat].backer === null ? "open seat" : name)).join(" vs ")}</strong>
                    <small>
                      {match.id} · {formatNear(match.stake)} NEAR a seat
                    </small>
                  </span>
                  <em>{match.status === "lobby" ? "waiting" : `round ${Math.min(match.round + 1, match.rules.maxRounds)} of ${match.rules.maxRounds}`}</em>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {CHAIN.devUrl && (
          <section className="tp-section tp-chain-dev">
            <h2 className="tp-heading">Local sandbox</h2>
            <PlayAs accountId={accountId} onChange={playAs} />
            <div className="tp-row">
              <button type="button" className="tp-btn tp-btn--main" disabled={accountId === null || creating} onClick={() => create({ kind: "solo" })}>
                Play the house
              </button>
              <button type="button" className="tp-btn" disabled={accountId === null || creating} onClick={() => create({ kind: "duel", open: true })}>
                Open a duel
              </button>
            </div>
            <p className="tp-hint">A dev account stakes 1 test NEAR a seat. Nothing here leaves this machine.</p>
            {problem && <p className="tp-problem">{problem}</p>}
          </section>
        )}
      </div>
    </main>
  );
}
