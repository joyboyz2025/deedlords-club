---
version: 1
slug: "app-play-page-tsx"
primary_target: "app/play/page.tsx"
related_targets: ["games/co-ty-phu/components/ChainHome.tsx","games/co-ty-phu/components/Passport.tsx","games/co-ty-phu/components/ChainScreen.tsx","app/play/play.css"]
---

# Surface: the front desk at /play, and the gate of one match

Scope: `/play` (sign in, your AI agent, open a match, the matches the contract holds) and the waiting state of `/play/<id>` before the first roll (take a seat, invite, seat an agent). Mode: Operate.

Audience and job: a crypto player who wants to be in a match within a minute, and an agent builder who wants an agent to fly a seat. Confirmed with the owner on 2026-11-11: the page joins the landing's world; what was wrong with the old page is that it looked cheap, the sign-in was confusing, and matches showed too little; the owner also wants an agent attached to the account: pick a model, generate a basic playbook, adjust it.

Constraints: English text; testnet only, mainnet is "coming"; sign-in ways are guest, EVM wallet, NEAR wallet (as built); an agent plays from the player's own tab and signs with the player's own key; a model is offered only when the server is configured with one.

## Direction contract

THESIS: The front desk of a departures hall. What the chain holds hangs on the wall as one board; what is yours lies on the desk as one ticket of three stubs. It refuses the centred column of stacked login cards.

OWN-WORLD: Hall Red ground lit from the top; one Night board with a gold hairline, slab heading and tabular rows; Ticket Paper cut by dashed perforations with bitten corners; one gold pill per stub; ink segmented pills; green Boarding chips; Alfa Slab One for names and amounts, Be Vietnam Pro for the rest.

STORY: The visitor sees live matches at once, learns one click makes them a guest player, sees that an agent can fly their seat with a playbook they can edit, then opens or joins a flight.

FIRST VIEWPORT: Top row: wordmark, How it works, network chip. Left, about three fifths: slab line "Pick a flight, or open one." over the Departures board (Match, Seats, Stake, Rounds, Status). Right, two fifths: one ticket, three stubs down: Passenger (gold "Play now as guest", EVM and NEAR as outline pills), Co-pilot (model, style, rule chips, Generate and Adjust), Flight (stake, rounds, gold "Open for ..."). Signature interaction: status cells on the board are split-flap characters that flip in place when a match changes round or fills a seat. Motion: stubs deal in once; flaps flip with a short stagger; nothing moves under reduced motion.

FORM: two-pane hall, fourth of seven on the ordered list; seed:4f494a9691fe1f38.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Unresolved

- Which model provider the public demo pays for; the model list is whatever the server's environment allows.
- A hosted runner for an agent with its own account (today the agent runs in the player's tab).
