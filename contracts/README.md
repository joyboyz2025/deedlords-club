# Deedlords contracts

Two crates in one Cargo workspace:

| Crate | What it is |
|---|---|
| `engine/` (`deedlords-engine`) | The game rules: a pure, deterministic, integer-only Rust port of the TS engine. No NEAR dependency. Contract with the TS engine: `docs/ENGINE-RULES.md`. |
| `deedlords/` (`deedlords`) | The NEAR contract around the engine: matches, stakes, on-chain dice, turn deadlines, payouts, Deed NFTs (NEP-171), stats. |
| `sandbox/` | Integration test on a local `near-sandbox` (never testnet or mainnet). |

## Build

Requires Rust with the `wasm32-unknown-unknown` target.

```sh
cd contracts
RUSTFLAGS="-C target-cpu=mvp -C target-feature=+sign-ext --cfg near" \
  cargo build -p deedlords --target wasm32-unknown-unknown --release
# -> target/wasm32-unknown-unknown/release/deedlords.wasm (stripped by the release profile)
```

`--cfg near` matters: near-sdk 5.30 routes `env::panic_str` and `env::sha256` to the NEAR host functions only under
`cfg(near)` (what `cargo near build` sets). Without it, panics on chain become a bare `WebAssembly trap: unreachable`
with no message, and sha256 is compiled in as pure Rust (more gas, bigger wasm). `target-cpu=mvp` + `+sign-ext` keep the
wasm within the features nearcore 2.x accepts. If `wasm-opt` is installed, `wasm-opt -Oz` shrinks it further (optional).

## Test

```sh
cd contracts
cargo test -p deedlords                  # contract unit tests (testing_env!, varied seeds and timestamps)
cargo test -p deedlords-engine           # engine tests
cargo clippy -p deedlords --all-targets

cd sandbox && npm install && npm test    # local near-sandbox 2.14: 5 scenarios + gas/size/storage numbers
# NEAR_SANDBOX_BIN_PATH=/path/to/near-sandbox reuses an already downloaded 2.14 binary
```

## Model

- A match has 2–4 **seats**. Seat `k` is the engine player `"s<k>"`. Each seat is **backed** by an account that paid
  the stake. A backer may name a **driver** (an agent account) that may also play the seat.
- In a **solo** match the solo player backs exactly one seat and the house backs all the others. In any other match
  one account may back several seats.
- Each deployment has a **stake cap** (`max_stake`, set once in `new`, no setter): `create_match` refuses more per seat.
- Backing the last seat **starts** the game in the same call (turn order and the Blitz deal come from the on-chain Rng).
- Every move goes through the engine. **A roll can never be taken back** (see "No re-rolls").
- Each turn has a **deadline** (`turn_seconds`, default 20). After it, **anyone** may call `timeout`.
- When the engine reports the end, the contract **settles once**, in that same call.

### Randomness

Each 32-byte block is `sha256(random_seed ‖ match_id ‖ draws_le ‖ salt)` where `random_seed` is `env::random_seed()`,
`draws` is the match's counter (incremented once per hash) and `salt` is `"die"` or `"below"`. `die()` takes the next byte
`< 252` and returns `b % 6 + 1`; `below(n)` takes the next little-endian u32 below `floor(2^32 / n) * n` and returns
`v % n` (rejection sampling, no modulo bias). Remaining risk: a block producer has a small influence on `random_seed`.
On NEAR a contract calling `play` cannot revert a bad roll, because cross-contract calls are asynchronous.

### No re-rolls

A roll that could be undone after it was seen would be a free re-roll. Two ways to undo one are closed:

- **Failing on purpose.** A call that drew no randomness is rejected whole when the engine rejects one of its actions.
  Once a die or a card was drawn the call stands: the actions applied so far are kept, the rest of the list is dropped,
  and the rejected action is reported in the return value of `play` and in the `actions` event. `["Roll", "Buy"]` on a
  square that cannot be bought keeps the roll.
- **Running out of gas on purpose.** Different outcomes burn different amounts of gas, so a caller could attach just
  enough for the outcomes it likes. `join`, `play`, `turn` and `timeout` therefore refuse to run with less than
  `MIN_MOVE_GAS` = **100 Tgas** attached (`get_config().min_move_gas`); the check comes before anything is drawn. A
  call is bounded (32 actions, or 64 driver steps), the heaviest one measured burns 8.9 Tgas and the estimate for the
  largest possible one is about 17 Tgas (Measurements), so every outcome completes.

Clients must set the gas explicitly: near-api-js attaches 30 Tgas by default, which these four methods refuse. The
floor costs an honest player nothing today: unspent gas is refunded in full (the gas-refund fee of NEP-536 exists in
nearcore but its parameters are 0, see nearcore `docs/architecture/how/gas.md`; on the sandbox the same call cost the
same 0.239 mNEAR with 10, 30, 100 and 300 Tgas attached, measured on `set_driver`). If that fee is switched on as
proposed (5% of the unspent gas), a move would cost about 5 Tgas more. None of this was measured on testnet or mainnet.

### Settlement

`pot = stake × seats`; rank `i` gets `pot × split[i] / 10000`, the integer remainder goes to rank 0. Shares of seats
backed by the **house** are added to `forfeited` and never paid out (no method moves them). Other shares are transferred
to the backers. A **Deed** NFT (token id = match id) is minted to the winner's backer unless the winner is a house seat.
Stats and a summary are stored, the match state is deleted, and the creator's storage deposit is refunded minus the
bytes of the permanent records (summary, stats, Deed), so finished matches never eat the contract's own balance.

### Storage deposit

`create_match` must attach at least `(measured size of the new match + 4500 bytes) × 10^19` yoctoNEAR (about 0.05
NEAR). The 4500-byte reserve covers the match growing while it is played and the permanent records written at the end
(measured in `tests::storage_reserve_covers_a_full_match`: worst case with 64-character accounts is about 1.1 KB of growth
and 2.5 KB of records). Abandoned matches refund the whole deposit.

### Deadlines

- The clock restarts (`turn_deadline = now + turn_seconds`) when the game starts, when the seat to move changes, and
  when the current seat rolls. Nothing else moves it: buying, building, selling, mortgaging, redeeming and paying keep
  the deadline where it was, whoever sends them. A seat cannot hold the table with free moves (`Mortgage` then `Redeem`
  is always legal); a turn lasts at most `turn_seconds` after each of its rolls.
- Pick `turn_seconds` so that a player can still decide after the roll: the default 20 suits agents, people need more
  (60 is reasonable).
- `timeout` does one step. While the timed-out player still holds the turn, the deadline stays expired, so the next
  step can be forced immediately; when the turn passes, the next player gets a fresh deadline.

## Methods

Change methods (all panic with a readable message on invalid input):

| Method | Who | What |
|---|---|---|
| `new(owner, house, max_stake: U128)` | contract account (init) | `max_stake`: the most yoctoNEAR one seat may stake in this deployment, at most 1,000,000 NEAR. Fixed for the life of the contract. |
| `create_match(id, seats, stake: U128, split: Vec<u16>, rules, solo_player: Option<AccountId>, turn_seconds: Option<u32>)` | anyone, payable (storage) | `id`: 1–32 chars `[A-Za-z0-9_-]`, unique forever once settled. `seats` 2..=4. `stake` ≤ `max_stake`. `split`: 1..=seats basis points per rank, sum 10000. `rules`: `{ salary, cash, blitz, max_rounds }` (`maxRounds` also accepted); `max_rounds` is required, 1..=255, so every match ends; Blitz needs `cash >= 1670`. `solo_player` may not be the house. |
| `join(id, seat)` | anyone, payable exactly `stake`. Solo match: the solo player (one seat) and the house (all the others; it cannot take the last free seat while the solo player is not seated) | backs a free seat; the last one starts the game |
| `leave(id, seat)` | the seat's backer, lobby only | refunds the stake |
| `set_driver(id, seat, driver: Option<AccountId>)` | the seat's backer | |
| `play(id, seat, actions: Vec<Action>)` | backer or driver of `seat` | 1..=32 engine actions in order: `"Roll"`, `"Buy"`, `"Skip"`, `"End"`, `"Bail"`, `"Card"`, `"Pay"`, `"Bankrupt"`, `{"Build": i}`, `{"Sell": i}`, `{"Mortgage": i}`, `{"Redeem": i}`. `Sell`/`Mortgage`/`Redeem` work out of turn as the engine allows. `Start`/`Auto` are refused. Returns `{ "applied": n, "rejected": null \| { "index", "action", "error" } }`: read `rejected`, a call that rolled succeeds even when a later action was refused ("No re-rolls"). |
| `turn(id, seat, plan)` | backer or driver of the current seat | whole agent turn in one transaction (below) |
| `timeout(id)` | anyone, after the deadline | engine `Auto` for the current player; in debt, the deterministic liquidation |
| `abandon(id)` | anyone, lobby only, 15 min after creation | refunds every stake and the storage deposit |
| `nft_transfer`, `nft_transfer_call`, `nft_resolve_transfer` | NEP-171 | Deeds |

`join`, `play`, `turn` and `timeout` need **at least 100 Tgas attached** ("No re-rolls"); with less they fail with
`attach at least 100 Tgas: ...` before anything happens.

`plan` (every field optional, each list at most 40 squares): `{ buy_reserve: i64, build: Vec<u8>, keep_reserve: i64, bail: bool, liquidate: Vec<u8> }`.
The exact algorithm is documented in `deedlords/src/autoplay.rs`:

```text
loop while seat is the current player:
  roll:  if in jail and plan.bail: use a leave-jail card if held, else pay bail if affordable. Roll.
  debt:  while in debt: Pay if cash >= debt; else Bankrupt if cash + everything sellable < debt;
         else sell one house from the first square (liquidate order, then board order) that has one,
         or else mortgage the first mortgageable square in that order.
  buy:   Buy if cash - price >= buy_reserve (and affordable), else Skip.
  end:   once per roll: build one house on each city of plan.build, in order, if legal and
         cash - house_cost >= keep_reserve. Then Roll again after doubles, else End.
```

`timeout` uses the same debt resolution with an empty `liquidate` list (board order).

Views:

| View | Returns |
|---|---|
| `get_match(id)` | `{ meta, game, log }` or `null`: `meta` has seats (backer, driver, house flag), stake, split, status, rules, deadline, current seat; `game` is the engine snapshot (ENGINE-RULES §8, same field names as the TS `Game`); `log` the last 30 structured engine events |
| `list_matches(from_index, limit)` | unfinished matches (lobby/playing), `limit` ≤ 50 |
| `get_result(id)` | settled summary: ranking (seats), backers and payouts per rank, forfeited, reason, block height, Deed owner |
| `get_stats(account_id)` | `{ played, wins, earned }` |
| `get_forfeited()` | total house shares locked |
| `get_config()` | owner, house, `max_stake` (yoctoNEAR, string), `min_move_gas` (gas units, string), constants |
| `nft_token`, `nft_tokens`, `nft_tokens_for_owner`, `nft_supply_for_owner`, `nft_total_supply`, `nft_metadata` | NEP-171/177/181 |

## Events

Every state change logs `EVENT_JSON:{"standard":"deedlords","version":"1.0.0","event":E,"data":D}`:

| `event` | `data` |
|---|---|
| `create_match` | `{ id, meta }` |
| `join` / `leave` / `set_driver` | `{ id, seat, backer, ... }` |
| `start` | `{ id, order (seats), props (Blitz deal), steps, turn_deadline }` |
| `actions` | `{ id, kind: play\|turn\|timeout, seat, by, steps: [{ action, events: [engine events] }], phase, stage, current_seat, turn_deadline }` (dice are in `roll` events, cards in `card` events). `rejected: { index, action, error }` is added only when an action was refused after a draw; `steps` holds what was kept. |
| `settle` | `{ id, reason, pot, ranks: [{ rank, seat, backer, share, forfeited }], forfeited, deed, block_height, record_bytes, storage_refund }` |
| `abandon` | `{ id, refunds, creator, storage_refund }` |

The Deed mint also logs the standard NEP-171 `nft_mint` event.

## Measurements (local near-sandbox 2.14, 2026-11-10)

| | |
|---|---|
| wasm (release, stripped, no wasm-opt) | 517,560 bytes |
| `create_match` | 3.1–3.3 Tgas per transaction |
| `join` | 2.4–3.9 Tgas (the last join also starts the game) |
| `turn` | 3.1–8.9 Tgas, avg 3.9. Ordinary turns with a 40 + 40 square plan: at most 3.9; the 8.9 is the turn that settles a 3-seat match (three payouts and the Deed mint) |
| `play` | 2.7–7.0 Tgas, avg 3.8. The 7.0 is the largest list allowed, 32 actions |
| `timeout` | 2.6–3.1 Tgas |
| largest possible call (estimate) | `turn` costs about 0.13 Tgas per engine step (fit over the measured turns, at most 8 steps each). The driver stops at 64 steps, so a 64-step turn that also settles is about 17 Tgas. This is an extrapolation, not a measurement |
| gas floor | 100 Tgas = 11 × the heaviest call measured, about 6 × the estimate above |
| storage, 4-seat match | 435 B in the lobby, 714 B once started, ~1.1 KB at its peak, 0 B after settlement except the permanent records (about 0.4–1.3 KB: summary, stats, and the Deed when a non-house seat wins) |

Every call of scenario (e) was sent with exactly 100 Tgas attached, a whole match included.

## Known limits

- **Randomness.** `env::random_seed()` is known to the block producer before the block is published, and a producer
  has a small influence on it. That is acceptable for small stakes only, which is what `max_stake` is for. The cap
  bounds what one seat can lose in one match, not the number of matches.
- **Anyone can create a match**, and outside solo matches one account may back several seats; nothing stops a person
  from using several accounts either. Stats (`played`, `wins`, `earned`) and Deeds can be produced by stake-0 or
  self-played matches: they are a record, not a ranking.
- **Payouts are detached transfers.** If a transfer to a backer fails (the account was deleted), the amount stays in
  the contract and no method moves it.
- **House seats** are played by the house account. Its shares are locked forever, so it cannot profit from a result,
  but it does choose its own moves.
- **No administration.** `owner` is stored and shown by `get_config`; no method checks it. There is no pause, no
  upgrade method and no way to change `house` or `max_stake`. The code can still be replaced by whoever holds a
  full-access key of the contract account: a deployment is only as fixed as that key is (delete it to freeze the code).

## Sandbox harness notes

- `Sandbox.tearDown()` of near-sandbox 0.3.5 waits forever because the 2.14 node ignores SIGTERM. `run.js` stops the
  node itself (SIGTERM, then SIGKILL after 5 s), and has a 20-minute watchdog and a Ctrl-C handler, so no node is left
  running.
