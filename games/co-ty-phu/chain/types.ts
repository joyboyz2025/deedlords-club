// What the Deedlords contract answers, as JSON. The shapes are pinned by tests/fixtures/chain-duel.json, which holds
// real answers of the contract on a local sandbox.

import type { Deck } from "../board.ts";
import type { Owned, Payee, Phase, Stage, Ticket, TicketState } from "../engine.ts";

export type ChainSeat = {
  seat: number;
  /** The engine's name for this seat: `s0`, `s1`… */
  player: string;
  /** The account that staked for the seat, `null` while the seat is free. */
  backer: string | null;
  /** An account the backer lets move for the seat (an agent, a session). */
  driver: string | null;
  house: boolean;
};

/** `tickets`, `leaderRent`, `buildHere`: the opt-in rules of ENGINE-RULES §10; the contract leaves them out of a match that has none. */
export type ChainRules = { salary: number; cash: number; blitz: boolean; maxRounds: number; tickets?: boolean; leaderRent?: boolean; buildHere?: boolean; buildOne?: boolean; buildOnBuy?: boolean };

export type ChainMeta = {
  id: string;
  status: "lobby" | "playing" | "ended" | "abandoned";
  seats: ChainSeat[];
  /** Stake per seat, in yoctoNEAR. */
  stake: string;
  /** Share per rank of the pot that is left after the fee, in basis points. */
  split: number[];
  /** The fee on this match's pot, in basis points (250 is 2.5%): the contract's fee when the match was opened. */
  fee_bps: number;
  rules: ChainRules;
  solo_player: string | null;
  creator: string;
  /** The account that starts the game once every seat is taken; `null`: it starts by itself. Only in the lobby. */
  host?: string | null;
  storage_deposit: string;
  /** Block times, in nanoseconds. */
  created_at: string;
  last_activity: string;
  turn_seconds: number;
  /** `"0"` in the lobby. */
  turn_deadline: string;
  /**
   * The seats that are away, when some are: a seat that let its whole clock run out without throwing. The contract
   * plays such a seat's turns after a few seconds instead of a whole clock, until it moves or says it is back.
   */
  away?: number[];
  draws: number;
  current_seat: number | null;
};

export type ChainPlayer = {
  id: string;
  cash: number;
  position: number;
  jail: number | null;
  freeCards: Deck[];
  bankrupt: boolean;
  outAt: number | null;
};

/** The engine's snapshot: the TS `Game` without the people, the settings and the log. */
export type ChainGame = {
  phase: Phase;
  order: string[];
  turn: number;
  stage: Stage;
  dice: [number, number] | null;
  doubles: number;
  again: boolean;
  round: number;
  props: Record<string, Owned>;
  debt: Payee[] | null;
  pendingMove: number | null;
  card: { deck: Deck; index: number } | null;
  buildAt: number | null;
  builtThisTurn: number[];
  minted: number;
  rolls: number;
  result: { reason: "last" | "time"; ranking: string[] } | null;
  players: ChainPlayer[];
  /** Only in a match with tickets. */
  tickets?: TicketState;
};

/** One entry of the contract's log (the last 30 are kept). */
export type ChainEvent =
  | { kind: "start"; first: string }
  | { kind: "roll"; player: string; dice: [number, number] }
  | { kind: "salary"; player: string; amount: number }
  | { kind: "buy"; player: string; square: number; price: number }
  | { kind: "skip"; player: string; square: number }
  | { kind: "rent"; player: string; owner: string; square: number; amount: number }
  | { kind: "tax"; player: string; square: number; amount: number }
  | { kind: "card"; player: string; deck: Deck; index: number }
  | { kind: "jailed"; player: string }
  | { kind: "released"; player: string; by: "doubles" | "bail" | "card" | "fine" }
  | { kind: "build"; player: string; square: number; houses: number }
  | { kind: "sell"; player: string; square: number }
  | { kind: "mortgage"; player: string; square: number; amount: number }
  | { kind: "redeem"; player: string; square: number; amount: number }
  | { kind: "paidDebt"; player: string; amount: number }
  | { kind: "bankrupt"; player: string; creditor: string | null }
  | { kind: "auto"; player: string }
  | { kind: "end"; reason: "last" | "time" }
  | { kind: "resign"; player: string }
  /** Tickets and the leader's rent (ENGINE-RULES §10). `value`: the steps chosen, or the square taken over. */
  | { kind: "drew"; player: string; ticket: Ticket }
  | { kind: "played"; player: string; ticket: Ticket; value: number }
  | { kind: "waived"; player: string; owner: string; square: number; amount: number }
  | { kind: "taken"; player: string; owner: string; square: number; amount: number }
  | { kind: "raised"; player: string; square: number; festival: boolean; leader: boolean };

/** `get_match`: `null` once the match is settled, abandoned or never existed. */
export type ChainMatch = { meta: ChainMeta; game: ChainGame; log: ChainEvent[] };

/** `list_matches`: the meta of each open match plus where its game stands. */
export type ChainListed = ChainMeta & { round: number; phase: Phase };

/** `get_result`: what is kept forever of a settled match. */
export type ChainResult = {
  id: string;
  stake: string;
  /** All the stakes, and what the contract kept of them as its fee (yoctoNEAR). */
  pot: string;
  fee: string;
  /** Backer of each seat, by seat. */
  seats: string[];
  /** Seat indexes, best first. */
  ranking: number[];
  /** Backer and payout (yoctoNEAR) of each rank, best first. */
  backers: string[];
  payouts: string[];
  /** Shares of house seats, kept by the contract. */
  forfeited: string;
  reason: "last" | "time";
  block_height: string;
  ended_at: string;
  /** Who was minted the Deed of this match. */
  deed: string | null;
};

/** An action as `play(id, seat, actions)` takes it. */
export type ContractAction =
  | "Roll"
  | "Buy"
  | "Skip"
  | "End"
  | "Bail"
  | "Card"
  | "Pay"
  | "Bankrupt"
  | "Resign"
  | "Waiver"
  | "Takeover"
  | "Festival"
  | { Steps: number }
  | { Build: number }
  | { Sell: number }
  | { Mortgage: number }
  | { Redeem: number };

/** What `play` returns. */
export type PlayOutcome = { applied: number; rejected: null | { index: number; action: ContractAction; error: string } };
