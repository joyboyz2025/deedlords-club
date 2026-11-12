"use client";

// The tables of two to nine seats the contract holds, for the lobby's wall: the ones with a free seat first.

import { useEffect, useState } from "react";
import { noteTable, tableClient } from "./chain";
import type { TableView } from "./seat";

/** A free RPC is shared by every tab that is open: the wall is read this often, and not at all while it is hidden. */
const REFRESH_MS = 6_000;

export type Tables = {
  /** Every table that is not settled, the ones with a free seat first; `null` until the first answer. */
  tables: TableView[] | null;
  /** The last read failed: what is shown may be old. */
  offline: boolean;
};

const freeSeats = (table: TableView): number => table.players.filter((player) => !player).length;

export function useTables(): Tables {
  const [tables, setTables] = useState<TableView[] | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let stopped = false;
    const load = () =>
      tableClient.view<TableView[]>("list_matches", { from_index: 0, limit: 50 }).then(
        (listed) => {
          if (stopped) return;
          listed.forEach(noteTable);
          // Tables still in the lobby first, then the ones under way that have a free seat, then the full ones.
          const rank = (table: TableView) => (table.phase === "lobby" ? 2 : freeSeats(table) > 0 ? 1 : 0);
          setTables([...listed].sort((a, b) => rank(b) - rank(a)));
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
