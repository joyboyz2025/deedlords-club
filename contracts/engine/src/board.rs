//! Board data and the integer formulas of ENGINE-RULES section 6.
//!
//! The data (squares, decks, constants) is generated at build time from `shared/board.json` by `build.rs`; the
//! formulas (house cost, city rents, redeem price) live here in code, as in the TypeScript `board.ts`.

use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};

/// A card deck. Serialized as `"chance"` / `"chest"`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
#[serde(rename_all = "lowercase")]
pub enum Deck {
    Chance,
    Chest,
}

/// One square of the board.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Square {
    Start,
    /// Customs Hold. Landing here is "just visiting".
    Jail,
    Rest,
    /// Visa Denied: go to jail.
    Arrest,
    City {
        group: u8,
        price: i64,
    },
    Station {
        price: i64,
    },
    Utility {
        price: i64,
    },
    Tax {
        amount: i64,
    },
    Card {
        deck: Deck,
    },
}

/// Target of a "nearest" card.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Nearest {
    Station,
    Utility,
}

/// What a card does when drawn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CardEffect {
    /// Positive: the bank pays the player. Negative: the player is charged.
    Money {
        amount: i64,
    },
    /// Move straight to `to`, collecting the salary when passing Departure.
    Goto {
        to: u8,
    },
    /// Move back without passing Departure.
    Back {
        steps: u8,
    },
    /// Move forward to the nearest square of that kind; station rent doubles, utility rent is 10x the dice.
    Nearest {
        kind: Nearest,
    },
    Jail,
    /// Keep a "leave jail" card.
    Free,
    /// Positive: every other active player pays the player (at most their cash). Negative: the player pays each.
    Each {
        amount: i64,
    },
    Repairs {
        house: i64,
        hotel: i64,
    },
}

include!(concat!(env!("OUT_DIR"), "/board_data.rs"));

/// Rent multipliers `m` of ENGINE-RULES §6: bare, 1–4 houses, hotel.
pub const RENT_MULTIPLIERS: [i64; 6] = [1, 5, 15, 30, 40, 50];

impl Square {
    /// Purchase price of an ownable square.
    pub const fn price(&self) -> Option<i64> {
        match self {
            Square::City { price, .. } | Square::Station { price } | Square::Utility { price } => Some(*price),
            _ => None,
        }
    }

    pub const fn is_ownable(&self) -> bool {
        self.price().is_some()
    }

    pub const fn is_city(&self) -> bool {
        matches!(self, Square::City { .. })
    }
}

/// The square at `index`, or `None` when off the board.
pub fn square(index: u8) -> Option<&'static Square> {
    SQUARES.get(usize::from(index))
}

/// Price of the ownable square at `index`.
pub fn price(index: u8) -> Option<i64> {
    square(index).and_then(Square::price)
}

/// The cards of a deck; a drawn card is `cards(deck)[below(len)]`.
pub fn cards(deck: Deck) -> &'static [CardEffect] {
    match deck {
        Deck::Chance => &CHANCE,
        Deck::Chest => &CHEST,
    }
}

/// City indexes of a colour group (empty for an unknown group).
pub fn group_squares(group: u8) -> &'static [u8] {
    GROUPS.get(usize::from(group)).copied().unwrap_or(&[])
}

/// `houseCost(index) = 50 * (floor(index / 10) + 1)`.
pub const fn house_cost(index: u8) -> i64 {
    50 * (index as i64 / 10 + 1)
}

/// Value of one house in the Blitz net worth: `floor(houseCost(index) * 3 / 4)`.
pub const fn blitz_house_value(index: u8) -> i64 {
    house_cost(index) * 3 / 4
}

/// `cityRents(price)[i] = floor((price * m_i + 25) / 50) * 5`. Index 0 is the bare rent, 1–4 houses, 5 a hotel.
pub fn city_rents(price: i64) -> [i64; 6] {
    RENT_MULTIPLIERS.map(|m| (price * m + 25).div_euclid(50) * 5)
}

/// Cost to lift a mortgage: `ceil(price * 11 / 20)`; 0 for squares that cannot be owned.
pub fn redeem_price(index: u8) -> i64 {
    match price(index) {
        Some(price) => (price * 11 + 19).div_euclid(20),
        None => 0,
    }
}
