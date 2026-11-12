# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Confirmed with the owner on 2026-11-11.

- **Primary: crypto players.** They have a wallet (EVM or NEAR) or are willing to play as a guest, and want a short staked match of a property board game against a friend or an AI, on a phone or a laptop.
- **Secondary: people who build AI agents.** They want their agent to take a seat and play; an agent is a NEAR account that calls the contract.

## Product Purpose

Deedlords is a property-trading board game whose rules, dice and stakes live in a NEAR smart contract. Players stake into a pot, play a fixed number of rounds, and the contract ranks them by net worth and pays out in the transaction that ends the match. Success: a match is played from the first roll to the payout with no game server deciding anything, and a player never signs a prompt per move.

Built for NEAR HACKATHON (November 2026), `games` track.

## Positioning

There is no game server: the contract is the referee. Every move is a transaction anyone can open in an explorer, the dice are drawn by the contract, and the payout is made by the contract. Humans and AI agents sit at the same table through the same contract calls, and a seat can be handed to an agent and taken back mid-game.

## Operating Context

- A player signs in once (guest key in the browser, a game account derived from an EVM wallet signature, or a NEAR wallet), stakes once, then plays without wallet prompts.
- A match: 2 seats today in the web UI, a stake per seat in NEAR, 3, 6 or 12 rounds, 60 seconds a turn; a late player is moved by the contract.
- An AI agent plays a whole turn in one transaction by handing the contract a plan; it shows the sentence it gave for the plan.
- Vocabulary on the table is travel: the board is 40 squares of world cities (ranked by real prime property prices, cheapest first), canals and airports; corners are Departure, Customs, Transit Lounge, Visa Denied; card decks are Travel Alert and Souvenir.

## Capabilities and Constraints

- Live on NEAR **testnet** at `game.deedlords.testnet`; stakes there are test NEAR. Mainnet and staking from other chains through NEAR Intents are being built: the owner allows saying "coming", never that they exist (confirmed 2026-11-11).
- No fee for now (owner's choice, 2026-11-12): the contract's owner may set one later with `set_fee`, at most 5%, and a match keeps the fee it was opened with. The winner of a duel takes 70% of the pot, second place 30%.
- A move takes about 2 to 3 seconds from click to result on testnet.
- The game is an original property game. No Monopoly names, art, or wording, anywhere.
- All product text is in English.
- Undecided: whether the web UI opens tables of more than two seats before the deadline; which model provider the public demo uses.

## Brand Commitments

- Name: **Deedlords Club** for the whole product (the owner's choice, 2026-11-12): one account and one character across its games. Its games keep their names: Deedlords (the board game), Poker, Arena.
- An existing visual world in code (the lobby at `/play` and the table): deep red ground, cream paper, gold; a slab display face with a geometric sans; boarding-pass and departures-board forms; a 3D board of a small city; chibi characters for seats.

## Evidence on Hand

- The running game at `/play` and `/play/<id>` (lobby, 3D table, transactions list).
- Settled matches on testnet with their transactions, e.g. `m-mwb586zg-xrxn` and `m-mwb5gfo9-rxff` (AI against AI), `m-mwb4hy8x-xpzm` (two players); every transaction opens on testnet.nearblocks.io.
- The board data (`shared/board.json`), the seat portraits and the board art drawn from that data (`games/co-ty-phu/components/LobbyArt.tsx`).
- Sentences an AI agent gave for its plans during those matches (helper log; not stored anywhere public).
- None of: testimonials, user counts, press, prizes, audits. Do not invent them.

## Product Principles

1. Show the chain, do not claim it: a link to the transaction beats a sentence about trust.
2. One confirmation for a stake, none for a move.
3. A human and an agent are the same kind of player.
4. Say only what is true today; what is coming is labelled as coming.
