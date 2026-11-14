//! The game state machine. A line-by-line port of `games/co-ty-phu/engine.ts` as amended by `docs/ENGINE-RULES.md`.

use std::collections::BTreeMap;
use std::fmt;

use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::board::{self, CardEffect, Deck, Nearest, Square, BOARD_SIZE, JAIL, JAIL_FINE, OWNABLE, SQUARES, STATION_RENTS, UTILITY_TIMES};

/// Fewest seated players needed to start.
pub const MIN_PLAYERS: usize = 2;
/// Players beyond the first six only watch (as in the TS lobby).
pub const MAX_SEATS: usize = 6;
/// Length of the structured event log kept for the UI.
pub const MAX_LOG: usize = 30;
/// Ownable squares dealt to each player at the start of a Blitz game.
pub const BLITZ_DEAL: usize = 5;
/// Houses on a square with a hotel.
pub const HOTEL: u8 = 5;
/// Tickets a player may hold (ENGINE-RULES §10.2).
pub const MAX_TICKETS: usize = 2;

/// The only source of randomness (ENGINE-RULES §2). The engine calls it only in `start`, `roll` (also via `auto`)
/// and when a card is drawn (which can also happen in `pay`, when a pending jail move lands on a card square).
///
/// The engine trusts the implementation: `die()` must return 1..=6 and `below(n)` must return 0..n. Out-of-range
/// values never panic, but `below` results are clamped, so the game would no longer match the TS engine.
pub trait Rng {
    /// An integer in `1..=6`.
    fn die(&mut self) -> u8;
    /// An integer in `0..n`, `n >= 1`.
    fn below(&mut self, n: u32) -> u32;
}

impl<R: Rng + ?Sized> Rng for &mut R {
    fn die(&mut self) -> u8 {
        (**self).die()
    }
    fn below(&mut self, n: u32) -> u32 {
        (**self).below(n)
    }
}

/// Options fixed when the game is created. Serialized as `{ salary, cash, blitz, maxRounds }` like the trace files.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rules {
    /// Paid by the bank each time a player passes Departure.
    pub salary: i64,
    /// Starting cash of each seated player.
    pub cash: i64,
    /// Blitz rules (ENGINE-RULES §5).
    pub blitz: bool,
    /// The game ends with reason `time` when `round` reaches this; 0 means no limit.
    pub max_rounds: u8,
}

impl Default for Rules {
    fn default() -> Self {
        Rules { salary: board::SALARY, cash: board::START_CASH, blitz: false, max_rounds: 0 }
    }
}

/// Rules a match may switch on when it is created (ENGINE-RULES §10). Both are off by default, and a game with both
/// off plays exactly as before they existed. They are kept outside [`Rules`], whose borsh layout is what deployed
/// contracts have stored.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Extras {
    /// Special tickets (ENGINE-RULES §10.2).
    pub tickets: bool,
    /// Whoever leads on net worth pays double rent (ENGINE-RULES §10.1).
    pub leader_rent: bool,
    /// Blitz builds only on the own city just stopped on, one house per stop, as in classic (ENGINE-RULES §10.5). Not in
    /// the borsh form of `Extras`, which is the layout stored before this rule existed: the contract stores it after.
    #[borsh(skip)]
    pub build_here: bool,
    /// Blitz builds one house a turn, on any own city of the player's choice (ENGINE-RULES §10.6). Goes before
    /// `build_here`. Not in the borsh form either.
    #[borsh(skip)]
    pub build_one: bool,
}

impl Extras {
    pub fn is_off(&self) -> bool {
        !self.tickets && !self.leader_rent && !self.build_here && !self.build_one
    }
}

/// A special ticket (ENGINE-RULES §10.2), in the order a draw picks them: `below(4)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
#[serde(rename_all = "lowercase")]
pub enum Ticket {
    /// The next rent owed this turn is not charged.
    Waiver,
    /// Choose the steps of a throw, 2 to 12.
    Steps,
    /// Buy the city stood on from its owner at double its price (no house on it).
    Takeover,
    /// Own cities charge double rent until the player's next turn starts.
    Festival,
}

impl Ticket {
    pub const ALL: [Ticket; 4] = [Ticket::Waiver, Ticket::Steps, Ticket::Takeover, Ticket::Festival];
}

/// The ticket state of a game with `extras.tickets` (the snapshot's `tickets`, ENGINE-RULES §10.2).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct Tickets {
    /// Tickets held by each seated player, oldest first; at most [`MAX_TICKETS`].
    pub held: BTreeMap<String, Vec<Ticket>>,
    /// The current player's Rent waiver is played and not used yet.
    pub waiver: bool,
    /// Players whose Festival is on, in the order they played it.
    pub festival: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Lobby,
    Playing,
    Ended,
}

/// `roll`: waiting for the dice. `buy`: standing on an unowned square. `debt`: owes more than their cash.
/// `end`: moved, waiting for the end of the turn (or another roll after doubles).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    Roll,
    Buy,
    Debt,
    End,
}

/// Why the game ended: one player left, or the round limit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
#[serde(rename_all = "lowercase")]
pub enum Reason {
    Last,
    Time,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
#[serde(rename_all = "camelCase")]
pub struct Player {
    pub id: String,
    pub cash: i64,
    pub position: u8,
    /// `None` when free; 0, 1, 2 = failed rolls so far in jail.
    pub jail: Option<u8>,
    /// "Leave jail" cards held, by deck, in the order received.
    pub free_cards: Vec<Deck>,
    pub bankrupt: bool,
    /// Elimination order (1 = first out).
    pub out_at: Option<u8>,
}

impl Player {
    fn new(id: String) -> Self {
        Player { id, cash: 0, position: 0, jail: None, free_cards: Vec::new(), bankrupt: false, out_at: None }
    }
}

/// An owned square. `houses` 5 is a hotel.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct Owned {
    pub owner: String,
    pub houses: u8,
    pub mortgaged: bool,
}

/// One creditor of a debt. `id: None` is the bank.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct Payee {
    pub id: Option<String>,
    pub amount: i64,
}

/// The card drawn this turn (shown until the next roll or turn).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct CardRef {
    pub deck: Deck,
    pub index: u8,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct GameResult {
    pub reason: Reason,
    /// Player ids, best first.
    pub ranking: Vec<String>,
}

/// How a player left jail.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
#[serde(rename_all = "lowercase")]
pub enum Release {
    Doubles,
    Bail,
    Card,
    /// Third failed roll: the fine is charged (possibly as a debt) and the player moves.
    Fine,
}

/// Structured log entry for the UI (the last [`MAX_LOG`] are kept). Not part of the snapshot.
/// Serialized with a `kind` tag, e.g. `{ "kind": "rent", "player": "p1", "owner": "p0", "square": 3, "amount": 5 }`.
/// New kinds go last: the logs of matches stored before a kind existed must still read. `Resign` (the player gave up
/// the game) is always followed by a `Bankrupt`: that is how a player leaves.
///
/// The last five belong to tickets and the leader's rent (ENGINE-RULES §10). `Drew`: a ticket was drawn, at the start or
/// passing Departure. `Played`: a ticket was played; `value` is the steps chosen (`Steps`), the square taken over
/// (`Takeover`), else 0. `Waived`: a rent of `amount` was not charged, the player's Rent waiver took it. `Taken`:
/// `player` bought `square` from `owner` for `amount` with a Takeover. `Raised`: the rent `player` owes on `square` is
/// raised (the owner's Festival is on, the player leads, or both); it comes right before the `Rent` or `Waived` it
/// explains.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Event {
    Start { first: String },
    Roll { player: String, dice: [u8; 2] },
    Salary { player: String, amount: i64 },
    Buy { player: String, square: u8, price: i64 },
    Skip { player: String, square: u8 },
    Rent { player: String, owner: String, square: u8, amount: i64 },
    Tax { player: String, square: u8, amount: i64 },
    Card { player: String, deck: Deck, index: u8 },
    Jailed { player: String },
    Released { player: String, by: Release },
    Build { player: String, square: u8, houses: u8 },
    Sell { player: String, square: u8 },
    Mortgage { player: String, square: u8, amount: i64 },
    Redeem { player: String, square: u8, amount: i64 },
    PaidDebt { player: String, amount: i64 },
    Bankrupt { player: String, creditor: Option<String> },
    Auto { player: String },
    End { reason: Reason },
    Resign { player: String },
    Drew { player: String, ticket: Ticket },
    Played { player: String, ticket: Ticket, value: u8 },
    Waived { player: String, owner: String, square: u8, amount: i64 },
    Taken { player: String, owner: String, square: u8, amount: i64 },
    Raised { player: String, square: u8, festival: bool, leader: bool },
}

/// Rent modifier from a "nearest" card.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RentMod {
    Normal,
    /// Nearest station: double rent.
    DoubleStation,
    /// Nearest utility: 10 times the dice.
    UtilityTen,
}

/// A player action (ENGINE-RULES §7). Square indexes are `u8`; an index off the board is simply illegal.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub enum Action {
    Start,
    Roll,
    Buy,
    Skip,
    End,
    Bail,
    /// Use a "leave jail" card.
    Card,
    /// Pay the pending debt.
    Pay,
    Bankrupt,
    Build(u8),
    Sell(u8),
    Mortgage(u8),
    Redeem(u8),
    /// Act for the current player after a timeout: roll, skip buying, or end the turn. Never acts in `debt`.
    Auto,
    /// Give up the game: any player still in it, at any time. The player goes bankrupt; see `resign`.
    Resign,
    /// Tickets (ENGINE-RULES §10.2), only in a game with `extras.tickets`. Play a Rent waiver before a throw.
    Waiver,
    /// Play "Pick your steps": move this many steps (2..=12) instead of rolling.
    Steps(u8),
    /// Play a Takeover on the city stood on.
    Takeover,
    /// Play a Festival before a throw.
    Festival,
}

impl Action {
    /// The op names used in trace files, in [`Action`] order.
    pub const OPS: [&'static str; 19] = [
        "start", "roll", "buy", "skip", "end", "bail", "card", "pay", "bankrupt", "build", "sell", "mortgage", "redeem", "auto", "resign",
        "waiver", "steps", "takeover", "festival",
    ];

    /// Trace op name.
    pub fn op(&self) -> &'static str {
        match self {
            Action::Start => "start",
            Action::Roll => "roll",
            Action::Buy => "buy",
            Action::Skip => "skip",
            Action::End => "end",
            Action::Bail => "bail",
            Action::Card => "card",
            Action::Pay => "pay",
            Action::Bankrupt => "bankrupt",
            Action::Build(_) => "build",
            Action::Sell(_) => "sell",
            Action::Mortgage(_) => "mortgage",
            Action::Redeem(_) => "redeem",
            Action::Auto => "auto",
            Action::Resign => "resign",
            Action::Waiver => "waiver",
            Action::Steps(_) => "steps",
            Action::Takeover => "takeover",
            Action::Festival => "festival",
        }
    }

    /// Square index of `build`/`sell`/`mortgage`/`redeem`; the steps of `steps`.
    pub fn index(&self) -> Option<u8> {
        match self {
            Action::Build(i) | Action::Sell(i) | Action::Mortgage(i) | Action::Redeem(i) | Action::Steps(i) => Some(*i),
            _ => None,
        }
    }

    /// Whether the op takes a square index.
    pub fn op_takes_index(op: &str) -> bool {
        matches!(op, "build" | "sell" | "mortgage" | "redeem" | "steps")
    }

    /// Parses a trace op. `None` for an unknown op, or an indexed op without an index.
    pub fn from_op(op: &str, index: Option<u8>) -> Option<Action> {
        Some(match op {
            "start" => Action::Start,
            "roll" => Action::Roll,
            "buy" => Action::Buy,
            "skip" => Action::Skip,
            "end" => Action::End,
            "bail" => Action::Bail,
            "card" => Action::Card,
            "pay" => Action::Pay,
            "bankrupt" => Action::Bankrupt,
            "build" => Action::Build(index?),
            "sell" => Action::Sell(index?),
            "mortgage" => Action::Mortgage(index?),
            "redeem" => Action::Redeem(index?),
            "auto" => Action::Auto,
            "resign" => Action::Resign,
            "waiver" => Action::Waiver,
            "steps" => Action::Steps(index?),
            "takeover" => Action::Takeover,
            "festival" => Action::Festival,
            _ => return None,
        })
    }
}

/// Why an action was refused. The state is unchanged whenever `apply` returns one of these.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EngineError {
    /// `start` after the game started.
    NotInLobby,
    /// `start` with fewer than [`MIN_PLAYERS`].
    NotEnoughPlayers,
    /// The game is not being played (lobby or ended).
    NotPlaying,
    /// The action needs the current player and the actor is someone else (or missing).
    NotYourTurn,
    /// The actor is not a player of this game.
    UnknownPlayer,
    /// The actor is bankrupt.
    Bankrupt,
    /// Not possible at this stage of the turn.
    WrongStage,
    NotEnoughCash,
    /// No "leave jail" card to use.
    NoFreeCard,
    /// The square does not exist or is the wrong kind for this action.
    BadSquare,
    /// The actor does not own the square.
    NotOwner,
    /// Any other rule (no houses to sell, already mortgaged, cannot build here now, ...).
    NotAllowed,
    /// The player does not hold that ticket.
    NoTicket,
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            EngineError::NotInLobby => "the game has already started",
            EngineError::NotEnoughPlayers => "not enough players to start",
            EngineError::NotPlaying => "the game is not being played",
            EngineError::NotYourTurn => "not your turn",
            EngineError::UnknownPlayer => "unknown player",
            EngineError::Bankrupt => "player is bankrupt",
            EngineError::WrongStage => "not possible at this stage of the turn",
            EngineError::NotEnoughCash => "not enough cash",
            EngineError::NoFreeCard => "no leave-jail card",
            EngineError::BadSquare => "wrong square for this action",
            EngineError::NotOwner => "you do not own this square",
            EngineError::NotAllowed => "not allowed",
            EngineError::NoTicket => "you do not hold that ticket",
        })
    }
}

impl std::error::Error for EngineError {}

fn ensure(condition: bool, error: EngineError) -> Result<(), EngineError> {
    if condition {
        Ok(())
    } else {
        Err(error)
    }
}

fn total(payees: &[Payee]) -> i64 {
    payees.iter().map(|payee| payee.amount).sum()
}

/// The whole game. Every field except `rules` and `log` is in the snapshot (ENGINE-RULES §8); the serde form uses the
/// same camelCase names as the TS `Game`, plus `rules` and `log`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
#[serde(rename_all = "camelCase")]
pub struct Game {
    pub rules: Rules,
    pub phase: Phase,
    /// Turn order (seated player ids).
    pub order: Vec<String>,
    /// Index into `order` of the current player.
    pub turn: u8,
    pub stage: Stage,
    pub dice: Option<[u8; 2]>,
    /// Doubles rolled in a row this turn.
    pub doubles: u8,
    /// Just rolled doubles: may roll again.
    pub again: bool,
    /// Completed rounds (incremented when the turn wraps around `order`).
    pub round: u32,
    /// Owned squares by index.
    pub props: BTreeMap<u8, Owned>,
    pub debt: Option<Vec<Payee>>,
    /// Steps still to move once the jail fine (3rd failed roll) is paid.
    pub pending_move: Option<u8>,
    pub card: Option<CardRef>,
    /// Classic rules: the own city the current player stopped on, where one house may be built.
    pub build_at: Option<u8>,
    /// Blitz rules: cities built on this turn (always empty in classic rules).
    pub built_this_turn: Vec<u8>,
    /// Money issued by the bank minus money returned. Always equals the sum of cash.
    pub minted: i64,
    pub rolls: u32,
    pub result: Option<GameResult>,
    /// In seating order.
    pub players: Vec<Player>,
    pub log: Vec<Event>,
    /// Opt-in rules (ENGINE-RULES §10). Not in the borsh form, which stays the one deployed contracts stored: whoever
    /// stores a game with borsh keeps `extras` and `tickets` beside it (the contract appends them to its match).
    #[borsh(skip)]
    #[serde(default, skip_serializing_if = "Extras::is_off")]
    pub extras: Extras,
    /// `Some` from `start` on in a game with `extras.tickets`.
    #[borsh(skip)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tickets: Option<Tickets>,
}

/// The snapshot view (ENGINE-RULES §8): the game without `rules` and `log`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot<'a> {
    phase: Phase,
    order: &'a [String],
    turn: u8,
    stage: Stage,
    dice: Option<[u8; 2]>,
    doubles: u8,
    again: bool,
    round: u32,
    props: &'a BTreeMap<u8, Owned>,
    debt: &'a Option<Vec<Payee>>,
    pending_move: Option<u8>,
    card: Option<CardRef>,
    build_at: Option<u8>,
    built_this_turn: &'a [u8],
    minted: i64,
    rolls: u32,
    result: &'a Option<GameResult>,
    players: &'a [Player],
    #[serde(skip_serializing_if = "Option::is_none")]
    tickets: Option<&'a Tickets>,
}

/// The actions taking a square index, for `legal_actions`.
const INDEXED: [fn(u8) -> Action; 4] = [Action::Build, Action::Sell, Action::Mortgage, Action::Redeem];

impl Game {
    /// A game in the lobby. Player ids must be unique; seating order is the order given.
    pub fn new(rules: Rules, players: Vec<String>) -> Self {
        Game {
            rules,
            phase: Phase::Lobby,
            order: Vec::new(),
            turn: 0,
            stage: Stage::Roll,
            dice: None,
            doubles: 0,
            again: false,
            round: 0,
            props: BTreeMap::new(),
            debt: None,
            pending_move: None,
            card: None,
            build_at: None,
            built_this_turn: Vec::new(),
            minted: 0,
            rolls: 0,
            result: None,
            players: players.into_iter().map(Player::new).collect(),
            log: Vec::new(),
            extras: Extras::default(),
            tickets: None,
        }
    }

    /// The same game with the opt-in rules of ENGINE-RULES §10 set. For a game still in the lobby.
    pub fn with_extras(mut self, extras: Extras) -> Self {
        self.extras = extras;
        self
    }

    // ----- Queries -------------------------------------------------------------------------------------------------

    /// The snapshot JSON of ENGINE-RULES §8.
    pub fn snapshot(&self) -> Value {
        let snapshot = Snapshot {
            phase: self.phase,
            order: &self.order,
            turn: self.turn,
            stage: self.stage,
            dice: self.dice,
            doubles: self.doubles,
            again: self.again,
            round: self.round,
            props: &self.props,
            debt: &self.debt,
            pending_move: self.pending_move,
            card: self.card,
            build_at: self.build_at,
            built_this_turn: &self.built_this_turn,
            minted: self.minted,
            rolls: self.rolls,
            result: &self.result,
            players: &self.players,
            tickets: self.tickets.as_ref(),
        };
        serde_json::to_value(snapshot).expect("the snapshot only holds strings, integers and integer map keys")
    }

    /// Id of the player whose turn it is (only while playing).
    pub fn current_player(&self) -> Option<&str> {
        self.current_index().map(|p| self.players[p].id.as_str())
    }

    pub fn player(&self, id: &str) -> Option<&Player> {
        self.players.iter().find(|p| p.id == id)
    }

    /// Non-bankrupt players in turn order.
    pub fn active_players(&self) -> Vec<&str> {
        self.order.iter().map(String::as_str).filter(|id| !self.is_bankrupt(id)).collect()
    }

    /// Cash + owned squares (half price if mortgaged) + houses (`houseCost`, or `floor(houseCost * 3 / 4)` in Blitz).
    /// 0 for a bankrupt or unknown player.
    pub fn net_worth(&self, id: &str) -> i64 {
        let Some(player) = self.player(id) else { return 0 };
        if player.bankrupt {
            return 0;
        }
        let mut sum = player.cash;
        for (&index, owned) in &self.props {
            if owned.owner != id {
                continue;
            }
            let Some(price) = board::price(index) else { continue };
            sum += if owned.mortgaged { price / 2 } else { price };
            let house = if self.rules.blitz { board::blitz_house_value(index) } else { board::house_cost(index) };
            sum += i64::from(owned.houses) * house;
        }
        sum
    }

    /// Rent due on square `index` for a roll totalling `dice_total` (0 when unowned or mortgaged).
    pub fn rent_for(&self, index: u8, dice_total: i64, modifier: RentMod) -> i64 {
        let Some(owned) = self.props.get(&index) else { return 0 };
        if owned.mortgaged {
            return 0;
        }
        match board::square(index) {
            Some(&Square::City { group, price }) => {
                let rents = board::city_rents(price);
                if owned.houses > 0 {
                    return rents[usize::from(owned.houses.min(HOTEL))];
                }
                if self.owns_group(&owned.owner, group) {
                    rents[0] * 2
                } else {
                    rents[0]
                }
            }
            Some(Square::Station { .. }) => {
                let count = self.count_owned(&owned.owner, Nearest::Station);
                let rent = STATION_RENTS[count.clamp(1, STATION_RENTS.len()) - 1];
                if modifier == RentMod::DoubleStation {
                    rent * 2
                } else {
                    rent
                }
            }
            Some(Square::Utility { .. }) => {
                let count = self.count_owned(&owned.owner, Nearest::Utility);
                let times = if modifier == RentMod::UtilityTen { 10 } else { UTILITY_TIMES[count.clamp(1, UTILITY_TIMES.len()) - 1] };
                dice_total * times
            }
            _ => 0,
        }
    }

    /// Whether `id` leads: its net worth is strictly above that of every other player still in the game.
    pub fn leads(&self, id: &str) -> bool {
        if self.is_bankrupt(id) {
            return false;
        }
        let mine = self.net_worth(id);
        let mut others = self.active_players().into_iter().filter(|other| *other != id).peekable();
        others.peek().is_some() && others.all(|other| self.net_worth(other) < mine)
    }

    /// What `payer` owes landing on `index` (ENGINE-RULES §10.3): [`Game::rent_for`], once more on a city whose owner's
    /// Festival is on, once more when the leader's rent is on and `payer` leads.
    pub fn rent_due(&self, payer: &str, index: u8, dice_total: i64, modifier: RentMod) -> i64 {
        let (festival, leader) = self.rent_raises(payer, index);
        self.rent_for(index, dice_total, modifier) * (1 + i64::from(festival) + i64::from(leader))
    }

    /// Why `payer` owes more than the base rent on `index`: (the owner's Festival is on and it is a city, the leader's
    /// rent is on and `payer` leads).
    pub fn rent_raises(&self, payer: &str, index: u8) -> (bool, bool) {
        let Some(owned) = self.props.get(&index) else { return (false, false) };
        let city = board::square(index).is_some_and(|square| square.is_city());
        let festival = city && self.tickets.as_ref().is_some_and(|tickets| tickets.festival.contains(&owned.owner));
        (festival, self.extras.leader_rent && self.leads(payer))
    }

    /// Tickets `id` holds, oldest first (empty without the ticket rules).
    pub fn tickets_of(&self, id: &str) -> &[Ticket] {
        self.tickets.as_ref().and_then(|tickets| tickets.held.get(id)).map_or(&[], Vec::as_slice)
    }

    /// Checks an action without applying it. `Ok` exactly when [`Game::apply`] would succeed.
    pub fn check(&self, actor: Option<&str>, action: Action) -> Result<(), EngineError> {
        self.validate(actor, action).map(|_| ())
    }

    /// Every action `actor` could apply right now (exact: `apply` succeeds for each one and fails for every other).
    /// Includes `Start` and `Auto` when they would succeed, since anyone may send those.
    pub fn legal_actions(&self, actor: &str) -> Vec<Action> {
        let mut actions = Vec::new();
        let simple = [
            Action::Start,
            Action::Roll,
            Action::Buy,
            Action::Skip,
            Action::End,
            Action::Bail,
            Action::Card,
            Action::Pay,
            Action::Bankrupt,
            Action::Resign,
            Action::Waiver,
            Action::Takeover,
            Action::Festival,
        ];
        for action in simple {
            if self.check(Some(actor), action).is_ok() {
                actions.push(action);
            }
        }
        if self.phase == Phase::Playing {
            for make in INDEXED {
                for &index in &OWNABLE {
                    let action = make(index);
                    if self.check(Some(actor), action).is_ok() {
                        actions.push(action);
                    }
                }
            }
            for steps in 2..=12 {
                if self.check(Some(actor), Action::Steps(steps)).is_ok() {
                    actions.push(Action::Steps(steps));
                }
            }
        }
        if self.check(Some(actor), Action::Auto).is_ok() {
            actions.push(Action::Auto);
        }
        actions
    }

    // ----- Applying actions ----------------------------------------------------------------------------------------

    /// Applies `action` for `actor`. `actor` is ignored for `Start` and `Auto`; every other action needs it.
    /// On `Err` nothing changed and the Rng was not called.
    pub fn apply<R: Rng + ?Sized>(&mut self, actor: Option<&str>, action: Action, rng: &mut R) -> Result<(), EngineError> {
        let p = self.validate(actor, action)?;
        match action {
            Action::Start => self.start(rng),
            Action::Auto => self.auto(p, rng),
            Action::Roll => self.roll(p, rng),
            Action::Buy => self.buy(p),
            Action::Skip => {
                let player = self.players[p].id.clone();
                let square = self.players[p].position;
                self.note(Event::Skip { player, square });
                self.stage = Stage::End;
            }
            Action::End => self.next_turn(),
            Action::Bail => {
                self.pay(Some(p), None, JAIL_FINE);
                self.players[p].jail = None;
                self.note(Event::Released { player: self.players[p].id.clone(), by: Release::Bail });
            }
            Action::Card => {
                self.players[p].free_cards.remove(0);
                self.players[p].jail = None;
                self.note(Event::Released { player: self.players[p].id.clone(), by: Release::Card });
            }
            Action::Pay => self.pay_debt(p, rng),
            Action::Bankrupt => self.declare_bankruptcy(p),
            Action::Resign => self.resign(p),
            Action::Build(index) => self.build(p, index),
            Action::Sell(index) => self.sell(p, index),
            Action::Mortgage(index) => self.mortgage(p, index),
            Action::Redeem(index) => self.redeem(p, index),
            Action::Waiver => {
                self.take_ticket(p, Ticket::Waiver, 0);
                if let Some(tickets) = self.tickets.as_mut() {
                    tickets.waiver = true;
                }
            }
            Action::Festival => {
                self.take_ticket(p, Ticket::Festival, 0);
                let id = self.players[p].id.clone();
                if let Some(tickets) = self.tickets.as_mut() {
                    tickets.festival.push(id);
                }
            }
            Action::Steps(steps) => self.steps(p, steps, rng),
            Action::Takeover => self.takeover(p),
        }
        Ok(())
    }

    /// Checks an action; returns the index of the acting player (the current player for `Auto`, 0 for `Start`).
    fn validate(&self, actor: Option<&str>, action: Action) -> Result<usize, EngineError> {
        use EngineError as E;
        match action {
            Action::Start => {
                ensure(self.phase == Phase::Lobby, E::NotInLobby)?;
                ensure(self.seated() >= MIN_PLAYERS, E::NotEnoughPlayers)?;
                Ok(0)
            }
            Action::Auto => {
                let p = self.current_index().ok_or(E::NotPlaying)?;
                ensure(self.stage != Stage::Debt, E::WrongStage)?;
                Ok(p)
            }
            Action::Roll => {
                let p = self.turn_of(actor)?;
                ensure(self.can_roll(), E::WrongStage)?;
                Ok(p)
            }
            Action::Buy => {
                let p = self.turn_of(actor)?;
                ensure(self.stage == Stage::Buy, E::WrongStage)?;
                let price = board::price(self.players[p].position).ok_or(E::BadSquare)?;
                ensure(self.players[p].cash >= price, E::NotEnoughCash)?;
                Ok(p)
            }
            Action::Skip => {
                let p = self.turn_of(actor)?;
                ensure(self.stage == Stage::Buy, E::WrongStage)?;
                Ok(p)
            }
            Action::End => {
                let p = self.turn_of(actor)?;
                ensure(self.stage == Stage::End && !self.again, E::WrongStage)?;
                Ok(p)
            }
            Action::Bail => {
                let p = self.turn_of(actor)?;
                ensure(self.stage == Stage::Roll && self.players[p].jail.is_some(), E::WrongStage)?;
                ensure(self.players[p].cash >= JAIL_FINE, E::NotEnoughCash)?;
                Ok(p)
            }
            Action::Card => {
                let p = self.turn_of(actor)?;
                ensure(self.stage == Stage::Roll && self.players[p].jail.is_some(), E::WrongStage)?;
                ensure(!self.players[p].free_cards.is_empty(), E::NoFreeCard)?;
                Ok(p)
            }
            Action::Pay => {
                let p = self.turn_of(actor)?;
                let debt = self.debt.as_deref().filter(|_| self.stage == Stage::Debt).ok_or(E::WrongStage)?;
                ensure(self.players[p].cash >= total(debt), E::NotEnoughCash)?;
                Ok(p)
            }
            Action::Bankrupt => {
                let p = self.turn_of(actor)?;
                ensure(self.stage == Stage::Debt && self.debt.is_some(), E::WrongStage)?;
                Ok(p)
            }
            Action::Resign => {
                ensure(self.phase == Phase::Playing, E::NotPlaying)?;
                let p = actor.and_then(|id| self.index_of(id)).ok_or(E::UnknownPlayer)?;
                ensure(!self.players[p].bankrupt, E::Bankrupt)?;
                Ok(p)
            }
            Action::Build(index) => {
                let (p, owned) = self.own_square(actor, index, true)?;
                ensure(self.current_index() == Some(p), E::NotYourTurn)?;
                ensure(self.stage != Stage::Debt, E::WrongStage)?;
                if self.rules.blitz && self.extras.build_one {
                    ensure(self.built_this_turn.is_empty(), E::NotAllowed)?;
                } else if self.rules.blitz && !self.extras.build_here {
                    ensure(!self.built_this_turn.contains(&index), E::NotAllowed)?;
                } else {
                    ensure(self.build_at == Some(index), E::NotAllowed)?;
                }
                ensure(!owned.mortgaged && owned.houses < HOTEL, E::NotAllowed)?;
                ensure(self.players[p].cash >= board::house_cost(index), E::NotEnoughCash)?;
                Ok(p)
            }
            Action::Sell(index) => {
                let (p, owned) = self.own_square(actor, index, true)?;
                ensure(owned.houses > 0, E::NotAllowed)?;
                Ok(p)
            }
            Action::Mortgage(index) => {
                let (p, owned) = self.own_square(actor, index, false)?;
                ensure(!owned.mortgaged && owned.houses == 0, E::NotAllowed)?;
                Ok(p)
            }
            Action::Redeem(index) => {
                let (p, owned) = self.own_square(actor, index, false)?;
                ensure(owned.mortgaged, E::NotAllowed)?;
                ensure(self.players[p].cash >= board::redeem_price(index), E::NotEnoughCash)?;
                Ok(p)
            }
            Action::Waiver | Action::Festival | Action::Steps(_) => {
                let p = self.turn_of(actor)?;
                let tickets = self.tickets.as_ref().ok_or(E::NotAllowed)?;
                ensure(self.can_roll(), E::WrongStage)?;
                let id = &self.players[p].id;
                match action {
                    Action::Waiver => {
                        ensure(self.tickets_of(id).contains(&Ticket::Waiver), E::NoTicket)?;
                        ensure(!tickets.waiver, E::NotAllowed)?;
                    }
                    Action::Festival => {
                        ensure(self.tickets_of(id).contains(&Ticket::Festival), E::NoTicket)?;
                        ensure(!tickets.festival.contains(id), E::NotAllowed)?;
                    }
                    Action::Steps(steps) => {
                        ensure(self.tickets_of(id).contains(&Ticket::Steps), E::NoTicket)?;
                        ensure(self.players[p].jail.is_none(), E::WrongStage)?;
                        ensure((2..=12).contains(&steps), E::NotAllowed)?;
                    }
                    _ => {}
                }
                Ok(p)
            }
            Action::Takeover => {
                let p = self.turn_of(actor)?;
                ensure(self.tickets.is_some(), E::NotAllowed)?;
                ensure(self.stage == Stage::End, E::WrongStage)?;
                let player = &self.players[p];
                ensure(self.tickets_of(&player.id).contains(&Ticket::Takeover), E::NoTicket)?;
                let Some(&Square::City { price, .. }) = board::square(player.position) else { return Err(E::BadSquare) };
                let owned = self.props.get(&player.position).ok_or(E::BadSquare)?;
                ensure(owned.owner != player.id && owned.houses == 0 && !owned.mortgaged, E::NotAllowed)?;
                ensure(player.cash >= 2 * price, E::NotEnoughCash)?;
                Ok(p)
            }
        }
    }

    // ----- Helpers -------------------------------------------------------------------------------------------------

    fn seated(&self) -> usize {
        self.players.len().min(MAX_SEATS)
    }

    fn index_of(&self, id: &str) -> Option<usize> {
        self.players.iter().position(|p| p.id == id)
    }

    fn is_bankrupt(&self, id: &str) -> bool {
        self.player(id).is_some_and(|p| p.bankrupt)
    }

    fn current_index(&self) -> Option<usize> {
        if self.phase != Phase::Playing {
            return None;
        }
        self.order.get(usize::from(self.turn)).and_then(|id| self.index_of(id))
    }

    fn can_roll(&self) -> bool {
        self.stage == Stage::Roll || (self.stage == Stage::End && self.again)
    }

    /// The current player's index, if `actor` is the current player.
    fn turn_of(&self, actor: Option<&str>) -> Result<usize, EngineError> {
        let p = self.current_index().ok_or(EngineError::NotPlaying)?;
        ensure(actor == Some(self.players[p].id.as_str()), EngineError::NotYourTurn)?;
        Ok(p)
    }

    /// `ownCity` / `ownProperty` of the TS engine: playing, the actor is a non-bankrupt player, the square is a city
    /// (or any ownable square) and the actor owns it.
    fn own_square(&self, actor: Option<&str>, index: u8, city_only: bool) -> Result<(usize, &Owned), EngineError> {
        ensure(self.phase == Phase::Playing, EngineError::NotPlaying)?;
        let p = actor.and_then(|id| self.index_of(id)).ok_or(EngineError::UnknownPlayer)?;
        ensure(!self.players[p].bankrupt, EngineError::Bankrupt)?;
        let square = board::square(index).ok_or(EngineError::BadSquare)?;
        ensure(if city_only { square.is_city() } else { square.is_ownable() }, EngineError::BadSquare)?;
        let owned = self.props.get(&index).filter(|o| o.owner == self.players[p].id).ok_or(EngineError::NotOwner)?;
        Ok((p, owned))
    }

    fn owns_group(&self, owner: &str, group: u8) -> bool {
        board::group_squares(group).iter().all(|i| self.props.get(i).is_some_and(|o| o.owner == owner))
    }

    fn count_owned(&self, owner: &str, kind: Nearest) -> usize {
        self.props
            .iter()
            .filter(|(&i, o)| {
                o.owner == owner
                    && matches!(
                        (kind, board::square(i)),
                        (Nearest::Station, Some(Square::Station { .. })) | (Nearest::Utility, Some(Square::Utility { .. }))
                    )
            })
            .count()
    }

    fn dice_total(&self) -> i64 {
        self.dice.map_or(0, |[a, b]| i64::from(a) + i64::from(b))
    }

    fn note(&mut self, event: Event) {
        self.log.push(event);
        if self.log.len() > MAX_LOG {
            self.log.remove(0);
        }
    }

    /// Moves money. `None` is the bank, so the sum of cash always equals `minted`.
    fn pay(&mut self, from: Option<usize>, to: Option<usize>, amount: i64) {
        match from {
            Some(p) => self.players[p].cash -= amount,
            None => self.minted += amount,
        }
        match to {
            Some(p) => self.players[p].cash += amount,
            None => self.minted -= amount,
        }
    }

    /// Pays now if the player has the cash; otherwise the payees become the debt and the stage `debt`.
    fn charge(&mut self, p: usize, payees: Vec<Payee>) -> bool {
        if self.players[p].cash < total(&payees) {
            self.debt = Some(payees);
            self.stage = Stage::Debt;
            return false;
        }
        for payee in &payees {
            let to = payee.id.as_deref().and_then(|id| self.index_of(id));
            self.pay(Some(p), to, payee.amount);
        }
        true
    }

    /// Fisher–Yates of ENGINE-RULES §2: `for i = len-1 down to 1: j = below(i+1); swap(i, j)`.
    fn shuffle<T, R: Rng + ?Sized>(items: &mut [T], rng: &mut R) {
        for i in (1..items.len()).rev() {
            let j = rng.below(i as u32 + 1) as usize;
            items.swap(i, j.min(i));
        }
    }

    // ----- Start ---------------------------------------------------------------------------------------------------

    fn start<R: Rng + ?Sized>(&mut self, rng: &mut R) {
        let seated = self.seated();
        let cash = self.rules.cash;
        for (i, player) in self.players.iter_mut().enumerate() {
            *player = Player::new(std::mem::take(&mut player.id));
            if i < seated {
                player.cash = cash;
            }
        }
        let mut order: Vec<String> = self.players[..seated].iter().map(|p| p.id.clone()).collect();
        Self::shuffle(&mut order, rng);
        self.phase = Phase::Playing;
        self.order = order;
        self.turn = 0;
        self.stage = Stage::Roll;
        self.dice = None;
        self.doubles = 0;
        self.again = false;
        self.round = 0;
        self.props.clear();
        self.debt = None;
        self.pending_move = None;
        self.card = None;
        self.build_at = None;
        self.built_this_turn.clear();
        self.minted = cash * seated as i64;
        self.rolls = 0;
        self.result = None;
        self.log.clear();
        self.note(Event::Start { first: self.order[0].clone() });
        if self.rules.blitz {
            self.deal(rng);
        }
        // Tickets (ENGINE-RULES §10.2): one each, in turn order, after the deal.
        self.tickets = None;
        if self.extras.tickets {
            let held = self.players[..seated].iter().map(|p| (p.id.clone(), Vec::new())).collect();
            self.tickets = Some(Tickets { held, waiver: false, festival: Vec::new() });
            for k in 0..self.order.len() {
                if let Some(p) = self.index_of(&self.order[k]) {
                    self.draw_ticket(p, rng);
                }
            }
        }
    }

    /// One more ticket for the player, `below(4)`, unless they hold [`MAX_TICKETS`] (then nothing is drawn).
    fn draw_ticket<R: Rng + ?Sized>(&mut self, p: usize, rng: &mut R) {
        let id = self.players[p].id.clone();
        let Some(tickets) = self.tickets.as_mut() else { return };
        let held = tickets.held.entry(id.clone()).or_default();
        if held.len() >= MAX_TICKETS {
            return;
        }
        let ticket = Ticket::ALL[(rng.below(Ticket::ALL.len() as u32) as usize).min(Ticket::ALL.len() - 1)];
        held.push(ticket);
        self.note(Event::Drew { player: id, ticket });
    }

    /// Removes the first `ticket` the player holds and logs that it was played.
    fn take_ticket(&mut self, p: usize, ticket: Ticket, value: u8) {
        let id = self.players[p].id.clone();
        if let Some(held) = self.tickets.as_mut().and_then(|tickets| tickets.held.get_mut(&id)) {
            if let Some(at) = held.iter().position(|&one| one == ticket) {
                held.remove(at);
            }
        }
        self.note(Event::Played { player: id, ticket, value });
    }

    /// "Pick your steps": a throw whose dice are chosen. No second throw for a double, and it does not count as one.
    fn steps<R: Rng + ?Sized>(&mut self, p: usize, steps: u8, rng: &mut R) {
        self.take_ticket(p, Ticket::Steps, steps);
        let a = (steps - 1).min(6);
        let dice = [a, steps - a];
        self.dice = Some(dice);
        self.rolls += 1;
        self.card = None;
        self.again = false;
        self.build_at = None;
        self.note(Event::Roll { player: self.players[p].id.clone(), dice });
        self.move_by(p, steps, rng);
    }

    /// Takeover: the city stood on changes hands for twice its price, paid to its owner.
    fn takeover(&mut self, p: usize) {
        let square = self.players[p].position;
        self.take_ticket(p, Ticket::Takeover, square);
        let amount = 2 * board::price(square).unwrap_or(0);
        let id = self.players[p].id.clone();
        let Some(owner) = self.props.get(&square).map(|owned| owned.owner.clone()) else { return };
        let to = self.index_of(&owner);
        self.pay(Some(p), to, amount);
        if let Some(owned) = self.props.get_mut(&square) {
            owned.owner = id.clone();
        }
        self.note(Event::Taken { player: id, owner, square, amount });
    }

    /// Blitz deal: shuffle the ownable squares, then `order[k]` buys entries `[5k, 5k+5)` at list price.
    fn deal<R: Rng + ?Sized>(&mut self, rng: &mut R) {
        let mut squares = OWNABLE;
        Self::shuffle(&mut squares, rng);
        for k in 0..self.order.len() {
            let owner = self.order[k].clone();
            let Some(p) = self.index_of(&owner) else { continue };
            for &index in squares.iter().skip(BLITZ_DEAL * k).take(BLITZ_DEAL) {
                let price = board::price(index).unwrap_or(0);
                self.pay(Some(p), None, price);
                self.props.insert(index, Owned { owner: owner.clone(), houses: 0, mortgaged: false });
            }
        }
    }

    // ----- Moving --------------------------------------------------------------------------------------------------

    fn roll<R: Rng + ?Sized>(&mut self, p: usize, rng: &mut R) {
        let a = rng.die();
        let b = rng.die();
        self.dice = Some([a, b]);
        self.rolls += 1;
        self.card = None;
        self.again = false;
        self.build_at = None;
        let id = self.players[p].id.clone();
        self.note(Event::Roll { player: id.clone(), dice: [a, b] });
        let double = a == b;
        let steps = a.saturating_add(b);

        if let Some(tries) = self.players[p].jail {
            if double {
                self.players[p].jail = None;
                self.note(Event::Released { player: id, by: Release::Doubles });
                return self.move_by(p, steps, rng);
            }
            let tries = tries.saturating_add(1);
            if tries < 3 {
                self.players[p].jail = Some(tries);
                self.stage = Stage::End;
                return;
            }
            // Third failed roll: pay the fine, then move.
            self.players[p].jail = None;
            self.note(Event::Released { player: id, by: Release::Fine });
            if !self.charge(p, vec![Payee { id: None, amount: JAIL_FINE }]) {
                self.pending_move = Some(steps);
                return;
            }
            return self.move_by(p, steps, rng);
        }

        if double {
            self.doubles += 1;
            if self.doubles == 3 {
                self.note(Event::Jailed { player: id });
                return self.send_to_jail(p);
            }
        }
        self.again = double;
        self.move_by(p, steps, rng);
    }

    fn move_by<R: Rng + ?Sized>(&mut self, p: usize, steps: u8, rng: &mut R) {
        let from = self.players[p].position;
        let to = ((u32::from(from) + u32::from(steps)) % u32::from(BOARD_SIZE)) as u8;
        if to < from {
            self.pass_start(p, rng);
        }
        self.players[p].position = to;
        self.land(p, RentMod::Normal, rng);
    }

    /// Straight to `to`, collecting the salary when passing Departure.
    fn move_to<R: Rng + ?Sized>(&mut self, p: usize, to: u8, rent: RentMod, rng: &mut R) {
        if to < self.players[p].position {
            self.pass_start(p, rng);
        }
        self.players[p].position = to;
        self.land(p, rent, rng);
    }

    fn pass_start<R: Rng + ?Sized>(&mut self, p: usize, rng: &mut R) {
        let amount = self.rules.salary;
        self.pay(None, Some(p), amount);
        self.note(Event::Salary { player: self.players[p].id.clone(), amount });
        self.draw_ticket(p, rng);
    }

    fn send_to_jail(&mut self, p: usize) {
        self.players[p].position = JAIL;
        self.players[p].jail = Some(0);
        self.again = false;
        self.stage = Stage::End;
    }

    fn land<R: Rng + ?Sized>(&mut self, p: usize, rent: RentMod, rng: &mut R) {
        let position = self.players[p].position;
        let square = SQUARES[usize::from(position) % SQUARES.len()];
        self.stage = Stage::End;
        match square {
            Square::City { .. } | Square::Station { .. } | Square::Utility { .. } => {
                let Some(owned) = self.props.get(&position) else {
                    self.stage = Stage::Buy;
                    return;
                };
                // Stopping on your own city (not the purchase itself) allows one more house there (classic rules).
                if owned.owner == self.players[p].id {
                    if square.is_city() && !owned.mortgaged {
                        self.build_at = Some(position);
                    }
                    return;
                }
                if owned.mortgaged {
                    return;
                }
                let owner = owned.owner.clone();
                let amount = self.rent_due(&self.players[p].id, position, self.dice_total(), rent);
                let (festival, leader) = self.rent_raises(&self.players[p].id, position);
                if festival || leader {
                    self.note(Event::Raised { player: self.players[p].id.clone(), square: position, festival, leader });
                }
                if let Some(tickets) = self.tickets.as_mut().filter(|tickets| tickets.waiver) {
                    tickets.waiver = false;
                    self.note(Event::Waived { player: self.players[p].id.clone(), owner, square: position, amount });
                    return;
                }
                self.note(Event::Rent { player: self.players[p].id.clone(), owner: owner.clone(), square: position, amount });
                self.charge(p, vec![Payee { id: Some(owner), amount }]);
            }
            Square::Tax { amount } => {
                self.note(Event::Tax { player: self.players[p].id.clone(), square: position, amount });
                self.charge(p, vec![Payee { id: None, amount }]);
            }
            Square::Card { deck } => self.draw_card(p, deck, rng),
            Square::Arrest => {
                self.note(Event::Jailed { player: self.players[p].id.clone() });
                self.send_to_jail(p);
            }
            Square::Start | Square::Jail | Square::Rest => {}
        }
    }

    /// Draws with replacement: `index = below(deck length)`.
    fn draw_card<R: Rng + ?Sized>(&mut self, p: usize, deck: Deck, rng: &mut R) {
        let cards = board::cards(deck);
        let index = (rng.below(cards.len() as u32) as usize).min(cards.len() - 1);
        self.card = Some(CardRef { deck, index: index as u8 });
        let id = self.players[p].id.clone();
        self.note(Event::Card { player: id.clone(), deck, index: index as u8 });
        match cards[index] {
            CardEffect::Free => self.players[p].free_cards.push(deck),
            CardEffect::Money { amount } => {
                if amount > 0 {
                    self.pay(None, Some(p), amount);
                } else {
                    self.charge(p, vec![Payee { id: None, amount: -amount }]);
                }
            }
            CardEffect::Goto { to } => self.move_to(p, to, RentMod::Normal, rng),
            CardEffect::Back { steps } => {
                let position = self.players[p].position;
                self.players[p].position = ((u32::from(position) + u32::from(BOARD_SIZE) - u32::from(steps)) % u32::from(BOARD_SIZE)) as u8;
                self.land(p, RentMod::Normal, rng);
            }
            CardEffect::Nearest { kind } => {
                let mut to = self.players[p].position;
                for _ in 0..BOARD_SIZE {
                    to = (to + 1) % BOARD_SIZE;
                    let found = matches!(
                        (kind, SQUARES[usize::from(to)]),
                        (Nearest::Station, Square::Station { .. }) | (Nearest::Utility, Square::Utility { .. })
                    );
                    if found {
                        break;
                    }
                }
                let rent = match kind {
                    Nearest::Station => RentMod::DoubleStation,
                    Nearest::Utility => RentMod::UtilityTen,
                };
                self.move_to(p, to, rent, rng);
            }
            CardEffect::Jail => {
                self.note(Event::Jailed { player: id });
                self.send_to_jail(p);
            }
            CardEffect::Each { amount } => {
                let others: Vec<usize> =
                    self.active_players().into_iter().filter(|other| *other != id).filter_map(|other| self.index_of(other)).collect();
                if amount > 0 {
                    // Others pay out of turn, so only with the cash they have; it never becomes a debt.
                    for other in others {
                        let paid = self.players[other].cash.min(amount);
                        self.pay(Some(other), Some(p), paid);
                    }
                } else {
                    let payees =
                        others.into_iter().map(|other| Payee { id: Some(self.players[other].id.clone()), amount: -amount }).collect();
                    self.charge(p, payees);
                }
            }
            CardEffect::Repairs { house, hotel } => {
                let amount: i64 = self
                    .props
                    .values()
                    .filter(|o| o.owner == id)
                    .map(|o| if o.houses == HOTEL { hotel } else { i64::from(o.houses) * house })
                    .sum();
                if amount > 0 {
                    self.charge(p, vec![Payee { id: None, amount }]);
                }
            }
        }
    }

    // ----- Turn ----------------------------------------------------------------------------------------------------

    fn buy(&mut self, p: usize) {
        let square = self.players[p].position;
        let price = board::price(square).unwrap_or(0);
        self.pay(Some(p), None, price);
        let owner = self.players[p].id.clone();
        self.props.insert(square, Owned { owner: owner.clone(), houses: 0, mortgaged: false });
        self.note(Event::Buy { player: owner, square, price });
        self.stage = Stage::End;
    }

    fn auto<R: Rng + ?Sized>(&mut self, p: usize, rng: &mut R) {
        self.note(Event::Auto { player: self.players[p].id.clone() });
        if self.can_roll() {
            self.roll(p, rng);
        } else if self.stage == Stage::Buy {
            self.stage = Stage::End;
        } else if self.stage == Stage::End {
            self.next_turn();
        }
    }

    /// Next non-bankrupt player; a wrap-around completes a round, which may end the game (`maxRounds`).
    fn next_turn(&mut self) {
        let count = self.order.len();
        if count == 0 {
            return;
        }
        let turn = usize::from(self.turn);
        let mut next = turn;
        for _ in 0..count {
            next = (next + 1) % count;
            if !self.is_bankrupt(&self.order[next]) {
                break;
            }
        }
        if next <= turn {
            self.round += 1;
        }
        if self.rules.max_rounds > 0 && self.round >= u32::from(self.rules.max_rounds) {
            return self.finish(Reason::Time);
        }
        self.turn = next as u8;
        self.stage = Stage::Roll;
        self.doubles = 0;
        self.again = false;
        self.card = None;
        self.build_at = None;
        self.built_this_turn.clear();
        if let Some(tickets) = self.tickets.as_mut() {
            tickets.waiver = false;
            let starts = &self.order[next];
            tickets.festival.retain(|id| id != starts);
        }
    }

    // ----- Debt and bankruptcy -------------------------------------------------------------------------------------

    fn pay_debt<R: Rng + ?Sized>(&mut self, p: usize, rng: &mut R) {
        let debt = self.debt.take().unwrap_or_default();
        for payee in &debt {
            let to = payee.id.as_deref().and_then(|id| self.index_of(id));
            self.pay(Some(p), to, payee.amount);
        }
        self.note(Event::PaidDebt { player: self.players[p].id.clone(), amount: total(&debt) });
        self.stage = Stage::End;
        if let Some(steps) = self.pending_move.take() {
            self.move_by(p, steps, rng);
        }
    }

    /// Giving up (ENGINE-RULES §7, `resign`). The player leaves the way a bankrupt one does. In debt on their own turn
    /// the creditor is paid as in `declare_bankruptcy`, so giving up is never a way around a debt; at any other moment
    /// everything goes back to the bank. A debt the current player owes to somebody who gives up is owed to the bank.
    fn resign(&mut self, p: usize) {
        let id = self.players[p].id.clone();
        self.note(Event::Resign { player: id.clone() });
        if self.current_index() == Some(p) {
            if self.stage == Stage::Debt && self.debt.is_some() {
                return self.declare_bankruptcy(p);
            }
        } else if let Some(debt) = self.debt.as_mut() {
            for payee in debt.iter_mut().filter(|payee| payee.id.as_deref() == Some(id.as_str())) {
                payee.id = None;
            }
        }
        self.go_bankrupt(p, None);
    }

    fn declare_bankruptcy(&mut self, p: usize) {
        let debt = self.debt.as_deref().unwrap_or_default();
        let creditors: Vec<&Payee> = debt.iter().filter(|payee| payee.id.is_some()).collect();
        let creditor = if debt.len() == 1 && creditors.len() == 1 { creditors[0].id.clone() } else { None };
        self.go_bankrupt(p, creditor);
    }

    /// Sells all houses to the bank at half price, then gives cash, squares and leave-jail cards to the single player
    /// creditor; with the bank (or several creditors) as creditor the squares return to the bank unmortgaged.
    fn go_bankrupt(&mut self, p: usize, creditor: Option<String>) {
        let creditor = creditor.and_then(|id| self.index_of(&id));
        let id = self.players[p].id.clone();
        let owned: Vec<u8> = self.props.iter().filter(|(_, o)| o.owner == id).map(|(&i, _)| i).collect();
        for index in owned {
            let houses = self.props[&index].houses;
            if houses > 0 {
                self.pay(None, Some(p), i64::from(houses) * board::house_cost(index) / 2);
            }
            match creditor {
                Some(c) => {
                    let new_owner = self.players[c].id.clone();
                    if let Some(o) = self.props.get_mut(&index) {
                        o.owner = new_owner;
                        o.houses = 0;
                    }
                }
                None => {
                    self.props.remove(&index);
                }
            }
        }
        let cash = self.players[p].cash;
        self.pay(Some(p), creditor, cash);
        let cards = std::mem::take(&mut self.players[p].free_cards);
        if let Some(c) = creditor {
            self.players[c].free_cards.extend(cards);
        }
        if let Some(tickets) = self.tickets.as_mut() {
            if let Some(held) = tickets.held.get_mut(&id) {
                held.clear();
            }
            tickets.festival.retain(|one| *one != id);
        }
        let out = self.players.iter().filter(|player| player.out_at.is_some()).count();
        let player = &mut self.players[p];
        player.bankrupt = true;
        player.out_at = Some(u8::try_from(out + 1).unwrap_or(u8::MAX));
        player.jail = None;
        self.note(Event::Bankrupt { player: id, creditor: creditor.map(|c| self.players[c].id.clone()) });

        let was_current = self.current_index() == Some(p);
        if was_current {
            self.debt = None;
            self.pending_move = None;
        }
        if self.active_players().len() == 1 {
            return self.finish(Reason::Last);
        }
        if was_current {
            self.next_turn();
        }
    }

    // ----- Houses and mortgages ------------------------------------------------------------------------------------

    fn build(&mut self, p: usize, index: u8) {
        self.pay(Some(p), None, board::house_cost(index));
        let houses = match self.props.get_mut(&index) {
            Some(owned) => {
                owned.houses += 1;
                owned.houses
            }
            None => 0,
        };
        // One house per stop (classic). The TS engine clears it in both modes.
        self.build_at = None;
        if self.rules.blitz {
            self.built_this_turn.push(index);
        }
        self.note(Event::Build { player: self.players[p].id.clone(), square: index, houses });
    }

    fn sell(&mut self, p: usize, index: u8) {
        if let Some(owned) = self.props.get_mut(&index) {
            owned.houses -= 1;
        }
        self.pay(None, Some(p), board::house_cost(index) / 2);
        self.note(Event::Sell { player: self.players[p].id.clone(), square: index });
    }

    fn mortgage(&mut self, p: usize, index: u8) {
        if let Some(owned) = self.props.get_mut(&index) {
            owned.mortgaged = true;
        }
        let amount = board::price(index).unwrap_or(0) / 2;
        self.pay(None, Some(p), amount);
        self.note(Event::Mortgage { player: self.players[p].id.clone(), square: index, amount });
    }

    fn redeem(&mut self, p: usize, index: u8) {
        let amount = board::redeem_price(index);
        self.pay(Some(p), None, amount);
        if let Some(owned) = self.props.get_mut(&index) {
            owned.mortgaged = false;
        }
        self.note(Event::Redeem { player: self.players[p].id.clone(), square: index, amount });
    }

    // ----- End -----------------------------------------------------------------------------------------------------

    /// Standing players by net worth, descending, stable (ties keep turn order); then bankrupt players by `outAt` desc.
    /// Ends a game under way as it stands, ranked by net worth as when the rounds run out. For whoever keeps the game
    /// (the contract closes a table everybody has left); not an action of a player. Does nothing unless playing.
    pub fn close(&mut self) {
        if self.phase == Phase::Playing {
            self.finish(Reason::Time);
        }
    }

    fn finish(&mut self, reason: Reason) {
        let mut standing: Vec<(String, i64)> =
            self.order.iter().filter(|id| !self.is_bankrupt(id)).map(|id| (id.clone(), self.net_worth(id))).collect();
        standing.sort_by_key(|&(_, worth)| std::cmp::Reverse(worth)); // stable
        let mut out: Vec<(String, u8)> = self
            .order
            .iter()
            .filter_map(|id| self.player(id).filter(|p| p.bankrupt).map(|p| (id.clone(), p.out_at.unwrap_or(0))))
            .collect();
        out.sort_by_key(|&(_, out_at)| std::cmp::Reverse(out_at));
        let ranking = standing.into_iter().map(|(id, _)| id).chain(out.into_iter().map(|(id, _)| id)).collect();
        self.phase = Phase::Ended;
        self.debt = None;
        self.result = Some(GameResult { reason, ranking });
        self.note(Event::End { reason });
    }
}
