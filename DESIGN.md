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
  gold-flat: "#f2c14e"
  amber: "#ffc857"
  cream: "#fff7e6"
  paper: "#f8f0d4"
  ink: "#2a1208"
  ink-soft: "#5a3524"
  soft: "#f0d9c4"
  soft-warm: "#f3d9b1"
  night: "#201009"
  night-top: "#2a120a"
  boarding-green: "#4fae6c"
  boarding-green-text: "#bfeccb"
  gain: "#1f6a34"
  loss: "#a02a1a"
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
  title:
    fontFamily: "Alfa Slab One, serif"
    fontSize: "26px"
    fontWeight: 400
    lineHeight: 1.1
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
  body-app:
    fontFamily: "Be Vietnam Pro, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: "Be Vietnam Pro, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 700
    letterSpacing: "0.06em"
  data:
    fontFamily: "ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "14px"
    fontWeight: 400
rounded:
  pill: "999px"
  board: "22px"
  panel: "20px"
  inner: "16px"
  row: "10px"
spacing:
  tight: "8px"
  stack: "12px"
  panel: "18px"
  gutter: "20px"
  ticket: "26px"
  section: "clamp(72px, 9vw, 132px)"
components:
  button-go:
    backgroundColor: "{colors.gold}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    height: "56px"
    padding: "0 8px"
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
  departures-board:
    backgroundColor: "{colors.night}"
    textColor: "{colors.cream}"
    rounded: "{rounded.board}"
    padding: "18px 18px 20px"
  status-chip:
    backgroundColor: "rgb(47 154 92 / 22%)"
    textColor: "{colors.boarding-green-text}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "4px 14px"
  status-chip-live:
    backgroundColor: "rgb(248 201 63 / 14%)"
    textColor: "#fbe29a"
    rounded: "{rounded.pill}"
  status-chip-soon:
    backgroundColor: "transparent"
    textColor: "{colors.soft}"
    rounded: "{rounded.pill}"
  segment:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    height: "40px"
    padding: "0 12px"
  segment-pressed:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.cream}"
  agent-note:
    backgroundColor: "{colors.cream}"
    textColor: "#3a1508"
    padding: "14px 18px"
  lobby-panel:
    backgroundColor: "rgb(20 6 3 / 38%)"
    textColor: "{colors.cream}"
    rounded: "{rounded.panel}"
    padding: "18px"
---

# Design System: Deedlords

Recorded on 2026-11-11 from the shipped code: the landing page at `/` (`app/landing.css`) first, then the lobby at `/play` (`app/play/play.css`) and the game table (`app/co-ty-phu/co-ty-phu.css`) as the incumbent it extends. The three stylesheets each declare their own custom properties on their own root class (`.lp`, `.dl`, `.tp`); there is no shared token file. Where they disagree, both values are listed and the disagreement is stated, not resolved.

## Overview

**Creative North Star: "The Departures Hall"**

Deedlords is drawn as an airport for a board game. A match is a flight: it is listed on a departures board, boarded with a ticket, and paid out at landing. Three materials do all the work. A deep red ground, lit from the top centre, holds the prose. Cream ticket paper, cut by perforations and notched at its corners, holds a match's facts and the action that starts one. Near-black boards with a gold hairline hold what is read from the chain: open matches and transaction ledgers. Gold slab lettering names things; a geometric sans says everything else.

The system is warm and physical, never glassy or technical. The chain is shown as printed matter: a transaction is a stub you can pick up, a ledger is a board you can read down. Small isometric vignettes of the board's own squares stand in for illustration. Density is high on paper and boards (tabular figures, short lines) and generous on the ground (one headline, one lede, wide vertical gaps).

The landing page and the app are the same world built at two moments and they differ in measurable ways. The landing sets its lettering in a gold-foil plate on a darker ground; the lobby and table use flat gold on a lighter, redder ground, and the lobby adds translucent dark panels that the landing does not have. The name "The Departures Hall" was chosen by the documenting pass from the built forms and has not been confirmed by the owner.

**Key Characteristics:**
- Three materials: red ground, cream ticket paper, near-black board. Each has one job.
- Tickets are divided by dashed perforations and bitten corners, not by gaps or borders.
- Gold is lettering and the primary action; green is "boarding"; nothing else is an accent.
- Alfa Slab One for names, headlines and amounts; Be Vietnam Pro for everything else.
- Only paper tilts and casts a shadow. Boards and prose sit level and flat.
- Every figure is set in tabular numerals; every chain identifier is a link.

## Colors

A red-and-gold palette with warm neutrals only: no grey, no blue, no pure black or white in the landing build.

### Primary
- **Foil Gold** (`gold`, #f8c93f): the landing's gold. Slab lettering on the ground and on boards, the primary button, link underlines, the hairline around boards (at 55% alpha), question terms in the trust list, focus rings.
- **Flat Gold** (`gold-flat`, #f2c14e): the incumbent gold of the lobby and table. Logo, main button, selected segment, balances. It is a different value from Foil Gold and both are live.
- **Board Amber** (`amber`, #ffc857): lobby only. The heading, match codes and status on the lobby's departures panel.

### Secondary
- **Boarding Green** (`boarding-green`, #4fae6c, with text `boarding-green-text`): the border and text of the "Boarding" and "Open" status chips on boards and on the ground. It means a seat can be taken now.
- **Gain Green** (`gain`, #1f6a34) and **Loss Red** (`loss`, #a02a1a): signed returns on paper, in the fare table only.

### Neutral
- **Hall Red** (`ground`, #5d100a, falling to `ground-low`): the landing's page ground. A vertical gradient from #67120b through `ground` to `ground-low`, under a soft radial glow of rgb(190 60 38 / 55%) at the top centre.
- **Lantern Red** (`red`, #7a1712, with `red-lit` above and `red-deep` below): the incumbent ground of the lobby and table, a radial gradient lit from the top centre. On the landing the same value is lettering on paper (pass headings, the closing headline) and the slider accent.
- **Ticket Paper** (`paper`, #f8f0d4): the landing's ticket stock, under a tiled paper-grain plate. Stubs, the boarding pass, the fare table, the closing ticket.
- **Cream** (`cream`, #fff7e6): primary text on ground and boards; the agent's speech notes; in the lobby and table it is also the ticket stock, flat, with no grain.
- **Ink** (`ink`, #2a1208, with `ink-soft` for secondary lines): all text on paper and on gold.
- **Soft** (`soft`, #f0d9c4 on the landing; `soft-warm`, #f3d9b1 in the lobby and table): secondary text on ground and boards.
- **Night** (`night`, #201009, under `night-top`): departures boards, ledgers and the code block.

### Named Rules
**The Three Materials Rule.** On the landing every surface is ground, paper or board. Ground carries prose, paper carries a match and its action, boards carry what is read from the chain. The lobby adds a fourth, a translucent dark panel (rgb(20 6 3 / 38%)) for forms; it is incumbent and stays where it is.

**The Two Golds Rule.** Foil Gold belongs to the landing, Flat Gold to the lobby and table. This is recorded as a difference in the build, not as a design decision; do not introduce a third.

## Typography

**Display Font:** Alfa Slab One (with serif)
**Body Font:** Be Vietnam Pro (with system-ui, sans-serif)
**Label/Mono Font:** ui-monospace, SF Mono, Menlo, Consolas (system stack, chain identifiers only)

**Character:** A heavy poster slab against a plain geometric sans: the slab is the sign over the gate, the sans is the small print on the ticket. Both are loaded in `lib/fonts.ts`; Be Vietnam Pro is loaded at 400, 600 and 700 only.

### Hierarchy
- **Display** (400, clamp(40px, 12.4vw, 96px), line-height 0.9, uppercase): the product name on the landing's first screen below 900px. From 900px up the first screen scales with the window and the name is 102 comp units (about 6.6vw, capped near 117px) at line-height 0.82. The lobby logo is the same face at clamp(44px, 13vw, 72px).
- **Headline** (400, clamp(30px, 4vw, 52px), line-height 1.08, balanced): one per landing section.
- **Title** (400, 26px, line-height 1.1): slab headings on paper and on boards (pass legs at 26px, ledger heading at clamp(20px, 2.2vw, 28px), lobby panel titles at 21px).
- **Title, sans** (700, clamp(21px, 2.1vw, 26px), line-height 1.25): a sub-heading on the ground that should not compete with the section headline.
- **Lede** (400, clamp(17px, 1.5vw, 20px), line-height 1.5, max 62ch): the sentence under a headline.
- **Body** (400, 17px, line-height 1.5, max 60 to 62ch): prose on the landing; 16px on paper. The app runs denser, at 15px with line-height 1.4.
- **Label** (700, 13px, letter-spacing 0.06em, uppercase): status chips and the agent's name tag. Column heads on a board are 600 at 0.1em.
- **Data** (400, 14px, system mono): transaction hashes and match ids on boards.

### Named Rules
**The Slab Says Little Rule.** Alfa Slab One sets names, headlines and amounts (the pot, the fare result), and nothing smaller than 19px anywhere in the build. It never sets a sentence of body text.

**The Tabular Figures Rule.** Times, stakes, seat counts, returns and hashes are set with `font-variant-numeric: tabular-nums`, so a board's columns hold still as its numbers change.

## Layout

Below the landing's first screen the page is a single centred column, min(1120px, 100% - 40px), with sections separated by clamp(72px, 9vw, 132px) of ground. Inside a section the order is fixed: slab headline, lede, then one paper or board object. Two-column arrangements (plan and code, copy and fare table) are near-even grids with a 40 to 48px gap that collapse to one column at 899px.

The landing's first screen is a different model and is specific to that screen. From 900px up it is laid out in the approved comp's own pixels (1536 wide): every length is a comp measure multiplied by one unit, `min(100vw, 1760px) / 1536`, so the whole composition, type included, scales with the window. Below 900px the unit becomes 1px and the same parts stack: name, line, copy, board plate, then the ticket hanging down the page as a column of stubs.

The lobby is a single column of min(100%, 620px), centred, with 16px between panels and 18px inside them. The table sizes itself from the board: a 9 by 13 cell grid in portrait, 13 by 9 in landscape from 600px wide.

Breakpoints in the build: 899px (landing), 520px (lobby rows and ticket), landscape with min-width 600px (table). Safe-area insets pad the top and bottom of every screen.

### Named Rules
**The Level Ground Rule.** Only tickets tilt: the itinerary strip by -5.08deg (-1.2deg when stacked), the closing ticket by -1.4deg (-1deg), the first stub's button by -3deg. Boards, prose and lists are never rotated.

## Elevation & Depth

Depth is material, not a scale. Paper is a loose object and casts a soft, warm, low shadow on the ground; a board is fixed to the wall and, on the landing, casts none, marked instead by a gold hairline. Because ticket paper is cut with a CSS mask, its shadow is a `filter: drop-shadow` on the unmasked parent, never a `box-shadow` on the paper itself.

### Shadow Vocabulary
- **Ticket on the ground** (`filter: drop-shadow(0 14px 18px rgb(20 4 2 / 40%))`): every masked paper object on the landing; 45% under the itinerary strip, `0 18px 22px` under the closing ticket.
- **Foil lettering** (`filter: drop-shadow(0 2px 1.5px rgb(74 30 4 / 70%))`): the shade under foil-clipped headlines; the first-screen name and the wordmark add `drop-shadow(0 10px 16px rgb(0 0 0 / 22%))`.
- **Go button** (`box-shadow: inset 0 -2px 0 rgb(160 96 10 / 35%), 0 3px 7px rgb(90 50 5 / 22%)`): a pressed-foil lower edge and a short cast on paper.
- **Speech note** (`box-shadow: 0 6px 14px rgb(0 0 0 / 22%)`): the agent's cream notes on the ground; `0 4px 12px` at the table.
- **Lobby panel** (`box-shadow: 0 14px 30px rgb(0 0 0 / 28%)`) and **lobby ticket** (`box-shadow: 0 18px 36px rgb(0 0 0 / 40%)`): the incumbent's neutral black shadows. The lobby shadows its boards; the landing does not.

### Named Rules
**The Paper Casts, Boards Sit Rule.** On the landing, shadow means "this is paper". A board gets a 1.5px border of Foil Gold at 55% and a top-to-bottom gradient from `night-top` to `night`, and no shadow.

## Shapes

Two families. Tickets are rectangles with their corners bitten out by a quarter-circle (radius 9 to 12px), so that where two stubs meet the bites form a perforation notch, joined by a 2px dashed line of rgb(122 82 46 / 55%) inset 16 to 18px from the edges. The two ends of the itinerary strip are scalloped (7px half-rounds every 22px) with a 16px outer radius, as if torn from a book. When stubs stack on a narrow screen the perforation turns horizontal and the scallops move to the top and bottom edges.

Everything that is not a ticket is softly rounded: boards at 22 to 24px with an inner table at 16px, lobby panels and tickets at 20px, table cards at 16 to 18px, rows and small fields at 10px. Controls and chips are full pills. A speech note has one tight corner (4px 16px 16px 16px) pointing at its speaker.

The lobby's ticket is an earlier form of the same idea: a 20px rounded cream card with a dashed divider and two 22px discs in the ground colour laid over its edges. The landing's masked bites replace the discs, which only work on a flat ground.

Lines on the ground are hairlines of cream at 11 to 18% alpha; a dashed hairline means "not yet" (the Coming chip, the Coming note, a free seat in the lobby).

Icons on the landing are one drawn set: 24px grid, 2px round stroke, `currentColor`, with a filled plane and an ink-outlined die.

## Components

### Buttons
Round, warm and few: one gold action per ticket.
- **Shape:** full pill (999px).
- **Go (landing primary):** a top-to-bottom gold gradient (#fbd155 to #f3b93a) on paper, ink label at 700, trailing arrow icon; 62 by 250 comp units on the first screen, 56px tall and full width when stacked. It lives on a ticket stub, never on the ground.
- **Main (lobby and table):** Flat Gold fill and border, ink label at 700, min-height 42px, padding 0 16px; a 52px full-width size and a 34px small size.
- **Outline (lobby and table):** 1.5px border of cream at 40%, fill of white at 8%, inherits text colour; a quiet variant drops both.
- **Hover / Focus:** Go lifts 2px over 0.25s with cubic-bezier(0.2, 0.9, 0.2, 1). Incumbent buttons scale to 0.97 on press over 120ms. Focus on the landing is a 3px Foil Gold outline offset 3px, switched to ink on gold and to `red` on paper.

### Chips
- **Status chip:** pill, 1.5px border, uppercase label. Boarding or Open: green border, green tint, pale green text. Live or Beta (`data-live`): gold border, gold tint at 14%, pale gold text. Coming (`data-soon`): dashed cream border at 38%, no fill, Soft text.
- **Network chip:** pill, 1.5px Foil Gold border, fill rgb(52 10 8 / 78%), cream text with a gold chain icon; sits at the far right of the top row.
- **Lobby chips:** 1px hairline border, black at 22%, Soft text at 12px. The lobby's departures status is a 6px-radius filled tag, not a pill.

### Cards / Containers
- **Ticket stub (landing):** Ticket Paper with grain, ink text, bitten corners, perforation to its neighbour, shadow from the parent (see Elevation). Padding 26px 24px 30px in the boarding pass, 26px in the fare table. A stub that is a transaction is one whole link: it lifts 4px on hover, its code turns `red` and underlines, and a small ink pill names where it opens.
- **Departures board / ledger (landing):** `night-top` to `night` gradient, gold hairline, radius 22 to 24px, slab heading in gold with a leading icon, rows divided by cream hairlines at 11%, row hover a cream wash at 5 to 6%. Each row is a link.
- **Lobby panel:** translucent dark fill, hairline of cream at 16%, radius 20px, padding 18px, neutral shadow. The lobby's departures panel swaps the fill for a near-black gradient with an amber hairline and sets its rows in mono.
- **Seat card (lobby):** radius 20px, 2px border and tinted fill mixed from the seat's own colour; a free seat is dashed, greyed and slowly bobbing.
- **Speech note:** cream fill, dark brown text, one tight corner, short shadow; successive notes step to the right on the landing.

### Inputs / Fields
- **Segmented picker on paper (fare table):** separate pills, min 48 by 40px, 1.5px ink border at 30%; pressed is solid ink with cream text.
- **Segmented picker on a panel (lobby):** pills inside a black-at-30% track; pressed is Flat Gold with ink text.
- **Slider:** native range input with `accent-color` set to `red`.

### Navigation
The landing's top row: gold slab wordmark, four sans links at 600 with a 3px gold underline on hover, and the network chip pushed right. Below 900px the links wrap to their own scrollable row. The lobby's only navigation is a plain Soft text link back to the list.

### Itinerary strip (signature)
One real match as a ticket of six stubs laid across the first screen: the first stub carries the Go button, the other five are transactions with time, action, an isometric vignette and a short hash. It arrives once, stub by stub (0.7s each, 0.11s apart, cubic-bezier(0.16, 1, 0.3, 1)), and not at all under reduced motion.

## Do's and Don'ts

### Do:
- **Do** put a match's facts and its one action on Ticket Paper, what is read from the chain on a Night board, and prose directly on the ground.
- **Do** divide a ticket with a 2px dashed perforation and bitten corners; shadow it with `filter: drop-shadow` on the unmasked parent.
- **Do** set every time, amount, count and hash in tabular numerals, and make every chain identifier a link to its transaction or account.
- **Do** keep Alfa Slab One at 19px or larger, for names, headlines and amounts only.
- **Do** mark what does not exist yet with a dashed outline and the word Coming.
- **Do** draw new illustration as small isometric vignettes of the board's own squares, and keep each raster's generation prompt with the file, as `assets/plates/` does.
- **Do** honour `prefers-reduced-motion`: entrances are removed and transitions shortened, as all three stylesheets already do.

### Don't:
- **Don't** clip the gold-foil plate to anything but slab lettering on the dark ground or a board: on paper the same lettering is flat `red`.
- **Don't** rotate a board, a list or a paragraph; only tickets tilt.
- **Don't** put a `box-shadow` on masked paper (the mask cuts it off) or a shadow under a landing board.
- **Don't** add a third gold or another ground red; the two of each that exist are a recorded difference between the landing and the app.
- **Don't** carry the first screen's window-scaled comp units to another screen: below the fold the landing itself returns to fixed and clamped sizes.
- **Don't** use any Monopoly name, art or wording; the corners are Departure, Customs, Transit Lounge and Visa Denied.
