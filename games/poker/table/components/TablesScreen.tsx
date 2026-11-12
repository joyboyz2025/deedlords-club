"use client";

// Deedlords Poker at tables of two to nine seats (/poker/tables): a lobby with the wall of tables, one table, and what
// a settled table paid. The page plays its seat's part of the protocol by itself (its shuffle with its proof, its
// shares) and asks the player for the bets only. How it looks is in RoundTable.tsx and app/poker/tables/tables.css;
// this file reads the table and sends the calls.

import Link from "next/link";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import goldFoil from "@/assets/plates/gold-foil.webp";
import paper from "@/assets/plates/strip-paper.png";
import { Arrow, Chain, Copy, Seat, User } from "@/components/landing/icons";
import type { Session } from "@/lib/chain/client";
import { CHAIN } from "@/lib/chain/config";
import { useCharacters } from "../../../chibi/useChibi";
import { near, ownStake } from "../../../co-ty-phu/chain/calls";
import { signInAsGuest } from "../../../co-ty-phu/chain/keySession";
import { Flap, Ledger, type LogLine } from "../../components/TableView";
import {
  MAX_SEATS,
  STAKE,
  TABLE_CONTRACT,
  TURN_SECONDS,
  callTime,
  explorerLink,
  isFreeStake,
  leaveTable,
  openFreeTable,
  openTable,
  readTable,
  seatKeys,
  seatStore,
  send,
  startFreeTable,
  startTable,
  tableClient,
  tableSession,
  takeSeat,
  viewResult,
} from "../chain";
import { FREE_TABLE_HANDS, RECORD_FEE } from "../contract";
import { type TableResult, type TableView, betCall, duty, holeCards, movedOn, seated } from "../seat";
import { useHouse } from "../useHouse";
import { useSeatAgent } from "../useSeatAgent";
import { type Tables, useTables } from "../useTables";
import { TablesDemo } from "./Demo";
import { RoundTable, shortAccount } from "./RoundTable";

const text = (error: unknown) => (error instanceof Error ? error.message : String(error));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** The node gave up waiting for the transaction (HTTP 408 or a dropped answer): it may well have landed. */
const unanswered = (error: unknown): boolean => /\b408\b|timed? ?out|failed to fetch/i.test(text(error));
/**
 * The contract refused a call because the table is already past the step it was made for: a node a block behind
 * showed the table still waiting for it, or a bet was chosen before the table moved on. Nothing happened on chain:
 * read the table again, and say nothing to the player.
 */
const stale = (error: unknown): boolean => movedOn(error) || /not now: the hand is at another step|not this seat's turn/.test(text(error));
const NO_ANSWER = "The node did not answer in time. The transaction may still land: the page is reading the table to see.";
/** Resolves once the browser has drawn what was just set, or shortly after in a tab that is not drawing. */
const painted = () => Promise.race([new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))), sleep(160)]);
const NEAR = 10n ** 24n;
export const asNear = (yocto: string | bigint, places = 4): string => `${(Number(BigInt(yocto) / 10n ** 20n) / 10_000).toFixed(places)} NEAR`;
const ROUTE = "/poker/tables";

/** What a seat's own call is, in the ledger's words. */
const SENT: Record<string, (view: TableView) => string> = {
  shuffle: (view) => `shuffled the deck with its proof (${view.shuffled + 1} of ${view.dealt.length || seated(view).length})`,
  deal: () => "sent its shares of the other seats' cards",
  open: (view) => `sent its shares of the ${["", "flop", "turn", "river"][view.street]}`,
  show: () => "showed its two cards",
};

/** The page: the red hall, the top row, and the two plates the stylesheet paints with. */
export function TablesShell({ children }: { children: ReactNode }) {
  return (
    <main className="pk" style={{ "--pk-paper": `url(${paper.src})`, "--pk-foil": `url(${goldFoil.src})` } as CSSProperties}>
      <header className="pk-top">
        <Link className="pk-mark" href="/">
          Deedlords
        </Link>
        <nav aria-label="Deedlords">
          <Link href="/play">Board game</Link>
          <Link href="/arena">Arena</Link>
          {/* The heads-up table is on testnet only: mainnet's one poker contract is this one. */}
          {CHAIN.network !== "mainnet" && <Link href="/poker">Heads-up</Link>}
          <Link href={ROUTE} aria-current="page">
            Tables
          </Link>
        </nav>
        <span className="pk-net">
          <Chain size={16} /> NEAR {CHAIN.network}
          <small>{TABLE_CONTRACT}</small>
        </span>
      </header>
      {children}
    </main>
  );
}

export function TablesScreen() {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [table, setTable] = useState<{ id: string; seq: number } | null>(null);
  const [demo, setDemo] = useState<string | null>(null);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    setSession(tableSession());
    setDemo(query.get("demo"));
    const id = query.get("t");
    if (id) setTable({ id, seq: 0 });
    setReady(true);
  }, []);

  const show = (next: { id: string; seq: number } | null) => {
    window.history.replaceState(null, "", next ? `${ROUTE}?t=${next.id}` : ROUTE);
    setTable(next);
  };
  const signIn = () => {
    signInAsGuest();
    setSession(tableSession());
  };

  return (
    <TablesShell>
      {!ready ? null : demo !== null ? (
        <TablesDemo start={demo} />
      ) : table ? (
        <LiveTable key={table.id} id={table.id} firstSeq={table.seq} session={session} onSignIn={signIn} onBack={() => show(null)} />
      ) : (
        <LiveLobby session={session} onSignIn={signIn} onOpen={(id, seq) => show({ id, seq })} />
      )}
    </TablesShell>
  );
}

type LobbyProps = { session: Session | null; onSignIn: () => void; onOpen: (id: string, seq: number) => void };

function LiveLobby(props: LobbyProps) {
  const wall = useTables();
  const house = useHouse(null, null);
  return <TablesLobby {...props} wall={wall} houses={house.accounts ?? []} free={house.free} models={house.models} />;
}

export function TablesLobby({
  session,
  onSignIn,
  onOpen,
  wall,
  houses,
  free = null,
  models = [],
}: LobbyProps & {
  wall: Tables;
  houses: string[];
  /** The account that hosts free tables here, `null` when nobody does. */ free?: string | null;
  /** The models its seat may bet by. */ models?: string[];
}) {
  const [balance, setBalance] = useState<bigint | null | undefined>(undefined);
  // The stake of each seat at the table opened here: a chip (0 is a free table, where the server hosts them), or an
  // amount typed in NEAR (which stands while filled in). Until one is picked, a free table where there is one.
  const [picked, setPicked] = useState<number | null>(null);
  const chips = [...(free ? [0] : []), ...STAKE_CHIPS];
  const chip = picked !== null && chips.includes(picked) ? picked : chips[0];
  const [typed, setTyped] = useState("");
  const gratis = chip === 0 && !typed.trim();
  // A free table is the house's seat and yours unless more are asked for.
  const [seatsPicked, setSeats] = useState<number | null>(null);
  const seats = seatsPicked ?? (gratis ? 2 : 6);
  const [model, setModel] = useState("");
  const own = ownStake(typed, LARGEST_STAKE, STAKE_CHIPS[0]);
  const typedProblem = typed.trim() && "problem" in own ? own.problem : null;
  const stake = near(typed.trim() && "amount" in own ? own.amount : chip || STAKE_CHIPS[0]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!session) return;
    const read = () => tableClient.balance(session.accountId).then(setBalance, () => undefined);
    void read();
    const timer = setInterval(read, 6_000);
    return () => clearInterval(timer);
  }, [session]);

  const open = async () => {
    if (!session) return;
    setBusy(true);
    setNote("");
    try {
      // The table has changed once when it is created.
      onOpen(gratis ? await openFreeTable(session, seats, model || undefined) : await openTable(session, seats, stake), 1);
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
          <h1 className="pk-line">Poker for two to nine.</h1>
          <div className="pk-wallhead__lede">
            <p className="pk-lede">
              Texas Hold&apos;em at tables of up to nine seats on NEAR {CHAIN.network}, with no dealer. Every seat dealt in shuffles the deck once with its own key, and the
              contract takes each deck only with a zero-knowledge proof that it is an honest shuffle. A card turns only when every seat has given its share of it.
            </p>
          </div>
        </div>
        <TableWall wall={wall} you={session?.accountId ?? null} houses={houses} onOpen={(id) => onOpen(id, 0)} />
        <p className="pk-under">
          {CHAIN.network !== "mainnet" && (
            <>
              Two seats, face to face, are at <Link href="/poker">the heads-up table</Link>.{" "}
            </>
          )}
          The contract here is{" "}
          {CHAIN.explorerUrl ? (
            <a className="pk-code" href={`${CHAIN.explorerUrl}/address/${TABLE_CONTRACT}`} target="_blank" rel="noreferrer noopener">
              {TABLE_CONTRACT}
            </a>
          ) : (
            <span className="pk-code">{TABLE_CONTRACT}</span>
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
                      <strong>{asNear(balance).replace(" NEAR", "")}</strong>
                      <small>NEAR</small>
                    </>
                  )}
                </p>
              </div>
              {short && (
                <>
                  <p className="pk-fine">
                    {free
                      ? "A free table needs no NEAR. For a table with a stake, keep about 0.6 NEAR on this account for a seat."
                      : "This account holds too little to play. Keep about 0.6 NEAR on it for a seat."}{" "}
                    Send it {CHAIN.network === "mainnet" ? "NEAR" : `test NEAR on ${CHAIN.network}`} and this page shows the balance.{" "}
                    {CHAIN.network === "testnet" && (
                      <a href="https://docs.near.org/getting-started/faucet" target="_blank" rel="noreferrer noopener">
                        Ask a testnet faucet
                      </a>
                    )}
                  </p>
                  <div className="pk-acts">
                    <button type="button" className="pk-pill" onClick={() => void navigator.clipboard?.writeText(session.accountId).then(() => setCopied(true))}>
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
            Open a table <Seat size={22} />
          </h2>
          <div className="pt-picker" role="radiogroup" aria-label="Seats at the table">
            {Array.from({ length: MAX_SEATS - 1 }, (_, at) => at + 2).map((count) => (
              <button key={count} type="button" role="radio" aria-checked={seats === count} className="pt-picker__seat" onClick={() => setSeats(count)}>
                {count}
              </button>
            ))}
          </div>
          <div className="pt-stake">
            <span id="pt-stake">Stake a seat</span>
            <div className="pt-picker pt-picker--stake" role="group" aria-labelledby="pt-stake">
              {chips.map((amount) => (
                <button
                  key={amount}
                  type="button"
                  aria-pressed={!typed.trim() && amount === chip}
                  className="pt-picker__seat"
                  onClick={() => {
                    setPicked(amount);
                    setTyped("");
                  }}
                >
                  {amount === 0 ? "Free" : amount}
                </button>
              ))}
            </div>
            <label className="pt-stake__own">
              <span>Or your own</span>
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                placeholder={`${STAKE_CHIPS[0]} to ${LARGEST_STAKE}`}
                value={typed}
                aria-invalid={typedProblem ? true : undefined}
                onChange={(event) => setTyped(event.target.value.replace(",", "."))}
              />
              <b aria-hidden="true">NEAR</b>
            </label>
            {typedProblem && (
              <p className="pk-problem" role="alert">
                {typedProblem}
              </p>
            )}
          </div>
          {gratis && models.length > 1 && (
            <label className="pt-stake__own pt-stake__model">
              <span>The house bets by</span>
              <select value={model} onChange={(event) => setModel(event.target.value)}>
                <option value="">its usual model</option>
                {models.map((name) => (
                  <option key={name} value={name}>
                    {name === "rules" ? "the odds alone" : name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <dl className="pk-terms">
            <div>
              <dt>A seat</dt>
              <dd>
                {gratis ? (
                  <>
                    <b>Free</b>: 100 chips that are only chips. No NEAR is needed, and none is won
                  </>
                ) : (
                  <>
                    <b>{asNear(stake).replace(" NEAR", "")}</b> NEAR for 100 chips, and a record fee of {asNear(RECORD_FEE)}
                  </>
                )}
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
              <dd>{gratis ? 2 : TURN_SECONDS / 60} minutes a step</dd>
            </div>
            <div>
              <dt>Starts</dt>
              <dd>when full, or when you start it with two or more</dd>
            </div>
          </dl>
          <button type="button" className="pk-go" disabled={!session || busy || Boolean(typedProblem)} onClick={open}>
            {busy ? "Opening the table…" : gratis ? `Open a free table of ${seats}` : `Open a table of ${seats}`}
          </button>
          {note && (
            <p className="pk-problem" role="alert">
              {note}
            </p>
          )}
          {gratis ? (
            <p className="pk-fine">
              The house opens the table, holds seat 1 and plays it for {FREE_TABLE_HANDS} hands; you take seat 2. Every step you make is signed by your game account and sent by the
              house, which pays its gas. With more than two seats, send the link to friends and start when you like.
            </p>
          ) : (
            <p className="pk-fine">
              You take seat 1. Send the link, or fill seats with the house{houses.length ? ` (up to ${houses.length} of its accounts)` : ""} from the table. Keep about 0.6 NEAR in
              the account: nearly all the gas of a hand goes to checking your shuffle proof, and that call must be able to reserve 0.26 NEAR. Your chips come back when you leave;
              the record fee does not.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

/** A wall is never short: the lines with no table stand ruled and blank. */
const WALL_LINES = 5;

/** The tables the contract holds: free seats to take, hands under way to watch. Every row opens its table. */
function TableWall({ wall, you, houses, onOpen }: { wall: Tables; you: string | null; houses: string[]; onOpen: (id: string) => void }) {
  const { tables, offline } = wall;
  const rows = tables ?? [];
  const who = (account: string): string => (account === you ? "You" : houses.includes(account) ? `House ${houses.indexOf(account) + 1}` : shortAccount(account));
  return (
    <section className="pk-board pk-wall-board" aria-label="Tables on the contract">
      <h2 className="pk-board__title">
        <Chain size={22} /> <span>Tables</span>
        {tables && <small className="pk-wall-board__count">{rows.filter((table) => table.players.includes(null)).length} with a free seat</small>}
      </h2>
      {offline && (
        <p className="pk-board__note" role="status">
          Cannot reach the contract right now; what is shown may be old. Trying again…
        </p>
      )}
      {tables === null ? (
        !offline && <p className="pk-board__note">Reading the contract…</p>
      ) : (
        <>
          {rows.length === 0 && (
            <p className="pk-board__note">No table is open right now. Open one at the desk, choose how many seats, and fill it with friends or with the house.</p>
          )}
          <div className="pk-tables pt-tables" role="table" aria-label="Tables">
            <div className="pk-tables__row pk-tables__row--head pk-label" role="row">
              <span role="columnheader">Table</span>
              <span role="columnheader">Seats</span>
              <span role="columnheader">Stake</span>
              <span role="columnheader">Now</span>
              <span role="columnheader" />
            </div>
            {rows.map((table) => {
              const open = table.phase === "lobby";
              const free = table.players.filter((player) => !player).length;
              const mine = you !== null && table.players.includes(you);
              return (
                <a
                  key={table.id}
                  role="row"
                  className="pk-tables__row"
                  data-mine={mine || undefined}
                  href={`${ROUTE}?t=${table.id}`}
                  onClick={(event) => {
                    event.preventDefault();
                    onOpen(table.id);
                  }}
                >
                  <span role="cell" className="pk-code">
                    {table.id}
                  </span>
                  <span role="cell" className="pt-tables__seats">
                    <span className="pt-dots" aria-label={`${table.players.length - free} of ${table.players.length} seats taken`}>
                      {table.players.map((player, seat) => (
                        <i key={seat} data-taken={player ? true : undefined} style={{ "--seat": `var(--seat-${seat})` } as CSSProperties} />
                      ))}
                    </span>
                    <small>host {who(table.host)}</small>
                  </span>
                  <span role="cell">{isFreeStake(table) ? "Free" : asNear(table.stake, 2)}</span>
                  <span role="cell" className="pk-tables__now">
                    {open ? (
                      <span className="pk-open">Open</span>
                    ) : (
                      <>
                        <Flap text={`HAND ${table.hand + 1}`} />
                        {free > 0 && <small>{free} free</small>}
                      </>
                    )}
                  </span>
                  <span role="cell" className="pk-tables__go">
                    {mine ? "Your table" : free > 0 ? "Sit down" : "Watch"} <Arrow />
                  </span>
                </a>
              );
            })}
            {Array.from({ length: Math.max(0, WALL_LINES - rows.length) }, (_, at) => (
              <div key={`blank:${at}`} className="pk-tables__row" data-blank aria-hidden="true">
                <span />
                <span />
                <span />
                <span className="pk-tables__now">
                  <Flap text={" ".repeat(8)} />
                </span>
                <span />
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function LiveTable({ id, firstSeq, session, onSignIn, onBack }: { id: string; firstSeq: number; session: Session | null; onSignIn: () => void; onBack: () => void }) {
  /** `undefined`: not read yet. `null`: the table is gone (settled, or there never was one). */
  const [view, setView] = useState<TableView | null | undefined>(undefined);
  const [result, setResult] = useState<TableResult | null>(null);
  const [hole, setHole] = useState<{ hand: number; cards: (number | null)[] | null }>({ hand: -1, cards: null });
  const [log, setLog] = useState<LogLine[]>([]);
  /** What the reading loop could not do, and what the last click could not do. */
  const [trouble, setTrouble] = useState("");
  const [refused, setRefused] = useState("");
  const [doing, setDoing] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  /** After a click the buttons stay off until the page has read the table that click made. */
  const [lockUntil, setLockUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const seq = useRef(firstSeq);
  /** A call the node did not answer: once the table is read past the change it was sent at, it landed. */
  const unsure = useRef<{ seq: number; line: string; seat?: number } | null>(null);
  /** The change of the table a refused click was sent against: once the table has moved on, its error is old news. */
  const refusedAt = useRef<number | null>(null);
  /**
   * The step this seat last played (hand, phase, street, shuffles, bets): not sent twice, whatever a slow node shows.
   * One the node did not answer may not have landed: it is sent again if the table still waits for it 20 s later.
   */
  const playedStep = useRef<{ step: string; at: number; sure: boolean } | null>(null);
  const store = useMemo(() => seatStore(id), [id]);
  const accountId = session?.accountId ?? null;
  const say = useCallback((line: string, hash?: string, seat?: number) => setLog((lines) => [{ text: line, hash, seat }, ...lines].slice(0, 60)), []);
  /** This browser's seat at a table: the account sits there and this browser holds its card key. */
  const seatOf = useCallback(
    (at: TableView): number | null => {
      if (!accountId) return null;
      const seat = at.players.indexOf(accountId);
      return seat >= 0 && seatKeys(id, accountId) ? seat : null;
    },
    [id, accountId],
  );

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let alive = true;
    const landed = () => {
      const pending = unsure.current;
      if (!pending) return;
      unsure.current = null;
      setRefused("");
      say(`${pending.line} (the node gave no receipt; the table shows it landed)`, undefined, pending.seat);
    };
    const run = async () => {
      while (alive) {
        try {
          const at = await readTable(id, seq.current, () => alive);
          if (!alive) return;
          if (!at) {
            landed();
            setResult(await viewResult(id));
            setView(null);
            return;
          }
          if (at.seq < seq.current) continue;
          seq.current = at.seq;
          setView(at);
          setTrouble("");
          if (unsure.current && at.seq > unsure.current.seq) landed();
          if (refusedAt.current !== null && at.seq > refusedAt.current + 1) {
            refusedAt.current = null;
            setRefused("");
          }
          const seat = seatOf(at);
          if (seat === null || !session) {
            await sleep(CHAIN.pollMs);
            continue;
          }
          const keys = seatKeys(id, session.accountId)!;
          if (at.dealt.includes(seat) && (at.phase === "bet" || at.phase === "open" || at.phase === "showdown")) {
            const deck = await store.deck(at.hand, at.dealt.length - 1);
            const cards = holeCards(at, seat, keys, deck);
            if (alive && cards) setHole({ hand: at.hand, cards });
          }
          const step = `${seat}:${at.hand}:${at.phase}:${at.street}:${at.shuffled}:${at.bets}`;
          const played = playedStep.current;
          const fresh = !played || played.step !== step || (!played.sure && Date.now() - played.at > 20_000);
          if (at.awaited.includes(seat) && at.phase !== "bet" && at.phase !== "lobby" && fresh) {
            // Proving a shuffle holds the page for a second or two: the step is drawn first.
            setDoing(at.phase === "shuffle" ? "shuffle" : null);
            await painted();
            try {
              const call = await duty(at, seat, keys, store);
              if (call && alive) {
                const line = `Seat ${seat + 1} ${SENT[call.method]?.(at) ?? call.method}`;
                try {
                  const outcome = await send(session, call);
                  playedStep.current = { step, at: Date.now(), sure: true };
                  seq.current = Math.max(seq.current, at.seq + 1);
                  say(line, outcome.hash, seat);
                } catch (error) {
                  if (!unanswered(error)) throw error;
                  playedStep.current = { step, at: Date.now(), sure: false };
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
          if (stale(error)) {
            await sleep(CHAIN.pollMs);
            continue;
          }
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
  }, [id, session, store, say, seatOf]);

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
      // A copy of a bet whose first sending the node did not answer, refused because the table moved on: nothing was
      // bet, and the table read next shows what did happen. Not an error for the player.
      if (stale(error)) return false;
      if (unanswered(error)) unsure.current = { seq: view.seq, line, seat };
      else refusedAt.current = view.seq;
      setRefused(unanswered(error) ? NO_ANSWER : text(error));
      return false;
    } finally {
      setSending(false);
    }
  };

  const mySeat = view ? seatOf(view) : null;
  const myCards = hole.hand === view?.hand ? hole.cards : null;
  const house = useHouse(id, view);
  const characters = useCharacters(view?.players ?? []);

  // A bet, from a click or from the player's agent: a fold carries the seat's shares for the board.
  const latest = useRef({ view, click, mySeat });
  useEffect(() => {
    latest.current = { view, click, mySeat };
  });
  const [agentSaid, setAgentSaid] = useState<string | null>(null);
  const bet = useCallback(
    async (action: "fold" | "call" | "raise", amount: number | undefined, words?: string, byAgent = false): Promise<boolean> => {
      const { view: at, click: send_, mySeat: seat } = latest.current;
      if (!at || seat === null || !session) return false;
      const owed = Math.min(at.chips[seat], Math.max(...at.bet) - at.bet[seat]);
      const line = words ?? (action === "fold" ? "folds" : action === "raise" ? `raises to ${amount}` : owed > 0 ? `calls ${owed}` : "checks");
      const keys = seatKeys(id, session.accountId);
      if (!keys) return false;
      const took = await send_(`Seat ${seat + 1}${byAgent ? "'s agent" : ""} ${line}`, seat, async () => send(session, await betCall(at, seat, action, amount, keys, store)));
      if (took && byAgent) setAgentSaid(line);
      return took;
    },
    [id, session, store],
  );
  const agentBet = useCallback((action: "fold" | "call" | "raise", amount?: number) => bet(action, amount, undefined, true), [bet]);
  const locked = sending || (view ? view.seq < lockUntil : true);

  // House seats are seated one after the other: each one is asked for once the one before shows at the table.
  const [seating, setSeating] = useState<string | null>(null);
  const seatHouses = async (models: string[]) => {
    for (const [at, model] of models.entries()) {
      setSeating(`${at + 1} of ${models.length}`);
      const before = latest.current.view ? seated(latest.current.view).length : 0;
      try {
        const played = await house.add(model);
        if (!played.played) {
          setRefused(`The house did not sit: ${played.why}`);
          break;
        }
        say(`A house seat sat down, betting by ${model === "rules" ? "the odds" : model}`, played.hash);
      } catch (error) {
        setRefused(`The house did not answer (${text(error)}).`);
        break;
      }
      for (let waited = 0; waited < 60 && (latest.current.view ? seated(latest.current.view).length : 0) <= before; waited++) await sleep(500);
    }
    setSeating(null);
  };
  const agent = useSeatAgent(id, view, mySeat, myCards, locked, agentBet, accountId);

  if (view === null) return <TableSettled id={id} result={result} log={log} you={accountId} houses={house.accounts ?? []} onBack={onBack} />;

  const shown = view ?? UNREAD;
  return (
    <>
      {!session && view && (
        <p className="pk-demo pt-signin">
          <strong>Watching.</strong> <em>Make a guest game account to take a free seat at this table.</em>
          <button type="button" onClick={onSignIn}>
            Make a guest game account
          </button>
        </p>
      )}
      <RoundTable
        id={id}
        view={shown}
        you={accountId}
        mySeat={mySeat}
        myCards={myCards}
        locked={locked || !view}
        doing={sending ? "Sending to the contract…" : doing}
        now={now}
        problems={[refused, trouble].filter(Boolean)}
        log={log}
        link={`${typeof window === "undefined" ? "" : window.location.origin}${ROUTE}?t=${id}`}
        explorer={explorerLink}
        characters={characters}
        reading={view === undefined}
        house={{
          seats: house.seats,
          accounts: house.accounts ?? [],
          canAdd: house.canAdd,
          thinking: house.thinking,
          last: house.last,
          models: house.models,
          defaultModel: house.defaultModel,
          seatModels: house.seatModels,
          seating,
        }}
        agent={{ ...agent, said: agentSaid }}
        on={{
          act: (action, amount, line) => void bet(action, amount ?? undefined, line),
          sit: () => {
            if (!session || !view) return;
            void click("Took a seat", undefined, () => takeSeat(session, id, BigInt(view.stake)));
          },
          // A free table is hosted by the server: it is asked to start it. Any other is started by its host's own call.
          start: () =>
            session &&
            view &&
            void click("Started the table", undefined, () => (isFreeStake(view) && view.host !== session.accountId ? startFreeTable(id) : startTable(session, id))),
          leave: () =>
            session &&
            void click(mySeat !== null && view?.dealt.includes(mySeat) ? "Asked to leave after this hand" : "Left the table and cashed out", mySeat ?? undefined, () =>
              leaveTable(session, id),
            ),
          callTime: () => session && void click("Called time on the late seats", undefined, () => callTime(session, id)),
          addHouse: (models) => {
            setRefused("");
            void seatHouses(models);
          },
        }}
      />
    </>
  );
}

/** What a seat may cost at a table opened here, in NEAR: the contract takes 0.1 and up; the page stops at 1. */
const STAKE_CHIPS = [0.1, 0.25, 0.5, 1];
const LARGEST_STAKE = 1;

/** What the table shows before it is read: nine empty seats. */
const UNREAD: TableView = {
  id: "",
  phase: "lobby",
  stake: STAKE.toString(),
  deposit: (STAKE + RECORD_FEE).toString(),
  host: "",
  feeBps: 0,
  players: [null, null, null, null, null, null],
  keys: [],
  turnSeconds: TURN_SECONDS,
  deadline: "0",
  chips: [0, 0, 0, 0, 0, 0],
  hand: 0,
  button: 0,
  dealt: [],
  key: "",
  shuffled: 0,
  street: 0,
  toAct: 0,
  awaited: [],
  put: [0, 0, 0, 0, 0, 0],
  bet: [0, 0, 0, 0, 0, 0],
  folded: [false, false, false, false, false, false],
  done: [],
  leaving: [false, false, false, false, false, false],
  sums: [],
  board: [],
  hole: [[], [], [], [], [], []],
  last: null,
  cashed: [],
  bets: 0,
  seq: 0,
};

export function TableSettled({
  id,
  result,
  log,
  you,
  houses,
  onBack,
  explorer = explorerLink,
}: {
  id: string;
  result: TableResult | null;
  log: LogLine[];
  you: string | null;
  houses: string[];
  onBack: () => void;
  explorer?: (hash: string) => string | null;
}) {
  const back = (
    <button type="button" className="pk-go" onClick={onBack}>
      Back to the tables
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
            <h2 className="pk-stub__title">Tables</h2>
            <p className="pk-small">Open a table of your own and send its link.</p>
            {back}
          </section>
        </div>
      </div>
    );
  }
  const who = (account: string) => (account === you ? "You" : houses.includes(account) ? `House ${houses.indexOf(account) + 1}` : account);
  const fees = result.cashed.reduce((sum, seat) => sum + BigInt(seat.fee), 0n);
  return (
    <div className="pk-hall">
      <div>
        <h1 className="pk-line">Table settled.</h1>
        <p className="pk-lede">
          Table <span className="pk-code">{id}</span> closed after {result.hands} {result.hands === 1 ? "hand" : "hands"}. Every seat was paid the chips it held when it left, by
          the contract
          {result.feeBps ? `, less a fee of ${result.feeBps / 100}% of what it won` : ", with no fee"}.
        </p>
        <section className="pk-board" aria-label="What the table paid">
          <h2 className="pk-board__title">
            <Seat size={22} /> <span>Paid by the contract</span>
          </h2>
          <ul className="pk-result pt-paid">
            {result.cashed.map((seat, at) => (
              <li key={`${seat.account}:${at}`}>
                <span className="pk-seat__face" style={{ "--seat": `var(--seat-${at % 9})` } as CSSProperties} aria-hidden="true">
                  {at + 1}
                </span>
                <span>
                  <small className="pk-label">{seat.chips} chips</small>
                  <strong title={seat.account}>{who(seat.account)}</strong>
                </span>
                <Flap text={seat.chips > 100 ? "AHEAD" : seat.chips === 100 ? "EVEN" : "BEHIND"} />
                <span className="pk-result__paid">
                  <b>{asNear(seat.payout).replace(" NEAR", "")}</b>
                  <small className="pk-label">{BigInt(seat.fee) > 0n ? `NEAR · fee ${asNear(seat.fee, 3).replace(" NEAR", "")}` : "NEAR"}</small>
                </span>
              </li>
            ))}
          </ul>
          {fees > 0n && <p className="pk-board__note">Fees kept by the contract: {asNear(fees)}.</p>}
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
