# Deedlords

A property-trading board game whose rules, dice and stakes live entirely in a **NEAR smart contract**. There is no
game server: every roll, every rent, every payout is a transaction anyone can open in an explorer. Built for **NEAR
HACKATHON** (November 2026), `games` track.

Humans and AI agents sit at the same table through the same contract calls. A seat can be handed to an agent and
taken back mid-game; the agent plays by a **playbook** its owner writes and adjusts, or by one it asks a language
model to write from a wish in plain words.

This repo ships **two** games built the same way (contract is the referee, a human or an agent can hold any seat):

| | Deedlords | Deedlords Arena |
|---|---|---|
| What it is | An original property-trading game. 40 squares of world cities (ranked by real prime-property prices, cheapest first), buy, build, collect rent. | An original auto-battler. A shared market, sealed first-price bids, a hex-grid fight with no randomness. |
| Contract (testnet) | `game.deedlords.testnet` | `arena.deedlords.testnet` |
| Web route | `/play` | `/arena` |
| Status | Playable end to end on testnet | Playable end to end on testnet |

No Monopoly (or any existing game's) name, art, or wording is used anywhere; see [PROVENANCE.md](PROVENANCE.md) for
exactly what in this repo predates the hackathon, what was written during it, and how the generated art was made.

## Why a contract is the referee

- **Dice and cards are drawn on chain.** A match's randomness comes from the chain's own RNG, not a server the player
  has to trust.
- **A move is a transaction.** `turn(id, seat, plan)` rolls, applies the plan, and ends the turn in one call — anyone
  can open that transaction in [NearBlocks](https://testnet.nearblocks.io) and read exactly what happened.
- **The contract pays out.** When a match ends, the same call that reports the end also settles the pot. Nothing is
  claimed by a server afterwards.
- **No signing prompt per move.** A player signs in once (a guest key kept in the browser, a key derived from an EVM
  wallet signature, or a connected NEAR wallet) and that session key signs every move for that match. A stake still
  asks for one confirmation.
- **A human and an agent are the same kind of player.** An agent is just another account calling `turn`; a seat's
  backer can name a driver and take the seat back at any time.

## Try it (testnet)

The web app talks to NEAR **testnet**; every stake below is test NEAR, worth nothing. An AI agent needs a model
service configured (`cp .env.example .env.local` and fill one in) — without one, agents still play, just by their
playbook's arithmetic alone.

```bash
npm install
npm run build:chibi
npm run dev:chain      # NEXT_PUBLIC_NEAR_NETWORK=sandbox, for a local playground instead of testnet
# or, against testnet directly:
npm run dev:web
```

Then open `http://localhost:3000`:

- **`/play`** — sign in as a guest (or with an EVM/NEAR wallet), open or join a duel, watch the board play out in 3D.
- **`/arena`** — the auto-battler, same sign-in.

A guest account needs about **0.23 NEAR** to open the smallest Deedlords match (the stake, a refundable storage
deposit, and gas the network holds while you play); the page tells you the exact figure and the address to send to.

## What's on chain, what isn't

| | On chain | Off chain |
|---|---|---|
| Rules, dice, cards | ✅ contract (`contracts/deedlords`, `contracts/arena`) | |
| Stakes and payout | ✅ contract | |
| Match state (board, cash, props) | ✅ contract (`get_match`) | |
| The board page you see, the 3D scene, sounds | | ✅ this web app, reads the contract |
| An AI agent's plan for one turn | | ✅ a language model or a playbook's arithmetic, in the player's own browser tab; the plan is only binding once signed and sent as a transaction |
| Generated art (buildings, unit portraits/models) | | ✅ produced before the hackathon window closed, shipped as static files |

An agent never signs anything the contract doesn't also check: `turn`/`play_turn` re-derives the outcome from the
engine, so a bad or malicious plan can only cost that seat's own game, never bypass the rules.

## Fees

The contract keeps a fixed **2.5%** of each pot (set once at deploy, capped at 5%, no setter). Of the rest, a duel's
winner takes 70%, second place 30%.

## Repository layout

```
app/                   Next.js routes: / (landing), /play, /play/[id], /arena, /api/agent, /api/moves
games/co-ty-phu/       Deedlords: rules engine, board data, 3D scene, agent (playbook + LLM)
games/arena/           Deedlords Arena: rules engine, 3D scene, agent
contracts/engine/      Deedlords rules ported to Rust (same outputs as games/co-ty-phu, checked by replay)
contracts/deedlords/   The Deedlords NEAR contract
contracts/arena-engine/ Arena rules ported to Rust
contracts/arena/       The Arena NEAR contract
contracts/sandbox/     Local near-sandbox test, testnet deploy script, local play helpers
shared/board.json      Deedlords board data, shared by the TS engine, the Rust engine and the contract build
shared/arena.json      Arena data (units, guilds), shared the same way
docs/ENGINE-RULES.md   The exact contract between the TS and Rust rules engines
PROVENANCE.md          What predates the hackathon, what was written during it, how art was generated
```

## Running the contracts yourself

See [`contracts/README.md`](contracts/README.md) for the Rust build, the unit tests, the local `near-sandbox`
integration test, and the testnet deploy script (`contracts/sandbox/testnet.js`, which refuses to touch mainnet).

```bash
cd contracts && cargo test --workspace
cd sandbox && npm install && npm test   # local near-sandbox, nothing leaves this machine
```

## AI agents

Each account can carry its own agent (kept in that browser, never on chain):

- **A playbook**: six numeric/choice rules (cash kept in reserve, how much of the worst rent ahead to cover, where
  houses go, bail-out policy, what to sell first in debt) that are turned into a turn's plan by arithmetic alone.
  This is also the fallback whenever a language model is slow, refused, or unreachable.
- **A model**, picked from whatever the server is configured to offer (`DEEDLORDS_LLM_MODELS`); it can write a
  playbook from a one-line wish, and is asked for each live turn with the playbook as its standing instructions.

Every model call is paid for by whoever deploys the server, so both endpoints are rate-limited (per caller and
across everyone, both configurable, see `.env.example`); past the limit a turn quietly falls back to the playbook
instead of being refused, and writing a new playbook answers with a plain "try again in a few minutes" instead.

See `games/co-ty-phu/agent/` (`playbook.ts`, `llm.ts`, `advise.ts`, `rateLimit.ts`) and `app/api/agent/`.

## Tests

```bash
npm test          # TypeScript rules engines + agent + chain adapters (node --test)
npm run typecheck
cd contracts && cargo test --workspace
```

## License

[MIT](LICENSE) for the code written during the hackathon window. See [PROVENANCE.md](PROVENANCE.md) for the Deedlords
game code that predates it, written by the same author.
