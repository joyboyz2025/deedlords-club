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

cd sandbox && npm install && npm test    # local near-sandbox 2.14: 4 scenarios + gas/size/storage numbers
# NEAR_SANDBOX_BIN_PATH=/path/to/near-sandbox reuses an already downloaded 2.14 binary
```

## Model

- A match has 2–4 **seats**. Seat `k` is the engine player `"s<k>"`. Each seat is **backed** by an account that paid
  the stake; one account may back several seats (the house in a solo match). A backer may name a **driver** (an agent
  account) that may also play the seat.
- Backing the last seat **starts** the game in the same call (turn order and the Blitz deal come from the on-chain Rng).
- Every move goes through the engine. Any engine error **rejects the whole call** (the receipt reverts).
- Each turn has a **deadline** (`turn_seconds`, default 20). After it, **anyone** may call `timeout`.
- When the engine reports the end, the contract **settles once**, in that same call.

### Randomness

Each 32-byte block is `sha256(random_seed ‖ match_id ‖ draws_le ‖ salt)` where `random_seed` is `env::random_seed()`,
`draws` is the match's counter (incremented once per hash) and `salt` is `"die"` or `"below"`. `die()` takes the next byte
`< 252` and returns `b % 6 + 1`; `below(n)` takes the next little-endian u32 below `floor(2^32 / n) * n` and returns
`v % n` (rejection sampling, no modulo bias). Remaining risk: a block producer has a small influence on `random_seed`.
On NEAR a contract calling `play` cannot revert a bad roll, because cross-contract calls are asynchronous.

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

- Start of the game and every action of the current seat: `turn_deadline = now + turn_seconds`.
- Out-of-turn `Sell`/`Mortgage`/`Redeem` by a waiting seat do not extend the current player's deadline.
- `timeout` does one step. While the timed-out player still holds the turn, the deadline stays expired, so the next
  step can be forced immediately; when the turn passes, the next player gets a fresh deadline.

## Methods

Change methods (all panic with a readable message on invalid input):

| Method | Who | What |
|---|---|---|
| `new(owner, house)` | contract account (init) | |
| `create_match(id, seats, stake: U128, split: Vec<u16>, rules, solo_player: Option<AccountId>, turn_seconds: Option<u32>)` | anyone, payable (storage) | `id`: 1–32 chars `[A-Za-z0-9_-]`, unique forever once settled. `seats` 2..=4. `split`: 1..=seats basis points per rank, sum 10000. `rules`: `{ salary, cash, blitz, max_rounds }` (`maxRounds` also accepted); Blitz needs `cash >= 1670`. |
| `join(id, seat)` | anyone (solo match: only `solo_player` or `house`), payable exactly `stake` | backs a free seat; the last one starts the game |
| `leave(id, seat)` | the seat's backer, lobby only | refunds the stake |
| `set_driver(id, seat, driver: Option<AccountId>)` | the seat's backer | |
| `play(id, seat, actions: Vec<Action>)` | backer or driver of `seat` | 1..=32 engine actions in order: `"Roll"`, `"Buy"`, `"Skip"`, `"End"`, `"Bail"`, `"Card"`, `"Pay"`, `"Bankrupt"`, `{"Build": i}`, `{"Sell": i}`, `{"Mortgage": i}`, `{"Redeem": i}`. `Sell`/`Mortgage`/`Redeem` work out of turn as the engine allows. `Start`/`Auto` are refused. |
| `turn(id, seat, plan)` | backer or driver of the current seat | whole agent turn in one transaction (below) |
| `timeout(id)` | anyone, after the deadline | engine `Auto` for the current player; in debt, the deterministic liquidation |
| `abandon(id)` | anyone, lobby only, 15 min after creation | refunds every stake and the storage deposit |
| `nft_transfer`, `nft_transfer_call`, `nft_resolve_transfer` | NEP-171 | Deeds |

`plan` (every field optional): `{ buy_reserve: i64, build: Vec<u8>, keep_reserve: i64, bail: bool, liquidate: Vec<u8> }`.
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
| `get_config()` | owner, house, constants |
| `nft_token`, `nft_tokens`, `nft_tokens_for_owner`, `nft_supply_for_owner`, `nft_total_supply`, `nft_metadata` | NEP-171/177/181 |

## Events

Every state change logs `EVENT_JSON:{"standard":"deedlords","version":"1.0.0","event":E,"data":D}`:

| `event` | `data` |
|---|---|
| `create_match` | `{ id, meta }` |
| `join` / `leave` / `set_driver` | `{ id, seat, backer, ... }` |
| `start` | `{ id, order (seats), props (Blitz deal), steps, turn_deadline }` |
| `actions` | `{ id, kind: play\|turn\|timeout, seat, by, steps: [{ action, events: [engine events] }], phase, stage, current_seat, turn_deadline }` (dice are in `roll` events, cards in `card` events) |
| `settle` | `{ id, reason, pot, ranks: [{ rank, seat, backer, share, forfeited }], forfeited, deed, block_height, record_bytes, storage_refund }` |
| `abandon` | `{ id, refunds, creator, storage_refund }` |

The Deed mint also logs the standard NEP-171 `nft_mint` event.

## Measurements (local near-sandbox 2.14, 2026-11-10)

| | |
|---|---|
| wasm (release, stripped, no wasm-opt) | 513,130 bytes |
| `create_match` | ~3.2 Tgas per transaction |
| `join` | 2.4–3.9 Tgas (the last join also starts the game) |
| `turn` | 3.1–5.1 Tgas, avg 3.5 (the settling turn pays out and mints the Deed) |
| `play` | 2.6–5.9 Tgas, avg 3.1 |
| `timeout` | ~2.7 Tgas |
| storage, 4-seat match | 435 B in the lobby, 714 B once started, ~1.1 KB at its peak, 0 B after settlement except the permanent records (about 0.4–1.3 KB: summary, stats, and the Deed when a non-house seat wins) |

## Sandbox harness notes

- `Sandbox.tearDown()` of near-sandbox 0.3.5 waits forever because the 2.14 node ignores SIGTERM. `run.js` stops the
  node itself (SIGTERM, then SIGKILL after 5 s), and has a 20-minute watchdog and a Ctrl-C handler, so no node is left
  running.
