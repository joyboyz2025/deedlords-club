"use client";

// Deedlords Poker in plain HTML: a lobby and one table. The page plays a seat's part of the protocol by itself (its
// shuffles, its decryption shares, the opening of its shuffles) and asks the player for the bets only.

import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@/lib/chain/client";
import { CHAIN } from "@/lib/chain/config";
import { signInAsGuest } from "../../co-ty-phu/chain/keySession";
import { POKER_CONTRACT, STAKE, type Result, explorerLink, openTable, pokerClient, pokerSession, readMatch, seatKeys, seatStore, send, takeSeat, viewResult } from "../chain";
import { type MatchView, type Outcome, betOptions, duty, holeCards } from "../seat";

const inNear = (yocto: string | bigint): string => `${(Number(BigInt(yocto) / 10n ** 20n) / 10_000).toFixed(4)} NEAR`;
const text = (error: unknown) => (error instanceof Error ? error.message : String(error));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const page: CSSProperties = { minHeight: "100vh", background: "#fff", color: "#111", font: "16px/1.5 system-ui, sans-serif", padding: "16px", maxWidth: 760, margin: "0 auto" };
const cell: CSSProperties = { border: "1px solid #999", padding: "6px 10px", textAlign: "left" };
const button: CSSProperties = { font: "inherit", padding: "6px 12px", marginRight: 8, marginBottom: 8 };
const cardBox: CSSProperties = { display: "inline-block", minWidth: 34, padding: "2px 4px", marginRight: 4, border: "1px solid #555", borderRadius: 4, textAlign: "center", fontWeight: 700, background: "#fafafa" };

/** A card face; `undefined` is a card face down, `null` a deck position that decrypted to no card. */
function Card({ card }: { card: number | null | undefined }) {
  if (card === undefined) return <span style={cardBox}>??</span>;
  if (card === null) return <span style={{ ...cardBox, color: "#b00020" }}>!!</span>;
  const suit = Math.floor(card / 13);
  return (
    <span style={{ ...cardBox, color: suit === 1 || suit === 2 ? "#b00020" : "#111" }}>
      {"23456789TJQKA"[card % 13]}
      {"♣♦♥♠"[suit]}
    </span>
  );
}

const Cards = ({ cards }: { cards: (number | null | undefined)[] }) => (
  <>
    {cards.map((card, index) => (
      <Card key={index} card={card} />
    ))}
  </>
);

const outcomeText = (outcome: Outcome): string => (outcome === "split" ? "split pot" : outcome === "void" ? "void: a card did not decrypt" : `seat ${outcome.won + 1} wins`);

const DOING: Record<string, string> = { shuffle: "shuffling and re-encrypting the deck", deal: "sending its shares of the other seat's hole cards", open: "sending its shares of the board cards", show: "showing its hole cards", audit: "opening its shuffle for the audit" };

export function PokerScreen() {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [table, setTable] = useState<{ id: string; seq: number } | null>(null);

  useEffect(() => {
    setSession(pokerSession());
    const id = new URLSearchParams(window.location.search).get("m");
    if (id) setTable({ id, seq: 0 });
    setReady(true);
  }, []);

  const show = (next: { id: string; seq: number } | null) => {
    window.history.replaceState(null, "", next ? `/poker?m=${next.id}` : "/poker");
    setTable(next);
  };

  return (
    <main style={page}>
      <h1 style={{ fontSize: 26, margin: "0 0 4px" }}>Deedlords Poker</h1>
      <p style={{ marginTop: 0 }}>
        Heads-up Texas Hold&apos;em on NEAR {CHAIN.network} with no dealer. The two seats shuffle and deal the deck with their own keys; the contract <code>{POKER_CONTRACT}</code> checks every card they turn and, after each
        hand, every shuffle.
      </p>
      {!ready ? null : !session ? (
        <button
          type="button"
          style={button}
          onClick={() => {
            signInAsGuest();
            setSession(pokerSession());
          }}
        >
          Make a guest game account
        </button>
      ) : table ? (
        <Table key={table.id} id={table.id} firstSeq={table.seq} session={session} onBack={() => show(null)} />
      ) : (
        <Lobby session={session} onSeated={(id, seq) => show({ id, seq })} />
      )}
    </main>
  );
}

function Lobby({ session, onSeated }: { session: Session; onSeated: (id: string, seq: number) => void }) {
  const [balance, setBalance] = useState<bigint | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    const read = () => pokerClient.balance(session.accountId).then(setBalance, () => undefined);
    void read();
    const timer = setInterval(read, 6_000);
    return () => clearInterval(timer);
  }, [session]);

  const open = async (bothSeats: boolean) => {
    setBusy(true);
    setNote("Sending to the contract…");
    try {
      // The match has changed once when it is created, twice when both seats are taken.
      onSeated(await openTable(session, bothSeats), bothSeats ? 2 : 1);
    } catch (error) {
      setNote(text(error));
      setBusy(false);
    }
  };

  return (
    <section>
      <p>
        Your game account: <code style={{ wordBreak: "break-all" }}>{session.accountId}</code>
        <br />
        Balance: {balance === undefined ? "reading…" : balance === null ? "0 (nothing has been sent to it yet)" : inNear(balance)}
      </p>
      <p>
        A seat costs {inNear(STAKE)} of test NEAR for 100 chips; blinds are 1 and 2. Keep about 0.5 NEAR in the account: a hand costs a seat about 0.02 NEAR of gas, nearly all of it for the check of its shuffle, and that call must
        be able to reserve 0.18 NEAR before it is sent.
      </p>
      <p>
        <button type="button" style={button} disabled={busy} onClick={() => open(true)}>
          Play both seats in this browser
        </button>
        <button type="button" style={button} disabled={busy} onClick={() => open(false)}>
          Open a table for a friend
        </button>
      </p>
      <p>{note}</p>
    </section>
  );
}

function Table({ id, firstSeq, session, onBack }: { id: string; firstSeq: number; session: Session; onBack: () => void }) {
  /** `undefined`: not read yet. `null`: the match is gone (settled, or there never was one). */
  const [view, setView] = useState<MatchView | null | undefined>(undefined);
  const [result, setResult] = useState<Result | null>(null);
  const [hole, setHole] = useState<{ hand: number; cards: ((number | null)[] | null)[] }>({ hand: -1, cards: [null, null] });
  const [log, setLog] = useState<{ text: string; hash?: string }[]>([]);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  /** After a click the buttons stay off until the page has read the match that click made. */
  const [lockUntil, setLockUntil] = useState(0);
  const [raiseTo, setRaiseTo] = useState("");
  /** The next view must be at least this change of the match. */
  const seq = useRef(firstSeq);
  /** The last hand this browser agreed to start. Later hands wait for a click, so a seat can leave between hands. */
  const dealt = useRef(0);
  const store = useMemo(() => seatStore(id), [id]);
  const say = useCallback((line: string, hash?: string) => setLog((lines) => [{ text: line, hash }, ...lines].slice(0, 60)), []);
  const seatsOf = useCallback((now: MatchView) => [0, 1].filter((seat) => now.players[seat] === session.accountId && seatKeys(id, seat) !== null), [id, session]);

  useEffect(() => {
    let alive = true;
    const run = async () => {
      while (alive) {
        try {
          const now = await readMatch(id, seq.current, () => alive);
          if (!alive) return;
          if (!now) {
            setResult(await viewResult(id));
            setView(null);
            return;
          }
          // A bet sent while this read was under way made the match newer than what was read.
          if (now.seq < seq.current) continue;
          seq.current = now.seq;
          setView(now);
          const mine = seatsOf(now);
          if (now.shuffled === 2 && mine.length > 0) {
            const deck = await store.deck(now.hand, 1);
            const cards = [0, 1].map((seat) => (mine.includes(seat) ? holeCards(now, seat, seatKeys(id, seat)!, deck) : null));
            if (alive) setHole({ hand: now.hand, cards });
          }
          const seat = mine.find((candidate) => now.awaited.includes(candidate));
          const waitsForClick = now.phase === "shuffle" && now.shuffled === 0 && now.hand > dealt.current;
          if (seat !== undefined && now.phase !== "bet" && now.phase !== "lobby" && !waitsForClick) {
            const call = await duty(now, seat, seatKeys(id, seat)!, store);
            if (call && alive) {
              setNote(`Seat ${seat + 1} is ${DOING[call.method]}…`);
              const outcome = await send(session, call);
              seq.current = Math.max(seq.current, now.seq + 1);
              say(`Seat ${seat + 1}: ${call.method}`, outcome.hash);
              setNote("");
              continue;
            }
          }
        } catch (error) {
          if (!alive) return;
          setNote(text(error));
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
  const click = async (line: string, method: string, args: Record<string, unknown>): Promise<boolean> => {
    if (!view) return false;
    setSending(true);
    setNote("Sending to the contract…");
    try {
      const outcome = await send(session, { method, args: { id, ...args } });
      seq.current = Math.max(seq.current, view.seq + 1);
      setLockUntil(view.seq + 1);
      say(line, outcome.hash);
      setNote("");
      return true;
    } catch (error) {
      setNote(text(error));
      return false;
    } finally {
      setSending(false);
    }
  };

  if (view === undefined) return <p>Reading table {id}… {note}</p>;
  if (view === null) {
    return (
      <section>
        {result ? (
          <p>
            Table <code>{id}</code> is settled after {result.hands} {result.hands === 1 ? "hand" : "hands"} ({result.reason}). Chips {result.chips[0]} : {result.chips[1]}. Paid by the contract: {inNear(result.payouts[0])} to
            seat 1, {inNear(result.payouts[1])} to seat 2.
          </p>
        ) : (
          <p>
            There is no table <code>{id}</code>.
          </p>
        )}
        <button type="button" style={button} onClick={onBack}>
          Back to the lobby
        </button>
        <Log lines={log} />
      </section>
    );
  }

  const mine = seatsOf(view);
  const locked = sending || view.seq < lockUntil;
  const left = Math.round(Number(view.deadline) / 1e9 - Date.now() / 1000);
  const streetName = ["before the flop", "on the flop", "on the turn", "on the river"][view.street];
  const shown = (seat: number): (number | null | undefined)[] => {
    if (view.hole[seat]?.length === 2) return view.hole[seat];
    if (hole.hand === view.hand && hole.cards[seat]) return hole.cards[seat]!;
    return view.shuffled === 2 ? [undefined, undefined] : [];
  };

  let status = "";
  if (view.phase === "shuffle") status = `Seat ${view.awaited[0] + 1} is to shuffle the deck (shuffle ${view.shuffled + 1} of 2).`;
  if (view.phase === "deal") status = "Dealing: each seat sends the other its share of the hole cards.";
  if (view.phase === "bet") status = `Seat ${view.toAct + 1} to act ${streetName}.`;
  if (view.phase === "open") status = `Turning the ${["", "flop", "turn", "river"][view.street]}: both seats send their shares of it.`;
  if (view.phase === "showdown") status = "Showdown: both seats show their hole cards.";
  if (view.phase === "audit" && view.outcome) status = `The hand is over (${outcomeText(view.outcome)}). Both seats open their shuffles before any chip moves.`;

  const bettor = view.phase === "bet" && mine.includes(view.toAct) ? view.toAct : null;
  const options = bettor === null ? null : betOptions(view, bettor);
  const raise = options?.raise ?? null;
  const raiseAmount = raise ? Math.min(raise.max, Math.max(raise.min, Number(raiseTo) || raise.min)) : 0;
  const betweenHands = view.phase === "shuffle" && view.shuffled === 0 && view.hand > 0;

  return (
    <section>
      <p>
        Table <code>{id}</code>, hand {view.hand + 1}, pot <b>{view.put[0] + view.put[1]}</b>. {view.phase !== "lobby" && (left >= 0 ? `${left} s left for this step.` : "The time for this step is over.")}
      </p>

      {view.phase === "lobby" ? (
        mine.includes(0) ? (
          <p>
            Waiting for an opponent. Send this link: <code style={{ wordBreak: "break-all" }}>{`${window.location.origin}/poker?m=${id}`}</code>
            <br />
            <button
              type="button"
              style={{ ...button, marginTop: 8 }}
              disabled={locked}
              onClick={async () => {
                if (await click("The table was closed", "leave", {})) onBack();
              }}
            >
              Close the table and take the stake back
            </button>
          </p>
        ) : (
          <p>
            <button
              type="button"
              style={button}
              disabled={locked}
              onClick={async () => {
                setSending(true);
                setNote("Sending to the contract…");
                try {
                  const outcome = await takeSeat(session, id, BigInt(view.stake));
                  seq.current = Math.max(seq.current, view.seq + 1);
                  say("Seat 2: join", outcome.hash);
                  setNote("");
                } catch (error) {
                  setNote(text(error));
                } finally {
                  setSending(false);
                }
              }}
            >
              Take the seat for {inNear(view.stake)}
            </button>
          </p>
        )
      ) : (
        <>
          <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: 12 }}>
            <thead>
              <tr>
                {["Seat", "Chips", "Bet", "Cards"].map((heading) => (
                  <th key={heading} style={cell}>
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[0, 1].map((seat) => (
                <tr key={seat} style={{ background: view.awaited.includes(seat) ? "#fff7d6" : undefined }}>
                  <td style={cell}>
                    <b>Seat {seat + 1}</b>
                    {mine.includes(seat) ? " (you)" : ""}
                    {view.button === seat ? " · button" : ""}
                    <br />
                    <small style={{ wordBreak: "break-all" }}>{view.players[seat].length > 24 ? `${view.players[seat].slice(0, 10)}…${view.players[seat].slice(-6)}` : view.players[seat]}</small>
                  </td>
                  <td style={cell}>{view.chips[seat]}</td>
                  <td style={cell}>{view.bet[seat]}</td>
                  <td style={cell}>
                    <Cards cards={shown(seat)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            Board: {view.board.length ? <Cards cards={view.board} /> : "no cards yet"}
          </p>
          <p>
            <b>{status}</b>
          </p>

          {bettor !== null && options && (
            <p>
              <button type="button" style={button} disabled={locked} onClick={() => click(`Seat ${bettor + 1} folds`, "act", { seat: bettor, action: "fold", amount: null })}>
                Fold
              </button>
              <button type="button" style={button} disabled={locked} onClick={() => click(`Seat ${bettor + 1} ${options.owed ? `calls ${options.owed}` : "checks"}`, "act", { seat: bettor, action: "call", amount: null })}>
                {options.owed ? `Call ${options.owed}` : "Check"}
              </button>
              {raise && (
                <>
                  <input type="number" min={raise.min} max={raise.max} value={raiseTo || raise.min} onChange={(event) => setRaiseTo(event.target.value)} style={{ font: "inherit", width: 80, padding: 5, marginRight: 4 }} />
                  <button type="button" style={button} disabled={locked} onClick={() => click(`Seat ${bettor + 1} raises to ${raiseAmount}`, "act", { seat: bettor, action: "raise", amount: raiseAmount })}>
                    Raise to {raiseAmount}
                  </button>
                  <button type="button" style={button} disabled={locked} onClick={() => click(`Seat ${bettor + 1} goes all in for ${raise.max}`, "act", { seat: bettor, action: "raise", amount: raise.max })}>
                    All in ({raise.max})
                  </button>
                </>
              )}
            </p>
          )}

          {betweenHands && mine.length > 0 && (
            <p>
              {mine.includes(view.awaited[0]) && (
                <button
                  type="button"
                  style={button}
                  disabled={locked}
                  onClick={() => {
                    dealt.current = view.hand;
                  }}
                >
                  Deal hand {view.hand + 1}
                </button>
              )}
              <button type="button" style={button} disabled={locked} onClick={() => click("Left the table", "leave", {})}>
                Leave the table and cash out
              </button>
            </p>
          )}

          {left < 0 && view.awaited.some((seat) => !mine.includes(seat)) && mine.length > 0 && (
            <p>
              <button type="button" style={button} disabled={locked} onClick={() => click("Claimed the table after the deadline", "timeout", {})}>
                The other seat ran out of time: claim the table
              </button>
            </p>
          )}

          {view.last && (
            <p>
              Hand {view.last.number + 1}: {outcomeText(view.last.outcome)}, pot {view.last.pot}. Board {view.last.board.length ? <Cards cards={view.last.board} /> : "not reached"}
              {view.last.hole.some((cards) => cards.length === 2) && (
                <>
                  ; seat 1 <Cards cards={view.last.hole[0]} /> seat 2 <Cards cards={view.last.hole[1]} />
                </>
              )}
            </p>
          )}
        </>
      )}

      <p style={{ color: "#555", minHeight: 24 }}>{note}</p>
      <Log lines={log} />
    </section>
  );
}

function Log({ lines }: { lines: { text: string; hash?: string }[] }) {
  if (lines.length === 0) return null;
  return (
    <>
      <h2 style={{ fontSize: 16, marginBottom: 4 }}>Transactions</h2>
      <ol reversed style={{ margin: 0, paddingLeft: 28, fontSize: 14 }}>
        {lines.map((line, index) => {
          const link = line.hash ? explorerLink(line.hash) : null;
          return (
            <li key={`${lines.length - index}`}>
              {line.text}{" "}
              {link ? (
                <a href={link} target="_blank" rel="noreferrer noopener">
                  {line.hash!.slice(0, 8)}…
                </a>
              ) : (
                line.hash && <code>{line.hash.slice(0, 8)}…</code>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}
