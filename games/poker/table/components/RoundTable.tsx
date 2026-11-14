"use client";

// A Deedlords Poker table of two to nine seats, as it is drawn: a board with the hand's route, an oval of red baize
// with the seats around its rail clockwise in seat order (this browser's seat at the foot), the board and the pot in
// the middle. The player acts on the table itself: the bets are a bar at the table's foot, a free seat is tapped to sit
// down or to seat an AI, the host starts from the middle of the cloth. What is beside the game (the hand before, who
// was paid, what the AIs thought once a hand is over, the transactions) is folded away under the table. It only draws:
// what it shows comes from a table view, every click goes back to whoever feeds it (the live table or the demo).

import { seatName } from "@/lib/seatName";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Bot, Copy, Seat as SeatIcon } from "@/components/landing/icons";
import type { Character } from "../../../chibi/chain";
import { useLookPictures } from "../../../chibi/useChibi";
import { lookFromSeat } from "../../../ma-soi/look";
import { CardPlace, PlayingCard } from "../../components/Cards";
import { Ledger, type LogLine } from "../../components/TableView";
import type { Advice } from "../../agent/decide";
import { madeHand } from "../../agent/hands";
import { type TableView, betOptions, clockMarginMs, handNets, handStory, houseName, nextDealt, seated } from "../seat";

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
  /** Everybody who sits or sat at the table: one house seat among them is "House", several are numbered. */
  const everyone = [...view.players, ...view.cashed.map((paid) => paid.account)];
  /** Who sits at a seat, in a word or two. */
  const name = (seat: number): string => {
    const player = view.players[seat];
    if (!player) return "Free seat";
    if (seat === mySeat) return "You";
    if (house?.accounts.includes(player)) return houseName(house.accounts, player, everyone);
    return characters?.get(player)?.name || seatName(player, shortAccount);
  };
  /** The same inside a sentence. */
  const named = (seat: number): string => (seat === mySeat ? "you" : name(seat));
  const waitingFor = view.awaited.map(named);
  const waitingText = waitingFor.length > 3 ? `${waitingFor.length} seats` : waitingFor.join(" and ");

  // Between two hands, while the next one is shuffled and dealt, the felt keeps the one before: its board, the cards
  // that were shown and who took the pot. The contract goes on to the next hand in the very call that ends one, so a
  // showdown was gone from the table the moment its last seat showed, and could only be read off the stub beside it.
  const before = !inLobby && !reading && (view.phase === "shuffle" || view.phase === "deal") && view.last?.number === view.hand - 1 ? view.last : null;
  const shownBefore = (seat: number): number[] | null => (before && view.players[seat] && before.hole[seat]?.length === 2 ? before.hole[seat] : null);
  /** How it ended, in a sentence. A seat given up since is named by its number: who sits there now did not play it. */
  const told = before
    ? handStory(
        before,
        (seat) => (view.players[seat] ? named(seat) : `seat ${seat + 1}`),
        (seat) => (shownBefore(seat) && before.board.length === 5 ? madeHand(shownBefore(seat)!, before.board) : null),
      )
    : null;

  const cardsOf = (seat: number): (number | null | undefined)[] => {
    if (before) return shownBefore(seat) ?? [];
    if (!inHand || !view.dealt.includes(seat) || view.phase === "shuffle" || view.phase === "deal") return [];
    if (view.hole[seat]?.length === 2) return view.hole[seat];
    if (seat === mySeat && myCards) return myCards;
    if (view.folded[seat]) return [];
    return [undefined, undefined];
  };

  let say: ReactNode;
  const filled = seated(view).length;
  if (reading) say = "Asking the contract for this table…";
  else if (inLobby) say = filled < 2 ? `${filled} of ${count} seats taken. The table starts when it is full, or when its host starts it.` : `${filled} of ${count} seats taken.`;
  else if (told)
    say = `${told} Next hand: ${view.phase === "deal" ? `dealing, waiting for ${waitingText}` : doing === "shuffle" ? "this page is shuffling for you" : `waiting for ${waitingText} to shuffle`}.`;
  else if (view.phase === "shuffle") say = <>{doing === "shuffle" ? "Shuffling the deck for your seat…" : `Shuffling the deck. Waiting for ${waitingText}.`}</>;
  else if (view.phase === "deal") say = `Dealing. Waiting for ${waitingText}.`;
  else if (view.phase === "bet") {
    const owed = betOptions(view, view.toAct).owed;
    say = `${view.toAct === mySeat ? "Your turn" : `${name(view.toAct)} to act`}${owed > 0 ? `: ${owed} to call.` : ": no bet to call."}`;
  } else if (view.phase === "open") say = `Turning the next card${view.street === 1 ? "s" : ""}. Waiting for ${waitingText}.`;
  else say = `Showdown. Waiting for ${waitingText}.`;
  if (mySeat !== null && inHand && view.leaving[mySeat]) say = <>{say} You leave when this hand is over: keep this page open until then.</>;

  const mine = mySeat !== null;
  const isHost = you !== null && view.host === you;
  // A table with a stake of nothing: its host is the server, which starts it when a seated player asks.
  const noStake = BigInt(view.stake) === 0n;
  const canStart = isHost || (noStake && Boolean(house?.accounts.includes(view.host)));
  const price = noStake ? "free" : asNear(view.deposit);
  /** What tapping a free seat does: sit down (the contract gives the first free seat), or ask the house for an AI. */
  const freeTap: { label: string; sub: string; run: () => void } | null = reading
    ? null
    : !mine
      ? {
          label: "Sit",
          sub: price,
          run: () => {
            setPressed({ key: "sit" });
            on.sit();
          },
        }
      : house?.canAdd && !house.seating
        ? {
            label: "+ AI",
            sub: "house",
            run: () => {
              setPressed({ key: "house" });
              on.addHouse([house.defaultModel ?? house.models[0] ?? "rules"]);
            },
          }
        : null;

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
        {free ? (
          freeTap ? (
            <button
              type="button"
              className="pt-pod__tap"
              disabled={locked || pressed?.key === "sit" || pressed?.key === "house"}
              data-busy={pressed?.key === "sit" || pressed?.key === "house" || undefined}
              onClick={freeTap.run}
              aria-label={freeTap.label === "Sit" ? `Sit down at seat ${seat + 1} (${freeTap.sub})` : `Seat an AI from the house at seat ${seat + 1}`}
            >
              <b>{freeTap.label}</b>
              <small>{freeTap.sub}</small>
            </button>
          ) : (
            <span className="pt-pod__status">free</span>
          )
        ) : (
          <b className="pt-pod__chips">{view.chips[seat]}</b>
        )}
        {status && !free && <span className="pt-pod__status">{status}</span>}
        {/* This seat's own cards lie large before it; another seat's cards face down are a small pair at its edge,
            and once shown they stand in the seat's own box: nothing of a seat lies on another seat. */}
        {cards.length > 0 && (
          <span className={seat === mySeat ? "pt-pod__cards" : cards[0] === undefined ? "pt-pod__backs" : "pt-pod__shown"} role="group" aria-label={`${name(seat)}'s cards`}>
            {cards.map((card, index) => (
              <PlayingCard
                key={`${before ? "before" : view.hand}:${seat}:${index}`}
                card={card}
                dealt={live && !before}
                order={order.indexOf(seat) * 2 + index}
                dim={!before && seat === mySeat && view.folded[seat]}
              />
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

  // Leaving takes two taps: the button sits in the table's head, where a thumb passes.
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => setLeaving(false), 4_000);
    return () => clearTimeout(timer);
  }, [leaving]);
  const leaveWords = !mine || view.leaving[mySeat] || reading ? null : inHand && view.dealt.includes(mySeat) ? "Leave after hand" : "Leave";
  const everyAccount = everyone;

  return (
    <div className="pt-room">
      <section className="pk-board pk-table pt-table" aria-label={`Table ${id}`}>
        <header className="pk-table__head pt-head">
          {on.back && (
            <button type="button" className="pk-exit" onClick={on.back} aria-label="Back to the tables">
              <span aria-hidden="true">←</span>
              <span className="pt-head__word"> Tables</span>
            </button>
          )}
          <h1>
            <span>{reading ? "Table" : inLobby ? `Table of ${count}` : `Hand ${view.hand + 1}`}</span>
          </h1>
          <p className="pt-head__tools">
            {agent && mine && !inLobby && !reading && (
              <label className="pt-auto" title={`${agent.name} (${agent.model}) bets for you while this is on`}>
                <input type="checkbox" checked={agent.on} onChange={agent.toggle} />
                <span>
                  <Bot size={15} /> Agent
                </span>
              </label>
            )}
            {leaveWords && (
              <button
                type="button"
                className="pt-leave"
                disabled={locked}
                data-busy={pressed?.key === "leave" || undefined}
                data-armed={leaving || undefined}
                onClick={() => {
                  if (!leaving) return setLeaving(true);
                  setLeaving(false);
                  setPressed({ key: "leave" });
                  on.leave();
                }}
              >
                {leaving ? (
                  "Tap again to leave"
                ) : (
                  <>
                    Leave{leaveWords !== "Leave" && <span className="pt-head__word"> after hand</span>}
                  </>
                )}
              </button>
            )}
          </p>
        </header>

        <div className="pt-arena" data-count={count}>
          <div className="pt-oval">
            <div className="pt-middle">
              <div className="pt-pot" aria-label={`Pot ${pot}`} data-empty={(pot === 0 && (progress !== null || inLobby || reading)) || undefined}>
                <span className="pk-pot__sum" key={pot}>
                  {pot}
                </span>
                <span className="pk-label">{bets > 0 && bets < pot ? `pot · ${bets} bet this round` : "pot"}</span>
              </div>
              {before && before.board.length > 0 && (
                <div className="pt-board" role="group" aria-label={`The board of hand ${before.number + 1}`}>
                  {before.board.map((card, index) => (
                    <PlayingCard key={`before:${before.number}:${index}`} card={card} />
                  ))}
                </div>
              )}
              {inLobby && !reading ? (
                <div className="pt-start">
                  {/* While seats are free the table's own link lies on the cloth as a code: a friend beside the
                      player points a phone at it and is at the table. */}
                  {mine && link && view.players.includes(null) && (
                    <figure className="pt-scan" title={link}>
                      <QRCodeSVG value={link} size={160} marginSize={0} bgColor="transparent" fgColor="#2a1208" level="M" />
                      <figcaption>Scan to sit</figcaption>
                    </figure>
                  )}
                  {mine && canStart && filled >= 2 ? (
                    <button
                      type="button"
                      className="pt-btn pt-btn--gold"
                      disabled={locked}
                      data-busy={pressed?.key === "start" || undefined}
                      onClick={() => {
                        setPressed({ key: "start" });
                        on.start();
                      }}
                    >
                      Start · {filled} seats
                    </button>
                  ) : (
                    <p>{!mine ? "Tap a free seat to sit down." : canStart ? "Or tap a free seat to add an AI." : "Waiting for the host to start."}</p>
                  )}
                </div>
              ) : progress ? (
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
              data-away={inLobby || reading || (view.phase !== "shuffle" && view.phase !== "deal") || Boolean(before?.board.length) || undefined}
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

        <Hud
          pressed={pressed}
          press={setPressed}
          view={view}
          mySeat={mySeat}
          locked={locked}
          left={left}
          pot={pot}
          problems={problems}
          link={link}
          price={price}
          house={house}
          agent={agent}
          reading={reading}
          on={on}
          name={name}
        />
      </section>

      {!reading && (
        <details className="pt-details">
          <summary>
            <span>Table details</span>
            <small>the hand before, who was paid, the AIs&apos; notes, transactions</small>
          </summary>
          <div className="pt-details__body">
            <p className="pk-table__facts">
              <span className="pk-code">{id}</span>
              <span>
                {filled} of {count} seats · blinds 1 and 2{view.feeBps > 0 ? ` · fee ${view.feeBps / 100}% of winnings` : ""}
              </span>
              {doing && doing !== "shuffle" && <span role="status">{doing}</span>}
            </p>
            {link && view.players.includes(null) && (
              <div className="pk-ticket">
                <section className="pk-stub pt-invite" aria-label="Invite to this table">
                  <figure className="pt-scan" title={link}>
                    <QRCodeSVG value={link} size={160} marginSize={0} bgColor="transparent" fgColor="#2a1208" level="M" />
                  </figure>
                  <div>
                    <h2 className="pk-stub__title">A seat is free</h2>
                    <p className="pk-small">Scan the code with a phone, or send the link. {inLobby ? "" : "Whoever sits down is dealt in from the next hand."}</p>
                    <p className="pk-invite" title={link}>
                      {link}
                    </p>
                  </div>
                </section>
              </div>
            )}
            {house && (house.canAdd || house.seating) && (
              <div className="pk-ticket">
                <section className="pk-stub" aria-label="House seats">
                  <HousePlanner
                    key={`${house.seats.length}:${view.players.filter((player) => !player).length}`}
                    house={house}
                    free={view.players.filter((player) => !player).length}
                    busy={locked || Boolean(house.seating) || pressed?.key === "house"}
                    onAdd={(models) => {
                      setPressed({ key: "house" });
                      on.addHouse(models);
                    }}
                  />
                </section>
              </div>
            )}
            {view.last && <LastHand view={view} name={name} />}
            {(house?.opened?.length || (agent?.last && mine)) && (
              <div className="pk-ticket">
                <section className="pk-stub pk-agents" aria-label="What the AIs thought">
                  <h2 className="pk-stub__title">AI notes</h2>
                  <p className="pk-fine">A house seat&apos;s note names its cards, so it is sealed while its hand is played and opened here once that hand is over.</p>
                  <div className="pk-voices">
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
                        who={`${agent.name} (your agent)`}
                        what={agent.said ?? (agent.last.action === "raise" ? `raises to ${agent.last.amount}` : agent.last.action === "fold" ? "folds" : "calls")}
                        reason={agent.last.reason}
                        driver={agent.last.driver}
                        seat={mySeat}
                        problem={agent.last.fallback ? (agent.last.problem ?? "the model did not answer") : undefined}
                      />
                    )}
                  </div>
                </section>
              </div>
            )}
            {view.cashed.length > 0 && (
              <section className="pk-board pt-cashed" aria-label="Paid and left">
                <h2 className="pk-board__title">
                  <SeatIcon size={22} /> <span>Paid and left</span>
                </h2>
                <ul>
                  {view.cashed.map((paid, at) => (
                    <li key={`${paid.account}:${at}`}>
                      <span title={paid.account}>
                        {paid.account === you ? "You" : house?.accounts.includes(paid.account) ? houseName(house.accounts, paid.account, everyAccount) : seatName(paid.account, shortAccount)}
                      </span>
                      <b>{paid.chips}</b>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <Ledger log={log} explorer={explorer} />
          </div>
        </details>
      )}
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
  const nets = handNets(last);
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
            const net = nets[seat];
            // What the cards a seat showed made with the board, as the contract ranked them.
            const made = last.hole[seat]?.length === 2 && last.board.length === 5 ? madeHand(last.hole[seat], last.board) : null;
            return (
              <li key={seat} style={seatColour(seat)} data-won={(net !== null && net > 0) || undefined}>
                <span>
                  <i className="pk-seal" data-given />
                  {name(seat)}
                  {last.late.includes(seat) && <em> late</em>}
                  {last.folded[seat] && <em> folded</em>}
                  {made && <em> {made}</em>}
                </span>
                <span className="pk-last__cards">{last.hole[seat]?.length === 2 && last.hole[seat].map((card, at) => <PlayingCard key={at} card={card} />)}</span>
                <b title={net === null ? "It lost the chips it had at the table" : undefined}>{net === null ? "out" : net > 0 ? `+${net}` : net}</b>
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

/**
 * The bar at the table's foot: what the player can do now, as buttons on the table itself. On their turn the three
 * bets with the sizing over them; a seat to take; an invitation while the table fills; time to call on a late seat.
 */
function Hud({
  pressed,
  press,
  view,
  mySeat,
  locked,
  left,
  pot,
  problems,
  link,
  price,
  house,
  agent,
  reading,
  on,
  name,
}: {
  pressed: Pressed | null;
  press: (pressed: Pressed) => void;
  view: TableView;
  mySeat: number | null;
  locked: boolean;
  left: number;
  pot: number;
  problems: string[];
  link: string;
  price: string;
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
  // Not while this seat's own part is owed: time called then rules it late with the others.
  const late = !inLobby && !reading && left < 0 && view.awaited.some((seat) => seat !== mySeat) && (mySeat === null || !view.awaited.includes(mySeat));
  // With nothing bet on the street yet a raise is a bet, and is called one.
  const top = Math.max(0, ...view.bet);
  const opening = top === 0;
  const clockSeconds = Math.round(clockMarginMs(view) / 1_000);
  const sized = (to: number): string => String(raise ? Math.min(raise.max, Math.max(raise.min, Math.round(to))) : to);

  const invite = () => {
    const copy = () => void navigator.clipboard?.writeText(link).then(() => setCopied(true));
    if (typeof navigator.share === "function" && window.matchMedia("(pointer: coarse)").matches)
      navigator.share({ title: "Deedlords Poker", text: "Sit at my poker table", url: link }).catch((error) => error?.name !== "AbortError" && copy());
    else copy();
  };

  let body: ReactNode = null;
  if (reading) body = null;
  else if (toAct && options) {
    body = (
      <>
        {handed && agent && (
          <p className="pt-hud__note" role="status">
            {agent.name} {agent.thinking ? "is choosing your bet…" : "bets for you."}{" "}
            <button type="button" className="pt-link" onClick={agent.toggle}>
              Bet myself
            </button>
          </p>
        )}
        {raise && raise.min < raise.max && !handed && (
          <div className="pt-size">
            <span className="pt-size__chips">
              <button type="button" disabled={off} onClick={() => setRaiseTo(sized(top + Math.ceil((pot + options.owed) / 2)))}>
                ½ pot
              </button>
              <button type="button" disabled={off} onClick={() => setRaiseTo(sized(top + pot + options.owed))}>
                Pot
              </button>
              <button type="button" disabled={off} onClick={() => setRaiseTo(String(raise.max))}>
                Max
              </button>
            </span>
            <input
              type="range"
              aria-label={opening ? "Bet" : "Raise to"}
              min={raise.min}
              max={raise.max}
              value={amount}
              disabled={off}
              onChange={(event) => setRaiseTo(event.target.value)}
            />
            <input
              type="number"
              aria-label={opening ? "Bet, in chips" : "Raise to, in chips"}
              inputMode="numeric"
              min={raise.min}
              max={raise.max}
              value={raiseTo || raise.min}
              disabled={off}
              onChange={(event) => setRaiseTo(event.target.value)}
            />
          </div>
        )}
        <div className="pt-hud__acts">
          <button
            type="button"
            className="pt-btn pt-btn--fold"
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
            className="pt-btn pt-btn--gold"
            disabled={off}
            data-busy={pressed?.key === "call" || undefined}
            onClick={() => {
              press({ key: "call", amount: view.bet[mySeat] + options.owed });
              on.act("call", null, options.owed ? `calls ${options.owed}` : "checks");
            }}
          >
            {options.owed ? `Call ${options.owed}` : "Check"}
          </button>
          {raise && (
            <button
              type="button"
              className="pt-btn"
              disabled={off}
              data-busy={pressed?.key === "raise" || pressed?.key === "allin" || undefined}
              onClick={() => {
                const all = amount === raise.max;
                press({ key: all ? "allin" : "raise", amount });
                on.act("raise", amount, all ? `goes all in for ${amount}` : opening ? `bets ${amount}` : `raises to ${amount}`);
              }}
            >
              {amount === raise.max ? "All in" : opening ? "Bet" : "Raise to"} {amount}
            </button>
          )}
        </div>
        {left <= clockSeconds + 10 && (
          <p className="pt-hud__note" role="status">
            With {clockSeconds} seconds left this page {options.owed > 0 ? "folds" : "checks"} for you, so that your seat is not ruled late.
          </p>
        )}
      </>
    );
  } else if (!mine && free) {
    body = (
      <>
        <div className="pt-hud__acts">
          <button
            type="button"
            className="pt-btn pt-btn--gold"
            disabled={locked}
            data-busy={pressed?.key === "sit" || undefined}
            onClick={() => {
              press({ key: "sit" });
              on.sit();
            }}
          >
            {price === "free" ? "Sit down for free" : `Sit down for ${price}`}
          </button>
        </div>
        <p className="pt-hud__note">
          {price === "free"
            ? "100 chips that are only chips; the house pays the gas of your moves."
            : `${asNear(view.stake)} buys 100 chips, yours again when you leave. Keep half a NEAR free for gas.`}
          {inLobby ? "" : " You are dealt in from the next hand."}
        </p>
      </>
    );
  } else if (mine && inLobby) {
    body = (
      <div className="pt-hud__acts">
        <button type="button" className="pt-btn" onClick={invite}>
          <Copy size={16} /> {copied ? "Link copied" : "Invite friends"}
        </button>
        {house?.canAdd && (
          <button
            type="button"
            className="pt-btn"
            disabled={locked || Boolean(house.seating) || pressed?.key === "house"}
            data-busy={Boolean(house.seating) || pressed?.key === "house" || undefined}
            onClick={() => {
              press({ key: "house" });
              on.addHouse([house.defaultModel ?? house.models[0] ?? "rules"]);
            }}
          >
            <Bot size={16} /> {house.seating ? "Seating an AI…" : "Add an AI"}
          </button>
        )}
      </div>
    );
  }

  const any = body || late || problems.length > 0;
  if (!any) return null;
  return (
    <div className="pt-hud" data-turn={toAct || undefined}>
      {problems.map((problem) => (
        <p key={problem} className="pt-hud__problem" role="alert">
          {problem}
        </p>
      ))}
      {body}
      {late && (
        <div className="pt-hud__acts">
          <button
            type="button"
            className="pt-btn"
            disabled={locked}
            data-busy={pressed?.key === "time" || undefined}
            onClick={() => {
              press({ key: "time" });
              on.callTime();
            }}
          >
            Call time on {view.awaited.filter((seat) => seat !== mySeat).length > 1 ? "the late seats" : name(view.awaited.find((seat) => seat !== mySeat)!)}
          </button>
        </div>
      )}
    </div>
  );
}
