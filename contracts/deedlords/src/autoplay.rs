//! Deterministic play on top of the engine: the per-action event capture used by every contract method, the agent
//! `turn` driver and the debt liquidation shared by `turn` and `timeout`.
//!
//! Everything here is a pure function of the game state, the plan and the Rng output, so the same inputs always produce
//! the same actions. Nothing here touches the NEAR environment.

use deedlords_engine::board::{self, OWNABLE};
use deedlords_engine::{Action, EngineError, Event, Game, Phase, Rng, Stage, MAX_LOG};
use near_sdk::serde::{Deserialize, Serialize};

/// One applied action and the engine events it produced, in order. Emitted in the contract's event logs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Step {
    pub action: Action,
    pub events: Vec<Event>,
}

/// The agent plan of `turn(id, seat, plan)`. Every field is optional in JSON (defaults: buy when affordable, build
/// nothing, keep no reserve, do not pay bail, liquidate in board order).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(crate = "near_sdk::serde", default)]
pub struct Plan {
    /// Buy the square landed on only if `cash - price >= buy_reserve`.
    pub buy_reserve: i64,
    /// Cities to build one house on, tried in this order after each landing; illegal ones are skipped.
    pub build: Vec<u8>,
    /// Skip a build if `cash - house_cost < keep_reserve`.
    pub keep_reserve: i64,
    /// In jail at the start of a roll: use a leave-jail card if held, else pay the bail if affordable.
    pub bail: bool,
    /// Squares to sell houses from / mortgage first when in debt (see [`liquidation_step`]).
    pub liquidate: Vec<u8>,
}

/// Longest `build` / `liquidate` list accepted (bounds the gas of a plan).
pub const MAX_PLAN_LIST: usize = 40;
/// Safety bound on the driver loop. A turn needs far fewer steps (at most 3 rolls, each followed by a few actions).
const MAX_DRIVER_STEPS: usize = 64;

/// Applies one action and records it with exactly the events it produced.
///
/// The engine keeps only the last [`MAX_LOG`] events, so the new events of one action cannot always be recovered by
/// comparing logs (identical events can repeat). Instead the log is set aside, the action runs on an empty log, and
/// the old log is put back followed by the new events, trimmed to the last [`MAX_LOG`] exactly as the engine's own
/// `note` does. The resulting `game.log` is identical to what `apply` alone would leave (the engine never reads its
/// log; `start` clears it, and the log is always empty in the lobby).
pub fn apply_logged<R: Rng + ?Sized>(
    game: &mut Game,
    actor: Option<&str>,
    action: Action,
    rng: &mut R,
    steps: &mut Vec<Step>,
) -> Result<(), EngineError> {
    let old = std::mem::take(&mut game.log);
    let result = game.apply(actor, action, rng);
    let new = std::mem::replace(&mut game.log, old);
    if result.is_ok() {
        if action == Action::Start {
            game.log.clear();
        }
        game.log.extend(new.iter().cloned());
        let extra = game.log.len().saturating_sub(MAX_LOG);
        game.log.drain(..extra);
        steps.push(Step { action, events: new });
    }
    result
}

fn cash_of(game: &Game, seat: &str) -> i64 {
    game.player(seat).map_or(0, |p| p.cash)
}

fn is_current(game: &Game, seat: &str) -> bool {
    game.phase == Phase::Playing && game.current_player() == Some(seat)
}

fn owed(game: &Game) -> i64 {
    game.debt.as_deref().map_or(0, |debt| debt.iter().map(|payee| payee.amount).sum())
}

/// Cash the seat could still raise: half the house cost per house plus half the price of every unmortgaged square.
pub fn raisable(game: &Game, seat: &str) -> i64 {
    game.props
        .iter()
        .filter(|(_, owned)| owned.owner == seat)
        .map(|(&index, owned)| {
            let houses = i64::from(owned.houses) * board::house_cost(index) / 2;
            let mortgage = if owned.mortgaged { 0 } else { board::price(index).unwrap_or(0) / 2 };
            houses + mortgage
        })
        .sum()
}

/// The fixed liquidation order: the plan's `liquidate` list (first occurrence of each index), then every other
/// ownable square in ascending board index.
fn liquidation_order(liquidate: &[u8]) -> Vec<u8> {
    let mut order: Vec<u8> = Vec::with_capacity(liquidate.len() + OWNABLE.len());
    for &index in liquidate.iter().chain(OWNABLE.iter()) {
        if !order.contains(&index) {
            order.push(index);
        }
    }
    order
}

/// The next money-raising action for `seat`, or `None` when nothing is left to sell or mortgage:
/// 1. sell one house from the first square in the liquidation order that has one (so a square is emptied before the
///    next one is touched);
/// 2. otherwise mortgage the first square in the liquidation order that the engine allows to be mortgaged.
pub fn liquidation_step(game: &Game, seat: &str, liquidate: &[u8]) -> Option<Action> {
    let order = liquidation_order(liquidate);
    let sell = order.iter().map(|&i| Action::Sell(i)).find(|&a| game.check(Some(seat), a).is_ok());
    sell.or_else(|| order.iter().map(|&i| Action::Mortgage(i)).find(|&a| game.check(Some(seat), a).is_ok()))
}

/// Resolves the debt of the current player `seat` (stage `debt`), deterministically:
///
/// ```text
/// while the game is playing, seat is the current player and the stage is debt:
///     if cash >= debt:                        Pay   (paying may finish a pending jail move, which can land on a
///                                                    new debt; the loop then continues)
///     else if cash + raisable(seat) < debt:   Bankrupt   (selling everything would not be enough)
///     else:                                   liquidation_step(seat, liquidate)   (one house sale or one mortgage)
/// ```
pub fn resolve_debt<R: Rng + ?Sized>(
    game: &mut Game,
    seat: &str,
    liquidate: &[u8],
    rng: &mut R,
    steps: &mut Vec<Step>,
) -> Result<(), EngineError> {
    while is_current(game, seat) && game.stage == Stage::Debt {
        let debt = owed(game);
        let cash = cash_of(game, seat);
        let action = if cash >= debt {
            Action::Pay
        } else if cash.saturating_add(raisable(game, seat)) < debt {
            Action::Bankrupt
        } else {
            // raisable > 0 guarantees a step exists; fall back to bankruptcy defensively.
            liquidation_step(game, seat, liquidate).unwrap_or(Action::Bankrupt)
        };
        apply_logged(game, Some(seat), action, rng, steps)?;
    }
    Ok(())
}

/// One house per city of `plan.build`, in order, where the engine allows it and `cash - house_cost >= keep_reserve`.
fn build_pass<R: Rng + ?Sized>(game: &mut Game, seat: &str, plan: &Plan, rng: &mut R, steps: &mut Vec<Step>) -> Result<(), EngineError> {
    for &index in &plan.build {
        let action = Action::Build(index);
        if game.check(Some(seat), action).is_ok() && cash_of(game, seat) - board::house_cost(index) >= plan.keep_reserve {
            apply_logged(game, Some(seat), action, rng, steps)?;
        }
    }
    Ok(())
}

/// Plays the rest of `seat`'s turn with `plan`, deterministically. `seat` must be the current player.
///
/// ```text
/// loop while the game is playing and seat is the current player:
///   stage roll:  if in jail and plan.bail: use a leave-jail card if held, else pay bail if affordable.
///                Roll.
///   stage debt:  resolve_debt(plan.liquidate).
///   stage buy:   Buy if cash - price >= plan.buy_reserve (and affordable), else Skip.
///   stage end:   once per roll (the first time stage end is seen after each roll): build pass over plan.build.
///                Then Roll again if doubles granted another roll, else End (the turn passes; stop).
/// ```
///
/// A third doubles sends the player to jail with no further roll; bankruptcy or the round limit can end the turn or the
/// game early; the loop stops as soon as `seat` is no longer the current player.
pub fn play_turn<R: Rng + ?Sized>(game: &mut Game, seat: &str, plan: &Plan, rng: &mut R, steps: &mut Vec<Step>) -> Result<(), EngineError> {
    let mut built_after_roll: Option<u32> = None;
    for _ in 0..MAX_DRIVER_STEPS {
        if !is_current(game, seat) {
            break;
        }
        match game.stage {
            Stage::Roll => {
                let jailed = game.player(seat).is_some_and(|p| p.jail.is_some());
                if jailed && plan.bail {
                    if game.check(Some(seat), Action::Card).is_ok() {
                        apply_logged(game, Some(seat), Action::Card, rng, steps)?;
                    } else if game.check(Some(seat), Action::Bail).is_ok() {
                        apply_logged(game, Some(seat), Action::Bail, rng, steps)?;
                    }
                }
                apply_logged(game, Some(seat), Action::Roll, rng, steps)?;
            }
            Stage::Debt => resolve_debt(game, seat, &plan.liquidate, rng, steps)?,
            Stage::Buy => {
                let position = game.player(seat).map_or(0, |p| p.position);
                let price = board::price(position).unwrap_or(i64::MAX);
                let wants = cash_of(game, seat).saturating_sub(price) >= plan.buy_reserve;
                let action = if wants && game.check(Some(seat), Action::Buy).is_ok() { Action::Buy } else { Action::Skip };
                apply_logged(game, Some(seat), action, rng, steps)?;
            }
            Stage::End => {
                if built_after_roll != Some(game.rolls) {
                    built_after_roll = Some(game.rolls);
                    build_pass(game, seat, plan, rng, steps)?;
                    continue;
                }
                if game.again {
                    apply_logged(game, Some(seat), Action::Roll, rng, steps)?;
                } else {
                    apply_logged(game, Some(seat), Action::End, rng, steps)?;
                    break;
                }
            }
        }
    }
    Ok(())
}

/// One timeout step for the current player: `Auto` (roll, skip buying, or end the turn), or, in debt (where the engine
/// refuses `Auto`), [`resolve_debt`] with the default liquidation order.
pub fn timeout_step<R: Rng + ?Sized>(game: &mut Game, rng: &mut R, steps: &mut Vec<Step>) -> Result<(), EngineError> {
    let current = game.current_player().ok_or(EngineError::NotPlaying)?.to_string();
    if game.stage == Stage::Debt {
        resolve_debt(game, &current, &[], rng, steps)
    } else {
        apply_logged(game, None, Action::Auto, rng, steps)
    }
}
