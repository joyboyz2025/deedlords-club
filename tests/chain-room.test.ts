// ChainRoom against a fake chain: the reference engine behind the two calls the room makes (`view`, `call`), with a
// gate to hold a transaction "on its way" and a way to answer from a block behind.

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyAction } from "../games/co-ty-phu/chain/adapt.ts";
import { ChainRoom, type Caller } from "../games/co-ty-phu/chain/room.ts";
import type { ChainMatch, ChainResult, ContractAction } from "../games/co-ty-phu/chain/types.ts";
import { autoAct, createGame, newPlayer, roll, startGame, type Game, type Rng } from "../games/co-ty-phu/engine.ts";

const BACKERS = ["alice.test", "bob.test"];
/** Keeps the seating order as the turn order and always draws card 0. */
const RNG: Rng = { die: () => 1, below: (n) => n - 1 };

class FakeChain {
  game: Game;
  clock = 1_000n;
  deadline = 0n;
  settled: ChainResult | null = null;
  exists = true;
  calls: { by: string; method: string; actions?: ContractAction[] }[] = [];
  /** What the room said each call was for, in the order of `calls`. */
  readonly tables: ({ stake: string; creator: string } | null)[] = [];
  /** The next transactions wait for this before they run. */
  gate: Promise<void> | null = null;
  /** The next transaction fails with this, as a contract panic does. */
  refuse: string | null = null;
  /** Answered once instead of the current match: a node one block behind. */
  behind: ChainMatch | null = null;
  dice: [number, number][] = [];

  constructor(maxRounds = 3, blitz = false) {
    this.game = createGame();
    this.game.settings = { limitMinutes: 0, salary: 200, cash: blitz ? 2000 : 1500, autoSeconds: 45, maxRounds, blitz };
    this.game.players.push(newPlayer("s0", "", "s0"), newPlayer("s1", "", "s1"));
    startGame(this.game, new Set(["s0", "s1"]), 0, RNG);
    assert.deepEqual(this.game.order, ["s0", "s1"]);
  }

  match(): ChainMatch {
    const g = this.game;
    return structuredClone({
      meta: {
        id: "m1",
        status: "playing" as const,
        seats: BACKERS.map((backer, seat) => ({ seat, player: `s${seat}`, backer, driver: null, house: false })),
        stake: "1000000000000000000000000",
        split: [7000, 3000],
        fee_bps: 250,
        rules: { salary: 200, cash: g.settings.cash ?? 1500, blitz: g.settings.blitz ?? false, maxRounds: g.settings.maxRounds ?? 0 },
        solo_player: null,
        creator: BACKERS[0],
        storage_deposit: "60000000000000000000000",
        created_at: "1",
        last_activity: String(this.clock),
        turn_seconds: 45,
        turn_deadline: String(this.deadline),
        draws: g.rolls,
        current_seat: g.phase === "playing" ? Number(g.order[g.turn].slice(1)) : null,
      },
      game: {
        phase: g.phase,
        order: g.order,
        turn: g.turn,
        stage: g.stage,
        dice: g.dice,
        doubles: g.doubles,
        again: g.again,
        round: g.round,
        props: g.props,
        debt: g.debt,
        pendingMove: g.pendingMove,
        card: g.card,
        buildAt: g.buildAt ?? null,
        builtThisTurn: g.builtThisTurn,
        minted: g.minted,
        rolls: g.rolls,
        result: g.result,
        players: g.players.map(({ id, cash, position, jail, freeCards, bankrupt, outAt }) => ({ id, cash, position, jail, freeCards, bankrupt, outAt })),
      },
      log: [],
    });
  }

  readonly reader = {
    view: async <T>(method: string): Promise<T> => {
      if (method === "get_result") return this.settled as T;
      if (!this.exists || this.settled) return null as T;
      const behind = this.behind;
      this.behind = null;
      return (behind ?? this.match()) as T;
    },
  };

  caller(accountId: string): Caller {
    return {
      accountId,
      call: async (method, args, table) => {
        const { seat, actions } = args as { seat?: number; actions?: ContractAction[] };
        this.calls.push({ by: accountId, method, ...(actions ? { actions } : {}) });
        this.tables.push(table ?? null);
        if (this.gate) await this.gate;
        if (this.refuse) {
          const why = this.refuse;
          this.refuse = null;
          throw new Error(why);
        }
        if (method === "timeout") {
          assert.ok(autoAct(this.game, RNG));
        } else {
          assert.equal(BACKERS[seat!], accountId);
          for (const [i, action] of actions!.entries()) {
            const rolls = this.game.rolls;
            if (action === "Roll") roll(this.game, `s${seat}`, this.dice.shift() ?? [1, 2], RNG);
            const done = action === "Roll" ? this.game.rolls > rolls : applyAction(this.game, `s${seat}`, action);
            if (!done) throw new Error(`action ${i} rejected: illegal`);
          }
        }
        this.clock += 1_000n;
        if (this.game.phase === "ended") this.settle();
        return { value: { applied: actions?.length ?? 0, rejected: null } };
      },
    };
  }

  settle(): void {
    const ranking = this.game.result!.ranking.map((id) => Number(id.slice(1)));
    this.settled = {
      id: "m1",
      stake: "1000000000000000000000000",
      pot: "2000000000000000000000000",
      fee: "50000000000000000000000",
      seats: BACKERS,
      ranking,
      backers: ranking.map((seat) => BACKERS[seat]),
      payouts: ["1365000000000000000000000", "585000000000000000000000"],
      forfeited: "0",
      reason: this.game.result!.reason,
      block_height: "9",
      ended_at: String(this.clock),
      deed: BACKERS[ranking[0]],
    };
  }
}

function roomFor(chain: FakeChain, accountId: string | null, now: () => number = () => 0): ChainRoom {
  return new ChainRoom({ id: "m1", reader: chain.reader, caller: accountId ? chain.caller(accountId) : null, pollMs: 1_000, now, sleep: async () => {} });
}

function gate(chain: FakeChain): () => void {
  let open!: () => void;
  chain.gate = new Promise((resolve) => (open = resolve));
  return () => {
    chain.gate = null;
    open();
  };
}

test("a seated player is their seat; anybody else watches", async () => {
  const chain = new FakeChain();
  const alice = roomFor(chain, "alice.test");
  await alice.refresh();
  const seen = alice.getState();
  assert.equal(seen.link, "online");
  assert.equal(seen.seat, 0);
  assert.equal(seen.view!.you.id, "s0");
  assert.equal(seen.view!.current, "s0");
  assert.deepEqual(
    seen.view!.players.map((p) => [p.name, p.color, p.cash]),
    [
      ["alice", 0, 1500],
      ["bob", 1, 1500],
    ],
  );

  const guest = roomFor(chain, null);
  await guest.refresh();
  const watched = guest.getState().view!;
  assert.equal(guest.getState().seat, null);
  assert.equal(watched.you.id, "watcher");
  assert.deepEqual(watched.order, ["s0", "s1"]);
  assert.equal(watched.players.find((p) => p.id === "watcher")!.color, null);
  guest.send({ t: "roll" });
  assert.equal(chain.calls.length, 0, "a watcher sends nothing");
});

test("every call is handed over with the table it is for, so its sender can tell a free one", async () => {
  const chain = new FakeChain();
  const alice = roomFor(chain, "alice.test");
  await alice.refresh();
  alice.send({ t: "roll" });
  await alice.idle();
  assert.equal(chain.calls.length, 1);
  assert.deepEqual(chain.tables, [{ stake: "1000000000000000000000000", creator: "alice.test" }]);
});

test("a roll is only sent, and nothing else is taken until it lands", async () => {
  const chain = new FakeChain();
  const room = roomFor(chain, "alice.test");
  await room.refresh();
  const open = gate(chain);
  room.send({ t: "roll" });
  assert.equal(room.getState().busy, true);
  assert.equal(room.getState().view!.rolls, 0, "the dice are the chain's: nothing is shown ahead");
  room.send({ t: "roll" });
  room.send({ t: "end" });
  assert.deepEqual(chain.calls, [{ by: "alice.test", method: "play", actions: ["Roll"] }]);
  open();
  await room.idle();
  const { busy, view } = room.getState();
  assert.equal(busy, false);
  assert.deepEqual(view!.dice, [1, 2]);
  assert.equal(view!.stage, "buy");
  assert.equal(chain.calls.length, 1);
});

test("a move without dice shows at once; moves made meanwhile go out together", async () => {
  const chain = new FakeChain();
  const room = roomFor(chain, "alice.test");
  await room.refresh();
  room.send({ t: "roll" });
  await room.idle();

  const open = gate(chain);
  room.send({ t: "buy" });
  assert.equal(chain.game.stage, "buy", "the chain has not run it yet");
  assert.equal(room.getState().view!.props[3].owner, "s0");
  assert.equal(room.getState().view!.stage, "end");
  assert.equal(room.getState().busy, false);
  room.send({ t: "mortgage", square: 3 });
  room.send({ t: "end" });
  assert.equal(room.getState().view!.current, "s1", "the turn is shown passed on");
  assert.equal(room.getState().view!.autoInMs, null, "the chain's deadline belongs to the turn before");
  room.send({ t: "end" });
  room.send({ t: "roll" });
  open();
  await room.idle();

  assert.deepEqual(
    chain.calls.map((c) => c.actions),
    [["Roll"], ["Buy"], [{ Mortgage: 3 }, "End"]],
  );
  const view = room.getState().view!;
  assert.equal(view.current, "s1");
  assert.equal(view.props[3].mortgaged, true);
  assert.deepEqual(view.log, [], "the view is the chain's again (the fake keeps no log)");
  assert.equal(room.getState().notice, null);
});

test("a refused move drops what was shown ahead of the chain", async () => {
  const chain = new FakeChain();
  const room = roomFor(chain, "alice.test");
  await room.refresh();
  room.send({ t: "roll" });
  await room.idle();

  const open = gate(chain);
  chain.refuse = "action 0 (buy) rejected: not enough cash";
  room.send({ t: "buy" });
  room.send({ t: "end" });
  assert.equal(room.getState().view!.current, "s1");
  open();
  await room.idle();
  const { view, notice } = room.getState();
  assert.equal(notice, "action 0 (buy) rejected: not enough cash");
  assert.equal(view!.stage, "buy");
  assert.equal(view!.current, "s0");
  assert.equal(view!.props[3], undefined);
  assert.equal(chain.calls.length, 2, "the queued End was dropped with it");
});

test("an answer from a node one block behind is ignored", async () => {
  const chain = new FakeChain();
  const room = roomFor(chain, "alice.test");
  await room.refresh();
  const before = chain.match();
  await chain.caller("alice.test").call("play", { id: "m1", seat: 0, actions: ["Roll"] });
  await room.refresh();
  assert.equal(room.getState().view!.rolls, 1);
  chain.behind = before;
  await room.refresh();
  assert.equal(room.getState().view!.rolls, 1);
  assert.equal(room.getState().view!.stage, "buy");
});

test("after the payout the board stays and the result comes from the contract", async () => {
  const chain = new FakeChain(1);
  const alice = roomFor(chain, "alice.test");
  const bob = roomFor(chain, "bob.test");
  await alice.refresh();
  alice.send({ t: "roll" });
  await alice.idle();
  alice.send({ t: "buy" });
  alice.send({ t: "end" });
  await alice.idle();

  await bob.refresh();
  bob.send({ t: "roll" });
  await bob.idle();
  bob.send({ t: "skip" });
  bob.send({ t: "end" });
  assert.equal(bob.getState().view!.phase, "ended", "the last End ends the game here as it will on chain");
  await bob.idle();
  assert.ok(chain.settled);

  // Bob made the last move: his board is the final one.
  assert.deepEqual(bob.getState().result, chain.settled);
  assert.deepEqual(bob.getState().view!.result, chain.game.result);
  // Alice last read the match before Bob's turn: her board is that one, with the contract's ranking on it.
  await alice.refresh();
  const seen = alice.getState();
  assert.deepEqual(seen.result, chain.settled);
  assert.equal(seen.view!.phase, "ended");
  assert.deepEqual(seen.view!.result, { reason: "time", ranking: chain.settled!.ranking.map((seat) => `s${seat}`) });
  assert.equal(seen.view!.rolls, 1);
  const sent = chain.calls.length;
  alice.send({ t: "roll" });
  assert.equal(chain.calls.length, sent, "a settled match takes no more moves");
});

test("a seated player has the contract move for whoever is past the deadline", async () => {
  const chain = new FakeChain();
  chain.deadline = 5_000n * 1_000_000n;
  let now = 5_500;
  const bob = roomFor(chain, "bob.test", () => now);
  await bob.refresh();
  await bob.idle();
  assert.equal(chain.calls.length, 0, "inside the grace time");
  assert.equal(bob.getState().view!.autoInMs, 0);

  now = 7_000;
  await bob.refresh();
  await bob.idle();
  assert.deepEqual(chain.calls, [{ by: "bob.test", method: "timeout" }]);
  assert.equal(bob.getState().view!.rolls, 1, "the contract rolled for alice");

  const guest = roomFor(chain, null, () => now + 60_000);
  await guest.refresh();
  await guest.idle();
  assert.equal(chain.calls.length, 1, "a watcher cannot");
});

test("a match opened after its payout shows the result; an unknown one says so", async () => {
  const chain = new FakeChain(1);
  chain.game.phase = "ended";
  chain.game.result = { reason: "time", ranking: ["s1", "s0"] };
  chain.settle();
  const late = roomFor(chain, null);
  await late.refresh();
  assert.deepEqual(late.getState().result, chain.settled);
  assert.equal(late.getState().view, null);
  assert.equal(late.getState().error, null);

  const none = new FakeChain();
  none.exists = false;
  const room = roomFor(none, "alice.test");
  await room.refresh();
  assert.equal(room.getState().error, "no-match");
  assert.equal(room.getState().view, null);
});

const auto = (chain: FakeChain, clock: { now: number }): ChainRoom =>
  new ChainRoom({ id: "m1", reader: chain.reader, caller: chain.caller("alice.test"), pollMs: 1_000, now: () => clock.now, sleep: async () => {}, autoPlay: true });
/** Time passes, the room reads the match and does what it does. */
async function after(room: ChainRoom, clock: { now: number }, ms: number): Promise<void> {
  clock.now += ms;
  await room.refresh();
  await room.idle();
}
const sentBy = (chain: FakeChain) => chain.calls.flatMap((call) => call.actions ?? [call.method]);

test("with autoPlay, the dice are thrown after 5 seconds, and a turn with nothing left to decide ends as soon as the chain shows it", async () => {
  const chain = new FakeChain();
  chain.dice = [[1, 3]]; // Airport Tax: paid, and nothing to buy
  const clock = { now: 0 };
  const room = auto(chain, clock);
  await after(room, clock, 0);
  assert.equal(room.getState().view!.autoInMs, 5_000, "the countdown shown is the room's own wait");
  await after(room, clock, 4_000);
  assert.deepEqual(sentBy(chain), [], "the dice are the player's to throw for 5 seconds");
  await after(room, clock, 1_100);
  // The end of the turn follows the roll without waiting: the board shows the landing while it is on its way.
  assert.deepEqual(sentBy(chain), ["Roll", "End"]);
  assert.equal(room.getState().view!.current, "s1");
  // Somebody else's turn is never played from here (the contract's own clock is another matter).
  await after(room, clock, 60_000);
  assert.deepEqual(sentBy(chain), ["Roll", "End"]);
});

test("with autoPlay, a square to buy waits 15 seconds, then it is passed over and the turn ended", async () => {
  const chain = new FakeChain();
  const clock = { now: 0 };
  const room = auto(chain, clock);
  await room.refresh();
  room.send({ t: "roll" }); // 1 + 2: Cape Town, nobody's
  await room.idle();
  assert.equal(room.getState().view!.stage, "buy");
  assert.equal(room.getState().view!.autoInMs, 15_000);
  await after(room, clock, 14_000);
  assert.deepEqual(sentBy(chain), ["Roll"], "theirs to decide for 15 seconds");
  await after(room, clock, 1_100);
  assert.deepEqual(sentBy(chain), ["Roll", "Skip", "End"]);
  assert.equal(room.getState().view!.current, "s1");
  assert.equal(room.getState().view!.props[3], undefined, "nothing was bought");
});

test("with autoPlay, a player who buys in time keeps the square, and a double is thrown again after 5 seconds", async () => {
  const chain = new FakeChain();
  chain.dice = [
    [2, 2],
    [1, 3],
  ]; // a double onto the tax square: the same seat throws again, onto Melbourne
  const clock = { now: 0 };
  const room = auto(chain, clock);
  await room.refresh();
  room.send({ t: "roll" });
  await room.idle();
  assert.equal(room.getState().view!.stage, "end");
  await after(room, clock, 3_000);
  assert.deepEqual(sentBy(chain), ["Roll"], "the second throw is theirs for 5 seconds; the turn is not ended");
  await after(room, clock, 2_100);
  assert.deepEqual(sentBy(chain), ["Roll", "Roll"]);
  // Melbourne, nobody's. Bought in time: only the end of the turn is left.
  assert.equal(room.getState().view!.stage, "buy");
  room.send({ t: "buy" });
  assert.equal(room.getState().view!.current, "s1", "the turn is over on the screen as soon as the square is bought");
  await room.idle();
  assert.deepEqual(sentBy(chain), ["Roll", "Roll", "Buy", "End"]);
  assert.deepEqual(chain.calls.at(-1)!.actions, ["Buy", "End"], "the purchase and the end of the turn are one transaction");
  assert.equal(room.getState().view!.props[8].owner, "s0");
});

test("with autoPlay, a double that leaves nothing to decide does not end the turn: the second throw is still to come", async () => {
  const chain = new FakeChain();
  chain.dice = [[1, 1]]; // a double onto Souvenir; the card drawn (repairs, with no house standing) costs nothing
  const clock = { now: 0 };
  const room = auto(chain, clock);
  await room.refresh();
  room.send({ t: "roll" });
  await room.idle();
  assert.equal(room.getState().view!.again, true);
  assert.deepEqual(sentBy(chain), ["Roll"], "a turn with a throw left is not ended");
});

test("while the board is still playing the rolls before, the dice are not thrown; a turn with nothing left to decide is ended all the same", async () => {
  const chain = new FakeChain();
  chain.dice = [[1, 3]]; // Airport Tax: paid, and nothing to buy
  const clock = { now: 0 };
  const room = auto(chain, clock);
  room.watch(true);
  await after(room, clock, 0);
  await after(room, clock, 60_000);
  assert.deepEqual(sentBy(chain), [], "nothing is thrown for somebody still watching the turn before");
  assert.equal(room.getState().view!.autoInMs, null, "and no countdown runs");
  // The board shows the present: the five seconds start then.
  room.watch(false);
  await after(room, clock, 4_000);
  assert.deepEqual(sentBy(chain), []);
  await after(room, clock, 1_100);
  // The viewer's own roll is now playing on the board (`behind` again): the turn is ended without waiting for it.
  room.watch(true);
  await room.idle();
  assert.deepEqual(sentBy(chain), ["Roll", "End"]);
});

test("Blitz: a turn is not ended while a house can still go up; the last house that can takes the end of the turn with it", async () => {
  const chain = new FakeChain(3, true);
  // Seat 0 holds one city and the cash for exactly one house on it.
  for (const key of Object.keys(chain.game.props)) delete chain.game.props[Number(key)];
  chain.game.props[1] = { owner: "s0", houses: 0, mortgaged: false };
  chain.game.players[0].cash = 250;
  chain.dice = [[1, 3]]; // Airport Tax, 200: nothing to buy, 50 left
  const clock = { now: 0 };
  const room = auto(chain, clock);
  await room.refresh();
  room.send({ t: "roll" });
  await room.idle();
  assert.equal(room.getState().view!.autoInMs, 15_000, "a house can go up in São Paulo: the turn is theirs to end, for fifteen seconds");
  await after(room, clock, 2_000);
  assert.deepEqual(sentBy(chain), ["Roll"]);
  room.send({ t: "build", square: 1 });
  await room.idle();
  assert.deepEqual(chain.calls.at(-1)!.actions, [{ Build: 1 }, "End"]);
  assert.equal(room.getState().view!.props[1].houses, 1);
  assert.equal(room.getState().view!.current, "s1");
});

test("Blitz: each house that goes up gives whoever is building the fifteen seconds again", async () => {
  const chain = new FakeChain(3, true);
  for (const key of Object.keys(chain.game.props)) delete chain.game.props[Number(key)];
  chain.game.props[1] = { owner: "s0", houses: 0, mortgaged: false };
  chain.game.props[3] = { owner: "s0", houses: 0, mortgaged: false };
  chain.dice = [[1, 3]]; // Airport Tax: nothing to buy, houses can go up in São Paulo and Cape Town
  const clock = { now: 0 };
  const room = auto(chain, clock);
  await room.refresh();
  room.send({ t: "roll" });
  await room.idle();
  await after(room, clock, 14_000);
  room.send({ t: "build", square: 1 });
  await room.idle();
  assert.deepEqual(chain.calls.at(-1)!.actions, [{ Build: 1 }], "Cape Town can still take a house: the turn is not ended with this one");
  assert.equal(room.getState().view!.autoInMs, 15_000, "the count starts again");
  // Sixteen seconds after the roll, two after the house: the turn is still theirs.
  await after(room, clock, 2_000);
  assert.equal(room.getState().view!.current, "s0");
  assert.deepEqual(chain.calls.at(-1)!.actions, [{ Build: 1 }]);
  await after(room, clock, 13_100);
  assert.deepEqual(chain.calls.at(-1)!.actions, ["End"]);
  assert.equal(room.getState().view!.props[3].houses, 0, "the house not built is passed over");
});

test("a seat that has done nothing itself this turn is not waited for fifteen seconds over a house; one that is there is", async () => {
  const blitz = () => {
    const chain = new FakeChain(3, true);
    for (const key of Object.keys(chain.game.props)) delete chain.game.props[Number(key)];
    chain.game.props[1] = { owner: "s0", houses: 0, mortgaged: false };
    chain.dice = [[1, 3]]; // Airport Tax: nothing to buy, a house can go up in São Paulo
    return chain;
  };
  // Nobody at the seat: the dice are thrown for it after five seconds, and five more pass the house over.
  let chain = blitz();
  let clock = { now: 0 };
  let room = auto(chain, clock);
  await after(room, clock, 0);
  await after(room, clock, 5_100);
  assert.deepEqual(sentBy(chain), ["Roll"]);
  assert.equal(room.getState().view!.autoInMs, 5_000);
  await after(room, clock, 4_000);
  assert.deepEqual(sentBy(chain), ["Roll"]);
  await after(room, clock, 1_100);
  assert.deepEqual(sentBy(chain), ["Roll", "End"]);
  assert.equal(room.getState().view!.props[1].houses, 0);

  // The dice were thrown for the seat, then its player turns to the houses: fifteen seconds from then.
  chain = blitz();
  clock = { now: 0 };
  room = auto(chain, clock);
  await after(room, clock, 0);
  await after(room, clock, 5_100);
  await after(room, clock, 3_000);
  room.here();
  assert.equal(room.getState().view!.autoInMs, 15_000);
  await after(room, clock, 14_000);
  assert.deepEqual(sentBy(chain), ["Roll"], "the turn is still theirs");
  room.send({ t: "build", square: 1 });
  await room.idle();
  assert.deepEqual(chain.calls.at(-1)!.actions, [{ Build: 1 }, "End"]);

  // A seat whose player threw the dice has the fifteen seconds without asking (the tests above), and keeps none of
  // it into the next round: being there is said turn by turn.
  chain = blitz();
  chain.game.players[0].cash = 5_000;
  chain.game.props[3] = { owner: "s0", houses: 0, mortgaged: false };
  clock = { now: 0 };
  room = auto(chain, clock);
  await room.refresh();
  room.send({ t: "roll" });
  await room.idle();
  assert.equal(room.getState().view!.autoInMs, 15_000);
});

test("without autoPlay a purchase is only a purchase", async () => {
  const chain = new FakeChain();
  const room = roomFor(chain, "alice.test");
  await room.refresh();
  room.send({ t: "roll" }); // 1 + 2: Cape Town, nobody's
  await room.idle();
  room.send({ t: "buy" });
  await room.idle();
  assert.deepEqual(chain.calls.at(-1)!.actions, ["Buy"]);
  assert.equal(room.getState().view!.current, "s0");
});

test("while an agent holds the seat the room moves nothing itself, and a room without autoPlay never does", async () => {
  const chain = new FakeChain();
  const clock = { now: 0 };
  const room = auto(chain, clock);
  room.hold(true);
  await after(room, clock, 0);
  await after(room, clock, 60_000);
  assert.deepEqual(sentBy(chain), [], "the agent plays whole turns");
  assert.equal(room.getState().view!.autoInMs, null, "no countdown of the room's: the fake chain set no deadline");
  // Given back: the wait starts then.
  room.hold(false);
  await after(room, clock, 4_000);
  assert.deepEqual(sentBy(chain), []);
  await after(room, clock, 1_100);
  assert.deepEqual(sentBy(chain), ["Roll"]);

  const plain = new FakeChain();
  const manual = roomFor(plain, "alice.test", () => clock.now);
  await manual.refresh();
  clock.now += 60_000;
  await manual.refresh();
  await manual.idle();
  assert.deepEqual(sentBy(plain), []);
});

test("a roll whose transaction never answers stops tumbling: the room gives up waiting and reads the board", async () => {
  const chain = new FakeChain();
  const room = new ChainRoom({ id: "m1", reader: chain.reader, caller: chain.caller("alice.test"), pollMs: 1_000, sleep: async () => {}, moveTimeoutMs: 30 });
  await room.refresh();
  chain.gate = new Promise(() => {}); // the call is sent and never comes back
  room.send({ t: "roll" });
  assert.equal(room.getState().busy, true);
  await room.idle();
  const state = room.getState();
  assert.equal(state.busy, false, "the dice stop tumbling");
  assert.match(state.notice ?? "", /did not answer in time/);
  assert.equal(state.view!.stage, "roll", "the board is the chain's as read");
  // The page goes on: it reads the match again and takes moves.
  chain.gate = null;
  room.send({ t: "roll" });
  await room.idle();
  assert.equal(room.getState().busy, false);
});
