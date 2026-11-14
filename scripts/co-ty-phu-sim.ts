// How long a match lasts and how open it stays, measured without a chain or a browser.
//
//   node --experimental-strip-types --disable-warning=ExperimentalWarning --import ./server/register.mjs scripts/co-ty-phu-sim.ts
//   … scripts/co-ty-phu-sim.ts --games 4000 --seed 7 --proposal
//   … scripts/co-ty-phu-sim.ts --seats 2 --set "more cash:3000,200,1,20"
//
// Every seat is played by the rule bot's playbook (agent/playbook.ts) through a port of the contract's own turn driver
// (contracts/deedlords/src/autoplay.rs `play_turn`), on the reference engine, with seeded dice. For each set of rules
// it reports how a match ends, after how many rounds, who wins (does whoever leads at a third and at half of the game
// go on to win?), how wide the gap is, and how many minutes the match takes on the table: every roll, purchase and
// end of turn is given the time the client spends on it (the chain's answer, the dice, the walk, the waits), with the
// timings of the client as it was and as it is now.
//
// `Mods` are rules the deployed contract does not have. They are modelled here only, on top of the engine, to put
// numbers behind a proposal (`--proposal`); the engine and the contract are untouched.

import { pathToFileURL } from "node:url";
import { briefFor, type Brief } from "../games/co-ty-phu/agent/brief.ts";
import type { Plan } from "../games/co-ty-phu/agent/plan.ts";
import { DEFAULT_PLAYBOOK, playbookPlan, type Playbook } from "../games/co-ty-phu/agent/playbook.ts";
import { CARDS, JAIL_FINE, OWNABLE_SQUARES, SQUARES, houseCost, isOwnable } from "../games/co-ty-phu/board.ts";
import { RULES, TO_THE_END, roundsFor } from "../games/co-ty-phu/chain/calls.ts";
import type { ChainGame, ChainMatch, ChainRules } from "../games/co-ty-phu/chain/types.ts";
import {
  build,
  buy,
  canBuild,
  canMortgage,
  canPlay,
  canSell,
  canTakeover,
  createGame,
  currentPlayer,
  declareBankruptcy,
  endTurn,
  mortgage,
  netWorth,
  newPlayer,
  payBail,
  payDebt,
  playFestival,
  playSteps,
  playWaiver,
  roll,
  sellHouse,
  skipBuying,
  startGame,
  takeover,
  useFreeCard,
  TICKETS,
  type Game,
  type Rng,
  type Ticket,
} from "../games/co-ty-phu/engine.ts";
import { gameSeed, mulberry32, prngRng } from "../tools/diff/rng.ts";
import { snapshot } from "../tools/diff/snapshot.ts";

// ----- The contract's turn driver, on the reference engine ----------------------------------------------------------

/** What one roll of a turn did, as far as the table's clock cares. */
export type RollSeen = {
  /** Squares the piece walked for the dice; 0 when it stayed in custody. */
  steps: number;
  /** A card was drawn where the dice led. */
  card: boolean;
  /** The piece did not stay where the dice put it (a card, Visa Denied): a second leg. */
  sentOn: boolean;
  bought: boolean;
  /** There was a square to buy (bought or not). */
  offered: boolean;
  /** Houses put up after this roll. */
  built: number;
  /** Something could have been built after this roll (the player had a choice to make). */
  couldBuild: boolean;
  /** The roll ended in a debt that cash did not cover. */
  debt: boolean;
};

/** `tickets`: the tickets the seat played in the turn, in order; absent when it played none. */
export type TurnSeen = { player: string; rolls: RollSeen[]; bankrupt: boolean; tickets?: Ticket[] };

const owedOf = (game: Game) => (game.debt ?? []).reduce((sum, payee) => sum + payee.amount, 0);

/** Cash the seat could still raise: half the house cost per house plus half the price of every unmortgaged square. */
function raisable(game: Game, id: string): number {
  let sum = 0;
  for (const [key, owned] of Object.entries(game.props)) {
    if (owned.owner !== id) continue;
    const square = SQUARES[Number(key)];
    sum += (owned.houses * houseCost(Number(key))) / 2 + (owned.mortgaged || !isOwnable(square) ? 0 : square.price / 2);
  }
  return sum;
}

/** `resolve_debt`: pay when cash covers it, go bankrupt when nothing would, else one house sale or one mortgage at a time. */
function resolveDebt(game: Game, id: string, liquidate: number[], rng: Rng): void {
  const order = [...new Set([...liquidate, ...OWNABLE_SQUARES])];
  while (game.phase === "playing" && currentPlayer(game)?.id === id && game.stage === "debt") {
    const cash = currentPlayer(game)!.cash;
    if (cash >= owedOf(game)) payDebt(game, id, rng);
    else if (cash + raisable(game, id) < owedOf(game)) declareBankruptcy(game, id);
    else {
      const sell = order.find((index) => canSell(game, id, index));
      const pawn = order.find((index) => canMortgage(game, id, index));
      if (sell !== undefined) sellHouse(game, id, sell);
      else if (pawn !== undefined) mortgage(game, id, pawn);
      else declareBankruptcy(game, id);
    }
  }
}

/**
 * `play_turn`: the rest of `id`'s turn by `plan`. `afterRoll` is called once the dice have been applied, before
 * anything is decided on the square (the mods use it). Returns what the table saw.
 */
export function playTurn(game: Game, id: string, plan: Plan, rng: Rng, afterRoll: (game: Game, id: string) => void = () => {}): TurnSeen {
  const seen: TurnSeen = { player: id, rolls: [], bankrupt: false };
  const played = (ticket: Ticket) => void (seen.tickets ??= []).push(ticket);
  let builtAfter: number | null = null;
  const planned = plan.tickets ?? {};
  // `throw` of autoplay.rs: the plan's Festival and Rent waiver, then the chosen steps or the dice.
  const throwDice = () => {
    const me = currentPlayer(game)!;
    for (const [wanted, ticket, play] of [[planned.festival, "festival", playFestival], [planned.waiver, "waiver", playWaiver]] as const) {
      if (wanted && canPlay(game, id, ticket)) {
        play(game, id);
        played(ticket);
      }
    }
    const [from, held] = [me.position, me.jail !== null];
    if (planned.steps !== undefined && canPlay(game, id, "steps")) {
      playSteps(game, id, planned.steps, rng);
      played("steps");
    } else roll(game, id, null, rng);
    const moved = !(held && me.jail !== null);
    const dice = game.dice![0] + game.dice![1];
    const led = (from + dice) % SQUARES.length;
    seen.rolls.push({ steps: moved ? dice : 0, card: game.card !== null, sentOn: moved && (me.position !== led || me.jail !== null), bought: false, offered: false, built: 0, couldBuild: false, debt: false });
    afterRoll(game, id);
  };
  for (let step = 0; step < 64; step++) {
    const me = currentPlayer(game);
    if (game.phase !== "playing" || !me || me.id !== id) break;
    const last = seen.rolls.at(-1);
    if (game.stage === "roll") {
      if (me.jail !== null && plan.bail) {
        if (me.freeCards.length > 0) useFreeCard(game, id);
        else if (me.cash >= JAIL_FINE) payBail(game, id);
      }
      throwDice();
    } else if (game.stage === "debt") {
      if (last) last.debt = true;
      resolveDebt(game, id, plan.liquidate, rng);
    } else if (game.stage === "buy") {
      const square = SQUARES[me.position];
      const price = isOwnable(square) ? square.price : Infinity;
      const wants = me.cash - price >= plan.buy_reserve && me.cash >= price;
      if (wants) buy(game, id);
      else skipBuying(game, id);
      if (last) Object.assign(last, { offered: true, bought: wants });
    } else if (builtAfter !== game.rolls) {
      builtAfter = game.rolls;
      const square = SQUARES[me.position];
      if (planned.takeover?.includes(me.position) && isOwnable(square) && me.cash - 2 * square.price >= plan.buy_reserve && canTakeover(game, id)) {
        takeover(game, id);
        played("takeover");
      }
      if (last) last.couldBuild = Object.keys(game.props).some((key) => canBuild(game, id, Number(key)));
      for (const index of plan.build) {
        if (canBuild(game, id, index) && me.cash - houseCost(index) >= plan.keep_reserve) {
          build(game, id, index);
          if (last) last.built += 1;
        }
      }
    } else if (game.again) throwDice();
    else {
      endTurn(game, id);
      break;
    }
  }
  seen.bankrupt = game.players.find((player) => player.id === id)!.bankrupt;
  return seen;
}

// ----- Rules the contract does not have, for the proposal -----------------------------------------------------------

export type Mods = {
  /** Whoever leads on net worth pays this many times the rent. */
  leaderRent?: number;
  /** Whoever is last by net worth collects this many times the salary when passing Departure. */
  underdogSalary?: number;
  /** Rents grow as the match goes on: a multiplier by the rounds completed and the round limit. */
  rentRamp?: (round: number, maxRounds: number) => number;
};

const rentPaid = / pays (\S+) (\d+) rent at /;
const passedStart = / passes .* and collects (\d+)\.$/;

/** Applies the mods to what the roll just did. The engine's log of this roll is read for the rent and the salary it paid. */
function applyMods(game: Game, id: string, mods: Mods, lines: string[]): void {
  const me = game.players.find((player) => player.id === id)!;
  const others = game.players.filter((player) => player.color !== null && !player.bankrupt && player.id !== id);
  if (others.length === 0) return;
  const mine = netWorth(game, id);
  if (mods.underdogSalary && lines.some((line) => line.startsWith(`${id} `) && passedStart.test(line)) && others.every((other) => netWorth(game, other.id) > mine)) {
    const extra = Math.round((mods.underdogSalary - 1) * (game.settings.salary ?? 0));
    me.cash += extra;
    game.minted += extra;
  }
  const rent = lines.map((line) => rentPaid.exec(line)).find((found) => found !== null);
  const owner = rent && game.players.find((player) => player.id === rent[1]);
  if (!rent || !owner || me.bankrupt) return;
  const leads = others.every((other) => netWorth(game, other.id) < mine);
  const times = (mods.rentRamp ? mods.rentRamp(game.round, game.settings.maxRounds ?? 0) : 1) * (mods.leaderRent && leads ? mods.leaderRent : 1);
  const extra = Math.round((Number(rent[2]) * (times - 1)) / 5) * 5;
  if (extra <= 0) return;
  // The rest of the rent is owed like the rent itself: paid from cash, or a debt to settle.
  if (game.stage === "debt" && game.debt) game.debt[0].amount += extra;
  else if (me.cash >= extra) [me.cash, owner.cash] = [me.cash - extra, owner.cash + extra];
  else Object.assign(game, { debt: [{ id: owner.id, amount: extra }], stage: "debt" });
}

// ----- One match ----------------------------------------------------------------------------------------------------

export type Rules = ChainRules;
export type MatchSeen = {
  reason: "last" | "time";
  rounds: number;
  /** Player ids, best first. */
  ranking: string[];
  /** Net worth of every seat (by turn order) after each completed round; a bankrupt seat counts 0. */
  worth: number[][];
  order: string[];
  turns: TurnSeen[];
  bankruptcies: number;
};

/** Asked of the game after a turn has been played on it: the compiler only knows what it was before. */
const over = (game: Game): boolean => game.phase === "ended";

function asMatch(game: Game, rules: Rules): ChainMatch {
  const seats = game.players.map((player, seat) => ({ seat, player: player.id, backer: `${player.id}.sim`, driver: null, house: false }));
  const meta = { id: "sim", status: "playing" as const, seats, stake: "0", split: [10_000], fee_bps: 0, rules, solo_player: null, creator: "sim", storage_deposit: "0" };
  const clock = { created_at: "0", last_activity: "0", turn_seconds: 30, turn_deadline: "0", draws: 0, current_seat: game.players.findIndex((player) => player.id === game.order[game.turn]) };
  return { meta: { ...meta, ...clock }, game: snapshot(game) as unknown as ChainGame, log: [] };
}

/** A seat's playbook, or what it does turn by turn from what the seat is told: a playbook, or the plan itself. */
export type Book = Playbook | ((brief: Brief) => Playbook | Plan);

/** A whole match of `seats` rule bots. `books`: a playbook per seat, the default one when not given. */
export function playMatch(seats: number, rules: Rules, seed: number, mods: Mods = {}, books: Book[] = []): MatchSeen {
  const rng = prngRng(mulberry32(seed));
  const game = createGame();
  for (let seat = 0; seat < seats; seat++) game.players.push(newPlayer(`s${seat}`, "", `s${seat}`, seat === 0));
  game.settings = { limitMinutes: 0, salary: rules.salary, cash: rules.cash, autoSeconds: 0, maxRounds: rules.maxRounds, blitz: rules.blitz };
  if (rules.tickets) game.settings.tickets = true;
  if (rules.leaderRent) game.settings.leaderRent = true;
  if (rules.buildHere) game.settings.buildHere = true;
  if (rules.buildOne) game.settings.buildOne = true;
  if (rules.buildOnBuy) game.settings.buildOnBuy = true;
  startGame(game, new Set(game.players.map((player) => player.id)), 0, rng);
  const order = [...game.order];
  const worthNow = () => order.map((id) => netWorth(game, id));
  const seen: MatchSeen = { reason: "time", rounds: 0, ranking: [], worth: [], order, turns: [], bankruptcies: 0 };
  const modded = Object.keys(mods).length > 0;
  for (let turn = 0; turn < 20_000 && game.phase === "playing"; turn++) {
    const me = currentPlayer(game)!;
    const seat = game.players.indexOf(me);
    const brief = briefFor(asMatch(game, rules), seat);
    if (!brief) throw new Error(`no brief for ${me.id}`);
    const book = books[seat] ?? DEFAULT_PLAYBOOK;
    const chosen = typeof book === "function" ? book(brief) : book;
    const plan = "buy_reserve" in chosen ? chosen : playbookPlan(brief, chosen).plan;
    const round = game.round;
    game.log = [];
    const played = playTurn(game, me.id, plan, rng, (now, id) => {
      if (modded) applyMods(now, id, mods, now.log);
      now.log = [];
    });
    seen.turns.push(played);
    if (played.bankrupt) seen.bankruptcies += 1;
    if (game.round > round || over(game)) seen.worth.push(worthNow());
  }
  if (!over(game) || !game.result) throw new Error(`match ${seed} did not end`);
  // Whatever the rules, modelled ones included: every coin on the table was issued by the bank.
  if (game.players.reduce((sum, player) => sum + player.cash, 0) !== game.minted) throw new Error(`match ${seed} made or lost money`);
  return { ...seen, reason: game.result.reason, rounds: game.round, ranking: game.result.ranking };
}

// ----- The table's clock --------------------------------------------------------------------------------------------

/** What the client spends on each thing, in ms. */
export type Pace = {
  /** scene/layout.ts THROW_MS + SETTLE_MS: the dice, then a look at them. */
  dice: number;
  /** A square walked: scene/layout.ts TILE over the chibi's WALK_SPEED times the scene's HOP_SPEED. */
  square: number;
  /** TycoonScreen DWELL_MS, CARD_MS, LEG_MS. */
  dwell: number;
  card: number;
  leg: number;
  /** chain/room.ts: how long the room waits before it ends a turn with nothing left to decide. */
  autoEnd: number;
  /** A purchase, or a house, that leaves nothing to decide goes out with the end of the turn. */
  endWithMove: boolean;
  /** A turn with nothing to decide is ended when the chain shows the roll, not when the piece has arrived. */
  endOnRoll: boolean;
  /** lib/chain/config.ts pollMs on mainnet: how often the match is read. */
  poll: number;
  /** The page that asked the server for an agent's turn reads the match when the answer comes, not at its next poll. */
  readOnAnswer: boolean;
  /** A transaction, from sending it to reading its result (README: about 2 s, measured on testnet; then the re-read). */
  tx: number;
  /** An agent's plan: the server reads the match and asks its model. About nothing for the playbook. */
  plan: number;
  /** A person: until they throw, decide on a square, pick houses, settle a debt. */
  react: number;
  thinkBuy: number;
  thinkBuild: number;
  thinkDebt: number;
};

/** The client as it was: the end of a turn was its own transaction, sent 1.8 s after the piece had arrived. */
export const PACE_BEFORE: Pace = {
  dice: 1650,
  square: 240,
  dwell: 700,
  card: 2800,
  leg: 1600,
  autoEnd: 1800,
  endWithMove: false,
  endOnRoll: false,
  poll: 1300,
  readOnAnswer: false,
  tx: 2500,
  plan: 300,
  react: 2000,
  thinkBuy: 2500,
  thinkBuild: 3000,
  thinkDebt: 5000,
};

/**
 * The client as it is now: the end of a turn no longer waits for the piece, nor travels alone after a purchase
 * (chain/room.ts), and an agent's turn is read as soon as the server has played it (chain/useFree.ts).
 */
export const PACE_NOW: Pace = { ...PACE_BEFORE, autoEnd: 0, endWithMove: true, endOnRoll: true, readOnAnswer: true };

/** The same client with people who take their time and agents that ask a model: twice the thinking, 2.5 s a plan. */
export const unhurried = (pace: Pace): Pace => ({ ...pace, plan: 2500, react: 2 * pace.react, thinkBuy: 2 * pace.thinkBuy, thinkBuild: 2 * pace.thinkBuild, thinkDebt: 2 * pace.thinkDebt });

/** Seconds a match takes on the table. `human(playerId)`: whether a person plays that seat (else an agent, one transaction a turn). */
export function tableSeconds(match: MatchSeen, pace: Pace, human: (playerId: string) => boolean): number {
  // Two clocks: when the chain has a state, and when the board has finished showing it. A roll is shown only after
  // the one before has arrived and stayed for a moment (TycoonScreen `useRollPace`).
  let chain = 0;
  let boardFree = 0;
  let arrived = 0;
  const show = (roll: RollSeen, from: number): number => {
    const walk = pace.dice + Math.min(roll.steps, 12) * pace.square + (roll.sentOn ? (roll.card ? pace.card : 0) + pace.leg : 0);
    arrived = Math.max(from, boardFree) + (roll.steps > 0 || roll.sentOn ? walk : pace.dice);
    boardFree = arrived + pace.dwell;
    return arrived;
  };
  for (const turn of match.turns) {
    if (!human(turn.player)) {
      // Whoever has the match open sees the turn at their next read and asks the server; one transaction plays it.
      const read = pace.readOnAnswer ? 0 : pace.poll / 2;
      chain += read + pace.plan + pace.tx;
      const seenAt = chain + read;
      for (const roll of turn.rolls) show(roll, seenAt);
      continue;
    }
    // A person throws once the board shows the present. Each roll is a transaction, and so is what they do after it.
    let ready = Math.max(chain, arrived);
    // A ticket played before the throw goes out with it, after a moment's thought.
    const before = (turn.tickets ?? []).filter((ticket) => ticket !== "takeover").length;
    for (const [i, roll] of turn.rolls.entries()) {
      const landed = ready + pace.react + (i === 0 ? before * pace.thinkBuy : 0) + pace.tx;
      let at = show(roll, landed);
      // A Takeover is a move on the square, thought over like a purchase.
      if (i === turn.rolls.length - 1 && turn.tickets?.includes("takeover")) at += pace.thinkBuy + pace.tx;
      if (roll.debt) at += pace.thinkDebt + pace.tx;
      if (roll.offered) at += pace.thinkBuy;
      if (roll.couldBuild) at += pace.thinkBuild;
      // Moves made on the square: a purchase or a pass, houses. They show at once and are sent as they are made.
      const moves = (roll.offered ? 1 : 0) + roll.built;
      if (i < turn.rolls.length - 1) {
        ready = at + (moves > 0 ? pace.tx : 0);
        continue;
      }
      if (turn.bankrupt) chain = at;
      // Something could be built: the turn is the player's to end, with a press that follows whatever they did.
      else if (roll.couldBuild && !(pace.endWithMove && moves === 1 && roll.built === 1)) chain = at + (moves > 0 ? 2 : 1) * pace.tx;
      else if (moves > 0) chain = pace.endWithMove ? at + pace.tx : at + pace.tx + pace.autoEnd + pace.tx;
      // Nothing to decide: the room ends the turn, once the piece has arrived or as soon as the chain shows the roll.
      else chain = pace.endOnRoll && !roll.debt ? landed + pace.tx : at + pace.autoEnd + pace.tx;
    }
  }
  return Math.max(chain, boardFree) / 1000;
}

// ----- Many matches -------------------------------------------------------------------------------------------------

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
const quantile = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(q * values.length))] ?? 0;

export type Spread = { mean: number; p10: number; p90: number };
export type Report = {
  games: number;
  /** Share of matches that ran out of rounds (the rest ended with one seat standing). */
  byRounds: number;
  rounds: Spread;
  turns: number;
  /** Share of matches won by whoever led on net worth after a third and after half of the rounds played. */
  leaderWins: { third: number; half: number };
  /** Share of matches won by whoever was last after half of the rounds played. */
  lastWins: number;
  /** Times the lead changed hands, per match. */
  leadChanges: number;
  /** The leader's share of all the net worth on the table, after a quarter, half, three quarters and all of the rounds. */
  gap: number[];
  /** Seats bankrupt per match, and houses put up. */
  bankruptcies: number;
  houses: number;
  /**
   * Minutes on the table: one person against agents (`solo`) and a table of people (`people`), at the pace given;
   * `slow`: the same with people who take their time and agents that ask a model (`unhurried`).
   */
  minutes: { solo: Spread; people: Spread; slow: { solo: Spread; people: Spread } };
  /**
   * Only for rules with tickets, per ticket: how many were played a match, and the share of matches won by the seats
   * that played at least one against the share won by the seats that played none (`null`: no such seat).
   */
  tickets?: Record<Ticket, { played: number; winsWith: number | null; winsWithout: number | null }>;
};

const leaderOf = (worth: number[]): number | null => {
  const best = Math.max(...worth);
  return worth.filter((value) => value === best).length === 1 ? worth.indexOf(best) : null;
};
const lastOf = (worth: number[]): number | null => {
  const least = Math.min(...worth);
  return worth.filter((value) => value === least).length === 1 ? worth.indexOf(least) : null;
};

export function measure(seats: number, rules: Rules, games: number, seed: number, pace: Pace, mods: Mods = {}, books: Book[] = []): Report {
  const rounds: number[] = [];
  const minutes: number[][] = [[], [], [], []];
  const gap = [0, 0, 0, 0];
  const count = { byRounds: 0, turns: 0, third: 0, thirdOf: 0, half: 0, halfOf: 0, last: 0, lastOf: 0, changes: 0, bankruptcies: 0, houses: 0 };
  const slow = unhurried(pace);
  const byTicket = Object.fromEntries(TICKETS.map((ticket) => [ticket, { played: 0, withSeats: 0, withWins: 0, withoutSeats: 0, withoutWins: 0 }])) as unknown as Record<Ticket, Record<string, number>>;
  for (let g = 0; g < games; g++) {
    const match = playMatch(seats, rules, gameSeed(seed, g), mods, books);
    const winner = match.order.indexOf(match.ranking[0]);
    if (rules.tickets) {
      for (const ticket of TICKETS) {
        const users = new Set(match.turns.filter((turn) => turn.tickets?.includes(ticket)).map((turn) => turn.player));
        byTicket[ticket].played += match.turns.reduce((sum, turn) => sum + (turn.tickets ?? []).filter((one) => one === ticket).length, 0);
        for (const id of match.order) {
          const key = users.has(id) ? "with" : "without";
          byTicket[ticket][`${key}Seats`] += 1;
          if (id === match.ranking[0]) byTicket[ticket][`${key}Wins`] += 1;
        }
      }
    }
    const played = match.worth.length;
    rounds.push(match.rounds);
    if (match.reason === "time") count.byRounds += 1;
    count.turns += match.turns.length;
    count.bankruptcies += match.bankruptcies;
    count.houses += match.turns.reduce((sum, turn) => sum + turn.rolls.reduce((built, roll) => built + roll.built, 0), 0);
    const at = (part: number) => match.worth[Math.max(0, Math.ceil(played * part) - 1)];
    for (const [key, part] of [["third", 1 / 3], ["half", 1 / 2]] as const) {
      const leader = leaderOf(at(part));
      if (leader === null) continue;
      count[`${key}Of`] += 1;
      if (leader === winner) count[key] += 1;
    }
    const last = lastOf(at(1 / 2));
    if (last !== null) {
      count.lastOf += 1;
      if (last === winner) count.last += 1;
    }
    let lead: number | null = null;
    for (const worth of match.worth) {
      const now = leaderOf(worth);
      if (now !== null && lead !== null && now !== lead) count.changes += 1;
      if (now !== null) lead = now;
    }
    [0.25, 0.5, 0.75, 1].forEach((part, i) => {
      const worth = at(part);
      gap[i] += Math.max(...worth) / Math.max(1, worth.reduce((sum, value) => sum + value, 0));
    });
    const alone = (id: string) => id === "s0";
    [tableSeconds(match, pace, alone), tableSeconds(match, pace, () => true), tableSeconds(match, slow, alone), tableSeconds(match, slow, () => true)].forEach((seconds, i) => minutes[i].push(seconds / 60));
  }
  const spread = (values: number[]): Spread => ({ mean: mean(values), p10: quantile(values, 0.1), p90: quantile(values, 0.9) });
  return {
    games,
    byRounds: count.byRounds / games,
    rounds: spread(rounds),
    turns: count.turns / games,
    leaderWins: { third: count.third / Math.max(1, count.thirdOf), half: count.half / Math.max(1, count.halfOf) },
    lastWins: count.last / Math.max(1, count.lastOf),
    leadChanges: count.changes / games,
    gap: gap.map((sum) => sum / games),
    bankruptcies: count.bankruptcies / games,
    houses: count.houses / games,
    minutes: { solo: spread(minutes[0]), people: spread(minutes[1]), slow: { solo: spread(minutes[2]), people: spread(minutes[3]) } },
    ...(rules.tickets
      ? {
          tickets: Object.fromEntries(
            TICKETS.map((ticket) => {
              const of = byTicket[ticket];
              return [ticket, { played: of.played / games, winsWith: of.withSeats ? of.withWins / of.withSeats : null, winsWithout: of.withoutSeats ? of.withoutWins / of.withoutSeats : null }];
            }),
          ) as Report["tickets"],
        }
      : {}),
  };
}

/** A seat's playbook plan with only some tickets left in it (`keep`), for measuring what one ticket is worth alone. */
export const onlyTickets =
  (keep: Ticket[]): Book =>
  (brief) => {
    const { plan } = playbookPlan(brief, DEFAULT_PLAYBOOK);
    const tickets = Object.fromEntries(Object.entries(plan.tickets ?? {}).filter(([key]) => keep.includes(key as Ticket)));
    const { tickets: _, ...rest } = plan;
    return Object.keys(tickets).length > 0 ? { ...rest, tickets } : rest;
  };

/** Share of matches seat 0 wins when it plays by `mine` and every other seat by `theirs`. */
export function edge(seats: number, rules: Rules, games: number, seed: number, mine: Book, theirs: Book): number {
  let wins = 0;
  for (let g = 0; g < games; g++) if (playMatch(seats, rules, gameSeed(seed, g), {}, [mine, ...Array.from({ length: seats - 1 }, () => theirs)]).ranking[0] === "s0") wins += 1;
  return wins / games;
}

// ----- The report ---------------------------------------------------------------------------------------------------

const pct = (value: number) => `${Math.round(value * 100)}%`;
const one = (value: number) => value.toFixed(1);
const span = (spread: Spread) => `${one(spread.mean)} (${one(spread.p10)} to ${one(spread.p90)})`;

/** One set of rules as a few lines of text. */
export function describe(name: string, report: Report): string {
  const { rounds, minutes, leaderWins } = report;
  return [
    `  ${name}`,
    `    ends      after ${span(rounds)} rounds; out of rounds in ${pct(report.byRounds)} of matches; ${one(report.bankruptcies)} seats bankrupt and ${one(report.houses)} houses built a match`,
    `    minutes   one person against agents ${span(minutes.solo)}, a table of people ${span(minutes.people)}; unhurried: ${one(minutes.slow.solo.mean)} and ${one(minutes.slow.people.mean)}`,
    `    comeback  whoever leads after a third of the match wins ${pct(leaderWins.third)}, after half ${pct(leaderWins.half)}; whoever is last at half wins ${pct(report.lastWins)}; the lead changes ${one(report.leadChanges)} times`,
    `    gap       the leader holds ${report.gap.map(pct).join(", ")} of all net worth after a quarter, half, three quarters, the end`,
    ...(report.tickets
      ? [
          `    tickets   ${TICKETS.map((ticket) => {
            const of = report.tickets![ticket];
            const share = (value: number | null) => (value === null ? "n/a" : pct(value));
            return `${ticket} ${one(of.played)} a match, seats that played it win ${share(of.winsWith)} (those that did not ${share(of.winsWithout)})`;
          }).join("; ")}`,
        ]
      : []),
  ].join("\n");
}

/** The rules matches were opened with before, and are opened with now (chain/calls.ts). */
export const RULES_BEFORE = { cash: 1500, salary: 200, blitz: false };
/** Rules the contract does not have, as proposed: see `Mods`. */
export const PROPOSED: [string, Mods][] = [
  ["whoever leads on net worth pays double rent", { leaderRent: 2 }],
  ["whoever is last collects 3 salaries at Departure", { underdogSalary: 3 }],
  ["rents double in the last third of the rounds", { rentRamp: (round, maxRounds) => (round >= Math.floor((2 * maxRounds) / 3) ? 2 : 1) }],
  ["the first two together", { leaderRent: 2, underdogSalary: 3 }],
];

function main(): void {
  const args = process.argv.slice(2);
  const option = (name: string, fallback: string) => {
    const at = args.indexOf(`--${name}`);
    return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
  };
  const games = Number(option("games", "1000"));
  const seed = Number(option("seed", "1"));
  // --set "name:cash,salary,blitz,rounds" (any number of them) measures other rules than the ones kept here.
  const asked = args.flatMap((arg, i) => (arg === "--set" && args[i + 1] ? [args[i + 1]] : []));
  for (const seats of option("seats", "2,3,4").split(",").map(Number)) {
    console.log(`\n${seats} seats, ${games} matches each`);
    if (asked.length) {
      for (const text of asked) {
        const [name, values] = text.split(":");
        const [cash, salary, blitz, maxRounds] = values.split(",").map(Number);
        console.log(describe(name, measure(seats, { cash, salary, blitz: blitz === 1, maxRounds }, games, seed, PACE_NOW)));
      }
      continue;
    }
    const now = { ...RULES, maxRounds: roundsFor(seats) };
    console.log(describe("before: 1,500 in cash, nothing dealt, to the end; the client as it was", measure(seats, { ...RULES_BEFORE, maxRounds: TO_THE_END }, games, seed, PACE_BEFORE)));
    console.log(describe("before, the longest match with a limit: 12 rounds", measure(seats, { ...RULES_BEFORE, maxRounds: 12 }, games, seed, PACE_BEFORE)));
    console.log(describe(`now: Blitz, ${now.cash} in cash, ${now.maxRounds} rounds; the client as it is`, measure(seats, now, games, seed, PACE_NOW)));
    console.log(describe("now, to the end", measure(seats, { ...RULES, maxRounds: TO_THE_END }, games, seed, PACE_NOW)));
    if (args.includes("--proposal")) for (const [name, mods] of PROPOSED) console.log(describe(`proposed: ${name}`, measure(seats, now, games, seed, PACE_NOW, mods)));
    // The rules the contract has since tickets: measured on the engine itself, not modelled.
    if (args.includes("--tickets")) {
      const both = { ...now, tickets: true, leaderRent: true };
      console.log(describe("with the leader's rent alone", measure(seats, { ...now, leaderRent: true }, games, seed, PACE_NOW)));
      console.log(describe("with tickets alone", measure(seats, { ...now, tickets: true }, games, seed, PACE_NOW)));
      console.log(describe("with tickets and the leader's rent (what a match is opened with on a contract that has them)", measure(seats, both, games, seed, PACE_NOW)));
      console.log(describe("the same, building only where one stops (buildHere)", measure(seats, { ...both, buildHere: true }, games, seed, PACE_NOW)));
      console.log(describe("the same, one house a turn on a city of one's choice (buildOne)", measure(seats, { ...both, buildOne: true }, games, seed, PACE_NOW)));
      console.log(describe("nothing dealt, a house with the purchase and at each later stop (what a match is opened with now)", measure(seats, { ...both, blitz: false, buildOnBuy: true }, games, seed, PACE_NOW)));
      // What a ticket is worth: seat 0 alone plays it (or all four), nobody else plays any. An even table wins 1 in `seats`.
      const none = onlyTickets([]);
      const worth = [["none", []], ["all four", [...TICKETS]], ...TICKETS.map((ticket) => [ticket, [ticket]])] as [string, Ticket[]][];
      console.log(`    edge      seat 0 wins, playing only these tickets against seats that play none (even: ${pct(1 / seats)}): ${worth.map(([name, keep]) => `${name} ${pct(edge(seats, both, games, seed, onlyTickets(keep), none))}`).join(", ")}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
