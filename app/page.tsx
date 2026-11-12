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
import { Arrow, Chain, Out, Plane, Play } from "@/components/landing/icons";
import { COIN, NET_NAME, ON_MAINNET, OTHER_NET } from "@/components/landing/net";
import { TopBar } from "@/components/landing/TopBar";
import { CHAIN } from "@/lib/chain/config";
import { alfaSlab, beVietnam } from "@/lib/fonts";
import "./landing.css";

export const metadata: Metadata = {
  title: "Deedlords Club: the contract is the referee",
  description: "A club of games on NEAR: Deedlords, a property board game, and poker, with one account and one character at every table. Rules, dice, deck and stakes live in smart contracts, and every move is a transaction anyone can open.",
};

export const viewport: Viewport = { themeColor: "#5d100a", viewportFit: "cover" };

// The match below was played on testnet, whichever network this deployment plays on.
const EXPLORER = "https://testnet.nearblocks.io/txns/";
const CONTRACT = "game.deedlords.testnet";

// One real match, settled on NEAR testnet on 10 November 2026 (UTC): its eight transactions, in order.
const MATCH = "m-mwb586zg-xrxn";
const LEDGER: { time: string; who: string; what: string; hash: string }[] = [
  { time: "20:29:14", who: "Seat 1", what: "Open the match · stake 0.05 NEAR and take seat 1", hash: "7H8HeV3EM6rrrGeTQuVLsnMxLKc5Jd5mVzTUPVTWUK34" },
  { time: "20:29:29", who: "Seat 2", what: "Stake 0.05 NEAR and take seat 2 (played by an AI agent)", hash: "FSFqGbjj51j6n1L3DgZ5BES32kmG6aGXsckfSbcum3GX" },
  { time: "20:29:36", who: "Seat 2", what: "Roll 1+3, pay tax 200 · End turn", hash: "6Mr3EMXG3xnVojormZPa4TdmPyxEqWxjhYJmCMGu3vWL" },
  { time: "20:29:58", who: "Seat 1", what: "Roll 4+5 · Buy Lisbon · End turn", hash: "5YpvtkYp3UzQgegjQkdjJZRNjWorFg3ndQxyqqKqPQsD" },
  { time: "20:30:04", who: "Seat 2", what: "Roll 6+2 · Buy Power Grid · End turn", hash: "CnWof8sGwdKmAd7fMHL7zTaBEYGEPi2ZoeDZESXs5H59" },
  { time: "20:30:09", who: "Seat 1", what: "Roll 3+3 · Buy Suez Canal · Roll 1+5 · Buy Vienna · End turn", hash: "CRKDK8PULen52MJUKxYH3fDbTDwzzTVVrXmdq9erYhmA" },
  { time: "20:30:13", who: "Seat 2", what: "Roll 3+4 · Buy Sydney · End turn", hash: "McT4mxCXf7WTrAPcFEDfqVoc4ejNYAVXuop6MpfWkb5" },
  { time: "20:30:18", who: "Seat 1", what: "Roll 3+2 · Buy Los Angeles · End turn. Last round: the contract ranks both seats and pays 0.06825 and 0.02925 NEAR", hash: "CNXBuLKLFq1PMusu6Wv48GKtSoMpabvLmqtKqoCUwnHd" },
];
const short = (hash: string) => `${hash.slice(0, 6)}…${hash.slice(-4)}`;

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
              <p className="lp-line">No game server. The contract is the referee.</p>
              <p className="lp-copy">
                One account and one character at every table. The rules, the dice, the deck and the stakes live in NEAR contracts: every move is a transaction anyone can open. Pick a gate.
              </p>
            </div>
          </div>

          <ul className="lp-gates" aria-label="The games of the club">
            <li className="lp-gate lp-gate--main">
              <Link className="lp-poster" href="/play" aria-label={`Deedlords, the board game: play on ${NET_NAME}`}>
                <Image src={boardArt} alt="A city board game: three pieces on bright squares, two dice in the air over a small modern city, a jet taking off" priority sizes="(min-width: 1100px) 42vw, 92vw" />
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
                    <dd>3 to 12, or to the end</dd>
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
                <Image src={pokerArt} alt="A heads-up poker table in an airport lounge at night: every card lies face down under a small padlock" priority sizes="(min-width: 1100px) 28vw, 92vw" />
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
                    <dd>from 0.1</dd>
                  </div>
                </dl>
                <Link className="lp-go" href="/poker/tables">
                  Sit at a table <Arrow size={22} />
                </Link>
              </div>
            </li>

            <li className="lp-gate">
              <Link className="lp-poster" href="/arena" aria-label="Arena: watch the trailer">
                <Image src={arenaArt} alt="The Arena's crews lined up in a stone yard at dusk, a boilerman in a horned helmet in front" priority sizes="(min-width: 1100px) 28vw, 92vw" />
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

        <section className="lp-sec lp-cast" id="character" aria-labelledby="lp-cast">
          <h2 id="lp-cast">One traveller, every table</h2>
          <p className="lp-lede">
            Make a character once: a name and a look. It is your membership: its face sits at every table of the club. The character and each piece it wears are NFTs you hold, and the first mint is free.
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

        <section className="lp-sec lp-how" id="how" aria-labelledby="lp-how">
          <h2 id="lp-how">One confirmation to stake. None to move.</h2>
          <p className="lp-lede">A match of Deedlords is yours to size: two to four seats, three rounds or to the last seat standing, half a minute a turn. This is all of it.</p>
          <ol className="lp-pass">
            <li>
              <Image src={checkinArt} alt="" sizes="96px" />
              <h3>Check in</h3>
              <p>Sign in as a guest, with one signature of an EVM wallet, or with a NEAR wallet. You get a game account that signs for you from then on.</p>
            </li>
            <li>
              <Image src={openArt} alt="" sizes="110px" />
              <h3>Board</h3>
              <p>Stake your seat, from 0.05 {COIN}, or take one at a free table. The room fills, then its host starts the game.</p>
            </li>
            <li>
              <Image src={suezArt} alt="" sizes="190px" />
              <h3>Fly</h3>
              <p>Roll, buy cities, build, collect rent. A move shows its result in about two seconds and never opens a wallet.</p>
            </li>
            <li>
              <Image src={paidArt} alt="" sizes="110px" />
              <h3>Land</h3>
              <p>After the last round the contract ranks the seats by net worth and pays the pot in that same transaction.</p>
            </li>
          </ol>
        </section>

        <section className="lp-sec lp-chain" id="chain" aria-labelledby="lp-chain">
          <h2 id="lp-chain">Every move is a transaction</h2>
          <p className="lp-lede">There is nothing to take on trust here. Ask who does what, then open the chain and look.</p>
          <dl className="lp-trust">
            <div>
              <dt>Who rolls the dice?</dt>
              <dd>The contract, from the block&rsquo;s own random seed, inside the transaction that asked for the roll.</dd>
            </div>
            <div>
              <dt>Who shuffles the deck?</dt>
              <dd>At the poker table, every seat, one after the other, each under a key nobody else sees. Each shuffle comes with a zero-knowledge proof the contract checks before a card is dealt.</dd>
            </div>
            <div>
              <dt>Who holds the stakes?</dt>
              <dd>The contract. While a match is in play, only its rules move them.</dd>
            </div>
            <div>
              <dt>Who names the winner?</dt>
              <dd>The contract. On the board: net worth after the last round, a duel paid out 70 and 30. There is no fee for now: the owner may set one, at most 5%, and a match keeps the fee it was opened with. At poker: the best hand shown, or the last player who has not folded.</dd>
            </div>
            <div>
              <dt>What if a player walks away?</dt>
              <dd>After half a minute anybody at the table may ask the contract to move for them: it throws their dice and ends their turn. The match always ends.</dd>
            </div>
            <div>
              <dt>What can the developer still do?</dt>
              <dd>Replace a contract&rsquo;s code: the contract accounts&rsquo; keys still exist, so a bug can be fixed, and so could anything else. The poker proofs have had no outside review yet. We say so here rather than hide it.</dd>
            </div>
          </dl>

          <div className="lp-ledger">
            <h3>
              <Chain size={22} /> One whole match of Deedlords: {MATCH}
            </h3>
            <ol>
              {LEDGER.map((row) => (
                <li key={row.hash}>
                  <a href={`${EXPLORER}${row.hash}`} target="_blank" rel="noreferrer">
                    <time>{row.time}</time>
                    <span className="lp-ledger__who">{row.who}</span>
                    <span className="lp-ledger__what">{row.what}</span>
                    <code>
                      {short(row.hash)} <Out />
                    </code>
                  </a>
                </li>
              ))}
            </ol>
            <p>
              Eight transactions, 64 seconds, 0.1 NEAR in the pot. The contract is{" "}
              <a href={`https://testnet.nearblocks.io/address/${CONTRACT}`} target="_blank" rel="noreferrer">
                {CONTRACT}
              </a>
              .
            </p>
          </div>
        </section>

        <section className="lp-sec lp-agents" id="agents" aria-labelledby="lp-agents">
          <h2 id="lp-agents">An agent is just another player</h2>
          <p className="lp-lede">
            An AI agent is a NEAR account that calls the same contract you do. It cannot see the dice before they are rolled, and it wins or loses its seat&rsquo;s stake like anybody else.
          </p>
          <div className="lp-agent">
            <figure className="lp-agent__seat">
              <Image src={faceArt} alt="" sizes="160px" />
              <figcaption>
                <b>AI · gpt-4.1-mini</b>
                <span>seat 2 of {MATCH}</span>
              </figcaption>
            </figure>
            <ul className="lp-agent__notes" aria-label="What the agent said for its three turns, in order">
              <li>&ldquo;Buy cheap free squares only if at least 200 cash remains to afford future opportunities and avoid debt risk.&rdquo;</li>
              <li>&ldquo;Buy cheap free squares if cash stays above 100, no houses to build yet with no holdings.&rdquo;</li>
              <li>&ldquo;Keep 400 cash reserve to afford potential rent; don&rsquo;t buy expensive free squares this turn; no building.&rdquo;</li>
            </ul>
          </div>

          <div className="lp-plan">
            <div>
              <h3>A strategy is a plan, written before the dice</h3>
              <p>
                An agent does not click. It hands the contract one plan and a single transaction plays its whole turn: the roll, the purchase, the houses, the end. A plan holds thresholds, not moves, so it cannot depend on dice it has not seen.
              </p>
              <p>
                The model gets four seconds. If it is late or answers nonsense, a rule bot plays the turn and the seat says so. Hand your own seat to the agent mid-game with <b>Let AI play</b>, and take it back whenever you like: same key, no new approval.
              </p>
            </div>
            <pre className="lp-plan__code" aria-label="A plan, as an agent sends it (example values)">
              <code>{`// example values
turn(match, seat, {
  // cash to keep when buying
  buy_reserve: 300,
  // cities to build on, best first
  build: [],
  // cash to keep when building
  keep_reserve: 0,
  // pay to leave Customs?
  bail: false,
  // what to sell first in debt
  liquidate: []
})`}</code>
            </pre>
          </div>
        </section>

        <section className="lp-sec lp-back" id="back" aria-labelledby="lp-back">
          <div className="lp-back__copy">
            <h2 id="lp-back">Back a seat. Let an agent fly it.</h2>
            <p className="lp-lede">
              In the contract every seat has a backer, who stakes it and is paid, and may have a driver, who moves for it. Stake a seat, name an agent as its driver, and what the seat wins comes to you.
            </p>
            <p>
              What a seat returns is plain arithmetic in the contract, not a promise from us. Set the stake, then set how often you think your agent wins: the table does the rest.
            </p>
            <p className="lp-coming">
              <b>Coming</b> A button at the table to name any agent as your seat&rsquo;s driver, and a public track record for each agent: matches, wins and return, read from the chain. Today you can hand your own seat to the built-in agent, and there are only the matches themselves to judge it by.
            </p>
          </div>
          <FareTable />
        </section>

        <section className="lp-sec lp-gates" aria-labelledby="lp-gates">
          <h2 id="lp-gates">Board from the wallet you already have</h2>
          <p className="lp-lede">The club runs on NEAR. You do not have to start there.</p>
          <ul className="lp-gate-list">
            <li>
              <b>Google account</b>
              <span>Through NEAR Auth: no wallet and no seed phrase. A testnet preview that answers on the development address only, for now.</span>
              <i className="lp-status" data-live>
                Preview
              </i>
            </li>
            <li>
              <b>EVM wallet</b>
              <span>MetaMask, Rabby, Coinbase Wallet. One signature gives you the same game account on every device.</span>
              <i className="lp-status" data-live>
                Beta
              </i>
            </li>
            <li>
              <b>Guest</b>
              <span>A game account whose key stays in your browser. At a free table it needs no NEAR at all: the house pays the gas.</span>
              <i className="lp-status">Open</i>
            </li>
            <li>
              <b>NEAR wallet</b>
              <span>Meteor, Intear, Nightly and others through NEAR Connect. The wallet approves each stake.</span>
              <i className="lp-status" data-live>
                Beta
              </i>
            </li>
            <li>
              <b>Stake from another chain</b>
              <span>
                Bring NEAR in from USDC, ETH, SOL or BTC on their own chains, and take it back out the same way, through NEAR Intents&rsquo; 1Click. Mainnet only: on testnet it
                shows the price.
              </span>
              <i className="lp-status" data-live>
                {ON_MAINNET ? "Live" : "Mainnet"}
              </i>
            </li>
            <li>
              <b>{ON_MAINNET ? "Testnet" : "Mainnet"}</b>
              <span>
                {ON_MAINNET
                  ? "The same club with test NEAR: free tables, Google sign-in, nothing to lose."
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
          <span className="lp-wordmark">Deedlords Club</span> Original games refereed by NEAR contracts, built for NEAR HACKATHON 2026, games track.
        </p>
        <p>
          Contract{" "}
          <a href={`${CHAIN.explorerUrl ?? "https://testnet.nearblocks.io"}/address/${CHAIN.contractId}`} target="_blank" rel="noreferrer">
            {CHAIN.contractId}
          </a>{" "}
          · {NET_NAME} · stakes are {COIN}
        </p>
      </footer>
    </div>
  );
}
