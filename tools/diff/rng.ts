// Seeded randomness for traces (docs/ENGINE-RULES.md §2, §9): a mulberry32 PRNG, an engine `Rng` built on it, and a
// wrapper that records every call so the Rust replayer can feed the same values back.

import type { Rng } from "../../games/co-ty-phu/engine.ts";

export type RngCall = { kind: "die"; value: number } | { kind: "below"; n: number; value: number };

/** mulberry32: a small, fast 32-bit PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derives the seed of game `index` from the run seed, so each game can be regenerated alone. */
export function gameSeed(runSeed: number, index: number): number {
  let h = (Math.imul(runSeed >>> 0, 0x9e3779b1) ^ Math.imul(index + 1, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * An engine `Rng` on a PRNG. `doubles` is the chance that the second die of a roll copies the first, on top of the
 * fair chance: 0 gives fair dice, more makes doubles, triple doubles and jail exits by doubles more frequent. The
 * engine always draws a roll's two dice back to back, so pairing consecutive `die()` calls is safe.
 */
export function prngRng(random: () => number, doubles = 0): Rng & { reset(): void } {
  let first: number | null = null;
  const below = (n: number) => Math.min(n - 1, Math.floor(random() * n));
  return {
    die() {
      if (first === null) {
        first = 1 + below(6);
        return first;
      }
      const value = random() < doubles ? first : 1 + below(6);
      first = null;
      return value;
    },
    below(n: number) {
      if (!Number.isInteger(n) || n < 1) throw new Error(`below(${n})`);
      return below(n);
    },
    reset() {
      first = null;
    },
  };
}

/** Passes calls through to `source` and records them; `take()` returns and clears the calls of the current step. */
export class RecordingRng implements Rng {
  private calls: RngCall[] = [];
  private readonly source: Rng;
  /** Called after each `below` with its result (the generator uses it to count card draws). */
  onBelow: (n: number, value: number) => void = () => {};

  constructor(source: Rng) {
    this.source = source;
  }

  die(): number {
    const value = this.source.die();
    if (!Number.isInteger(value) || value < 1 || value > 6) throw new Error(`die() returned ${value}`);
    this.calls.push({ kind: "die", value });
    return value;
  }

  below(n: number): number {
    const value = this.source.below(n);
    if (!Number.isInteger(value) || value < 0 || value >= n) throw new Error(`below(${n}) returned ${value}`);
    this.calls.push({ kind: "below", n, value });
    this.onBelow(n, value);
    return value;
  }

  take(): RngCall[] {
    const calls = this.calls;
    this.calls = [];
    return calls;
  }
}

/** Replays recorded values in order and throws on any call that differs from the record (for tests). */
export function scriptedRng(calls: RngCall[]): Rng & { left(): number } {
  let next = 0;
  const take = (kind: string, n?: number) => {
    const call = calls[next++];
    if (!call) throw new Error(`unexpected ${kind}${n === undefined ? "()" : `(${n})`}: script exhausted`);
    if (call.kind !== kind || (call.kind === "below" && call.n !== n)) throw new Error(`asked ${kind}(${n ?? ""}), script has ${JSON.stringify(call)}`);
    return call.value;
  };
  return { die: () => take("die"), below: (n) => take("below", n), left: () => calls.length - next };
}
