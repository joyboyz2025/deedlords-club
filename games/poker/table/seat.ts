// What a seat at a Deedlords Poker table of two to nine seats (contracts/poker-table) must send next, and what it can
// see. Everything a hand needs besides the choice of a bet is worked out here from the table on chain, so the page,
// the house and the test script (contracts/sandbox/poker-table-run.js) play through the same code.
//
// Imports only the crypto next to it, so node can load this file as it is.

import { type Keys, cardAt, openDeck, shares, tableKey, token } from "../crypto.ts";
import { shuffle } from "../shuffle.ts";

export type Phase = "lobby" | "shuffle" | "deal" | "bet" | "open" | "showdown";

/** How a hand ended. Lists are by seat. */
export type Hand = {
  number: number;
  /** The seats dealt in, the button first. */
  dealt: number[];
  board: number[];
  /** Hole cards, of the seats that showed them. */
  hole: number[][];
  folded: boolean[];
  put: number[];
  /** The chips each seat took from the middle. */
  won: number[];
  /** "cancelled": a seat did not answer and no card could be opened without it. "void" cannot happen with proved shuffles. */
  ending: "fold" | "showdown" | "cancelled" | "void";
  /** The seats that ran out of time. */
  late: number[];
};

/** `get_match` of the contract. Byte strings are base64; lists are by seat unless said otherwise. */
export type TableView = {
  id: string;
  phase: Phase;
  stake: string;
  /** What a seat attaches to sit down: the stake and the record fee. */
  deposit: string;
  host: string;
  /** The owner's fee this table was opened with, in basis points of what a seat wins (0: none). Taken when a seat is paid. */
  feeBps: number;
  /** `null`: nobody sits there. */
  players: (string | null)[];
  /** "" for an empty seat. */
  keys: string[];
  turnSeconds: number;
  deadline: string;
  chips: number[];
  hand: number;
  /** The seat with the button: it shuffles first. */
  button: number;
  /** The seats dealt into the hand under way, the button first; empty until the button has shuffled. */
  dealt: number[];
  /** The key the hand's cards are encrypted under; "" until the button has shuffled. */
  key: string;
  shuffled: number;
  street: number;
  toAct: number;
  awaited: number[];
  put: number[];
  bet: number[];
  folded: boolean[];
  done: boolean[];
  /** The seat asked to leave: it is paid when the hand is over. */
  leaving: boolean[];
  /** By deck position: the sum of the decryption shares given so far. */
  sums: string[];
  board: number[];
  hole: number[][];
  last: Hand | null;
  /** Every seat given up so far, and the chips it was paid for. */
  cashed: { account: string; chips: number }[];
  /** Counts the changes stored for the table: of two views, the one with the higher number is the newer. */
  seq: number;
  /** Counts the bets made at the table. A bet names the count it was chosen at, so that one sent twice lands once. */
  bets: number;
};

/** `get_result` of the contract, for a table that is settled. */
export type TableResult = { id: string; stake: string; feeBps: number; cashed: { account: string; chips: number; payout: string; fee: string }[]; hands: number };

export type Call = { method: string; args: Record<string, unknown> };

/** Where a seat reads the decks from. */
export type SeatStore = {
  /** The newest deck of hand `hand` when `step` shuffles came before it. The deck dealt is at step `dealt.length - 1`. */
  deck(hand: number, step: number): Promise<Uint8Array>;
};

/** The contract's answer to a bet sent again, or chosen on a view the table has moved past: nothing was bet. */
export const movedOn = (error: unknown): boolean => /the table moved on since this bet was chosen/.test(error instanceof Error ? error.message : String(error));

/**
 * Whether a call the node gave no receipt for shows in the table read afterwards (`after`; `null`: the table is
 * settled): `method` sent by `account`, for `seat` when it has one, on the table as it was `before`. That the table
 * changed says nothing: another seat's call changes it too. Only what this call alone could have changed counts.
 */
export function tookEffect(method: string, account: string, seat: number | null, before: TableView, after: TableView | null): boolean {
  if (!after) return method === "leave" || method === "timeout";
  const sameStep = after.hand === before.hand && after.phase === before.phase && after.street === before.street && after.shuffled === before.shuffled;
  if (method === "join") return after.players.includes(account);
  if (method === "start") return after.phase !== "lobby";
  if (method === "leave") return !after.players.includes(account) || (seat !== null && after.leaving[seat]);
  if (method === "act") return after.bets > before.bets;
  if (method === "timeout") return !sameStep || before.awaited.some((late) => !after.awaited.includes(late));
  // A shuffle, or shares: the hand is past the step, or no longer waits for this seat at it.
  return !sameStep || seat === null || !after.awaited.includes(seat);
}

export const toBase64 = (bytes: Uint8Array): string => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
export const fromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

/** The seats somebody sits in. */
export const seated = (view: TableView): number[] => view.players.flatMap((player, seat) => (player ? [seat] : []));
/** The seats the next hand is dealt to, the button first: who sits at the table now. */
export const nextDealt = (view: TableView): number[] => {
  const taken = seated(view);
  const first = Math.max(0, taken.indexOf(view.button));
  return taken.map((_, index) => taken[(first + index) % taken.length]);
};
/** The seats still in the hand: dealt in and not folded. */
export const contenders = (view: TableView): number[] => view.dealt.filter((seat) => !view.folded[seat]);

/** Deck positions: of the two hole cards of the seat dealt in at `place` (0 is the button), and of board card `index`. */
export const holeAt = (place: number): number[] => [2 * place, 2 * place + 1];
export const boardAt = (view: TableView, index: number): number => 2 * view.dealt.length + index;
/** The board cards a street turns up: three on the flop, then one. */
export const streetCards = (street: number): number[] => (street === 1 ? [0, 1, 2] : street === 2 ? [3] : [4]);
const dealtDeck = (view: TableView, store: SeatStore): Promise<Uint8Array> => store.deck(view.hand, view.dealt.length - 1);

/**
 * The call `seat` owes the table now that needs no decision: its shuffle with the proof that it is one, or its
 * decryption shares. `null` when the table is not waiting for this seat, or is waiting for its bet.
 */
export async function duty(view: TableView, seat: number, keys: Keys, store: SeatStore): Promise<Call | null> {
  if (!view.awaited.includes(seat) || view.phase === "bet" || view.phase === "lobby") return null;
  if (view.phase === "shuffle") {
    // The button's shuffle starts the hand under the keys of the seats taken at that moment. The key goes with the
    // call: if a seat was taken or given up meanwhile the contract says so before it checks a proof that must fail.
    const key = view.shuffled === 0 ? tableKey(nextDealt(view).map((dealt) => fromBase64(view.keys[dealt]))) : fromBase64(view.key);
    const before = view.shuffled === 0 ? openDeck() : await store.deck(view.hand, view.shuffled - 1);
    const { deck, proof } = shuffle(before, key);
    return { method: "shuffle", args: { id: view.id, seat, deck: toBase64(deck), proof: toBase64(proof), key: toBase64(key) } };
  }
  const place = view.dealt.indexOf(seat);
  const at =
    view.phase === "deal"
      ? view.dealt.flatMap((_, other) => (other === place ? [] : holeAt(other)))
      : view.phase === "open"
        ? streetCards(view.street).map((index) => boardAt(view, index))
        : holeAt(place);
  const tokens = shares(keys, await dealtDeck(view, store), at);
  return { method: view.phase === "showdown" ? "show" : view.phase, args: { id: view.id, seat, tokens: toBase64(tokens) } };
}

/**
 * A bet as the call the contract takes. A fold carries the seat's shares for the board cards not yet open, so that
 * the hand can go on without it. The bet names the table's count of bets it was chosen at: sent again after a node
 * did not answer, it is refused rather than made twice, or made as an answer to a bet the seat never saw.
 */
export async function betCall(view: TableView, seat: number, action: "fold" | "call" | "raise", amount: number | undefined, keys: Keys, store: SeatStore): Promise<Call> {
  const unopened = [0, 1, 2, 3, 4].slice(view.board.length).map((index) => boardAt(view, index));
  const tokens = action === "fold" && unopened.length ? toBase64(shares(keys, await dealtDeck(view, store), unopened)) : null;
  return { method: "act", args: { id: view.id, seat, action, amount: action === "raise" ? amount : null, tokens, bets: view.bets } };
}

/**
 * The seat's own hole cards, once every other seat has dealt them: `null` before that or when the seat is not in the
 * hand; `null` in the list for a card that is no card.
 */
export function holeCards(view: TableView, seat: number, keys: Keys, deck: Uint8Array): (number | null)[] | null {
  const place = view.dealt.indexOf(seat);
  if (place < 0 || view.phase === "lobby" || view.phase === "shuffle" || view.phase === "deal") return null;
  if (view.hole[seat]?.length === 2) return view.hole[seat];
  return holeAt(place).map((at) => cardAt(deck, at, [fromBase64(view.sums[at]), token(keys, deck, at)]));
}

/**
 * What the seat to act may do: what a call costs it (all it has, when that is less than it owes), and the smallest
 * and largest bet it may raise to. `null`: no raise, because it cannot pay more than the bet it answers or because
 * nobody is left who could answer one.
 *
 * The smallest raise adds what the bet it answers added to the one before it, and the big blind at least, as at any
 * no-limit table; less only all in. The contract itself asks for the big blind and no more, so every raise offered
 * here is one it takes.
 */
export function betOptions(view: TableView, seat: number): { owed: number; raise: { min: number; max: number } | null } {
  const top = Math.max(...view.bet);
  const all = view.bet[seat] + view.chips[seat];
  const answering = contenders(view).some((other) => other !== seat && view.chips[other] > 0);
  const before = Math.max(0, ...view.bet.filter((chips) => chips < top));
  return { owed: Math.min(view.chips[seat], top - view.bet[seat]), raise: all > top && answering ? { min: Math.min(top + Math.max(2, top - before), all), max: all } : null };
}

/**
 * What each seat won or lost by a finished hand, by seat. A seat that ran out of time in a hand that was called off
 * also lost the chips it had behind, which went to the seats still in: with one late seat that is what the others
 * took beyond what was put in; with several, their shares cannot be told apart and `null` stands for each.
 */
export function handNets(last: Hand): (number | null)[] {
  const fined = last.won.reduce((sum, chips) => sum + chips, 0) - last.put.reduce((sum, chips) => sum + chips, 0);
  return last.won.map((won, seat) => {
    const net = won - (last.put[seat] ?? 0);
    if (fined <= 0 || !last.late.includes(seat)) return net;
    return last.late.length === 1 ? net - fined : null;
  });
}

/**
 * How long before its deadline a seat's own bet is made for it (`clockMove`), in milliseconds: room for the bet to be
 * signed, sent and taken into a block, and at a free table to wait its turn behind the sponsor's other transactions.
 */
export const clockMarginMs = (view: Pick<TableView, "turnSeconds">): number => Math.min(12_000, view.turnSeconds * 250);

/**
 * The bet a seat's page makes for it when its clock is nearly out: a check when nothing is owed, a fold when a bet
 * is, as the clock does at any online table. `null`: not this seat's bet, or time enough. Left to run out, the bet
 * costs far more than a fold: before the river the contract cannot fold the seat (a fold carries the seat's shares
 * for the board), so the hand is called off and the seat loses all it has at the table.
 */
export function clockMove(view: TableView, seat: number, nowMs: number): "call" | "fold" | null {
  if (view.phase !== "bet" || view.toAct !== seat) return null;
  if (Number(view.deadline) / 1_000_000 - nowMs > clockMarginMs(view)) return null;
  return betOptions(view, seat).owed > 0 ? "fold" : "call";
}

/**
 * Read when a step's clock has just been restarted (the contract sets the deadline a whole `turnSeconds` ahead): how
 * far this device's clock runs ahead of the chain's, in milliseconds, plus the moment the new table took to get here.
 * The least of several readings is the nearest. Taken off the device's time, a countdown and `clockMove` no longer
 * depend on a clock that is set wrong: one a minute ahead would otherwise fold every hand at once.
 */
export const clockAhead = (view: Pick<TableView, "turnSeconds" | "deadline">, nowMs: number): number => view.turnSeconds * 1_000 - (Number(view.deadline) / 1_000_000 - nowMs);

/**
 * Whether the page of `seat` calls time by itself: the deadline passed `graceMs` ago and the table waits for others,
 * not for this seat. Time called while its own part is still owed would rule this seat late with them.
 */
export const callsTime = (view: TableView, seat: number, nowMs: number, graceMs: number): boolean =>
  view.phase !== "lobby" && view.awaited.length > 0 && !view.awaited.includes(seat) && nowMs >= Number(view.deadline) / 1_000_000 + graceMs;

/** When a free table was opened, from its id (`f-<time in base 36>-…`); 0 for any other id. */
export const openedAt = (id: string): number => (/^f-([0-9a-z]{6,9})-/.test(id) ? parseInt(id.split("-")[1], 36) : 0);
/** A free table nobody came to is closed by its host this long after it was opened. */
export const FREE_LOBBY_MS = 10 * 60_000;
/** One somebody did sit at, and that still has not started this long after it was opened: whoever sat there walked away. */
export const FREE_ROOM_MS = 30 * 60_000;

/**
 * Whether the host of a free table closes it in the lobby: nobody came, or those who came never started it. A table
 * in the lobby has no clock, so nothing else ever ends it, and every one left open holds one of the few free tables
 * the sponsor keeps open at once (and a house seat, if one was asked to sit): on 2026-11-14 three rooms, 8 to 17
 * hours old, each with one guest long gone, held three of the testnet site's four.
 */
export const coldLobby = (table: Pick<TableView, "id" | "phase" | "players">, isHouse: (account: string) => boolean, now: number): boolean =>
  table.phase === "lobby" && now > openedAt(table.id) + (table.players.some((player) => player !== null && !isHouse(player)) ? FREE_ROOM_MS : FREE_LOBBY_MS);

/**
 * Whether the host of a free table, which plays `hands` hands there, asks to leave now: during the last of them, once
 * it is dealt into it. The contract then gives the seat up when that hand is over. Asked between two hands, before
 * the button has shuffled, the contract gives the seat up at once: the last hand was never played, and a table of two
 * closed under a guest whose page was shuffling for it.
 */
export const hostIsSpent = (view: Pick<TableView, "hand" | "dealt" | "leaving">, seat: number, hands: number): boolean =>
  view.hand >= hands - 1 && view.dealt.includes(seat) && !view.leaving[seat];

/**
 * How a finished hand ended, in a sentence for the table: who took the pot and with what. `name`: a seat inside a
 * sentence ("you", "House 1"). `made`: what the cards a seat showed made with the board ("two pair"), `null` when it
 * showed none.
 */
export function handStory(last: Hand, name: (seat: number) => string, made: (seat: number) => string | null): string {
  const list = (seats: number[]): string => {
    const names = seats.map(name);
    const said = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? "nobody");
    return said.charAt(0).toUpperCase() + said.slice(1);
  };
  const pot = last.put.reduce((sum, chips) => sum + chips, 0);
  if (last.ending === "void") return "The hand was void: every chip went back.";
  if (last.ending === "cancelled") return `Called off: ${list(last.late).replace(/^./, (first) => first.toLowerCase())} did not answer in time.`;
  const winners = last.dealt.filter((seat) => (last.won[seat] ?? 0) > 0 && !last.folded[seat]);
  if (last.ending === "fold") return `${list(winners)} took the pot of ${pot}: everyone else folded.`;
  const hands = winners.map(made);
  const same = hands[0] !== null && hands.every((hand) => hand === hands[0]) ? hands[0] : null;
  if (winners.length === 1) return `${list(winners)} took the pot of ${pot}${same ? ` with ${same}` : ""}.`;
  return `${list(winners)} shared the pot of ${pot}${same ? `, ${same} each` : ""}.`;
}

/**
 * What became of an account that asked to leave a table: "gone", it was paid and its seat given up; "leaving", it is
 * still in its seat and leaves when the hand it is in is over; "seated", nothing shows of the request.
 *
 * "Leave the table" pressed between two hands is paid at once only if it reaches the contract before the next hand's
 * first shuffle. If the button was quicker the seat is dealt into that hand and still owes it its part: a page that
 * walks off then leaves the seat to run out of time, and with it its chips.
 */
export function leaveState(view: Pick<TableView, "players" | "leaving">, account: string): "gone" | "leaving" | "seated" {
  const seat = view.players.indexOf(account);
  return seat < 0 ? "gone" : view.leaving[seat] ? "leaving" : "seated";
}

/**
 * Whether the seat an account sat in was given up because it ran out of time in the hand before: `seat` is where the
 * account sat. The contract rules a seat late when its step has not reached it by the deadline, whoever is at fault.
 */
export const ruledLate = (view: Pick<TableView, "players" | "last">, seat: number, account: string): boolean => view.players[seat] !== account && Boolean(view.last?.late.includes(seat));

/**
 * Whether what the reading loop could not do was a node not answering (a rate limit, a gateway error, no answer at
 * all), as lib/chain/rpc.ts words it: nothing for the player to act on, and not to be read out as "RPC query: HTTP 429".
 */
export const nodeTrouble = (problem: string): boolean => /^RPC \w+: (HTTP \d{3}|no answer in time|network error)$/.test(problem);

/**
 * What a seat of the house is called at a table: "House" when it is the only one of the house's accounts there, else
 * numbered as the server lists them. `at`: everybody who sits or sat at the table. Heads-up against the house, the
 * one opponent was "House 4": the free tables' host is the fourth account on the server's list.
 */
export const houseName = (houses: string[], account: string, at: (string | null)[]): string =>
  new Set(at.filter((other) => other !== null && houses.includes(other))).size > 1 ? `House ${houses.indexOf(account) + 1}` : "House";
