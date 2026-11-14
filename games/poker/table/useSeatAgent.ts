"use client";

// Handing one's own seat at a table of two to nine seats to one's agent, in the tab. The agent is the account's own
// (games/co-ty-phu/agent/roster.ts, the same agents as at the board game). The bet comes from the agent's desk
// (/api/poker/table/agent: a model the server offers, or the odds alone), or, for an agent on the player's own NEAR AI
// key (a `near:` model, lib/agentKey.ts), from that model asked right here in the tab: that key and the seat's cards
// then go to NEAR AI and nowhere else. It is signed here with the player's own key. The page still
// shuffles, deals and shows by itself either way; the agent only bets. Turning it off gives the seat back at once.

import { useCallback, useEffect, useRef, useState } from "react";
import { modelLabel, onOwnKey, ownLlm } from "@/lib/agentKey";
import { readStored, writeStored } from "@/lib/storage";
import { RULES_MODEL } from "../../co-ty-phu/agent/llm";
import { instructions } from "../../co-ty-phu/agent/roster";
import { readAgent } from "../../co-ty-phu/chain/useAgent";
import type { Advice } from "../agent/decide";
import { advise } from "./decide";
import type { TableView } from "./seat";

/** A bet that did not go through is asked for again after this long. */
const RETRY_MS = 5_000;
const AUTO_KEY = (id: string) => `deedlords:poker-table:auto:${id}`;

export type SeatAgent = {
  on: boolean;
  toggle: () => void;
  /** A bet is being asked for. */
  thinking: boolean;
  /** What the agent said for the last bet it made here. */
  last: Advice | null;
  /** The agent that plays: its name, and the model it asks (`rules`: the odds alone). */
  name: string;
  model: string;
};

async function askDesk(id: string, seat: number, hole: number[], model: string, style: string): Promise<Advice> {
  // The owner's instructions and the seat's two cards ride with the question and go no further: the desk keeps neither.
  const order = { id, seat, hole, model, style: style || undefined };
  const response = await fetch("/api/poker/table/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(order) });
  if (!response.ok) throw new Error(`the agent's desk answered ${response.status}`);
  return (await response.json()) as Advice;
}

/**
 * `seat`: the seat this browser plays, or `null`. `hole`: its own two cards as the page decrypted them. `locked`: a
 * call is on its way, nothing may be sent. `bet` sends a bet and answers whether the contract took it.
 */
export function useSeatAgent(
  id: string,
  view: TableView | null | undefined,
  seat: number | null,
  hole: (number | null)[] | null,
  locked: boolean,
  bet: (action: "fold" | "call" | "raise", amount?: number) => Promise<boolean>,
  accountId: string | null,
): SeatAgent {
  const [on, setOn] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [last, setLast] = useState<Advice | null>(null);
  const [tick, setTick] = useState(0);
  const tried = useRef<{ key: string; at: number } | null>(null);
  const agent = readAgent(accountId);

  useEffect(() => {
    // The owner's own choice at this table, or else whether their agent flies from the start everywhere.
    setOn(readStored<boolean>(AUTO_KEY(id)) ?? readAgent(accountId).auto);
  }, [id, accountId]);

  const toggle = useCallback(() => {
    setOn((before) => {
      writeStored(AUTO_KEY(id), !before);
      return !before;
    });
  }, [id]);

  // While it is on, look again every second: a bet that failed is retried.
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1_000);
    return () => clearInterval(timer);
  }, [on]);

  const mine = view && seat !== null && view.phase === "bet" && view.toAct === seat;
  const key = view ? `${view.hand}:${view.seq}` : "";

  useEffect(() => {
    if (!on || !view || seat === null || !mine || locked || thinking) return;
    if (!hole || hole.length !== 2 || hole.some((card) => card === null)) return;
    const now = Date.now();
    if (tried.current?.key === key && now - tried.current.at < RETRY_MS) return;
    tried.current = { key, at: now };
    setThinking(true);
    // Read at each bet: the owner may have rewritten the agent in another tab since the last one.
    const flying = readAgent(accountId);
    const own = hole as number[];
    // An agent on the player's own key asks NEAR AI from this tab; without the key the desk is asked.
    const asked = onOwnKey(flying.model)
      ? advise(view, seat, own, { llm: ownLlm(flying.model), style: instructions(flying) })
      : askDesk(id, seat, own, flying.model, instructions(flying));
    void asked
      // No desk (a page served without its server), or it refused: the odds alone, worked out right here.
      .catch(() => advise(view, seat, own, { llm: null }))
      .then(async (advice) => {
        if (await bet(advice.action, advice.amount)) setLast(advice);
      })
      .finally(() => setThinking(false));
    // `tick` is here so a bet that failed is looked at again.
  }, [on, view, seat, mine, hole, locked, thinking, key, id, accountId, bet, tick]);

  return { on, toggle, thinking, last, name: agent.name, model: agent.model === RULES_MODEL ? "the odds alone" : modelLabel(agent.model, onOwnKey(agent.model)) };
}
