"use client";

// One poker table as it is drawn: a board with the route of the hand, the baize with its two seats, deck, board cards
// and pot, the action stub and the ledger. It only draws: what it shows comes from a match view, and every click goes
// back to the Table that talks to the chain (or to the demo, which talks to nothing).

import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { Chain, Clock, Copy, Out } from "@/components/landing/icons";
import { type MatchView, type Outcome, betOptions, holeAt, streetAt } from "../seat";
import { CardPlace, type Mark, PlayingCard } from "./Cards";

export type LogLine = { text: string; hash?: string; seat?: number };
export type Hole = { hand: number; cards: ((number | null)[] | null)[] };
/** What this page is working on for a seat right now: `shuffle`, `deal`, `open`, `show`, or a click's own word. */
export type Doing = { seat: number; what: string } | null;

export type TableActions = {
  act(seat: number, action: "fold" | "call" | "raise", amount: number | null, line: string): void;
  deal(): void;
  leave(): void;
  claim(): void;
  close(): void;
  take(): void;
};

export type TableProps = {
  id: string;
  view: MatchView;
  hole: Hole;
  /** The seats this browser holds. */
  mine: number[];
  /** Buttons are off: a call is on its way, or the page has not yet read the match it made. */
  locked: boolean;
  doing: Doing;
  /** The last hand this browser agreed to start. */
  dealt: number;
  /** Milliseconds, for the clock. */
  now: number;
  problems: string[];
  log: LogLine[];
  link: string;
  explorer: (hash: string) => string | null;
  stake: string;
  /** The match has not been read yet: the table is drawn empty. */
  reading?: boolean;
  on: TableActions;
};

const STREETS = ["Pre-flop", "Flop", "Turn", "River"];
const STOPS = ["Shuffle", "Shuffle", "Deal", ...STREETS, "Showdown"];
const seatColour = (seat: number) => ({ "--seat": `var(--seat-${seat})` }) as CSSProperties;

/** A word on a board, one flap a character; a character that changes drops in as a new flap. */
export function Flap({ text }: { text: string }) {
  return (
    <span className="pk-flap" role="img" aria-label={text}>
      {[...text].map((char, i) => (
        <i key={`${i}:${char}`} style={{ "--i": i } as CSSProperties} data-gap={char === " " || undefined} aria-hidden="true">
          {char}
        </i>
      ))}
    </span>
  );
}

/** Chips for an amount, largest first, as stacks of at most five. */
function Chips({ amount, stacks = 1 }: { amount: number; stacks?: number }) {
  const chips: number[] = [];
  let left = amount;
  for (const worth of [100, 25, 5, 1]) {
    while (left >= worth && chips.length < stacks * 5) {
      chips.push(worth);
      left -= worth;
    }
  }
  const columns: number[][] = [];
  for (let at = 0; at < chips.length; at += 5) columns.push(chips.slice(at, at + 5));
  return (
    <>
      {columns.map((column, at) => (
        <span key={at} className="pk-stack" aria-hidden="true">
          {column.map((worth, n) => (
            <i key={n} className="pk-chip" data-of={worth} />
          ))}
        </span>
      ))}
    </>
  );
}

const shortAccount = (account: string): string => (account.length > 24 ? `${account.slice(0, 8)}…${account.slice(-6)}` : account);

export const outcomeText = (outcome: Outcome, name: (seat: number) => string): string =>
  outcome === "split" ? "Split pot" : outcome === "void" ? "Void hand: a card did not decrypt" : `${name(outcome.won)} ${name(outcome.won) === "You" ? "win" : "wins"}`;

/** The step of the hand under way, as the route counts it, with its flap word. */
function stepOf(view: MatchView, resting: boolean): { stop: number; word: string } {
  if (view.phase === "lobby") return { stop: -1, word: "OPEN SEAT" };
  // A paid hand has passed every stop.
  if (resting) return { stop: STOPS.length, word: "HAND PAID" };
  if (view.phase === "shuffle") return { stop: view.shuffled, word: `SHUFFLE ${view.shuffled + 1}/2` };
  if (view.phase === "deal") return { stop: 2, word: "DEALING" };
  if (view.phase === "bet") return { stop: 3 + view.street, word: STREETS[view.street].toUpperCase() };
  if (view.phase === "open") return { stop: 3 + view.street, word: `OPEN ${STREETS[view.street].toUpperCase()}` };
  return { stop: 7, word: "SHOWDOWN" };
}

/** The seat whose move made `now` out of `before`, and the move in a word; `null` when the two views do not say. */
function lastMove(before: MatchView, now: MatchView): { seat: number; word: string } | null {
  // A read can skip several changes (shares, then a bet): a bet that rose is the move that matters. Not in the
  // shuffle or the deal, where the blinds are posted.
  if (before.phase !== "bet" && before.phase !== "shuffle" && before.phase !== "deal" && now.hand === before.hand) {
    const bettors = [0, 1].filter((seat) => now.put[seat] > before.put[seat]);
    if (bettors.length === 1) {
      const seat = bettors[0];
      return { seat, word: now.put[seat] > now.put[1 - seat] ? (now.chips[seat] === 0 ? "all in" : "raised") : "called" };
    }
  }
  if (before.phase === "bet") {
    const seat = before.toAct;
    const other = 1 - seat;
    if (now.hand !== before.hand) {
      const folded = now.last && typeof now.last.outcome === "object" && now.last.outcome.won === other && now.last.hole.every((cards) => cards.length === 0);
      return folded ? { seat, word: "folded" } : null;
    }
    const paid = now.put[seat] - before.put[seat];
    return { seat, word: paid === 0 ? "checked" : now.put[seat] > now.put[other] ? (now.chips[seat] === 0 ? "all in" : "raised") : "called" };
  }
  if (before.phase === "shuffle") return { seat: before.awaited[0], word: "shuffled" };
  const word = before.phase === "showdown" ? "showed" : "shares in";
  if (before.awaited.length === 1) return { seat: before.awaited[0], word };
  const done = now.phase === before.phase && now.hand === before.hand ? before.awaited.find((seat) => !now.awaited.includes(seat)) : undefined;
  return done === undefined ? null : { seat: done, word };
}

export function TableView({ id, view, hole, mine, locked, doing, dealt, now, problems, log, link, explorer, stake, reading = false, on }: TableProps) {
  // Cards that are on the table when the page first draws it lie still; later ones travel in from the deck.
  const [live, setLive] = useState(false);
  useEffect(() => setLive(true), []);
  // The seat that moved last keeps its move on its plate until the next change of the match.
  const before = useRef<MatchView | null>(null);
  const [moved, setMoved] = useState<{ seat: number; word: string } | null>(null);
  useEffect(() => {
    const earlier = before.current;
    before.current = view;
    if (earlier && earlier.seq !== view.seq && earlier.phase !== "lobby") setMoved(lastMove(earlier, view));
  }, [view]);

  const inLobby = view.phase === "lobby";
  const betweenHands = view.phase === "shuffle" && view.shuffled === 0 && view.hand > 0;
  const dealer = view.awaited[0];
  /** The hand before is paid and the next one has not begun: the table still shows the hand before. */
  const resting = betweenHands && !(mine.includes(dealer) && dealt >= view.hand);
  const last = view.last;
  const low = mine[0] ?? 0;
  const top = 1 - low;
  const name = (seat: number): string => (mine.length === 1 && mine[0] === seat ? "You" : `Seat ${seat + 1}`);
  const is = (seat: number): string => (name(seat) === "You" ? "You are" : `${name(seat)} is`);
  const { stop, word } = reading ? { stop: -1, word: "READING" } : stepOf(view, resting);
  const left = Math.round(Number(view.deadline) / 1e9 - now / 1000);
  const pot = view.put[0] + view.put[1];
  const token = (seat: number, at: number): boolean => Boolean(view.tokens?.[seat * 9 + at]);
  const hand = resting && last ? last.number : view.hand;

  const shown = (seat: number): (number | null | undefined)[] => {
    if (resting) return last && last.hole[seat]?.length === 2 ? last.hole[seat] : [];
    if (view.hole[seat]?.length === 2) return view.hole[seat];
    if (hole.hand === view.hand && hole.cards[seat]) return hole.cards[seat]!;
    return view.shuffled === 2 ? [undefined, undefined] : [];
  };

  // The five places of the board: a card face up, a card face down whose shares are coming in, or an empty place.
  const board: (number | undefined | "place")[] = [0, 1, 2, 3, 4].map((place) => {
    const cards = resting ? (last?.board ?? []) : view.board;
    if (place < cards.length) return cards[place];
    if (!resting && view.phase === "open" && streetAt(view.street).includes(4 + place)) return undefined;
    return "place";
  });
  const newest = !resting && view.phase !== "open" && view.board.length > 0 ? (view.street === 1 ? [0, 1, 2] : [view.board.length - 1]) : [];
  const waitingFor = view.awaited.map(name).join(" and ");

  let say: ReactNode = "";
  if (reading) say = "Asking the contract for this table…";
  else if (inLobby) say = mine.includes(0) ? "The table is open. It starts the moment a second seat is taken." : "This table has an open seat.";
  else if (resting && last)
    say = (
      <>
        Hand {last.number + 1}: {outcomeText(last.outcome, name)}
        {last.outcome === "void" ? "" : `, pot ${last.pot}`}. {mine.includes(dealer) ? "Deal the next hand when you are ready." : `${name(dealer)} deals the next hand.`}
      </>
    );
  else if (view.phase === "shuffle")
    say =
      doing?.what === "shuffle" ? (
        <>
          This page is shuffling for {name(doing.seat) === "You" ? "you" : name(doing.seat)} and proving the shuffle: a second or two of work, then one transaction of about 3 s.
        </>
      ) : (
        <>
          {is(dealer)} shuffling the deck (shuffle {view.shuffled + 1} of 2, about 5 s). The contract takes a deck only with a proof that it is an honest shuffle.
        </>
      );
  else if (view.phase === "deal") say = <>Dealing, about 3 s a seat: each seat sends the shares that unlock the other seat&apos;s two cards. Waiting for {waitingFor}.</>;
  else if (view.phase === "bet") {
    const owed = betOptions(view, view.toAct).owed;
    say = (
      <>
        {name(view.toAct) === "You" ? "Your turn" : `${name(view.toAct)} to act`} {["before the flop", "on the flop", "on the turn", "on the river"][view.street]}
        {owed > 0 ? `: ${owed} to call.` : ": no bet to call."}
      </>
    );
  } else if (view.phase === "open")
    say = (
      <>
        Turning the {STREETS[view.street].toLowerCase()}, about 9 s: a card turns when both seats&apos; shares of it are in. Waiting for {waitingFor}.
      </>
    );
  else if (view.phase === "showdown") say = <>Showdown, about 3 s a seat: each seat opens its own two cards. Waiting for {waitingFor}.</>;

  const seat = (at: "top" | "low", number: number) => {
    const free = inLobby && !view.players[number];
    const cards = shown(number);
    const won = resting && last && typeof last.outcome === "object" && last.outcome.won === number;
    const move = moved?.seat === number && !inLobby ? moved.word : null;
    return (
      <div className="pk-spot" data-at={at}>
        <div className="pk-seat" data-free={free || undefined} data-awaited={(!resting && view.awaited.includes(number)) || undefined} data-won={won || undefined} data-moved={move !== null || undefined} style={seatColour(number)}>
          <span className="pk-seat__face" aria-hidden="true">
            {number + 1}
          </span>
          {!inLobby && view.button === number && (
            <span className="pk-dealer" title="The button: this seat shuffles first and posts the small blind">
              D
            </span>
          )}
          <span className="pk-label">
            Seat {number + 1}
            {mine.includes(number) ? " · you" : ""}
          </span>
          <span className="pk-seat__chips">
            {free ? (
              <small>open seat</small>
            ) : (
              <>
                <b>{view.chips[number]}</b>
                {move ? <em>{move}</em> : <small title={view.players[number]}>{shortAccount(view.players[number] ?? "")}</small>}
              </>
            )}
          </span>
        </div>
        <div className="pk-hand" role="group" aria-label={`Seat ${number + 1}'s cards`}>
          {cards.map((card, index) => (
            <PlayingCard
              key={`${hand}:${number}:${index}`}
              card={card}
              dealt={live}
              order={index * 2 + (number === view.button ? 0 : 1)}
              marks={[0, 1].map((from): Mark => ({ seat: from, given: token(from, holeAt(number)[index]) }))}
            />
          ))}
        </div>
      </div>
    );
  };

  const bet = (at: "top" | "low", number: number) => (
    <span className="pk-bet" data-at={at} data-none={resting || view.bet[number] === 0 || undefined}>
      <Chips key={view.bet[number]} amount={view.bet[number]} />
      {view.bet[number]} <small>bet</small>
    </span>
  );

  return (
    <div className="pk-room">
      <div className="pk-stage">
        <section className="pk-board pk-table" aria-label={`Table ${id}`}>
          <header className="pk-table__head">
            <h1>
              <span>{reading ? "Table" : inLobby ? "New table" : `Hand ${hand + 1}`}</span>
            </h1>
            <p className="pk-table__facts">
              <span className="pk-code">{id}</span>
              <span>Blinds 1 and 2</span>
            </p>
            <p className="pk-table__now">
              <Flap text={word} />
              {!inLobby && !resting && (
                <span className="pk-clock" data-low={left < 30 || undefined} title="Time left for this step">
                  <Clock size={16} /> {left >= 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "time up"}
                </span>
              )}
            </p>
          </header>

          <ol className="pk-route" aria-label="The steps of a hand">
            {STOPS.map((label, at) => (
              <li key={at} data-at={stop < 0 ? undefined : at < stop ? "past" : at === stop ? "now" : undefined} aria-current={at === stop ? "step" : undefined}>
                {label}
              </li>
            ))}
          </ol>

          <div className="pk-baize">
            <div className="pk-baize__in">
              {seat("top", top)}
              {bet("top", top)}

              <div className="pk-deckcell">
                <span className="pk-deck" data-pk-deck data-shuffling={(view.phase === "shuffle" && !resting && !inLobby) || undefined} data-out={resting || inLobby || undefined} aria-hidden="true">
                  {[0, 1, 2, 3, 4, 5, 6, 7].map((n) => (
                    <i key={n} style={{ "--n": n } as CSSProperties} />
                  ))}
                </span>
                {!inLobby && !resting && (
                  <span className="pk-label" data-done={view.shuffled === 2 || undefined} title="Each seat shuffles the deck once; the contract checks the proof of each shuffle">
                    {[view.button, 1 - view.button].map((from, order) => (
                      <i key={from} className="pk-seal" data-given={view.shuffled > order || undefined} style={seatColour(from)} />
                    ))}
                    <em>{view.shuffled === 2 ? "proved" : `${view.shuffled}/2`}</em>
                  </span>
                )}
              </div>

              <div className="pk-cards" role="group" aria-label="The board">
                {board.map((card, place) =>
                  card === "place" ? (
                    <CardPlace key={`place:${place}`} />
                  ) : (
                    <PlayingCard
                      key={`${hand}:board:${place}`}
                      card={card}
                      dealt={live}
                      order={place < 3 ? place : 0}
                      lit={newest.includes(place)}
                      marks={[0, 1].map((from): Mark => ({ seat: from, given: token(from, 4 + place) }))}
                    />
                  ),
                )}
              </div>

              {resting && last ? (
                <div className="pk-pot" data-result>
                  <span className="pk-pot__sum">{outcomeText(last.outcome, name)}</span>
                  {last.outcome !== "void" && <span className="pk-label">pot {last.pot}</span>}
                </div>
              ) : (
                <div className="pk-pot" aria-label={`Pot ${pot}`}>
                  <span className="pk-pot__stacks">
                    <Chips key={pot - view.bet[0] - view.bet[1]} amount={Math.max(0, pot - view.bet[0] - view.bet[1])} stacks={3} />
                  </span>
                  <span className="pk-pot__sum" key={pot}>
                    {pot}
                  </span>
                  <span className="pk-label">pot</span>
                </div>
              )}

              {bet("low", low)}
              {seat("low", low)}
            </div>
          </div>

          <p className="pk-say" role="status">
            <span>{say}</span>
          </p>
          {/* The marks are explained while the page works on them: in the steps that need no bet. */}
          {!inLobby && !reading && !resting && view.phase !== "bet" && (
            <p className="pk-legend">
              {[0, 1].map((from) => (
                <span key={from}>
                  <i className="pk-seal" data-given style={seatColour(from)} /> Seat {from + 1}
                </span>
              ))}
              <span className="pk-legend__long">Filled: that seat&apos;s shuffle is proved (on the deck), or its share is in (on a card).</span>
              <span className="pk-legend__short">Filled: proved, or share in</span>
            </p>
          )}
        </section>

        <ActionStub key={`${view.hand}:${view.street}:${view.toAct}`} view={view} mine={mine} locked={locked} doing={doing} resting={resting} left={left} problems={problems} link={link} stake={stake} name={name} reading={reading} on={on} />
      </div>

      <aside className="pk-side">
        {last && !resting && (
          <div className="pk-ticket">
            <section className="pk-stub pk-last" aria-label="The hand before">
              <h2 className="pk-stub__title">Hand {last.number + 1}</h2>
              <p className="pk-small">
                {outcomeText(last.outcome, name)}
                {last.outcome === "void" ? "" : `, pot ${last.pot}`}.
              </p>
              <LastCards last={last} />
            </section>
          </div>
        )}
        <Ledger log={log} explorer={explorer} />
      </aside>
    </div>
  );
}

function LastCards({ last }: { last: NonNullable<MatchView["last"]> }) {
  const shownHands = [0, 1].filter((seat) => last.hole[seat]?.length === 2);
  if (last.board.length === 0 && shownHands.length === 0) return <p className="pk-fine">No card was turned.</p>;
  return (
    <p className="pk-last__cards">
      {last.board.length > 0 && (
        <span>
          <small>Board</small>
          {last.board.map((card, at) => (
            <PlayingCard key={at} card={card} />
          ))}
        </span>
      )}
      {shownHands.map((seat) => (
        <span key={seat}>
          <small>Seat {seat + 1}</small>
          {last.hole[seat].map((card, at) => (
            <PlayingCard key={at} card={card} />
          ))}
        </span>
      ))}
    </p>
  );
}

function ActionStub({
  view,
  mine,
  locked,
  doing,
  resting,
  left,
  problems,
  link,
  stake,
  name,
  reading,
  on,
}: {
  reading: boolean;
  view: MatchView;
  mine: number[];
  locked: boolean;
  doing: Doing;
  resting: boolean;
  left: number;
  problems: string[];
  link: string;
  stake: string;
  name: (seat: number) => string;
  on: TableActions;
}) {
  const [raiseTo, setRaiseTo] = useState("");
  const [copied, setCopied] = useState(false);
  const bettor = view.phase === "bet" && mine.includes(view.toAct) ? view.toAct : null;
  const options = bettor === null ? null : betOptions(view, bettor);
  const raise = options?.raise ?? null;
  const amount = raise ? Math.min(raise.max, Math.max(raise.min, Math.round(Number(raiseTo)) || raise.min)) : 0;
  const betweenHands = view.phase === "shuffle" && view.shuffled === 0 && view.hand > 0;
  const late = left < 0 && view.phase !== "lobby" && mine.length > 0 && view.awaited.some((seat) => !mine.includes(seat));
  const sending = doing && doing.seat < 0 ? doing.what : null;

  let title = "";
  let line: ReactNode = null;
  let body: ReactNode = null;

  if (reading) {
    title = "Reading the table";
    line = "One moment: the page is asking the contract what this table holds.";
  } else if (view.phase === "lobby") {
    if (mine.includes(0)) {
      title = "Waiting for an opponent";
      line = "Send this link. Whoever opens it can take the second seat.";
      body = (
        <>
          <div className="pk-link">
            <output aria-label="The link to this table">{link}</output>
            <button
              type="button"
              className="pk-pill pk-pill--ink"
              onClick={() => {
                void navigator.clipboard?.writeText(link).then(() => setCopied(true));
              }}
            >
              <Copy size={16} /> {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <div className="pk-acts">
            <button type="button" className="pk-pill pk-pill--quiet" disabled={locked} onClick={on.close}>
              Close the table and take the stake back
            </button>
          </div>
        </>
      );
    } else {
      title = "An open seat";
      line = "The stake buys 100 chips, and what you hold when the table closes is paid back by the contract. The seat also pays a record fee of 0.002 NEAR, which is not returned.";
      body = (
        <button type="button" className="pk-go" disabled={locked} onClick={on.take}>
          Take the seat for {stake}
        </button>
      );
    }
  } else if (bettor !== null && options) {
    const seat = bettor;
    title = mine.length === 1 ? "Your move" : `Seat ${seat + 1} to act`;
    line = options.owed > 0 ? `${options.owed} to call` : "Nothing to call";
    body = (
      <div className="pk-move">
        <button type="button" className="pk-pill" disabled={locked} onClick={() => on.act(seat, "fold", null, "folds")}>
          Fold
        </button>
        <button type="button" className="pk-go" disabled={locked} onClick={() => on.act(seat, "call", null, options.owed ? `calls ${options.owed}` : "checks")}>
          {options.owed ? `Call ${options.owed}` : "Check"}
        </button>
        {raise && (
          <div className="pk-raise">
            <input type="range" aria-label="Raise to" min={raise.min} max={raise.max} value={amount} disabled={locked || raise.min === raise.max} onChange={(event) => setRaiseTo(event.target.value)} />
            <input type="number" aria-label="Raise to, in chips" inputMode="numeric" min={raise.min} max={raise.max} value={raiseTo || raise.min} disabled={locked} onChange={(event) => setRaiseTo(event.target.value)} />
            <button type="button" className="pk-pill pk-pill--ink" disabled={locked} onClick={() => on.act(seat, "raise", amount, `raises to ${amount}`)}>
              Raise to {amount}
            </button>
            <button type="button" className="pk-pill" disabled={locked} onClick={() => on.act(seat, "raise", raise.max, `goes all in for ${raise.max}`)}>
              All in {raise.max}
            </button>
          </div>
        )}
      </div>
    );
  } else if (betweenHands && mine.length > 0) {
    const dealer = view.awaited[0];
    const mayDeal = mine.includes(dealer);
    title = resting ? `Hand ${view.hand} is paid` : "Shuffling";
    line = resting ? (mayDeal ? "Deal again, or leave with the chips you hold." : `${name(dealer)} deals the next hand. You can leave with the chips you hold.`) : "This page plays your seat's part of the step by itself. You are asked for bets only.";
    body = resting ? (
      <div className="pk-next">
        <button type="button" className="pk-pill pk-pill--quiet" disabled={locked} onClick={on.leave}>
          Leave and cash out
        </button>
        {mayDeal && (
          <button type="button" className="pk-go" disabled={locked} onClick={on.deal}>
            Deal hand {view.hand + 1}
          </button>
        )}
      </div>
    ) : null;
  } else if (mine.length === 0) {
    title = "Watching";
    line = "This browser holds no seat at this table.";
  } else if (view.phase === "bet") {
    title = `${name(view.toAct)} to act`;
    line = "The table is waiting for the other seat's bet.";
  } else {
    title = view.phase === "shuffle" ? "Shuffling" : view.phase === "deal" ? "Dealing" : view.phase === "open" ? `Turning the ${STREETS[view.street].toLowerCase()}` : "Showdown";
    line = "This page plays your seat's part of the step by itself. You are asked for bets only.";
  }

  return (
    <div className="pk-ticket pk-desk">
      <section className="pk-stub" aria-label="Your move">
        <div className="pk-desk__head">
          <h2 className="pk-stub__title">{title}</h2>
          {line && (
            <p className="pk-small" data-long={(typeof line === "string" && line.length > 28) || undefined}>
              {line}
            </p>
          )}
        </div>
        {body}
        {late && (
          <div className="pk-acts">
            <p className="pk-small">The other seat ran out of time.</p>
            <button type="button" className="pk-pill pk-pill--ink" disabled={locked} onClick={on.claim}>
              Claim the table
            </button>
          </div>
        )}
        {sending && (
          <p className="pk-fine" role="status">
            {sending}
          </p>
        )}
        {problems.map((problem) => (
          <p key={problem} className="pk-problem" role="alert">
            {problem}
          </p>
        ))}
      </section>
    </div>
  );
}

const LEDGER_LINES = 6;

export function Ledger({ log, explorer }: { log: LogLine[]; explorer: (hash: string) => string | null }) {
  return (
    <section className="pk-board pk-ledger" aria-label="Transactions sent from this browser">
      <h2 className="pk-board__title">
        <Chain size={22} /> <span>Transactions</span>
      </h2>
      {log.length === 0 ? (
        <p className="pk-board__note">Nothing sent from this browser yet. Every shuffle, share and bet this page sends is listed here with its transaction.</p>
      ) : (
        <ol reversed>
          {log.map((line, index) => {
            const href = line.hash ? explorer(line.hash) : null;
            return (
              <li key={log.length - index}>
                <span>{log.length - index}</span>
                <b style={line.seat === undefined ? undefined : ({ "--seat": `var(--seat-${line.seat})` } as CSSProperties)}>{line.text}</b>
                {href ? (
                  <a href={href} target="_blank" rel="noreferrer noopener" aria-label={`Transaction ${line.hash}, opens the explorer`}>
                    {line.hash!.slice(0, 8)}… <Out size={12} />
                  </a>
                ) : (
                  line.hash && <span className="pk-code">{line.hash.slice(0, 8)}…</span>
                )}
              </li>
            );
          })}
          {/* A board is never short: the lines not yet written stand ruled and blank. */}
          {Array.from({ length: Math.max(0, LEDGER_LINES - log.length) }, (_, at) => (
            <li key={`blank:${at}`} data-blank aria-hidden="true" />
          ))}
        </ol>
      )}
    </section>
  );
}
