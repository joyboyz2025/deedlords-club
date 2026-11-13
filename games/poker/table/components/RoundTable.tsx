"use client";

// A Deedlords Poker table of two to nine seats, as it is drawn: a board with the hand's route, an oval of red baize
// with the seats around its rail clockwise in seat order (this browser's seat at the foot), the board and the pot in
// the middle, the action stub under it and the hand before, who has been paid and the ledger beside it. It only
// draws: what it shows comes from a table view, every click goes back to whoever feeds it (the live table or the demo).

import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { Bot, Clock, Copy, Seat as SeatIcon } from "@/components/landing/icons";
import type { Character } from "../../../chibi/chain";
import { useLookPictures } from "../../../chibi/useChibi";
import { lookFromSeat } from "../../../ma-soi/look";
import { CardPlace, PlayingCard } from "../../components/Cards";
import { Ledger, type LogLine } from "../../components/TableView";
import type { Advice } from "../../agent/decide";
import { type TableView, betOptions, nextDealt, seated } from "../seat";

const FACE_PX = 112;
const seatColour = (seat: number) => ({ "--seat": `var(--seat-${seat})` }) as CSSProperties;
export const shortAccount = (account: string): string => (account.length > 22 ? `${account.slice(0, 7)}…${account.slice(-5)}` : account);
const asNear = (yocto: string | bigint): string => `${(Number(BigInt(yocto) / 10n ** 20n) / 10_000).toFixed(3)} NEAR`;

export type TableActions = {
  act(action: "fold" | "call" | "raise", amount: number | null, line: string): void;
  sit(): void;
  start(): void;
  leave(): void;
  callTime(): void;
  /** Seats house accounts, one after the other, each betting by its model. */
  addHouse(models: string[]): void;
  /** Back to the wall of tables. The table goes on without the page. */
  back?(): void;
};

export type HouseAtTable = {
  seats: number[];
  accounts: string[];
  canAdd: boolean;
  /** The models a house seat may bet by ("rules": the odds alone), the one it gets when none is chosen, and each house seat's. */
  models: string[];
  defaultModel: string | null;
  seatModels: Record<number, string>;
  /** House seats being seated now: "2 of 3", or `null`. */
  seating?: string | null;
  thinking: boolean;
  /** The house's last bet. `sealed`: what it thought is kept until the hand is over (it names its cards). */
  last: { seat?: number; what: string; driver?: string; sealed?: boolean } | null;
  /** What the house's seats thought in the hand before this one, opened now that it is over. */
  opened?: { hand: number; seat: number; what: string; reason: string; driver?: string }[];
};
export type AgentAtTable = { on: boolean; toggle: () => void; thinking: boolean; last: Advice | null; name: string; model: string; said: string | null };

export type RoundTableProps = {
  id: string;
  view: TableView;
  /** This browser's account, and its seat here (`null`: it does not sit at this table). */
  you: string | null;
  mySeat: number | null;
  /** This seat's own two cards, as the page decrypted them (`null`: not yet). */
  myCards: (number | null)[] | null;
  locked: boolean;
  /** What the page is sending or working on, in a few words. */
  doing: string | null;
  now: number;
  problems: string[];
  log: LogLine[];
  link: string;
  explorer: (hash: string) => string | null;
  /** The seats' chibi characters, by account. */
  characters?: Map<string, Character | null>;
  house?: HouseAtTable;
  agent?: AgentAtTable;
  /** The match has not been read yet. */
  reading?: boolean;
  on: TableActions;
};

/** The button and the blinds of the hand under way, or of the next hand while it has not begun. */
function places(view: TableView): { order: number[]; button: number | null; small: number | null; big: number | null } {
  const order = view.dealt.length ? view.dealt : view.phase === "lobby" ? [] : nextDealt(view);
  if (order.length < 2) return { order, button: order[0] ?? null, small: null, big: null };
  return order.length === 2 ? { order, button: order[0], small: order[0], big: order[1] } : { order, button: order[0], small: order[1], big: order[2] };
}

/**
 * While a hand is being made ready, how far it has come: the seats that have shuffled, then the seats that have dealt.
 * `null` once the cards are out: from then on the board says where the hand is, as in any poker app.
 */
function readying(view: TableView): string | null {
  const of = view.dealt.length || nextDealt(view).length;
  if (view.phase === "shuffle") return `Shuffling: ${Math.min(view.shuffled, of)} of ${of} seats`;
  if (view.phase === "deal") return `Dealing: ${view.dealt.filter((seat) => view.done[seat]).length} of ${of} seats`;
  return null;
}

/** Where a seat sits on the rail: this browser's seat at the foot, the others clockwise in seat order. */
function railAt(seat: number, foot: number, count: number): { x: number; y: number; angle: number } {
  const angle = Math.PI / 2 + ((seat - foot + count) % count) * ((2 * Math.PI) / count);
  return { x: 50 + 50 * Math.cos(angle), y: 50 + 50 * Math.sin(angle), angle };
}

/** Chips for an amount, largest first, as one stack of at most five. */
function Chips({ amount }: { amount: number }) {
  const chips: number[] = [];
  let left = amount;
  for (const worth of [100, 25, 5, 1]) {
    while (left >= worth && chips.length < 5) {
      chips.push(worth);
      left -= worth;
    }
  }
  return (
    <span className="pk-stack" aria-hidden="true">
      {chips.map((worth, n) => (
        <i key={n} className="pk-chip" data-of={worth} />
      ))}
    </span>
  );
}

/** What a house seat or an agent said for its last bet, on the action stub's paper. */
export function Voice({
  who,
  what,
  reason,
  driver,
  seat,
  problem,
  sealed,
}: {
  who: string;
  what: string;
  reason?: string;
  driver?: string;
  seat: number;
  problem?: string;
  /** What it thought is not shown yet: said so, so that the silence is not taken for a missing answer. */
  sealed?: boolean;
}) {
  return (
    <figure className="pk-voice" data-paper style={seatColour(seat)}>
      <figcaption>
        <Bot size={16} /> <b>{who}</b> {what}
      </figcaption>
      {reason && <blockquote title={reason}>{reason}</blockquote>}
      {(driver || problem) && (
        <small>
          {problem ? `The model failed (${problem}); the odds answered.` : driver === "the book" ? "Decided by the odds." : `Decided by ${driver}.`} It saw only its own two cards.
          {sealed ? " What it thought is sealed until this hand is over: it would give its cards away." : ""}
        </small>
      )}
    </figure>
  );
}

/** The house reports a bet as a bare verb ("check", "raise to 6"); a note says it in the past. */
const done = (what: string): string =>
  what.replace(/^(check|call|fold|raise)\b/, (verb) => ({ check: "checked", call: "called", fold: "folded", raise: "raised" })[verb as "check"]);

/** A model's name as a player reads it. */
export const modelName = (model: string): string => (model === "rules" ? "the odds" : model);

export function RoundTable({ id, view, you, mySeat, myCards, locked, doing, now, problems, log, link, explorer, characters, house, agent, reading = false, on }: RoundTableProps) {
  // Cards on the table when it is first drawn lie still; later ones travel in from the deck.
  const [live, setLive] = useState(false);
  useEffect(() => setLive(true), []);
  // The button this browser pressed, until the chain has answered: the call it sent landed (the buttons unlock once
  // the table is read past it) or was refused. What it shows meanwhile is drawn from it, never from a timer.
  const [pressed, setPressed] = useState<Pressed | null>(null);
  const wasLocked = useRef(false);
  useEffect(() => {
    if (wasLocked.current && !locked) setPressed(null);
    wasLocked.current = locked;
  }, [locked]);
  // Asking for a house seat goes to this server, not through the locked buttons: it is over when the table changes.
  useEffect(() => {
    setPressed((before) => (before?.key === "house" ? null : before));
  }, [view.seq]);
  const problemsKey = problems.join("|");
  useEffect(() => {
    if (problemsKey) setPressed(null);
  }, [problemsKey]);

  const count = view.players.length;
  const foot = mySeat ?? 0;
  const houseSeats = house?.seats ?? [];
  const inLobby = view.phase === "lobby";
  const inHand = !inLobby && view.dealt.length > 0;
  const { order, button, small, big } = places(view);
  const progress = reading ? null : readying(view);
  const left = Math.round(Number(view.deadline) / 1e9 - now / 1000);
  /** What is left of the step's time, from 1 to 0, for the clock under the seat the table waits for. */
  const clock = Math.max(0, Math.min(1, left / Math.max(1, view.turnSeconds)));
  // The deck lies before the seat that is shuffling it, or before the button between shuffles.
  const deckSeat = view.phase === "shuffle" ? (view.awaited[0] ?? button) : button;
  const deckAt = deckSeat === null ? null : railAt(deckSeat, foot, count);
  const pot = view.put.reduce((sum, chips) => sum + chips, 0);
  const bets = view.bet.reduce((sum, chips) => sum + chips, 0);

  const looks = view.players.map((player, seat) => (player ? (!houseSeats.includes(seat) && characters?.get(player)?.look) || lookFromSeat(seat) : null));
  const faces = useLookPictures(looks, FACE_PX);
  /** Who sits at a seat, in a word or two. */
  const name = (seat: number): string => {
    const player = view.players[seat];
    if (!player) return "Free seat";
    if (seat === mySeat) return "You";
    const houseIndex = house?.accounts.indexOf(player) ?? -1;
    if (houseIndex >= 0) return `House ${houseIndex + 1}`;
    return characters?.get(player)?.name || shortAccount(player);
  };
  /** The same inside a sentence. */
  const named = (seat: number): string => (seat === mySeat ? "you" : name(seat));
  const waitingFor = view.awaited.map(named);
  const waitingText = waitingFor.length > 3 ? `${waitingFor.length} seats` : waitingFor.join(" and ");

  const cardsOf = (seat: number): (number | null | undefined)[] => {
    if (!inHand || !view.dealt.includes(seat) || view.phase === "shuffle" || view.phase === "deal") return [];
    if (view.hole[seat]?.length === 2) return view.hole[seat];
    if (seat === mySeat && myCards) return myCards;
    if (view.folded[seat]) return [];
    return [undefined, undefined];
  };

  let say: ReactNode;
  const filled = seated(view).length;
  if (reading) say = "Asking the contract for this table…";
  else if (inLobby)
    say =
      filled < 2
        ? `${filled} of ${count} seats taken. The table starts when it is full, or when its host starts it with two or more.`
        : `${filled} of ${count} seats taken. The host can start now, or wait for the table to fill.`;
  else if (view.phase === "shuffle")
    say = (
      <>
        {doing === "shuffle"
          ? "This page is shuffling for you and proving the shuffle: a second or two of work, then one transaction."
          : `Each seat shuffles the deck once with its own key, about 5 s each. Waiting for ${waitingText}.`}
      </>
    );
  else if (view.phase === "deal") say = `Each seat sends the shares that unlock the others' cards. Waiting for ${waitingText}.`;
  else if (view.phase === "bet") {
    const owed = betOptions(view, view.toAct).owed;
    say = `${view.toAct === mySeat ? "Your turn" : `${name(view.toAct)} to act`}${owed > 0 ? `: ${owed} to call.` : ": no bet to call."}`;
  } else if (view.phase === "open") say = `Turning the next card${view.street === 1 ? "s" : ""}: a card turns when every seat's share of it is in. Waiting for ${waitingText}.`;
  else say = `Showdown: each seat still in opens its own two cards. Waiting for ${waitingText}.`;

  const seatPod = (seat: number) => {
    const player = view.players[seat];
    const at = railAt(seat, foot, count);
    const free = !player;
    const out = !free && !inLobby && inHand && !view.dealt.includes(seat);
    const folded = inHand && view.folded[seat];
    const allIn = inHand && view.dealt.includes(seat) && !view.folded[seat] && view.chips[seat] === 0;
    const isHouse = houseSeats.includes(seat);
    const thinking = isHouse && house?.thinking && view.awaited.includes(seat);
    const status = free ? "free" : view.leaving[seat] ? "leaving" : folded ? "folded" : allIn ? "all in" : out ? "next hand" : thinking ? "thinking…" : null;
    const cards = cardsOf(seat);
    const upper = at.y < 50;
    /** The seat has done its part of the step under way: its shuffle, or its shares of the deal. */
    const ready =
      !inLobby &&
      ((view.phase === "shuffle" && view.dealt.length > 0 && order.indexOf(seat) >= 0 && order.indexOf(seat) < view.shuffled) ||
        (view.phase === "deal" && view.dealt.includes(seat) && view.done[seat]));
    const awaited = !inLobby && view.awaited.includes(seat);
    // This browser's own bet on its way: drawn at once, replaced by the table's own figures when it lands.
    const mineToAct = seat === mySeat && view.phase === "bet" && view.toAct === seat;
    const sendingBet = mineToAct && pressed && (pressed.key === "call" || pressed.key === "raise" || pressed.key === "allin") ? (pressed.amount ?? view.bet[seat]) : null;
    const folding = mineToAct && pressed?.key === "fold";
    return (
      <li
        key={seat}
        className="pt-pod"
        data-free={free || undefined}
        data-out={out || folded || undefined}
        data-awaited={awaited || undefined}
        data-thinking={thinking || undefined}
        data-folding={folding || undefined}
        data-mine={seat === mySeat || undefined}
        data-upper={upper || undefined}
        style={{ ...seatColour(seat), left: `${at.x}%`, top: `${at.y}%`, "--dx": (-Math.cos(at.angle)).toFixed(3), "--dy": (-Math.sin(at.angle)).toFixed(3) } as CSSProperties}
        aria-label={`Seat ${seat + 1}: ${name(seat)}${free ? "" : `, ${view.chips[seat]} chips`}${status ? `, ${status}` : ""}`}
      >
        <span className="pt-pod__face" aria-hidden="true">
          {faces[seat] ? <img src={faces[seat]!} alt="" /> : seat + 1}
          {button === seat && (
            <i className="pt-badge" data-kind="button" title="The button: it shuffles first">
              D
            </i>
          )}
          {(small === seat || big === seat) && (
            <i className="pt-badge" data-kind="blind" title={small === seat ? "The small blind, 1" : "The big blind, 2"}>
              {small === seat ? "SB" : "BB"}
            </i>
          )}
        </span>
        {ready && <i className="pt-pod__ready" title={view.phase === "shuffle" ? "Shuffled, with its proof" : "Its shares are in"} />}
        <span className="pt-pod__name">{name(seat)}</span>
        {isHouse && house?.seatModels[seat] && (
          <span className="pt-pod__model" title={`Bets by ${modelName(house.seatModels[seat])}`}>
            {modelName(house.seatModels[seat])}
          </span>
        )}
        {free ? <span className="pt-pod__status">free</span> : <b className="pt-pod__chips">{view.chips[seat]}</b>}
        {status && !free && <span className="pt-pod__status">{status}</span>}
        {cards.length > 0 && (
          <span className="pt-pod__cards" role="group" aria-label={`${name(seat)}'s cards`}>
            {cards.map((card, index) => (
              <PlayingCard key={`${view.hand}:${seat}:${index}`} card={card} dealt={live} order={order.indexOf(seat) * 2 + index} dim={seat === mySeat && view.folded[seat]} />
            ))}
          </span>
        )}
        {sendingBet !== null ? (
          <span className="pt-pod__bet" data-pending>
            <Chips amount={sendingBet} /> {sendingBet}
          </span>
        ) : (
          inHand &&
          view.bet[seat] > 0 && (
            <span className="pt-pod__bet" key={`${view.hand}:${view.street}:${view.bet[seat]}`}>
              <Chips amount={view.bet[seat]} /> {view.bet[seat]}
            </span>
          )
        )}
        {awaited && left >= 0 && <i className="pt-pod__clock" style={{ "--left": clock.toFixed(3) } as CSSProperties} aria-hidden="true" />}
      </li>
    );
  };

  const board: (number | undefined | "place")[] = [0, 1, 2, 3, 4].map((index) => {
    if (index < view.board.length) return view.board[index];
    const turning = view.phase === "open" && (view.street === 1 ? index < 3 : index === view.board.length);
    return turning ? undefined : "place";
  });

  return (
    <div className="pk-room">
      <div className="pk-stage">
        <section className="pk-board pk-table" aria-label={`Table ${id}`}>
          <header className="pk-table__head">
            {on.back && (
              <button type="button" className="pk-exit" onClick={on.back}>
                <span aria-hidden="true">←</span> Tables
              </button>
            )}
            <h1>
              <span>{reading ? "Table" : inLobby ? `Table of ${count}` : `Hand ${view.hand + 1}`}</span>
            </h1>
            <p className="pk-table__facts">
              <span className="pk-code">{id}</span>
              <span>
                {filled} of {count} seats · blinds 1 and 2{view.feeBps > 0 ? ` · fee ${view.feeBps / 100}% of winnings` : ""}
              </span>
            </p>
            <p className="pk-table__now">
              {!inLobby && !reading && (
                <span className="pk-clock" data-low={left < 30 || undefined} title="Time left for this step">
                  <Clock size={16} /> {left >= 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "time up"}
                </span>
              )}
            </p>
          </header>

          <div className="pt-arena" data-count={count}>
            <div className="pt-oval">
              <div className="pt-middle">
                <div className="pt-pot" aria-label={`Pot ${pot}`} data-empty={(pot === 0 && progress !== null) || undefined}>
                  <span className="pk-pot__sum" key={pot}>
                    {pot}
                  </span>
                  <span className="pk-label">{bets > 0 && bets < pot ? `pot · ${bets} bet this round` : "pot"}</span>
                </div>
                {progress ? (
                  <p className="pt-readying" role="status">
                    {progress}
                  </p>
                ) : (
                  <div className="pt-board" role="group" aria-label="The board">
                    {board.map((card, index) =>
                      card === "place" ? (
                        <CardPlace key={`place:${index}`} />
                      ) : (
                        <PlayingCard key={`${view.hand}:board:${index}`} card={card} dealt={live} order={index < 3 ? index : 0} />
                      ),
                    )}
                  </div>
                )}
              </div>
              <span
                className="pk-deck pt-deck"
                data-pk-deck
                data-shuffling={(view.phase === "shuffle" && !reading) || undefined}
                data-away={inLobby || reading || (view.phase !== "shuffle" && view.phase !== "deal") || undefined}
                style={{ "--ddx": deckAt ? Math.cos(deckAt.angle).toFixed(3) : "-0.8", "--ddy": deckAt ? Math.sin(deckAt.angle).toFixed(3) : "0" } as CSSProperties}
                aria-hidden="true"
              >
                {[0, 1, 2, 3, 4, 5].map((n) => (
                  <i key={n} style={{ "--n": n } as CSSProperties} />
                ))}
              </span>
            </div>
            <ol className="pt-seats" aria-label="Seats">
              {view.players.map((_, seat) => seatPod(seat))}
            </ol>
          </div>

          <p className="pk-say" role="status">
            <span>{say}</span>
            {/* The step's clock, where the eye is: past it a seat's page calls time by itself. */}
            {!inLobby && !reading && view.awaited.length > 0 && (
              <b className="pk-say__clock" data-low={left < 20 || undefined} title="Time left for this step">
                {left >= 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "time is up"}
              </b>
            )}
          </p>
        </section>

        <ActionStub
          pressed={pressed}
          press={setPressed}
          view={view}
          you={you}
          mySeat={mySeat}
          locked={locked}
          doing={doing}
          left={left}
          problems={problems}
          link={link}
          house={house}
          agent={agent}
          reading={reading}
          on={on}
          name={name}
        />
      </div>

      <aside className="pk-side">
        {view.last && <LastHand view={view} name={name} />}
        {view.cashed.length > 0 && (
          <section className="pk-board pt-cashed" aria-label="Paid and left">
            <h2 className="pk-board__title">
              <SeatIcon size={22} /> <span>Paid and left</span>
            </h2>
            <ul>
              {view.cashed.map((paid, at) => (
                <li key={`${paid.account}:${at}`}>
                  <span title={paid.account}>
                    {paid.account === you ? "You" : house?.accounts.includes(paid.account) ? `House ${house.accounts.indexOf(paid.account) + 1}` : shortAccount(paid.account)}
                  </span>
                  <b>{paid.chips}</b>
                </li>
              ))}
            </ul>
          </section>
        )}
        <Ledger log={log} explorer={explorer} />
      </aside>
    </div>
  );
}

/** The hand before, on paper: how it ended, who won what, the cards that were shown. */
function LastHand({ view, name: nameNow }: { view: TableView; name: (seat: number) => string }) {
  const last = view.last!;
  // A seat given up since the hand was played is named by its number: who sits there now did not play it.
  const name = (seat: number): string => (view.players[seat] ? nameNow(seat) : `Seat ${seat + 1}`);
  const ending =
    last.ending === "fold" ? "everyone else folded" : last.ending === "showdown" ? "showdown" : last.ending === "cancelled" ? "called off: a seat did not answer in time" : "void";
  return (
    <div className="pk-ticket">
      <section className="pk-stub pk-last" aria-label="The hand before">
        <h2 className="pk-stub__title">Hand {last.number + 1}</h2>
        <p className="pk-small">Ended by {ending}.</p>
        {last.board.length > 0 && (
          <p className="pk-last__cards">
            <span>
              <small>Board</small>
              {last.board.map((card, at) => (
                <PlayingCard key={at} card={card} />
              ))}
            </span>
          </p>
        )}
        <ul className="pt-results">
          {last.dealt.map((seat) => {
            const net = (last.won[seat] ?? 0) - (last.put[seat] ?? 0);
            return (
              <li key={seat} style={seatColour(seat)} data-won={net > 0 || undefined}>
                <span>
                  <i className="pk-seal" data-given />
                  {name(seat)}
                  {last.late.includes(seat) && <em> late</em>}
                  {last.folded[seat] && <em> folded</em>}
                </span>
                <span className="pk-last__cards">{last.hole[seat]?.length === 2 && last.hole[seat].map((card, at) => <PlayingCard key={at} card={card} />)}</span>
                <b>{net > 0 ? `+${net}` : net}</b>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

/** How many house seats to seat, and the model each one bets by. */
function HousePlanner({ house, free, busy, onAdd }: { house: HouseAtTable; free: number; busy: boolean; onAdd: (models: string[]) => void }) {
  const most = Math.max(0, Math.min(free, house.accounts.length - house.seats.length));
  const first = house.defaultModel ?? house.models[0] ?? "rules";
  const [plan, setPlan] = useState<string[]>(() => [first]);
  const count = Math.min(plan.length, Math.max(1, most));
  const setCount = (next: number) => setPlan((before) => Array.from({ length: next }, (_, at) => before[at] ?? house.models[at % Math.max(1, house.models.length)] ?? first));
  const modelName = (option: string) => (option === "rules" ? "The odds alone (no model)" : option);
  // One button seats the house with the plan as it stands; how many and which models fold under one line.
  return (
    <div className="pt-house" role="group" aria-label="House seats">
      {most > 0 && (
        <button type="button" className="pk-pill pk-pill--ink" disabled={busy} data-busy={busy || undefined} onClick={() => onAdd(plan.slice(0, count))}>
          <Bot size={16} /> {house.seating ? `Seating house seat ${house.seating}…` : count === 1 ? "Seat an AI from the house" : `Seat ${count} AIs from the house`}
        </button>
      )}
      <details className="pk-more">
        <summary>
          <span>
            <b>House seats</b>
            <small>{most > 0 ? `${count} · ${plan.slice(0, count).map(modelName).join(", ")}` : "none free"}</small>
          </span>
        </summary>
        <div className="pk-more__body">
          {most > 1 && (
            <div className="pt-house__head">
              <b>How many</b>
              <span className="pt-house__count" role="radiogroup" aria-label="How many house seats">
                {Array.from({ length: most }, (_, at) => at + 1).map((n) => (
                  <button key={n} type="button" role="radio" aria-checked={count === n} disabled={busy} onClick={() => setCount(n)}>
                    {n}
                  </button>
                ))}
              </span>
            </div>
          )}
          {most > 0 &&
            plan.slice(0, count).map((model, at) => (
              <label key={at} className="pt-house__seat">
                <span>House {house.seats.length + at + 1}</span>
                <select
                  value={model}
                  disabled={busy}
                  onChange={(event) => {
                    const chosen = event.target.value;
                    setPlan((before) => before.map((was, index) => (index === at ? chosen : was)));
                  }}
                >
                  {house.models.map((option) => (
                    <option key={option} value={option}>
                      {modelName(option)}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          <p className="pk-fine">
            A house seat is one of this server&apos;s accounts: it stakes its own NEAR (nothing at a free table), its model bets for it, and it sees only its own two cards.
          </p>
        </div>
      </details>
    </div>
  );
}

type Pressed = { key: "fold" | "call" | "raise" | "allin" | "sit" | "start" | "leave" | "time" | "house"; amount?: number };

function ActionStub({
  pressed,
  press,
  view,
  you,
  mySeat,
  locked,
  doing,
  left,
  problems,
  link,
  house,
  agent,
  reading,
  on,
  name,
}: {
  pressed: Pressed | null;
  press: (pressed: Pressed) => void;
  view: TableView;
  you: string | null;
  mySeat: number | null;
  locked: boolean;
  doing: string | null;
  left: number;
  problems: string[];
  link: string;
  house?: HouseAtTable;
  agent?: AgentAtTable;
  reading: boolean;
  on: TableActions;
  name: (seat: number) => string;
}) {
  const [raiseTo, setRaiseTo] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => setRaiseTo(""), [view.hand, view.street, view.toAct]);
  const inLobby = view.phase === "lobby";
  const free = view.players.includes(null);
  const mine = mySeat !== null;
  const toAct = mine && view.phase === "bet" && view.toAct === mySeat;
  const handed = Boolean(agent?.on && toAct);
  const off = locked || handed;
  const options = toAct ? betOptions(view, mySeat) : null;
  const raise = options?.raise ?? null;
  const amount = raise ? Math.min(raise.max, Math.max(raise.min, Math.round(Number(raiseTo)) || raise.min)) : 0;
  const late = !inLobby && left < 0 && view.awaited.some((seat) => seat !== mySeat);
  const isHost = you !== null && view.host === you;
  // A table with a stake of nothing: its host is the server, which starts it when a seated player asks.
  const noStake = BigInt(view.stake) === 0n;
  const canStart = isHost || (noStake && Boolean(house?.accounts.includes(view.host)));
  const filled = seated(view).length;
  const inHand = mine && view.dealt.includes(mySeat) && !inLobby;

  let title = "";
  let line: ReactNode = null;
  let body: ReactNode = null;
  if (reading) {
    title = "Reading the table";
    line = "One moment: the page is asking the contract what this table holds.";
  } else if (!mine) {
    title = free ? "A free seat" : "Watching";
    line = free
      ? noStake
        ? `A seat here is free: 100 chips that are only chips, and the house pays the gas of your moves. ${inLobby ? "" : "At a table under way you are dealt in from the next hand."}`
        : `A seat costs ${asNear(view.deposit)}: ${asNear(view.stake)} for 100 chips, which come back when you leave, and a record fee that does not. Your account also needs about half a NEAR that the check of your shuffle must be able to reserve. ${inLobby ? "" : "At a table under way you are dealt in from the next hand."}`
      : "Every seat is taken. You can watch the hands being played.";
    body = free ? (
      <button
        type="button"
        className="pk-go"
        disabled={locked}
        data-busy={pressed?.key === "sit" || undefined}
        onClick={() => {
          press({ key: "sit" });
          on.sit();
        }}
      >
        {noStake ? "Sit down for free" : `Sit down for ${asNear(view.deposit)}`}
      </button>
    ) : null;
    if (on.back)
      body = (
        <>
          {body}
          <div className="pk-acts">
            <button type="button" className="pk-pill" onClick={on.back}>
              <span aria-hidden="true">←</span> Back to the tables
            </button>
          </div>
        </>
      );
  } else if (inLobby) {
    title = isHost ? "Your table" : canStart ? "A free table" : "Waiting for the host";
    line = canStart
      ? filled >= 2
        ? "Start now with the seats taken, or wait for more."
        : "Invite a friend, or seat an AI from the house below."
      : "The table starts when it is full, or when its host starts it.";
    // One gold action: start once two sit, otherwise bring people in. The link is shared by the phone's own sheet.
    const invite = (
      <button
        type="button"
        className={canStart && filled >= 2 ? "pk-pill" : "pk-go"}
        onClick={() => {
          const copy = () => void navigator.clipboard?.writeText(link).then(() => setCopied(true));
          if (typeof navigator.share === "function" && window.matchMedia("(pointer: coarse)").matches)
            navigator.share({ title: "Deedlords Poker", text: "Sit at my poker table", url: link }).catch((error) => error?.name !== "AbortError" && copy());
          else copy();
        }}
      >
        <Copy size={16} /> {copied ? "Link copied: send it to a friend" : "Invite friends"}
      </button>
    );
    body = (
      <>
        {canStart && filled >= 2 && (
          <button
            type="button"
            className="pk-go"
            disabled={locked}
            data-busy={pressed?.key === "start" || undefined}
            onClick={() => {
              press({ key: "start" });
              on.start();
            }}
          >
            Start with {filled} seats
          </button>
        )}
        <div className="pk-acts">{invite}</div>
        <p className="pk-invite" title={link}>
          {link}
        </p>
      </>
    );
  } else if (toAct && options) {
    title = handed && agent ? (agent.thinking ? `${agent.name} is thinking` : `${agent.name} has your seat`) : "Your move";
    line = options.owed > 0 ? `${options.owed} to call${options.owed === view.chips[mySeat] ? " (all you have)" : ""}` : "Nothing to call";
    body = (
      <div className="pk-move">
        <button
          type="button"
          className="pk-pill"
          disabled={off}
          data-busy={pressed?.key === "fold" || undefined}
          onClick={() => {
            press({ key: "fold" });
            on.act("fold", null, "folds");
          }}
        >
          Fold
        </button>
        <button
          type="button"
          className="pk-go"
          disabled={off}
          data-busy={pressed?.key === "call" || undefined}
          onClick={() => {
            press({ key: "call", amount: view.bet[mySeat] + options.owed });
            on.act("call", null, options.owed ? `calls ${options.owed}` : "checks");
          }}
        >
          {options.owed ? `Call ${options.owed}` : "Check"}
        </button>
        {handed && agent && (
          <button type="button" className="pk-pill pk-pill--quiet" onClick={agent.toggle}>
            Bet myself
          </button>
        )}
        {raise && (
          <div className="pk-raise">
            <input
              type="range"
              aria-label="Raise to"
              min={raise.min}
              max={raise.max}
              value={amount}
              disabled={off || raise.min === raise.max}
              onChange={(event) => setRaiseTo(event.target.value)}
            />
            <input
              type="number"
              aria-label="Raise to, in chips"
              inputMode="numeric"
              min={raise.min}
              max={raise.max}
              value={raiseTo || raise.min}
              disabled={off}
              onChange={(event) => setRaiseTo(event.target.value)}
            />
            <button
              type="button"
              className="pk-pill pk-pill--ink"
              disabled={off}
              data-busy={pressed?.key === "raise" || undefined}
              onClick={() => {
                press({ key: "raise", amount });
                on.act("raise", amount, `raises to ${amount}`);
              }}
            >
              Raise to {amount}
            </button>
            <button
              type="button"
              className="pk-pill"
              disabled={off}
              data-busy={pressed?.key === "allin" || undefined}
              onClick={() => {
                press({ key: "allin", amount: raise.max });
                on.act("raise", raise.max, `goes all in for ${raise.max}`);
              }}
            >
              All in {raise.max}
            </button>
          </div>
        )}
      </div>
    );
  } else if (!inHand) {
    title = view.leaving[mySeat] ? "Leaving" : "Next hand";
    line = view.leaving[mySeat] ? "You are paid when this hand is over." : "You sit at the table and are dealt in from the next hand.";
  } else if (view.folded[mySeat]) {
    title = "Folded";
    line = "Your shares for the board went with the fold: you owe this hand nothing more.";
  } else if (view.phase === "bet") {
    title = `${name(view.toAct)} to act`;
    line = "Your cards are in; the table waits for another seat's bet.";
  } else {
    title = view.phase === "shuffle" ? "Shuffling" : view.phase === "deal" ? "Dealing" : view.phase === "open" ? "Turning cards" : "Showdown";
    line = "This page plays your seat's part of the step by itself. You are asked for bets only.";
  }

  // A seat dealt into the hand, folded or not, is paid when the hand is over.
  const leaveWords = !mine ? null : view.leaving[mySeat] ? null : inHand ? "Leave after this hand" : "Leave and cash out";
  const extras = !reading && (late || (mine && leaveWords));
  const showPlanner = Boolean(house && (house.canAdd || house.seating) && !reading);
  const showAgent = Boolean(agent && mine && !inLobby && !reading);
  const houseLast = house?.last;

  return (
    <>
      <div className="pk-ticket pk-desk">
        <section className="pk-stub" aria-label="Your move">
          <div className="pk-desk__head">
            <h2 className="pk-stub__title">{title}</h2>
            {line && (
              <p className="pk-small" data-long={typeof line !== "string" || line.length > 28 || undefined}>
                {line}
              </p>
            )}
          </div>
          {body}
          {doing && doing !== "shuffle" && (
            <p className="pk-fine" role="status">
              {doing}
            </p>
          )}
          {problems.map((problem) => (
            <p key={problem} className="pk-problem" role="alert">
              {problem}
            </p>
          ))}
        </section>
      </div>
      {(extras || showPlanner || showAgent || houseLast || house?.opened?.length || agent?.last) && (
        <div className="pk-ticket">
          <section className="pk-stub pk-agents" aria-label="The table's other ways">
            {extras && (
              <div className="pk-acts">
                {late && (
                  <button
                    type="button"
                    className="pk-pill pk-pill--ink"
                    disabled={locked}
                    data-busy={pressed?.key === "time" || undefined}
                    onClick={() => {
                      press({ key: "time" });
                      on.callTime();
                    }}
                  >
                    Call time on {view.awaited.filter((seat) => seat !== mySeat).length > 1 ? "the late seats" : name(view.awaited.find((seat) => seat !== mySeat)!)}
                  </button>
                )}
                {leaveWords && (
                  <button
                    type="button"
                    className="pk-pill pk-pill--quiet"
                    disabled={locked}
                    data-busy={pressed?.key === "leave" || undefined}
                    onClick={() => {
                      press({ key: "leave" });
                      on.leave();
                    }}
                  >
                    {leaveWords}
                  </button>
                )}
              </div>
            )}
            {house && (house.canAdd || house.seating) && !reading && (
              <HousePlanner
                key={`${house.seats.length}:${view.players.filter((player) => !player).length}`}
                house={house}
                free={view.players.filter((player) => !player).length}
                busy={locked || Boolean(house.seating) || pressed?.key === "house"}
                onAdd={(models) => {
                  press({ key: "house" });
                  on.addHouse(models);
                }}
              />
            )}
            {showAgent && agent && (
              <div className="pk-agent">
                <label className="pk-switch">
                  <input type="checkbox" checked={agent.on} onChange={agent.toggle} />
                  <span>
                    <b>Let my agent play</b>
                    <small>
                      {agent.name} · {agent.model} · <a href="/agents">your agents</a>
                    </small>
                  </span>
                </label>
              </div>
            )}
            {(houseLast || house?.opened?.length || agent?.last) && (
              <div className="pk-voices">
                {houseLast && (
                  <Voice
                    who={houseLast.seat !== undefined ? name(houseLast.seat) : "The house"}
                    what={done(houseLast.what)}
                    driver={houseLast.driver}
                    seat={houseLast.seat ?? 0}
                    sealed={houseLast.sealed}
                  />
                )}
                {house?.opened?.map((thought, at) => (
                  <Voice
                    key={`${thought.hand}:${thought.seat}:${at}`}
                    who={name(thought.seat)}
                    what={`${done(thought.what)} in hand ${thought.hand + 1}`}
                    reason={thought.reason}
                    driver={thought.driver}
                    seat={thought.seat}
                  />
                ))}
                {agent?.last && mine && (
                  <Voice
                    who={agent.name}
                    what={agent.said ?? (agent.last.action === "raise" ? `raises to ${agent.last.amount}` : agent.last.action === "fold" ? "folds" : "calls")}
                    reason={agent.last.reason}
                    driver={agent.last.driver}
                    seat={mySeat}
                    problem={agent.last.fallback ? (agent.last.problem ?? "the model did not answer") : undefined}
                  />
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}
