// Tables nobody is left waiting at: seats the contract marks away, and tables everybody left (the page's side).

import assert from "node:assert/strict";
import { test } from "node:test";
import { chainView, toGame } from "../games/co-ty-phu/chain/adapt.ts";
import { ABANDON_AFTER_MS, leftTables } from "../games/co-ty-phu/chain/freeDesk.ts";
import { describeCall } from "../games/co-ty-phu/chain/ledger.ts";
import type { ChainMatch, ChainMeta } from "../games/co-ty-phu/chain/types.ts";

const nanos = (ms: number) => String(BigInt(ms) * 1_000_000n);
const table = (id: string, status: ChainMeta["status"], idleMs: number, now: number): ChainMeta =>
  ({
    id,
    status,
    seats: [],
    stake: "0",
    split: [],
    fee_bps: 0,
    rules: { salary: 200, cash: 2000, blitz: true, maxRounds: 20 },
    solo_player: null,
    creator: "x",
    storage_deposit: "0",
    created_at: "0",
    last_activity: nanos(now - idleMs),
    turn_seconds: 30,
    turn_deadline: "0",
    draws: 0,
    current_seat: 0,
  }) as ChainMeta;

test("the tables everybody left: under way, quiet for longer than the contract asks, oldest first", () => {
  const now = 1_800_000_000_000;
  const tables = [
    table("fresh", "playing", 60_000, now),
    table("old", "playing", ABANDON_AFTER_MS + 5_000, now),
    table("older", "playing", 3 * ABANDON_AFTER_MS, now),
    table("lobby", "lobby", 3 * ABANDON_AFTER_MS, now),
  ];
  assert.deepEqual(leftTables(tables, now), ["older", "old"]);
});

test("the transactions list names a return to the table and a table that was closed", () => {
  assert.equal(describeCall("play", { id: "m", seat: 1, actions: [] }), "Back at the table");
  assert.match(describeCall("close", { id: "m" }), /everybody left/);
});

test("a seat the contract marks away shows as away on the table, to players and watchers alike", () => {
  const game = {
    phase: "playing",
    stage: "roll",
    round: 1,
    rolls: 0,
    again: false,
    doubles: 0,
    dice: null,
    card: null,
    debt: null,
    buildAt: null,
    builtThisTurn: [],
    pendingMove: null,
    minted: 0,
    order: ["s0", "s1"],
    turn: 0,
    props: {},
    result: null,
    players: [0, 1].map((k) => ({ id: `s${k}`, cash: 2000, position: 0, jail: null, freeCards: [], bankrupt: false, outAt: null })),
  };
  const seats = [0, 1].map((seat) => ({ seat, player: `s${seat}`, backer: `a${seat}.test`, driver: null, house: false }));
  const meta = { ...table("m", "playing", 0, 1_800_000_000_000), seats, away: [1] };
  const match = { meta, game, log: [] } as unknown as ChainMatch;
  for (const viewer of ["a0.test", null]) {
    const view = chainView(toGame(match), match.meta, viewer, 0, null);
    assert.deepEqual(
      view.players.filter((p) => p.id.startsWith("s")).map((p) => [p.id, p.online]),
      [
        ["s0", true],
        ["s1", false],
      ],
    );
  }
  const here = { ...meta, away: undefined };
  const everybodyHere = chainView(toGame({ ...match, meta: here } as ChainMatch), here, "a0.test", 0, null);
  assert.ok(everybodyHere.players.every((p) => p.online));
});
