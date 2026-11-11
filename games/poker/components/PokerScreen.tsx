"use client";

// Deedlords Poker: a lobby, one table, and what a settled table paid. The page plays a seat's part of the protocol by
// itself (its shuffles with their proofs, its decryption shares) and asks the player for the bets only. How it looks
// is in TableView.tsx, Cards.tsx and app/poker/poker.css; this file reads the match and sends the calls.

import Link from "next/link";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import goldFoil from "@/assets/plates/gold-foil.webp";
import paper from "@/assets/plates/strip-paper.png";
import { Chain, Copy, Seat, User } from "@/components/landing/icons";
import type { Session } from "@/lib/chain/client";
import { CHAIN } from "@/lib/chain/config";
import { signInAsGuest } from "../../co-ty-phu/chain/keySession";
import { POKER_CONTRACT, STAKE, TURN_SECONDS, type Result, explorerLink, openTable, pokerClient, pokerSession, readMatch, seatKeys, seatStore, send, takeSeat, viewResult } from "../chain";
import { type MatchView, duty, holeCards } from "../seat";
import { PlayingCard } from "./Cards";
import { DemoTable } from "./Demo";
import { type Doing, Flap, type Hole, Ledger, type LogLine, TableView } from "./TableView";

export const inNear = (yocto: string | bigint): string => `${(Number(BigInt(yocto) / 10n ** 20n) / 10_000).toFixed(4)} NEAR`;
const text = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** The node gave up waiting for the transaction (HTTP 408 or a dropped answer): it may well have landed. */
const unanswered = (error: unknown): boolean => /\b408\b|timed? ?out|failed to fetch/i.test(text(error));
/** What a seat pays on top of its stake for the match's record; `chain.ts` adds it to the deposit by itself (RECORD_FEE there). */
export const RECORD_FEE = 2n * 10n ** 21n;
const NEAR = 10n ** 24n;
const NO_ANSWER = "The node did not answer in time. The transaction may still land: the page is reading the table to see.";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Resolves once the browser has drawn what was just set, or shortly after in a tab that is not drawing. */
const painted = () => Promise.race([new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))), sleep(160)]);

/** What a seat's own call is, in the ledger's words. */
const SENT: Record<string, (view: MatchView) => string> = {
  shuffle: (view) => `shuffled the deck with its proof (${view.shuffled + 1} of 2)`,
  deal: () => "sent its shares of the other seat's cards",
  open: (view) => `sent its shares of the ${["", "flop", "turn", "river"][view.street]}`,
  show: () => "showed its two cards",
};

/** The page: the red hall, the top row, and the two plates the stylesheet paints with. */
export function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="pk" style={{ "--pk-paper": `url(${paper.src})`, "--pk-foil": `url(${goldFoil.src})` } as CSSProperties}>
      <header className="pk-top">
        <Link className="pk-mark" href="/">
          Deedlords
        </Link>
        <nav aria-label="Deedlords">
          <Link href="/play">Board game</Link>
          <Link href="/arena">Arena</Link>
          <Link href="/poker" aria-current="page">
            Poker
          </Link>
        </nav>
        <span className="pk-net">
          <Chain size={16} /> NEAR {CHAIN.network}
          <small>{POKER_CONTRACT}</small>
        </span>
      </header>
      {children}
    </main>
  );
}

export function PokerScreen() {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [table, setTable] = useState<{ id: string; seq: number } | null>(null);
  const [demo, setDemo] = useState<string | null>(null);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    setSession(pokerSession());
    setDemo(query.get("demo"));
    const id = query.get("m");
    if (id) setTable({ id, seq: 0 });
    setReady(true);
  }, []);

  const show = (next: { id: string; seq: number } | null) => {
    window.history.replaceState(null, "", next ? `/poker?m=${next.id}` : "/poker");
    setTable(next);
  };
  const signIn = () => {
    signInAsGuest();
    setSession(pokerSession());
  };

  return (
    <Shell>
      {!ready ? null : demo !== null ? (
        <DemoTable start={demo} />
      ) : table && session ? (
        <Table key={table.id} id={table.id} firstSeq={table.seq} session={session} onBack={() => show(null)} />
      ) : (
        <Lobby session={session} invited={table?.id ?? null} onSignIn={signIn} onSeated={(id, seq) => show({ id, seq })} />
      )}
    </Shell>
  );
}

/** How a hand is dealt, as the lobby's board lists it. The times are what the steps took on testnet. */
const STEPS: { step: string; by: string; check: string; time: string }[] = [
  { step: "Shuffle", by: "each seat, the button first", check: "a zero-knowledge proof that the new deck is a shuffle of the one before it", time: "5 s a seat" },
  { step: "Deal", by: "each seat", check: "a proof that every share unlocking the other seat's cards was made with the right key", time: "3 s a seat" },
  { step: "Bet", by: "the seat to act", check: "whose turn it is, and what the bet may be", time: "2 s" },
  { step: "Flop, turn, river", by: "both seats", check: "the same proof for every share; a card turns when both seats' shares are in", time: "9 s a street" },
  { step: "Showdown", by: "both seats", check: "the shares that open each seat's own cards; then it ranks the hands and pays the pot", time: "3 s a seat" },
];

export function Lobby({ session, invited, onSignIn, onSeated }: { session: Session | null; invited: string | null; onSignIn: () => void; onSeated: (id: string, seq: number) => void }) {
  const [balance, setBalance] = useState<bigint | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!session) return;
    const read = () => pokerClient.balance(session.accountId).then(setBalance, () => undefined);
    void read();
    const timer = setInterval(read, 6_000);
    return () => clearInterval(timer);
  }, [session]);

  const open = async (bothSeats: boolean) => {
    if (!session) return;
    setBusy(true);
    setNote("");
    try {
      // The match has changed once when it is created, twice when both seats are taken.
      onSeated(await openTable(session, bothSeats), bothSeats ? 2 : 1);
    } catch (error) {
      setNote(text(error));
      setBusy(false);
    }
  };

  /** Below this one seat cannot be taken and its shuffle proof still be checked (that call reserves 0.26 NEAR). */
  const short = balance !== undefined && (balance === null || balance < (4n * NEAR) / 10n);

  return (
    <div className="pk-hall">
      <div className="pk-wall">
        <div className="pk-wallhead">
          <h1 className="pk-line">Poker with no dealer.</h1>
          <div className="pk-wallhead__lede">
            <p className="pk-lede">
              Heads-up Texas Hold&apos;em on NEAR {CHAIN.network}. The two seats shuffle and deal one deck with their own keys. The contract takes a deck only with a zero-knowledge proof that it is an honest shuffle, and a card only with a
              proof that it was turned with the right key.
            </p>
          </div>
          <div className="pk-fan" aria-hidden="true">
            {[undefined, 48, 49, 50, 51].map((card, n) => (
              <span key={n} style={{ "--n": n, display: "contents" } as CSSProperties}>
                <PlayingCard card={card} />
              </span>
            ))}
          </div>
        </div>

        <section className="pk-board" aria-label="How a hand is dealt">
          <h2 className="pk-board__title">
            <Seat size={22} /> <span>One hand, step by step</span>
          </h2>
          <div className="pk-steps" role="table" aria-label="The steps of a hand">
            <div className="pk-label" role="row">
              <span role="columnheader" />
              <span role="columnheader">Step</span>
              <span role="columnheader">The contract checks</span>
              <span role="columnheader">Takes about</span>
            </div>
            {STEPS.map((row, at) => (
              <div key={row.step} role="row">
                <span role="cell" data-n>
                  {at + 1}
                </span>
                <span role="cell">
                  <b>{row.step}</b>
                  <small>{row.by}</small>
                </span>
                <span role="cell">{row.check}</span>
                <span role="cell" data-time>
                  {row.time}
                </span>
              </div>
            ))}
          </div>
        </section>
        <p className="pk-under">
          The page plays your seat&apos;s part of every step and asks you only for bets. The contract is{" "}
          {CHAIN.explorerUrl ? (
            <a className="pk-code" href={`${CHAIN.explorerUrl}/address/${POKER_CONTRACT}`} target="_blank" rel="noreferrer noopener">
              {POKER_CONTRACT}
            </a>
          ) : (
            <span className="pk-code">{POKER_CONTRACT}</span>
          )}
          .
        </p>
      </div>

      <div className="pk-ticket">
        <section className="pk-stub" aria-label="Your game account">
          <h2 className="pk-stub__title">
            Passenger <User size={22} />
          </h2>
          {session ? (
            <>
              <div className="pk-who">
                <span className="pk-stamp" aria-hidden="true">
                  {session.accountId.replace(/[^a-z0-9]/gi, "").slice(0, 2)}
                </span>
                <p>
                  <strong title={session.accountId}>{session.accountId}</strong>
                  <small>game account kept in this browser</small>
                </p>
                <p className="pk-balance" data-low={short || undefined}>
                  {balance === undefined ? (
                    <small>reading…</small>
                  ) : balance === null ? (
                    <small>not on chain yet</small>
                  ) : (
                    <>
                      <strong>{inNear(balance).replace(" NEAR", "")}</strong>
                      <small>NEAR</small>
                    </>
                  )}
                </p>
              </div>
              {short && (
                <>
                  <p className="pk-fine">
                    This account holds too little to play. Keep about 0.6 NEAR on it for one seat, 0.8 to play both. Send it test NEAR on {CHAIN.network} and this page shows the balance.{" "}
                    {CHAIN.network === "testnet" && (
                      <a href="https://docs.near.org/getting-started/faucet" target="_blank" rel="noreferrer noopener">
                        Ask a testnet faucet
                      </a>
                    )}
                  </p>
                  <div className="pk-acts">
                    <button
                      type="button"
                      className="pk-pill"
                      onClick={() => {
                        void navigator.clipboard?.writeText(session.accountId).then(() => setCopied(true));
                      }}
                    >
                      <Copy size={16} /> {copied ? "Address copied" : "Copy the address"}
                    </button>
                  </div>
                </>
              )}
            </>
          ) : (
            <>
              <p className="pk-small">A game account is a key kept in this browser. It signs every step of a hand, so you are never stopped by a wallet prompt.</p>
              <button type="button" className="pk-go" onClick={onSignIn}>
                Make a guest game account
              </button>
            </>
          )}
        </section>

        <section className="pk-stub" aria-label="Open a table">
          <h2 className="pk-stub__title">
            Table <Seat size={22} />
          </h2>
          {invited && !session && <p className="pk-small">You were sent table {invited}. Make a game account and it opens.</p>}
          <dl className="pk-terms">
            <div>
              <dt>A seat</dt>
              <dd>
                <b>{inNear(STAKE).replace(" NEAR", "")}</b> NEAR for 100 chips, and a record fee of {inNear(RECORD_FEE)}
              </dd>
            </div>
            <div>
              <dt>Blinds</dt>
              <dd>
                <b>1</b> and <b>2</b>
              </dd>
            </div>
            <div>
              <dt>Clock</dt>
              <dd>{TURN_SECONDS / 60} minutes a step</dd>
            </div>
            <div>
              <dt>Gas</dt>
              <dd>about 0.03 NEAR a seat, a hand</dd>
            </div>
          </dl>
          <button type="button" className="pk-go" disabled={!session || busy} onClick={() => open(true)}>
            {busy ? "Opening the table…" : "Play both seats in this browser"}
          </button>
          <div className="pk-acts">
            <button type="button" className="pk-pill" disabled={!session || busy} onClick={() => open(false)}>
              Open a table for a friend
            </button>
          </div>
          {note && (
            <p className="pk-problem" role="alert">
              {note}
            </p>
          )}
          <p className="pk-fine">
            Keep about 0.6 NEAR in the account for one seat, 0.8 to play both. Nearly all the gas of a hand goes to checking the shuffle proof, and that call must be able to reserve 0.26 NEAR before it is sent. The stakes are test NEAR:
            what a seat holds when the table closes is paid back; the record fee is not.
          </p>
        </section>
      </div>
    </div>
  );
}

function Table({ id, firstSeq, session, onBack }: { id: string; firstSeq: number; session: Session; onBack: () => void }) {
  /** `undefined`: not read yet. `null`: the match is gone (settled, or there never was one). */
  const [view, setView] = useState<MatchView | null | undefined>(undefined);
  const [result, setResult] = useState<Result | null>(null);
  const [hole, setHole] = useState<Hole>({ hand: -1, cards: [null, null] });
  const [log, setLog] = useState<LogLine[]>([]);
  /** What the reading loop could not do, and what the last click could not do. */
  const [trouble, setTrouble] = useState("");
  const [refused, setRefused] = useState("");
  const [doing, setDoing] = useState<Doing>(null);
  const [sending, setSending] = useState(false);
  /** After a click the buttons stay off until the page has read the match that click made. */
  const [lockUntil, setLockUntil] = useState(0);
  const [dealtHand, setDealtHand] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  /** The next view must be at least this change of the match. */
  const seq = useRef(firstSeq);
  /** The last hand this browser agreed to start. Later hands wait for a click, so a seat can leave between hands. */
  const dealt = useRef(0);
  /** A call the node did not answer: once the table is read past the change it was sent at, it landed. */
  const unsure = useRef<{ seq: number; line: string; seat?: number } | null>(null);
  const store = useMemo(() => seatStore(id), [id]);
  const say = useCallback((line: string, hash?: string, seat?: number) => setLog((lines) => [{ text: line, hash, seat }, ...lines].slice(0, 60)), []);
  const seatsOf = useCallback((at: MatchView) => [0, 1].filter((seat) => at.players[seat] === session.accountId && seatKeys(id, seat) !== null), [id, session]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let alive = true;
    const run = async () => {
      while (alive) {
        try {
          const at = await readMatch(id, seq.current, () => alive);
          if (!alive) return;
          if (!at) {
            // A call the node did not answer that closed the table: the table is settled, so it landed.
            const pending = unsure.current;
            if (pending) {
              unsure.current = null;
              setRefused("");
              say(`${pending.line} (the node gave no receipt; the table shows it landed)`, undefined, pending.seat);
            }
            setResult(await viewResult(id));
            setView(null);
            return;
          }
          // A bet sent while this read was under way made the match newer than what was read.
          if (at.seq < seq.current) continue;
          seq.current = at.seq;
          setView(at);
          setTrouble("");
          const pending = unsure.current;
          if (pending && at.seq > pending.seq) {
            unsure.current = null;
            setRefused("");
            say(`${pending.line} (the node gave no receipt; the table shows it landed)`, undefined, pending.seat);
          }
          const mine = seatsOf(at);
          if (at.shuffled === 2 && mine.length > 0) {
            const deck = await store.deck(at.hand, 1);
            const cards = [0, 1].map((seat) => (mine.includes(seat) ? holeCards(at, seat, seatKeys(id, seat)!, deck) : null));
            if (alive) setHole({ hand: at.hand, cards });
          }
          const seat = mine.find((candidate) => at.awaited.includes(candidate));
          const waitsForClick = at.phase === "shuffle" && at.shuffled === 0 && at.hand > dealt.current;
          if (seat !== undefined && at.phase !== "bet" && at.phase !== "lobby" && !waitsForClick) {
            // Proving a shuffle holds the page for a second or two: the table is drawn at this step first, so the
            // deck is already being riffled when the work starts.
            setDoing({ seat, what: at.phase === "showdown" ? "show" : at.phase });
            await painted();
            try {
              const call = await duty(at, seat, seatKeys(id, seat)!, store);
              if (call && alive) {
                const line = `Seat ${seat + 1} ${SENT[call.method]?.(at) ?? call.method}`;
                try {
                  const outcome = await send(session, call);
                  seq.current = Math.max(seq.current, at.seq + 1);
                  say(line, outcome.hash, seat);
                } catch (error) {
                  if (!unanswered(error)) throw error;
                  unsure.current = { seq: at.seq, line, seat };
                  setTrouble(NO_ANSWER);
                  await sleep(2_000);
                }
                continue;
              }
            } finally {
              if (alive) setDoing(null);
            }
          }
        } catch (error) {
          if (!alive) return;
          setTrouble(text(error));
          await sleep(3_000);
        }
        await sleep(CHAIN.pollMs);
      }
    };
    void run();
    return () => {
      alive = false;
    };
  }, [id, session, store, say, seatsOf]);

  /** Sends a call a click asked for. Returns whether the contract took it. */
  const click = async (line: string, seat: number | undefined, send_: () => Promise<{ hash?: string }>): Promise<boolean> => {
    if (!view) return false;
    setSending(true);
    setRefused("");
    try {
      const outcome = await send_();
      seq.current = Math.max(seq.current, view.seq + 1);
      setLockUntil(view.seq + 1);
      say(line, outcome.hash, seat);
      return true;
    } catch (error) {
      if (unanswered(error)) unsure.current = { seq: view.seq, line, seat };
      setRefused(unanswered(error) ? NO_ANSWER : text(error));
      return false;
    } finally {
      setSending(false);
    }
  };
  const call = (line: string, seat: number | undefined, method: string, args: Record<string, unknown>) => click(line, seat, () => send(session, { method, args: { id, ...args } }));

  if (view === undefined) {
    return (
      <TableView
        id={id}
        view={UNREAD}
        hole={hole}
        mine={[]}
        locked
        doing={null}
        dealt={0}
        now={now}
        problems={[trouble].filter(Boolean)}
        log={log}
        link=""
        explorer={explorerLink}
        stake=""
        reading
        on={{ act: idle, deal: idle, leave: idle, claim: idle, close: idle, take: idle }}
      />
    );
  }
  if (view === null) return <Settled id={id} result={result} log={log} onBack={onBack} />;

  return (
    <TableView
      id={id}
      view={view}
      hole={hole}
      mine={seatsOf(view)}
      locked={sending || view.seq < lockUntil}
      doing={sending ? { seat: -1, what: "Sending to the contract…" } : doing}
      dealt={dealtHand}
      now={now}
      problems={[refused, trouble].filter(Boolean)}
      log={log}
      link={`${window.location.origin}/poker?m=${id}`}
      explorer={explorerLink}
      stake={inNear(BigInt(view.stake) + RECORD_FEE)}
      on={{
        act: (seat, action, amount, line) => void call(`Seat ${seat + 1} ${line}`, seat, "act", { seat, action, amount }),
        deal: () => {
          dealt.current = view.hand;
          setDealtHand(view.hand);
        },
        leave: () => void call("Left the table and cashed out", undefined, "leave", {}),
        claim: () => void call("Claimed the table after the deadline", undefined, "timeout", {}),
        close: async () => {
          if (await call("Closed the table", undefined, "leave", {})) onBack();
        },
        take: () => void click("Seat 2 took the seat", 1, () => takeSeat(session, id, BigInt(view.stake))),
      }}
    />
  );
}

/** What the table shows before the match is read: two open seats and no cards. */
const UNREAD: MatchView = {
  id: "",
  phase: "lobby",
  stake: "0",
  players: [],
  keys: [],
  turnSeconds: TURN_SECONDS,
  deadline: "0",
  chips: [0, 0],
  hand: 0,
  button: 0,
  shuffled: 0,
  street: 0,
  toAct: 0,
  awaited: [],
  put: [0, 0],
  bet: [0, 0],
  done: [false, false],
  tokens: [],
  board: [],
  hole: [[], []],
  last: null,
  seq: 0,
};
const idle = () => undefined;

const REASONS: Record<string, string> = {
  left: "a seat left and both were paid what they held",
  timeout: "a seat ran out of time and forfeited its chips",
  busted: "a seat ran out of chips",
};

export function Settled({ id, result, log, onBack, explorer = explorerLink }: { id: string; result: Result | null; log: LogLine[]; onBack: () => void; explorer?: (hash: string) => string | null }) {
  const back = (
    <button type="button" className="pk-go" onClick={onBack}>
      Back to the lobby
    </button>
  );
  if (!result) {
    return (
      <div className="pk-hall">
        <div>
          <h1 className="pk-line">No such table.</h1>
          <p className="pk-lede">
            The contract holds no table <span className="pk-code">{id}</span>, open or settled. The link may be mistyped.
          </p>
        </div>
        <div className="pk-ticket">
          <section className="pk-stub">
            <h2 className="pk-stub__title">Lobby</h2>
            <p className="pk-small">Open a table of your own and send its link.</p>
            {back}
          </section>
        </div>
      </div>
    );
  }
  const [first, second] = result.chips;
  return (
    <div className="pk-hall">
      <div>
        <h1 className="pk-line">Table settled.</h1>
        <p className="pk-lede">
          Table <span className="pk-code">{id}</span> closed after {result.hands} {result.hands === 1 ? "hand" : "hands"}: {REASONS[result.reason] ?? result.reason}. The contract paid out in the transaction that closed it.
        </p>
        <section className="pk-board" aria-label="What the table paid">
          <h2 className="pk-board__title">
            <Seat size={22} /> <span>Paid by the contract</span>
          </h2>
          <ul className="pk-result">
            {[0, 1].map((seat) => (
              <li key={seat}>
                <span className="pk-seat__face" style={{ "--seat": `var(--seat-${seat})` } as CSSProperties} aria-hidden="true">
                  {seat + 1}
                </span>
                <span>
                  <small className="pk-label">
                    Seat {seat + 1} · {result.chips[seat]} chips
                  </small>
                  <strong title={result.players[seat]}>{result.players[seat]}</strong>
                </span>
                <Flap text={first === second ? "EVEN" : (seat === 0 ? first > second : second > first) ? "AHEAD" : "BEHIND"} />
                <span className="pk-result__paid">
                  <b>{inNear(result.payouts[seat]).replace(" NEAR", "")}</b>
                  <small className="pk-label">NEAR</small>
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <div className="pk-side">
        <div className="pk-ticket">
          <section className="pk-stub">
            <h2 className="pk-stub__title">Play again</h2>
            <p className="pk-small">A new table takes a new stake; what this one paid is already in the accounts above.</p>
            {back}
          </section>
        </div>
        <Ledger log={log} explorer={explorer} />
      </div>
    </div>
  );
}
