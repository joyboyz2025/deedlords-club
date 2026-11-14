# Deedlords Club

Poker with no dealer and a property board game with no game server, **fully on chain**, for real stakes on **NEAR
mainnet**. NEAR contracts are the dealer, the dice, the referee and the bank: the rules, the deck, the pot and the
whole state of every game live in them, and every move is a transaction. At the poker table every seat shuffles the
deck under its own key and proves the shuffle to the contract in zero knowledge, so nobody ever holds the deck: not a
server, not an enclave, not us. A guest plays in about ten seconds with no wallet and no NEAR. An auto-battler is in
the repository and shown as a trailer.

| | |
|---|---|
| Play on mainnet | https://deedlords-club.vercel.app |
| The same app on testnet, where everything is free | https://deedlords-club-testnet.vercel.app |
| Check the claims below against mainnet, with no key | `npm ci && npm run check:live` |
| For judges and AI screeners | [JUDGES.md](JUDGES.md): three minutes in the browser, three commands in a terminal, and what each shows |
| Tracks | `games`, `privacy`, `open`: [how each brief is answered](#tracks) |
| Built | for NEAR HACKATHON, November 2026. What predates it: [PROVENANCE.md](PROVENANCE.md) |

## The problem, and what this does about it

An online card or board game played for money asks every player to trust the operator's server with three things: the
randomness (who shuffled, who rolled), the rules (was that move legal) and the pot (will it be paid). A blockchain can
hold the rules and the pot in public, but two things usually stop there: a card game needs cards nobody can see, and a
player who has to buy a token, install a wallet and approve a pop-up for every move does not play.

| The usual obstacle | What is built here | NEAR feature it stands on |
|---|---|---|
| A public chain cannot keep a card hidden | Every seat shuffles the deck under its own key and proves the shuffle in zero knowledge; the contract refuses a deck without a valid proof. Nobody, the operator included, can read a face-down card | BN254 host functions (`alt_bn128_g1_multiexp`, `alt_bn128_g1_sum`), 300 Tgas per transaction |
| Somebody has to roll the dice | The contract draws them from the chain's own randomness in the same transaction as the move | `env::random_seed`, contract state |
| A wallet pop-up for every move | One approval for a whole match: a key that can only call the game contract signs the moves | Function-call access keys |
| A new player has no NEAR | A guest plays free tables holding nothing: the guest signs each move, a sponsor account sends it and pays the gas | Implicit accounts, meta-transactions (NEP-366) |
| The player's money is on another chain | A stake that the account cannot pay is topped up from USDC or ETH on Base, Arbitrum or Ethereum | NEAR Intents (1Click) |
| An AI opponent is a black box | An agent's move carries a signature from the hardware enclave its model ran in. Anyone can check which model made the move; nobody can read the owner's instructions | NEAR AI Cloud (TEE inference and attestation) |

## Check it in one command

Nothing to configure, no key, nothing is sent. This reads NEAR mainnet from public nodes and checks the claims above
against real transactions:

```bash
npm ci
npm run check:live
```

It prints seventeen checks in five groups and exits 0 when all pass (`scripts/check-live.ts`):

1. the three contracts are deployed on mainnet, with the code hashes listed below;
2. a real poker `shuffle`: 22,555 bytes of deck and proof in the call, accepted by the contract, 221 Tgas;
3. a guest's move: signed by the guest's key, sent and paid for by `free.deedlords.near`;
4. an AI agent's move: the five checks of its TEE proof (the same ones the `/verify` page runs in the browser);
5. a staked match whose last move made the contract pay the stakes out.

`npm test` runs the 298 unit tests of the rules engines, the chain adapters, the relayer's rules and the proofs (about
ten seconds, no network).

## Try it in the browser: do X, see Y

Use either site. On mainnet a free table costs you nothing (a sponsor pays the gas); a staked table uses real NEAR.

| # | Do | See |
|---|---|---|
| 1 | Open [`/play`](https://deedlords-club.vercel.app/play), press **Play as a guest** | A 64-character account name at the top right: a NEAR account whose key was just made in this browser. No wallet, no NEAR |
| 2 | Keep the **vs AI** tile and press **Play vs AI**. Unless you choose another under **Table options**, the AI seat plays by a model NEAR AI runs in a TEE (its name starts with `near:`), so its moves can be verified | A board of 40 world cities opens in about ten seconds: the sponsor first opens the table and seats its AI on chain. The dice roll by themselves after five seconds; the AI seat answers on its turns |
| 3 | Press the chain-link button at the left of the board (**Transactions**) | One row per move, each a link to the explorer. There your moves are calls of `play` on `game.deedlords.near` by your account, inside transactions signed and paid by `free.deedlords.near`. A row with a **TEE-signed** tag is an AI move that carries a proof |
| 4 | Click a **TEE-signed** tag, or open [this real one](https://deedlords-club.vercel.app/verify?tx=2af7dAbW4rBsDSKKhXAdyTXB35FrxcoXttPiE2swuXEc&from=free.deedlords.near) | "Signed in a TEE, and it holds." with five ticks, computed in your browser from the transaction and NEAR AI's public attestation report |
| 5 | Open [`/poker/tables`](https://deedlords-club.vercel.app/poker/tables), keep **vs House**, press **Play vs the House** | A table opens and a hand is dealt: both seats shuffle, then your two cards are face up for you only. Every step is a call on [`poker.deedlords.near`](https://nearblocks.io/address/poker.deedlords.near): `shuffle`, `deal`, `act`, `open`, `show` |
| 6 | On `/play` sign in with an **EVM wallet** instead, choose **Stake**, type a stake larger than the account holds | A panel under the stake with a live 1Click quote: "Pay … USDC from your wallet", for exactly the missing NEAR |
| 7 | Open [`/character`](https://deedlords-club.vercel.app/character) | The character that sits at every table. It and each piece it wears are NEP-171 tokens of `chibi.deedlords.near` |

Real transactions to open without playing:

| What | Transaction |
|---|---|
| A poker shuffle with its proof (22,555 bytes, 221 Tgas, 0.021 NEAR) | [`HucKM9wP…`](https://nearblocks.io/txns/HucKM9wPjKYhhSAtAec7rvDvnKRfnSjNT5CJ9ypHaRWG) |
| A guest's move relayed by the sponsor (4.3 Tgas, 0.0004 NEAR paid by the sponsor) | [`2jesymTA…`](https://nearblocks.io/txns/2jesymTABFtwPkeVX29Sc6DFhFvWQX9Rq2jyEAhTcLUx) |
| An AI move signed inside a TEE (3.9 Tgas, 0.0004 NEAR) | [`2af7dAbW…`](https://nearblocks.io/txns/2af7dAbW4rBsDSKKhXAdyTXB35FrxcoXttPiE2swuXEc) |
| The last move of a staked match: the contract pays both seats in the same transaction | [`Ci1p7yj2…`](https://nearblocks.io/txns/Ci1p7yj2tqF3LXhMNrEjAYQbyuk416u6zcNPVXi3TADJ) |

## Tracks

Each row quotes the track's brief. A "no" is said here first, because a reader finds it anyway.

### `games`: Games With Real Economies

| The brief says | Here | Check |
|---|---|---|
| "NPCs with wallets" | Every AI seat is a NEAR account that pays its own stake and wins or loses it like any player. At poker the house seats sit at 0.1 NEAR tables with their own NEAR | `pokerhouse.deedlords.near` and `pokerhouse2.deedlords.near` on the explorer |
| "player-owned markets" | Not built. Players own their character and its pieces (NEP-171) and stake their own seats; there is no market yet. Roadmap 4 and 5 | |
| "economies that evolve without a dev patch" | Inside a match, yes: who owns what, every rent, every mortgage and every bankruptcy is decided by the contract's rules and the players' moves, and a match keeps the fee and the rules it was opened with. Between matches nothing carries over yet | `get_match` on `game.deedlords.near` |
| "Judged on the game loop, not the token" | There is no token. Every few seconds: a bet, or a roll and a purchase. Every few minutes: a hand or a match is settled and paid by the contract. Every session: a character, an agent with instructions of your own, a stake | steps 1 to 5 above |
| "bonus if players never notice the chain" | A guest has no wallet, no seed phrase and no NEAR, and no pop-up opens for a move. About 2 s a move, measured on testnet | steps 1 to 3; the guest's relayed move in the table of transactions |
| Hints: agent NPCs, social login, NEAR Intents, NEP-245 | Agent NPCs: yes, on NEAR AI Cloud. Social login: Google through NEAR Auth is built and runs on localhost only; the public sites offer a guest account or one signature of an EVM wallet. NEAR Intents: a live 1Click quote for a missing stake (no real deposit completed yet). NEP-245: not used; the tokens are NEP-171 | "Known limits" |

### `privacy`: Privacy & Private AI

| The brief says | Here | Check |
|---|---|---|
| "confidential computation" | A deck of 52 cards stays hidden on a public chain with no trusted party: each seat re-encrypts and shuffles it under its own key and proves the shuffle in zero knowledge, and the contract is the verifier. A card opens only when every seat gives a proved share of the key | `contracts/poker/src/shuffle.rs`; the shuffle transaction above; `cargo test --manifest-path contracts/poker/Cargo.toml` |
| "AI that protects sensitive data" | With the owner's own NEAR AI key the browser asks the enclave directly: the owner's instructions and, at poker, the seat's two cards go there and nowhere else. On chain there is only the hash of the request | `lib/agentKey.ts`, `games/poker/table/useSeatAgent.ts` |
| A "Verified" panel that lists what was checked, with a fresh nonce | `/verify`: five checks computed in the browser from the transaction and NEAR AI's attestation report, asked for with a fresh random nonce | step 4 above; `lib/teeProof.ts`; `tests/tee-proof.test.ts` |
| "Keep nothing server-side" | The server keeps no game state and stores no request or answer. An agent on the server's own key does send its request through this site's server | "Fully on chain: what that means here" |
| Not done | The Intel and NVIDIA quote is not parsed here (the page links NEAR AI's Verification Center). The contract does not check the enclave's signature: the browser and `check:live` do. Poker bets by an agent carry no proof on chain yet | |

### `open`: Open Innovation

One game account from any wallet. One signature of an EVM wallet gives the same NEAR game account every time
(`lib/chain/evmKey.ts`); a guest's account is a key made in the browser; a sponsor pays the gas of free tables
(NEP-366); a stake the account cannot pay is quoted in USDC or ETH from Base, Arbitrum or Ethereum through NEAR
Intents (`lib/chain/oneclick.ts`). The player's own chain is where they start, not something they have to leave first.

## The games

| | Deedlords | Poker | Arena |
|---|---|---|---|
| What it is | An original property-trading board game. 40 squares of world cities ranked by real prime-property prices; buy, build, collect rent, go bankrupt. 2 to 4 seats. A match is short: five squares are dealt to each seat, a house can go up on any own city once a turn, and after 12 to 20 rounds (by seat count) the highest net worth wins. A match may also be opened with two more rules, when the contract lists them in `get_config` (`features`): four special tickets (Rent waiver, Pick your steps, Takeover, Festival; one dealt at the start, one more passing Departure, two in hand at most), and double rent for whoever leads on net worth ([`docs/ENGINE-RULES.md`](docs/ENGINE-RULES.md) §10). In 1,000 simulated two-seat matches the seat behind at half-time then wins 31% of the time instead of 23%. The testnet contract has both since 2026-11-14; the mainnet contract is the build from before them, so matches there play without. A free match of two seats against the AI took 10.5 minutes on testnet on 2026-11-14; `scripts/co-ty-phu-sim.ts` plays thousands of whole matches to measure length and how often the seat behind at half-time wins | Texas Hold'em for 2 to 9 seats with no dealer. Cash-game chips: 100 chips per stake, blinds 1 and 2 | An original auto-battler: a shared market, sealed first-price bids, a hex-grid fight with no randomness |
| Mainnet | `game.deedlords.near` | `poker.deedlords.near` | not deployed |
| Testnet | `game.deedlords.testnet` | `pokertable.deedlords.testnet` (`poker.deedlords.testnet` is the first, heads-up contract) | `arena.deedlords.testnet` |
| Web route | `/play` | `/poker/tables` | `/arena` (trailer) |
| Status | Playable end to end, free or staked | Playable end to end, free or staked. The proof code has had no outside review | On hold: contract, engines and screen are in the repository, the page shows the trailer |

No name, art or wording of Monopoly or of any existing game is used; see [PROVENANCE.md](PROVENANCE.md).

## Fully on chain: what that means here

| | On chain | Off chain |
|---|---|---|
| Rules of every game | Yes: `contracts/engine` + `contracts/deedlords`, `contracts/poker-table`, `contracts/arena` | |
| Dice, card draws, turn order | Yes: drawn by the contract in the transaction that needs them | |
| The deck of a poker hand | Yes: 52 ciphertexts in contract state; each seat's shuffle and every card turned are proved to the contract | Each seat's own card key stays in that seat's browser |
| Stakes, pot, payout, fee | Yes: held and paid by the contract. The move that ends a game pays it out | |
| Game state (board, cash, properties, chips, bets) | Yes: `get_match` on each contract returns all of it | |
| Turn clock | Yes: a deadline per step; after it anyone may call `timeout` | |
| Characters and items | Yes: NEP-171 tokens | |
| The page, the 3D scene, sound | | The web app. It reads the contract and sends transactions |
| An AI agent's reasoning | Its signed proof travels in the move's transaction | The model runs at NEAR AI Cloud or another provider |
| Paying a guest's gas | | A relayer (`/api/relay`). It cannot move a seat: it only forwards what the guest signed |

The web server keeps no game state. If it disappeared, every staked game could still be finished by calling the
contracts directly, and every finished one stays readable.

## What NEAR does here

### 1. Public by default, private where it matters

What is new here and what is not. Poker with no dealer is an old idea (Shamir, Rivest and Adleman, 1979), and shuffles
proved in zero knowledge have been verified by contracts on other chains before, with SNARK circuits (zkShuffle on
Ethereum, 2023, is the best known). What this repository adds: the verifier of a Terelius-Wikström shuffle written
directly on NEAR's `alt_bn128` host functions, with no circuit and no trusted setup, checked in one transaction of
221 Tgas; tables of two to nine seats with clocks, side pots and timeouts; live on mainnet; and free play for a guest
who holds nothing. We know of no other verifiable shuffle inside a NEAR contract.

- Cards are ElGamal ciphertexts over BN254 G1 under the sum of the keys of the seats in the hand. Each seat proves it
  knows its key when it sits down (Schnorr), so the table key belongs to nobody alone.
- Before a hand every seat shuffles and re-encrypts the deck in turn and proves that the result is the same 52 cards
  in another order. The proof is a Terelius-Wikström proof of a shuffle as the CHVote specification gives it, made
  non-interactive with SHA-256; the contract is its verifier (`contracts/poker/src/shuffle.rs`). One honest seat is
  enough for the order to be unknown to everyone.
- A card is turned by every seat giving its share of the decryption, each with a Chaum-Pedersen proof the contract
  checks. A hole card stays hidden as long as its owner has not given the last share.
- A seat that stops answering cannot freeze the pot: after the deadline anyone calls `timeout`; the late seat is folded,
  or the hand is cancelled and the late seat's chips are shared by the others (`contracts/poker-table/src/lib.rs`).
- The board game needs no secrets: its dice come from `env::random_seed` mixed with the match and the move, and a move
  that would let a player see a roll before committing to it is refused (`contracts/README.md`, "No re-rolls").

Measured on mainnet: a shuffle is one transaction of 22,555 bytes (6,656 of deck, 10,144 of proof, base64 and JSON
around them) that burns 221 to 223 Tgas, about 0.021 NEAR.

### 2. Fast and cheap enough to forget the chain

| | Measured | Where |
|---|---|---|
| An ordinary move (`play`, `turn`) | 3.0 to 3.9 Tgas, 0.0003 to 0.0004 NEAR | mainnet, transactions above |
| A move that settles a match and pays out | 38 Tgas, 0.0016 NEAR | mainnet |
| A guest's relayed move, paid by the sponsor | 4.1 to 4.3 Tgas, about 0.0004 NEAR | mainnet |
| Time from sending a move to its result | about 2 s (median 1.76 s for `play`, 2.06 s for `turn`); final after 3.5 to 4 s | testnet, 2026-11-10, through a free public RPC; block time 0.6 s. Not measured on mainnet |

- **No pop-up per move.** A session is a function-call access key for the game contract alone, made in the browser.
  A stake, which moves NEAR, still asks for one confirmation. See `contracts/README.md`, "Session keys".
- **No NEAR to start.** A guest's account is an implicit account: it exists as soon as its key does. At a free table
  each move is a delegate action signed by the guest; the sponsor wraps it in a transaction and pays
  (`app/api/relay/route.ts`). The contract still sees the guest as the caller, so the sponsor can never move a seat.
- **What the sponsor will pay for is narrow** (`games/co-ty-phu/chain/relayRules.ts`, `freeDesk.ts`): one call, to a
  game contract, to a method that moves a seat, with no deposit, signed by a game account's own key, for a table the
  sponsor itself opened, under rate limits per caller and overall.

### 3. An AI you can audit, a strategy nobody can read

A seat can be handed to an agent and taken back at any time. An agent is an account like any other: it calls `turn`
with a plan, the contract rolls and applies it, and a plan that breaks the rules only costs that seat its own game.

- **Verifiable moves.** When an agent's plan comes from a model that NEAR AI Cloud runs in a Trusted Execution
  Environment, the model's enclave signs `<model>:<sha256 of the request>:<sha256 of the response>` with a key that
  never leaves it. The agent puts the response, the signature and only the hash of the request into its `turn`
  transaction. `/verify` then checks, in the browser and from the chain alone: the response hashes to what was
  signed, the signature recovers the signer, the response names the model, the plan played is the plan answered, and
  NEAR AI's attestation report lists that signer for that model next to its Intel TDX and NVIDIA evidence
  (`lib/teeProof.ts`, `tests/tee-proof.test.ts`).
- **Private instructions.** The request holds the owner's own instructions for the agent. Only its hash goes on
  chain. With the owner's own NEAR AI key (`/agents`), the browser asks NEAR AI directly: the key, the instructions
  and, at poker, the seat's hole cards go to the enclave and nowhere else, not to this site's server
  (`lib/agentKey.ts`, `games/poker/table/useSeatAgent.ts`).
- **Limits, stated plainly.** The Intel and NVIDIA hardware quote itself is not parsed here: `/verify` links NEAR AI's
  Verification Center for it. Agents on the server's key send their request through this site's server. Poker bets
  made by an agent carry no proof on chain yet; board-game turns do.

Six TEE-signed turns by `Qwen/Qwen3.6-35B-A3B-FP8` are on mainnet as of 2026-11-13; one is checked by
`npm run check:live`.

### 4. Bring nothing

| Way in | What the player gets | Needs |
|---|---|---|
| **Play as a guest** | A NEAR implicit account, key kept in the browser. Free tables at both games | Nothing |
| **EVM wallet** (MetaMask, Rabby, Coinbase) | A NEAR game account derived from one signature of the wallet; the same account every time | The wallet |
| **NEAR wallet** (through NEAR Connect) | The player's own account; poker adds a game account funded in one approval | The wallet |
| **Short of NEAR for a stake** | A 1Click quote for exactly the missing amount, paid in USDC or ETH from the EVM wallet on Base, Arbitrum or Ethereum; NEAR arrives on the game account | Funds on that chain |

`lib/chain/oneclick.ts`, `lib/chain/evmPay.ts`, `games/co-ty-phu/components/TopUp.tsx`. The quote is live and the
wallet request is built and tested (`tests/evm-pay.test.ts`, `tests/oneclick.test.ts`); see "Known limits" for what
has not been exercised with real funds.

## Deployed contracts

Mainnet, owner `deedlords.near`, read on 2026-11-13:

| Account | What | Code hash |
|---|---|---|
| [`game.deedlords.near`](https://nearblocks.io/address/game.deedlords.near) | Deedlords: matches, stakes, dice, clocks, payouts, Deed NFTs. Fee 0, largest stake 1 NEAR | `Ha6nhaKnZ8p4SyGrvhgzniXNujjhbwfi3WKobcwMv5o6` |
| [`poker.deedlords.near`](https://nearblocks.io/address/poker.deedlords.near) | Poker tables of 2 to 9 seats, free tables included. Fee 0 | `7gBmMKnAkiroQJsMa1NnEoogPTotqsnEHiFzk6KRPb5Y` |
| [`chibi.deedlords.near`](https://nearblocks.io/address/chibi.deedlords.near) | Characters and items, NEP-171 | `BxzvTicT3UR8VcocQL7tDMW3D29jSTbfRGAWB6L7158C` |
| `free.deedlords.near` | The sponsor of free tables: opens them, relays guests' moves, plays the house seats | no contract |
| `house.deedlords.near` | The house seat of solo board-game matches | no contract |
| `pokerhouse.deedlords.near`, `pokerhouse2.deedlords.near` | AI seats at poker tables, each with its own account and its own NEAR: they sit at free tables and at tables with the 0.1 NEAR stake, and win or lose it like anybody | no contract |

Testnet, owner `deedlords.testnet`: `game.deedlords.testnet`, `pokertable.deedlords.testnet`, `poker.deedlords.testnet`,
`chibi.deedlords.testnet`, `arena.deedlords.testnet`, sponsor `free.deedlords.testnet`.

Fees: none for now. Each contract's owner may set one, at most 5% (`MAX_FEE_BPS`); a match or table keeps the fee in
force when it was opened, so a change never reaches money already staked.

## Run it yourself

Needs Node 22.6 or newer (tested on 22.12). Rust is needed only to rebuild or test the contracts.

```bash
npm ci
npm test              # 298 tests, about 10 s, no network
npm run typecheck
npm run check:live    # reads mainnet, sends nothing
npm run build         # the production build of the web app
```

The web app against a live network (it only reads and relays; without a sponsor key of your own, free tables are
off and wallets or a funded guest account still play):

```bash
npm run dev:web                                    # testnet, http://localhost:3000
NEXT_PUBLIC_NEAR_NETWORK=mainnet npm run dev:web   # mainnet
```

The contracts (see [`contracts/README.md`](contracts/README.md) for the build flags and the measurements):

```bash
cd contracts
cargo test --workspace                                        # Deedlords, its engine, Arena, the characters
cargo test --manifest-path poker/Cargo.toml                   # the shuffle proof and heads-up poker
cargo test --manifest-path poker-table/Cargo.toml             # tables of 2 to 9 seats (about 8 minutes: real proofs)
cd sandbox && npm install && npm test                         # the board game on a local near-sandbox
```

A whole local playground, chain included (`npm run dev:chain`), needs the contracts built to wasm first; the build
command is in `contracts/README.md`. `.env.example` lists every setting; none is needed for the commands above.

## How the pieces work

### Free play

- **The sponsor opens the table** (`POST /api/free`): a match with stake 0, the visitor's seat and one to three house
  agents, each on the model the visitor picked. It pays the storage deposit and gets it back at settlement.
- **The guest's moves are meta-transactions** (NEP-366). The browser signs a delegate action with the guest's own key;
  the sponsor sends it (`POST /api/relay`).
- **The house agents play when somebody has the table open** (`POST /api/free/move`): nothing runs between requests,
  so a table costs nothing while nobody is at it. Tables people left are closed by the sponsor before it opens
  another (`tidyFreeTables` in `freeDesk.ts`).
- **Poker has free tables too.** The poker contract takes a stake of nothing from its owner's own accounts only. The
  sponsor opens the table with a 0.25 NEAR deposit that comes back when it closes, holds a seat and plays it
  (`games/poker/table/house.ts`). A guest's shuffle, proof included, is relayed like any other move. Chips at a free
  table are only chips. A free table is played for ten hands.

### Signing in with Google

`/play` can offer "Google" through [NEAR Auth](https://docs.auth.near.org): the person gets a NEAR account whose key
NEAR's MPC network derives from their sign-in, and the game asks it for one thing, a function-call key for the game
contract (`games/co-ty-phu/chain/googleSession.ts`, `app/api/relay/session/route.ts`). This works with NEAR Auth's
shared testnet client, which accepts pages at `http://localhost:3000` only. It is switched off on both public sites
until the project has a client of its own.

### AI agents

Each account keeps its own agents in its browser (`/agents`): a name, a model, and instructions in plain words. For
the board game an agent can also work from a **playbook**: six numeric rules (cash kept in reserve, how much of the
worst rent ahead to cover, where houses go, and so on) that turn into a plan by arithmetic alone. That is the
fallback whenever a model is slow or unreachable, so a seat never stalls on a model.

A free table can seat one to three house agents, each on its own model; the table names each seat by its model and
shows the sentence it gave for its turn. Model calls are paid by whoever runs the server, so they are rate-limited;
past the limit a turn falls back to the playbook. See `games/co-ty-phu/agent/`, `games/poker/table/decide.ts`,
`app/api/agent/`, `app/api/poker/table/agent/`.

### Other chains

`/account` has "Other chains": bring NEAR in from USDC, USDT, ETH, SOL or BTC on their own chains through 1Click, or
send NEAR out to an address on one of them. The pot itself stays plain NEAR; 1Click sits only at the edges. 1Click has
no testnet, so on the testnet site the same form shows a real price and nothing to send.

## Known limits

- **No outside review.** The shuffle verifier, the poker contract and the board-game contract were written and tested
  during the hackathon and have not been audited. The largest stake the board game takes is capped at 1 NEAR.
- **Collusion at a poker table** (two seats sharing their cards off chain) is outside what any contract can see.
- **1Click with real funds:** quotes are live and the payment request was tested against a simulated wallet. As of
  2026-11-13 the team has not completed a real cross-chain deposit through it.
- **Google sign-in** runs on localhost only, as said above.
- **The sponsor's balance is finite.** A free poker hand for two seats costs it about 0.07 NEAR, nearly all for
  checking shuffles; when it runs low the page says so and staked tables keep working.
- **A TEE proof is confirmed against NEAR AI's report of the day.** When NEAR AI restarts a model's enclave its key
  changes, and a move made before the restart can no longer be confirmed: `/verify` and `npm run check:live` then mark
  that one check `!` (not confirmed today) and the other four still hold.
- **Arena** is not playable on the site.
- **Latency on mainnet** was not measured separately; the figures above are from testnet.
- **The contracts can still be upgraded** by `deedlords.near` (a full-access key exists). An upgrade keeps state:
  `contracts/sandbox/mainnet.js`.

## What predates the hackathon, libraries, AI assistance

- **Baseline.** The board game's rules, its 3D scene and the chibi characters were written by the same author for an
  earlier party-game platform and copied into this repository's first commit (`6d3275f`, 2026-11-10) together with
  the first changes made for the hackathon. [PROVENANCE.md](PROVENANCE.md) lists every copied file, with hashes and
  dates. That earlier game had a server as its referee and no chain. Its room server is still in the repository
  (`server/`, `worker/`, `wrangler.jsonc`, the route `app/co-ty-phu/`); nothing on chain uses it.
- **Written during the hackathon** (2026-11-10 to 2026-11-14, everything after that commit:
  `git log pre-hackathon..hackathon-submission`; the tag `pre-hackathon` is that commit): the Rust port of the rules, all NEAR contracts, the poker cryptography
  in Rust and TypeScript, the chain client, session keys, the relayer and free play, the agents and their TEE proofs,
  1Click, the characters as NFTs, Arena, and every page except the board's own screen.
- **Libraries.** Web: Next.js 16, React 19, three.js, `@noble/curves` and `@noble/hashes` (BN254, secp256k1, SHA-2,
  Keccak), `@hot-labs/near-connect` (NEAR wallets), `@auth0/auth0-spa-js` (NEAR Auth), `qrcode.react`. Contracts:
  `near-sdk` 5, `near-contract-standards`, `serde`, `borsh`. Tests on a local chain: `near-sandbox`, `near-api-js`.
  NEAR transactions, keys and delegate actions are encoded by this repository's own code (`lib/chain/`), not an SDK.
- **AI assistance.** The code was written with an AI coding assistant (Claude Code) at the author's direction. The
  posters, unit portraits and 3D models were made with generative tools; PROVENANCE.md names the tool and the prompt
  source for each.

## Roadmap

1. **Review:** an outside audit of the shuffle verifier and the poker contract, then a bug bounty, before the stake
   cap is raised.
2. **Cash out anywhere:** winnings sent to another chain through NEAR Intents from the table, not only from `/account`.
3. **Sign-in:** NEAR Auth (Google) on the public domain, and passkeys.
4. **Player-owned tables:** whoever opens a table sets its fee and is paid it by the contract.
5. **An agent market:** publish an agent, let others back its seat, split what it wins on chain. The board-game
   contract already separates a seat's backer (who stakes and is paid) from its driver (the account that plays it).
6. **Private AI further:** the agent's own key inside the enclave; proofs for poker bets; the hardware quote checked
   in the browser.
7. **The deck as a library:** the dealerless deck (keys, shuffle proof, shares) packaged for any card game on NEAR.
8. **Arena** opened, tournaments, a phone build.

## Repository layout

```
app/                    Next.js routes: / /play /poker /arena /verify /agents /account /character /shop /bag, and /api
components/hall/        The shared sign-in and top bar
games/co-ty-phu/        Deedlords: rules, board, 3D scene, chain room, agents, free play
games/poker/            Poker: card cryptography, shuffle proof, table logic, agents, house
games/arena/            Arena: rules, scene, agent
lib/chain/              NEAR client: RPC, keys, transactions, delegate actions, 1Click, EVM payment
lib/teeProof.ts         TEE proofs of AI moves
contracts/engine/       Deedlords rules in Rust (same outputs as the TypeScript engine, checked by replay)
contracts/deedlords/    The Deedlords contract
contracts/poker/        BN254 arithmetic, the shuffle verifier, heads-up poker
contracts/poker-table/  Poker for 2 to 9 seats
contracts/chibi/        Characters and items (NEP-171)
contracts/arena*/       Arena rules and contract
contracts/sandbox/      Local chain tests, deploy scripts for testnet and mainnet
server/ worker/         The board game as it was before the hackathon, refereed by a room server (with wrangler.jsonc
                        and the route app/co-ty-phu/). Kept as the baseline. Nothing under /play, /poker or the
                        contracts uses it
scripts/check-live.ts   npm run check:live
scripts/co-ty-phu-sim.ts  Whole Deedlords matches simulated: how long, how open, under which rules
tests/                  298 unit tests
docs/ENGINE-RULES.md    The exact contract between the TypeScript and Rust rules engines
PROVENANCE.md           What predates the hackathon, what was written during it, how art was generated
PRODUCT.md DESIGN.md    Design briefs as they were written during the week (also .impeccable/, docs/design/). Where
                        they differ from this README, for instance "testnet only", the README is current
```

## License

MIT, see [LICENSE](LICENSE).
