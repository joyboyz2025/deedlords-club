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
| Drawing a ticket (section 10, only with `rules.tickets`) | `below(4)`; the result is the ticket kind. In `start`, after the Blitz deal, one draw per player in turn order. In any move that pays the salary, right after the salary, unless the player already holds 2. |

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
| `resign` | `resign` | **any** non-bankrupt player, any time while playing |
| `build` (index) | `build` | current player |
| `sell` (index) | `sellHouse` | **any** non-bankrupt player, any time while playing |
| `mortgage` (index) | `mortgage` | **any** non-bankrupt player, any time while playing |
| `redeem` (index) | `redeem` | **any** non-bankrupt player, any time while playing |
| `auto` | `autoAct` | anyone (acts for the current player) |

`resign` (giving up): a `resign` log event, then the player goes bankrupt. On their own turn in `debt` the creditor
is decided exactly as by `bankrupt`; at any other moment everything goes to the bank (`creditor` null). If the current
player is in `debt` and a payee is the player who gives up, that payee's `id` becomes null (owed to the bank); amounts
are unchanged. The turn passes only if the player giving up held it; one player left ends the game (`last`).

Four more ops exist only in a game with `rules.tickets` (section 10): `waiver`, `steps` (index = the steps), `takeover`, `festival`, all for the current player. Without `rules.tickets` they are never allowed.

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

- With `rules.tickets` the snapshot has one more key, `tickets` (section 10); without it the key is absent, so a game without tickets has exactly the snapshot above.
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

- `rules` may also carry `"tickets": true` and `"leaderRent": true` (section 10); absent means off. Such games are written as `tickets-NNNNN.json` next to the `game-NNNNN.json` files, which are generated exactly as before.
- `rng` lists, in order, every Rng call the TS engine made during that step.
- The Rust replayer feeds those values back through a scripted Rng. If Rust asks for a different kind of call, a different `n`, or more or fewer calls than recorded, that is a divergence and the replay fails at that step.
- `state` is the snapshot after the step.
- The generator picks actions at random from all ops (mostly legal ones, some illegal on purpose), for 2–4 players, in both classic and Blitz rules, and stops at `phase = "ended"` or after 600 steps.

## 10. Tickets and the leader's rent (opt-in)

Two rules a match may switch on when it is created: `rules.tickets` and `rules.leaderRent`. Both are off when absent, and a game with both off behaves, draws randomness and snapshots exactly as sections 1 to 9 say.

### 10.1 The leader's rent (`rules.leaderRent`)

When a rent is worked out in `land` (section 6 gives the base amount), the payer **leads** if their net worth is strictly greater than the net worth of every other non-bankrupt player at that moment (before the rent is paid). A tie for first place is no lead. A payer who leads owes one more time the base rent (double).

### 10.2 Tickets (`rules.tickets`)

State, in the snapshot under `tickets`:

```json
{ "held": { "p0": ["waiver"], "p1": ["steps", "festival"] }, "waiver": false, "festival": ["p1"] }
```

- `held`: for every seated player (bankrupt ones included, with `[]`), the tickets held, oldest first. At most 2.
- `waiver`: the current player has played a Rent waiver this turn and it has not been used yet.
- `festival`: ids of the players whose Festival is on, in the order they played it.

Kinds, in the order of `below(4)`: `0 waiver`, `1 steps`, `2 takeover`, `3 festival`.

**Getting tickets.** In `start`, after the turn order is shuffled and after the Blitz deal, each player in turn order draws one ticket. In `passStart` (every place the salary is paid: a move past Departure by dice or by a card), right after the salary is paid, the player draws one ticket unless they already hold 2 (then nothing is drawn and no randomness is consumed).

**Playing tickets.** Only the current player, only a ticket they hold; the first such ticket in `held` is removed. "Before a throw" means `stage == "roll"`, or `stage == "end"` with `again` (the same condition as `roll`).

| Op | When | Effect |
|---|---|---|
| `waiver` | before a throw; `tickets.waiver` is false | `tickets.waiver = true`. The next rent the player would owe in `land` this turn is not charged at all (no payment, no debt) and `tickets.waiver` becomes false. Taxes and card payments are not rents. |
| `steps` (n) | before a throw; the player is not in jail; `2 <= n <= 12` | A throw whose dice are chosen: `dice = [a, n - a]` with `a = min(6, n - 1)`; `rolls += 1`; `card = null`; `buildAt = null`; `again = false` (a chosen double gives no second throw and does not count in `doubles`); then `moveBy(n)` exactly as a roll does. No `die()` is called; a ticket or a card drawn by the move consumes randomness as usual. |
| `festival` | before a throw; the player is not already in `tickets.festival` | The player's id is appended to `tickets.festival`. |
| `takeover` | `stage == "end"`; the player stands on a city owned by another player, with no house and not mortgaged; `cash >= 2 * price` | The player pays the owner `2 * price`; the city's owner becomes the player. Nothing else changes (`stage`, `again`, `buildAt` stay). |

**Ending.** In `nextTurn`, when the turn passes (not when the game finishes instead): `tickets.waiver = false`, and the id of the player whose turn starts is removed from `tickets.festival`. A player who goes bankrupt loses their tickets (`held[id] = []`, nothing passes to a creditor) and is removed from `tickets.festival`.

### 10.3 The rent owed

In `land`, with `base` the rent of section 6 (after a "nearest" card's modifier):

```
times = 1
if rules.tickets and the square is a city and its owner is in tickets.festival: times += 1
if rules.leaderRent and the payer leads (10.1):                                 times += 1
amount = base * times
if rules.tickets and tickets.waiver: tickets.waiver = false; nothing is charged
else: charge(payer, owner, amount)
```

So Festival and the leader's rent add up: the leader pays three times the base rent on a Festival city. `rentFor` keeps returning `base`; `rentDue(game, payerId, index, diceTotal, modifier)` returns `amount`.

### 10.4 `auto`

`auto` plays no ticket. In `stage == "end"` it ends the turn as before.

### 10.5 Building only where one stops (`rules.buildHere`)

A third opt-in rule, for Blitz games. With it, `build` follows the classic condition of section 5 in a Blitz game too:
a house goes up only on the player's own city they have just stopped on (`buildAt == index`), one house per stop,
and `buildAt` is cleared by the build. `builtThisTurn` is still recorded and plays no part. Everything else of Blitz
(the deal, the round limit, the worth of a house) is unchanged. In a classic game the rule changes nothing.

The contract stores it after the tickets, in a tail of version 2 that only a match with this rule has; `get_config`
lists it as `buildHere`.

### 10.6 One house a turn (`rules.buildOne`)

A fourth opt-in rule, for Blitz games; where both are set it goes before `buildHere`. With it, `build` is allowed on
any of the player's own cities, at any moment of their turn except in debt (as in Blitz), but only while
`builtThisTurn` is empty: one house a turn in all, on a city of the player's choice. The other conditions are those of
section 5 (not mortgaged, fewer than five houses, cash for the house). In a classic game the rule changes nothing.

The contract stores it after `buildHere`, in a tail of version 3 that only a match with this rule has; `get_config`
lists it as `buildOne`. The page opens its matches with `buildHere`, not with this rule (`BUILD_RULE` in
`games/co-ty-phu/chain/calls.ts`): the owner chose the rule players know from the board game.

### 10.7 A house with the purchase (`rules.buildOnBuy`)

A fifth opt-in rule, for any game. In `buy`, after the square has changed hands and `stage` is `end`: if the square is
a city, `buildAt` is set to it. The buyer may then `build` one house there in the same stop, under the classic
condition of section 5 (`buildAt == index`, which the build clears), exactly as when stopping on an own city later.
Stations and utilities take no house. In a Blitz game without `buildHere` the rule changes nothing that Blitz did not
already allow.

This is the game the page opens where the contract lists the rule (`rulesWith` in `games/co-ty-phu/chain/calls.ts`):
classic rules, so nothing is dealt and the board is bought by landing on it, a round limit, and a house with each
purchase and at each later stop on an own city. The contract stores the flag in a tail of version 4.

