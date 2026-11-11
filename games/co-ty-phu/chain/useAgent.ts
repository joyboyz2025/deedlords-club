"use client";

import { useCallback, useEffect, useState } from "react";
import { readStored, writeStored } from "@/lib/storage";
import { RULES_MODEL } from "../agent/llm";
import { DEFAULT_PLAYBOOK, cleanPlaybook, type Playbook } from "../agent/playbook";

// An account's own agent: which model it asks, the playbook it plays by, and what its owner wished for. Kept in this
// browser, under the account's name. Nothing of it is on chain: the agent plays from the owner's tab and signs with
// the owner's own game key (see useAutopilot).

export type AgentProfile = {
  /** A model the server offers, or `rules`: the playbook alone, no model asked. */
  model: string;
  playbook: Playbook;
  /** The owner's wish in their words, as last sent to a model. */
  wish: string;
  /** Who wrote the playbook last and what it said about it. `null`: a preset, or the owner's own hand. */
  written: { by: string; reason: string } | null;
  /** Take the owner's seat from the first roll of every match they open or join here. */
  auto: boolean;
};

export const NO_AGENT: AgentProfile = {
  model: RULES_MODEL,
  playbook: DEFAULT_PLAYBOOK,
  wish: "",
  written: null,
  auto: false,
};

const AGENT_KEY = (accountId: string) => `deedlords:agent:${accountId}`;
const AUTO_KEY = (matchId: string) => `deedlords:auto:${matchId}`;

/** The saved agent of `accountId`, or the default one. */
export function readAgent(accountId: string | null): AgentProfile {
  const stored = accountId ? readStored<Partial<AgentProfile>>(AGENT_KEY(accountId)) : null;
  const playbook = cleanPlaybook(stored?.playbook);
  if (!stored || !playbook) return NO_AGENT;
  return {
    model: typeof stored.model === "string" && stored.model ? stored.model : RULES_MODEL,
    playbook,
    wish: typeof stored.wish === "string" ? stored.wish : "",
    written: stored.written && typeof stored.written.by === "string" && typeof stored.written.reason === "string" ? stored.written : null,
    auto: stored.auto === true,
  };
}

/** The owner asked their agent to fly from the first roll: the match `matchId` starts with the autopilot on. */
export function armAgent(matchId: string, accountId: string | null): void {
  if (readAgent(accountId).auto) writeStored(AUTO_KEY(matchId), true);
}

export type AgentDesk = {
  agent: AgentProfile;
  /** Models this server offers; empty when none is configured. `null` while asking. */
  models: string[] | null;
  save: (change: Partial<AgentProfile>) => void;
  /** Ask the chosen model for a playbook from `wish`. */
  write: (wish: string) => Promise<void>;
  writing: boolean;
  problem: string | null;
};

export function useAgent(accountId: string | null): AgentDesk {
  const [agent, setAgent] = useState<AgentProfile>(NO_AGENT);
  const [models, setModels] = useState<string[] | null>(null);
  const [writing, setWriting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => setAgent(readAgent(accountId)), [accountId]);

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

  const save = useCallback(
    (change: Partial<AgentProfile>) => {
      setAgent((before) => {
        const next = { ...before, ...change };
        if (accountId) writeStored(AGENT_KEY(accountId), next);
        return next;
      });
    },
    [accountId],
  );

  const write = useCallback(
    async (wish: string) => {
      setWriting(true);
      setProblem(null);
      try {
        const model = agent.model === RULES_MODEL ? undefined : agent.model;
        const response = await fetch("/api/agent/playbook", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ wish, model }),
        });
        const answer = (await response.json()) as {
          playbook?: unknown;
          reason?: string;
          driver?: string;
          error?: string;
        };
        const playbook = cleanPlaybook(answer.playbook);
        if (!response.ok || !playbook) throw new Error(answer.error ?? `the agent's desk answered ${response.status}`);
        save({
          playbook,
          wish,
          written: {
            by: answer.driver ?? "model",
            reason: answer.reason ?? "",
          },
        });
      } catch (error) {
        setProblem(error instanceof Error ? error.message : String(error));
      }
      setWriting(false);
    },
    [agent.model, save],
  );

  return { agent, models, save, write, writing, problem };
}
