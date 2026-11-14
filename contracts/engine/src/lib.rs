//! Deedlords game rules, ported from the TypeScript engine (`games/co-ty-phu/engine.ts`) to run inside a NEAR
//! contract. The contract between the two engines is `docs/ENGINE-RULES.md`: for the same players, actions and random
//! values both produce the same snapshot after every step, which `cargo run --release --bin replay -- <traces>` checks.
//!
//! Deterministic and integer-only: money is `i64`, maps are `BTreeMap`, there are no floats, and every random value
//! comes from the caller's [`Rng`] in the order ENGINE-RULES §2 fixes.
//!
//! ```
//! use deedlords_engine::{Action, Game, Rng, Rules};
//!
//! struct Fixed;
//! impl Rng for Fixed {
//!     fn die(&mut self) -> u8 { 3 }
//!     fn below(&mut self, _n: u32) -> u32 { 0 }
//! }
//!
//! let mut game = Game::new(Rules::default(), vec!["alice".into(), "bob".into()]);
//! game.apply(None, Action::Start, &mut Fixed).unwrap();
//! let first = game.current_player().unwrap().to_string();
//! game.apply(Some(&first), Action::Roll, &mut Fixed).unwrap(); // 3 + 3: doubles, lands on square 6
//! assert!(game.legal_actions(&first).contains(&Action::Buy));
//! assert_eq!(game.snapshot()["players"][0]["position"], if first == "alice" { 6 } else { 0 });
//! ```
//!
//! Public API:
//! - [`Rng`]: `die()` (1..=6) and `below(n)` (0..n), the only randomness.
//! - [`Rules`]: salary, starting cash, Blitz, round limit. [`Extras`]: the opt-in rules of ENGINE-RULES §10 (tickets,
//!   the leader's rent), set with [`Game::with_extras`]; off by default.
//! - [`Game::new`] (lobby), [`Game::apply`] (`Err` leaves the state and the Rng untouched), [`Game::check`],
//!   [`Game::snapshot`] (ENGINE-RULES §8 JSON), [`Game::net_worth`], [`Game::current_player`],
//!   [`Game::legal_actions`] (exact), [`Game::rent_for`].
//! - [`board`]: squares and cards generated from `shared/board.json`, plus the formulas of ENGINE-RULES §6.

#![forbid(unsafe_code)]
#![cfg_attr(not(test), deny(clippy::float_arithmetic))]

pub mod board;
mod game;

pub use game::{
    Action, CardRef, EngineError, Event, Extras, Game, GameResult, Owned, Payee, Phase, Player, Reason, Release, RentMod, Rng, Rules, Stage,
    Ticket, Tickets, BLITZ_DEAL, HOTEL, MAX_LOG, MAX_SEATS, MAX_TICKETS, MIN_PLAYERS,
};

#[cfg(test)]
mod tests;
