// One chain state cut into the rolls that made it (games/co-ty-phu/steps.ts).

import assert from "node:assert/strict";
import { test } from "node:test";
import { type PacedView, beatOf, rollSteps } from "../games/co-ty-phu/steps.ts";

const player = (id: string, position: number, more: Record<string, unknown> = {}) => ({ id, name: id, color: 0, position, jail: null, bankrupt: false, cash: 1500, ...more });
const view = (rolls: number, positions: Record<string, number>, more: Record<string, unknown> = {}): PacedView =>
  ({
    phase: "playing",
    rolls,
    dice: [1, 1],
    current: "s0",
    you: { id: "s0" },
    card: null,
    autoInMs: 4000,
    players: Object.entries(positions).map(([id, at]) => player(id, at)),
    ...more,
  }) as unknown as PacedView;
const where = (state: PacedView, id: string) => state.players.find((one) => one.id === id)!.position;

test("one roll that leaves the piece where its dice lead is shown as it came", () => {
  const to = view(4, { s0: 0, s1: 9 }, { dice: [4, 5], trail: [{ player: "s1", dice: [4, 5] }] });
  assert.deepEqual(rollSteps(view(3, { s0: 0, s1: 0 }), to), [to]);
});

test("a double and the roll after it, made in one transaction, are two rolls on the board", () => {
  const from = view(3, { s0: 0, s1: 2 });
  const to = view(
    5,
    { s0: 0, s1: 21 },
    {
      dice: [5, 6],
      trail: [
        { player: "s0", dice: [1, 2] },
        { player: "s1", dice: [4, 4] },
        { player: "s1", dice: [5, 6] },
      ],
    },
  );
  const steps = rollSteps(from, to);
  assert.deepEqual(
    steps.map((step) => [step.rolls, step.dice, where(step, "s1"), step.current]),
    [
      [4, [4, 4], 10, "s1"],
      [5, [5, 6], 21, "s0"],
    ],
  );
  assert.equal(steps[1], to);
  // What happened in between (the money, the deeds) is the chain's to say, at the end: the step shows the state before.
  assert.equal(steps[0].players.find((one) => one.id === "s1")!.cash, 1500);
  assert.equal(steps[0].autoInMs, null);
});

test("a card that sends the piece on: the dice's square first, then where it ended, as a second leg of the same roll", () => {
  const from = view(3, { s0: 0, s1: 30 });
  const to = view(4, { s0: 0, s1: 0 }, { dice: [3, 4], trail: [{ player: "s1", dice: [3, 4] }] });
  const steps = rollSteps(from, to);
  assert.deepEqual(
    steps.map((step) => [beatOf(step), where(step, "s1")]),
    [
      ["4:0", 37],
      ["4:1", 0],
    ],
  );
  assert.deepEqual({ ...steps[1], step: undefined }, { ...to, step: undefined });
});

test("what cannot be rebuilt for certain is left as the chain gave it", () => {
  const from = view(3, { s0: 0, s1: 2 });
  const rolled = (more: Record<string, unknown>, positions = { s0: 0, s1: 21 }) =>
    view(5, positions, {
      trail: [
        { player: "s1", dice: [4, 4] },
        { player: "s1", dice: [5, 6] },
      ],
      ...more,
    });
  // The piece is not where two rolls lead: it was sent somewhere between them.
  const moved = rolled({}, { s0: 0, s1: 17 });
  assert.deepEqual(rollSteps(from, moved), [moved]);
  // The viewer's own rolls, the log too short, a thrower in Customs, a game not being played.
  const mine = view(4, { s0: 7, s1: 2 }, { trail: [{ player: "s0", dice: [3, 4] }] });
  assert.deepEqual(rollSteps(view(3, { s0: 0, s1: 2 }), mine), [mine]);
  const short = view(5, { s0: 0, s1: 21 }, { trail: [{ player: "s1", dice: [5, 6] }] });
  assert.deepEqual(rollSteps(from, short), [short]);
  const held = { ...from, players: from.players.map((one) => (one.id === "s1" ? { ...one, jail: 1 } : one)) } as PacedView;
  assert.deepEqual(rollSteps(held, rolled({})).length, 1);
  const over = rolled({ phase: "ended" });
  assert.deepEqual(rollSteps(from, over), [over]);
  // Nothing rolled since: the same state again.
  const same = view(3, { s0: 0, s1: 2 }, { trail: [] });
  assert.deepEqual(rollSteps(from, same), [same]);
});
