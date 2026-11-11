// Records Arena matches played by the rule bot with the TypeScript engine, one file of rounds per match, for the Rust
// engine to replay (`cargo run -p arena-engine --bin arena-replay -- traces/arena/*.json`). Usage: arena-gen.ts [matches]

import { mkdirSync, writeFileSync } from "node:fs";
import { planFor, type Playbook } from "../../games/arena/agent/bot.ts";
import { createMatch, drawMarket, resolveRound } from "../../games/arena/engine.ts";

const matches = Number(process.argv[2] ?? 60);
let state = 20261111;
const below = (n: number): number => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return Math.floor((state / 4294967296) * n);
};
const book = (): Playbook => ({ overbid: below(4), reserve: below(3) * 5, guild: below(5) - 1, role: below(5) - 1 });

mkdirSync("traces/arena", { recursive: true });
let rounds = 0;
for (let index = 0; index < matches; index++) {
  const books = [book(), book()];
  const steps = [];
  let match = createMatch(3 + below(5), drawMarket(1, below));
  while (!match.done) {
    const plans = [planFor(match, 0, books[0]), planFor(match, 1, books[1])];
    const nextMarket = drawMarket(match.round + 1, below);
    const after = resolveRound(match, plans, nextMarket);
    steps.push({ before: match, plans, nextMarket, after });
    match = after;
  }
  rounds += steps.length;
  writeFileSync(`traces/arena/match-${String(index).padStart(3, "0")}.json`, JSON.stringify(steps));
}
console.log(`${matches} matches, ${rounds} rounds written to traces/arena/`);
