"use client";

import { useEffect, useRef, useState } from "react";
import { freeSponsor, isFreeTable, nudgeHouseAgent } from "./free";
import type { RoomState } from "./room";

/** The account that sponsors free play here. `undefined`: not known yet. `null`: nobody does. */
export function useFreeSponsor(): string | null | undefined {
  const [sponsor, setSponsor] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let stale = false;
    void freeSponsor().then((account) => !stale && setSponsor(account));
    return () => {
      stale = true;
    };
  }, []);
  return sponsor;
}

/** A turn of the house agent that has not shown on chain is asked for again after this long. */
const NUDGE_EVERY_MS = 4_000;

/**
 * At a free table whose turn is the house agent's: asks the server to play it. The server keeps no process running,
 * so the agent moves because somebody with the match open asked; it plays a turn once however many ask.
 */
export function useHouseAgent(id: string, state: RoomState, sponsor: string | null | undefined): void {
  const [tick, setTick] = useState(0);
  const asked = useRef<{ key: string; at: number } | null>(null);
  const { match, result } = state;
  const seat = match?.meta.current_seat ?? null;
  const due = !result && !!match && match.meta.status === "playing" && seat !== null && isFreeTable(match.meta, sponsor) && match.meta.seats[seat]?.backer === sponsor;
  const key = match ? `${match.game.rolls}:${match.game.round}:${match.game.stage}` : "";

  useEffect(() => {
    if (!due) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1_000);
    return () => clearInterval(timer);
  }, [due]);

  useEffect(() => {
    if (!due || document.visibilityState === "hidden") return;
    const now = Date.now();
    if (asked.current?.key === key && now - asked.current.at < NUDGE_EVERY_MS) return;
    asked.current = { key, at: now };
    void nudgeHouseAgent(id).catch(() => undefined);
  }, [due, key, tick, id]);
}
