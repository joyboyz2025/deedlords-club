---
version: 1
slug: "app-poker-page-tsx"
primary_target: "app/poker/page.tsx"
related_targets: ["games/poker/components/PokerScreen.tsx","app/poker/poker.css"]
---

# Surface: Deedlords Poker at /poker (lobby, one table, the settled table)

Scope: `/poker` (make a game account, open a table), `/poker?m=<id>` (one heads-up table from the open seat to the payout) and the summary of a settled table. Mode: Operate. Built unattended from the brief of the poker session on 2026-11-12 ("decide yourself"); no decision round was put to the owner.

Audience and job: a crypto player, or a hackathon judge alone at one browser, who wants to see a hand of Hold'em dealt with no dealer and to bet in it. The page plays the seat's cryptography by itself; the player only bets.

Constraints: English text; testnet; the protocol files (`games/poker/{crypto,shuffle,seat,chain}.ts`) are fixed; nothing is instant (a shuffle 4 to 6 s a seat, the deal 3 s a seat, a street 9 s, a bet 2 s), so every wait has to read as a step of the game with a named seat.

## Direction contract

THESIS: The table hangs in the departures hall as one board that runs a hand like a flight: a route of stops across its top, the stop under way spelled in split-flap cells, and the cards as loose paper on a lit red baize. It refuses the green-felt casino skin and the bare spinner between steps.

OWN-WORLD: Hall Red ground; one Night board with a gold hairline holding a Lantern Red baize with a dark rail; playing cards cut from Field Cream stock with red-ink and ink pips and slab court letters, backs in red with a gold lattice; chips in gold, cream, red and ink; the player's action on a Ticket Paper stub with one gold pill; a second Night board as the ledger of transactions.

STORY: The visitor sees the deck being shuffled by each seat and the proof accepted, sees cards travel and turn only when both seats' shares are in, bets from a paper stub, and can open every step as a transaction.

FIRST VIEWPORT: Top row: wordmark, links to the other two games, network chip with the poker contract. Left, about two thirds: the table board. Its head carries the table code, the hand number, the flap word of the step and the clock; under it the route (Shuffle, Shuffle, Deal, Pre-flop, Flop, Turn, River, Showdown) with the current stop lit; then the baize: opponent seat above, deck, five board places and the pot across the middle, the player's seat and larger cards below; one sentence under the baize says who the table waits for. Under the board the action stub: Fold, gold Check or Call, the raise field with its ink Raise, All in. Right, one third: the last hand as a stub, then the Transactions board. Signature move: every wait is a visible step of the protocol (the deck riffles while a seat proves its shuffle, a board card lies face down under two key marks and turns when both are lit). Raise from the boarding-pass-and-gate-board challenger: a change holds its light until the next one (the seat that just acted, the card that just turned).

FORM: the table as a departures board, fourth of seven on the ordered list (dealt 4, 6, 2; from 6 the build takes the action stub pinned to the bottom of a phone screen); seed:abbf03a40b2d4d9c. Build path: code-led, as every Operate surface is whatever `.impeccable/config.json` records; no comp round and no owner pick took place.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Unresolved

- DESIGN.md is not updated by this build: the poker session's brief limits edits to `games/poker/components/`, `app/poker/` and `public/poker/`. The poker table's forms (baize, cards, chips, route) are recorded only here until the owner asks for the document pass.
- Seat portraits: seats are drawn as numbered discs; the other games use chibi portraits.
- Seat colours are teal `#3cc4ae` and orange `#f39a4a`, this surface's own: the gate at /play takes its first two seats from the board's token colours (red, blue), and a red ring is lost on the red baize. They are near the Arena's two sides (teal, coral). The lit seat is the one the table waits for (gold ring); the seat that moved last carries its move as a word in its own colour until the next change.
