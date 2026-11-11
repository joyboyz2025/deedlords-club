"use client";

// The table fed with recorded views instead of the chain: `/poker?demo` steps through one hand, phase by phase, with
// no account and no transaction. It exists to look at the table (and to show it without test NEAR); nothing here is
// sent anywhere. `/poker?demo=<n>` starts at frame n, `&seat=0|1|none` chooses which seats this browser "holds".

import { useEffect, useState } from "react";
import { type Result, STAKE } from "../chain";
import type { MatchView } from "../seat";
import { Lobby, RECORD_FEE, Settled, inNear } from "./PokerScreen";
import { type Doing, type Hole, type LogLine, TableView } from "./TableView";

const A = "a3f09c51d27e4b88f0c1a7d95e6b3c42718d0e9fa5b64c27d1e83f90ab7c5d16";
const B = "friend.testnet";
const ID = "p-demo-7k2q";
/** The hand that is dealt: seat 1 holds the ace and king of spades, seat 2 a pair of nines. */
const HOLE = [[51, 50], [7, 20]];
const BOARD = [49, 33, 5, 48, 13];

const none = (): string[] => Array.from({ length: 18 }, () => "");
const given = (...at: [number, number][]): string[] => {
  const tokens = none();
  for (const [seat, position] of at) tokens[seat * 9 + position] = "x";
  return tokens;
};
const dealtTokens: [number, number][] = [[1, 0], [1, 1], [0, 2], [0, 3]];
const upTo = (cards: number): [number, number][] => [...dealtTokens, ...[0, 1].flatMap((seat) => Array.from({ length: cards }, (_, n): [number, number] => [seat, 4 + n]))];

/** `ledger`: the frame whose ledger this one shows, for a view that stands outside the run of the hand. */
type Frame = { name: string; view: MatchView | null; result?: Result | null; hole?: Hole; doing?: Doing; dealt?: number; late?: boolean; screen?: "lobby"; ledger?: number };
const SETTLED = 23;

const base: MatchView = {
  id: ID,
  phase: "bet",
  stake: STAKE.toString(),
  players: [A, B],
  keys: ["", ""],
  turnSeconds: 300,
  deadline: "0",
  chips: [100, 100],
  hand: 0,
  button: 0,
  shuffled: 2,
  street: 0,
  toAct: 0,
  awaited: [0],
  put: [0, 0],
  bet: [0, 0],
  done: [false, false],
  tokens: none(),
  board: [],
  hole: [[], []],
  last: null,
  seq: 1,
};
const at = (more: Partial<MatchView>): MatchView => ({ ...base, ...more });
const mineHole: Hole = { hand: 0, cards: [HOLE[0], HOLE[1]] };

const FRAMES: Frame[] = [
  { name: "The lobby", view: null, screen: "lobby" },
  { name: "A table waiting for its second seat", view: at({ phase: "lobby", players: [A], shuffled: 0, awaited: [], tokens: none() }) },
  { name: "Shuffle 1 of 2, this page proving it", view: at({ phase: "shuffle", shuffled: 0, awaited: [0] }), doing: { seat: 0, what: "shuffle" } },
  { name: "Shuffle 2 of 2", view: at({ phase: "shuffle", shuffled: 1, awaited: [1] }) },
  { name: "Deal: the cards go out face down", view: at({ phase: "deal", awaited: [0, 1] }) },
  { name: "Deal: seat 2's shares are in, seat 1 reads its cards", view: at({ phase: "deal", awaited: [0], done: [false, true], tokens: given([1, 0], [1, 1]) }), hole: { hand: 0, cards: [HOLE[0], null] } },
  { name: "Before the flop: seat 1 to act", view: at({ chips: [99, 98], put: [1, 2], bet: [1, 2], toAct: 0, awaited: [0], tokens: given(...dealtTokens) }), hole: mineHole },
  { name: "Before the flop: seat 1 raised to 6", view: at({ chips: [94, 98], put: [6, 2], bet: [6, 2], toAct: 1, awaited: [1], tokens: given(...dealtTokens) }), hole: mineHole },
  { name: "Turning the flop: no share yet", view: at({ phase: "open", street: 1, chips: [94, 94], put: [6, 6], awaited: [0, 1], tokens: given(...dealtTokens) }), hole: mineHole },
  { name: "Turning the flop: seat 1's shares are in", view: at({ phase: "open", street: 1, chips: [94, 94], put: [6, 6], awaited: [1], done: [true, false], tokens: given(...dealtTokens, [0, 4], [0, 5], [0, 6]) }), hole: mineHole },
  { name: "The flop: seat 2 to act", view: at({ street: 1, chips: [94, 94], put: [6, 6], board: BOARD.slice(0, 3), toAct: 1, awaited: [1], tokens: given(...upTo(3)) }), hole: mineHole },
  { name: "The flop: seat 2 bet 8", view: at({ street: 1, chips: [94, 86], put: [6, 14], bet: [0, 8], board: BOARD.slice(0, 3), toAct: 0, awaited: [0], tokens: given(...upTo(3)) }), hole: mineHole },
  { name: "Turning the turn", view: at({ phase: "open", street: 2, chips: [86, 86], put: [14, 14], board: BOARD.slice(0, 3), awaited: [0, 1], tokens: given(...upTo(3)) }), hole: mineHole },
  { name: "The turn: seat 2 to act", view: at({ street: 2, chips: [86, 86], put: [14, 14], board: BOARD.slice(0, 4), toAct: 1, awaited: [1], tokens: given(...upTo(4)) }), hole: mineHole },
  { name: "Turning the river", view: at({ phase: "open", street: 3, chips: [86, 86], put: [14, 14], board: BOARD.slice(0, 4), awaited: [1], done: [true, false], tokens: given(...upTo(4), [0, 8]) }), hole: mineHole },
  { name: "The river: seat 1 faces a bet of 30", view: at({ street: 3, chips: [86, 56], put: [14, 44], bet: [0, 30], board: BOARD, toAct: 0, awaited: [0], tokens: given(...upTo(5)) }), hole: mineHole },
  { name: "Showdown: both seats to show", view: at({ phase: "showdown", street: 3, chips: [56, 56], put: [44, 44], board: BOARD, awaited: [0, 1], tokens: given(...upTo(5)) }), hole: mineHole },
  { name: "Showdown: seat 1 has shown", view: at({ phase: "showdown", street: 3, chips: [56, 56], put: [44, 44], board: BOARD, awaited: [1], done: [true, false], hole: [HOLE[0], []], tokens: given(...upTo(5), [0, 0], [0, 1]) }), hole: mineHole },
  {
    name: "The hand is paid: seat 1 wins 88",
    view: at({ phase: "shuffle", hand: 1, button: 1, shuffled: 0, awaited: [1], chips: [144, 56], last: { number: 0, board: BOARD, hole: HOLE, outcome: { won: 0 }, pot: 88 } }),
  },
  {
    name: "A hand that ended on a fold",
    view: at({ phase: "shuffle", hand: 2, button: 0, shuffled: 0, awaited: [0], chips: [138, 62], last: { number: 1, board: BOARD.slice(0, 3), hole: [[], []], outcome: { won: 1 }, pot: 16 } }),
  },
  {
    name: "The next hand under way, the hand before on its stub",
    view: at({ hand: 2, chips: [137, 60], put: [1, 2], bet: [1, 2], toAct: 0, awaited: [0], tokens: given(...dealtTokens), last: { number: 1, board: BOARD.slice(0, 3), hole: [[], []], outcome: { won: 1 }, pot: 16 } }),
    hole: { hand: 2, cards: [[23, 36], [0, 44]] },
    dealt: 2,
  },
  { name: "The other seat ran out of time", view: at({ street: 1, chips: [94, 94], put: [6, 6], board: BOARD.slice(0, 3), toAct: 1, awaited: [1], tokens: given(...upTo(3)) }), hole: mineHole, late: true, ledger: 10 },
  { name: "A position that decrypted to no card", view: at({ chips: [99, 98], put: [1, 2], bet: [1, 2], toAct: 0, awaited: [0], tokens: given(...dealtTokens) }), hole: { hand: 0, cards: [[51, null], HOLE[1]] }, ledger: 6 },
  { name: "The table settled", view: null, result: { id: ID, stake: base.stake, players: [A, B], chips: [138, 62], payouts: [((STAKE / 100n) * 138n).toString(), ((STAKE / 100n) * 62n).toString()], hands: 2, reason: "left" }, ledger: 19 },
  { name: "No such table", view: null, result: null, ledger: 0 },
];

/** A made-up transaction hash for line `n`: it looks like one and opens nothing. */
const fakeHash = (n: number): string => {
  const letters = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let state = (n + 1) * 2654435761;
  let hash = "";
  for (let at = 0; at < 44; at++) {
    state = (state * 1103515245 + 12345) >>> 0;
    hash += letters[state % letters.length];
  }
  return hash;
};

/** What this browser would have sent by each frame, oldest first. */
const SENT: [number, number, string][] = [
  [3, 0, "shuffled the deck with its proof (1 of 2)"],
  [4, 1, "shuffled the deck with its proof (2 of 2)"],
  [5, 1, "sent its shares of the other seat's cards"],
  [6, 0, "sent its shares of the other seat's cards"],
  [7, 0, "raises to 6"],
  [8, 1, "calls 4"],
  [9, 0, "sent its shares of the flop"],
  [10, 1, "sent its shares of the flop"],
  [11, 1, "raises to 8"],
  [12, 0, "calls 8"],
  [13, 0, "sent its shares of the turn"],
  [13, 1, "sent its shares of the turn"],
  [14, 1, "checks"],
  [14, 0, "checks"],
  [14, 0, "sent its shares of the river"],
  [15, 1, "sent its shares of the river"],
  [15, 1, "raises to 30"],
  [16, 0, "calls 30"],
  [17, 0, "showed its two cards"],
  [18, 1, "showed its two cards"],
  [19, 1, "shuffled the deck with its proof (1 of 2)"],
  [19, 0, "shuffled the deck with its proof (2 of 2)"],
  [19, 1, "sent its shares of the other seat's cards"],
  [19, 0, "sent its shares of the other seat's cards"],
  [19, 1, "raises to 6"],
  [19, 0, "calls 4"],
  [19, 1, "sent its shares of the flop"],
  [19, 0, "sent its shares of the flop"],
  [19, 0, "checks"],
  [19, 1, "raises to 4"],
  [19, 0, "folds"],
  [20, 0, "shuffled the deck with its proof (1 of 2)"],
  [20, 1, "shuffled the deck with its proof (2 of 2)"],
  [20, 1, "sent its shares of the other seat's cards"],
  [20, 0, "sent its shares of the other seat's cards"],
];
/** The ledger as it stands at a frame, newest first. */
const logAt = (frame: number, leaving = false): LogLine[] => {
  const lines: LogLine[] = SENT.map(([from, seat, text], n): [number, LogLine] => [from, { text: `Seat ${seat + 1} ${text}`, hash: fakeHash(n), seat }])
    .filter(([from]) => from <= frame)
    .map(([, line]) => line);
  if (leaving) lines.push({ text: "Left the table and cashed out", hash: fakeHash(99) });
  return lines.reverse();
};

export function DemoTable({ start }: { start: string }) {
  const [frame, setFrame] = useState(() => Math.min(FRAMES.length - 1, Math.max(0, Number(start) || 0)));
  const [playing, setPlaying] = useState(false);
  const [seats, setSeats] = useState<number[]>([0, 1]);
  const [now, setNow] = useState(() => Date.now());
  const [opened] = useState(() => Date.now());
  const step = (by: number) => setFrame((current) => (current + by + FRAMES.length) % FRAMES.length);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const seat = query.get("seat");
    // `&via=<n>` shows frame n first and then steps to the asked one, so the table sees two views in a row.
    const via = query.get("via");
    if (via !== null) {
      const target = Math.min(FRAMES.length - 1, Math.max(0, Number(start) || 0));
      setFrame(Math.min(FRAMES.length - 1, Math.max(0, Number(via) || 0)));
      setTimeout(() => setFrame(target), 400);
    }
    if (seat === "none") setSeats([]);
    else if (seat === "0" || seat === "1") setSeats([Number(seat)]);
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => setFrame((current) => (current + 1) % FRAMES.length), 2_600);
    return () => clearInterval(timer);
  }, [playing]);

  const { name, view, result, hole, doing, dealt, late, screen, ledger } = FRAMES[frame];
  const log = logAt(ledger ?? frame, frame === SETTLED);
  const next = () => step(1);
  const mine = seats.filter((seat) => view?.players[seat]);
  const shownHole: Hole = hole ? { hand: hole.hand, cards: hole.cards.map((cards, seat) => (seats.includes(seat) ? cards : null)) } : { hand: -1, cards: [null, null] };

  return (
    <>
      <p className="pk-demo">
        <strong>Demo.</strong> <em>Recorded views of one hand; nothing is read from or sent to the chain.</em>
        <span>
          {frame} of {FRAMES.length - 1}: {name}
        </span>
        <button type="button" onClick={() => step(-1)}>
          Back
        </button>
        <button type="button" onClick={next}>
          Next
        </button>
        <button type="button" aria-pressed={playing} onClick={() => setPlaying((on) => !on)}>
          {playing ? "Stop" : "Play"}
        </button>
      </p>
      {screen === "lobby" ? (
        <Lobby session={null} invited={null} onSignIn={next} onSeated={next} />
      ) : view === null ? (
        <Settled id={ID} result={result ?? null} log={log} explorer={() => null} onBack={next} />
      ) : (
        <TableView
          id={ID}
          view={{ ...view, seq: frame, deadline: String(BigInt(late ? opened - 20_000 : opened + 287_000) * 1_000_000n) }}
          hole={shownHole}
          mine={mine}
          locked={false}
          doing={doing ?? null}
          dealt={dealt ?? 0}
          now={now}
          problems={[]}
          log={log}
          link={`https://deedlords.example/poker?m=${ID}`}
          explorer={() => null}
          stake={inNear(STAKE + RECORD_FEE)}
          on={{ act: next, deal: next, leave: next, claim: next, close: next, take: next }}
        />
      )}
    </>
  );
}
