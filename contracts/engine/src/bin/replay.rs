//! Replays TS trace files (ENGINE-RULES §9) through the Rust engine and reports the first divergence of each trace.
//!
//! ```text
//! cargo run --release --bin replay -- <trace.json | directory>...
//! ```
//!
//! For every step it feeds the recorded Rng values back through a scripted Rng and checks that (a) Rust made exactly
//! the recorded Rng calls (kind, n, count), (b) `ok` matches (`Ok` <=> true), (c) the snapshot equals `state`.
//! Directories are searched recursively for `*.json`. Exit code 1 when any trace fails.

use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use deedlords_engine::{Action, Extras, Game, Rng, Rules};
use serde::Deserialize;
use serde_json::Value;

/// How many differing JSON paths to print for a divergent snapshot.
const MAX_DIFFS: usize = 25;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Trace {
    version: u32,
    #[serde(default)]
    #[allow(dead_code)]
    seed: Value,
    /// `{ salary, cash, blitz, maxRounds }`, and the opt-in rules of ENGINE-RULES §10 when on (`tickets`, `leaderRent`, `buildHere`).
    rules: Value,
    players: Vec<String>,
    steps: Vec<Step>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Step {
    op: String,
    player: Option<String>,
    #[serde(default)]
    index: Value,
    rng: Vec<Call>,
    ok: bool,
    state: Value,
}

#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
enum Call {
    Die { value: i64 },
    Below { n: i64, value: i64 },
}

impl Call {
    fn describe(&self) -> String {
        match self {
            Call::Die { value } => format!("die()={value}"),
            Call::Below { n, value } => format!("below({n})={value}"),
        }
    }
}

/// Hands out the recorded values; remembers the first mismatch instead of panicking.
struct Scripted<'a> {
    calls: &'a [Call],
    used: usize,
    error: Option<String>,
}

impl Scripted<'_> {
    fn next(&mut self, asked: &str) -> Option<Call> {
        let i = self.used;
        self.used += 1;
        let call = self.calls.get(i).copied();
        if call.is_none() && self.error.is_none() {
            self.error = Some(format!("rust asked {asked} as call #{} but the trace recorded only {} call(s)", i + 1, self.calls.len()));
        }
        call
    }

    fn fail(&mut self, message: String) {
        if self.error.is_none() {
            self.error = Some(message);
        }
    }
}

impl Rng for Scripted<'_> {
    fn die(&mut self) -> u8 {
        let i = self.used + 1;
        match self.next("die()") {
            Some(Call::Die { value }) if (1..=6).contains(&value) => value as u8,
            Some(Call::Die { value }) => {
                self.fail(format!("call #{i}: recorded die() value {value} is outside 1..=6"));
                1
            }
            Some(other) => {
                self.fail(format!("call #{i}: rust asked die(), trace has {}", other.describe()));
                1
            }
            None => 1,
        }
    }

    fn below(&mut self, n: u32) -> u32 {
        let i = self.used + 1;
        match self.next(&format!("below({n})")) {
            Some(Call::Below { n: m, value }) if m == i64::from(n) && (0..m).contains(&value) => value as u32,
            Some(Call::Below { n: m, value }) if m == i64::from(n) => {
                self.fail(format!("call #{i}: recorded below({m}) value {value} is outside 0..{m}"));
                0
            }
            Some(other) => {
                self.fail(format!("call #{i}: rust asked below({n}), trace has {}", other.describe()));
                0
            }
            None => 0,
        }
    }
}

/// The action of a step, or `None` when the trace's index cannot name a square (negative, fractional, null, huge):
/// such a step is illegal by definition and must be recorded with `ok: false` and no Rng calls.
fn action_of(step: &Step) -> Result<Option<Action>, String> {
    if !Action::OPS.contains(&step.op.as_str()) {
        return Err(format!("unknown op {:?}", step.op));
    }
    let index = step.index.as_u64().and_then(|i| u8::try_from(i).ok());
    if Action::op_takes_index(&step.op) && index.is_none() {
        return Ok(None);
    }
    Ok(Action::from_op(&step.op, index))
}

/// Collects `path: rust=… trace=…` lines for every differing leaf.
fn diff(path: &str, rust: Option<&Value>, trace: Option<&Value>, out: &mut Vec<String>) {
    if rust == trace {
        return;
    }
    match (rust, trace) {
        (Some(Value::Object(a)), Some(Value::Object(b))) => {
            let keys: BTreeSet<&String> = a.keys().chain(b.keys()).collect();
            for key in keys {
                let sub = if path.is_empty() { key.clone() } else { format!("{path}.{key}") };
                diff(&sub, a.get(key), b.get(key), out);
            }
        }
        (Some(Value::Array(a)), Some(Value::Array(b))) => {
            for i in 0..a.len().max(b.len()) {
                diff(&format!("{path}[{i}]"), a.get(i), b.get(i), out);
            }
        }
        _ => {
            let show = |v: Option<&Value>| v.map_or("<missing>".to_string(), Value::to_string);
            out.push(format!("{}: rust={} trace={}", if path.is_empty() { "<root>" } else { path }, show(rust), show(trace)));
        }
    }
}

/// Replays one trace; `Err` describes the first divergence (or why the file is unusable).
fn replay(path: &Path) -> Result<usize, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("cannot read: {e}"))?;
    let trace: Trace = serde_json::from_str(&text).map_err(|e| format!("not a version-1 trace: {e}"))?;
    if trace.version != 1 {
        return Err(format!("unsupported trace version {}", trace.version));
    }
    let rules: Rules = match serde_json::from_value(trace.rules.clone()) {
        Ok(rules) => rules,
        Err(error) => return Err(format!("bad rules: {error}")),
    };
    let extras: Extras = match serde_json::from_value(trace.rules.clone()) {
        Ok(extras) => extras,
        Err(error) => return Err(format!("bad rules: {error}")),
    };
    let mut game = Game::new(rules, trace.players.clone()).with_extras(extras);
    for (number, step) in trace.steps.iter().enumerate() {
        let action = action_of(step).map_err(|e| format!("step {number}: {e}"))?;
        let mut rng = Scripted { calls: &step.rng, used: 0, error: None };
        let ok = match action {
            Some(action) => game.apply(step.player.as_deref(), action, &mut rng).is_ok(),
            None => false,
        };
        let mut problems = Vec::new();
        if let Some(error) = rng.error.take() {
            problems.push(format!("rng: {error}"));
        } else if rng.used != step.rng.len() {
            let recorded: Vec<String> = step.rng.iter().map(Call::describe).collect();
            problems.push(format!("rng: rust made {} call(s), the trace recorded {}: [{}]", rng.used, step.rng.len(), recorded.join(", ")));
        }
        if ok != step.ok {
            problems.push(format!("ok: rust={ok} trace={}", step.ok));
        }
        let mut diffs = Vec::new();
        diff("", Some(&game.snapshot()), Some(&step.state), &mut diffs);
        if !diffs.is_empty() {
            let more = diffs.len().saturating_sub(MAX_DIFFS);
            let mut text = format!("state: {} differing path(s)", diffs.len());
            for line in diffs.iter().take(MAX_DIFFS) {
                write!(text, "\n      {line}").unwrap();
            }
            if more > 0 {
                write!(text, "\n      ... and {more} more").unwrap();
            }
            problems.push(text);
        }
        if !problems.is_empty() {
            let index = if step.index.is_null() { String::new() } else { format!(" index={}", step.index) };
            let mut text = format!("step {number} op={} player={}{index}", step.op, step.player.as_deref().unwrap_or("null"));
            for problem in problems {
                write!(text, "\n    {problem}").unwrap();
            }
            return Err(text);
        }
    }
    Ok(trace.steps.len())
}

fn collect(path: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    if path.is_dir() {
        let entries = std::fs::read_dir(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let mut children: Vec<PathBuf> = entries.filter_map(|entry| entry.ok().map(|e| e.path())).collect();
        children.sort();
        for child in children {
            if child.is_dir() || child.extension().is_some_and(|ext| ext == "json") {
                collect(&child, files)?;
            }
        }
        Ok(())
    } else if path.is_file() {
        files.push(path.to_path_buf());
        Ok(())
    } else {
        Err(format!("{}: no such file or directory", path.display()))
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() || args.iter().any(|a| a == "-h" || a == "--help") {
        eprintln!("usage: replay <trace.json | directory>...");
        return ExitCode::from(2);
    }
    let mut files = Vec::new();
    for arg in &args {
        if let Err(error) = collect(Path::new(arg), &mut files) {
            eprintln!("{error}");
            return ExitCode::from(2);
        }
    }
    let (mut passed, mut failed) = (0, 0);
    for file in &files {
        match replay(file) {
            Ok(steps) => {
                passed += 1;
                println!("OK   {} ({steps} steps)", file.display());
            }
            Err(error) => {
                failed += 1;
                println!("FAIL {}\n  {error}", file.display());
            }
        }
    }
    println!("REPLAY: {passed} ok, {failed} failed");
    if failed == 0 && passed > 0 {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
