# Before the game: the pre-game screens, redesigned

Date: 2026-11-13. Scope: everything a player goes through before the first roll or the first hand, in both games of Deedlords Club.
Screenshots, before and after, at 390 px (phone) and 1440 px (desktop), are in [`pregame-ux/`](pregame-ux/).

The brief, from the owner (in Vietnamese): study and redesign the whole pre-game UI/UX, the waiting room and table creation; there seem to be too many buttons; cut them down; take ideas from other casual games.

## 1. Audit: what was there

Counted on the paper ticket only (the top row and the departures board are left out), visible controls only, testnet with free play sponsored.

| Screen                                 | Before                                                                                                                                                                                                | Controls |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------: |
| `/play`, signed out                    | Passenger: guest, Google, EVM wallet, NEAR wallet. Co-pilot: a paragraph asking to check in. Flight: 6 stake chips, own stake field, opponent 2, AI count 3, AI model select, rounds 4, a disabled Go |       22 |
| `/play`, signed in                     | Passenger: Wallet, Sign out. Co-pilot: agent chip, + New agent, "Fly my seat" checkbox, Edit my agents. Flight: the same 18                                                                           |       24 |
| Gate of a match (host waiting)         | Copy the invitation link; Passenger: Make your character, Wallet, Sign out; Co-pilot: 4 again                                                                                                         |        8 |
| Gate of a match (stranger, signed out) | No seat button at all ("Check in below"); four sign-in buttons further down                                                                                                                           |        4 |
| `/poker/tables`, signed in             | Copy the address, faucet link; seats 2 to 9 (8 buttons), 5 stake chips, own stake field, house model select, Go                                                                                       |       18 |
| `/poker/tables`, signed out            | Make a guest game account, then the same 16                                                                                                                                                           |       17 |
| Poker table waiting for players (host) | Link box + Copy, Start, Leave, house model select, Seat a house seat                                                                                                                                  |        5 |
| Poker table, stranger signed out       | A banner with its own "Make a guest game account" button, then "Sit down"                                                                                                                             |        2 |

What the phone showed (`before-play-guest-390.webp`, `before-poker-signedin-390.webp`): every option of every kind of table at once. On `/play` the gold button sat a full screen below the fold, under nine pill rows; the stub for a guest who had not signed in asked them to sign in three times (Passenger, Co-pilot, the disabled Go). A player who wanted "just play" had to read 22 controls to find out that the defaults were fine. The waiting room repeated the whole Passenger and Co-pilot stubs. The board listed twelve matches as twelve tall cards, the open ones not first.

## 2. References: how casual games start a game

Patterns studied (genres, not copied: no names, art or look taken from any game):

- **Mobile board games of the race-and-dice kind.** The first screen is three or four big mode tiles: against the computer, with friends in a private room, online for coins. Picking a tile is the only decision; the room's size and rules are behind a small "settings" line with sane defaults.
- **Poker apps' lobbies.** A single "Play now" seats you at once; the stake (the buy-in) is the one lever shown up front, as chips; everything else (table size, speed) is a filter or an option.
- **Party games' waiting rooms.** One big "Invite" that opens the phone's share sheet, the room's link or code shown small under it, the players' figures in the middle, and the host's Start as the only gold button once enough people are in.
- **Card games' quick play.** You can play before you have an account: the game makes a guest profile on the first tap and offers to link a real account later.

The rules the skill's UX base gives for the same thing: one primary action per screen (`primary-action`), reveal complex options progressively (`progressive-disclosure`), touch targets of 44 px and more (`touch-target-size`).

## 3. The new flow

**One gold button per screen, everything else has a default.**

### Deedlords desk (`/play`)

1. **Passenger** shrinks to one line: face or stamp, name, how the account was made, and the balance, which is the link to the wallet page (deposit, withdraw, other chains through 1Click, back up the key, sign out all live there already). Nobody signed in: the club's sign-in ticket lies on the desk in place of the stubs (section 8).
2. **New game**: three mode tiles, **vs AI · Free**, **Friends · Free room**, **Stake · Win NEAR** (only Stake where nobody sponsors free play), then the gold button: "Play vs AI", "Open a room of 2", "Open for 0.06 NEAR".
   - Stake shows its chips (0.05 to 1 NEAR, cut by the contract's cap) and an **Other** chip that opens the own-amount field; pot and winner's share stay under the chips.
   - **Table options** is one folded line that says what the defaults are ("1 AI · to the end", "2 seats · 6 rounds"). Inside: AI opponents 1 to 3 with a model each, seats 2 to 4, rounds 3/6/12/To the end.
   - The desk is dealt only to somebody signed in (section 8), so the gold button always opens a table. On Stake, an account that holds too little gets the way to the missing NEAR right under the button (`TopUp`: an EVM wallet pays the difference through 1Click on mainnet; a guest gets the address and the 1Click form).
3. **Co-pilot** shrinks to one row: "Let my agent play from the first roll", the agent (a select when there are several), and a link to `/agents`.
4. **Departures**: matches you sit in first, then matches with a seat to take, then the ones under way. On a phone the first four show and "Show all N matches" opens the rest. On a phone the top row no longer repeats the account chip the ticket already shows.

### Deedlords waiting room (gate of one match)

- The boarding pass has one gold action, whichever is due: **Take seat N** (somebody looking on without an account: **Sign in to take seat N**, back to the sign-in step), **Invite a friend** (the phone's share sheet; copies the link elsewhere; the link is printed small underneath), or the host's **Start the game**.
- Passenger and Co-pilot are the same one-line stubs as on the desk. The terms and the seats' full-body figures are unchanged.

### Poker lobby (`/poker/tables`)

- One-line account stub (shown once there is an account).
- **New table**: **vs House · Free** (heads-up, the house in seat 1), **Friends · Free room** (3 to 9 seats, the house holds seat 1 and pays the gas), **Stake · Win NEAR** (chips 0.1 to 1 NEAR and **Other** for an own amount, 0.1 to 1). One gold button. Seats 2 to 9, the house's model, and the table's rules (blinds, clock, start) fold under **Table options**.
- The lobby is shown only to somebody signed in to the club (section 8). On Stake, an account that is short gets the same `TopUp` as the board game under the button.

### Poker table waiting for players

- **Start with N seats** is the gold button once two sit; until then **Invite friends** is (share sheet or copy, the link printed small).
- **Seat an AI from the house** is one button with the default model; how many and which models fold under **House seats**.
- A stranger looking on has **Sit down**, which sends them to the sign-in step; the separate banner and its button are gone. **← Tables** at the head of every table leads back to the wall.

## 4. Before and after

| Screen                           | Before | After | Primary action, after                                 |
| -------------------------------- | -----: | ----: | ----------------------------------------------------- |
| `/play`, signed out              |     22 |     4 | Play as a guest, on the sign-in ticket (section 8)    |
| `/play`, signed in               |     24 |     8 | Play vs AI / Open a room / Open for X NEAR            |
| Gate, host waiting               |      8 |     4 | Invite a friend, then Start the game                  |
| Gate, stranger signed out        |      4 |     4 | Play as a guest, on the sign-in ticket; or Just watch |
| `/poker/tables`, signed in       |     18 |     5 | Play vs the House / Open a room / Open a table        |
| `/poker/tables`, signed out      |     17 |     4 | Play as a guest, on the sign-in ticket (section 8)    |
| Poker table waiting (host)       |      5 |     5 | Start with N seats, else Invite friends               |
| Poker table, stranger signed out |      2 |     2 | Sit down (to the sign-in step), Back to the tables    |

The waiting poker table keeps its count; what changed there is that one button is gold and the link box became a line of text.

## 5. Nothing lost: where each capability lives now

| Capability                                                       | Where                                                                             |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Guest / Google / EVM wallet / NEAR wallet sign-in                | The club's one sign-in ticket, on every page that needs an account (section 8)    |
| Free table vs AI, 1 to 3 opponents, a model each                 | vs AI tile; count and models under Table options                                  |
| Free room with friends                                           | Friends tile; seats under Table options                                           |
| Stake chips and own amount (Deedlords 0.05 to 1, poker 0.1 to 1) | Stake tile: chips, and Other for the field                                        |
| Seats (Deedlords 2 to 4, poker 2 to 9)                           | Table options                                                                     |
| Rounds 3 / 6 / 12 / To the end                                   | Table options                                                                     |
| Own agent, "fly my seat", `/agents`                              | Co-pilot row on the desk and the gate; the table's own "Let AI play" is unchanged |
| House model for free poker                                       | Table options (lobby) and House seats (table)                                     |
| Share a table link                                               | Invite button (share sheet or copy), link printed under it                        |
| Host's Start                                                     | The gold button once it is due                                                    |
| Join a table from the wall                                       | Departures / Tables boards, rows unchanged (open seats sorted first on Deedlords) |
| 1Click "Other chains", deposit, withdraw, key back-up, sign out  | Account page `/account`, reached from the balance on the one-line Passenger       |
| Make your character                                              | The top row's chip (unchanged)                                                    |
| Local helper's test accounts, faucet, "Play against the AI"      | Unchanged, shown only when the helper runs                                        |

No contract call, API route or game logic changed: the new props are UI only (`compact` on `PassengerStub` and `AgentStub`, `onSignIn` for somebody looking on).

## 6. Checked

- 390 px and 1440 px, before and after, in `pregame-ux/`; no horizontal scroll at 390 px.
- On NEAR testnet (first pass, before the sign-in step of section 8): a free Deedlords table against the AI was opened and played (`after-e2e-free-vs-ai.webp`), a free poker table against the house dealt hand 1 (`after-e2e-free-poker.webp`), and a free Deedlords room and a free poker room of 3 were opened from the Friends tiles. Section 8 lists what was checked again after it.
- `npx tsc --noEmit -p .` clean; `npm test` 233 of 233 pass.

## 7. One top row for the whole club (added 2026-11-13)

The owner's note after the first pass: the menus differ from game to game, poker has no account entry and no way to sign out, and the character's face is not shown everywhere.

Before, four top rows were drawn by four pieces of code:

| Page                                                                    | Links                                                 | Network                     | Account                                                   |
| ----------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------- | --------------------------------------------------------- |
| `/play`, the gate, `/account`, `/agents`, `/character`, `/shop`, `/bag` | Deedlords, Poker, Arena, Character, Shop, Bag, Agents | two-part chip               | chip with the face, the name and the balance; no sign-out |
| `/` and `/arena`                                                        | Deedlords, Poker, Arena, Character, Agents            | chip                        | none                                                      |
| `/poker` (heads-up)                                                     | Deedlords, Poker, Arena, Character, Agents            | chip with the contract's id | none                                                      |
| `/poker/tables`                                                         | Board game, Arena, Heads-up, Tables                   | chip with the contract's id | none                                                      |

Now one component, `components/hall/HallBar.tsx` with its own stylesheet `hall-bar.css`, draws the row on all of them:

- The same seven links in the same order everywhere: Deedlords, Poker, Arena, then Character, Shop, Bag, Agents. The current page is underlined.
- One network chip. Where the club also runs on the other network, the link to it is the last link of the row and an entry of the account menu.
- One account chip: the character's face (or the account's initials until it has one) and its name. Pressed, it opens a menu: name, balance, Account and wallet, Character, My AI agents, Sign out. Signed out, it is a gold "Sign in" chip to `/account`. A signed-in account with no character has a gold dot on the Character link.
- Sign out works from any page, poker included: it forgets the game key (after the same warning a guest gets on the account page) or disconnects the wallet, then loads the page again so every part of it agrees.
- A page that already knows who plays hands the account to the bar; elsewhere (the landing, the Arena's trailer, both poker pages) the bar reads the game key or the connected wallet by itself, and the poker pages hand it the club account like every other page.
- On a phone: wordmark, network and face on one line, the links on a second line that scrolls sideways. Below 1280 px the links take their own line; from 1280 px it is one row. The row never pushes the account off the screen: the links give way and scroll.

Not carried over: the poker rows' contract id (each poker lobby still links its contract under the board) and the "Heads-up" link (the tables lobby links it on testnet, as before).

Screens: `after-nav-unified-390.webp`, `after-nav-unified-1440.webp` (the row on seven pages), `after-nav-account-menu-390.webp`.

Not checked with a real character: the test account had none and the headless browser cannot draw one (no WebGL), so the chip was seen with initials only. The face is the same `ChibiFace` the hall's chip used before.

## 8. One sign-in for the club, a way out of every table, poker with 1Click (added 2026-11-13)

The owner's note after trying it: after a game there is no way out to the menu; a wallet connected for Deedlords has to be connected again at Poker, which only offers a guest account, with no wallet and no 1Click; better to make people sign in once outside, then every game is playable inside. So the "play first, a guest is made on the first tap" pattern of the first pass (section 2's last reference) is replaced by one explicit sign-in step.

### The sign-in step, per route

One component, `components/hall/SignIn.tsx` (its own stylesheet `sign-in.css`), is the only place the club signs anybody in. It offers a guest account (the gold button), Google where a sponsor makes it possible, an EVM wallet and a NEAR wallet, and says under each wallet what it can do at the poker tables. Once somebody is in, every page plays as that account (`usePlayer()`), and none asks again.

| Route                                                | Nobody signed in                                                                                                                                                                                            | Signed in                     |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `/` (landing), `/arena`                              | Nothing asked: the gates lead to the routes below. The top row has a gold Sign in chip                                                                                                                      | The top row shows the account |
| `/play`                                              | "Check in, then pick a flight.": the sign-in ticket lies on the desk in place of the stubs; the departures board stays readable                                                                             | The desk                      |
| `/play/<match>`                                      | "Check in to board this flight.": the sign-in ticket, with **Just watch, without signing in** (and a link with `?as=` goes straight to watching). A watcher's boarding pass says **Sign in to take seat N** | The match's gate or table     |
| `/poker/tables`                                      | "Check in, then pick a table.": the sign-in ticket                                                                                                                                                          | The lobby                     |
| `/poker/tables?t=<table>`                            | The sign-in ticket with **Just watch**; a watcher's **Sit down** leads back to it                                                                                                                           | The table                     |
| `/poker` (heads-up, testnet only)                    | The sign-in ticket                                                                                                                                                                                          | The lobby                     |
| `/account`, `/character`, `/shop`, `/bag`, `/agents` | The same ticket where the Passenger stub used to offer its own ways in                                                                                                                                      | As before                     |

Poker no longer signs anybody in: "Make a guest game account" is gone from both poker pages, and the top row gets the club account from the page like everywhere else.

### What each kind of account can do at the poker tables

Poker signs every step of a hand (a shuffle with its proof, the shares of each card, a bet) with a full-access key kept in the browser, so that no wallet prompt stops a hand. Nothing in the contracts or in the relay's rules was changed, so:

| Club account                                                 | Deedlords                                                        | Poker                                                                                                                                                                                                                                            |
| ------------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Guest (a key kept in this browser)                           | Yes                                                              | Yes, as the same account                                                                                                                                                                                                                         |
| EVM wallet (a game account made from the wallet's signature) | Yes                                                              | Yes, as the same account; a stake it cannot pay is paid from the wallet through 1Click on mainnet                                                                                                                                                |
| NEAR wallet                                                  | Yes                                                              | Not as that account: its key stays in the wallet. The lobby says so in one paragraph and offers **Make my poker game account**: one tap makes a game account for the poker tables, kept beside the wallet sign-in, which Deedlords goes on using |
| Google (through NEAR Auth)                                   | Yes (the browser holds a key for the board game's contract only) | Not as that account, for the same reason; the same one-tap poker game account                                                                                                                                                                    |

The poker game account kept beside a wallet or Google sign-in is `games/poker/pokerAccount.ts`: a key of its own in this browser (`deedlords:poker-account`), never deleted by signing out, because it may hold chips or NEAR. If the club account is later a guest's or an EVM wallet's, poker is played as that account again. Not built: showing that separate account on `/account` (its balance and a key back-up); for now its address and balance are on the poker lobby's first line.

### The ways out

- **Deedlords, match over:** the result card's gold button is **Back to the lobby** (`/play`), with **Club menu** (`/`), Transactions and View the board beside it; the same on a result opened from a link, on "the contract is paying out" and on "no such match".
- **Deedlords, during play:** a round exit button beside the transactions and menu buttons on the table leads to the lobby; the More sheet has **← Back to the lobby** and **Club menu**, with one line saying that leaving does not end the match (the contract moves a late seat, and the match stays first on the lobby's board). On the 2D board the header has **← Lobby**.
- **Poker, at any table:** **← Tables** at the head of the table. Somebody without a seat (looking on, or after leaving) also has **Back to the tables** under Sit down. **Leave and cash out** between hands goes back to the wall of tables by itself once the contract has paid. A settled table's gold button is **Back to the tables** (as before). The club's top row is on every poker page.

### A poker stake the account cannot pay

On Stake, the lobby works out what the seat needs (the stake, the record fee, and about half a NEAR that the check of the seat's shuffle proof must be able to reserve) and, when the account holds less, shows the board game's `TopUp` under the button in place of the old "keep about 0.6 NEAR" note: on mainnet an EVM-wallet account is quoted by 1Click and one button has the wallet pay the difference; a guest (and the poker account kept beside a wallet) gets the address and the 1Click form. `TopUp` took one new optional prop, `made`, so that it names poker's costs rather than the board game's.

### Checked on testnet

- Signed out: `/play`, `/poker/tables` and a match link show the sign-in ticket (`after-signin-play-390.webp`, `after-signin-play-1440.webp`, `after-signin-poker-390.webp`, `after-signin-match-390.webp`); Just watch shows the match with "Sign in to take seat 2" (`after-match-watching-390.webp`); signing in there as a guest and taking the seat filled the room.
- One sign-in: a guest made on `/poker/tables` was the account on `/play` with no further question, and the reverse.
- A Google-kind account (a stored key marked as Google's; a real Google or NEAR wallet sign-in was not run): the poker lobby showed the one paragraph and the button (`after-poker-google-account-390.webp`); one tap made the poker account, shown as "your poker game account, beside …" (`after-poker-own-account-390.webp`), and `/play` still played as the Google account.
- Deedlords: a free table against the AI, given up from the More sheet, reached the result with Back to the lobby (`after-deedlords-result-390.webp`).
- Poker: a free room opened from Friends showed ← Tables (`after-poker-room-exit-390.webp`); Leave and cash out returned to the wall of tables.
- Poker Stake with an empty account: the top-up is shown under the button (`after-poker-stake-topup-390.webp`). The 1Click payment itself is mainnet only and was not run.
- `npx tsc --noEmit -p .` clean; `npm test` 239 of 239 pass. The screenshots are WebP now (3.4 MB for the folder, from 23 MB of PNG).
