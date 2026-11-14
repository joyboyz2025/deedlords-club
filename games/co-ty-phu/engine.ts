// Luật Cờ tỷ phú thuần túy, không phụ thuộc mạng hay trình duyệt. Server gọi các hàm này rồi lưu và phát kết quả.
// Mọi khoản tiền đều đi qua `pay`, nên tổng tiền mặt luôn bằng số tiền ngân hàng đã phát ra.
//
// This is the reference ("oracle") for the Rust port in `contracts/`: docs/ENGINE-RULES.md is the contract between the
// two. Every random value comes from an `Rng`, consumed only where and in the order that document fixes, so a trace of
// (actions, random values) replays step by step in Rust.

import { randomBelow } from "../../lib/random.ts";
import { lookFromSeat, type Look } from "../ma-soi/look.ts";
import {
  BOARD_SIZE,
  CARDS,
  DECK_NAMES,
  JAIL,
  JAIL_FINE,
  OWNABLE_SQUARES,
  SALARY,
  SQUARES,
  START_CASH,
  STATION_RENTS,
  UTILITY_TIMES,
  cityRents,
  groupSquares,
  houseCost,
  isOwnable,
  type Deck,
} from "./board.ts";
import { AUTO_CHOICES, CASH_CHOICES, LIMIT_CHOICES, SALARY_CHOICES, type Offer } from "./protocol.ts";

export const MIN_PLAYERS = 2;
export const MAX_SEATS = 6;
export const MAX_PEOPLE = 40;
/** Blitz: ownable squares dealt to each player at the start. */
export const BLITZ_DEAL = 5;
const MAX_LOG = 30;

export type Phase = "lobby" | "playing" | "ended";
/** `roll`: chờ đổ xúc xắc. `buy`: đứng ở đất chưa có chủ. `debt`: nợ nhiều hơn tiền mặt. `end`: đã đi xong, chờ kết thúc lượt. */
export type Stage = "roll" | "buy" | "debt" | "end";

/**
 * The only source of randomness (ENGINE-RULES §2). `die()` is 1..=6, `below(n)` is 0..=n-1. The engine calls it only
 * when starting (turn order, Blitz deal), rolling (two dice) and drawing a card, and never for a refused action.
 */
export interface Rng {
  die(): number;
  below(n: number): number;
}

/** Real randomness for the room server: unbiased, from `crypto.getRandomValues`. */
export const defaultRng: Rng = {
  die: () => randomBelow(6) + 1,
  below: (n) => randomBelow(n),
};

/** Fisher–Yates exactly as ENGINE-RULES §2 fixes it: `for i = len-1 down to 1: j = below(i+1); swap(i, j)`. */
export function shuffleWith<T>(items: readonly T[], rng: Rng): T[] {
  const result = [...items];
  for (let i = result.length - 1; i >= 1; i--) {
    const j = rng.below(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export type Player = {
  id: string;
  secret: string;
  name: string;
  isHost: boolean;
  /** Ở phòng chờ: muốn chơi ván tới. Đủ 6 người thì người sau chỉ xem. */
  wantsToPlay: boolean;
  /** Màu quân, `null` là không chơi ván này. */
  color: number | null;
  cash: number;
  position: number;
  /** `null` là đang tự do; 0, 1, 2 là số lần đã đổ mà chưa ra khỏi tạm giữ. */
  jail: number | null;
  /** Get-out-of-jail cards held, by the deck they came from. Cards are drawn with replacement, so nothing goes back. */
  freeCards: Deck[];
  bankrupt: boolean;
  /** Thứ tự bị loại, người bị loại sau xếp trên. */
  outAt: number | null;
  /** Nhân vật chibi đi trên bàn cờ 3D, dùng chung bảng đồ của Ma Sói. */
  look: Look;
};

export type Owned = { owner: string; houses: number; mortgaged: boolean };
/** A special ticket (ENGINE-RULES §10.2), in the order a draw picks them: `below(4)`. */
export const TICKETS = ["waiver", "steps", "takeover", "festival"] as const;
export type Ticket = (typeof TICKETS)[number];
/** Tickets a player may hold. */
export const MAX_TICKETS = 2;
/**
 * The ticket state of a game with `settings.tickets`. `held`: per seated player, oldest first. `waiver`: the current
 * player's Rent waiver is played and not used yet. `festival`: players whose Festival is on, in the order played.
 */
export type TicketState = { held: Record<string, Ticket[]>; waiver: boolean; festival: string[] };
export type Payee = { id: string | null; amount: number };
export type Trade = Offer & { from: string };
export type Result = { reason: "last" | "time"; ranking: string[] };

export type Settings = {
  limitMinutes: number;
  salary?: number;
  cash?: number;
  autoSeconds?: number;
  /** The game ends with reason `time` when `round` reaches this. 0 or missing: no round limit. */
  maxRounds?: number;
  /** Blitz rules (ENGINE-RULES §5). Missing: classic rules. */
  blitz?: boolean;
  /** Special tickets (ENGINE-RULES §10.2). Missing: none. */
  tickets?: boolean;
  /** Whoever leads on net worth pays double rent (ENGINE-RULES §10.1). Missing: off. */
  leaderRent?: boolean;
  /** Blitz builds only where the player stops: one house on the own city stood on, as in classic (ENGINE-RULES §10.5). */
  buildHere?: boolean;
};

export type Game = {
  phase: Phase;
  /**
   * `salary`: tiền nhận mỗi lần đi qua Xuất phát. `cash`: vốn mỗi người lúc vào ván. `autoSeconds`: người tới lượt để quá
   * chừng này giây thì máy bấm hộ, 0 là chờ mãi. Ván lưu từ trước khi có các lựa chọn này thì không có, tính theo mặc định.
   */
  settings: Settings;
  players: Player[];
  /** Thứ tự lượt, chỉ gồm người chơi ván này. */
  order: string[];
  turn: number;
  stage: Stage;
  dice: [number, number] | null;
  /** Số lần đổ đôi liền nhau trong lượt này. */
  doubles: number;
  /** Vừa đổ đôi nên được đổ tiếp. */
  again: boolean;
  /** Completed rounds: goes up by one each time the turn wraps around `order`. 0 at the start. */
  round: number;
  props: Record<number, Owned>;
  /** Khoản nợ đang chờ trả. `id` là `null` khi nợ ngân hàng. */
  debt: Payee[] | null;
  /** Đổ hỏng lần thứ ba trong tạm giữ mà không đủ tiền nộp phạt: trả xong nợ thì mới đi chừng này ô. */
  pendingMove: number | null;
  /** The card drawn this turn: `index` into `CARDS[deck]`. */
  card: { deck: Deck; index: number } | null;
  /** Ô đất của mình mà người đang tới lượt vừa dừng chân: được xây thêm một nhà ở đó, xây xong hay đi tiếp thì thôi. */
  buildAt?: number | null;
  /** Blitz: cities built on this turn, one house per city per turn. Always empty in classic rules. */
  builtThisTurn: number[];
  log: string[];
  trade: Trade | null;
  endsAt: number | null;
  /** Hết giờ: chơi nốt vòng này rồi tính tài sản. */
  lastRound: boolean;
  /** Tổng tiền ngân hàng đã phát ra trừ tiền đã thu về. Luôn bằng tổng tiền mặt của mọi người. */
  minted: number;
  rolls: number;
  result: Result | null;
  /** Only in a game with `settings.tickets`, from the start on (ENGINE-RULES §10.2). */
  tickets?: TicketState | null;
};

/** Mặc định chờ người tới lượt chừng này giây rồi máy bấm hộ. */
export const AUTO_SECONDS = 20;

export function createGame(): Game {
  return {
    phase: "lobby",
    settings: { limitMinutes: 45, salary: SALARY, cash: START_CASH, autoSeconds: AUTO_SECONDS },
    players: [],
    order: [],
    turn: 0,
    stage: "roll",
    dice: null,
    doubles: 0,
    again: false,
    round: 0,
    props: {},
    debt: null,
    pendingMove: null,
    card: null,
    buildAt: null,
    builtThisTurn: [],
    log: [],
    trade: null,
    endsAt: null,
    lastRound: false,
    minted: 0,
    rolls: 0,
    result: null,
  };
}

export function newPlayer(id: string, secret: string, name: string, isHost = false, look: Look = lookFromSeat(0)): Player {
  return { id, secret, name, isHost, wantsToPlay: true, color: null, cash: 0, position: 0, jail: null, freeCards: [], bankrupt: false, outAt: null, look };
}

const find = (game: Game, id: string | null | undefined) => game.players.find((p) => p.id === id);

export function currentPlayer(game: Game): Player | undefined {
  return game.phase === "playing" ? find(game, game.order[game.turn]) : undefined;
}

export function activePlayers(game: Game): Player[] {
  return game.order.map((id) => find(game, id)!).filter((p) => !p.bankrupt);
}

function note(game: Game, text: string): void {
  game.log.push(text);
  if (game.log.length > MAX_LOG) game.log.shift();
}

/** `null` là ngân hàng. */
function pay(game: Game, from: Player | null, to: Player | null, amount: number): void {
  if (from) from.cash -= amount;
  else game.minted += amount;
  if (to) to.cash += amount;
  else game.minted -= amount;
}

const total = (payees: Payee[]) => payees.reduce((sum, payee) => sum + payee.amount, 0);

/** Trả ngay nếu đủ tiền, không thì thành nợ: phải bán nhà, cầm cố hoặc phá sản. */
function charge(game: Game, payer: Player, payees: Payee[]): boolean {
  if (payer.cash < total(payees)) {
    game.debt = payees;
    game.stage = "debt";
    return false;
  }
  for (const payee of payees) pay(game, payer, find(game, payee.id) ?? null, payee.amount);
  return true;
}

const JAIL_NAME = SQUARES[JAIL].name;
const START_NAME = SQUARES[0].name;

// Phòng chờ

export function setLimit(game: Game, minutes: unknown): void {
  if (game.phase === "lobby" && LIMIT_CHOICES.some((choice) => choice === minutes)) game.settings = { ...game.settings, limitMinutes: minutes as number };
}

export function setSalary(game: Game, amount: unknown): void {
  if (game.phase === "lobby" && SALARY_CHOICES.some((choice) => choice === amount)) game.settings = { ...game.settings, salary: amount as number };
}

export function setStartCash(game: Game, amount: unknown): void {
  if (game.phase === "lobby" && CASH_CHOICES.some((choice) => choice === amount)) game.settings = { ...game.settings, cash: amount as number };
}

export function setAutoSeconds(game: Game, seconds: unknown): void {
  if (game.phase === "lobby" && AUTO_CHOICES.some((choice) => choice === seconds)) game.settings = { ...game.settings, autoSeconds: seconds as number };
}

/** Tiền nhận mỗi lần đi qua Xuất phát của ván này. */
export const salaryOf = (game: Pick<Game, "settings">) => game.settings.salary ?? SALARY;
/** Vốn mỗi người lúc vào ván. */
export const startCashOf = (game: Pick<Game, "settings">) => game.settings.cash ?? START_CASH;
/** Số giây chờ người tới lượt trước khi máy bấm hộ, 0 là chờ mãi. */
export const autoSecondsOf = (game: Pick<Game, "settings">) => game.settings.autoSeconds ?? AUTO_SECONDS;
/** Round limit of this game, 0 is none. */
export const maxRoundsOf = (game: Pick<Game, "settings">) => game.settings.maxRounds ?? 0;
/** Whether this game uses the Blitz rules. */
export const isBlitz = (game: Pick<Game, "settings">) => game.settings.blitz ?? false;

export function setPlaying(game: Game, playerId: string, on: unknown): void {
  const player = find(game, playerId);
  if (game.phase === "lobby" && player && typeof on === "boolean") player.wantsToPlay = on;
}

/** Những người sẽ vào ván: muốn chơi, đang có mặt, tối đa 6 người theo thứ tự vào phòng. */
export function seatedPlayers(game: Game, online: Set<string>): Player[] {
  return game.players.filter((p) => p.wantsToPlay && online.has(p.id)).slice(0, MAX_SEATS);
}

export function startProblem(game: Game, online: Set<string>): string | null {
  const count = seatedPlayers(game, online).length;
  return count < MIN_PLAYERS ? `Need at least ${MIN_PLAYERS} players, have ${count}` : null;
}

function resetPlayer(player: Player): void {
  Object.assign(player, { color: null, cash: 0, position: 0, jail: null, freeCards: [], bankrupt: false, outAt: null });
}

/**
 * Seats the players, shuffles the turn order (Fisher–Yates over the seated ids in seating order) and, in Blitz, deals
 * the ownable squares. `rng` is only for tests and traces.
 */
export function startGame(game: Game, online: Set<string>, now: number, rng: Rng = defaultRng): void {
  if (game.phase !== "lobby" || startProblem(game, online)) return;
  const seated = seatedPlayers(game, online);
  const cash = startCashOf(game);
  game.players.forEach(resetPlayer);
  seated.forEach((player, i) => Object.assign(player, { color: i, cash }));
  Object.assign(game, {
    phase: "playing",
    order: shuffleWith(
      seated.map((p) => p.id),
      rng,
    ),
    turn: 0,
    stage: "roll",
    dice: null,
    doubles: 0,
    again: false,
    round: 0,
    props: {},
    debt: null,
    pendingMove: null,
    card: null,
    buildAt: null,
    builtThisTurn: [],
    log: [],
    trade: null,
    endsAt: game.settings.limitMinutes > 0 ? now + game.settings.limitMinutes * 60_000 : null,
    lastRound: false,
    minted: cash * seated.length,
    rolls: 0,
    result: null,
  });
  // Games saved before cards were drawn with replacement still carry their shuffled decks.
  delete (game as { decks?: unknown }).decks;
  if (isBlitz(game)) dealBlitz(game, rng);
  // Tickets (ENGINE-RULES §10.2): one each, in turn order, after the deal.
  delete game.tickets;
  if (game.settings.tickets) {
    game.tickets = { held: Object.fromEntries(seated.map((p) => [p.id, []])), waiver: false, festival: [] };
    for (const id of game.order) drawTicket(game, find(game, id)!, rng);
  }
  note(game, `${find(game, game.order[0])!.name} goes first.`);
}

export const TICKET_NAMES: Record<Ticket, string> = { waiver: "Rent waiver", steps: "Pick your steps", takeover: "Takeover", festival: "Festival" };

/** One more ticket for the player, `below(4)`, unless they hold two (then nothing is drawn). */
function drawTicket(game: Game, player: Player, rng: Rng): void {
  if (!game.tickets) return;
  const held = (game.tickets.held[player.id] ??= []);
  if (held.length >= MAX_TICKETS) return;
  const ticket = TICKETS[rng.below(TICKETS.length)];
  held.push(ticket);
  note(game, `${player.name} gets a ticket: ${TICKET_NAMES[ticket]}.`);
}

/** Tickets `playerId` holds, oldest first (none without the ticket rules). */
export const ticketsOf = (game: Pick<Game, "tickets">, playerId: string): Ticket[] => game.tickets?.held[playerId] ?? [];

/** Removes the first `ticket` the player holds. `false`: they hold none. */
function takeTicket(game: Game, player: Player, ticket: Ticket): boolean {
  const held = game.tickets?.held[player.id];
  const at = held ? held.indexOf(ticket) : -1;
  if (!held || at < 0) return false;
  held.splice(at, 1);
  return true;
}

/** "Before a throw": the same moment a roll is allowed. */
const canThrow = (game: Game) => game.stage === "roll" || (game.stage === "end" && game.again);

/** Whether the current player `playerId` may play `ticket` now, whatever it then needs (the steps, the city stood on). */
export function canPlay(game: Game, playerId: string, ticket: Ticket): boolean {
  const player = currentPlayer(game);
  if (!player || player.id !== playerId || !game.tickets || !ticketsOf(game, playerId).includes(ticket)) return false;
  if (ticket === "takeover") return canTakeover(game, playerId);
  if (!canThrow(game)) return false;
  if (ticket === "waiver") return !game.tickets.waiver;
  if (ticket === "festival") return !game.tickets.festival.includes(playerId);
  return player.jail === null;
}

/** Rent waiver: the next rent owed this turn is not charged. */
export function playWaiver(game: Game, playerId: string): void {
  const player = currentPlayer(game);
  if (!player || !canPlay(game, playerId, "waiver") || !takeTicket(game, player, "waiver")) return;
  game.tickets!.waiver = true;
  note(game, `${player.name} plays a Rent waiver: the next rent this turn is not charged.`);
}

/** Festival: the player's cities charge double rent until their next turn starts. */
export function playFestival(game: Game, playerId: string): void {
  const player = currentPlayer(game);
  if (!player || !canPlay(game, playerId, "festival") || !takeTicket(game, player, "festival")) return;
  game.tickets!.festival.push(player.id);
  note(game, `${player.name} plays a Festival: double rent in their cities until their next turn.`);
}

/** "Pick your steps": a throw whose dice are chosen, 2 to 12. No second throw for a double, and it does not count as one. */
export function playSteps(game: Game, playerId: string, steps: unknown, rng: Rng = defaultRng): void {
  const player = currentPlayer(game);
  if (typeof steps !== "number" || !Number.isInteger(steps) || steps < 2 || steps > 12) return;
  if (!player || !canPlay(game, playerId, "steps") || !takeTicket(game, player, "steps")) return;
  const a = Math.min(6, steps - 1);
  game.dice = [a, steps - a];
  game.rolls += 1;
  game.card = null;
  game.again = false;
  game.buildAt = null;
  note(game, `${player.name} plays Pick your steps and moves ${steps}.`);
  moveBy(game, player, steps, rng);
}

/** Whether the current player `playerId` holds a Takeover and stands on a city it can take: another's, no house, not mortgaged, twice its price in cash. */
export function canTakeover(game: Game, playerId: string): boolean {
  const player = currentPlayer(game);
  if (!player || player.id !== playerId || !game.tickets || game.stage !== "end" || !ticketsOf(game, playerId).includes("takeover")) return false;
  const square = SQUARES[player.position];
  const owned = game.props[player.position];
  return square.kind === "city" && !!owned && owned.owner !== playerId && owned.houses === 0 && !owned.mortgaged && player.cash >= 2 * square.price;
}

/** Takeover: the city stood on changes hands for twice its price, paid to its owner. */
export function takeover(game: Game, playerId: string): void {
  const player = currentPlayer(game);
  if (!player || !canTakeover(game, playerId) || !takeTicket(game, player, "takeover")) return;
  const square = SQUARES[player.position];
  const owned = game.props[player.position];
  const owner = find(game, owned.owner)!;
  const amount = isOwnable(square) ? 2 * square.price : 0;
  pay(game, player, owner, amount);
  owned.owner = player.id;
  note(game, `${player.name} plays a Takeover: ${square.name} from ${owner.name} for ${amount}.`);
}

/** Blitz: shuffle the ownable squares; the k-th player in turn order buys entries [5k, 5k+5) at full price. */
function dealBlitz(game: Game, rng: Rng): void {
  const deal = shuffleWith(OWNABLE_SQUARES, rng);
  game.order.forEach((id, k) => {
    const player = find(game, id)!;
    for (const index of deal.slice(BLITZ_DEAL * k, BLITZ_DEAL * (k + 1))) {
      const square = SQUARES[index];
      if (!isOwnable(square)) continue;
      pay(game, player, null, square.price);
      game.props[index] = { owner: id, houses: 0, mortgaged: false };
    }
  });
  note(game, `Blitz: each player is dealt ${BLITZ_DEAL} properties.`);
}

export function returnToLobby(game: Game): void {
  game.players.forEach(resetPlayer);
  Object.assign(game, { ...createGame(), settings: game.settings, players: game.players });
}

// Đi quân

/**
 * `dice` is only for tests: when given, no die is drawn. A refused roll consumes no randomness: the dice come from
 * `rng` (first die, then second) only after the roll is known to be legal, then any card the move draws.
 */
export function roll(game: Game, playerId: string, dice?: [number, number] | null, rng: Rng = defaultRng): void {
  const player = currentPlayer(game);
  const canRoll = game.stage === "roll" || (game.stage === "end" && game.again);
  if (!player || player.id !== playerId || !canRoll) return;
  const a = dice ? dice[0] : rng.die();
  const b = dice ? dice[1] : rng.die();
  game.dice = [a, b];
  game.rolls += 1;
  game.card = null;
  game.again = false;
  game.buildAt = null;
  const double = a === b;

  if (player.jail !== null) {
    if (double) {
      player.jail = null;
      note(game, `${player.name} rolls a double ${a}-${b} and leaves ${JAIL_NAME}.`);
      return moveBy(game, player, a + b, rng);
    }
    player.jail += 1;
    if (player.jail < 3) {
      note(game, `${player.name} rolls ${a}-${b} and stays in ${JAIL_NAME}.`);
      game.stage = "end";
      return;
    }
    // Lần thứ ba vẫn hỏng: nộp phạt rồi đi.
    player.jail = null;
    note(game, `${player.name} fails a third time, pays ${JAIL_FINE} and leaves ${JAIL_NAME}.`);
    if (!charge(game, player, [{ id: null, amount: JAIL_FINE }])) {
      game.pendingMove = a + b;
      return;
    }
    return moveBy(game, player, a + b, rng);
  }

  if (double) {
    game.doubles += 1;
    if (game.doubles === 3) {
      note(game, `${player.name} rolls doubles three times in a row and goes to ${JAIL_NAME}.`);
      return sendToJail(game, player);
    }
  }
  game.again = double;
  note(game, `${player.name} rolls ${a}-${b}${double ? " and rolls again" : ""}.`);
  moveBy(game, player, a + b, rng);
}

function moveBy(game: Game, player: Player, steps: number, rng: Rng): void {
  const to = (player.position + steps) % BOARD_SIZE;
  if (to < player.position) passStart(game, player, rng);
  player.position = to;
  land(game, player, rng);
}

/** Đi thẳng tới ô `to`, đi qua Xuất phát thì nhận lương. */
function moveTo(game: Game, player: Player, to: number, rng: Rng, rent?: { double?: boolean; utility?: boolean }): void {
  if (to < player.position) passStart(game, player, rng);
  player.position = to;
  land(game, player, rng, rent);
}

function passStart(game: Game, player: Player, rng: Rng): void {
  const salary = salaryOf(game);
  pay(game, null, player, salary);
  note(game, `${player.name} passes ${START_NAME} and collects ${salary}.`);
  drawTicket(game, player, rng);
}

function sendToJail(game: Game, player: Player): void {
  player.position = JAIL;
  player.jail = 0;
  game.again = false;
  game.stage = "end";
}

function ownsGroup(game: Game, owner: string, group: number): boolean {
  return groupSquares(group).every((i) => game.props[i]?.owner === owner);
}

function countOwned(game: Game, owner: string, kind: "station" | "utility"): number {
  return SQUARES.filter((square, i) => square.kind === kind && game.props[i]?.owner === owner).length;
}

/** Tiền thuê khi đứng ở ô `index`. Thẻ "gần nhất" làm bến xe gấp đôi và điện nước gấp 10 lần số chấm. */
export function rentFor(game: Game, index: number, diceTotal: number, rent: { double?: boolean; utility?: boolean } = {}): number {
  const square = SQUARES[index];
  const owned = game.props[index];
  if (!owned || owned.mortgaged) return 0;
  if (square.kind === "city") {
    const rents = cityRents(square.price);
    if (owned.houses > 0) return rents[owned.houses];
    return ownsGroup(game, owned.owner, square.group) ? rents[0] * 2 : rents[0];
  }
  if (square.kind === "station") return STATION_RENTS[countOwned(game, owned.owner, "station") - 1] * (rent.double ? 2 : 1);
  if (square.kind === "utility") return diceTotal * (rent.utility ? 10 : UTILITY_TIMES[countOwned(game, owned.owner, "utility") - 1]);
  return 0;
}

/** Why a rent is raised, as the log says it. */
export const raiseLine = (payer: string, raised: { festival: boolean; leader: boolean }): string =>
  raised.festival && raised.leader
    ? `Triple rent for ${payer}: a Festival is on here, and the leader pays double.`
    : raised.festival
      ? `Double rent for ${payer}: a Festival is on here.`
      : `Double rent for ${payer}: the leader on net worth pays double.`;

/** Whether `playerId` leads: their net worth is strictly above that of every other player still in the game. */
export function leads(game: Game, playerId: string): boolean {
  const player = find(game, playerId);
  if (!player || player.bankrupt) return false;
  const others = activePlayers(game).filter((other) => other.id !== playerId);
  const mine = netWorth(game, playerId);
  return others.length > 0 && others.every((other) => netWorth(game, other.id) < mine);
}

/**
 * What `payerId` owes landing on `index` (ENGINE-RULES §10.3): `rentFor`, once more on a city whose owner's Festival
 * is on, once more when the leader's rent is on and the payer leads.
 */
export function rentDue(game: Game, payerId: string, index: number, diceTotal: number, rent: { double?: boolean; utility?: boolean } = {}): number {
  const { festival, leader } = rentRaises(game, payerId, index);
  return rentFor(game, index, diceTotal, rent) * (1 + (festival ? 1 : 0) + (leader ? 1 : 0));
}

/** Why `payerId` owes more than the base rent on `index`: the owner's Festival is on (a city), the payer leads. */
export function rentRaises(game: Game, payerId: string, index: number): { festival: boolean; leader: boolean } {
  const owned = game.props[index];
  if (!owned) return { festival: false, leader: false };
  const festival = SQUARES[index].kind === "city" && !!game.tickets?.festival.includes(owned.owner);
  return { festival, leader: !!game.settings.leaderRent && leads(game, payerId) };
}

function land(game: Game, player: Player, rng: Rng, rent?: { double?: boolean; utility?: boolean }): void {
  const square = SQUARES[player.position];
  game.stage = "end";
  if (isOwnable(square)) {
    const owned = game.props[player.position];
    if (!owned) {
      game.stage = "buy";
      return;
    }
    // Dừng lại đúng đất của mình (không phải lần mua) thì được xây thêm một nhà ở đây.
    if (owned.owner === player.id) {
      if (square.kind === "city" && !owned.mortgaged) game.buildAt = player.position;
      return;
    }
    if (owned.mortgaged) return;
    const amount = rentDue(game, player.id, player.position, game.dice![0] + game.dice![1], rent);
    const owner = find(game, owned.owner)!;
    const raised = rentRaises(game, player.id, player.position);
    if (raised.festival || raised.leader) note(game, raiseLine(player.name, raised));
    if (game.tickets?.waiver) {
      game.tickets.waiver = false;
      note(game, `${player.name}'s Rent waiver covers ${amount} rent to ${owner.name} at ${square.name}.`);
      return;
    }
    note(game, `${player.name} pays ${owner.name} ${amount} rent at ${square.name}.`);
    charge(game, player, [{ id: owner.id, amount }]);
    return;
  }
  if (square.kind === "tax") {
    note(game, `${player.name} ${square.verb} ${square.amount}.`);
    charge(game, player, [{ id: null, amount: square.amount }]);
  } else if (square.kind === "card") {
    drawCard(game, player, square.deck, rng);
  } else if (square.kind === "arrest") {
    note(game, `${player.name} lands on ${square.name} and goes to ${JAIL_NAME}.`);
    sendToJail(game, player);
  }
}

/** Cards are drawn with replacement: `below(deck size)` picks the card, which stays in the deck for everyone. */
function drawCard(game: Game, player: Player, deck: Deck, rng: Rng): void {
  const index = rng.below(CARDS[deck].length);
  const { text, effect } = CARDS[deck][index];
  game.card = { deck, index };
  note(game, `${player.name} draws ${DECK_NAMES[deck]}: ${text}`);

  switch (effect.kind) {
    case "free":
      player.freeCards.push(deck);
      break;
    case "money":
      if (effect.amount > 0) pay(game, null, player, effect.amount);
      else charge(game, player, [{ id: null, amount: -effect.amount }]);
      break;
    case "goto":
      moveTo(game, player, effect.to, rng);
      break;
    case "back":
      player.position = (player.position - effect.steps + BOARD_SIZE) % BOARD_SIZE;
      land(game, player, rng);
      break;
    case "nearest": {
      let to = player.position;
      do to = (to + 1) % BOARD_SIZE;
      while (SQUARES[to].kind !== effect.type);
      moveTo(game, player, to, rng, effect.type === "station" ? { double: true } : { utility: true });
      break;
    }
    case "jail":
      sendToJail(game, player);
      break;
    case "each": {
      const others = activePlayers(game).filter((p) => p.id !== player.id);
      // Người khác phải trả ngoài lượt của họ thì chỉ trả bằng tiền mặt đang có, không thành nợ.
      if (effect.amount > 0) for (const other of others) pay(game, other, player, Math.min(other.cash, effect.amount));
      else charge(game, player, others.map((other) => ({ id: other.id, amount: -effect.amount })));
      break;
    }
    case "repairs": {
      const owned = Object.values(game.props).filter((o) => o.owner === player.id);
      const amount = owned.reduce((sum, o) => sum + (o.houses === 5 ? effect.hotel : o.houses * effect.house), 0);
      if (amount > 0) charge(game, player, [{ id: null, amount }]);
      break;
    }
  }
}

export function buy(game: Game, playerId: string): void {
  const player = currentPlayer(game);
  if (!player || player.id !== playerId || game.stage !== "buy") return;
  const square = SQUARES[player.position];
  if (!isOwnable(square) || player.cash < square.price) return;
  pay(game, player, null, square.price);
  game.props[player.position] = { owner: player.id, houses: 0, mortgaged: false };
  note(game, `${player.name} buys ${square.name} for ${square.price}.`);
  game.stage = "end";
}

/** Không mua thì đất vẫn để trống cho người sau, không đấu giá. */
export function skipBuying(game: Game, playerId: string): void {
  const player = currentPlayer(game);
  if (!player || player.id !== playerId || game.stage !== "buy") return;
  note(game, `${player.name} does not buy ${SQUARES[player.position].name}.`);
  game.stage = "end";
}

export function endTurn(game: Game, playerId: string): void {
  const player = currentPlayer(game);
  if (!player || player.id !== playerId || game.stage !== "end" || game.again) return;
  nextTurn(game);
}

/**
 * Người tới lượt để quá giờ: máy bấm hộ bước đang chờ. Chưa đổ thì đổ (đang tạm giữ thì đổ tìm đôi), vừa đổ đôi thì đổ tiếp,
 * đang hỏi mua đất thì bỏ qua, đi xong thì hết lượt. Mắc nợ thì không bấm hộ: bán gì, cầm cố gì phải để người đó chọn.
 * Trả về `true` nếu đã bấm hộ. Uses `rng` only when it rolls.
 */
export function autoAct(game: Game, rng: Rng = defaultRng): boolean {
  const player = currentPlayer(game);
  if (!player) return false;
  if (game.stage === "roll" || (game.stage === "end" && game.again)) {
    note(game, `${player.name} timed out; the game rolls for them.`);
    roll(game, player.id, null, rng);
    return true;
  }
  if (game.stage === "buy") {
    note(game, `${player.name} timed out and does not buy ${SQUARES[player.position].name}.`);
    game.stage = "end";
    return true;
  }
  if (game.stage === "end") {
    note(game, `${player.name} timed out; the game ends their turn.`);
    nextTurn(game);
    return true;
  }
  return false;
}

/**
 * Passes the turn to the next player still in the game. Wrapping around `order` completes a round; reaching
 * `maxRounds` ends the game right there (the turn does not advance).
 */
function nextTurn(game: Game): void {
  const count = game.order.length;
  let next = game.turn;
  do next = (next + 1) % count;
  while (find(game, game.order[next])!.bankrupt);
  if (next <= game.turn) {
    game.round = (game.round ?? 0) + 1;
    const maxRounds = maxRoundsOf(game);
    if (maxRounds > 0 && game.round >= maxRounds) return finish(game, "time");
    // Hết giờ thì vòng cuối xong khi lượt quay về đầu thứ tự.
    if (game.lastRound) return finish(game, "time");
  }
  // Thẻ vừa rút chỉ hiện trong lượt của người rút; diễn biến vẫn ghi lại.
  Object.assign(game, { turn: next, stage: "roll", doubles: 0, again: false, card: null, buildAt: null, builtThisTurn: [] });
  if (game.tickets) {
    game.tickets.waiver = false;
    game.tickets.festival = game.tickets.festival.filter((id) => id !== game.order[next]);
  }
}

// Tạm giữ

/** Nộp phạt trước khi đổ để ra ngay. */
export function payBail(game: Game, playerId: string): void {
  const player = currentPlayer(game);
  if (!player || player.id !== playerId || game.stage !== "roll" || player.jail === null || player.cash < JAIL_FINE) return;
  pay(game, player, null, JAIL_FINE);
  player.jail = null;
  note(game, `${player.name} pays ${JAIL_FINE} to leave ${JAIL_NAME}.`);
}

/** Uses the first card held. Nothing goes back to a deck: cards are drawn with replacement. */
export function useFreeCard(game: Game, playerId: string): void {
  const player = currentPlayer(game);
  if (!player || player.id !== playerId || game.stage !== "roll" || player.jail === null || player.freeCards.length === 0) return;
  player.freeCards.shift();
  player.jail = null;
  note(game, `${player.name} uses a card to leave ${JAIL_NAME}.`);
}

// Nợ và phá sản

/** Pays the whole debt. After a third failed jail roll the pending move follows, which may draw a card from `rng`. */
export function payDebt(game: Game, playerId: string, rng: Rng = defaultRng): void {
  const player = currentPlayer(game);
  if (!player || player.id !== playerId || game.stage !== "debt" || !game.debt || player.cash < total(game.debt)) return;
  for (const payee of game.debt) pay(game, player, find(game, payee.id) ?? null, payee.amount);
  note(game, `${player.name} pays off a debt of ${total(game.debt)}.`);
  game.debt = null;
  game.stage = "end";
  if (game.pendingMove !== null) {
    const steps = game.pendingMove;
    game.pendingMove = null;
    moveBy(game, player, steps, rng);
  }
}

/**
 * Bán hết nhà cho ngân hàng lấy nửa giá, rồi giao tiền, đất và thẻ ra tù cho chủ nợ.
 * Nợ ngân hàng hoặc nợ nhiều người cùng lúc thì đất về lại ngân hàng, xóa cầm cố, thẻ ra tù bỏ đi.
 */
function goBankrupt(game: Game, player: Player, creditorId: string | null): void {
  const creditor = find(game, creditorId) ?? null;
  for (const [index, owned] of Object.entries(game.props)) {
    if (owned.owner !== player.id) continue;
    if (owned.houses > 0) pay(game, null, player, (owned.houses * houseCost(Number(index))) / 2);
    if (creditor) Object.assign(owned, { owner: creditor.id, houses: 0 });
    else delete game.props[Number(index)];
  }
  pay(game, player, creditor, player.cash);
  if (creditor) creditor.freeCards.push(...player.freeCards);
  if (game.tickets) {
    if (game.tickets.held[player.id]) game.tickets.held[player.id] = [];
    game.tickets.festival = game.tickets.festival.filter((id) => id !== player.id);
  }
  const out = game.players.filter((p) => p.outAt !== null).length;
  Object.assign(player, { bankrupt: true, outAt: out + 1, jail: null, freeCards: [] });
  if (game.trade && (game.trade.from === player.id || game.trade.to === player.id)) game.trade = null;

  const wasCurrent = currentPlayer(game)?.id === player.id;
  if (wasCurrent) Object.assign(game, { debt: null, pendingMove: null });
  if (activePlayers(game).length === 1) return finish(game, "last");
  if (wasCurrent) nextTurn(game);
}

export function declareBankruptcy(game: Game, playerId: string): void {
  const player = currentPlayer(game);
  if (!player || player.id !== playerId || game.stage !== "debt" || !game.debt) return;
  const creditors = game.debt.filter((payee) => payee.id !== null);
  note(game, `${player.name} goes bankrupt.`);
  goBankrupt(game, player, game.debt.length === 1 && creditors.length === 1 ? creditors[0].id : null);
}

/**
 * Giving up (ENGINE-RULES §7, `resign`): any player still in the game, at any time. They leave the way a bankrupt
 * player does. In debt on their own turn the creditor is paid as in `declareBankruptcy`, so giving up is never a way
 * around a debt; at any other moment everything goes back to the bank. A debt the current player owes to somebody
 * who gives up is owed to the bank.
 */
export function resign(game: Game, playerId: string): void {
  const player = find(game, playerId);
  if (game.phase !== "playing" || !player || player.bankrupt || player.color === null) return;
  note(game, `${player.name} gives up.`);
  if (currentPlayer(game)?.id === player.id) {
    if (game.stage === "debt" && game.debt) {
      const creditors = game.debt.filter((payee) => payee.id !== null);
      return goBankrupt(game, player, game.debt.length === 1 && creditors.length === 1 ? creditors[0].id : null);
    }
  } else if (game.debt) {
    for (const payee of game.debt) if (payee.id === player.id) payee.id = null;
  }
  goBankrupt(game, player, null);
}

/** Người đang tới lượt rời ván quá lâu: bị loại, đất về ngân hàng. */
export function removeAbsent(game: Game, playerId: string): void {
  const player = find(game, playerId);
  if (game.phase !== "playing" || !player || player.bankrupt || player.color === null) return;
  note(game, `${player.name} was away for more than 10 minutes and is out.`);
  goBankrupt(game, player, null);
}

// Nhà và cầm cố, với đất của mình. Xây nhà chỉ khi quân dừng lại ở đất đó (Blitz: bất cứ thành phố nào của mình, mỗi lượt
// một nhà mỗi ô); bán nhà, cầm cố, chuộc thì lúc nào cũng được.

function ownCity(game: Game, playerId: string, index: unknown) {
  const player = find(game, playerId);
  const square = SQUARES[index as number];
  const owned = game.props[index as number];
  if (game.phase !== "playing" || !player || player.bankrupt || !square || square.kind !== "city" || owned?.owner !== playerId) return null;
  return { player, owned };
}

/**
 * Như cờ tỷ phú trên điện thoại: lần đầu dừng ở đất trống thì chỉ mua; những lần sau dừng lại đúng ô đất của mình
 * thì xây thêm được một nhà, đủ 4 nhà thì lần dừng sau lên khách sạn. Không cần đủ bộ màu, không xây khi đang mắc nợ.
 * Blitz: any own city, any time in your turn (except in debt), once per city per turn. Blitz with `buildHere`: as in
 * classic, only the own city just stopped on, one house per stop (ENGINE-RULES §10.5).
 */
export function canBuild(game: Game, playerId: string, index: number): boolean {
  const target = ownCity(game, playerId, index);
  if (!target || currentPlayer(game)?.id !== playerId || game.stage === "debt") return false;
  if (isBlitz(game) && !game.settings.buildHere ? (game.builtThisTurn ?? []).includes(index) : game.buildAt !== index) return false;
  const { player, owned } = target;
  return !owned.mortgaged && owned.houses < 5 && player.cash >= houseCost(index);
}

export function build(game: Game, playerId: string, index: unknown): void {
  if (typeof index !== "number" || !canBuild(game, playerId, index)) return;
  const { player, owned } = ownCity(game, playerId, index)!;
  pay(game, player, null, houseCost(index));
  owned.houses += 1;
  // Mỗi lần dừng chỉ xây một nhà.
  game.buildAt = null;
  if (isBlitz(game)) game.builtThisTurn = [...(game.builtThisTurn ?? []), index];
  note(game, `${player.name} builds ${owned.houses === 5 ? "a hotel" : `house ${owned.houses}`} in ${SQUARES[index].name}.`);
}

/** Bán từng nhà ở ô nào cũng được. Ngân hàng trả nửa giá. */
export function canSell(game: Game, playerId: string, index: number): boolean {
  const target = ownCity(game, playerId, index);
  return !!target && target.owned.houses > 0;
}

export function sellHouse(game: Game, playerId: string, index: unknown): void {
  if (typeof index !== "number" || !canSell(game, playerId, index)) return;
  const { player, owned } = ownCity(game, playerId, index)!;
  owned.houses -= 1;
  pay(game, null, player, houseCost(index) / 2);
  note(game, `${player.name} sells a house in ${SQUARES[index].name}.`);
}

function ownProperty(game: Game, playerId: string, index: unknown) {
  const player = find(game, playerId);
  const square = SQUARES[index as number];
  const owned = game.props[index as number];
  if (game.phase !== "playing" || !player || player.bankrupt || !square || !isOwnable(square) || owned?.owner !== playerId) return null;
  return { player, owned, square };
}

/** Ô còn nhà thì phải bán hết nhà mới cầm cố được. */
export function canMortgage(game: Game, playerId: string, index: number): boolean {
  const target = ownProperty(game, playerId, index);
  return !!target && !target.owned.mortgaged && target.owned.houses === 0;
}

export function mortgage(game: Game, playerId: string, index: unknown): void {
  if (typeof index !== "number" || !canMortgage(game, playerId, index)) return;
  const { player, owned, square } = ownProperty(game, playerId, index)!;
  owned.mortgaged = true;
  pay(game, null, player, square.price / 2);
  note(game, `${player.name} mortgages ${square.name} for ${square.price / 2}.`);
}

/** Chuộc lại phải trả thêm 10%. */
export function redeemPrice(index: number): number {
  const square = SQUARES[index];
  // Tính bằng số nguyên: nửa giá nhân 1,1 bằng số thực sẽ lệch 1.
  return isOwnable(square) ? Math.ceil((square.price * 11) / 20) : 0;
}

export function redeem(game: Game, playerId: string, index: unknown): void {
  const target = typeof index === "number" ? ownProperty(game, playerId, index) : null;
  if (!target || !target.owned.mortgaged || target.player.cash < redeemPrice(index as number)) return;
  pay(game, target.player, null, redeemPrice(index as number));
  target.owned.mortgaged = false;
  note(game, `${target.player.name} redeems ${target.square.name}.`);
}

// Đổi đất và tiền giữa hai người

/** Đất đổi được: của người đó và không có nhà. */
function tradable(game: Game, ownerId: string, indexes: unknown): indexes is number[] {
  return (
    Array.isArray(indexes) &&
    new Set(indexes).size === indexes.length &&
    indexes.every((i) => {
      const square = SQUARES[i];
      return !!square && isOwnable(square) && game.props[i]?.owner === ownerId && game.props[i].houses === 0;
    })
  );
}

function validOffer(game: Game, from: Player, offer: Offer): boolean {
  const to = find(game, offer.to);
  const cash = (value: unknown, max: number) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= max;
  return (
    !!to &&
    to.id !== from.id &&
    to.color !== null &&
    !to.bankrupt &&
    tradable(game, from.id, offer.give) &&
    tradable(game, to.id, offer.take) &&
    cash(offer.giveCash, from.cash) &&
    cash(offer.takeCash, to.cash) &&
    offer.give.length + offer.take.length + offer.giveCash + offer.takeCash > 0
  );
}

export function proposeTrade(game: Game, playerId: string, offer: Offer): void {
  const from = find(game, playerId);
  if (game.phase !== "playing" || game.trade || !from || from.color === null || from.bankrupt || !offer || !validOffer(game, from, offer)) return;
  const { to, give, take, giveCash, takeCash } = offer;
  game.trade = { from: from.id, to, give, take, giveCash, takeCash };
}

export function answerTrade(game: Game, playerId: string, accept: boolean): void {
  const trade = game.trade;
  if (!trade || trade.to !== playerId) return;
  game.trade = null;
  const from = find(game, trade.from)!;
  const to = find(game, trade.to)!;
  if (!accept) return note(game, `${to.name} declines the trade with ${from.name}.`);
  // Kiểm tra lại vì từ lúc đề nghị tới giờ có thể đã xây nhà hay tiêu tiền.
  if (!validOffer(game, from, trade)) return note(game, `${from.name}'s offer is no longer valid and is cancelled.`);
  for (const i of trade.give) game.props[i].owner = to.id;
  for (const i of trade.take) game.props[i].owner = from.id;
  pay(game, from, to, trade.giveCash);
  pay(game, to, from, trade.takeCash);
  note(game, `${from.name} and ${to.name} complete a trade.`);
}

export function withdrawTrade(game: Game, playerId: string): void {
  if (game.trade?.from === playerId) game.trade = null;
}

// Hết giờ và kết thúc

/** Value of one house for net worth: its cost, or in Blitz `floor(cost * 3 / 4)`. */
function houseWorth(game: Game, index: number): number {
  return isBlitz(game) ? Math.floor((houseCost(index) * 3) / 4) : houseCost(index);
}

/** Tiền mặt, giá đất (đất cầm cố tính nửa giá) và giá nhà đã xây. */
export function netWorth(game: Game, playerId: string): number {
  const player = find(game, playerId);
  if (!player || player.bankrupt) return 0;
  return Object.entries(game.props).reduce((sum, [key, owned]) => {
    const index = Number(key);
    const square = SQUARES[index];
    if (owned.owner !== playerId || !isOwnable(square)) return sum;
    return sum + (owned.mortgaged ? square.price / 2 : square.price) + owned.houses * houseWorth(game, index);
  }, player.cash);
}

/** Tới giờ thì báo vòng cuối. Trả về `true` nếu vừa đổi. */
export function checkTime(game: Game, now: number): boolean {
  if (game.phase !== "playing" || game.endsAt === null || now < game.endsAt || game.lastRound) return false;
  game.lastRound = true;
  note(game, "Time is up: this round is the last, then net worth decides.");
  return true;
}

/** Standing players by net worth (stable sort: ties keep turn order), then bankrupt players, last out first. */
function finish(game: Game, reason: Result["reason"]): void {
  const players = game.order.map((id) => find(game, id)!);
  const standing = players.filter((p) => !p.bankrupt).sort((a, b) => netWorth(game, b.id) - netWorth(game, a.id));
  const out = players.filter((p) => p.bankrupt).sort((a, b) => b.outAt! - a.outAt!);
  Object.assign(game, { phase: "ended", trade: null, debt: null, result: { reason, ranking: [...standing, ...out].map((p) => p.id) } });
}
