import type { Metadata, Viewport } from "next";
import Image from "next/image";
import Link from "next/link";
import checkinArt from "@/assets/plates/checkin-art.png";
import goldFoil from "@/assets/plates/gold-foil.webp";
import heroBoardFull from "@/assets/plates/hero-board-full.png";
import heroBoard from "@/assets/plates/hero-board.png";
import paper from "@/assets/plates/strip-paper.png";
import faceArt from "@/assets/plates/stub-ai-face.png";
import openArt from "@/assets/plates/stub-open-art.png";
import paidArt from "@/assets/plates/stub-paid-art.png";
import powerArt from "@/assets/plates/stub-power-art.png";
import suezArt from "@/assets/plates/stub-suez-art.png";
import { Departures } from "@/components/landing/Departures";
import { FareTable } from "@/components/landing/FareTable";
import { Arrow, Chain, Clock, Out, Plane } from "@/components/landing/icons";
import { alfaSlab, beVietnam } from "@/lib/fonts";
import "./landing.css";

export const metadata: Metadata = {
  title: "Deedlords: the contract is the referee",
  description: "A property board game whose rules, dice and stakes live in a NEAR contract. Every move is a transaction anyone can open.",
};

export const viewport: Viewport = { themeColor: "#5d100a", viewportFit: "cover" };

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
      <header className="lp-nav">
        <Link className="lp-wordmark" href="/" aria-label="Deedlords, home">
          Deedlords
        </Link>
        <nav aria-label="Sections">
          <Link href="/play">Play</Link>
          <a href="#how">How it works</a>
          <a href="#chain">On chain</a>
          <a href="#agents">Agents</a>
        </nav>
        <p className="lp-chip">
          <Chain size={20} /> NEAR testnet · mainnet coming
        </p>
      </header>

      <main>
        <section className="lp-first" aria-labelledby="lp-title">
          <h1 id="lp-title" className="lp-title">
            Deedlords
          </h1>
          <p className="lp-line">No game server. The contract is the referee.</p>
          <p className="lp-copy">Buy the world&rsquo;s priciest cities, collect rent, take the pot. The rules, the dice and the stakes live in a smart contract, so there is no game server and every move is a transaction anyone can open.</p>
          <Image className="lp-board" src={heroBoard} alt="The Deedlords board: a ring of forty squares around a small city" priority sizes="33vw" />
          <Image className="lp-board-small" src={heroBoardFull} alt="" sizes="(min-width: 1100px) 1px, 90vw" loading="eager" />

          <ol className="lp-strip" aria-label="One real match on NEAR testnet, as its transactions">
            <li className="lp-stub lp-stub--you">
              <p className="lp-stub__flight">
                <Plane size={22} /> <b>Your flight</b> · NEAR testnet
              </p>
              <Link className="lp-go" href="/play">
                Play on testnet <Arrow size={22} />
              </Link>
            </li>
            <li className="lp-stub lp-stub--open">
              <a href={`${EXPLORER}7H8HeV3EM6rrrGeTQuVLsnMxLKc5Jd5mVzTUPVTWUK34`} target="_blank" rel="noreferrer">
                <p className="lp-stub__text">
                  <span className="lp-time">
                    <Clock /> 20:29
                  </span>
                  <b>Open the match</b>
                  <span>stake 0.05 NEAR</span>
                  <span>seat 1 of 2</span>
                </p>
                <Image className="lp-art" src={openArt} alt="" sizes="140px" />
                <code className="lp-code">tx 7H8HeV…</code>
              </a>
            </li>
            <li className="lp-stub lp-stub--ai">
              <a href={`${EXPLORER}FSFqGbjj51j6n1L3DgZ5BES32kmG6aGXsckfSbcum3GX`} target="_blank" rel="noreferrer">
                <p className="lp-stub__text">
                  <span className="lp-time">
                    <Clock /> 20:29
                  </span>
                  <b>Seat 2 taken by an AI</b>
                </p>
                <Image className="lp-art" src={faceArt} alt="" sizes="120px" />
                <code className="lp-code">tx FSFqGb…</code>
              </a>
            </li>
            <li className="lp-stub lp-stub--suez">
              <a href={`${EXPLORER}CRKDK8PULen52MJUKxYH3fDbTDwzzTVVrXmdq9erYhmA`} target="_blank" rel="noreferrer">
                <p className="lp-stub__text">
                  <span className="lp-time">
                    <Clock /> 20:30
                  </span>
                  <b>Roll 3+3</b>
                  <span>Buy Suez Canal</span>
                  <span>Roll 1+5</span>
                  <span>Buy Vienna</span>
                </p>
                <Image className="lp-art" src={suezArt} alt="" sizes="240px" />
                <code className="lp-code">tx CRKDK8…YhmA</code>
              </a>
            </li>
            <li className="lp-stub lp-stub--power">
              <a href={`${EXPLORER}CnWof8sGwdKmAd7fMHL7zTaBEYGEPi2ZoeDZESXs5H59`} target="_blank" rel="noreferrer">
                <p className="lp-stub__text">
                  <span className="lp-time">
                    <Clock /> 20:30
                  </span>
                  <b>Roll 6+2</b>
                  <span>Buy Power Grid</span>
                </p>
                <Image className="lp-art" src={powerArt} alt="" sizes="150px" />
                <code className="lp-code">tx CnWof8…5H59</code>
              </a>
            </li>
            <li className="lp-stub lp-stub--paid">
              <a href={`${EXPLORER}CNXBuLKLFq1PMusu6Wv48GKtSoMpabvLmqtKqoCUwnHd`} target="_blank" rel="noreferrer">
              <p className="lp-stub__text">
                <span className="lp-time">
                  <Clock /> 20:30
                </span>
                <b>Paid out</b>
                <strong>0.06825 NEAR</strong>
                <span>by the contract</span>
              </p>
              <Image className="lp-art" src={paidArt} alt="" sizes="140px" />
              </a>
            </li>
          </ol>
          <p className="lp-strip-note">
            Match {MATCH}, played on NEAR testnet on 10 November 2026 (times in UTC). Every stub opens its transaction.
          </p>
        </section>

        <section className="lp-departures" id="play" aria-labelledby="lp-departures">
          <h2 id="lp-departures">
            <Plane size={34} /> Departures
          </h2>
          <Departures />
        </section>

        <section className="lp-sec lp-how" id="how" aria-labelledby="lp-how">
          <h2 id="lp-how">One confirmation to stake. None to move.</h2>
          <p className="lp-lede">A match is short: two seats, three to twelve rounds, a minute a turn. This is all of it.</p>
          <ol className="lp-pass">
            <li>
              <Image src={checkinArt} alt="" sizes="96px" />
              <h3>Check in</h3>
              <p>Sign in as a guest, with one signature of an EVM wallet, or with a NEAR wallet. You get a game account that signs for you from then on.</p>
            </li>
            <li>
              <Image src={openArt} alt="" sizes="110px" />
              <h3>Board</h3>
              <p>Stake your seat, from 0.05 test NEAR. The game starts by itself when the last seat is taken.</p>
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
              <dt>Who holds the stakes?</dt>
              <dd>The contract. While a match is in play, only its rules move them.</dd>
            </div>
            <div>
              <dt>Who names the winner?</dt>
              <dd>The contract: net worth after the last round, paid out 70 and 30 after a 2.5% fee.</dd>
            </div>
            <div>
              <dt>What if a player walks away?</dt>
              <dd>After a minute anybody may ask the contract to move for them. The match always ends.</dd>
            </div>
            <div>
              <dt>What can the developer still do?</dt>
              <dd>Replace the contract&rsquo;s code: this is a testnet build and its account key still exists. We say so here rather than hide it.</dd>
            </div>
          </dl>

          <div className="lp-ledger">
            <h3>
              <Chain size={22} /> The whole of match {MATCH}
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
          <p className="lp-lede">Deedlords runs on NEAR. You do not have to start there.</p>
          <ul className="lp-gate-list">
            <li>
              <b>EVM wallet</b>
              <span>MetaMask, Rabby, Coinbase Wallet. One signature gives you the same game account on every device.</span>
              <i className="lp-status" data-live>
                Beta
              </i>
            </li>
            <li>
              <b>Guest</b>
              <span>A game account whose key stays in your browser. The quickest way to try a match.</span>
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
              <span>Pay your stake in the token you hold on another chain and be paid back there, through NEAR Intents.</span>
              <i className="lp-status" data-soon>
                Coming
              </i>
            </li>
            <li>
              <b>Mainnet</b>
              <span>Real NEAR in the pot. Until then every stake on this page is test NEAR and worth nothing.</span>
              <i className="lp-status" data-soon>
                Coming
              </i>
            </li>
          </ul>
        </section>

        <section className="lp-close" aria-labelledby="lp-close">
          <div className="lp-close__stub">
            <h2 id="lp-close">Your seat is open</h2>
            <p>A guest account and a little test NEAR are all it takes.</p>
          </div>
          <div className="lp-close__stub lp-close__stub--go">
            <p className="lp-stub__flight">
              <Plane size={22} /> <b>Your flight</b> · NEAR testnet
            </p>
            <Link className="lp-go" href="/play">
              Play on testnet <Arrow size={22} />
            </Link>
          </div>
        </section>
      </main>

      <footer className="lp-foot">
        <p>
          <span className="lp-wordmark">Deedlords</span> An original property game, built for NEAR HACKATHON 2026, games track.
        </p>
        <p>
          Contract{" "}
          <a href={`https://testnet.nearblocks.io/address/${CONTRACT}`} target="_blank" rel="noreferrer">
            {CONTRACT}
          </a>{" "}
          · NEAR testnet · stakes are test NEAR
        </p>
      </footer>
    </div>
  );
}
