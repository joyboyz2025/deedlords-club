// Differential-test trace generator (docs/ENGINE-RULES.md §9).
//
//   npm run diff:gen -- --games 2000 --seed 1 --out traces
//   npm run diff:check                      (replays traces/ through the Rust engine)
//
// Plays random games on the TypeScript engine with a seeded PRNG behind a recording Rng and writes one JSON file per
// game: every step's op, actor, square index, the Rng calls it made, whether it changed the state, and the snapshot
// after it. Ops are mostly legal, about 10% deliberately illegal. The policy is biased so that games regularly reach
// jail (and all ways out), doubles and triple doubles, every card, debt (also with a pending move), bankruptcy to a
// player and to the bank, mortgages, hotels, and both end reasons. Prints a coverage table at the end.

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CARDS, JAIL, JAIL_FINE, SQUARES, isOwnable, type CardEffect, type Deck } from "../../games/co-ty-phu/board.ts";
import {
  autoAct,
  build,
  buy,
  canBuild,
  canMortgage,
  canPlay,
  playFestival,
  playSteps,
  playWaiver,
  takeover,
  ticketsOf,
  canSell,
  createGame,
  currentPlayer,
  declareBankruptcy,
  defaultRng,
  endTurn,
  mortgage,
  newPlayer,
  payBail,
  payDebt,
  redeem,
  redeemPrice,
  resign,
  roll,
  sellHouse,
  skipBuying,
  startGame,
  useFreeCard,
  type Game,
  type Player,
  type Rng,
} from "../../games/co-ty-phu/engine.ts";
import { RecordingRng, gameSeed, mulberry32, prngRng, type RngCall } from "./rng.ts";
import { snapshot, type Snapshot } from "./snapshot.ts";

export const OPS = ["start", "roll", "buy", "skip", "end", "bail", "card", "pay", "bankrupt", "build", "sell", "mortgage", "redeem", "auto", "resign"] as const;
/** The ops of a game with tickets (ENGINE-RULES §10.2); `steps` takes the steps as its index. Never in a `game-` trace. */
export const TICKET_OPS = ["waiver", "steps", "takeover", "festival"] as const;
export type Op = (typeof OPS)[number] | (typeof TICKET_OPS)[number];
/** Ops only the current player may do. */
const TURN_OPS: Op[] = ["roll", "buy", "skip", "end", "bail", "card", "pay", "bankrupt"];
const INDEXED_OPS: Op[] = ["build", "sell", "mortgage", "redeem"];

export type Rules = { salary: number; cash: number; blitz: boolean; maxRounds: number; tickets?: boolean; leaderRent?: boolean; buildHere?: boolean; buildOne?: boolean };
export type TraceStep = { op: Op; player: string | null; index: number | null; rng: RngCall[]; ok: boolean; state: Snapshot };
export type Trace = { version: 1; seed: number; rules: Rules; players: string[]; steps: TraceStep[] };

const MAX_STEPS = 600;
const ILLEGAL_RATE = 0.1;

type Move = { op: Op; player: string | null; index: number | null; illegal?: boolean };

/** A lobby game with these players seated in this order and these rules (time limit and auto-play off). */
export function newTraceGame(players: string[], rules: Rules): Game {
  const game = createGame();
  players.forEach((id, i) => game.players.push(newPlayer(id, `secret-${id}`, id, i === 0)));
  game.settings = { limitMinutes: 0, salary: rules.salary, cash: rules.cash, autoSeconds: 0, maxRounds: rules.maxRounds, blitz: rules.blitz };
  if (rules.tickets) game.settings.tickets = true;
  if (rules.leaderRent) game.settings.leaderRent = true;
  if (rules.buildHere) game.settings.buildHere = true;
  if (rules.buildOne) game.settings.buildOne = true;
  return game;
}

/** Applies one trace op to the TS engine (ENGINE-RULES §7). `start` seats every player, all online. */
export function applyOp(game: Game, op: Op, player: string | null, index: number | null, rng: Rng): void {
  const id = player ?? "";
  switch (op) {
    case "start":
      return startGame(game, new Set(game.players.map((p) => p.id)), 0, rng);
    case "roll":
      return roll(game, id, null, rng);
    case "buy":
      return buy(game, id);
    case "skip":
      return skipBuying(game, id);
    case "end":
      return endTurn(game, id);
    case "bail":
      return payBail(game, id);
    case "card":
      return useFreeCard(game, id);
    case "pay":
      return payDebt(game, id, rng);
    case "bankrupt":
      return declareBankruptcy(game, id);
    case "build":
      return build(game, id, index);
    case "sell":
      return sellHouse(game, id, index);
    case "mortgage":
      return mortgage(game, id, index);
    case "redeem":
      return redeem(game, id, index);
    case "auto":
      autoAct(game, rng);
      return;
    case "resign":
      return resign(game, id);
    case "waiver":
      return playWaiver(game, id);
    case "steps":
      return playSteps(game, id, index, rng);
    case "takeover":
      return takeover(game, id);
    case "festival":
      return playFestival(game, id);
  }
}

// Policy

type Params = { doubles: number; auto: number; raise: number; buy: number; build: number; bail: number; card: number; offTurn: number; resign: number };

function picker(random: () => number) {
  return <T>(items: readonly T[]): T => items[Math.min(items.length - 1, Math.floor(random() * items.length))];
}

function pickRules(random: () => number): Rules {
  const pick = picker(random);
  const r = random();
  if (r < 0.3) return { salary: 200, cash: pick([1500, 1500, 800, 400]), blitz: false, maxRounds: 0 };
  if (r < 0.55) return { salary: pick([200, 200, 100]), cash: pick([1500, 600, 300]), blitz: false, maxRounds: 2 + Math.floor(random() * 9) };
  if (r < 0.8) return { salary: 200, cash: 2000, blitz: true, maxRounds: 3 };
  return { salary: 200, cash: pick([2000, 2500]), blitz: true, maxRounds: pick([0, 6, 10, 20]) };
}

function pickParams(random: () => number): Params {
  const pick = picker(random);
  const between = (lo: number, hi: number) => lo + (hi - lo) * random();
  return {
    doubles: pick([0, 0, 0.15, 0.35]),
    auto: between(0.02, 0.08),
    raise: between(0.4, 0.95),
    buy: between(0.6, 0.97),
    build: between(0.5, 0.95),
    bail: between(0.15, 0.6),
    card: between(0.3, 0.9),
    offTurn: between(0.02, 0.08),
    // Most games see nobody give up; some see it once or twice, on any turn and at any stage.
    resign: pick([0, 0, 0.004, 0.012]),
  };
}

const owedOf = (game: Game) => (game.debt ?? []).reduce((sum, payee) => sum + payee.amount, 0);
const ownedBy = (game: Game, id: string) =>
  Object.keys(game.props)
    .map(Number)
    .filter((i) => game.props[i].owner === id);

/** Legal sell, mortgage and redeem moves of a player (any player may do these any time while playing). */
function propertyMoves(game: Game, player: Player): Move[] {
  const moves: Move[] = [];
  for (const index of ownedBy(game, player.id)) {
    if (canSell(game, player.id, index)) moves.push({ op: "sell", player: player.id, index });
    if (canMortgage(game, player.id, index)) moves.push({ op: "mortgage", player: player.id, index });
    if (game.props[index].mortgaged && player.cash >= redeemPrice(index)) moves.push({ op: "redeem", player: player.id, index });
  }
  return moves;
}

/** Turn ops the current player may do right now. */
function legalTurnOps(game: Game, me: Player): Set<Op> {
  const ops = new Set<Op>();
  const square = SQUARES[me.position];
  if (game.stage === "roll" || (game.stage === "end" && game.again)) ops.add("roll");
  if (game.stage === "buy") {
    ops.add("skip");
    if (isOwnable(square) && me.cash >= square.price) ops.add("buy");
  }
  if (game.stage === "end" && !game.again) ops.add("end");
  if (game.stage === "roll" && me.jail !== null) {
    if (me.cash >= JAIL_FINE) ops.add("bail");
    if (me.freeCards.length > 0) ops.add("card");
  }
  if (game.stage === "debt") {
    ops.add("bankrupt");
    if (me.cash >= owedOf(game)) ops.add("pay");
  }
  return ops;
}

function legalMove(game: Game, me: Player, random: () => number, params: Params): Move {
  const pick = picker(random);
  const turn = (op: Op): Move => ({ op, player: me.id, index: null });
  const builds = ownedBy(game, me.id).filter((i) => canBuild(game, me.id, i));
  const props = propertyMoves(game, me);
  if (game.stage !== "debt" && random() < params.auto) return { op: "auto", player: null, index: null };
  switch (game.stage) {
    case "debt": {
      if (me.cash >= owedOf(game)) return props.length > 0 && random() < 0.1 ? pick(props) : turn("pay");
      const raise = props.filter((move) => move.op !== "redeem");
      return raise.length > 0 && random() < params.raise ? pick(raise) : turn("bankrupt");
    }
    case "roll": {
      if (builds.length > 0 && random() < params.build * 0.4) return { op: "build", player: me.id, index: pick(builds) };
      if (me.jail !== null) {
        if (me.freeCards.length > 0 && random() < params.card) return turn("card");
        if (me.cash >= JAIL_FINE && random() < params.bail) return turn("bail");
      }
      return turn("roll");
    }
    case "buy": {
      const square = SQUARES[me.position];
      if (isOwnable(square) && me.cash >= square.price && random() < params.buy) return turn("buy");
      return turn("skip");
    }
    case "end": {
      if (builds.length > 0 && random() < params.build) return { op: "build", player: me.id, index: pick(builds) };
      if (props.length > 0 && random() < 0.06) return pick(props);
      return turn(game.again ? "roll" : "end");
    }
  }
}

/** Squares that can never be owned. */
const UNOWNABLE = SQUARES.flatMap((square, i) => (isOwnable(square) ? [] : [i]));

function illegalMove(game: Game, random: () => number): Move {
  const pick = picker(random);
  const ids = game.players.map((p) => p.id);
  const me = currentPlayer(game)!;
  const others = ids.filter((id) => id !== me.id);
  const owned = Object.keys(game.props).map(Number);
  const anySquare = () => Math.floor(random() * 40);
  const kind = Math.floor(random() * 9);
  switch (kind) {
    case 0: {
      // Not your turn.
      const player = pick(others);
      const op = pick([...TURN_OPS, "build" as Op]);
      const theirs = ownedBy(game, player);
      return { op, player, index: op === "build" ? (theirs.length > 0 ? pick(theirs) : anySquare()) : null, illegal: true };
    }
    case 1: {
      // Wrong stage for the current player.
      const legal = legalTurnOps(game, me);
      const wrong = TURN_OPS.filter((op) => !legal.has(op));
      return { op: pick(wrong), player: me.id, index: null, illegal: true };
    }
    case 2: {
      // An index that names no ownable square: off the board (40..255) or a corner, tax or card square.
      const index = random() < 0.5 ? 40 + Math.floor(random() * 216) : pick(UNOWNABLE);
      return { op: pick(INDEXED_OPS), player: pick(ids), index, illegal: true };
    }
    case 3: {
      // Someone else's square.
      if (owned.length === 0) break;
      const index = pick(owned);
      const player = pick(ids.filter((id) => id !== game.props[index].owner));
      return { op: pick(INDEXED_OPS), player, index, illegal: true };
    }
    case 4: {
      // Own square in the wrong state: mortgage twice, redeem unmortgaged, sell without houses, build off-turn/again.
      if (owned.length === 0) break;
      const index = pick(owned);
      const owner = game.props[index].owner;
      const { mortgaged, houses } = game.props[index];
      const op: Op = mortgaged ? pick(["mortgage", "build", "sell"] as Op[]) : houses === 0 ? pick(["redeem", "sell", "build"] as Op[]) : pick(["mortgage", "redeem", "build"] as Op[]);
      return { op, player: owner, index, illegal: true };
    }
    case 5: {
      // Nobody owns it yet.
      const free = SQUARES.flatMap((square, i) => (isOwnable(square) && !game.props[i] ? [i] : []));
      if (free.length === 0) break;
      return { op: pick(INDEXED_OPS), player: pick(ids), index: pick(free), illegal: true };
    }
    case 6:
      // `auto` never acts in debt; `start` only works in the lobby.
      if (game.stage === "debt") return { op: "auto", player: null, index: null, illegal: true };
      if (random() < 0.3) return { op: "start", player: null, index: null, illegal: true };
      break;
    case 7: {
      // A bankrupt player, or an id that is not in the game.
      const out = game.players.filter((p) => p.bankrupt).map((p) => p.id);
      const player = out.length > 0 ? pick(out) : "nobody";
      const op = pick(OPS.filter((op) => op !== "start" && op !== "auto"));
      return { op, player, index: INDEXED_OPS.includes(op) ? (owned.length > 0 ? pick(owned) : anySquare()) : null, illegal: true };
    }
    case 8: {
      // Off-turn players may sell, mortgage and redeem, but not something they cannot afford or do not own.
      const player = pick(game.players);
      const theirs = ownedBy(game, player.id);
      const target = theirs.find((i) => game.props[i].mortgaged && player.cash < redeemPrice(i));
      if (target !== undefined) return { op: "redeem", player: player.id, index: target, illegal: true };
      return { op: pick(["sell", "mortgage", "redeem"] as Op[]), player: player.id, index: anySquare(), illegal: true };
    }
  }
  return { op: pick(TURN_OPS), player: pick(others), index: null, illegal: true };
}

/** A ticket the current player may play now, played about half the times it could be (a Takeover more often: it is rare). */
function ticketMove(game: Game, me: Player, random: () => number): Move | null {
  if (canPlay(game, me.id, "takeover") && random() < 0.8) return { op: "takeover", player: me.id, index: null };
  for (const op of ["festival", "waiver", "steps"] as const) {
    if (canPlay(game, me.id, op) && random() < 0.45) return { op, player: me.id, index: op === "steps" ? 2 + Math.floor(random() * 11) : null };
  }
  return null;
}

/** A ticket op that the rules should refuse: not the player's turn, a ticket not held, the wrong moment, steps off 2..12. */
function illegalTicket(game: Game, me: Player, random: () => number): Move {
  const pick = picker(random);
  const op = pick(TICKET_OPS);
  const others = game.players.filter((p) => p.id !== me.id);
  const kind = Math.floor(random() * 4);
  if (kind === 0 && others.length > 0) return { op, player: pick(others).id, index: op === "steps" ? 7 : null, illegal: true };
  if (kind === 1) return { op: "steps", player: me.id, index: pick([0, 1, 13, 40, 255]), illegal: true };
  const missing = TICKET_OPS.filter((ticket) => !ticketsOf(game, me.id).includes(ticket));
  if (kind === 2 && missing.length > 0) return { op: pick(missing), player: me.id, index: 7, illegal: true };
  return { op, player: me.id, index: op === "steps" ? 2 + Math.floor(random() * 11) : null, illegal: true };
}

function chooseMove(game: Game, random: () => number, params: Params, steps: number): Move {
  if (game.phase === "lobby") {
    // Now and then something illegal before the start.
    if (steps < 2 && random() < 0.1) {
      const pick = picker(random);
      const op = pick(OPS.filter((op) => op !== "start"));
      return { op, player: op === "auto" ? null : pick(game.players).id, index: INDEXED_OPS.includes(op) ? Math.floor(random() * 40) : null, illegal: true };
    }
    return { op: "start", player: null, index: null };
  }
  // Only a game with tickets draws these: a `game-` trace takes the same random values as before tickets existed.
  if (game.settings.tickets) {
    if (random() < 0.03) return illegalTicket(game, currentPlayer(game)!, random);
    const play = ticketMove(game, currentPlayer(game)!, random);
    if (play) return play;
  }
  if (random() < ILLEGAL_RATE) return illegalMove(game, random);
  const me = currentPlayer(game)!;
  if (params.resign > 0 && random() < params.resign) return { op: "resign", player: picker(random)(game.players.filter((p) => !p.bankrupt)).id, index: null };
  if (random() < params.offTurn) {
    const others = game.players.filter((p) => p.id !== me.id && !p.bankrupt);
    const moves = others.flatMap((p) => propertyMoves(game, p));
    if (moves.length > 0) return picker(random)(moves);
  }
  return legalMove(game, me, random, params);
}

// Coverage

export class Coverage {
  counts = new Map<string, number>();
  add(key: string, by = 1): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + by);
  }
  get(key: string): number {
    return this.counts.get(key) ?? 0;
  }
}

function effectName(effect: CardEffect): string {
  switch (effect.kind) {
    case "money":
      return effect.amount > 0 ? "money +" : "money -";
    case "each":
      return effect.amount > 0 ? "each + (collect from each)" : "each - (pay each)";
    case "nearest":
      return `nearest ${effect.type}`;
    case "goto":
      return effect.to === 0 ? "goto Departure" : "goto square";
    default:
      return effect.kind;
  }
}

/**
 * Plays one game and records its trace. `extras`: a game with the opt-in rules of ENGINE-RULES §10, mostly both, some
 * with one of them; such a game draws more random values, so it is another game than the one of the same seed without.
 */
export function generateGame(seed: number, coverage: Coverage = new Coverage(), extras = false): Trace {
  const random = mulberry32(seed);
  const count = 2 + Math.floor(random() * 3);
  const players = Array.from({ length: count }, (_, i) => `p${i}`);
  const rules = pickRules(random);
  if (extras) {
    const r = random();
    if (r < 0.85) rules.tickets = true;
    if (r > 0.15) rules.leaderRent = true;
    // Tickets come at Departure: most of these games are long enough to pass it a few times.
    if (rules.maxRounds > 0 && rules.maxRounds < 8 && random() < 0.7) rules.maxRounds = 12;
    // Building only where one stops (ENGINE-RULES §10.5), in every other Blitz game: by the seed, so that it draws no
    // random value and the games without it stay the games they were.
    if (rules.blitz && seed % 3 === 0) rules.buildHere = true;
    // One house a turn on any own city (ENGINE-RULES §10.6), in another third of them.
    if (rules.blitz && seed % 3 === 1) rules.buildOne = true;
  }
  const params = pickParams(random);
  const source = prngRng(random, params.doubles);
  const rng = new RecordingRng(source);
  const game = newTraceGame(players, rules);
  coverage.add(`rules: ${rules.blitz ? "blitz" : "classic"}, ${rules.maxRounds === 0 ? "no round limit" : rules.maxRounds === 3 && rules.blitz ? "maxRounds 3" : "maxRounds > 0"}`);
  if (extras) coverage.add(`extras: ${rules.tickets ? "tickets" : ""}${rules.tickets && rules.leaderRent ? " + " : ""}${rules.leaderRent ? "leader's rent" : ""}`);
  if (rules.buildHere) coverage.add("extras: build only where one stops");
  if (rules.buildOne) coverage.add("extras: one house a turn");
  coverage.add(`players: ${count}`);

  let drawing = false;
  rng.onBelow = (n, value) => {
    if (!drawing) return;
    // A ticket drawn passing Departure: `below(4)` (a deck holds 14 cards).
    if (game.tickets && n === TICKET_OPS.length) return coverage.add(`ticket: drawn passing Departure (${TICKET_OPS[value]})`);
    const square = SQUARES[currentPlayer(game)!.position];
    if (square.kind !== "card") throw new Error("a card was drawn off a card square");
    coverage.add(`card ${square.deck}[${value}]`);
    coverage.add(`effect ${effectName(CARDS[square.deck][value].effect)}`);
  };

  const steps: TraceStep[] = [];
  let before = JSON.stringify(snapshot(game));
  while (steps.length < MAX_STEPS && game.phase !== "ended") {
    const move = chooseMove(game, random, params, steps.length);
    const me = currentPlayer(game);
    const was = me && { jail: me.jail, doubles: game.doubles, stage: game.stage, pendingMove: game.pendingMove, debt: game.debt, freeCards: me.freeCards.length };
    const logged = game.log.length;
    const [waiverWas, heldWas] = [game.tickets?.waiver ?? false, me ? ticketsOf(game, me.id).length : 0];
    source.reset();
    drawing = move.op !== "start";
    applyOp(game, move.op, move.player, move.index, rng);
    drawing = false;
    const state = snapshot(game);
    const after = JSON.stringify(state);
    const ok = after !== before;
    before = after;
    const calls = rng.take();
    if (!ok && calls.length > 0) throw new Error(`seed ${seed} step ${steps.length}: refused ${move.op} consumed randomness`);
    const cash = game.players.reduce((sum, p) => sum + p.cash, 0);
    if (cash !== game.minted) throw new Error(`seed ${seed} step ${steps.length}: cash ${cash} != minted ${game.minted}`);
    if (game.players.some((p) => p.cash < 0 || !Number.isInteger(p.cash))) throw new Error(`seed ${seed} step ${steps.length}: bad cash`);
    steps.push({ op: move.op, player: move.player, index: move.index, rng: calls, ok, state });

    coverage.add(`op ${move.op} ${ok ? "ok" : "illegal"}`);
    if (move.illegal && ok) coverage.add("illegal pick that was legal");
    if (!ok) continue;
    if (move.op === "start" && game.settings.blitz) coverage.add("blitz deal");
    const rolled = move.op === "roll" || (move.op === "auto" && calls.some((call) => call.kind === "die"));
    if (move.op === "auto") coverage.add(rolled ? "auto: roll" : was?.stage === "buy" ? "auto: skip buying" : "auto: end turn");
    if (me && was) {
      const double = rolled && game.dice![0] === game.dice![1];
      if (double) coverage.add("doubles rolled");
      if (rolled && was.jail === null && was.doubles === 2 && double) coverage.add("jail: in by triple doubles");
      else if (was.jail === null && me.jail === 0) coverage.add(game.card && CARDS[game.card.deck][game.card.index].effect.kind === "jail" ? "jail: in by card" : "jail: in by Visa Denied");
      if (was.jail !== null && me.jail === null && !me.bankrupt) {
        if (move.op === "card") coverage.add("jail: out by card");
        else if (move.op === "bail") coverage.add("jail: out by bail");
        else if (double) coverage.add("jail: out by double");
        else if (game.pendingMove !== null) coverage.add("jail: out by 3rd roll, fine owed (pendingMove)");
        else coverage.add("jail: out by 3rd roll, fine paid");
      }
      if (was.stage !== "debt" && game.stage === "debt" && game.phase === "playing") coverage.add("debt: entered");
      if (move.op === "pay") coverage.add(was.pendingMove !== null ? "debt: paid, then pending move" : "debt: paid");
      if (move.op === "pay" && was.pendingMove !== null && calls.length > 0) coverage.add("debt: pending move drew a card");
      if (move.op === "resign") {
        const mine = move.player === me.id;
        coverage.add(mine ? (was.stage === "debt" ? "resign: on turn, in debt" : "resign: on turn") : was.debt?.some((payee) => payee.id === move.player) ? "resign: off turn, owed a debt" : "resign: off turn");
      }
      if (move.op === "bankrupt") {
        const toPlayer = was.debt!.length === 1 && was.debt![0].id !== null;
        coverage.add(toPlayer ? "bankrupt: to a player" : "bankrupt: to the bank");
        if (was.freeCards > 0) coverage.add(toPlayer ? "bankrupt: free cards passed to the creditor" : "bankrupt: free cards dropped");
      }
    }
    if (extras) {
      // The text log says what the rules of section 10 did in this step (it never holds more than 30 lines: a step adds few).
      const lines = game.log.slice(Math.max(0, game.log.length - Math.max(0, game.log.length - logged) - (game.log.length === 30 ? 6 : 0)));
      if (move.op === "start" && game.tickets) coverage.add("ticket: dealt at the start", game.order.length);
      if ((TICKET_OPS as readonly string[]).includes(move.op)) coverage.add(`ticket played: ${move.op}`);
      if (waiverWas && !game.tickets?.waiver && me && currentPlayer(game)?.id === me.id && game.phase === "playing") coverage.add("waiver: a rent not charged");
      if (waiverWas && me && currentPlayer(game)?.id !== me.id) coverage.add("waiver: unused when the turn passed");
      if (me && me.bankrupt && heldWas > 0) coverage.add("ticket: lost in bankruptcy");
      if (move.op === "roll" || move.op === "steps" || move.op === "auto" || move.op === "pay") {
        if (lines.some((line) => line.startsWith("Triple rent"))) coverage.add("rent: tripled (Festival and the leader)");
        else if (lines.some((line) => line.startsWith("Double rent") && line.includes("Festival"))) coverage.add("rent: doubled by a Festival");
        else if (lines.some((line) => line.startsWith("Double rent"))) coverage.add("rent: doubled for the leader");
      }
      if (move.op === "steps" && calls.length > 0) coverage.add("steps: drew a card or a ticket");
      if (me && (move.op === "roll" || move.op === "steps") && heldWas === 2 && lines.some((line) => line.includes(" passes ")) && ticketsOf(game, me.id).length === 2) coverage.add("ticket: none drawn at Departure (holds 2)");
    }
    if (move.op === "build" && game.props[move.index!].houses === 5) coverage.add("build: hotel");
    if (move.op === "build" && game.settings.blitz) coverage.add("build: blitz");
    if (move.op === "build" && !game.settings.blitz) coverage.add("build: classic");
  }
  coverage.add(`end: ${game.result?.reason ?? `unfinished (${MAX_STEPS} steps)`}${game.result ? `, ${game.settings.blitz ? "blitz" : "classic"}` : ""}`);
  coverage.add("steps", steps.length);
  return { version: 1, seed, rules, players, steps };
}

function printCoverage(coverage: Coverage, games: number, seed: number, out: string): void {
  const c = (key: string) => coverage.get(key);
  const keys = [...coverage.counts.keys()].sort();
  const line = (label: string, value: number | string) => console.log(`  ${label.padEnd(48)} ${String(value).padStart(9)}`);
  console.log(`\nCoverage: ${games} games, ${c("steps")} steps, seed ${seed}, traces in ${out}/`);
  console.log("\nRules and players");
  for (const key of keys.filter((k) => k.startsWith("rules: ") || k.startsWith("players: "))) line(key, c(key));
  console.log(`\n  ${"op".padEnd(12)} ${"ok".padStart(9)} ${"illegal".padStart(9)}`);
  for (const op of [...OPS, ...TICKET_OPS]) console.log(`  ${op.padEnd(12)} ${String(c(`op ${op} ok`)).padStart(9)} ${String(c(`op ${op} illegal`)).padStart(9)}`);
  line("illegal picks that turned out legal", c("illegal pick that was legal"));
  console.log("\nCard effects");
  for (const key of keys.filter((k) => k.startsWith("effect "))) line(key.slice(7), c(key));
  const cards = (["chance", "chest"] as Deck[]).flatMap((deck) => CARDS[deck].map((_, i) => `card ${deck}[${i}]`));
  const least = cards.reduce((min, key) => (c(key) < c(min) ? key : min), cards[0]);
  line(`distinct cards drawn (of ${cards.length})`, cards.filter((key) => c(key) > 0).length);
  line(`least drawn: ${least.slice(5)}`, c(least));
  console.log("\nTurns, jail, debt, bankruptcy, building");
  for (const prefix of ["doubles", "jail: ", "auto: ", "debt: ", "bankrupt: ", "resign: ", "build: ", "blitz deal", "extras: ", "ticket", "waiver: ", "rent: ", "steps: "])
    for (const key of keys.filter((k) => k.startsWith(prefix))) line(key, c(key));
  console.log("\nEnd reasons");
  for (const key of keys.filter((k) => k.startsWith("end: "))) line(key.slice(5), c(key));
}

function main(): void {
  const args = process.argv.slice(2);
  const option = (name: string, fallback: string) => {
    const at = args.indexOf(`--${name}`);
    return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
  };
  const games = Number(option("games", "2000"));
  // Games with the opt-in rules of ENGINE-RULES §10, written as tickets-NNNNN.json beside the others: a fifth as many unless told.
  const withExtras = Number(option("tickets", String(Math.ceil(games / 5))));
  const seed = Number(option("seed", "1"));
  const out = option("out", "traces");
  if (!Number.isInteger(games) || games < 1 || !Number.isInteger(seed)) {
    console.error("usage: gen.ts --games <n> --seed <int> --out <dir>");
    process.exit(2);
  }
  // Every random value must go through the recording Rng; the room server's real randomness must never be reached.
  defaultRng.die = () => {
    throw new Error("unrecorded die()");
  };
  defaultRng.below = () => {
    throw new Error("unrecorded below()");
  };
  mkdirSync(out, { recursive: true });
  for (const file of readdirSync(out)) if (/^(game|tickets)-\d+\.json$/.test(file)) rmSync(join(out, file));
  const coverage = new Coverage();
  const started = performance.now();
  for (let g = 0; g < games; g++) {
    const trace = generateGame(gameSeed(seed, g), coverage);
    writeFileSync(join(out, `game-${String(g).padStart(5, "0")}.json`), JSON.stringify(trace));
  }
  for (let g = 0; g < withExtras; g++) {
    const trace = generateGame(gameSeed(seed, games + g), coverage, true);
    writeFileSync(join(out, `tickets-${String(g).padStart(5, "0")}.json`), JSON.stringify(trace));
  }
  printCoverage(coverage, games + withExtras, seed, out);
  console.log(`\nWrote ${games} + ${withExtras} traces to ${out}/ in ${((performance.now() - started) / 1000).toFixed(1)} s`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
