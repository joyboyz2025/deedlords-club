"use client";

// The house's seat at a table, from the page's side: the server plays it (games/poker/house.ts) but only when asked,
// so the tab that has the table open asks whenever the table is waiting for the house.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Played } from "./house";
import type { MatchView } from "./seat";

/** While the table waits for the house, it is asked again after this long. */
const RETRY_MS = 4_000;

/**
 * Asks the house for one step at table `id`: to take the open seat, or to play what the table waits for from it.
 * `deal`: the player wants the next hand, which the house is to deal.
 */
export async function askHouse(id: string, deal = false): Promise<Played> {
  for (let tries = 0; ; tries++) {
    const response = await fetch("/api/poker/house", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, deal }) });
    const answer = (await response.json()) as Played & { error?: string };
    if (!response.ok) throw new Error(answer.error ?? `the house answered ${response.status}`);
    // A table opened a moment ago may not have reached the node the server read from: ask again for a few seconds.
    if (answer.played || !answer.again || tries >= 5) return answer;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
}

export type HouseSeat = {
  /** The account that plays the house here; `null`: this server has none; `undefined`: not known yet. */
  account: string | null | undefined;
  /** The seat the house holds at this table, or `null`. */
  seat: number | null;
  /** The house is doing its part right now. */
  thinking: boolean;
  /** Its last bet here and what it said about it. */
  last: { what: string; driver?: string } | null;
  /**
   * The house is to deal the next hand and waits for the player to say so (`deal`). It waits half of the time the
   * step has (`view.deadline`), then leaves the table, which pays both seats what they hold.
   */
  holding: boolean;
  /** Tells the house to deal the hand it is holding. */
  deal: () => void;
};

export function useHouse(id: string | null, view: MatchView | null | undefined): HouseSeat {
  const [account, setAccount] = useState<string | null | undefined>(undefined);
  const [thinking, setThinking] = useState(false);
  const [last, setLast] = useState<HouseSeat["last"]>(null);
  const [tick, setTick] = useState(0);
  const tried = useRef<{ key: string; at: number } | null>(null);

  useEffect(() => {
    let stopped = false;
    fetch("/api/poker/house")
      .then((response) => (response.ok ? (response.json() as Promise<{ house: string | null }>) : { house: null }))
      .then((answer) => !stopped && setAccount(answer.house))
      .catch(() => !stopped && setAccount(null));
    return () => {
      stopped = true;
    };
  }, []);

  const seat = view && account ? (view.players.indexOf(account) >= 0 ? view.players.indexOf(account) : null) : null;
  const [dealt, setDealt] = useState(-1);
  const holding = Boolean(view && seat !== null && view.phase === "shuffle" && view.shuffled === 0 && view.hand > 0 && view.awaited.includes(seat) && dealt !== view.hand);
  // The house is asked when the table waits for it, and when the other seat is out of time (it then ends the table).
  const waited = Boolean(view && seat !== null && view.phase !== "lobby" && !holding && (view.awaited.includes(seat) || Date.now() * 1_000_000 > Number(view.deadline)));
  const key = view ? `${view.seq}` : "";
  const hand = view?.hand ?? -1;
  const deal = useCallback(() => {
    if (!id || hand < 0) return;
    setDealt(hand);
    void askHouse(id, true).catch(() => undefined);
  }, [id, hand]);

  useEffect(() => {
    if (!waited) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1_000);
    return () => clearInterval(timer);
  }, [waited]);

  useEffect(() => {
    if (!id || !waited || thinking) return;
    const now = Date.now();
    if (tried.current?.key === key && now - tried.current.at < RETRY_MS) return;
    tried.current = { key, at: now };
    setThinking(true);
    // The wish to deal rides along, in case the first telling did not arrive.
    void askHouse(id, dealt === hand)
      .then((played) => played.played && played.driver && setLast({ what: played.what, driver: played.driver }))
      .catch(() => undefined)
      .finally(() => setThinking(false));
  }, [id, waited, thinking, key, tick, dealt, hand]);

  return { account, seat, thinking, last, holding, deal };
}
