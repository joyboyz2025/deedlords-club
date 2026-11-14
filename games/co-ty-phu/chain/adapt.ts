// Between the contract and the game screen. The contract keeps the engine's snapshot and who backs each seat; the
// screen wants the `Game` of the reference engine (names, colours, a readable log). This file builds one from the
// other, maps the screen's messages to contract actions, and applies the actions that need no dice with the reference
// engine, which replays the Rust engine step for step (tools/diff), so a move shows at once instead of after a block.

import { characterOf } from "../../chibi/known.ts";
import { lookFromSeat, roomLook } from "../../ma-soi/look.ts";
import { BOARD_SIZE, CARDS, DECK_NAMES, JAIL, JAIL_FINE, SQUARES } from "../board.ts";
import {
  build,
  buy,
  currentPlayer,
  declareBankruptcy,
  endTurn,
  mortgage,
  newPlayer,
  payBail,
  payDebt,
  canPlay,
  playFestival,
  playWaiver,
  raiseLine,
  takeover,
  TICKET_NAMES,
  redeem,
  resign,
  sellHouse,
  skipBuying,
  useFreeCard,
  type Game,
  type Player,
  type Rng,
} from "../engine.ts";
import type { ClientMessage } from "../protocol.ts";
import { viewFor, type View } from "../view.ts";
import type { ChainEvent, ChainMatch, ChainMeta, ChainResult, ContractAction } from "./types.ts";

/** The id of somebody who only watches: the contract has no such player, the screen needs a "you". */
export const WATCHER_ID = "watcher";

const JAIL_NAME = SQUARES[JAIL].name;
const START_NAME = SQUARES[0].name;

/** `alice.near` is shown as `alice`; an implicit account (64 hex digits) by its two ends. */
export function shortAccount(accountId: string): string {
  if (/^[0-9a-f]{64}$/.test(accountId)) return `${accountId.slice(0, 6)}…${accountId.slice(-4)}`;
  const first = accountId.split(".")[0];
  return first.length > 16 ? `${first.slice(0, 15)}…` : first;
}

/** The account that sponsors free tables on this server and plays their second seat, once the page has learnt it (free.ts). */
let houseAgent: string | null = null;

export function knowHouseAgent(accountId: string | null): void {
  houseAgent = accountId;
}

/** A seat the sponsor's agent plays: the sponsor's own seat at a table it opened with nothing staked. */
export const isHouseAgentSeat = (meta: ChainMeta, seat: { backer: string | null }): boolean =>
  houseAgent !== null && seat.backer === houseAgent && meta.creator === houseAgent && meta.stake === "0";

/** The model each house agent of a free table plays with, by table and seat, once the page has asked (useFree.ts). */
const houseModels = new Map<string, Record<number, string>>();

export function knowHouseModels(id: string, models: Record<number, string>): void {
  houseModels.set(id, models);
}

/** A house agent's seat by its model: "AI · gpt-4.1-mini"; "House agent" while the model is not known. */
const houseSeatName = (meta: ChainMeta, seat: number): string => {
  const model = houseModels.get(meta.id)?.[seat];
  return model ? `AI · ${model === "rules" ? "house numbers" : (model.split("/").pop() ?? model)}` : "House agent";
};

/** An account as a line of text names it: the sponsor's as what it is here, any other by `shortAccount`. */
export const accountLabel = (accountId: string): string => (accountId === houseAgent ? "the house agent" : shortAccount(accountId));

/** An account by its chibi character's name when this page has read one (games/chibi), else by `shortAccount`. */
export const playerName = (accountId: string): string => characterOf(accountId)?.name ?? shortAccount(accountId);

/** A name per seat, by seat. Seats that would share a name are numbered. */
export function seatNames(meta: ChainMeta): string[] {
  const names = meta.seats.map((seat) => (seat.house ? "House" : isHouseAgentSeat(meta, seat) ? houseSeatName(meta, seat.seat) : seat.backer ? playerName(seat.backer) : `Seat ${seat.seat + 1}`));
  return names.map((name, i) => {
    const same = names.filter((other) => other === name).length;
    return same > 1 ? `${name} ${names.slice(0, i + 1).filter((other) => other === name).length}` : name;
  });
}

/** The seat this account moves for: the first one it backs or drives. `null`: it only watches. */
export function seatOf(meta: ChainMeta, accountId: string | null): number | null {
  if (!accountId) return null;
  const seat = meta.seats.find((s) => s.backer === accountId || s.driver === accountId);
  return seat ? seat.seat : null;
}

/** When the current turn times out, on this machine's clock, in ms. `null` when no turn is running. */
export function deadlineMs(meta: ChainMeta): number | null {
  if (meta.status !== "playing") return null;
  const ns = BigInt(meta.turn_deadline);
  return ns > 0n ? Number(ns / 1_000_000n) : null;
}

/** One line of the game log, in the words the reference engine uses. */
export function logLine(event: ChainEvent, nameOf: (playerId: string) => string): string {
  const squareName = (index: number) => SQUARES[index]?.name ?? `square ${index}`;
  switch (event.kind) {
    case "start":
      return `${nameOf(event.first)} goes first.`;
    case "roll":
      return `${nameOf(event.player)} rolls ${event.dice[0]}-${event.dice[1]}.`;
    case "salary":
      return `${nameOf(event.player)} passes ${START_NAME} and collects ${event.amount}.`;
    case "buy":
      return `${nameOf(event.player)} buys ${squareName(event.square)} for ${event.price}.`;
    case "skip":
      return `${nameOf(event.player)} does not buy ${squareName(event.square)}.`;
    case "rent":
      return `${nameOf(event.player)} pays ${nameOf(event.owner)} ${event.amount} rent at ${squareName(event.square)}.`;
    case "tax": {
      const square = SQUARES[event.square];
      return `${nameOf(event.player)} ${square?.kind === "tax" ? square.verb : "pays"} ${event.amount}.`;
    }
    case "card":
      return `${nameOf(event.player)} draws ${DECK_NAMES[event.deck]}: ${CARDS[event.deck][event.index]?.text ?? `card ${event.index}`}`;
    case "jailed":
      return `${nameOf(event.player)} goes to ${JAIL_NAME}.`;
    case "released":
      if (event.by === "doubles") return `${nameOf(event.player)} rolls a double and leaves ${JAIL_NAME}.`;
      if (event.by === "bail") return `${nameOf(event.player)} pays ${JAIL_FINE} to leave ${JAIL_NAME}.`;
      if (event.by === "card") return `${nameOf(event.player)} uses a card to leave ${JAIL_NAME}.`;
      return `${nameOf(event.player)} fails a third time, pays ${JAIL_FINE} and leaves ${JAIL_NAME}.`;
    case "build":
      return `${nameOf(event.player)} builds ${event.houses === 5 ? "a hotel" : `house ${event.houses}`} in ${squareName(event.square)}.`;
    case "sell":
      return `${nameOf(event.player)} sells a house in ${squareName(event.square)}.`;
    case "mortgage":
      return `${nameOf(event.player)} mortgages ${squareName(event.square)} for ${event.amount}.`;
    case "redeem":
      return `${nameOf(event.player)} redeems ${squareName(event.square)}.`;
    case "paidDebt":
      return `${nameOf(event.player)} pays off a debt of ${event.amount}.`;
    case "bankrupt":
      return `${nameOf(event.player)} goes bankrupt.`;
    case "auto":
      return `${nameOf(event.player)} timed out; the game moves for them.`;
    case "resign":
      return `${nameOf(event.player)} gives up.`;
    case "drew":
      return `${nameOf(event.player)} gets a ticket: ${TICKET_NAMES[event.ticket]}.`;
    case "played":
      if (event.ticket === "waiver") return `${nameOf(event.player)} plays a Rent waiver: the next rent this turn is not charged.`;
      if (event.ticket === "festival") return `${nameOf(event.player)} plays a Festival: double rent in their cities until their next turn.`;
      if (event.ticket === "steps") return `${nameOf(event.player)} plays Pick your steps and moves ${event.value}.`;
      return `${nameOf(event.player)} plays a Takeover on ${squareName(event.value)}.`;
    case "waived":
      return `${nameOf(event.player)}'s Rent waiver covers ${event.amount} rent to ${nameOf(event.owner)} at ${squareName(event.square)}.`;
    case "taken":
      return `${nameOf(event.player)} takes ${squareName(event.square)} from ${nameOf(event.owner)} for ${event.amount}.`;
    case "raised":
      return raiseLine(nameOf(event.player), event);
    case "end":
      return event.reason === "time" ? "Time is up: net worth decides." : "Only one player is left.";
  }
}

/** The contract's answer as a `Game` of the reference engine. A new object every time, free to change. */
export function toGame(match: ChainMatch): Game {
  const { meta } = match;
  const game = structuredClone(match.game);
  const names = seatNames(meta);
  const playing = game.phase !== "lobby";
  const players: Player[] = game.players.map((player) => {
    const backing = meta.seats.find((s) => s.player === player.id);
    const seat = backing?.seat ?? 0;
    // The seat's backer's chibi character when this page has read it (no pet or ride at a table), else the seat's default.
    const character = backing?.house ? null : characterOf(backing?.backer);
    const look = character ? roomLook(character.look) : lookFromSeat(seat);
    return { ...player, secret: "", name: names[seat] ?? player.id, isHost: false, wantsToPlay: true, color: playing ? seat : null, look };
  });
  const nameOf = (id: string) => players.find((p) => p.id === id)?.name ?? id;
  const { salary, cash, blitz, maxRounds } = meta.rules;
  return {
    phase: game.phase,
    // The chain has no clock for the whole game: it ends after `maxRounds` rounds. Its turn clock is `turn_seconds`.
    settings: { limitMinutes: 0, salary, cash, autoSeconds: meta.turn_seconds, maxRounds, blitz, ...(meta.rules.tickets ? { tickets: true } : {}), ...(meta.rules.leaderRent ? { leaderRent: true } : {}), ...(meta.rules.buildHere ? { buildHere: true } : {}) },
    players,
    order: game.order,
    turn: game.turn,
    stage: game.stage,
    dice: game.dice,
    doubles: game.doubles,
    again: game.again,
    round: game.round,
    props: game.props,
    debt: game.debt,
    pendingMove: game.pendingMove,
    card: game.card,
    buildAt: game.buildAt,
    builtThisTurn: game.builtThisTurn,
    log: match.log.map((event) => logLine(event, nameOf)),
    trade: null,
    endsAt: null,
    lastRound: game.phase === "playing" && maxRounds > 0 && game.round >= maxRounds - 1,
    minted: game.minted,
    rolls: game.rolls,
    result: game.result,
    ...(game.tickets ? { tickets: game.tickets } : {}),
  };
}

/**
 * The last board seen of a match that is now settled. The contract drops the board when it pays out, so the final
 * moves made by somebody else may be missing here; who won and what was paid comes from `get_result` alone.
 */
export function settledGame(game: Game, meta: ChainMeta, result: ChainResult): Game {
  if (game.phase === "ended" && game.result) return game;
  const ranking = result.ranking.map((seat) => meta.seats[seat]?.player).filter((id): id is string => typeof id === "string");
  return { ...game, phase: "ended", debt: null, result: { reason: result.reason, ranking } };
}

/** What this account sees. Somebody without a seat is added as a watcher: the contract has no such player. */
export function chainView(game: Game, meta: ChainMeta, accountId: string | null, now: number, autoAt: number | null): View {
  const seat = seatOf(meta, accountId);
  // A seat the contract holds for away shows as away on its card; everybody else is at the table.
  const away = new Set((meta.away ?? []).map((k) => meta.seats[k]?.player));
  const here = (players: Player[]) => new Set(players.map((p) => p.id).filter((id) => !away.has(id)));
  if (seat !== null) return viewFor(game, meta.seats[seat].player, { code: meta.id, online: here(game.players), now, autoAt });
  const watcher: Player = { ...newPlayer(WATCHER_ID, "", accountId ? shortAccount(accountId) : "Guest"), wantsToPlay: false };
  const shown: Game = { ...game, players: [...game.players, watcher] };
  return viewFor(shown, WATCHER_ID, { code: meta.id, online: here(shown.players), now, autoAt });
}

const isSquare = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) < BOARD_SIZE;

/** The contract action a message of the screen stands for. `null`: the contract has nothing like it (trades, lobby settings). */
export function toAction(message: ClientMessage): ContractAction | null {
  switch (message.t) {
    case "roll":
      return "Roll";
    case "buy":
      return "Buy";
    case "skip":
      return "Skip";
    case "end":
      return "End";
    case "bail":
      return "Bail";
    case "card":
      return "Card";
    case "pay":
      return "Pay";
    case "bankrupt":
      return "Bankrupt";
    case "resign":
      return "Resign";
    case "build":
      return isSquare(message.square) ? { Build: message.square } : null;
    case "sell":
      return isSquare(message.square) ? { Sell: message.square } : null;
    case "mortgage":
      return isSquare(message.square) ? { Mortgage: message.square } : null;
    case "redeem":
      return isSquare(message.square) ? { Redeem: message.square } : null;
    case "ticket":
      if (message.ticket === "waiver") return "Waiver";
      if (message.ticket === "festival") return "Festival";
      if (message.ticket === "takeover") return "Takeover";
      return Number.isInteger(message.steps) && message.steps! >= 2 && message.steps! <= 12 ? { Steps: message.steps! } : null;
    default:
      return null;
  }
}

/**
 * Whether the chain's randomness decides what this action does: a roll, or paying the debt of a third failed jail
 * roll (the held-back move follows and may draw a card). Such an action is never applied here first.
 */
export function needsDice(game: Game, action: ContractAction): boolean {
  // "Pick your steps" throws no dice, but where it leads the chain may draw a card or a ticket.
  return action === "Roll" || (action === "Pay" && game.pendingMove !== null) || (typeof action === "object" && "Steps" in action);
}

/** Whether the rules allow `playerId` an action that needs dice right now. */
export function diceAllowed(game: Game, playerId: string, action: ContractAction): boolean {
  const player = currentPlayer(game);
  if (!player || player.id !== playerId) return false;
  if (action === "Roll") return game.stage === "roll" || (game.stage === "end" && game.again);
  if (action === "Pay") return game.stage === "debt" && !!game.debt && player.cash >= game.debt.reduce((sum, payee) => sum + payee.amount, 0);
  if (typeof action === "object" && "Steps" in action) return canPlay(game, playerId, "steps");
  return false;
}

const NO_DICE: Rng = {
  die() {
    throw new Error("only the chain rolls dice");
  },
  below() {
    throw new Error("only the chain draws cards");
  },
};

/**
 * Applies an action that needs no dice, exactly as the contract will. Returns `false`, with the game untouched, when
 * the rules refuse it (the engine ignores an illegal action) or when it needs dice.
 */
export function applyAction(game: Game, playerId: string, action: ContractAction): boolean {
  if (needsDice(game, action)) return false;
  const before = JSON.stringify(game);
  if (action === "Buy") buy(game, playerId);
  else if (action === "Skip") skipBuying(game, playerId);
  else if (action === "End") endTurn(game, playerId);
  else if (action === "Bail") payBail(game, playerId);
  else if (action === "Card") useFreeCard(game, playerId);
  else if (action === "Pay") payDebt(game, playerId, NO_DICE);
  else if (action === "Bankrupt") declareBankruptcy(game, playerId);
  else if (action === "Resign") resign(game, playerId);
  else if (action === "Waiver") playWaiver(game, playerId);
  else if (action === "Festival") playFestival(game, playerId);
  else if (action === "Takeover") takeover(game, playerId);
  else if (typeof action === "string") return false;
  else if ("Build" in action) build(game, playerId, action.Build);
  else if ("Sell" in action) sellHouse(game, playerId, action.Sell);
  else if ("Mortgage" in action) mortgage(game, playerId, action.Mortgage);
  else if ("Redeem" in action) redeem(game, playerId, action.Redeem);
  else return false;
  return JSON.stringify(game) !== before;
}

/** Basis points as a percentage: `250` is `2.5%`. */
export function formatBps(basisPoints: number): string {
  return `${basisPoints / 100}%`;
}

/** yoctoNEAR as a plain NEAR amount: `"1400000000000000000000000"` is `1.4`. Cut, not rounded, after `digits` decimals. */
export function formatNear(yocto: string, digits = 4): string {
  const value = BigInt(yocto);
  const one = 10n ** 24n;
  const decimals = ((value % one) / 10n ** BigInt(24 - digits)).toString().padStart(digits, "0").replace(/0+$/, "");
  return decimals ? `${value / one}.${decimals}` : `${value / one}`;
}
