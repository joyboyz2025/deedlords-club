"use client";

// The table of two to nine seats fed with made-up views instead of the chain: `/poker/tables?demo` steps through tables
// of four, six and nine seats, phase by phase, with no account and no transaction. It exists to look at the table;
// nothing here is sent anywhere. `/poker/tables?demo=<n>` starts at frame n.

import { useEffect, useState } from "react";
import type { LogLine } from "../../components/TableView";
import { STAKE } from "../chain";
import { RECORD_FEE } from "../contract";
import type { Hand, TableResult, TableView } from "../seat";
import { RoundTable } from "./RoundTable";
import { TableSettled, TablesLobby } from "./TablesScreen";

const ME = "a3f09c51d27e4b88f0c1a7d95e6b3c42718d0e9fa5b64c27d1e83f90ab7c5d16";
const HOUSES = ["pokerhouse.deedlords.testnet", "pokerhouse2.deedlords.testnet", "pokerhouse3.deedlords.testnet"];
const OTHERS = ["mira.testnet", "kenji.testnet", "ana-lucia.testnet", "otto.testnet", "freya.testnet", "bao.testnet"];
const fill = <T,>(count: number, value: T): T[] => Array.from({ length: count }, () => value);

/** A table of `players` (by seat, `null` for a free one) in the middle of a hand, with what is not given filled in. */
function table(players: (string | null)[], more: Partial<TableView> = {}): TableView {
  const count = players.length;
  return {
    id: `t-demo-${count}`,
    phase: "bet",
    stake: STAKE.toString(),
    deposit: (STAKE + RECORD_FEE).toString(),
    host: ME,
    feeBps: 0,
    players,
    keys: players.map((player) => (player ? "k" : "")),
    turnSeconds: 300,
    deadline: "0",
    chips: players.map((player) => (player ? 100 : 0)),
    hand: 0,
    button: 0,
    dealt: [],
    key: "",
    shuffled: 0,
    street: 0,
    toAct: 0,
    awaited: [],
    put: fill(count, 0),
    bet: fill(count, 0),
    folded: fill(count, false),
    done: fill(count, false),
    leaving: fill(count, false),
    sums: [],
    board: [],
    hole: fill(count, [] as number[]),
    last: null,
    cashed: [],
    bets: 0,
    seq: 1,
    ...more,
  };
}

const SIX = [ME, OTHERS[0], HOUSES[0], OTHERS[1], HOUSES[1], OTHERS[2]];
const NINE = [ME, OTHERS[0], HOUSES[0], OTHERS[1], OTHERS[2], HOUSES[1], OTHERS[3], HOUSES[2], OTHERS[4]];
const FOUR = [ME, HOUSES[0], OTHERS[0], null];
const BOARD = [49, 33, 5, 48, 13];

const lastHand: Hand = {
  number: 2,
  dealt: [2, 3, 4, 5, 0, 1],
  board: BOARD,
  hole: [[], [], [12, 25], [], [7, 20], []],
  folded: [true, true, false, true, false, true],
  put: [2, 6, 30, 1, 30, 6],
  won: [0, 0, 0, 0, 75, 0],
  ending: "showdown",
  late: [],
};

type Frame = {
  name: string;
  view?: TableView;
  lobby?: boolean;
  settled?: TableResult | null;
  mine?: (number | null)[];
  doing?: string;
  houseThinking?: boolean;
  houseLast?: boolean;
  agentOn?: boolean;
  you?: string | null;
};

const FRAMES: Frame[] = [
  { name: "The lobby", lobby: true },
  { name: "A table of four waiting for its last seat", view: table(FOUR, { phase: "lobby", chips: [100, 100, 100, 0] }) },
  { name: "Six seats: the button shuffles first", view: table(SIX, { phase: "shuffle", button: 0, awaited: [0], shuffled: 0 }), doing: "shuffle" },
  {
    name: "Six seats: shuffle 4 of 6, the house at work",
    view: table(SIX, { phase: "shuffle", button: 0, dealt: [0, 1, 2, 3, 4, 5], shuffled: 3, awaited: [3], key: "k" }),
    houseThinking: true,
  },
  { name: "Six seats: dealing", view: table(SIX, { phase: "deal", dealt: [0, 1, 2, 3, 4, 5], shuffled: 6, awaited: [1, 3, 5], key: "k" }) },
  {
    name: "Six seats: before the flop, your move",
    view: table(SIX, {
      dealt: [0, 1, 2, 3, 4, 5],
      shuffled: 6,
      chips: [100, 99, 98, 94, 100, 94],
      put: [0, 1, 2, 6, 0, 6],
      bet: [0, 1, 2, 6, 0, 6],
      folded: [false, false, false, false, true, false],
      toAct: 0,
      awaited: [0],
    }),
    mine: [51, 50],
    houseLast: true,
  },
  {
    name: "Six seats: turning the flop",
    view: table(SIX, {
      phase: "open",
      street: 1,
      dealt: [0, 1, 2, 3, 4, 5],
      shuffled: 6,
      chips: [94, 99, 98, 94, 100, 94],
      put: [6, 1, 2, 6, 0, 6],
      folded: [false, true, true, false, true, false],
      awaited: [3, 5],
    }),
    mine: [51, 50],
  },
  {
    name: "Six seats: the turn, your agent has your seat",
    view: table(SIX, {
      street: 2,
      dealt: [0, 1, 2, 3, 4, 5],
      shuffled: 6,
      board: BOARD.slice(0, 4),
      chips: [86, 99, 98, 72, 100, 94],
      put: [14, 1, 2, 28, 0, 14],
      bet: [0, 0, 0, 14, 0, 0],
      folded: [false, true, true, false, true, true],
      toAct: 0,
      awaited: [0],
      leaving: [false, true, false, false, false, false],
    }),
    mine: [51, 50],
    agentOn: true,
    houseLast: true,
  },
  {
    name: "Six seats: an all-in at the river",
    view: table(SIX, {
      street: 3,
      dealt: [0, 1, 2, 3, 4, 5],
      shuffled: 6,
      board: BOARD,
      chips: [72, 99, 98, 0, 100, 94],
      put: [28, 1, 2, 100, 0, 14],
      bet: [0, 0, 0, 72, 0, 0],
      folded: [false, true, true, false, true, true],
      toAct: 0,
      awaited: [0],
    }),
    mine: [51, 50],
  },
  {
    name: "Six seats: showdown",
    view: table(SIX, {
      phase: "showdown",
      street: 3,
      dealt: [0, 1, 2, 3, 4, 5],
      shuffled: 6,
      board: BOARD,
      chips: [0, 99, 98, 0, 100, 94],
      put: [100, 1, 2, 100, 0, 14],
      folded: [false, true, true, false, true, true],
      awaited: [3],
      hole: [[51, 50], [], [], [], [], []],
    }),
    mine: [51, 50],
  },
  {
    name: "Six seats: the next hand, the last one on its stub",
    view: table(SIX, { phase: "shuffle", hand: 3, button: 1, chips: [100, 99, 128, 75, 100, 94], awaited: [1], last: lastHand, cashed: [{ account: "lena.testnet", chips: 140 }] }),
  },
  {
    name: "Nine seats: before the flop",
    view: table(NINE, {
      dealt: [3, 4, 5, 6, 7, 8, 0, 1, 2],
      button: 3,
      shuffled: 9,
      chips: [94, 100, 100, 100, 99, 98, 94, 100, 94],
      put: [6, 0, 0, 0, 1, 2, 6, 0, 6],
      bet: [6, 0, 0, 0, 1, 2, 6, 0, 6],
      folded: [false, true, true, true, false, false, false, true, false],
      toAct: 4,
      awaited: [4],
    }),
    mine: [23, 36],
  },
  {
    name: "Nine seats: watching, a seat free",
    view: table([...NINE.slice(0, 8), null], {
      street: 1,
      dealt: [0, 1, 2, 3, 4, 5, 6, 7],
      board: BOARD.slice(0, 3),
      toAct: 2,
      awaited: [2],
      put: fill(9, 4),
      chips: [96, 96, 96, 96, 96, 96, 96, 96, 0],
    }),
    you: "visitor.testnet",
  },
  { name: "Two seats", view: table([ME, HOUSES[0]], { dealt: [0, 1], shuffled: 2, chips: [99, 98], put: [1, 2], bet: [1, 2], toAct: 0, awaited: [0] }), mine: [44, 45] },
  {
    name: "Nine seats: shuffle 6 of 9, the deck before the seat shuffling",
    view: table(NINE, { phase: "shuffle", button: 3, dealt: [3, 4, 5, 6, 7, 8, 0, 1, 2], shuffled: 5, awaited: [8], key: "k" }),
  },
  {
    name: "Nine seats: dealing, 5 of 9 seats in",
    view: table(NINE, {
      phase: "deal",
      button: 3,
      dealt: [3, 4, 5, 6, 7, 8, 0, 1, 2],
      shuffled: 9,
      awaited: [0, 2, 5, 7],
      done: [false, true, false, true, true, false, true, false, true],
      key: "k",
    }),
  },
  {
    name: "Two seats: the house shuffles second",
    view: table([ME, HOUSES[0]], { phase: "shuffle", button: 0, dealt: [0, 1], shuffled: 1, awaited: [1], key: "k" }),
    houseThinking: true,
  },
  {
    name: "The table settled",
    settled: {
      id: "t-demo-6",
      stake: STAKE.toString(),
      feeBps: 0,
      hands: 7,
      cashed: [
        { account: ME, chips: 182, payout: ((STAKE / 100n) * 182n).toString(), fee: "0" },
        { account: OTHERS[0], chips: 40, payout: ((STAKE / 100n) * 40n).toString(), fee: "0" },
        { account: HOUSES[0], chips: 118, payout: ((STAKE / 100n) * 118n).toString(), fee: "0" },
        { account: OTHERS[1], chips: 60, payout: ((STAKE / 100n) * 60n).toString(), fee: "0" },
      ],
    },
  },
];

const LOG: LogLine[] = [
  { text: "Seat 1 calls 6", seat: 0 },
  { text: "Seat 1 sent its shares of the other seats' cards", seat: 0 },
  { text: "Seat 1 shuffled the deck with its proof (1 of 6)", seat: 0 },
];

export function TablesDemo({ start }: { start: string }) {
  const [frame, setFrame] = useState(() => Math.min(FRAMES.length - 1, Math.max(0, Number(start) || 0)));
  const [now, setNow] = useState(() => Date.now());
  const [opened] = useState(() => Date.now());
  const [agentOn, setAgentOn] = useState<boolean | null>(null);
  useEffect(() => setAgentOn(null), [frame]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const step = (by: number) => setFrame((current) => (current + by + FRAMES.length) % FRAMES.length);
  const next = () => step(1);
  const shown = FRAMES[frame];
  const you = shown.you === undefined ? ME : shown.you;
  const view = shown.view && { ...shown.view, deadline: String(BigInt(opened + 254_000) * 1_000_000n) };
  const mySeat = view && you ? view.players.indexOf(you) : -1;
  const houseSeats = view ? view.players.flatMap((player, seat) => (player && HOUSES.includes(player) ? [seat] : [])) : [];

  return (
    <>
      <p className="pk-demo">
        <strong>Demo.</strong> <em>Made-up tables of two to nine seats; nothing is read from or sent to the chain.</em>
        <span>
          {frame} of {FRAMES.length - 1}: {shown.name}
        </span>
        <button type="button" onClick={() => step(-1)}>
          Back
        </button>
        <button type="button" onClick={next}>
          Next
        </button>
      </p>
      {shown.lobby ? (
        <TablesLobby
          session={null}
          onSignIn={next}
          onOpen={next}
          houses={HOUSES}
          wall={{
            offline: false,
            tables: [
              table(FOUR, { id: "t-mwd9k2a1-q7rt", phase: "lobby", host: OTHERS[0] }),
              table([OTHERS[3], null, null, null, null, null, null, null, null], { id: "t-mwd8zz04-b3xm", phase: "lobby", host: OTHERS[3] }),
              table([...SIX.slice(0, 5), null], { id: "t-mwd7t1e3-k2pa", hand: 4, host: OTHERS[1] }),
              table(NINE, { id: "t-mwd6q0ss-7hne", hand: 11, host: OTHERS[2] }),
            ],
          }}
        />
      ) : shown.settled !== undefined || !view ? (
        <TableSettled id="t-demo-6" result={shown.settled ?? null} log={LOG} you={ME} houses={HOUSES} onBack={next} explorer={() => null} />
      ) : (
        <RoundTable
          id={view.id}
          view={view}
          you={you}
          mySeat={mySeat >= 0 ? mySeat : null}
          myCards={shown.mine ?? null}
          locked={false}
          doing={shown.doing ?? null}
          now={now}
          problems={[]}
          log={frame < 3 ? [] : LOG}
          link={`https://deedlords.example/poker/tables?t=${view.id}`}
          explorer={() => null}
          house={{
            seats: houseSeats,
            accounts: HOUSES,
            canAdd: view.players.includes(null) && houseSeats.length < HOUSES.length,
            models: ["gpt-4.1-mini", "gemini-2.5-flash", "gemini-2.5-flash-lite", "rules"],
            defaultModel: "gemini-2.5-flash-lite",
            seatModels: Object.fromEntries(houseSeats.map((seat, at) => [seat, ["gemini-2.5-flash-lite", "gpt-4.1-mini", "rules"][at % 3]])),
            thinking: Boolean(shown.houseThinking),
            last: shown.houseLast
              ? { seat: houseSeats[0], what: "raise to 6", driver: "gemini-2.5-flash-lite", sealed: true }
              : null,
          }}
          agent={{
            on: agentOn ?? Boolean(shown.agentOn),
            toggle: () => setAgentOn(!(agentOn ?? Boolean(shown.agentOn))),
            thinking: Boolean(shown.agentOn),
            name: "Velvet",
            model: "gemini-2.5-flash-lite",
            said: null,
            last: null,
          }}
          on={{ act: next, sit: next, start: next, leave: next, callTime: next, addHouse: next }}
        />
      )}
    </>
  );
}
