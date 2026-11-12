"use client";

// The tables the contract holds, for the lobby's wall: the ones with an open seat first.

import { useEffect, useState } from "react";
import { pokerClient } from "./chain";
import type { MatchView } from "./seat";

/** A free RPC is shared by every tab that is open: the wall is read this often, and not at all while it is hidden. */
const REFRESH_MS = 6_000;

export type Tables = {
  /** Every unfinished table, open seats first; `null` until the first answer. */
  tables: MatchView[] | null;
  /** The last read failed: what is shown may be old. */
  offline: boolean;
};

export function useTables(): Tables {
  const [tables, setTables] = useState<MatchView[] | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let stopped = false;
    const load = () =>
      pokerClient.view<MatchView[]>("list_matches", { from_index: 0, limit: 50 }).then(
        (listed) => {
          if (stopped) return;
          setTables([...listed].sort((a, b) => Number(b.phase === "lobby") - Number(a.phase === "lobby")));
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

  return { tables, offline };
}
