//! Turns `shared/arena.json` into Rust constants (`$OUT_DIR/arena_data.rs`) so the contract never parses JSON at
//! runtime. Set `ARENA_JSON` to another path when building somewhere that only sees `contracts/`.

use std::env;
use std::fmt::Write as _;
use std::fs;
use std::path::PathBuf;

use serde_json::Value;

fn ints(value: &Value) -> String {
    let list: Vec<String> = value.as_array().expect("an array").iter().map(|v| v.as_i64().expect("an integer").to_string()).collect();
    format!("[{}]", list.join(", "))
}

/// "allyLane" -> "AllyLane"; "self" is a keyword in Rust and becomes "Caster".
fn camel(name: &str) -> String {
    if name == "self" {
        return "Caster".into();
    }
    let mut out = String::new();
    let mut chars = name.chars();
    if let Some(first) = chars.next() {
        out.extend(first.to_uppercase());
    }
    out.extend(chars);
    out
}

fn main() {
    println!("cargo:rerun-if-env-changed=ARENA_JSON");
    let path = match env::var("ARENA_JSON") {
        Ok(path) => PathBuf::from(path),
        Err(_) => PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../../shared/arena.json"),
    };
    println!("cargo:rerun-if-changed={}", path.display());
    let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    let data: Value = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{} is not valid JSON: {e}", path.display()));
    let c = &data["constants"];
    let mut code = String::new();
    for (name, key) in [
        ("START_GOLD", "startGold"),
        ("START_POINTS", "startPoints"),
        ("BASE_INCOME", "baseIncome"),
        ("INTEREST_PER", "interestPer"),
        ("INTEREST_MAX", "interestMax"),
        ("WIN_BONUS", "winBonus"),
        ("MARKET_SIZE", "marketSize"),
        ("BENCH_SIZE", "benchSize"),
        ("MAX_TICKS", "maxTicks"),
        ("MIN_COOLDOWN", "minCooldown"),
        ("MAX_RANK", "maxRank"),
        ("COLS", "cols"),
        ("ROWS", "rows"),
        ("MELEE_RANGE", "meleeRange"),
        ("RANGED_RANGE", "rangedRange"),
        ("OVERTIME", "overtime"),
    ] {
        writeln!(code, "pub const {name}: i32 = {};", c[key].as_i64().unwrap_or_else(|| panic!("constants.{key}"))).unwrap();
    }
    writeln!(code, "pub const RANK_PERCENT: [i32; 3] = {};", ints(&c["rankPercent"])).unwrap();
    writeln!(code, "pub const TEAM_CAP: [i32; 7] = {};", ints(&c["teamCap"])).unwrap();
    let weights: Vec<String> = c["tierWeights"].as_array().unwrap().iter().map(ints).collect();
    writeln!(code, "pub const TIER_WEIGHTS: [[i32; 4]; 7] = [{}];", weights.join(", ")).unwrap();
    for (name, key) in [("GUILD", "guilds"), ("ROLE", "roles")] {
        let traits = data[key].as_array().unwrap();
        let at: Vec<String> = traits.iter().map(|t| ints(&t["at"])).collect();
        let bonus: Vec<String> = traits.iter().map(|t| ints(&t["bonus"])).collect();
        writeln!(code, "pub const {name}_AT: [[i32; 2]; 4] = [{}];", at.join(", ")).unwrap();
        writeln!(code, "pub const {name}_BONUS: [[i32; 2]; 4] = [{}];", bonus.join(", ")).unwrap();
    }
    let units = data["units"].as_array().unwrap();
    writeln!(code, "pub const UNITS: [UnitDef; {}] = [", units.len()).unwrap();
    for unit in units {
        let n = |key: &str| unit[key].as_i64().unwrap_or_else(|| panic!("unit.{key}"));
        let b = |key: &str| unit[key].as_bool().unwrap_or_else(|| panic!("unit.{key}"));
        let ability = &unit["ability"];
        writeln!(
            code,
            "    UnitDef {{ id: {:?}, guild: {}, role: {}, cost: {}, hp: {}, atk: {}, armor: {}, cd: {}, ranged: {}, dive: {}, every: {}, op: Op::{}, who: Who::{}, amount: {} }},",
            unit["id"].as_str().unwrap(),
            n("guild"),
            n("role"),
            n("cost"),
            n("hp"),
            n("atk"),
            n("armor"),
            n("cd"),
            b("ranged"),
            b("dive"),
            n("every"),
            camel(ability["op"].as_str().unwrap()),
            camel(ability["who"].as_str().unwrap()),
            ability["amount"].as_i64().unwrap(),
        )
        .unwrap();
    }
    writeln!(code, "];").unwrap();
    fs::write(PathBuf::from(env::var("OUT_DIR").unwrap()).join("arena_data.rs"), code).unwrap();
}
