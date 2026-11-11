"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readStored, writeStored } from "@/lib/storage";
import { advise, type Advice } from "../agent/advise";
import type { AgentNote } from "../agent/book";
import type { Plan } from "../agent/plan";
import type { RoomState } from "./room";
import { readAgent, type AgentProfile } from "./useAgent";

// Handing one's own seat to an agent, in the tab: the plan comes from the agent's desk (/api/agent: a model, or the rule
// bot) and is signed here with the player's own session key, the same key that signs their clicks. Nothing changes on
// chain and no key moves: turning it off gives the seat back at once.

/** A turn that did not go through is planned again after this long. */
const RETRY_MS = 5_000;
const NOTES_EVERY_MS = 2_500;
const AUTO_KEY = (id: string) => `deedlords:auto:${id}`;

export type Autopilot = {
  on: boolean;
  /** A plan is being asked for. */
  thinking: boolean;
  toggle: () => void;
  /** What the agent said for the last turn it played here. */
  last: Advice | null;
};

async function askDesk(id: string, seat: number, agent: AgentProfile): Promise<Advice> {
  const order = { id, seat, model: agent.model, playbook: agent.playbook, style: agent.wish || undefined };
  const response = await fetch("/api/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(order) });
  if (!response.ok) throw new Error(`the agent's desk answered ${response.status}`);
  return (await response.json()) as Advice;
}

/** `accountId`: whose agent flies (its model and playbook, see useAgent). `null` for somebody who has no seat in the match. */
export function useAutopilot(id: string, state: RoomState, playTurn: (plan: Plan) => boolean, accountId: string | null = null): Autopilot | null {
  const [on, setOn] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [last, setLast] = useState<Advice | null>(null);
  const [tick, setTick] = useState(0);
  const tried = useRef<{ key: string; at: number } | null>(null);
  const wanted = useRef(false);
  const { match, seat, busy, result } = state;

  useEffect(() => {
    const stored = readStored<boolean>(AUTO_KEY(id)) === true;
    wanted.current = stored;
    setOn(stored);
  }, [id]);

  const toggle = useCallback(() => {
    wanted.current = !wanted.current;
    writeStored(AUTO_KEY(id), wanted.current);
    setOn(wanted.current);
  }, [id]);

  // While it is on, look again every second: a turn that failed is retried, a move still landing is waited for.
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1_000);
    return () => clearInterval(timer);
  }, [on]);

  const mine = on && seat !== null && !result && !busy && match?.meta.status === "playing" && match.meta.current_seat === seat;
  const key = match ? `${match.game.rolls}:${match.game.round}:${match.game.stage}` : "";

  useEffect(() => {
    if (!mine || !match || seat === null || thinking) return;
    const now = Date.now();
    if (tried.current?.key === key && now - tried.current.at < RETRY_MS) return;
    tried.current = { key, at: now };
    setThinking(true);
    // Read at each turn: the owner may have adjusted the playbook in another tab since the last one.
    const agent = readAgent(accountId);
    void askDesk(id, seat, agent)
      // No desk (a page served without its server): the playbook runs right here.
      .catch(() => advise(match, seat, { llm: null, playbook: agent.playbook }))
      .then((advice) => {
        if (!advice || !wanted.current) return;
        if (playTurn(advice.plan)) setLast(advice);
      })
      .catch(() => undefined)
      .finally(() => setThinking(false));
  }, [mine, key, tick, thinking, id, seat, match, playTurn, accountId]);

  return seat === null ? null : { on, thinking, toggle, last };
}

/** Who drives which seat of the match and what each said last, as the agent's desk knows it. Empty without a desk. */
export function useAgentNotes(id: string, watching: boolean): AgentNote[] {
  const [notes, setNotes] = useState<AgentNote[]>([]);
  useEffect(() => {
    if (!watching) return;
    let stopped = false;
    const load = () =>
      document.visibilityState !== "hidden" &&
      fetch(`/api/agent?id=${encodeURIComponent(id)}`)
        .then((response) => (response.ok ? (response.json() as Promise<{ notes: AgentNote[] }>) : null))
        .then((answer) => !stopped && answer && setNotes((before) => (JSON.stringify(before) === JSON.stringify(answer.notes) ? before : answer.notes)))
        .catch(() => undefined);
    void load();
    const timer = setInterval(load, NOTES_EVERY_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [id, watching]);
  return notes;
}
