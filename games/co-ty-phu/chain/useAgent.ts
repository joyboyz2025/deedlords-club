"use client";

import { useCallback, useEffect, useState } from "react";
import { readStored, writeStored } from "@/lib/storage";
import { RULES_MODEL } from "../agent/llm";
import { cleanPlaybook } from "../agent/playbook";
import { FIRST_ROSTER, MAX_AGENTS, cleanRoster, flyingAgent, newAgent, type Agent, type Roster } from "../agent/roster";

// An account's own agents (see agent/roster.ts), kept in this browser under the account's name. Nothing of them is on
// chain: the one that flies plays from the owner's tab and signs with the owner's own game key (see useAutopilot).

/** The agent that flies the owner's seat, and whether it does so from the first roll. */
export type AgentProfile = Agent & { auto: boolean };

const ROSTER_KEY = (accountId: string) => `deedlords:agents:${accountId}`;
/** Where an account's single agent was kept before it could have several. */
const LEGACY_KEY = (accountId: string) => `deedlords:agent:${accountId}`;
const AUTO_KEY = (matchId: string) => `deedlords:auto:${matchId}`;

export function readRoster(accountId: string | null): Roster {
  if (!accountId) return FIRST_ROSTER;
  return cleanRoster(readStored<unknown>(ROSTER_KEY(accountId)), readStored<unknown>(LEGACY_KEY(accountId)));
}

/** The agent of `accountId` that flies, or the default one. */
export function readAgent(accountId: string | null): AgentProfile {
  const roster = readRoster(accountId);
  return { ...flyingAgent(roster), auto: roster.auto };
}

/** The owner asked their agent to fly from the first roll: the match `matchId` starts with the autopilot on. */
export function armAgent(matchId: string, accountId: string | null): void {
  if (readRoster(accountId).auto) writeStored(AUTO_KEY(matchId), true);
}

export type AgentDesk = {
  agents: Agent[];
  /** The agent being looked at, which is also the one that flies. */
  agent: Agent;
  auto: boolean;
  /** Models this server offers; empty when none is configured. `null` while asking. */
  models: string[] | null;
  /** Changes the agent being looked at. */
  save: (change: Partial<Omit<Agent, "id">>) => void;
  /** Looks at, and flies, another of the owner's agents. */
  pick: (id: string) => void;
  /** A new agent with that name, which becomes the one looked at. `false`: there are too many already. */
  add: (name: string) => boolean;
  /** Deletes the agent being looked at, unless it is the last one. */
  remove: () => void;
  setAuto: (auto: boolean) => void;
  /** Ask the chosen model for a playbook from `wish`. */
  write: (wish: string) => Promise<void>;
  writing: boolean;
  problem: string | null;
};

export function useAgent(accountId: string | null): AgentDesk {
  const [roster, setRoster] = useState<Roster>(FIRST_ROSTER);
  const [models, setModels] = useState<string[] | null>(null);
  const [writing, setWriting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => setRoster(readRoster(accountId)), [accountId]);

  useEffect(() => {
    let stopped = false;
    fetch("/api/agent/playbook")
      .then((response) => (response.ok ? (response.json() as Promise<{ models: string[] }>) : { models: [] }))
      .then((answer) => !stopped && setModels(answer.models))
      // No desk (a page served without its server): the playbook alone plays.
      .catch(() => !stopped && setModels([]));
    return () => {
      stopped = true;
    };
  }, []);

  const change = useCallback(
    (make: (before: Roster) => Roster) => {
      setRoster((before) => {
        const next = make(before);
        if (accountId && next !== before) writeStored(ROSTER_KEY(accountId), next);
        return next;
      });
    },
    [accountId],
  );

  const save = useCallback(
    (edit: Partial<Omit<Agent, "id">>) => change((before) => ({ ...before, agents: before.agents.map((agent) => (agent.id === before.flying ? { ...agent, ...edit } : agent)) })),
    [change],
  );
  const pick = useCallback((id: string) => change((before) => (before.agents.some((agent) => agent.id === id) ? { ...before, flying: id } : before)), [change]);
  const add = useCallback(
    (name: string) => {
      if (roster.agents.length >= MAX_AGENTS) return false;
      const id = `a${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
      change((before) => ({ ...before, agents: [...before.agents, newAgent(id, name.trim() || `Agent ${before.agents.length + 1}`)], flying: id }));
      return true;
    },
    [change, roster.agents.length],
  );
  const remove = useCallback(
    () =>
      change((before) => {
        if (before.agents.length < 2) return before;
        const agents = before.agents.filter((agent) => agent.id !== before.flying);
        return { ...before, agents, flying: agents[0].id };
      }),
    [change],
  );
  const setAuto = useCallback((auto: boolean) => change((before) => ({ ...before, auto })), [change]);

  const agent = flyingAgent(roster);
  const write = useCallback(
    async (wish: string) => {
      setWriting(true);
      setProblem(null);
      try {
        const model = agent.model === RULES_MODEL ? undefined : agent.model;
        const response = await fetch("/api/agent/playbook", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wish, model }) });
        const answer = (await response.json()) as { playbook?: unknown; reason?: string; driver?: string; error?: string };
        const playbook = cleanPlaybook(answer.playbook);
        if (!response.ok || !playbook) throw new Error(answer.error ?? `the agent's desk answered ${response.status}`);
        save({ playbook, written: { by: answer.driver ?? "model", reason: answer.reason ?? "" } });
      } catch (error) {
        setProblem(error instanceof Error ? error.message : String(error));
      }
      setWriting(false);
    },
    [agent.model, save],
  );

  return { agents: roster.agents, agent, auto: roster.auto, models, save, pick, add, remove, setAuto, write, writing, problem };
}
