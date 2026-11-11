// The advice given lately, by match. Two uses: an agent asked twice for the same turn answers once (and a model is paid
// once), and the table can show who drives a seat and the sentence it gave. Kept in memory only: a note is a courtesy
// to the people watching, not a record. What a seat did is on chain.

import type { Advice } from "./advise.ts";

/** What the table shows next to a seat an agent plays. */
export type AgentNote = { seat: number; driver: string; reason: string; fallback: boolean; ms: number; round: number; at: number };

type Page = { turns: Map<number, { key: string; advice: Advice }>; notes: Map<number, AgentNote> };

export class AdviceBook {
  private readonly pages = new Map<string, Page>();
  private readonly maxMatches: number;

  constructor(maxMatches = 200) {
    this.maxMatches = maxMatches;
  }

  /** The advice already given to `seat` for the turn named `turnKey`, if any. */
  recall(id: string, seat: number, turnKey: string): Advice | null {
    const turn = this.pages.get(id)?.turns.get(seat);
    return turn?.key === turnKey ? turn.advice : null;
  }

  remember(id: string, seat: number, turnKey: string, round: number, advice: Advice, now: number): void {
    const page = this.pages.get(id) ?? { turns: new Map(), notes: new Map() };
    // Written last, dropped last.
    this.pages.delete(id);
    this.pages.set(id, page);
    page.turns.set(seat, { key: turnKey, advice });
    page.notes.set(seat, { seat, driver: advice.driver, reason: advice.reason, fallback: advice.fallback, ms: advice.ms, round, at: now });
    for (const oldest of this.pages.keys()) {
      if (this.pages.size <= this.maxMatches) break;
      this.pages.delete(oldest);
    }
  }

  /** The last note of each seat an agent has played in the match, by seat. */
  notes(id: string): AgentNote[] {
    return [...(this.pages.get(id)?.notes.values() ?? [])].sort((a, b) => a.seat - b.seat);
  }
}
