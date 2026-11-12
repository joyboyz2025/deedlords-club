"use client";

// The house's seats at a table of two to nine seats, from the page's side: the server plays them
// (games/poker/table/house.ts). The tab that has the table open asks whenever the table is waiting for one of them,
// which makes the house quick; it also plays unasked, only slower.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Played } from "./house";
import type { TableView } from "./seat";

/** While the table waits for the house, it is asked again after this long. */
const RETRY_MS = 4_000;

/** Asks the house for one step at table `id`; with `add`, to take one more free seat there, betting by `model`. */
export async function askHouse(id: string, add = false, model?: string): Promise<Played> {
  for (let tries = 0; ; tries++) {
    const response = await fetch("/api/poker/table/house", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, add, model }) });
    const answer = (await response.json()) as Played & { error?: string };
    if (!response.ok) throw new Error(answer.error ?? `the house answered ${response.status}`);
    // A table opened a moment ago may not have reached the node the server read from: ask again for a few seconds.
    if (answer.played || !answer.again || tries >= 5) return answer;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
}

export type HouseSeats = {
  /** The accounts that play the house here; empty: this server has none; `undefined`: not known yet. */
  accounts: string[] | undefined;
  /** The account that opens free tables here and holds a seat at each, `null` when nobody does. It never stakes. */
  free: string | null;
  /** The seats the house holds at this table. */
  seats: number[];
  /** Whether one more house seat can be asked for: a seat is free and a house account is not at the table yet. */
  canAdd: boolean;
  /** Asks a house account to take a free seat, betting by `model` (one of `models`); answers why not when it did not. */
  add: (model?: string) => Promise<Played>;
  /** The models a house seat may be given ("rules": the odds alone), and the one a seat gets when none is chosen. */
  models: string[];
  defaultModel: string | null;
  /** The model each house seat at this table bets by, by seat. */
  seatModels: Record<number, string>;
  /** The house is doing its part right now. */
  thinking: boolean;
  /** The last bet of a house seat here and what it said about it. */
  last: { seat?: number; what: string; reason?: string; driver?: string } | null;
};

export function useHouse(id: string | null, view: TableView | null | undefined): HouseSeats {
  const [accounts, setAccounts] = useState<string[] | undefined>(undefined);
  // The accounts that sit at tables with a stake: all of them but the free tables' host.
  const [staking, setStaking] = useState<string[]>([]);
  const [free, setFree] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [byAccount, setByAccount] = useState<Record<string, string>>({});
  const [thinking, setThinking] = useState(false);
  const [last, setLast] = useState<HouseSeats["last"]>(null);
  const [tick, setTick] = useState(0);
  const tried = useRef<{ key: string; at: number } | null>(null);

  useEffect(() => {
    let stopped = false;
    type Answer = { houses: string[]; staking?: string[]; free?: string | null; models?: string[]; model?: string | null; seats?: Record<string, string> };
    fetch(`/api/poker/table/house${id ? `?id=${encodeURIComponent(id)}` : ""}`)
      .then((response) => (response.ok ? (response.json() as Promise<Answer>) : { houses: [] as string[] }))
      .then((answer: Answer) => {
        if (stopped) return;
        setAccounts(answer.houses);
        setStaking(answer.staking ?? answer.houses);
        setFree(answer.free ?? null);
        setModels(answer.models ?? []);
        setDefaultModel(answer.model ?? null);
        setByAccount(answer.seats ?? {});
      })
      .catch(() => !stopped && setAccounts([]));
    return () => {
      stopped = true;
    };
    // Read again when a house seat is added (the number of seats taken changes).
  }, [id, view?.players.filter(Boolean).length]);

  const seats = view && accounts ? view.players.flatMap((player, seat) => (player && accounts.includes(player) ? [seat] : [])) : [];
  // At a free table any of the server's accounts may sit; at one with a stake, only those that stake.
  const pool = view && accounts ? (BigInt(view.stake) === 0n ? accounts : staking) : [];
  const canAdd = Boolean(view && view.players.includes(null) && pool.some((account) => !view.players.includes(account)));
  // The house is asked when the table waits for one of its seats, and when another seat is out of time (it then calls time).
  const waited = Boolean(view && seats.length && view.phase !== "lobby" && (view.awaited.some((seat) => seats.includes(seat)) || Date.now() * 1_000_000 > Number(view.deadline)));
  const key = view ? `${view.seq}` : "";
  const add = useCallback((model?: string) => (id ? askHouse(id, true, model) : Promise.resolve<Played>({ played: false, why: "no table" })), [id]);
  const seatModels: Record<number, string> = Object.fromEntries(
    seats.flatMap((seat) => (view?.players[seat] && byAccount[view.players[seat]!] ? [[seat, byAccount[view.players[seat]!]]] : [])),
  );

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
    void askHouse(id)
      .then((played) => played.played && played.reason && setLast({ seat: played.seat, what: played.what, reason: played.reason, driver: played.driver }))
      .catch(() => undefined)
      .finally(() => setThinking(false));
  }, [id, waited, thinking, key, tick]);

  return { accounts, free, seats, canAdd, add, models, defaultModel, seatModels, thinking, last };
}
