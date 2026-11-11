---
name: Deedlords
description: A property board game refereed by a NEAR contract, drawn as an air-travel world of red ground, cream ticket paper, gold slab lettering and dark departures boards.
colors:
  ground: "#5d100a"
  ground-low: "#3f0806"
  red: "#7a1712"
  red-deep: "#4a0c09"
  red-lit: "#a4241b"
  gold: "#f8c93f"
  gold-pale: "#fbe29a"
  gold-button-top: "#fbd155"
  gold-button-low: "#f3b93a"
  gold-flat: "#f2c14e"
  cream: "#fff7e6"
  paper: "#f8f0d4"
  field: "#fffaf0"
  ink: "#2a1208"
  ink-soft: "#5a3524"
  soft: "#f0d9c4"
  soft-warm: "#f3d9b1"
  night: "#201009"
  night-top: "#2a120a"
  chip-well: "rgb(52 10 8 / 78%)"
  boarding-green: "#4fae6c"
  boarding-green-text: "#bfeccb"
  boarding-green-tint: "rgb(47 154 92 / 22%)"
  gain: "#1f6a34"
  loss: "#a02a1a"
  alert-ink: "#8a2114"
typography:
  display:
    fontFamily: "Alfa Slab One, serif"
    fontSize: "clamp(40px, 12.4vw, 96px)"
    fontWeight: 400
    lineHeight: 0.9
    letterSpacing: "normal"
  headline:
    fontFamily: "Alfa Slab One, serif"
    fontSize: "clamp(30px, 4vw, 52px)"
    fontWeight: 400
    lineHeight: 1.08
  headline-desk:
    fontFamily: "Alfa Slab One, serif"
    fontSize: "clamp(32px, 3.6vw, 52px)"
    fontWeight: 400
    lineHeight: 1.05
  title:
    fontFamily: "Alfa Slab One, serif"
    fontSize: "26px"
    fontWeight: 400
    lineHeight: 1.1
  title-stub:
    fontFamily: "Alfa Slab One, serif"
    fontSize: "23px"
    fontWeight: 400
    lineHeight: 1.1
  amount:
    fontFamily: "Alfa Slab One, serif"
    fontSize: "24px"
    fontWeight: 400
    lineHeight: 1.15
  title-sans:
    fontFamily: "Be Vietnam Pro, system-ui, sans-serif"
    fontSize: "clamp(21px, 2.1vw, 26px)"
    fontWeight: 700
    lineHeight: 1.25
  lede:
    fontFamily: "Be Vietnam Pro, system-ui, sans-serif"
    fontSize: "clamp(17px, 1.5vw, 20px)"
    fontWeight: 400
    lineHeight: 1.5
  body:
    fontFamily: "Be Vietnam Pro, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.5
  body-desk:
    fontFamily: "Be Vietnam Pro, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.45
  body-app:
    fontFamily: "Be Vietnam Pro, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.4
  small-paper:
    fontFamily: "Be Vietnam Pro, system-ui, sans-serif"
    fontSize: "14.5px"
    fontWeight: 400
    lineHeight: 1.45
  fine:
    fontFamily: "Be Vietnam Pro, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: "Be Vietnam Pro, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 700
    letterSpacing: "0.06em"
  label-desk:
    fontFamily: "Be Vietnam Pro, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 700
    letterSpacing: "0.06em"
  label-board:
    fontFamily: "Be Vietnam Pro, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    letterSpacing: "0.1em"
  data:
    fontFamily: "ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "14px"
    fontWeight: 400
  flap:
    fontFamily: "ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 700
    lineHeight: 1
rounded:
  pill: "999px"
  board: "22px"
  inner: "16px"
  row: "10px"
  flap: "3px"
spacing:
  tight: "8px"
  stack: "12px"
  gutter: "20px"
  stub-inline: "24px"
  ticket: "26px"
  hall-gap: "clamp(24px, 2.6vw, 40px)"
  section: "clamp(72px, 9vw, 132px)"
components:
  button-go:
    backgroundColor: "{colors.gold-button-top}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    height: "56px"
    padding: "0 8px"
  button-go-desk:
    backgroundColor: "{colors.gold-button-top}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    height: "52px"
    width: "100%"
    padding: "0 20px"
  button-go-desk-disabled:
    backgroundColor: "rgb(42 18 8 / 10%)"
    textColor: "{colors.ink-soft}"
  pill-outline:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    height: "40px"
    padding: "0 14px"
  pill-ink:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.cream}"
    rounded: "{rounded.pill}"
    height: "40px"
    padding: "0 14px"
  pill-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.pill}"
    height: "40px"
    padding: "0 14px"
  way-button:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.inner}"
    height: "50px"
    padding: "6px 14px"
  button-main:
    backgroundColor: "{colors.gold-flat}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    height: "42px"
    padding: "0 16px"
  button-outline:
    backgroundColor: "rgb(255 255 255 / 8%)"
    textColor: "{colors.cream}"
    rounded: "{rounded.pill}"
    height: "42px"
    padding: "0 16px"
  ticket-stub:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    padding: "26px 24px 30px"
  ticket-stub-desk:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    padding: "16px 24px 18px"
  departures-board:
    backgroundColor: "{colors.night}"
    textColor: "{colors.cream}"
    rounded: "{rounded.board}"
    padding: "18px 18px 20px"
  departures-board-desk:
    backgroundColor: "{colors.night}"
    textColor: "{colors.cream}"
    rounded: "{rounded.board}"
    padding: "20px 22px 14px"
  flap-cell:
    backgroundColor: "#1a0b06"
    textColor: "{colors.gold-pale}"
    typography: "{typography.flap}"
    rounded: "{rounded.flap}"
    width: "15px"
    height: "22px"
  status-chip:
    backgroundColor: "{colors.boarding-green-tint}"
    textColor: "{colors.boarding-green-text}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "4px 14px"
  status-chip-desk:
    backgroundColor: "{colors.boarding-green-tint}"
    textColor: "{colors.boarding-green-text}"
    typography: "{typography.label-desk}"
    rounded: "{rounded.pill}"
    padding: "4px 12px"
  status-chip-live:
    backgroundColor: "rgb(248 201 63 / 14%)"
    textColor: "{colors.gold-pale}"
    rounded: "{rounded.pill}"
  status-chip-soon:
    backgroundColor: "transparent"
    textColor: "{colors.soft}"
    rounded: "{rounded.pill}"
  network-chip:
    backgroundColor: "{colors.chip-well}"
    textColor: "{colors.cream}"
    rounded: "{rounded.pill}"
    padding: "7px 14px"
  rule-chip:
    backgroundColor: "rgb(42 18 8 / 8%)"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "4px 10px"
  segment:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    height: "40px"
    padding: "0 12px"
  segment-pressed:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.cream}"
  field:
    backgroundColor: "{colors.field}"
    textColor: "{colors.ink}"
    rounded: "{rounded.row}"
    height: "40px"
    padding: "0 12px"
  problem-note:
    backgroundColor: "rgb(160 42 26 / 12%)"
    textColor: "{colors.alert-ink}"
    rounded: "{rounded.row}"
    padding: "8px 12px"
  account-stamp:
    backgroundColor: "transparent"
    textColor: "{colors.red}"
    rounded: "50%"
    size: "52px"
  agent-note:
    backgroundColor: "{colors.cream}"
    textColor: "#3a1508"
    padding: "14px 18px"
  agent-note-paper:
    backgroundColor: "{colors.field}"
    textColor: "{colors.ink}"
    padding: "10px 14px"
---

# Design System: Deedlords

Recorded on 2026-11-11 from the shipped code, in three passes: the landing page at `/` (`app/landing.css`), then the front desk at `/play` and the gate of one match (`app/play/desk.css`), rebuilt to join the landing's world by the owner's choice of the same day, and the game table (`app/co-ty-phu/co-ty-phu.css`, with the transactions ledger and agent note in `app/play/play.css`) as the incumbent that was not rebuilt. The three stylesheets each declare their own custom properties on their own root class (`.lp`, `.fd`, `.tp`); there is no shared token file. Where they disagree, both values are listed and the disagreement is stated, not resolved.

## Overview

**Creative North Star: "The Departures Hall"**

Deedlords is drawn as an airport for a board game. A match is a flight: it is listed on a departures board, boarded with a ticket, and paid out at landing. Three materials do all the work. A deep red ground, lit from the top centre, holds the prose. Cream ticket paper, cut by perforations and notched at its corners, holds a match's facts and the action that starts one. Near-black boards with a gold hairline hold what is read from the chain: open matches, the seats of one match, transaction ledgers. Gold slab lettering names things; a geometric sans says everything else.

The system is warm and physical, never glassy or technical. The chain is shown as printed matter: a transaction is a stub you can pick up, a ledger is a board you can read down, a status that changes is a row of split-flap cells that turn. Small isometric vignettes of the board's own squares stand in for illustration on the landing. Density is high on paper and boards (tabular figures, short lines) and generous on the ground (one headline, one lede, wide vertical gaps).

The world is built on three surfaces and they are not identical. The landing and the front desk share the same materials: the same ground gradient, Foil Gold, Ticket Paper with its grain plate, the same board. The front desk is the working form of it: the board hangs on the left as a wall, one ticket of stacked stubs lies on the right as a desk, and the paper carries form controls the landing does not have. The game table was not rebuilt: it keeps a lighter, redder ground and a flat gold of its own. The name "The Departures Hall" was chosen by the documenting pass from the built forms and has not been confirmed by the owner.

**Key Characteristics:**
- Three materials: red ground, cream ticket paper, near-black board. Each has one job.
- Tickets are divided by dashed perforations and bitten corners, not by gaps or borders.
- Gold is lettering and the one primary action of a stub; green is "boarding"; nothing else is an accent.
- Alfa Slab One for names, headlines and amounts; Be Vietnam Pro for everything else.
- Only paper casts a shadow. Boards and prose sit level and flat.
- A status that changes on a board is set in split-flap cells; a board is never short, its empty lines stand blank.
- Every figure is set in tabular numerals.

## Colors

A red-and-gold palette with warm neutrals only: no grey, no blue, no white. The one pure black in the landing and the front desk is the hinge line across a flap cell.

### Primary
- **Foil Gold** (`gold`, #f8c93f): the gold of the landing and the front desk. Slab lettering on the ground and on boards (under the gold-foil plate), link underlines, the hairline around boards (at 55% alpha), the border of the network chip, the row arrow, focus rings on the ground, the text selection.
- **Pale Gold** (`gold-pale`, #fbe29a): gold that is read as data on a board: match codes in mono, flap letters, the text of a Live chip.
- **Button Gold** (`gold-button-top` falling to `gold-button-low`): the top-to-bottom gradient of the one gold pill on a ticket, on the landing and the front desk alike.
- **Flat Gold** (`gold-flat`, #f2c14e): the incumbent gold of the game table only. Logo, main button, balances. It is a different value from Foil Gold and both are live.

### Secondary
- **Boarding Green** (`boarding-green`, #4fae6c, with `boarding-green-tint` as fill and `boarding-green-text` as text): the "Boarding" and "Open" status chips on boards and on the ground, and the front desk's narrow-screen link that jumps to the board. It means a seat can be taken now.
- **Gain Green** (`gain`, #1f6a34) and **Loss Red** (`loss`, #a02a1a): signed returns on paper in the landing's fare table. On the front desk Loss Red is the balance of an account that holds too little to play.
- **Alert Ink** (`alert-ink`, #8a2114): the text of an error note on paper, over a 12% wash of Loss Red.

### Neutral
- **Hall Red** (`ground`, #5d100a, falling to `ground-low`): the page ground of the landing and the front desk. A vertical gradient from #67120b through `ground` and #480b08 to `ground-low`, under a soft radial glow of rgb(190 60 38 / 55%) at the top centre. On the landing the stop lengths scale with the first screen's unit; on the front desk they are fixed (400px, 760px, 1040px).
- **Lantern Red** (`red`, #7a1712, with `red-lit` above and `red-deep` below): the incumbent ground of the game table, a radial gradient lit from the top centre. On the landing and the front desk the same value is red ink on paper: stub titles, amounts, the account stamp, icons on paper, the caret, and the accent of range and checkbox controls.
- **Ticket Paper** (`paper`, #f8f0d4): the ticket stock of the landing and the front desk, under a tiled paper-grain plate.
- **Field Cream** (`field`, #fffaf0): the fill of a select or text input on paper and of the agent's quote on a stub; the table also uses it for its own light surfaces.
- **Cream** (`cream`, #fff7e6): primary text on ground and boards; text on solid ink; the agent's speech notes on the landing and the table.
- **Ink** (`ink`, #2a1208, with `ink-soft` for secondary lines, labels and fine print): all text on paper and on gold. Borders on paper are ink at 30%; washes are ink at 6 to 10%.
- **Soft** (`soft`, #f0d9c4 on the landing and the front desk; `soft-warm`, #f3d9b1 on the table): secondary text on ground and boards.
- **Night** (`night`, #201009, under `night-top`): departures boards, ledgers and the code block. A flap cell is darker still (#1a0b06 over #120805).
- **Chip Well** (`chip-well`): the dark red fill of the network chip in the top row.

### Named Rules
**The Three Materials Rule.** On the landing and the front desk every surface is ground, paper or board. Ground carries prose, paper carries a match and its action and whatever belongs to the visitor, boards carry what is read from the chain. The game table was not rebuilt and keeps its own incumbent surfaces.

**The Two Golds Rule.** Foil Gold belongs to the landing and the front desk, Flat Gold to the game table. This is recorded as a difference in the build, not as a design decision; do not introduce a third.

## Typography

**Display Font:** Alfa Slab One (with serif)
**Body Font:** Be Vietnam Pro (with system-ui, sans-serif)
**Label/Mono Font:** ui-monospace, SF Mono, Menlo, Consolas (system stack: chain identifiers and flap cells only)

**Character:** A heavy poster slab against a plain geometric sans: the slab is the sign over the gate, the sans is the small print on the ticket. Both are loaded in `lib/fonts.ts`; Be Vietnam Pro is loaded at 400, 600 and 700 only.

### Hierarchy
- **Display** (400, clamp(40px, 12.4vw, 96px), line-height 0.9, uppercase): the product name on the landing's first screen below 1100px. From 1100px up the first screen scales with the window and the name is 102 comp units (about 6.6vw, capped near 117px) at line-height 0.82. The table's logo is the same face at clamp(42px, 13vw, 64px). The wordmark in the front desk's top row is clamp(24px, 2.4vw, 32px).
- **Headline** (400, clamp(30px, 4vw, 52px), line-height 1.08, balanced): one per landing section. The front desk's single line is clamp(32px, 3.6vw, 52px) at line-height 1.05, held to 16ch.
- **Title** (400, 26px, line-height 1.1): slab headings on paper and on boards. Pass legs at 26px and the ledger heading at clamp(20px, 2.2vw, 28px) on the landing; on the front desk a board title is clamp(21px, 2vw, 26px) and a stub title is 23px.
- **Amount** (400, 24px, line-height 1.15, tabular): a pot, a stake or a prize on a stub, in red ink, with its unit beside it in the sans at 13px, 700. An account's balance is 26px.
- **Title, sans** (700, clamp(21px, 2.1vw, 26px), line-height 1.25): a sub-heading on the ground that should not compete with the section headline.
- **Lede** (400, clamp(17px, 1.5vw, 20px), line-height 1.5, max 62ch): the sentence under a headline. On the front desk it is clamp(15px, 1.2vw, 17px).
- **Body** (400, 17px, line-height 1.5, max 60 to 62ch): prose on the landing; 16px on paper. The front desk runs at 15px with line-height 1.45, the table at 15px with 1.4.
- **Small on paper** (400, 14.5px; 600 for a field's label): explanations, fields and pickers on a stub, held to 46ch. Fine print under an action is 13px at line-height 1.4.
- **Label** (700, 13px, letter-spacing 0.06em, uppercase): status chips and the agent's name tag on the landing. On the front desk the chip is 12px.
- **Board label** (600, 12px, letter-spacing 0.1em, uppercase): column heads on a board, and the small line over a seat's name or a term at the gate.
- **Data** (400, 14px, system mono): transaction hashes and match ids on boards.
- **Flap** (700, 12px, line-height 1, system mono, capitals and figures): one character to a cell.

### Named Rules
**The Slab Says Little Rule.** Alfa Slab One sets names, headlines and amounts (the pot, the fare result, a balance, the two initials in the account stamp), and nothing smaller than 19px on the landing or the front desk. It never sets a sentence of body text.

**The Tabular Figures Rule.** Times, stakes, seat counts, returns and hashes are set with `font-variant-numeric: tabular-nums`, so a board's columns hold still as its numbers change.

## Layout

Below the landing's first screen the page is a single centred column, min(1120px, 100% - 40px), with sections separated by clamp(72px, 9vw, 132px) of ground. Inside a section the order is fixed: slab headline, lede, then one paper or board object. Two-column arrangements (plan and code, copy and fare table) are near-even grids with a 40 to 48px gap that collapse to one column at 1099px.

The landing's first screen is a different model and is specific to that screen. From 1100px up it is laid out in the approved comp's own pixels (1536 wide): every length is a comp measure multiplied by one unit, `min(100vw, 1760px) / 1536`, so the whole composition, type included, scales with the window. Below 1100px the unit becomes 1px and the same parts stack: name, line, copy, board plate, then the ticket hanging down the page as a column of stubs.

The front desk and the gate are a two-pane hall under a top row (min-height 60px): a wall on the left and a desk on the right, `minmax(0, 1.45fr) minmax(360px, 1fr)`, gap clamp(24px, 2.6vw, 40px), aligned to the top, in a frame of max 1440px with clamp(16px, 3.2vw, 44px) of ground at the sides. The wall holds the slab line, the lede and one board; the desk holds one ticket of stubs, 8px between the parts of a stub. At 1099px the hall becomes one column of max 640px and the order changes with the screen's job. At `/play`: line, a green link to the board that says how many matches are boarding, the ticket, the lede, the board. At the gate: line, the board of seats, the lede, the ticket, the way back. A row of the board becomes a small card of three columns whose cells carry their own labels; the column heads and the blank lines are dropped. At 420px the ways in, the fields and the pickers each stack to one column.

The table sizes itself from the board: a 9 by 13 cell grid in portrait, 13 by 9 in landscape from 600px wide.

Breakpoints in the build: 1099px (landing and front desk), 420px (front desk), landscape with min-width 600px (table). Safe-area insets pad the top and bottom of every screen.

### Named Rules
**The Level Ground Rule.** At rest only the landing's tickets tilt: the itinerary strip by -5.08deg (-1.2deg when stacked), the closing ticket by -1.4deg (-1deg), the first stub's button by -3deg. Boards, prose and lists are never tilted, and the front desk's ticket lies level: it is a form to be filled. Motion is not tilt: a stub may settle from -0.7deg as it is dealt, and a flap turns on its top edge as it drops in.

## Elevation & Depth

Depth is material, not a scale. Paper is a loose object and casts a soft, warm, low shadow on the ground; a board is fixed to the wall and casts none, marked instead by a gold hairline. Because ticket paper is cut with a CSS mask, its shadow is a `filter: drop-shadow` on the unmasked parent, never a `box-shadow` on the paper itself. Nothing on a stub is raised except its one gold pill; fields, chips and notes on paper are flat.

### Shadow Vocabulary
- **Ticket on the ground** (`filter: drop-shadow(0 14px 18px rgb(20 4 2 / 40%))`): every masked paper object on the landing and the ticket on the front desk; 45% under the itinerary strip, `0 18px 22px` under the closing ticket.
- **Foil lettering** (`filter: drop-shadow(0 2px 1.5px rgb(74 30 4 / 70%))`): the shade under foil-clipped lettering, on the landing and the front desk; the landing's first-screen name and wordmark add `drop-shadow(0 10px 16px rgb(0 0 0 / 22%))`.
- **Go button** (`box-shadow: inset 0 -2px 0 rgb(160 96 10 / 35%), 0 3px 7px rgb(90 50 5 / 22%)`): a pressed-foil lower edge and a short cast on paper. Removed when the button is disabled.
- **Speech note** (`box-shadow: 0 6px 14px rgb(0 0 0 / 22%)`): the agent's cream notes on the landing's ground; `0 4px 12px` at the table. The agent's quote on a front-desk stub has no shadow.

The table keeps its own neutral black shadows, which this record does not enumerate.

### Named Rules
**The Paper Casts, Boards Sit Rule.** On the landing and the front desk, shadow means "this is paper". A board gets a 1.5px border of Foil Gold at 55% and a top-to-bottom gradient from `night-top` to `night`, and no shadow.

## Shapes

Two families. Tickets are rectangles with their corners bitten out by a quarter-circle (radius 9 to 12px on the landing, 10px on the front desk), so that where two stubs meet the bites form a perforation notch, joined by a 2px dashed line of rgb(122 82 46 / 55%) inset 16 to 18px from the edges. On the landing stubs sit side by side and the perforation is vertical; the two ends of the itinerary strip are scalloped (7px half-rounds every 22px) with a 16px outer radius, as if torn from a book, and when stubs stack on a narrow screen the perforation turns horizontal. On the front desk the stubs are always stacked and the perforation is always horizontal. The same dashed line, drawn inside a stub, sets its sums apart from its choices; a solid 1.5px line of ink at 14% opens the rule editor.

Everything that is not a ticket is softly rounded: boards at 22 to 24px with an inner table at 16px on the landing, table cards at 16 to 18px, the two secondary ways in at 16px, rows, fields and the error note at 10px. Controls and chips are full pills. A flap cell is a small upright rectangle (15 by 22px, radius 3px) with a hinge line across its middle. A speech note has one tight corner pointing at its speaker (4px 16px 16px 16px on the landing, 4px 14px 14px 14px on a stub).

Two circles belong to people. An account is a stamp: a 52px ring in red ink, 2px outside and 1.5px inside, around two slab initials. A seat at the gate is a 64px disc (52px on a narrow screen) with a 3px border in the seat's own colour over a fill mixed from that colour and Night; a free seat is a dashed ring with no fill.

Lines on the ground and on boards are hairlines of cream at 11 to 18% alpha; a dashed line in cream at 38% means "not yet" (the Coming chip, the Coming note, an open seat on the board, a free seat at the gate).

Icons are one drawn set, `components/landing/icons.tsx`, shared by the landing and the front desk: 24px grid, 2px round stroke, `currentColor`, with a filled plane and an ink-outlined die. On paper an icon that names a thing is red ink; on the ground and on boards it is Foil Gold.

## Components

### Buttons
Round, warm and few: one gold action per stub.
- **Shape:** full pill (999px).
- **Go (the primary on a ticket):** Button Gold gradient on paper, ink label at 700, with an icon when it helps. On the landing: 62 by 250 comp units on the first screen, 56px tall and full width when stacked, a trailing arrow. On the front desk: full width, min-height 52px, padding 0 20px, label 16px. It lives on a stub, never on the ground. Disabled, it is a flat wash of ink at 10% with Soft Ink text and no shadow.
- **Outline pill (front desk):** min-height 40px, padding 0 14px, 1.5px border of ink at 30%, no fill, ink label 14px at 700; hover darkens the border to ink and adds a wash of ink at 6%. An ink variant is solid ink with cream text, for the one action that sits beside a field. A quiet variant drops the border and sets Soft Ink at 600, for leaving and for back-ups.
- **Way in (front desk):** the two secondary sign-in choices, side by side: a 16px-radius outline box, min-height 50px, a red icon, a 14.5px name over a 12.5px line of examples.
- **Main (table):** Flat Gold fill and border, ink label at 700, min-height 42px, padding 0 16px; a 52px full-width size and a 34px small size.
- **Outline (table):** 1.5px border of cream at 40%, fill of white at 8%, inherits text colour; a quiet variant drops both.
- **Hover / Focus:** Go lifts 2px over 0.25s with cubic-bezier(0.2, 0.9, 0.2, 1) and brightens slightly; the table's buttons scale to 0.97 on press over 120ms. Focus on the landing and the front desk is a 3px Foil Gold outline offset 3px, switched to `red` on paper (and to ink on the landing's gold button).

### Chips
- **Status chip:** pill, 1.5px border, uppercase label. Boarding or Open: green border, green tint, pale green text. Live or Beta (`data-live`): gold border, gold tint at 14%, Pale Gold text. Coming (`data-soon`): dashed cream border at 38%, no fill, Soft text. On the landing's board it is 14 comp units with padding 4 by 15; the front desk sets it at 12px with 4px 12px.
- **Network chip:** pill, 1.5px Foil Gold border, Chip Well fill, cream text with a gold chain icon; sits at the far right of the top row. On the front desk it is 13px at 700 and is followed by the contract's id in mono at 12.5px, which is dropped at 1099px; on the landing the text is 400.
- **Rule chip (front desk):** one rule of an agent's playbook: pill, wash of ink at 8%, no border, ink text 12.5px at 600, padding 4px 10px. It states; it is not pressed.
- **Open seat:** on a board row, the words "open seat" in a dashed cream pill.
- **Share bar (gate):** how a pot is shared: segments in one pill-clipped row, 3px apart, each as wide as its share; first place is solid ink with cream text, the rest a wash of ink at 10%.

### Cards / Containers
- **Ticket stub (landing):** Ticket Paper with grain, ink text, bitten corners, perforation to its neighbour, shadow from the parent (see Elevation). Padding 26px 24px 30px in the boarding pass, 26px in the fare table. A stub that is a transaction is one whole link: it lifts 4px on hover, its code turns `red` and underlines, and a small ink pill names where it opens.
- **Ticket of stubs (front desk):** the same paper, grain and bites, stacked in one column and joined by horizontal perforations. Each stub: padding 16px 24px 18px, a slab title in red ink (23px) that may carry one icon at its right end, at most one Go button, everything else in ink. `/play` deals three: Passenger, Co-pilot, Flight. The gate deals Boarding pass first, then the same Passenger and Co-pilot.
- **Departures board / ledger:** `night-top` to `night` gradient, gold hairline, radius 22 to 24px, slab heading in gold with a leading icon, rows divided by cream hairlines at 11%, row hover a cream wash at 5 to 6%. Each row is a link. On the front desk the heading's word is foil-clipped, a match code is Pale Gold mono, the row of a match you sit in carries a gold wash at 8%, and a gold arrow at the end of the row slides 3px on hover.
- **Blank lines:** the front desk's board always shows seven lines. A line with no match is a ruled line at half strength whose status cells are eight blank flaps. They are dropped on a narrow screen.
- **Gate board:** the same board for one match: a row per seat (disc, board label over the name at 19px, a flap word), then a row of four terms, each a board label over a 16px value. Its title carries the match's state at the right end.
- **Speech note:** on the landing and the table, cream fill, dark brown text, one tight corner, short shadow; successive notes step to the right on the landing. On a stub the agent's quote is Field Cream, flat, 14px, with the model's name in red before the sentence.
- **Error note (front desk):** on paper, radius 10px, padding 8px 12px, a 12% wash of Loss Red, Alert Ink text at 13.5px, 600. It says what failed and what still works.

### Inputs / Fields
Standard controls, dressed in ink on paper.
- **Segmented picker on paper:** separate pills, min 48 by 40px, 1.5px ink border at 30%; pressed is solid ink with cream text. The landing's fare table and the front desk's Flight stub use the same form.
- **Select and text input (front desk):** min-height 40px, padding 0 12px, radius 10px, 1.5px border of ink at 30%, Field Cream fill, ink text (600 in a select, 400 in a text input); a select draws its own ink chevron; the placeholder is #76543f and the caret is `red`. Disabled is 55% opacity. A field's label sits to its left in Soft Ink at 600 and moves above it at 420px.
- **Slider and checkbox:** native controls with `accent-color` set to `red`; a slider's label carries its current value at the right in tabular figures; a checkbox is 18px.
- **Focus:** the 3px `red` outline of anything on paper.

### Navigation
The top row of the landing and the front desk: gold slab wordmark, sans links at 600 with a 3px gold underline on hover, and the network chip pushed right. On the front desk the links are Soft and the current page keeps its underline. Below 1100px the links wrap to their own scrollable row. The gate's way back to the board is a Soft text link at 600 with a gold arrow, under the board.

### Itinerary strip (landing signature)
One real match as a ticket of six stubs laid across the first screen: the first stub carries the Go button, the other five are transactions with time, action, an isometric vignette and a short hash. It arrives once, stub by stub (0.7s each, 0.11s apart, cubic-bezier(0.16, 1, 0.3, 1)), and not at all under reduced motion.

### Split-flap status (front desk signature)
A status that changes on a board is spelled in flap cells, one character to a cell, 2px apart, a space as a 6px gap: the round of a match in play ("ROUND 4/6"), a seat's state at the gate ("SEATED", "WAITING", "THE HOUSE"), a full match about to start ("STARTING"). A cell is 15 by 22px, radius 3px, a 1px border of Foil Gold at 32%, a dark face split by a black hinge line, a Pale Gold character in bold mono. Each cell is keyed by its character, so a character that changes is a new flap: it drops in from its top edge (0.42s, cubic-bezier(0.16, 1, 0.3, 1), 45ms later per cell, from a 62deg fold and a brighter face) while the cells that did not change hold still. The word is read aloud whole. A match that is boarding keeps the green chip instead; flaps are for what moves. The stubs of the ticket are dealt once on arrival (0.6s, 0.09s apart). Under reduced motion neither entrance runs and transitions are cut to nothing.

## Do's and Don'ts

### Do:
- **Do** put a match's facts and its one action on Ticket Paper, what is read from the chain on a Night board, and prose directly on the ground.
- **Do** divide a ticket with a 2px dashed perforation and bitten corners; shadow it with `filter: drop-shadow` on the unmasked parent.
- **Do** give a stub one gold pill at most; every other action on paper is an ink outline, solid ink or quiet.
- **Do** spell a status that changes on a board in split-flap cells keyed by character, and keep the green chip for "boarding".
- **Do** dress standard form controls in ink on paper (Field Cream fill, ink border at 30%, `red` accent) rather than drawing new ones.
- **Do** set every time, amount, count and hash in tabular numerals, and make every chain identifier a link to its transaction or account, as the landing does.
- **Do** keep Alfa Slab One at 19px or larger, for names, headlines and amounts only.
- **Do** mark what does not exist yet with a dashed outline: the word Coming, an open seat.
- **Do** draw new illustration as small isometric vignettes of the board's own squares, and keep each raster's generation prompt with the file, as `assets/plates/` does.
- **Do** honour `prefers-reduced-motion`: entrances are removed and transitions shortened, as every stylesheet already does.

### Don't:
- **Don't** clip the gold-foil plate to anything but slab lettering on the dark ground or a board: on paper the same lettering is flat `red`.
- **Don't** tilt a board, a list or a paragraph, or the front desk's ticket; only the landing's tickets tilt at rest.
- **Don't** put a `box-shadow` on masked paper (the mask cuts it off) or a shadow under a board.
- **Don't** set flap cells on paper or on the ground; they belong to boards.
- **Don't** add a third gold or another ground red; the two of each that exist are a recorded difference between the landing and front desk on one side and the game table on the other.
- **Don't** carry the first screen's window-scaled comp units to another screen: below the fold the landing itself returns to fixed and clamped sizes, and the front desk uses none.
- **Don't** use any Monopoly name, art or wording; the corners are Departure, Customs, Transit Lounge and Visa Denied.
