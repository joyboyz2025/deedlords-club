# Deedlords contracts

Deployed on NEAR mainnet under `deedlords.near` (read on 2026-11-13; `npm run check:live` at the repository root
reads them again):

| Account | Crate | Code hash |
|---|---|---|
| `game.deedlords.near` | `deedlords/` | `Ha6nhaKnZ8p4SyGrvhgzniXNujjhbwfi3WKobcwMv5o6` |
| `poker.deedlords.near` | `poker-table/` | `7gBmMKnAkiroQJsMa1NnEoogPTotqsnEHiFzk6KRPb5Y` |
| `chibi.deedlords.near` | `chibi/` | `BxzvTicT3UR8VcocQL7tDMW3D29jSTbfRGAWB6L7158C` |

On testnet under `deedlords.testnet`: `game.`, `pokertable.` (`poker-table/`), `poker.` (`poker/`), `chibi.`, `arena.`.
`sandbox/mainnet.js plan` prints every transaction a mainnet deployment or upgrade would sign, `rehearse` runs the same
steps on a local near-sandbox, `run --yes` sends them; an upgrade keeps the contract's state.

The rest of this file is about the board game's contract. The poker contracts document themselves at the top of their
sources: `poker/src/shuffle.rs` (the shuffle proof and its verifier), `poker/src/curve.rs` (BN254 through NEAR's
`alt_bn128` host functions), `poker-table/src/lib.rs` (a table of two to nine seats: keys, shuffles, shares, bets,
deadlines, free tables), `poker-table/src/pots.rs` (side pots). Each is its own Cargo workspace:
`cargo test --manifest-path poker/Cargo.toml`, `cargo test --manifest-path poker-table/Cargo.toml` (about eight minutes:
one hand of nine seats is played with real proofs).

The crates:

| Crate | What it is |
|---|---|
| `engine/` (`deedlords-engine`) | The game rules: a pure, deterministic, integer-only Rust port of the TS engine. No NEAR dependency. Contract with the TS engine: `docs/ENGINE-RULES.md`. |
| `deedlords/` (`deedlords`) | The NEAR contract around the engine: matches, stakes, on-chain dice, turn deadlines, payouts, Deed NFTs (NEP-171), stats. |
| `chibi/` (`deedlords-chibi`) | Chibi characters as NFTs (NEP-171 + enumeration + metadata): one character per account, every look item a token, free basic items (paid from a free pool the minter draws on), boxes of rarer items bought with NEAR. Its catalogue `src/catalog.rs` is generated from the game's chibi parts (`npm run chibi:catalog`). Testnet: `chibi.deedlords.testnet`. Sandbox and testnet deploy: `sandbox/chibi-run.js`. |
| `sandbox/` | `run.js`: integration test on a local `near-sandbox` (never leaves this machine). `testnet.js`: testnet deploy + latency check (refuses mainnet). `sponsor.js`: creates the testnet account that pays for free play (refuses mainnet). |

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

cd sandbox && npm install && npm test    # local near-sandbox 2.14: 6 scenarios + gas/size/storage numbers
# NEAR_SANDBOX_BIN_PATH=/path/to/near-sandbox reuses an already downloaded 2.14 binary

# Testnet deploy + latency check (sandbox/testnet.js; it refuses mainnet and reads keys from ~/.near-credentials/testnet)
npm run testnet:dry                                   # the same flow on a local sandbox, nothing leaves this machine
npm run testnet:dry-recover                           # sandbox again: a run cut off mid-match, then a second run that recovers (about 3 min)
DEEDLORDS_PARENT=<you>.testnet npm run testnet:plan   # read-only: balances and the transactions `run` would sign
DEEDLORDS_PARENT=<you>.testnet npm run testnet:run    # creates game./house./p1./p2.<you>.testnet, deploys, plays 3 matches
```

`testnet:run` can be repeated: it skips the accounts and the deploy that already exist, deletes session keys left by an
interrupted run and finishes its unfinished matches before starting new ones. It paces its RPC requests
(`DEEDLORDS_RPC_GAP_MS`, default 350) and retries with backoff, because the free public RPC answers HTTP 429 when asked
too often.

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
proposed (5% of the unspent gas), a move would cost about 5 Tgas more. Testnet (protocol 88, 2026-11-10) refunds in
full too: eight moves with 100 Tgas attached to each took 0.0031 NEAR in total from the signing key's allowance, the
fees they burnt and nothing more. Not measured on mainnet.

### Settlement

`pot = stake × seats`. The contract first keeps its **fee**, `pot × fee_bps / 10000` rounded down; rank `i` then gets
`(pot − fee) × split[i] / 10000`, the integer remainder going to rank 0, so fee + shares = pot to the yocto. Shares of
seats backed by the **house** are added to `forfeited` and never paid out (no method moves them). Other shares are
transferred to the backers. A **Deed** NFT (token id = match id) is minted to the winner's backer unless the winner is a house seat.
Stats and a summary are stored, the match state is deleted, and the creator's storage deposit is refunded minus the
bytes of the permanent records (summary, stats, Deed), so finished matches never eat the contract's own balance.

### Fee

`fee_bps` is given to `new` (or to `migrate`), at most 500 (5%, `MAX_FEE_BPS`). The owner changes it with `set_fee`,
which needs 1 yoctoNEAR attached (so only a full-access key signs it) and applies to matches opened from then on: each
match writes the fee in force under a storage key of its own (`fee:<id>`, outside `Match`, paid by the creator's
storage deposit) and is settled at that rate, so a change never reaches a stake already made. A match opened before
these records existed pays the fee in force before the first `set_fee`, which that call keeps under `fee_before_set`.
`get_config` shows the fee for new matches, each match's `meta` its own. Since 2026-11-12 the testnet deployment's fee
is 0 (matches opened there before keep their 2.5%). The fee is taken only when a match is settled: `leave` and
`abandon` return stakes whole.
Collected fees add up in a counter (`get_fees`); `withdraw_fees` sends exactly that amount to the owner and resets it.
It needs 1 yoctoNEAR attached, so only a full-access key of the owner can sign it. Stakes of open matches, storage
deposits and the house's forfeited shares are not in the counter and cannot be withdrawn.

Whoever holds a full-access key of the contract account can still deploy other code: the rules above describe this
code, not the account.

### Upgrading a deployment made before the fee

The first testnet deployment (2026-11-10) has no `fee_bps` and `fees` in its state. `migrate(fee_bps)` reads that
layout and writes the new one; it must be called by the contract account **in the same transaction as the deploy**
(`[DeployContract, FunctionCall migrate]`), because the new code cannot read the old state. It is refused while any
match is open (its players staked when there was no fee). Matches, results, stats and Deeds keep their layout: a match
settled before the upgrade stays readable and reports a fee of 0. `sandbox/testnet.js run` does this by itself when it
finds the old contract; `DEEDLORDS_V1_WASM=<old wasm> npm test` and `DEEDLORDS_V1_WASM=<old wasm> npm run testnet:dry`
rehearse it on a local sandbox.

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
| `new(owner, house, max_stake: U128, fee_bps: u16)` | contract account (init) | `max_stake`: the most yoctoNEAR one seat may stake in this deployment, at most 1,000,000 NEAR. `fee_bps`: the contract's fee on every pot in basis points, at most 500. Both fixed for the life of the contract. |
| `migrate(fee_bps: u16)` | contract account, together with the deploy | upgrades a deployment made before the fee (above) |
| `create_match(id, seats, stake: U128, split: Vec<u16>, rules, solo_player: Option<AccountId>, turn_seconds: Option<u32>, host: Option<AccountId>)` | anyone, payable (storage) | `id`: 1–32 chars `[A-Za-z0-9_-]`, unique forever once settled. `seats` 2..=4. `stake` ≤ `max_stake`. `split`: 1..=seats basis points per rank, sum 10000. `rules`: `{ salary, cash, blitz, max_rounds }` (`maxRounds` also accepted); `max_rounds` is required, 1..=255, so every match ends; Blitz needs `cash >= 1670`. `solo_player` may not be the house. `host`: the match is a room that only this account starts (`start`); not with `solo_player`. Kept under its own storage key, so matches stored before hosts existed read unchanged. |
| `join(id, seat)` | anyone, payable exactly `stake`. Solo match: the solo player (one seat) and the house (all the others; it cannot take the last free seat while the solo player is not seated) | backs a free seat; the last one starts the game, unless the match has a host |
| `start(id)` | the host, once every seat is taken, ≥ 100 Tgas | starts a hosted match (draws the turn order); `play(id, seat, ["Start"])` does the same, so a session key can send it |
| `leave(id, seat)` | the seat's backer, lobby only | refunds the stake |
| `set_driver(id, seat, driver: Option<AccountId>)` | the seat's backer | |
| `play(id, seat, actions: Vec<Action>)` | backer or driver of `seat` | 1..=32 engine actions in order: `"Roll"`, `"Buy"`, `"Skip"`, `"End"`, `"Bail"`, `"Card"`, `"Pay"`, `"Bankrupt"`, `"Resign"`, `{"Build": i}`, `{"Sell": i}`, `{"Mortgage": i}`, `{"Redeem": i}`. `Sell`/`Mortgage`/`Redeem` work out of turn as the engine allows; so does `Resign` (giving up, any time: the seat goes bankrupt, see ENGINE-RULES §7). `Auto` is refused, and `Start` except alone from a hosted match's host (`start`). Returns `{ "applied": n, "rejected": null \| { "index", "action", "error" } }`: read `rejected`, a call that rolled succeeds even when a later action was refused ("No re-rolls"). |
| `turn(id, seat, plan)` | backer or driver of the current seat | whole agent turn in one transaction (below) |
| `timeout(id)` | anyone, after the deadline | engine `Auto` for the current player; in debt, the deterministic liquidation |
| `abandon(id)` | anyone, lobby only, 15 min after creation | refunds every stake and the storage deposit |
| `withdraw_fees()` | the owner, payable exactly 1 yoctoNEAR | sends the collected fees to the owner, returns the amount |
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
| `get_match(id)` | `{ meta, game, log }` or `null`: `meta` has seats (backer, driver, house flag), stake, split, `fee_bps`, status, rules, deadline, current seat; `game` is the engine snapshot (ENGINE-RULES §8, same field names as the TS `Game`); `log` the last 30 structured engine events |
| `list_matches(from_index, limit)` | unfinished matches (lobby/playing), `limit` ≤ 50 |
| `get_result(id)` | settled summary: `pot`, `fee`, ranking (seats), backers and payouts per rank, forfeited, reason, block height, Deed owner |
| `get_stats(account_id)` | `{ played, wins, earned }` |
| `get_forfeited()` | total house shares locked |
| `get_fees()` | fees collected and not yet withdrawn |
| `get_config()` | owner, house, `max_stake` (yoctoNEAR, string), `fee_bps`, `max_fee_bps`, `min_move_gas` (gas units, string), constants |
| `nft_token`, `nft_tokens`, `nft_tokens_for_owner`, `nft_supply_for_owner`, `nft_total_supply`, `nft_metadata` | NEP-171/177/181 |

## Events

Every state change logs `EVENT_JSON:{"standard":"deedlords","version":"1.0.0","event":E,"data":D}`:

| `event` | `data` |
|---|---|
| `create_match` | `{ id, meta }` |
| `join` / `leave` / `set_driver` | `{ id, seat, backer, ... }` |
| `start` | `{ id, order (seats), props (Blitz deal), steps, turn_deadline }` |
| `actions` | `{ id, kind: play\|turn\|timeout, seat, by, steps: [{ action, events: [engine events] }], phase, stage, current_seat, turn_deadline }` (dice are in `roll` events, cards in `card` events). `rejected: { index, action, error }` is added only when an action was refused after a draw; `steps` holds what was kept. |
| `settle` | `{ id, reason, pot, fee, fee_bps, ranks: [{ rank, seat, backer, share, forfeited }], forfeited, deed, block_height, record_bytes, storage_refund }` (`share` is after the fee) |
| `withdraw_fees` | `{ to, amount }` |
| `abandon` | `{ id, refunds, creator, storage_refund }` |

The Deed mint also logs the standard NEP-171 `nft_mint` event.

## Session keys (no wallet prompt per move)

`play`, `turn`, `timeout`, `set_driver` and `leave` take no deposit, so a seat can be played with a **function-call
access key**: receiver = the game contract, methods = those five, plus an allowance for fees. The app holds that key
and signs every move itself. The wallet is asked only for what carries a deposit, `create_match` (storage) and `join`
(the stake), and once to add the key.

Checked by `sandbox/testnet.js` with a 0.25 NEAR allowance, on the local sandbox and on NEAR testnet (2026-11-10, two
runs against `game.deedlords.testnet`):

- Testnet: 28 moves (`play` and `turn`) signed by session keys with exactly 100 Tgas attached, all accepted.
- The protocol refuses the same key, before execution and at no cost, when it attaches a deposit
  (`DepositWithFunctionCall`), calls a method outside its list (`MethodNameMismatch`) or sends a transfer
  (`RequiresFullAccess`). Same three answers on the sandbox and on testnet.
- The allowance pays only the fee actually burnt. On testnet 8 moves took 0.003105 NEAR from it (0.250000 →
  0.246894), although 100 Tgas was attached to each (0.08 NEAR in total at that gas price). That is about 0.0004 NEAR
  per move, so 0.25 NEAR lasts about 640 moves. (Sandbox: 8 moves took 0.00233 NEAR.)
- The script deletes its session keys at the end. A run that is cut off leaves them on the accounts; the next run
  deletes them first.

## Measurements (local near-sandbox 2.14, 2026-11-10)

| | |
|---|---|
| wasm (release, stripped, no wasm-opt) | 517,560 bytes (525,921 with the fee, built 2026-11-10; the rows below were measured before it) |
| `create_match` | 3.1–3.3 Tgas per transaction |
| `join` | 2.4–3.9 Tgas (the last join also starts the game) |
| `turn` | 3.1–8.9 Tgas, avg 3.9. Ordinary turns with a 40 + 40 square plan: at most 3.9; the 8.9 is the turn that settles a 3-seat match (three payouts and the Deed mint) |
| `play` | 2.7–7.0 Tgas, avg 3.8. The 7.0 is the largest list allowed, 32 actions |
| `timeout` | 2.6–3.1 Tgas |
| largest possible call (estimate) | `turn` costs about 0.13 Tgas per engine step (fit over the measured turns, at most 8 steps each). The driver stops at 64 steps, so a 64-step turn that also settles is about 17 Tgas. This is an extrapolation, not a measurement |
| gas floor | 100 Tgas = 11 × the heaviest call measured, about 6 × the estimate above |
| storage, 4-seat match | 435 B in the lobby, 714 B once started, ~1.1 KB at its peak, 0 B after settlement except the permanent records (about 0.4–1.3 KB: summary, stats, and the Deed when a non-house seat wins) |

Every call of scenario (e) was sent with exactly 100 Tgas attached, a whole match included.

## Measurements (NEAR testnet, 2026-11-10)

Test deployment: `game.deedlords.testnet` (code hash `CRBA9Sf1dTadmgPPXwQS75ef84n7aV2eWjEBfiGEuWkK`, owner
`deedlords.testnet`, house `house.deedlords.testnet`, `max_stake` 1 NEAR, `fee_bps` 250). Its full-access key still
exists, so the code can be replaced ("Known limits").

It was first deployed without the fee (code hash `CWgLMPL61iCd8VN2mTSUC3FNvMXq74TPXixXcsXHSesi`) and upgraded in place
on 2026-11-10 by `sandbox/testnet.js run`: one transaction with the deploy (525,921 bytes) and `migrate(250)`,
`3bWxiEx4RxRVkCrr7w5RBrh1VnQ2NMY84pGbVzfWbRii`, 40.18 Tgas, 3.996 mNEAR, result after 2.64 s, final after 4.25 s.
Read back afterwards: the five matches settled before the upgrade still answer `get_result` (fee 0), the three played
after it paid 0.0025 NEAR each on a 0.1 NEAR pot (`get_fees` 0.0075 NEAR), no session key and no open match were left.
The table below was measured on the first build.

Measured by `sandbox/testnet.js run` through the free public RPC `https://test.rpc.fastnear.com` (one RPC round trip:
about 0.25 s). Protocol 88, block time 0.60 s, gas price 10^8 yoctoNEAR per gas unit, 100 Tgas attached to every
call. Stakes 0.05 NEAR per seat. Times run from sending the transaction until the RPC reports it:

- **result**: status `EXECUTED_OPTIMISTIC`, the call and the receipts it produced (payouts included, gas refunds
  excluded) have run;
- **final**: status `FINAL`.

| call | n | result, s: median (min–max) | final, s: median (min–max) | gas burnt, Tgas: median / max | fee, mNEAR: median / max |
|---|---|---|---|---|---|
| `create_match` | 3 | 2.04 (1.92–2.17) | 3.76 (3.34–4.07) | 3.41 / 3.43 | 0.319 / 0.321 |
| `join` | 3 | 2.08 (1.65–2.13) | 3.79 (3.32–4.19) | 2.67 / 2.67 | 0.244 / 0.245 |
| `join` (last seat: starts the game) | 3 | 2.29 (2.16–2.35) | 3.96 (3.32–4.09) | 2.94 / 3.56 | 0.272 / 0.334 |
| `play` | 7 | 1.76 (1.68–2.15) | 3.51 (3.31–3.91) | 2.98 / 3.05 | 0.276 / 0.282 |
| `play` that settles and pays out | 1 | 2.46 | 4.22 | 8.21 | 0.754 |
| `turn` | 6 | 2.06 (1.36–2.44) | 3.90 (3.12–4.11) | 3.69 / 3.85 | 0.347 / 0.363 |
| `turn` that settles and pays out | 2 | 2.71 (2.27–3.14) | 4.27 (3.80–4.74) | 7.20 / 7.38 | 0.676 / 0.693 |
| `timeout` | 3 | 1.74 (1.71–2.19) | 3.50 (3.24–4.02) | 2.99 / 3.01 | 0.277 / 0.278 |
| `timeout` that settles and pays out | 1 | 2.68 | 4.70 | 8.28 | 0.784 |
| add or delete a session key | 9 | 1.17–1.72 | 2.82–3.43 | 0.64 | 0.042 |
| deploy the wasm (517,560 bytes) | 1 | 2.72 | 4.53 | 37.76 | 3.753 |
| `new` | 1 | 1.58 | 3.34 | 3.96 | 0.374 |
| `get_match` (view, no transaction) | 24 | 0.25 (0.24–0.29) | | | |

- In blocks: a transaction was included 3 blocks (2–4) after the chain head seen when it was sent, the contract's
  result came 1 block later, and the last receipt (the gas refund) 2 blocks after inclusion, 3 when the call settles
  (the payouts are one more hop). On the local sandbox the same counts are 2, +1, +2 and +3.
- So a move shows its result after about 2 s and is final after about 3.5–4 s. On the sandbox (126 ms blocks) the same
  move takes about 0.37 s and 0.75 s: the difference is block time and the RPC round trips.
- Five matches were played to settlement (two through `play`, two solo through `turn`, one forced entirely by
  `timeout` from a third account). The contract account then held 523,392 bytes of storage, against 517,964 right
  after deploy + `new`: about 1.1 KB of permanent records per match.
- The table is the second run. The first run was cut off by the RPC's rate limit (HTTP 429) in the middle of a match;
  its samples agree (`play`, n = 8: 1.98 s / 3.82 s; `turn`, n = 3: 1.84 s / 3.56 s). Deploy and `new` are from that
  first run. The second run deleted the session keys the first one left and finished its match.
- Small samples from one machine and one RPC provider: read the times as an order of magnitude. Nothing here was
  measured on mainnet.

### Upgrade of 2026-11-12: giving up, and hosted rooms

`game.deedlords.testnet` was upgraded in place (code hash `CRBA9Sf1…` → `GWbj4WHw…`, 531,595 bytes, tx
`FHX5j1i9GEpfmXHsJsfP28QAzeaEs1wmFiYHiHsWxeAU`) with a plain deploy, no `migrate`: `Action::Resign` and
`Event::Resign` were added at the end of their enums, and a match's host lives under its own key (`host:<id>`), so
every stored match reads as before. `sandbox/upgrade.js dry` rehearses exactly this on a local sandbox, starting from
the code fetched from testnet, with a lobby and a game in progress opened on it; `sandbox/upgrade.js run` deploys.

### Tickets and the leader's rent (2026-11-14, not deployed yet)

Two rules a match may be opened with (docs/ENGINE-RULES.md section 10), both off unless asked for:

- `create_match`'s `rules` may also carry `"tickets": true` and `"leaderRent": true`. The method's arguments are the
  ones of before; the two fields are read from the call's own JSON, so a contract deployed before them ignores them
  without a word. `get_config` therefore lists what a build knows, `"features": ["tickets", "leaderRent"]`, and the
  page sends the fields only to a contract that lists them (`games/co-ty-phu/chain/calls.ts` `extrasOf`).
- A match with them shows `rules.tickets` / `rules.leaderRent` in its `meta` and `game.tickets` in `get_match`
  (`{ held, waiver, festival }`); a match without has neither, and plays, logs and reads exactly as before.
- Four more actions for `play`: `"Waiver"`, `"Festival"`, `"Takeover"`, `{"Steps": n}` (2..=12). `turn`'s plan may carry
  `"tickets": { "waiver": bool, "festival": bool, "steps": n, "takeover": [squares] }`: before a throw the driver plays
  the Festival and the Rent waiver if asked and held, then `Steps(n)` if allowed, else `Roll`; after a landing it plays
  a Takeover when the city stood on is listed and `cash - 2 * price >= buy_reserve`. Five more events in the log:
  `drew`, `played`, `waived`, `taken`, `raised`.
- **Storage.** A stored match is the layout of before, to the byte, when it has neither rule. With one, the top bit of
  its status byte is set and a tail follows the game (a version byte, the two flags, the ticket state). What earlier
  builds stored reads as a match without the rules: the upgrade is a plain deploy, no `migrate`, and open matches
  play on. (The other way round does not hold: a build from before cannot read a match opened with the rules.)

Checked on a local sandbox only: `DEEDLORDS_ONLY=i node run.js <wasm>` (every ticket through the contract, tables of 2
and 4 settled, a match without the rules) and `node upgrade.js dry <wasm>` from the code live on testnet and, with
`DEEDLORDS_PARENT=deedlords.near NEAR_RPC=https://free.rpc.fastnear.com`, from the code live on mainnet (both are
`Ha6nhaKn…`, 534,311 bytes): matches opened before the deploy read the same after it and play on to their settlement.
The new build is 583,211 bytes: **the game account must hold about 0.49 NEAR more for its code before the deploy.**

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
- The sandbox node forgets a block about a minute after producing it (`UNKNOWN_BLOCK` on a later lookup), and a
  transaction's block hash is valid there for 100 blocks only (about 12 s). `testnet.js --sandbox` therefore reads
  block heights right after each transaction and refreshes its block hash every 4 s; on testnet it reads the heights
  once at the end, to spare the public RPC.
