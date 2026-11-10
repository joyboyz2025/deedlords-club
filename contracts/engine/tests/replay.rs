//! Runs the `replay` binary: the hand-written fixtures must pass, and tampered copies must fail with a precise report.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");

fn run(paths: &[&Path]) -> (bool, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_replay")).args(paths).output().expect("run replay");
    (output.status.success(), String::from_utf8_lossy(&output.stdout).into_owned())
}

fn fixture(name: &str) -> Value {
    let text = std::fs::read_to_string(Path::new(FIXTURES).join(name)).unwrap();
    serde_json::from_str(&text).unwrap()
}

#[test]
fn the_fixtures_replay_cleanly() {
    let (ok, out) = run(&[Path::new(FIXTURES)]);
    assert!(ok, "{out}");
    assert!(out.ends_with("REPLAY: 4 ok, 0 failed\n"), "{out}");
}

#[test]
fn every_kind_of_divergence_is_reported_at_its_step() {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("bad-traces");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let write = |name: &str, trace: &Value| std::fs::write(dir.join(name), serde_json::to_string_pretty(trace).unwrap()).unwrap();

    // (c) a state value differs.
    let mut trace = fixture("01-classic-basic.json");
    trace["steps"][3]["state"]["players"][1]["cash"] = json!(1441);
    trace["steps"][3]["state"]["round"] = json!(7);
    write("a-state.json", &trace);

    // (a) fewer Rng calls recorded than Rust asks for.
    let mut trace = fixture("01-classic-basic.json");
    trace["steps"][5]["rng"].as_array_mut().unwrap().pop();
    write("b-rng-missing.json", &trace);

    // (a) a different kind of call.
    let mut trace = fixture("02-classic-rent-jail-max-rounds.json");
    trace["steps"][6]["rng"][0] = json!({ "kind": "below", "n": 6, "value": 2 });
    write("c-rng-kind.json", &trace);

    // (a) more Rng calls recorded than Rust makes.
    let mut trace = fixture("03-classic-debt-bankrupt.json");
    trace["steps"][1]["rng"].as_array_mut().unwrap().push(json!({ "kind": "die", "value": 6 }));
    write("d-rng-extra.json", &trace);

    // (b) ok differs.
    let mut trace = fixture("04-blitz-deal-build-max-rounds.json");
    trace["steps"][2]["ok"] = json!(true);
    write("e-ok.json", &trace);

    // (a) a different n.
    let mut trace = fixture("04-blitz-deal-build-max-rounds.json");
    trace["steps"][0]["rng"][1]["n"] = json!(27);
    write("f-rng-n.json", &trace);

    let (ok, out) = run(&[&dir]);
    assert!(!ok, "{out}");
    let expected = [
        "step 3 op=buy player=p1\n    state: 2 differing path(s)\n      players[1].cash: rust=1440 trace=1441\n      round: rust=0 trace=7",
        "step 5 op=roll player=p0\n    rng: rust asked below(14) as call #3 but the trace recorded only 2 call(s)",
        "step 6 op=auto player=null\n    rng: call #1: rust asked die(), trace has below(6)=2",
        "step 1 op=roll player=p0\n    rng: rust made 2 call(s), the trace recorded 3: [die()=1, die()=2, die()=6]",
        "step 2 op=build player=p1 index=3\n    ok: rust=false trace=true",
        "step 0 op=start player=null\n    rng: call #2: rust asked below(28), trace has below(27)=0",
    ];
    for text in expected {
        assert!(out.contains(text), "missing {text:?} in:\n{out}");
    }
    assert!(out.ends_with("REPLAY: 0 ok, 6 failed\n"), "{out}");
}
