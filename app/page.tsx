import type { Metadata, Viewport } from "next";
import Image from "next/image";
import Link from "next/link";
import checkinArt from "@/assets/plates/checkin-art.png";
import arenaArt from "@/assets/plates/game-arena.webp";
import boardArt from "@/assets/plates/game-board.webp";
import pokerArt from "@/assets/plates/game-poker.webp";
import goldFoil from "@/assets/plates/gold-foil.webp";
import paper from "@/assets/plates/strip-paper.png";
import faceArt from "@/assets/plates/stub-ai-face.png";
import openArt from "@/assets/plates/stub-open-art.png";
import paidArt from "@/assets/plates/stub-paid-art.png";
import suezArt from "@/assets/plates/stub-suez-art.png";
import { Cast } from "@/components/landing/Cast";
import { Departures } from "@/components/landing/Departures";
import { FareTable } from "@/components/landing/FareTable";
import { Arrow, Chain, Out, Plane, Play, Tick } from "@/components/landing/icons";
import { COIN, NET_NAME, ON_MAINNET, OTHER_NET } from "@/components/landing/net";
import { TopBar } from "@/components/landing/TopBar";
import { CHAIN } from "@/lib/chain/config";
import { alfaSlab, beVietnam } from "@/lib/fonts";
import "./landing.css";

export const metadata: Metadata = {
  title: "Deedlords Club: no dealer, no server, no wallet pop-ups",
  description:
    "Table games for real stakes, fully on chain. NEAR contracts roll the dice, hold a deck nobody can read and pay the pot. Play free as a guest in seconds, or stake NEAR from any chain.",
};

export const viewport: Viewport = { themeColor: "#5d100a", viewportFit: "cover" };

// Everything quoted below is on NEAR mainnet, whichever network this deployment plays on: real transactions of 12 and
// 13 November 2026 (UTC), with what each burned. `npm run check:live` reads the same ones.
const NEARBLOCKS = "https://nearblocks.io";
const GAME = "game.deedlords.near";
const POKER = "poker.deedlords.near";
const REPO = "https://github.com/joyboyz2025/deedlords-club";
/** The mainnet club: this site itself there, the other deployment from the testnet one. */
const MAINNET_SITE = ON_MAINNET ? "" : (OTHER_NET.url ?? "https://deedlords-club.vercel.app").replace(/\/$/, "");

const RECEIPTS: { what: string; cost: string; hash: string }[] = [
  { what: "A poker seat shuffles 52 face-down cards and proves it in zero knowledge", cost: "221 Tgas · 0.021 NEAR", hash: "HucKM9wPjKYhhSAtAec7rvDvnKRfnSjNT5CJ9ypHaRWG" },
  { what: "A guest with no NEAR rolls the dice: the guest signs, the club pays", cost: "4.3 Tgas · 0.0004 NEAR", hash: "2jesymTABFtwPkeVX29Sc6DFhFvWQX9Rq2jyEAhTcLUx" },
  { what: "An AI seat plays its whole turn, signed inside a hardware enclave", cost: "3.9 Tgas · 0.0004 NEAR", hash: "2af7dAbW4rBsDSKKhXAdyTXB35FrxcoXttPiE2swuXEc" },
  {
    what: "The last move of a staked match: the contract pays both seats in the same transaction",
    cost: "38 Tgas · 0.0016 NEAR",
    hash: "Ci1p7yj2tqF3LXhMNrEjAYQbyuk416u6zcNPVXi3TADJ",
  },
];

// Three turns of one AI seat at a free table on mainnet, each signed by the enclave its model ran in.
const AI_MATCH = "f-mwdlimwc-tzrb-124";
const AI_MODEL = "Qwen3.6-35B";
const AI_TURNS: { said: string; hash: string }[] = [
  { said: "Follows owner: keep 150 reserve. No cities to build. Bail is false as no debt and fine not imminent.", hash: "5AGxB9L9QGoaHiULKwJbEcNRSgkM7DsV7ymTRtpbx6J7" },
  { said: "Reserve 150 cash covers worst rent 48 and fine. Do not build; buy Lisbon if landed on and cash allows.", hash: "HUcbjcN8zo55XDjwSpMym2eNmhjEX4xYMLWXJMnJ5r3x" },
  { said: "Reserve 150. Buy Milan or Sydney if affordable to boost rent. No buildings. Bail later if needed.", hash: "2af7dAbW4rBsDSKKhXAdyTXB35FrxcoXttPiE2swuXEc" },
];
const verifyUrl = (hash: string) => `${MAINNET_SITE}/verify?tx=${hash}&from=free.deedlords.near`;

/** What /verify checks for an AI move, in the order it shows them. */
const CHECKS: { label: string; means: string }[] = [
  { label: "The response hashes to what was signed", means: "The answer on chain is byte for byte the one the enclave signed." },
  { label: "The signature is the signer\u2019s", means: "It recovers the key that never leaves the enclave." },
  { label: "The response names the model", means: "The model the seat claims, not a stronger one swapped in, and not a person." },
  { label: "The plan played is the plan answered", means: "The move sent to the contract is the move in that answer." },
  { label: "NEAR AI attests the signer", means: "Its public report lists that key for that model, next to the Intel TDX and NVIDIA evidence." },
];

const NEXT: { what: string; how: string; status: string }[] = [
  {
    what: "Outside review",
    how: "The shuffle verifier and the poker contract audited by an outside team, then a bug bounty. Until then the board game takes no stake above 1 NEAR.",
    status: "Next",
  },
  { what: "Cash out to any chain", how: "Winnings sent from the table to USDC or ETH elsewhere through NEAR Intents. Today that runs from the account page.", status: "Planned" },
  { what: "Google and passkeys", how: "Sign-in through NEAR Auth on this domain. It is built and runs at the development address.", status: "Waiting" },
  { what: "Your table, your fee", how: "Whoever opens a table sets its fee, and the contract pays it to them.", status: "Planned" },
  { what: "An agent market", how: "Publish an agent, let others back its seat, split what it wins on chain, with a track record read from the chain.", status: "Planned" },
  { what: "Sealed agents", how: "The agent\u2019s own key inside the enclave, and proofs for poker bets as there are for board-game turns.", status: "Planned" },
  { what: "The deck as a library", how: "The dealerless deck (keys, shuffle proof, shares) packaged for any card game on NEAR.", status: "Planned" },
];
const short = (hash: string) => `${hash.slice(0, 6)}\u2026${hash.slice(-4)}`;

export default function LandingPage() {
  return (
    <div className={`lp ${alfaSlab.variable} ${beVietnam.variable}`} style={{ "--lp-paper": `url(${paper.src})`, "--lp-foil": `url(${goldFoil.src})` } as React.CSSProperties}>
      <TopBar />

      <main>
        <section className="lp-hall" aria-labelledby="lp-title">
          <div className="lp-hall__head">
            <h1 id="lp-title" className="lp-title">
              Deedlords Club
            </h1>
            <div>
              <p className="lp-line">No dealer. No server. No wallet pop-ups.</p>
              <p className="lp-copy">
                Table games for real stakes, fully on chain. NEAR contracts roll the dice, hold a deck nobody can read and pay the pot, and every move is a transaction anyone can
                open. Play free as a guest in seconds. Pick a gate.
              </p>
            </div>
          </div>

          <ul className="lp-gates" aria-label="The games of the club">
            <li className="lp-gate lp-gate--main">
              <Link className="lp-poster" href="/play" aria-label={`Deedlords, the board game: play on ${NET_NAME}`}>
                <Image
                  src={boardArt}
                  alt="A city board game: three pieces on bright squares, two dice in the air over a small modern city, a jet taking off"
                  priority
                  sizes="(min-width: 1100px) 42vw, 92vw"
                />
                <span className="lp-poster__gate">
                  Gate <b>A</b>
                </span>
                <i className="lp-status">Boarding</i>
                <h2>Deedlords</h2>
              </Link>
              <div className="lp-gate__stub">
                <p>The board game. Buy the world&rsquo;s priciest cities, collect rent, take the pot. The contract rolls the dice and pays the winner.</p>
                <dl>
                  <div>
                    <dt>Seats</dt>
                    <dd>2 to 4</dd>
                  </div>
                  <div>
                    <dt>Rounds</dt>
                    <dd>8 to 20, or to the end</dd>
                  </div>
                  <div>
                    <dt>A seat</dt>
                    <dd>free, or from 0.05</dd>
                  </div>
                </dl>
                <Link className="lp-go" href="/play">
                  Play Deedlords <Arrow size={22} />
                </Link>
              </div>
            </li>

            <li className="lp-gate">
              <Link className="lp-poster" href="/poker/tables" aria-label={`Poker: sit at a table on ${NET_NAME}`}>
                <Image
                  src={pokerArt}
                  alt="A heads-up poker table in an airport lounge at night: every card lies face down under a small padlock"
                  priority
                  sizes="(min-width: 1100px) 28vw, 92vw"
                />
                <span className="lp-poster__gate">
                  Gate <b>B</b>
                </span>
                <i className="lp-status">Boarding</i>
                <h2>Poker</h2>
              </Link>
              <div className="lp-gate__stub">
                <p>Texas Hold&rsquo;em for two to nine with no dealer. Every seat shuffles the deck under its own key and proves it to the contract.</p>
                <dl>
                  <div>
                    <dt>Seats</dt>
                    <dd>2 to 9</dd>
                  </div>
                  <div>
                    <dt>Shuffle</dt>
                    <dd>proved in ZK</dd>
                  </div>
                  <div>
                    <dt>A seat</dt>
                    <dd>free, or staked</dd>
                  </div>
                </dl>
                <Link className="lp-go" href="/poker/tables">
                  Sit at a table <Arrow size={22} />
                </Link>
              </div>
            </li>

            <li className="lp-gate">
              <Link className="lp-poster" href="/arena" aria-label="Arena: watch the trailer">
                <Image
                  src={arenaArt}
                  alt="The Arena's crews lined up in a stone yard at dusk, a boilerman in a horned helmet in front"
                  priority
                  sizes="(min-width: 1100px) 28vw, 92vw"
                />
                <span className="lp-poster__gate">
                  Gate <b>C</b>
                </span>
                <i className="lp-status" data-soon>
                  Trailer
                </i>
                <span className="lp-poster__play" aria-hidden="true">
                  <Play size={30} />
                </span>
                <h2>Arena</h2>
              </Link>
              <div className="lp-gate__stub">
                <p>An auto-battler of sealed bids: hire a crew from four guilds, place it, and watch a fight with no dice in it.</p>
                <dl>
                  <div>
                    <dt>Units</dt>
                    <dd>16</dd>
                  </div>
                  <div>
                    <dt>Guilds</dt>
                    <dd>4</dd>
                  </div>
                  <div>
                    <dt>Gate</dt>
                    <dd>not open yet</dd>
                  </div>
                </dl>
                <Link className="lp-watch" href="/arena">
                  <Play size={18} /> Watch the trailer
                </Link>
              </div>
            </li>
          </ul>
          <p className="lp-hall__note">
            {ON_MAINNET
              ? "Both open gates run on NEAR mainnet: stakes are real NEAR, brought in from any chain if you like."
              : "Both open gates run on NEAR testnet: every stake here is test NEAR and worth nothing."}{" "}
            {OTHER_NET.url && (
              <a href={OTHER_NET.url}>
                The same club on {OTHER_NET.name} <Arrow size={14} />
              </a>
            )}
          </p>
        </section>

        <section className="lp-departures" id="play" aria-labelledby="lp-departures">
          <h2 id="lp-departures">
            <Plane size={34} /> Departures <small>Deedlords · read live from the contract</small>
          </h2>
          <Departures />
        </section>

        <section className="lp-sec lp-chain" id="chain" aria-labelledby="lp-chain">
          <h2 id="lp-chain">Everything is public. Your cards are not.</h2>
          <p className="lp-lede">
            The club is fully on chain: the rules, the dice, the deck, the pot and the whole state of every game live in NEAR contracts. There is no game server to trust. Ask who
            does what, then open the chain and look.
          </p>
          <dl className="lp-trust">
            <div>
              <dt>Who rolls the dice?</dt>
              <dd>The contract, from the block&rsquo;s own random seed, inside the transaction that asked for the roll.</dd>
            </div>
            <div>
              <dt>Who shuffles the deck?</dt>
              <dd>
                Every seat, one after the other, each under a key nobody else holds. Each shuffle carries a zero-knowledge proof that it is the same 52 cards in another order, and
                the contract refuses a deck without one. Nobody ever holds the deck, so there is nobody to bribe, hack or trust.
              </dd>
            </div>
            <div>
              <dt>Who can see my cards?</dt>
              <dd>
                You. A card turns only when every seat has given its share of the key, each share proved to the contract. Your own share of your two cards stays in your browser
                until the showdown.
              </dd>
            </div>
            <div>
              <dt>Who holds the stakes?</dt>
              <dd>The contract. While a game is in play only its rules move them, and the move that ends the game pays the pot.</dd>
            </div>
            <div>
              <dt>What if a player walks away?</dt>
              <dd>
                Every step has a clock. When it runs out anybody at the table may ask the contract to move on: a turn is played and ended, a poker hand is folded. No game is left
                hanging with money in it.
              </dd>
            </div>
            <div>
              <dt>What can the developer still do?</dt>
              <dd>
                Replace a contract&rsquo;s code: the contract accounts&rsquo; keys still exist, so a bug can be fixed, and so could anything else. The proofs have had no outside
                review yet. We say so here rather than hide it.
              </dd>
            </div>
          </dl>

          <div className="lp-ledger lp-ledger--receipts">
            <h3>
              <Chain size={22} /> Four receipts from NEAR mainnet
            </h3>
            <ol>
              {RECEIPTS.map((row) => (
                <li key={row.hash}>
                  <a href={`${NEARBLOCKS}/txns/${row.hash}`} target="_blank" rel="noreferrer">
                    <span className="lp-ledger__what">{row.what}</span>
                    <span className="lp-ledger__cost">{row.cost}</span>
                    <code>
                      {short(row.hash)} <Out />
                    </code>
                  </a>
                </li>
              ))}
            </ol>
            <p>
              Real transactions, with the gas each burned. The contracts are{" "}
              <a href={`${NEARBLOCKS}/address/${GAME}`} target="_blank" rel="noreferrer">
                {GAME}
              </a>{" "}
              and{" "}
              <a href={`${NEARBLOCKS}/address/${POKER}`} target="_blank" rel="noreferrer">
                {POKER}
              </a>
              .
            </p>
          </div>
        </section>

        <section className="lp-sec lp-how" id="how" aria-labelledby="lp-how">
          <h2 id="lp-how">One confirmation to stake. None to move.</h2>
          <p className="lp-lede">
            A move lands in about two seconds and costs about 0.0004 {COIN}. You approve your stake once; after that a key that can only call the game signs your moves, so no
            wallet opens again. At a free table you pay nothing at all: you sign, the club pays the gas.
          </p>
          <ol className="lp-pass">
            <li>
              <Image src={checkinArt} alt="" sizes="96px" />
              <h3>Check in</h3>
              <p>Sign in as a guest, with one signature of an EVM wallet, or with a NEAR wallet. You get a game account that signs for you from then on.</p>
            </li>
            <li>
              <Image src={openArt} alt="" sizes="110px" />
              <h3>Board</h3>
              <p>Take a seat at a free table for nothing, or stake one from 0.05 {COIN}. The room fills, then its host starts the game.</p>
            </li>
            <li>
              <Image src={suezArt} alt="" sizes="190px" />
              <h3>Fly</h3>
              <p>Roll, buy cities, build, collect rent. Idle for five seconds and the dice roll themselves; walk away and the contract still ends your turn.</p>
            </li>
            <li>
              <Image src={paidArt} alt="" sizes="110px" />
              <h3>Land</h3>
              <p>After the last round the contract ranks the seats by net worth and pays the pot in that same transaction.</p>
            </li>
          </ol>
        </section>

        <section className="lp-sec lp-agents" id="agents" aria-labelledby="lp-agents">
          <h2 id="lp-agents">
            An AI you can audit.
            <br />A strategy nobody can read.
          </h2>
          <p className="lp-lede">
            An AI agent is a NEAR account that calls the same contract you do. When its model runs inside a hardware enclave at NEAR AI Cloud, the enclave signs every answer and
            the signature goes on chain with the move. Anyone can check which model played. What its owner told it stays sealed: only a hash of it is published.
          </p>
          <div className="lp-agent">
            <figure className="lp-agent__seat">
              <Image src={faceArt} alt="" sizes="160px" />
              <figcaption>
                <b>AI · {AI_MODEL}</b>
                <span>seat 4 of {AI_MATCH}</span>
              </figcaption>
            </figure>
            <ul className="lp-agent__notes" aria-label="What the agent said for three of its turns on mainnet, in order">
              {AI_TURNS.map((turn) => (
                <li key={turn.hash}>
                  &ldquo;{turn.said}&rdquo;{" "}
                  <a href={verifyUrl(turn.hash)}>
                    Verify <Arrow size={15} />
                  </a>
                </li>
              ))}
            </ul>
          </div>

          <div className="lp-ledger lp-proof">
            <h3>
              <Tick size={24} /> Five checks, run in your own browser
            </h3>
            <ol className="lp-ticks">
              {CHECKS.map((check) => (
                <li key={check.label}>
                  <Tick size={20} />
                  <b>{check.label}</b>
                  <span>{check.means}</span>
                </li>
              ))}
            </ol>
            <p>
              Nothing is taken from this site&rsquo;s server: the page reads the transaction from a NEAR node and the report from NEAR AI.{" "}
              <a href={verifyUrl(AI_TURNS[2].hash)}>Check a real move yourself</a>.
            </p>
          </div>

          <div className="lp-plan">
            <div>
              <h3>A strategy is a plan, written before the dice</h3>
              <p>
                An agent does not click. It hands the contract one plan and a single transaction plays its whole turn: the roll, the purchase, the houses, the end. A plan holds
                thresholds, not moves, so it cannot depend on dice it has not seen.
              </p>
              <p>
                Bring your own NEAR AI key and your browser asks the enclave directly: your instructions and, at poker, your hole cards go there and nowhere else. If a model is
                late, a rule bot plays the turn and the seat says so. Hand your seat over with <b>Let AI play</b> and take it back whenever you like.
              </p>
            </div>
            <pre className="lp-plan__code" aria-label="The plan and the proof of the third turn above, as its transaction carries them (the long values cut short)">
              <code>{`turn("${AI_MATCH}", 3, {
  // cash to keep when buying
  buy_reserve: 985,
  // cities to build on, best first
  build: [],
  // cash to keep when building
  keep_reserve: 150,
  // pay to leave Customs?
  bail: false,
  // what to sell first in debt
  liquidate: []
}, {
  // the proof: the contract ignores it,
  // the chain keeps it
  model: "Qwen/Qwen3.6-35B-A3B-FP8",
  kind: "provider_tee",
  signer: "0xfdbd79…8ddf",
  req: "94a67cd0…05fe", // a hash only
  res: "{ the model's answer }",
  sig: "0x…"
})`}</code>
            </pre>
          </div>
        </section>

        <section className="lp-sec lp-back" id="back" aria-labelledby="lp-back">
          <div className="lp-back__copy">
            <h2 id="lp-back">Back a seat. Let an agent fly it.</h2>
            <p className="lp-lede">
              In the contract every seat has a backer, who stakes it and is paid, and may have a driver, who moves for it. Stake a seat, name an agent as its driver, and what the
              seat wins comes to you.
            </p>
            <p>
              What a seat returns is plain arithmetic in the contract, not a promise from us. Set the stake, then set how often you think your agent wins: the table does the rest.
            </p>
            <p className="lp-coming">
              <b>Coming</b> A button at the table to name any agent as your seat&rsquo;s driver, and a public track record for each agent: matches, wins and return, read from the
              chain. Today you can hand your own seat to the built-in agent, and there are only the matches themselves to judge it by.
            </p>
          </div>
          <FareTable />
        </section>

        <section className="lp-sec lp-boarding" aria-labelledby="lp-boarding">
          <h2 id="lp-boarding">Board with nothing in your pocket</h2>
          <p className="lp-lede">The club runs on NEAR. You do not have to hold any to sit down, and you do not have to start there.</p>
          <ul className="lp-gate-list">
            <li>
              <b>Guest</b>
              <span>One tap. A NEAR account whose key stays in your browser, playing free tables at both games with no NEAR at all: the club pays the gas.</span>
              <i className="lp-status">Open</i>
            </li>
            <li>
              <b>EVM wallet</b>
              <span>MetaMask, Rabby, Coinbase Wallet. One signature gives you the same NEAR game account on every device.</span>
              <i className="lp-status">Open</i>
            </li>
            <li>
              <b>NEAR wallet</b>
              <span>Meteor, Intear, Nightly and others through NEAR Connect. The wallet approves each stake, never each move.</span>
              <i className="lp-status">Open</i>
            </li>
            <li>
              <b>Short of NEAR at the table</b>
              <span>
                Pay the difference from your wallet in USDC or ETH on Base, Arbitrum or Ethereum: NEAR Intents delivers exactly the missing NEAR to your seat. The account page also
                takes SOL and BTC, and sends NEAR back out. Mainnet only: on testnet it shows the price.
              </span>
              <i className="lp-status" data-live>
                {ON_MAINNET ? "Live" : "Mainnet"}
              </i>
            </li>
            <li>
              <b>Google account</b>
              <span>
                Through NEAR Auth: no wallet and no seed phrase. Built and working at the development address; on this site it waits for NEAR Auth to approve the club&rsquo;s own
                sign-in.
              </span>
              <i className="lp-status" data-soon>
                Preview
              </i>
            </li>
            <li>
              <b>{ON_MAINNET ? "Testnet" : "Mainnet"}</b>
              <span>
                {ON_MAINNET
                  ? "The same club with test NEAR: free tables, AI seats at poker for test stakes, nothing to lose."
                  : "Real NEAR in the pot, the same contracts, no fee for now."}{" "}
                {OTHER_NET.url && <a href={OTHER_NET.url}>Open it</a>}
              </span>
              {OTHER_NET.url ? (
                <i className="lp-status" data-live>
                  Live
                </i>
              ) : (
                <i className="lp-status" data-soon>
                  Coming
                </i>
              )}
            </li>
          </ul>
        </section>

        <section className="lp-sec lp-cast" id="character" aria-labelledby="lp-cast">
          <h2 id="lp-cast">One traveller, every table</h2>
          <p className="lp-lede">
            Make a character once: a name and a look. It is your membership: its face sits at every table of the club. The character and each piece it wears are NFTs you hold, and
            the first mint is free.
          </p>
          <div className="lp-cast__stage">
            <Cast />
          </div>
          <ul className="lp-cast__ways">
            <li>
              <b>Character</b>
              <span>Pick a name, a face, a haircut, an outfit. Minted to your account for free.</span>
              <Link href="/character">
                Make yours <Arrow size={18} />
              </Link>
            </li>
            <li>
              <b>Shop and bag</b>
              <span>Basic pieces are free to mint. Rare, Epic and Legendary ones only come out of boxes, paid in NEAR and rolled by the contract.</span>
              <Link href="/shop">
                Open the shop <Arrow size={18} />
              </Link>
            </li>
            <li>
              <b>Agents</b>
              <span>Name an AI agent, pick its model, and tell it how to play in your own words. What you tell it stays yours.</span>
              <Link href="/agents">
                Brief an agent <Arrow size={18} />
              </Link>
            </li>
          </ul>
        </section>

        <section className="lp-sec lp-judges" id="check" aria-labelledby="lp-judges">
          <h2 id="lp-judges">
            Judging this?
            <br />
            Three checks, three minutes.
          </h2>
          <p className="lp-lede">Do not take this page&rsquo;s word for any of it. Each of these ends on the chain, not on our server.</p>
          <ul className="lp-cast__ways">
            <li>
              <b>Play without a wallet</b>
              <span>Play as a guest against the AI, then open Transactions at the table: every move is a call on the game contract, signed by you and paid by the club.</span>
              <Link href="/play">
                Play a free game <Arrow size={18} />
              </Link>
            </li>
            <li>
              <b>Audit an AI move</b>
              <span>A real turn on mainnet by a model in an enclave. Five ticks, computed in your browser from the transaction alone.</span>
              <a href={verifyUrl(AI_TURNS[2].hash)}>
                Open the proof <Arrow size={18} />
              </a>
            </li>
            <li>
              <b>Open the dealerless deck</b>
              <span>A real shuffle on mainnet: 52 cards and their proof in one transaction, checked and accepted by the contract.</span>
              <a href={`${NEARBLOCKS}/txns/${RECEIPTS[0].hash}`} target="_blank" rel="noreferrer">
                Open the transaction <Arrow size={18} />
              </a>
            </li>
          </ul>
          <p className="lp-judges__cli">
            Prefer a terminal? <code>npm ci &amp;&amp; npm run check:live</code> reads mainnet and runs sixteen checks without a key.{" "}
            <a href={REPO} target="_blank" rel="noreferrer">
              The repository
            </a>
          </p>
        </section>

        <section className="lp-sec lp-next" id="next" aria-labelledby="lp-next">
          <h2 id="lp-next">Next departures</h2>
          <p className="lp-lede">What is not here yet, in the order we mean to build it.</p>
          <ul className="lp-gate-list">
            {NEXT.map((item) => (
              <li key={item.what}>
                <b>{item.what}</b>
                <span>{item.how}</span>
                <i className="lp-status" data-soon>
                  {item.status}
                </i>
              </li>
            ))}
          </ul>
        </section>

        <section className="lp-close" aria-labelledby="lp-close">
          <div className="lp-close__stub">
            <h2 id="lp-close">Your seat is open</h2>
            <p>{ON_MAINNET ? "A guest account and a little NEAR, from any chain, are all it takes." : "A guest account and a little test NEAR are all it takes."}</p>
          </div>
          <div className="lp-close__stub lp-close__stub--go">
            <p className="lp-stub__flight">
              <Plane size={22} /> <b>Your flight</b> · {NET_NAME}
            </p>
            <Link className="lp-go" href="/play">
              Play on {CHAIN.network} <Arrow size={22} />
            </Link>
          </div>
        </section>
      </main>

      <footer className="lp-foot">
        <p>
          <span className="lp-wordmark">Deedlords Club</span> Original games, fully on chain, refereed by NEAR contracts. Built for NEAR HACKATHON 2026.
        </p>
        <p>
          Contract{" "}
          <a href={`${CHAIN.explorerUrl ?? "https://testnet.nearblocks.io"}/address/${CHAIN.contractId}`} target="_blank" rel="noreferrer">
            {CHAIN.contractId}
          </a>{" "}
          · {NET_NAME} · stakes are {COIN} ·{" "}
          <a href={REPO} target="_blank" rel="noreferrer">
            Source
          </a>
        </p>
      </footer>
    </div>
  );
}
