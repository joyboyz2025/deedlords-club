"use client";

import type { TeeProof } from "@/lib/teeProof";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { Session } from "@/lib/chain/client";
import { CHAIN } from "@/lib/chain/config";
import { chainClient } from "@/lib/chain/shared";
import type { Plan } from "../agent/plan";
import type { Send } from "../useRoom";
import { seatCaller } from "./free";
import { ChainRoom, type RoomState } from "./room";

/**
 * An on-chain match in React: what `useRoom` is for a room on the room server. `session` is the viewer's function-call
 * key for the game contract, `null` to only watch. Every state is the whole of what the viewer sees.
 */
export function useChainRoom(
  id: string,
  session: Session | null,
): RoomState & { send: Send; playTurn: (plan: Plan, proof?: TeeProof | null) => boolean; retry: () => void; refresh: () => Promise<void> } {
  const room = useMemo(
    () => new ChainRoom({ id, reader: chainClient, caller: session && seatCaller(session), pollMs: CHAIN.pollMs, isVisible: () => document.visibilityState !== "hidden" }),
    [id, session],
  );

  useEffect(() => {
    room.start();
    // Back on the tab: read at once instead of at the next poll.
    const wake = () => {
      if (document.visibilityState !== "hidden") void room.refresh();
    };
    document.addEventListener("visibilitychange", wake);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      room.stop();
    };
  }, [room]);

  const state = useSyncExternalStore(room.subscribe, room.getState, room.getState);
  return { ...state, send: room.send, playTurn: room.playTurn, retry: room.retry, refresh: room.refresh };
}
