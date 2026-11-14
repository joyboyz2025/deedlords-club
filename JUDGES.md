# For judges and AI screeners

Two ways to check Deedlords Club: three commands in a terminal, or three minutes in a browser. Each line says what you
should see. Where something is not built, the [README](README.md) says so under "Known limits" and "Tracks".

## Three commands

A fresh clone needs Node 22.6 or newer. No key, no account, nothing to configure.

| Command              | What it does                                                                                                                                                                                                                                                                     | It ends with                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `npm ci && npm test` | Unit tests of the rules engines, the card cryptography, the chain adapters, the relayer's rules and the TEE proofs. About ten seconds, no network                                                                                                                                | `# pass 298` and `# fail 0`                                   |
| `npm run typecheck`  | Type-checks the web app, the worker and the server                                                                                                                                                                                                                               | No output, exit code 0                                        |
| `npm run check:live` | Reads NEAR **mainnet** from public nodes and checks the README's claims against real transactions: the three contracts and their code hashes, a poker shuffle with its proof, a guest's relayed move, an AI move signed in a TEE, a payout made by the contract. Nothing is sent | Seventeen lines starting with `✓`, then `Every check passed.` |

One line of `check:live` may start with `!` instead of `✓`: "not confirmed today". It means NEAR AI restarted the
model's enclave after the checked move was made, so today's attestation report lists a new key. The other checks of
that move (the hash, the signature, the model, the plan) do not depend on the report and still hold. The command then
ends with `No check failed.` and exit code 0.

The contracts have their own tests: `cargo test --manifest-path contracts/Cargo.toml` (Rust, a few minutes the first
time).

## Three minutes in a browser

On mainnet: https://deedlords-club.vercel.app. A free table costs you nothing there: a sponsor account pays the gas.
The same app on testnet: https://deedlords-club-testnet.vercel.app.

| Time | Do                                                                                                                                                                     | See                                                                                                                                           |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00 | Open `/play`, press **Play as a guest**                                                                                                                                | A 64-character account name at the top right: a NEAR account whose key was made in this browser. No wallet, no seed phrase, no NEAR           |
| 0:15 | Press **Play vs AI**                                                                                                                                                   | A board opens in about ten seconds. You roll; an AI seat plays its own turn. No pop-up asks you to sign anything                              |
| 1:00 | Press the chain-link button at the left of the board (**Transactions**)                                                                                                | One row per move, each a link to the explorer: calls on `game.deedlords.near`, signed by your key, sent and paid for by `free.deedlords.near` |
| 1:15 | Click a **TEE-signed** tag, or open [this real one](https://deedlords-club.vercel.app/verify?tx=2af7dAbW4rBsDSKKhXAdyTXB35FrxcoXttPiE2swuXEc&from=free.deedlords.near) | "Signed in a TEE, and it holds." with five ticks, computed in your browser from the transaction and NEAR AI's public report                   |
| 1:45 | Open `/poker/tables`, press **Play vs the House**                                                                                                                      | A table opens. Both seats shuffle the deck and prove it to the contract; then your two cards are face up for you alone                        |
| 2:30 | Check or call once, then open a `shuffle` row on the explorer                                                                                                          | A call of about 22 KB that `poker.deedlords.near` accepted: 52 encrypted cards and the proof that they are the same cards in another order    |

The AI seat plays by a model NEAR AI runs in a TEE unless you choose another, so its moves carry a **TEE-signed** tag.
A move the model did not answer in time is played by rules and has no tag.

## Real transactions, without playing

| What                                                                                  | Transaction                                                                            |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| A poker shuffle with its proof (22,555 bytes, 221 Tgas, 0.021 NEAR)                   | [`HucKM9wP…`](https://nearblocks.io/txns/HucKM9wPjKYhhSAtAec7rvDvnKRfnSjNT5CJ9ypHaRWG) |
| A guest's move relayed by the sponsor (4.3 Tgas)                                      | [`2jesymTA…`](https://nearblocks.io/txns/2jesymTABFtwPkeVX29Sc6DFhFvWQX9Rq2jyEAhTcLUx) |
| An AI move signed inside a TEE                                                        | [`2af7dAbW…`](https://nearblocks.io/txns/2af7dAbW4rBsDSKKhXAdyTXB35FrxcoXttPiE2swuXEc) |
| The last move of a staked match: the contract pays both seats in the same transaction | [`Ci1p7yj2…`](https://nearblocks.io/txns/Ci1p7yj2tqF3LXhMNrEjAYQbyuk416u6zcNPVXi3TADJ) |

## What was written when

`git log pre-hackathon..hackathon-submission` lists everything written during the hackathon. What the first commit
already held, file by file with hashes and dates, and which parts an AI assistant wrote: [PROVENANCE.md](PROVENANCE.md).
