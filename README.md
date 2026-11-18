# Deedlords Club

Poker with no dealer and a property board game with no game server, **fully on chain**, for real stakes on **NEAR
mainnet**. NEAR contracts are the dealer, the dice, the referee and the bank: the rules, the deck, the pot and the
whole state of every game live in them, and every move is a transaction. At the poker table every seat shuffles the
deck under its own key and proves the shuffle to the contract in zero knowledge, so nobody ever holds the deck: not a
server, not an enclave, not us. A guest plays in about ten seconds with no wallet and no NEAR. An auto-battler is in
the repository and shown as a trailer.

| | |
|---|---|
| Play on mainnet | https://www.deedlords.xyz (also https://deedlords-club.vercel.app) |
| The same app on testnet, where everything is free | https://testnet.deedlords.xyz (also https://deedlords-club-testnet.vercel.app) |
| Demo video, three minutes | https://x.com/hoangalt/status/2121687720829587954 |
| Check it against mainnet, with no key | `npm ci && npm run check:live` |
| For judges and AI screeners | [JUDGES.md](JUDGES.md): three minutes in the browser, three commands in a terminal, and what each shows |
| Tracks | `games`, `privacy`, `open`: [how each brief is answered](#tracks) |
| Built | for NEAR HACKATHON, November 2026. What predates it: [PROVENANCE.md](PROVENANCE.md). Everything written during the hackathon: [`pre-hackathon...hackathon-submission`](https://github.com/joyboyz2025/deedlords-club/compare/pre-hackathon...hackathon-submission) |

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
| The player's money is on another chain | A stake that the account cannot pay is quoted in USDC or ETH on Base, Arbitrum or Ethereum and paid from the player's own wallet; NEAR arrives on the game account. NEAR can leave to another chain the same way | NEAR Intents, the 1Click Swap API: [how it is used](#5-money-from-any-chain-near-intents-1click) |
| An AI opponent is a black box | An agent's move carries a signature from the hardware enclave its model ran in. Anyone can check which model made the move; nobody can read the owner's instructions | NEAR AI Cloud (TEE inference and attestation) |

## Check it in one command

Nothing to configure, no key, nothing is sent. This reads NEAR mainnet from public nodes and checks five things said
above against real transactions:

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

`npm test` runs the 317 unit tests of the rules engines, the chain adapters, the relayer's rules and the proofs (about
ten seconds, no network).

## Try it in the browser: do X, see Y

Use either site: https://www.deedlords.xyz (mainnet; the links below open it) or https://testnet.deedlords.xyz. On
mainnet a free table costs you nothing (a sponsor pays the gas); a staked table uses real NEAR.

| # | Do | See |
|---|---|---|
| 1 | Open [`/play`](https://www.deedlords.xyz/play), press **Play as a guest** | Your account at the top right, shortened like `4b57da…105f` (hover it for all 64 characters): a NEAR implicit account whose key was just made in this browser. No wallet, no seed phrase, no NEAR. At a table the other players see a short handle worked out from the account, like `Otter27` (`lib/seatName.ts`) |
| 2 | Keep the **vs AI** tile and press **Play vs AI**. Unless you choose another under **Table options**, the AI seat plays by a model NEAR AI runs in a TEE (its name starts with `near:`), so its moves can be verified | A board of 40 world cities opens in about ten seconds: the sponsor first opens the table and seats its AI on chain. The dice roll by themselves after five seconds; the AI seat answers on its turns |
| 3 | Press the chain-link button at the left of the board (**Transactions**) | One row per move, each a link to the explorer. There your moves are calls of `play` on `game.deedlords.near` by your account, inside transactions signed and paid by `free.deedlords.near`. A row with a **TEE-signed** tag is an AI move that carries a proof |
| 4 | Click a **TEE-signed** tag, or open [this real one](https://www.deedlords.xyz/verify?tx=2af7dAbW4rBsDSKKhXAdyTXB35FrxcoXttPiE2swuXEc&from=free.deedlords.near) | "Signed in a TEE, and it holds." with five ticks, computed in your browser from the transaction and NEAR AI's public attestation report |
| 5 | Open [`/poker/tables`](https://www.deedlords.xyz/poker/tables), keep **vs House**, press **Play vs the House** | A table opens and a hand is dealt: both seats shuffle, then your two cards are face up for you only. Every step is a call on [`poker.deedlords.near`](https://nearblocks.io/address/poker.deedlords.near): `shuffle`, `deal`, `act`, `open`, `show`. **Table details** under the table lists the hand's transactions |
| 6 | On the mainnet site's `/play` sign in with an **EVM wallet** instead and choose **Stake**. A new game account holds no NEAR, so it cannot pay any stake | A panel under the stake, "Add … NEAR to play this stake", with a live quote from NEAR Intents' 1Click and one button: "Pay … USDC from your wallet". Nothing is sent unless you approve the transfer in the wallet. 1Click has no testnet: there the price is shown on `/account` under **Other chains**, with nothing to send ([section 5](#5-money-from-any-chain-near-intents-1click)) |
| 7 | Open [`/character`](https://www.deedlords.xyz/character) | The character that sits at every table. It and each piece it wears are NEP-171 tokens of `chibi.deedlords.near` |

## Every feature, with a real transaction

Each row is a transaction on NEAR mainnet (or Arbitrum, for the other side of a swap) that shows the feature doing
what it says. Open any of them without playing. The first four are also read and checked by `npm run check:live`.

| Feature | What the transaction shows | Transaction |
|---|---|---|
| **Poker: a shuffle proved in zero knowledge** | 22,555 bytes of re-encrypted deck and proof in one call, accepted by the contract (221 Tgas, 0.021 NEAR) | [`HucKM9wP…`](https://nearblocks.io/txns/HucKM9wPjKYhhSAtAec7rvDvnKRfnSjNT5CJ9ypHaRWG) |
| **Free play: a guest moves holding no NEAR** | A `play` the guest signed as a delegate action (NEP-366), sent and paid by `free.deedlords.near` (4.3 Tgas, 0.0004 NEAR) | [`2jesymTA…`](https://nearblocks.io/txns/2jesymTABFtwPkeVX29Sc6DFhFvWQX9Rq2jyEAhTcLUx) |
| **AI agent: a move signed in a TEE** | A whole `turn` planned by `Qwen/Qwen3.6-35B-A3B-FP8` on NEAR AI Cloud, with the enclave's signature in the arguments | [`2af7dAbW…`](https://nearblocks.io/txns/2af7dAbW4rBsDSKKhXAdyTXB35FrxcoXttPiE2swuXEc) |
| **Staked match: the contract pays the winners** | The last `play` of a 2-seat staked match: `settle`, 0.0756 and 0.0700 NEAR sent to the two backers, and a Deed NFT minted, all in the same transaction | [`Ci1p7yj2…`](https://nearblocks.io/txns/Ci1p7yj2tqF3LXhMNrEjAYQbyuk416u6zcNPVXi3TADJ) |
| **Poker: dealing** | `deal`: one seat's decryption shares for the other seats' hole cards (11.3 Tgas) | [`u8qsqkEh…`](https://nearblocks.io/txns/u8qsqkEhcLH48ZCDy4UzZeeumtHagrrNAoYtZno1b9f) |
| **Poker: betting** | `act`: a bet, which the contract checks against the table's rules before taking it (2.5 Tgas) | [`7kKCsk3D…`](https://nearblocks.io/txns/7kKCsk3DvHYSWVHCBUu856DK3QgzUqKaMnXhrfFyo8eK) |
| **Poker: a card turned face up** | `open`: one seat's shares for a street's board cards, each with the proof the contract checks (15.7 Tgas) | [`GybkF3CT…`](https://nearblocks.io/txns/GybkF3CTMckGPKeHpGEfCS5PUTBqsRYTt2T1Ba35RuCD) |
| **Poker: showdown and payout** | `show` at a staked table: the last hole cards are opened, the contract ranks the hands and pays 0.2 NEAR out in the same transaction | [`4ZETZvTJ…`](https://nearblocks.io/txns/4ZETZvTJjx5cPC5qMKp7KUHaF9TyyF3mSGtgY6Rpqr57) |
| **Poker: a seat that stops answering** | `timeout`, which anyone may send once a seat's deadline has passed; here 0.246 NEAR went back to the sponsor in the same transaction | [`AnNomF9V…`](https://nearblocks.io/txns/AnNomF9ViTnkMhJQhA851cFDm65huifVpvPHa5xZXTFU) |
| **Board game: an AI seat plays a whole turn in one transaction** | The house agent's `turn` that ends a free match: `settle` and a Deed NFT minted | [`C29pnjL6…`](https://nearblocks.io/txns/C29pnjL6PmPcqmu4VoNNXSSZEHxU1hazM4VP2ZNYa4dR) |
| **Board game: a table everyone left is closed** | `close`, called 15 minutes after the last move: ranked by net worth, settled, Deed minted, the storage deposit refunded | [`5mjyeJYq…`](https://nearblocks.io/txns/5mjyeJYqZzCUJQpuZpz7ypDRkukumL9dim7TTqGs3pmp) |
| **Board game: the sponsor opens a free table** | `create_match` and `join` in one transaction, paid by `free.deedlords.near` | [`3V7W51C6…`](https://nearblocks.io/txns/3V7W51C6M6emfk4edvY1nJaJVgVCEqRYCxxCr75TfRNf) |
| **Characters: made free, as NEP-171 tokens** | `create_character`, paid by the sponsor: `character_created` and `nft_mint` | [`5uuxPUk2…`](https://nearblocks.io/txns/5uuxPUk2XTJducc98i71mR2aAoUFTRJQ5vB3X4KvGJpi) |
| **Characters: a box bought with NEAR** | `buy_box` with 0.1 NEAR attached: `box_opened` and the item minted | [`EWv7u3ym…`](https://nearblocks.io/txns/EWv7u3ym7c9Zz4tHzo53EHaoG18feSr6UJk9BwmhGoN5) |
| **Characters: an item worn** | `equip` | [`65PRLe16…`](https://nearblocks.io/txns/65PRLe16mkDqzKtuvjk5xC2suGDXTBPZGjMdwhxgLK4w) |
| **NEAR Intents (1Click): money from another chain** | 0.000546 ETH sent from an Arbitrum wallet to a 1Click deposit address; 0.29 NEAR delivered to the game account | [`0x089a902b…`](https://arbiscan.io/tx/0x089a902bce51fb3caf24376080a74c94556b1c5d02cb222fd6def95f9c58e774) then [`98PnDJ3r…`](https://nearblocks.io/txns/98PnDJ3rS5w1BmD583VMXzPsSxb29SgwVkd3PYdMFDb7) |
| **…and the NEAR staked at once** | Nine seconds after that NEAR arrived, the same account opened a staked poker table with 0.102 NEAR attached | [`3RP7EHTQ…`](https://nearblocks.io/txns/3RP7EHTQhxtN4WnKAXYmYVEWTc9YvxtXSFny1oQcTyM3) |
| **Upgrade that keeps every match** | The board-game contract replaced in place on mainnet (590,426 bytes), no `migrate`, state kept | [`4DGjbAEo…`](https://nearblocks.io/txns/4DGjbAEo2cLY5Mz7ALJ3A8Pd8wvT6oN3rBLrmKCk16X2) |

The explorer answers a script with HTTP 403. In a terminal, `npm run check:live` reads the first four from public RPC
nodes, and section 5 has a `curl` that asks 1Click itself about the swaps.


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
| Hints: agent NPCs, social login, NEAR Intents, NEP-245 | Agent NPCs: yes, on NEAR AI Cloud. Social login: Google through NEAR Auth is built and runs on localhost only; the public sites offer a guest account or one signature of an EVM wallet. NEAR Intents: 1Click quotes and the wallet payment for a missing stake, and NEAR in or out of a game account from `/account`. Three real top-ups, ETH on Arbitrum to NEAR, are in [section 5](#5-money-from-any-chain-near-intents-1click). NEP-245: not used; the tokens are NEP-171 | "Known limits" |

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
| What it is | An original property-trading board game. 40 squares of world cities ranked by real prime-property prices; buy, build, collect rent, go bankrupt. 2 to 4 seats. A match is short: after 12 to 20 rounds (by seat count) the highest net worth wins. No property is dealt: the board is bought by landing on it, a city takes its first house in the stop it is bought in, and one more each time its owner stops there again. The page opens every match with two more rules: four special tickets (Rent waiver, Pick your steps, Takeover, Festival; one dealt at the start, one more passing Departure, two in hand at most), and double rent for whoever leads on net worth ([`docs/ENGINE-RULES.md`](docs/ENGINE-RULES.md) §10). Each rule is asked for only from a contract that lists it in `get_config` (`features`). Both networks' contracts list all of them since 2026-11-14, when mainnet was upgraded in place to the build testnet runs (transaction `4DGjbAEo2cLY5Mz7ALJ3A8Pd8wvT6oN3rBLrmKCk16X2`). `scripts/co-ty-phu-sim.ts` plays whole matches under these rules with seeded dice: over 400 two-seat matches a match is 20 rounds and about 12 houses, an estimated 7 minutes against agents and 10 between two people, and the seat behind at half-time still wins 29% of the time | Texas Hold'em for 2 to 9 seats with no dealer. Cash-game chips: 100 chips per stake, blinds 1 and 2 | An original auto-battler: a shared market, sealed first-price bids, a hex-grid fight with no randomness |
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
| **Short of NEAR for a stake** | A 1Click quote for the missing NEAR, paid in USDC or ETH from the EVM wallet on Base, Arbitrum or Ethereum; NEAR arrives on the game account | Funds on that chain |

The last row is NEAR Intents' 1Click. The next section says how it is used and what has not been done with it.

### 5. Money from any chain: NEAR Intents (1Click)

The pot of every game is plain NEAR, held by the contract. What a player holds may be USDC on Base or ETH on Arbitrum.
The way from one to the other is NEAR Intents' [1Click Swap API](https://docs.near-intents.org): the app asks for a
quote, 1Click answers with a deposit address on the token's own chain, the player sends the token there from their own
wallet, and NEAR Intents delivers NEAR to the game account. This project has no bridge contract and no wrapped token
in a pot, and it never holds the player's token or signs for them.

It sits at the edges of the games, in three places:

| Where | What happens | Code |
|---|---|---|
| A stake the account cannot pay (`/play`, `/poker/tables`), signed in with an EVM wallet on mainnet | The page asks what the missing NEAR costs in a token of that wallet and shows one button, "Pay … USDC from your wallet". The wallet is switched to the token's chain and shown one ordinary transfer to 1Click's deposit address, which its owner approves there. The page follows the swap, and the stake opens when the NEAR has arrived | `games/co-ty-phu/components/TopUp.tsx`, `lib/chain/evmPay.ts` |
| `/account`, **Other chains**, **Bring NEAR in** | For any game account, a guest's included: pick a token (USDC on Base, Arbitrum, Ethereum or Solana; USDT on Ethereum; ETH on Base or Arbitrum; SOL; BTC) and how much NEAR is wanted, and get the address and the exact amount to send, as text and as a QR code | `games/co-ty-phu/components/CrossChain.tsx` |
| `/account`, **Other chains**, **Take NEAR out** | The other way: the game account sends NEAR to the address 1Click names, and the token arrives at the address the player typed on the other chain | the same file |

A top-up, step by step:

1. The browser posts `{ kind: "in", asset, near, recipient, refundTo }` to this site's own `/api/oneclick`
   (`app/api/oneclick/route.ts`). The server checks the request before 1Click hears of it: a token from the short list
   in `lib/chain/oneclick.ts`, 0.1 to 100 NEAR, a NEAR account as the recipient, an address of the token's own chain
   for refunds, and at most 30 quotes from one IP address in ten minutes.
2. The server asks `POST https://1click.chaindefuser.com/v0/quote` with `swapType: "EXACT_OUTPUT"` (the player gets
   exactly the NEAR asked for, and the token amount follows), `originAsset` the token, `destinationAsset`
   `nep141:wrap.near`, `depositType` and `refundType` `"ORIGIN_CHAIN"`, `recipientType: "DESTINATION_CHAIN"`,
   `slippageTolerance: 100` (1%), a deadline one hour ahead and `referral: "deedlords-club"`.
3. The answer carries the deposit address, the amount to send, its value in dollars and the time 1Click expects. The
   NEAR asked for is what the account is short of plus a twentieth (gas prices move), rounded up to a hundredth, and
   never under the smallest swap taken here, 0.1 NEAR (`topUpAmount` in the same `TopUp.tsx`).
4. The page builds the wallet's request itself (`paymentRequest` in `lib/chain/evmPay.ts`: an ERC-20 `transfer`, or a
   plain transfer for ETH) and sends it with `eth_sendTransaction`. A wallet account other than the one the game
   account was made from is refused, so that a refund goes back where the quote said.
5. The transaction's hash goes to `POST /v0/deposit/submit` so that 1Click looks for it sooner, and the page reads
   `GET /v0/status` every four seconds: `PENDING_DEPOSIT`, `KNOWN_DEPOSIT_TX`, `PROCESSING`, then `SUCCESS`,
   `REFUNDED` or `FAILED`, each said to the player in a sentence (`statusLine`). The payment is kept in the browser's
   storage, so a reload goes on following it. A swap that cannot go through is refunded by 1Click on the token's chain.

Do this, see that. 1Click has no testnet, so off mainnet every quote is asked with `dry: true`: a real price, no
deposit address. The testnet site answers with no key (the refund address below is Hardhat's well-known test account):

```bash
curl -s https://testnet.deedlords.xyz/api/oneclick -H 'content-type: application/json' -d '{"kind":"in","asset":"nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near","near":"1000000000000000000000000","recipient":"deedlords.near","refundTo":"0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"}'
```

On 2026-11-14 it answered `"amountInFormatted":"3.123294"` (USDC on Base) for `"amountOutFormatted":"1.0"` (NEAR), with
`"timeEstimate":37` (seconds), `"live":false` and `"depositAddress":null`. In the browser the same price is on the
testnet site's `/account` under **Other chains**, with the line "A price only: on testnet there is nothing to send."

With real funds. Three top-ups have gone through the mainnet site: ETH on Arbitrum became NEAR on one game account
(`16c3b293…79b9`), each with `swapType: "EXACT_OUTPUT"`, the referral `deedlords-club` and a refund address on
Arbitrum, and 1Click reports `SUCCESS` for all three. Each deposit carried a little more ETH than the swap used (the
quote leaves room for 1% of slippage), and 1Click sent that back:

| When (UTC) | Sent on Arbitrum | Delivered on NEAR | Deposit | Delivery | Change returned |
|---|---|---|---|---|---|
| 2026-11-13 09:17 | 0.000461 ETH | 0.25 NEAR | [`0x360faf4a…`](https://arbiscan.io/tx/0x360faf4ad02bcaed634364960a3b1250473136fe624f048639e63acf894d503b) | [`5gYybKCG…`](https://nearblocks.io/txns/5gYybKCGNV7uhk3yjZitxFv4RMLPosUXhWyrj5QUxHQg) | [`0xa493641d…`](https://arbiscan.io/tx/0xa493641d2170f37234b3f2dc12740396166b5830ac039016f324f1eb94d658a1) |
| 2026-11-13 10:37 | 0.000561 ETH | 0.31 NEAR | [`0xa8b55f8c…`](https://arbiscan.io/tx/0xa8b55f8cdfba26f84681dab5aab7e97824b3fbb95b02dc376aeefb4fcc6be591) | [`9evCJN6M…`](https://nearblocks.io/txns/9evCJN6MkHTN1HnSh1tmcn3zVAA1Be3W8QCc3VZ2J2Ew) | [`0xc5661669…`](https://arbiscan.io/tx/0xc5661669474d4dc02f4ed0a6b7e4365bd38464156db7c472ca023008191e3783) |
| 2026-11-18 09:32 | 0.000546 ETH | 0.29 NEAR | [`0x089a902b…`](https://arbiscan.io/tx/0x089a902bce51fb3caf24376080a74c94556b1c5d02cb222fd6def95f9c58e774) | [`98PnDJ3r…`](https://nearblocks.io/txns/98PnDJ3rS5w1BmD583VMXzPsSxb29SgwVkd3PYdMFDb7) | [`0x7c229897…`](https://arbiscan.io/tx/0x7c2298971c28175ae1a642c4b2fb0eb70ac1b15a2933500f7da2327ff8423048) |

Nine seconds after the last delivery, the same account opened a staked poker table with that NEAR
([`3RP7EHTQ…`](https://nearblocks.io/txns/3RP7EHTQhxtN4WnKAXYmYVEWTc9YvxtXSFny1oQcTyM3), 0.102 NEAR attached). 1Click answers about any of them with no key:

```bash
curl -s "https://1click.chaindefuser.com/v0/status?depositAddress=0xecD94ff44eca5732417477b836E6cD32aA374b58"
```

It returns `"status":"SUCCESS"`, the quote request as this site sent it, and the transaction hashes above. These
lines were added on 2026-11-18, after the submission deadline, and the code is the one submitted. The README of the
submission said no real swap had been made; the first two above already had.

What is not done. Nothing has gone the other way (NEAR out to another chain) with real funds, and the three swaps
above are all ETH on Arbitrum. The wallet request is also tested against a simulated wallet (`tests/evm-pay.test.ts`
and `tests/oneclick.test.ts`, nine tests). No partner key is set on the public sites, so 1Click charges what it charges a request without
one (0.25% on top of the protocol's 0.0001%, by its [fee page](https://docs.near-intents.org/resources/fees));
`ONECLICK_JWT` on the server would switch to the partner rate. NEAR Intents is not used inside a game: pots and
payouts are NEAR, and a winner who wants another chain goes through `/account` after the payout (Roadmap 2).

## Deployed contracts

Mainnet, owner `deedlords.near`, read on 2026-11-14:

| Account | What | Code hash |
|---|---|---|
| [`game.deedlords.near`](https://nearblocks.io/address/game.deedlords.near) | Deedlords: matches, stakes, dice, clocks, payouts, Deed NFTs. Fee 0, largest stake 1 NEAR | `HB5ibsB7g2iR5ht2kWjKMDjpMfhwVd1tJgQn5WzHNY5T` |
| [`poker.deedlords.near`](https://nearblocks.io/address/poker.deedlords.near) | Poker tables of 2 to 9 seats, free tables included. Fee 0 | `7gBmMKnAkiroQJsMa1NnEoogPTotqsnEHiFzk6KRPb5Y` |
| [`chibi.deedlords.near`](https://nearblocks.io/address/chibi.deedlords.near) | Characters and items, NEP-171 | `BxzvTicT3UR8VcocQL7tDMW3D29jSTbfRGAWB6L7158C` |
| `free.deedlords.near` | The sponsor of free tables: opens them, relays guests' moves, plays the house seats | no contract |
| `house.deedlords.near` | The house seat of solo board-game matches | no contract |
| `pokerhouse.deedlords.near`, `pokerhouse2.deedlords.near` | AI seats at poker tables, each with its own account and its own NEAR: they sit at free tables and at tables with the 0.1 NEAR stake, and win or lose it like anybody | no contract |

Testnet, owner `deedlords.testnet`: `game.deedlords.testnet`, `pokertable.deedlords.testnet`, `poker.deedlords.testnet`,
`chibi.deedlords.testnet`, `arena.deedlords.testnet`, sponsor `free.deedlords.testnet`. The board game and the poker
tables run the same code there as on mainnet (the same two hashes).

The three mainnet contracts are builds of this repository; the command is in
[`contracts/README.md`](contracts/README.md), "Build". On the author's machine a fresh clone of the submitted commit
builds to files with exactly the three hashes above (checked on 2026-11-14 with rustc 1.99.1). This is not a
reproducible build in the strict sense: the compiler writes the absolute path of the local cargo registry into panic
messages, so a build under another home directory has other bytes and another hash.

Fees: none for now. Each contract's owner may set one, at most 5% (`MAX_FEE_BPS`); a match or table keeps the fee in
force when it was opened, so a change never reaches money already staked.

## Run it yourself

Needs Node 22.6 or newer (tested on 22.12). Rust is needed only to rebuild or test the contracts (tested with rustc
1.99.1 and its `wasm32-unknown-unknown` target).

```bash
npm ci
npm test              # 317 tests, about 10 s, no network
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
cargo test --workspace                                        # Deedlords, its engine, Arena, the characters: 136 tests
cargo test --manifest-path poker/Cargo.toml                   # the shuffle proof and heads-up poker: 19 tests
cargo test --manifest-path poker-table/Cargo.toml             # tables of 2 to 9 seats: 24 tests, about 8 minutes (real proofs)

# The board game on a local near-sandbox: build the contract first, then eight scenarios (about 4 minutes)
RUSTFLAGS="-C target-cpu=mvp -C target-feature=+sign-ext --cfg near" \
  cargo build -p deedlords --target wasm32-unknown-unknown --release
cd sandbox && npm install && npm test
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

See [Money from any chain: NEAR Intents (1Click)](#5-money-from-any-chain-near-intents-1click) above: the quote, the
payment from the player's wallet, and NEAR in or out of a game account from `/account`.

## Known limits

- **No outside review.** The shuffle verifier, the poker contract and the board-game contract were written and tested
  during the hackathon and have not been audited. The largest stake the board game takes is capped at 1 NEAR.
- **Collusion at a poker table** (two seats sharing their cards off chain) is outside what any contract can see.
- **1Click with real funds:** three real top-ups, all ETH on Arbitrum into NEAR (section 5). Nothing has been sent out
  to another chain with real funds yet.
- **Google sign-in** runs on localhost only, as said above.
- **The sponsor's balance is finite.** A free poker hand for two seats costs it about 0.07 NEAR, nearly all for
  checking shuffles, and the cost grows with the table: at nine seats the nine shuffles alone are about 0.19 NEAR a
  hand. When the sponsor runs low the page says so and staked tables keep working.
- **A TEE proof is confirmed against NEAR AI's report of the day.** When NEAR AI restarts a model's enclave its key
  changes, and a move made before the restart can no longer be confirmed: `/verify` and `npm run check:live` then mark
  that one check `!` (not confirmed today) and the other four still hold.
- **Arena** is not playable on the site.
- **Latency on mainnet** was not measured separately; the figures above are from testnet.
- **The contracts can still be upgraded** by `deedlords.near` (a full-access key exists). An upgrade keeps state:
  `contracts/sandbox/mainnet.js`.
- **No bit-for-bit rebuild on another machine.** The deployed code is a build of this repository made on the author's
  machine ("Deployed contracts"); there is no Docker build that anyone can repeat to the same hash.

## What predates the hackathon, libraries, AI assistance

- **Baseline.** The board game's rules, its 3D scene and the chibi characters were written by the same author for an
  earlier party-game platform and copied into this repository's first commit (`6d3275f`, 2026-11-10) together with
  the first changes made for the hackathon. [PROVENANCE.md](PROVENANCE.md) lists every copied file, with hashes and
  dates. That earlier game had a server as its referee and no chain. Its room server is still in the repository
  (`server/`, `worker/`, `wrangler.jsonc`, the route `app/co-ty-phu/`); nothing on chain uses it.
- **Written during the hackathon** (2026-11-10 to 2026-11-14, everything after that commit:
  `git log pre-hackathon..hackathon-submission`, or on GitHub
  [pre-hackathon...hackathon-submission](https://github.com/joyboyz2025/deedlords-club/compare/pre-hackathon...hackathon-submission);
  the tag `pre-hackathon` is that commit): the Rust port of the rules, all NEAR contracts, the poker cryptography
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
5. **An agent market:** a public record per agent (matches, win rate, return on what was staked), then publishing an
   agent so that others rent it or back its seat, with what it wins split on chain. Two pieces exist: the board-game
   contract separates a seat's backer (who stakes and is paid) from its driver (the account that plays it), and it
   counts `played`, `wins` and `earned` per account (`get_stats`). A record that self-played matches cannot inflate is
   the missing part.
6. **Private AI further:** the agent's own key inside the enclave; proofs for poker bets; the hardware quote checked
   in the browser.
7. **The deck as a library:** the dealerless deck (keys, shuffle proof, shares) packaged for any card game on NEAR.
8. **More games on the same rails:** Arena opened, tournaments, a phone build; then the shared pieces (session keys,
   the sponsor, the dealerless deck, agents with TEE proofs) offered to other builders' games.
9. **Games as a test bed for AI agents:** one seat played by different models and different instructions, compared on
   results the contract recorded. Today a free table already seats up to three house agents, each on its own model.

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
tools/demo/             How the demo film was recorded and cut: a headless Chrome, captions, narration
tools/diff/             Differential tests: games recorded on the TypeScript engines, replayed through the Rust ones
tools/arena/            Arena's art tools and its trailer
tests/                  317 unit tests
docs/ENGINE-RULES.md    The exact contract between the TypeScript and Rust rules engines
PROVENANCE.md           What predates the hackathon, what was written during it, how art was generated
PRODUCT.md DESIGN.md    Design briefs as they were written during the week (also .impeccable/, docs/design/). Where
                        they differ from this README, for instance "testnet only", the README is current
```

## License

MIT, see [LICENSE](LICENSE).
