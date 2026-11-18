# For judges and AI screeners

Two ways to check Deedlords Club: commands in a terminal, or three minutes in a browser. Each line says what you
should see. Where something is not built, the [README](README.md) says so under "Known limits" and "Tracks".

## Three commands

A fresh clone needs Node 22.6 or newer. No key, no account, nothing to configure.

| Command | What it does | It ends with |
|---|---|---|
| `npm ci && npm test` | Unit tests of the rules engines, the card cryptography, the chain adapters, the relayer's rules and the TEE proofs. About ten seconds, no network | `# pass 317` and `# fail 0` |
| `npm run typecheck` | Type-checks the web app, the worker and the server | No error and exit code 0 (npm only echoes the command) |
| `npm run check:live` | Reads NEAR **mainnet** from public nodes and checks what the README says against real transactions: the three contracts and their code hashes, a poker shuffle with its proof, a guest's relayed move, an AI move signed in a TEE, a payout made by the contract. Nothing is sent | Seventeen lines starting with `✓`, then `Every check passed.` |

One line of `check:live` may start with `!` instead of `✓`: "not confirmed today". It means NEAR AI restarted the
model's enclave after the checked move was made, so today's attestation report lists a new key. The other checks of
that move (the hash, the signature, the model, the plan) do not depend on the report and still hold. The command then
ends with `No check failed.` and exit code 0.

More, for whoever wants it:

| Command | What it does | It ends with |
|---|---|---|
| `npm run build` | The production build of the web app | Next.js's list of routes, exit code 0 |
| `cargo test --manifest-path contracts/Cargo.toml` | The board-game contract, its rules engine, the characters and Arena, in Rust. A few minutes the first time | `test result: ok` for every crate, 136 tests in all |
| `cargo test --manifest-path contracts/poker/Cargo.toml` | The shuffle proof, its verifier and heads-up poker | `test result: ok. 19 passed` |
| The `curl` line in the README's [section 5](README.md#5-money-from-any-chain-near-intents-1click) | Asks the testnet site for a NEAR Intents (1Click) quote: what 1 NEAR costs in USDC on Base. No key, and nothing can be sent: 1Click has no testnet, so the quote is a dry one | JSON with `amountInFormatted`, `"live":false` and `"depositAddress":null` |

The README's "Run it yourself" has two longer ones: the poker tables of two to nine seats with real proofs (24 tests,
about eight minutes), and the board game played on a local near-sandbox, for which the contract is built first.

## Three minutes in a browser

On mainnet: https://www.deedlords.xyz. A free table costs you nothing there: a sponsor account pays the gas.
The same app on testnet: https://testnet.deedlords.xyz. The demo video, three minutes:
https://x.com/hoangalt/status/2121687720829587954.

| Time | Do | See |
|---|---|---|
| 0:00 | Open `/play`, press **Play as a guest** | Your account at the top right, shortened like `4b57da…105f`: a NEAR implicit account (64 hex characters) whose key was made in this browser. No wallet, no seed phrase, no NEAR |
| 0:15 | Press **Play vs AI** | A board opens in about ten seconds. You roll, or the dice roll by themselves after five seconds; an AI seat plays its own turn. No pop-up asks you to sign anything |
| 1:00 | Press the chain-link button at the left of the board (**Transactions**) | One row per move, each a link to the explorer: calls on `game.deedlords.near`, signed by your key, sent and paid for by `free.deedlords.near` |
| 1:15 | Click a **TEE-signed** tag, or open [this real one](https://www.deedlords.xyz/verify?tx=2af7dAbW4rBsDSKKhXAdyTXB35FrxcoXttPiE2swuXEc&from=free.deedlords.near) | "Signed in a TEE, and it holds." with five ticks, computed in your browser from the transaction and NEAR AI's public report |
| 1:45 | Open `/poker/tables`, press **Play vs the House** | A table opens. Both seats shuffle the deck and prove it to the contract; then your two cards are face up for you alone |
| 2:30 | Check or call once, open **Table details** under the table, then a `shuffle` transaction on the explorer | A call of about 22 KB that `poker.deedlords.near` accepted: 52 encrypted cards and the proof that they are the same cards in another order |

The AI seat plays by a model NEAR AI runs in a TEE unless you choose another, so its moves carry a **TEE-signed** tag.
A move the model did not answer in time is played by rules and has no tag.

## Real transactions, without playing

| What | Transaction |
|---|---|
| A poker shuffle with its proof (22,555 bytes, 221 Tgas, 0.021 NEAR) | [`HucKM9wP…`](https://nearblocks.io/txns/HucKM9wPjKYhhSAtAec7rvDvnKRfnSjNT5CJ9ypHaRWG) |
| A guest's move relayed by the sponsor (4.3 Tgas) | [`2jesymTA…`](https://nearblocks.io/txns/2jesymTABFtwPkeVX29Sc6DFhFvWQX9Rq2jyEAhTcLUx) |
| An AI move signed inside a TEE | [`2af7dAbW…`](https://nearblocks.io/txns/2af7dAbW4rBsDSKKhXAdyTXB35FrxcoXttPiE2swuXEc) |
| The last move of a staked match: the contract pays both seats in the same transaction | [`Ci1p7yj2…`](https://nearblocks.io/txns/Ci1p7yj2tqF3LXhMNrEjAYQbyuk416u6zcNPVXi3TADJ) |
| A real NEAR Intents (1Click) top-up: ETH sent on Arbitrum, 0.29 NEAR delivered to the game account | [`0x089a902b…`](https://arbiscan.io/tx/0x089a902bce51fb3caf24376080a74c94556b1c5d02cb222fd6def95f9c58e774), then [`98PnDJ3r…`](https://nearblocks.io/txns/98PnDJ3rS5w1BmD583VMXzPsSxb29SgwVkd3PYdMFDb7) |

The README's [Every feature, with a real transaction](README.md#every-feature-with-a-real-transaction) has one
transaction for each feature: dealing, betting, opening cards and the showdown at poker, a timeout, a table closed
after everyone left, characters made and bought, three 1Click swaps, the contract upgrade.

The explorer answers a script with HTTP 403: open these in a browser, or let `npm run check:live` read the same four
transactions from public RPC nodes.

## What was written when

`git log pre-hackathon..hackathon-submission` lists everything written during the hackathon; on GitHub,
[pre-hackathon...hackathon-submission](https://github.com/joyboyz2025/deedlords-club/compare/pre-hackathon...hackathon-submission).
What the first commit already held, file by file with hashes and dates, and which parts an AI assistant wrote:
[PROVENANCE.md](PROVENANCE.md).
