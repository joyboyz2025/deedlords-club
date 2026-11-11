# Engine rules: the contract between the TypeScript and Rust engines

Deedlords has two implementations of the same game rules:

- **TypeScript** at `games/co-ty-phu/engine.ts`. It is the reference ("oracle"). It already ran real games before the hackathon.
- **Rust** at `contracts/engine/`. It is a port that will run inside the NEAR contract.

For the same players, the same actions and the same random values, both must produce **exactly the same state** after every step. A differential test checks this on thousands of generated games. This document defines everything both sides must agree on. If the TS code and this document disagree, this document wins and the TS code is changed to match.

## 1. What changes relative to the pre-hackathon TS engine

The baseline is the pre-hackathon `engine.ts` (lobby, turn machine, rent, cards, jail, debt, bankruptcy, build/sell/mortgage/redeem, trades, time limit). Changes:

1. **Board data comes from `shared/board.json`** (world cities ranked by real prime property prices, English card texts). `board.ts` keeps the formulas below and re-exports the data.
2. **All randomness goes through an `Rng` interface** (section 2), consumed in a fixed order.
3. **Cards are drawn with replacement.** There are no shuffled decks any more. The `decks` field is removed. (A pre-shuffled deck is hidden information that someone must hold; on-chain there must be none.)
4. **Rounds and `maxRounds`.** New fields `round` and `rules.maxRounds` (section 4).
5. **Blitz rules** behind `rules.blitz` (section 5).
6. New field `builtThisTurn` (section 5).

Not ported to Rust (TS keeps them for the room server, but they are never exercised by traces): lobby settings, `wantsToPlay`/online/seated logic, `removeAbsent`, `returnToLobby`, time limit (`limitMinutes`, `endsAt`, `lastRound`, `checkTime`), trades (`proposeTrade`, `answerTrade`, `withdrawTrade`), `look`, `secret`, `name`, `color`, `isHost`, the text `log`.

## 2. Randomness

```ts
interface Rng {
  die(): number;          // integer 1..=6
  below(n: number): number; // integer 0..=n-1, n >= 1
}
```

The engines call the Rng **only** in these places and **in this order**:

| Where | Calls |
|---|---|
| `start` | Shuffle the turn order: Fisher–Yates over the seated player ids in seating order, `for i = len-1 down to 1: j = below(i+1); swap(i, j)`. Then, if `rules.blitz`, shuffle the list of ownable square indexes in ascending order (cities, stations, utilities: 28 indexes) with the same algorithm. |
| `roll` (including a roll made by `auto`) | `die()` for the first die, then `die()` for the second. Then any card drawn as a consequence of the move. |
| Drawing a card | `below(cards[deck].length)`; the result is the card index. |

No other code path may consume randomness. Rust must use the same Fisher–Yates loop. The TS code must not use `lib/random.ts`'s `shuffle` for these, because its loop may differ.

In the contract, `die()` and `below()` are derived from `env::random_seed()` mixed with the match id and a draw counter (rejection sampling, no modulo bias). In tests and traces they are scripted.

## 3. Cards

- Drawing: `index = below(cards[deck].length)`, then `card = { deck, index }`, then apply the effect exactly as before.
- `free` card: push `deck` onto the player's `freeCards`. Nothing else changes; the card can be drawn again by anyone.
- `useFreeCard` ("card" action): remove the first entry of `freeCards`. Nothing is returned to any deck.
- Bankruptcy: if there is a single player creditor, they receive the bankrupt player's `freeCards` (appended in order). Otherwise the cards are dropped.

## 4. Rounds and `maxRounds`

- `round` starts at 0 when the game starts.
- In `nextTurn`, after choosing `next` (skipping bankrupt players): if `next <= turn` then `round += 1`. Then, if `rules.maxRounds > 0` and `round >= rules.maxRounds`, call `finish(game, "time")` and stop (the turn does not advance).
- The old time-limit check (`lastRound`) stays in TS only and never triggers in traces (`limitMinutes` is 0).

## 5. Blitz (`rules.blitz = true`)

1. **Deal.** In `start`, after the turn order is shuffled, shuffle the ownable indexes (section 2). The k-th player **in turn order** (`order[k]`) receives shuffled entries `[5k, 5k+5)`, in that order. For each one: `pay(player, bank, price)` and `props[index] = { owner, houses: 0, mortgaged: false }`. With 4 players this deals 20 of the 28 ownables.
2. **Building.** `canBuild` in Blitz: the game is playing, the actor is the current player, `stage != "debt"`, the square is a city the actor owns, not mortgaged, `houses < 5`, `cash >= houseCost(index)`, and `index` is **not** in `builtThisTurn`. The `buildAt` rule and the group rule do not apply. `build` appends `index` to `builtThisTurn`.
3. **Net worth.** Houses count at `floor(houseCost(index) * 3 / 4)` each instead of `houseCost(index)`.
4. Everything else (rent, cards, jail, debt) is unchanged.

`builtThisTurn` exists in both modes (always empty in classic mode). It is reset to `[]` in `nextTurn` and at `start`. In classic mode, `canBuild` is unchanged (the `buildAt` rule).

## 6. Formulas (integers only, no floats)

- `houseCost(index) = 50 * (floor(index / 10) + 1)`.
- `cityRents(price)[i] = floor((price * m_i + 25) / 50) * 5` with `m = [1, 5, 15, 30, 40, 50]` (this equals the TS `Math.round(price * x / 5) * 5` with `x = [0.1, 0.5, 1.5, 3, 4, 5]`). Index 0 is the bare rent (doubled if the owner holds the whole group), 1–4 houses, 5 is a hotel.
- Station rent: `stationRents[count - 1]`, doubled by the "nearest station" card. Utility rent: `diceTotal * (card ? 10 : utilityTimes[count - 1])`.
- Selling a house pays `houseCost / 2`. Mortgage pays `price / 2`. Redeem costs `ceil(price * 11 / 20)`. Bankruptcy sells houses at `houses * houseCost / 2`.
- Net worth: cash + for each owned square (`price / 2` if mortgaged else `price`) + houses value (section 5.3 in Blitz).
- `finish`: standing players sorted by net worth descending with a **stable** sort (ties keep turn order), then bankrupt players by `outAt` descending.
- Money is a signed 64-bit integer in Rust.

## 7. Actions

| Op | TS function | Who may do it |
|---|---|---|
| `start` | `startGame` with every player seated and online | — |
| `roll` | `roll` | current player |
| `buy` | `buy` | current player |
| `skip` | `skipBuying` | current player |
| `end` | `endTurn` | current player |
| `bail` | `payBail` | current player |
| `card` | `useFreeCard` | current player |
| `pay` | `payDebt` | current player |
| `bankrupt` | `declareBankruptcy` | current player |
| `build` (index) | `build` | current player |
| `sell` (index) | `sellHouse` | **any** non-bankrupt player, any time while playing |
| `mortgage` (index) | `mortgage` | **any** non-bankrupt player, any time while playing |
| `redeem` (index) | `redeem` | **any** non-bankrupt player, any time while playing |
| `auto` | `autoAct` | anyone (acts for the current player) |

An action that is not allowed leaves the state unchanged. TS returns silently; Rust returns `Err(EngineError)`. An action is "ok" if and only if it changed the snapshot.

## 8. Snapshot

Both sides produce this JSON after every step. Comparison is JSON value equality (key order does not matter).

```json
{
  "phase": "playing",
  "order": ["p2", "p0", "p3", "p1"],
  "turn": 0,
  "stage": "roll",
  "dice": [3, 5],
  "doubles": 0,
  "again": false,
  "round": 0,
  "props": { "6": { "owner": "p2", "houses": 1, "mortgaged": false } },
  "debt": null,
  "pendingMove": null,
  "card": { "deck": "chance", "index": 4 },
  "buildAt": null,
  "builtThisTurn": [],
  "minted": 6000,
  "rolls": 1,
  "result": null,
  "players": [
    { "id": "p0", "cash": 1500, "position": 0, "jail": null, "freeCards": [], "bankrupt": false, "outAt": null }
  ]
}
```

- `props` keys are decimal square indexes as strings.
- `players` is in seating order (the order given in the trace), not turn order.
- `dice`, `debt`, `pendingMove`, `card`, `buildAt`, `jail`, `outAt`, `result` use `null` when empty.

## 9. Trace files

The TS generator writes one JSON file per game into `traces/`:

```json
{
  "version": 1,
  "seed": 12345,
  "rules": { "salary": 200, "cash": 1500, "blitz": false, "maxRounds": 0 },
  "players": ["p0", "p1", "p2", "p3"],
  "steps": [
    { "op": "start", "player": null, "index": null, "rng": [{ "kind": "below", "n": 4, "value": 2 }], "ok": true, "state": {} },
    { "op": "roll", "player": "p2", "index": null, "rng": [{ "kind": "die", "value": 3 }, { "kind": "die", "value": 5 }], "ok": true, "state": {} }
  ]
}
```

- `rng` lists, in order, every Rng call the TS engine made during that step.
- The Rust replayer feeds those values back through a scripted Rng. If Rust asks for a different kind of call, a different `n`, or more or fewer calls than recorded, that is a divergence and the replay fails at that step.
- `state` is the snapshot after the step.
- The generator picks actions at random from all ops (mostly legal ones, some illegal on purpose), for 2–4 players, in both classic and Blitz rules, and stops at `phase = "ended"` or after 600 steps.
