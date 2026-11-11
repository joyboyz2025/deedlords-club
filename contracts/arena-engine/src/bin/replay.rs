//! Replays rounds recorded by the TypeScript engine (`tools/diff/arena-gen.ts`) and checks that this engine gives the
//! same match after each one. Usage: `arena-replay <file.json>...`; each file is a list of
//! `{ "before": Match, "plans": [Plan, Plan], "nextMarket": [..], "after": Match }`.

use std::{env, fs, process};

use arena_engine::{resolve_round, Match, Plan};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Step {
    before: Match,
    plans: [Plan; 2],
    next_market: Vec<u8>,
    after: Match,
}

fn main() {
    let mut rounds = 0;
    for path in env::args().skip(1) {
        let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {path}: {e}"));
        let steps: Vec<Step> = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{path}: {e}"));
        for (index, step) in steps.into_iter().enumerate() {
            let got = resolve_round(&step.before, &step.plans, step.next_market).unwrap_or_else(|e| panic!("{path} round {index}: {e}"));
            if got != step.after {
                eprintln!("{path}: round {index} differs\n  rust: {}\n  ts:   {}", serde_json::to_string(&got).unwrap(), serde_json::to_string(&step.after).unwrap());
                process::exit(1);
            }
            rounds += 1;
        }
    }
    println!("{rounds} rounds replayed, all equal");
}
