// An account's own agents: as many as its owner likes, each with a name, the model it asks, and the owner's own
// instructions: a prompt as long as they need and any number of rules. One of them is the one that flies the owner's
// seat. Kept in the owner's browser only. The instructions are the owner's secret: they go to the model with each
// turn's question and are shown to nobody else at the table.
//
// The playbook is what is left of the old way (six numbers and choices): it plays when no model is asked, or when
// the model is slow or refuses.

import { MAX_STYLE, RULES_MODEL } from "./llm.ts";
import { DEFAULT_PLAYBOOK, cleanPlaybook, type Playbook } from "./playbook.ts";

export type Agent = {
  id: string;
  name: string;
  /** A model the server offers, or `rules`: the playbook alone, no model asked. */
  model: string;
  /** The owner's instructions in their own words. */
  prompt: string;
  /** More instructions, one thought each. */
  rules: string[];
  playbook: Playbook;
  /** Who wrote the playbook last and what it said about it. `null`: a preset, or the owner's own hand. */
  written: { by: string; reason: string } | null;
};

export type Roster = {
  agents: Agent[];
  /** The agent that takes the owner's seat when asked to. Always one of `agents`. */
  flying: string;
  /** Take the owner's seat from the first roll of every match they open or join here. */
  auto: boolean;
};

export const MAX_NAME = 32;
export const MAX_RULE = 600;
export const MAX_AGENTS = 24;
export const MAX_RULES = 60;

export function newAgent(id: string, name = "Co-pilot"): Agent {
  return { id, name, model: RULES_MODEL, prompt: "", rules: [], playbook: DEFAULT_PLAYBOOK, written: null };
}

export const FIRST_ROSTER: Roster = { agents: [newAgent("first")], flying: "first", auto: false };

const text = (value: unknown, max: number): string => (typeof value === "string" ? value.slice(0, max) : "");

function cleanAgent(raw: unknown, fallbackId: string): Agent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const from = raw as Record<string, unknown>;
  const playbook = cleanPlaybook(from.playbook);
  if (!playbook) return null;
  const written = from.written as { by?: unknown; reason?: unknown } | null | undefined;
  return {
    id: text(from.id, 40) || fallbackId,
    name: text(from.name, MAX_NAME).trim() || "Co-pilot",
    model: text(from.model, 80) || RULES_MODEL,
    prompt: text(from.prompt, MAX_STYLE),
    rules: (Array.isArray(from.rules) ? from.rules : []).slice(0, MAX_RULES).map((rule) => text(rule, MAX_RULE)),
    playbook,
    written: written && typeof written.by === "string" && typeof written.reason === "string" ? { by: written.by, reason: written.reason } : null,
  };
}

/**
 * What was stored, made safe to use: a roster with at least one agent and a flying one among them. `legacy` is the
 * single agent an account had before it could have several (`{ model, playbook, wish, auto }`): it becomes the first.
 */
export function cleanRoster(raw: unknown, legacy?: unknown): Roster {
  const from = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const seen = new Set<string>();
  const agents = (Array.isArray(from.agents) ? from.agents : [])
    .slice(0, MAX_AGENTS)
    .map((agent, i) => cleanAgent(agent, `a${i}`))
    .filter((agent): agent is Agent => agent !== null && !seen.has(agent.id) && Boolean(seen.add(agent.id)));
  if (agents.length === 0) {
    const old = (typeof legacy === "object" && legacy !== null ? legacy : null) as Record<string, unknown> | null;
    const kept = old && cleanAgent({ ...old, id: "first", name: "Co-pilot", prompt: old.wish }, "first");
    return { agents: [kept ?? newAgent("first")], flying: "first", auto: old?.auto === true };
  }
  const flying = typeof from.flying === "string" && seen.has(from.flying) ? from.flying : agents[0].id;
  return { agents, flying, auto: from.auto === true };
}

export const flyingAgent = (roster: Roster): Agent => roster.agents.find((agent) => agent.id === roster.flying) ?? roster.agents[0];

/** What the model is told on the owner's behalf: the prompt, then the rules, numbered. Empty when there is nothing. */
export function instructions(agent: Pick<Agent, "prompt" | "rules">): string {
  const rules = agent.rules.map((rule) => rule.trim()).filter(Boolean);
  return [agent.prompt.trim(), ...rules.map((rule, i) => `Rule ${i + 1}: ${rule}`)].filter(Boolean).join("\n").slice(0, MAX_STYLE);
}
