// The advice given lately, by match. Two uses: an agent asked twice for the same turn answers once (and a model is paid
// once), and the table can show who drives a seat. Kept in memory only: a note is a courtesy to the people watching,
// not a record. What a seat did is on chain.
//
// An owner's instructions to their agent are theirs alone, and the sentence the agent gives may echo them. So the
// advice for a turn is kept under the instructions it was made from (`brief`): only somebody who sends the very same
// ones gets it back, and nobody can leave advice of their own making for another's seat to pick up. The table is
// told who drives a seat, and the sentence only when the agent is the house's, which has no secret.

import type { Advice } from "./advise.ts";

/** What the table shows next to a seat an agent plays. */
export type AgentNote = { seat: number; driver: string; reason: string; fallback: boolean; ms: number; round: number; at: number };

type Page = { turns: Map<string, { key: string; advice: Advice }>; notes: Map<number, AgentNote> };
/** Advice kept per seat and per set of instructions; a seat is asked from a handful of browsers at most. */
const MAX_TURNS = 12;

export class AdviceBook {
  private readonly pages = new Map<string, Page>();
  private readonly maxMatches: number;

  constructor(maxMatches = 200) {
    this.maxMatches = maxMatches;
  }

  /** The advice already given to `seat` for the turn named `turnKey` under the instructions named `brief`, if any. */
  recall(id: string, seat: number, turnKey: string, brief = ""): Advice | null {
    const turn = this.pages.get(id)?.turns.get(`${seat}:${brief}`);
    return turn?.key === turnKey ? turn.advice : null;
  }

  /** `open`: the sentence may be shown to everybody at the table (the house agent's). Otherwise only who drove. */
  remember(id: string, seat: number, turnKey: string, round: number, advice: Advice, now: number, about: { brief?: string; open?: boolean } = {}): void {
    const page = this.pages.get(id) ?? { turns: new Map(), notes: new Map() };
    // Written last, dropped last.
    this.pages.delete(id);
    this.pages.set(id, page);
    const slot = `${seat}:${about.brief ?? ""}`;
    page.turns.delete(slot);
    page.turns.set(slot, { key: turnKey, advice });
    for (const oldest of page.turns.keys()) {
      if (page.turns.size <= MAX_TURNS) break;
      page.turns.delete(oldest);
    }
    page.notes.set(seat, { seat, driver: advice.driver, reason: about.open ? advice.reason : "", fallback: advice.fallback, ms: advice.ms, round, at: now });
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
