"use client";

// Deedlords Poker at tables of two to nine seats (/poker/tables): a lobby with the wall of tables, one table, and what
// a settled table paid. The page plays its seat's part of the protocol by itself (its shuffle with its proof, its
// shares) and asks the player for the bets only. How it looks is in RoundTable.tsx and app/poker/tables/tables.css;
// this file reads the table and sends the calls.

import Link from "next/link";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import goldFoil from "@/assets/plates/gold-foil.webp";
import paper from "@/assets/plates/strip-paper.png";
import { Arrow, Chain, Copy, Seat } from "@/components/landing/icons";
import { HallBar, type HallAccount } from "@/components/hall/HallBar";
import { SignIn } from "@/components/hall/SignIn";
import type { Session } from "@/lib/chain/client";
import { CHAIN } from "@/lib/chain/config";
import { useCharacters } from "../../../chibi/useChibi";
import { near, ownStake } from "../../../co-ty-phu/chain/calls";
import { usePlayer, type Player } from "../../../co-ty-phu/chain/usePlayer";
import { TopUp } from "../../../co-ty-phu/components/TopUp";
import { makePokerAccount, pokerAccount } from "../../pokerAccount";
import { type FundStep, amountToMove, fundPoker, sendBack } from "../../pokerFunds";
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
import { type TableResult, type TableView, betCall, callsTime, clockAhead, clockMove, duty, holeCards, movedOn, seated, tookEffect } from "../seat";
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
export function TablesShell({ children, account }: { children: ReactNode; account?: HallAccount | null }) {
  return (
    <main className="pk" style={{ "--pk-paper": `url(${paper.src})`, "--pk-foil": `url(${goldFoil.src})` } as CSSProperties}>
      <HallBar current="poker" account={account} />
      {children}
    </main>
  );
}

export function TablesScreen() {
  // Who is signed in to the club: the same account on every page, asked for once.
  const state = usePlayer();
  const { player } = state;
  const [ready, setReady] = useState(false);
  // The account poker is played as (pokerAccount.ts): the club's game account, or one kept for poker beside a NEAR
  // wallet or Google account, which cannot sign a hand.
  const [session, setSession] = useState<Session | null>(null);
  const [table, setTable] = useState<{ id: string; seq: number } | null>(null);
  const [demo, setDemo] = useState<string | null>(null);
  // A table can be looked at without an account.
  const [watching, setWatching] = useState(false);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    setDemo(query.get("demo"));
    const id = query.get("t");
    if (id) setTable({ id, seq: 0 });
    setReady(true);
  }, []);
  useEffect(() => setSession(player ? tableSession() : null), [player]);

  const show = (next: { id: string; seq: number } | null) => {
    window.history.replaceState(null, "", next ? `${ROUTE}?t=${next.id}` : ROUTE);
    setTable(next);
  };
  const makeAccount = () => {
    makePokerAccount();
    setSession(tableSession());
  };
  const account = player === undefined ? undefined : player && { accountId: player.accountId, balance: state.balance };

  return (
    <TablesShell account={demo !== null ? null : account}>
      {!ready ? null : demo !== null ? (
        <TablesDemo start={demo} />
      ) : player === undefined ? null : player === null && !(table && watching) ? (
        <div className="si-page">
          <h1 className="si-page__line">{table ? "Check in to take a seat." : "Check in, then pick a table."}</h1>
          <SignIn state={state} onWatch={table ? () => setWatching(true) : undefined} />
        </div>
      ) : table ? (
        <LiveTable
          key={table.id}
          id={table.id}
          firstSeq={table.seq}
          session={player ? session : null}
          // A poker account kept beside a wallet or Google account is filled from that account when a seat costs NEAR.
          backer={player && session && pokerAccount()?.apart && player.accountId !== session.accountId ? player : null}
          // Who brings NEAR the seat's account lacks, when no club account stands behind it: the account itself.
          payer={
            !session
              ? null
              : player?.via === "key" && player.accountId === session.accountId
                ? player
                : { via: "key", accountId: session.accountId, session, source: "guest", evmAddress: null, label: null }
          }
          // Somebody looking on goes back to the sign-in step; a wallet or Google account gets its poker account.
          onSignIn={player ? makeAccount : () => setWatching(false)}
          onBack={() => show(null)}
        />
      ) : (
        <LiveLobby session={session} player={player} clubBalance={state.balance} onSignIn={makeAccount} onOpen={(id, seq) => show({ id, seq })} />
      )}
    </TablesShell>
  );
}

type LobbyProps = {
  session: Session | null;
  /** Who is signed in to the club, when that is not the account poker is played as. */ player?: Player | null;
  /** What that club account holds, in yoctoNEAR (`null`: not on chain; `undefined`: not read yet). */ clubBalance?: bigint | null;
  /** Makes the game account poker is played with, for a club account that cannot sign a hand. */ onSignIn: () => void;
  onOpen: (id: string, seq: number) => void;
};

function LiveLobby(props: LobbyProps) {
  const wall = useTables();
  const house = useHouse(null, null);
  return <TablesLobby {...props} wall={wall} houses={house.accounts ?? []} free={house.free} models={house.models} />;
}

/** How a table is played: heads-up against the house, a free room for friends, or for a stake. */
type Mode = "house" | "friends" | "stake";
const MODES: Record<Mode, { name: string; line: string }> = {
  house: { name: "vs House", line: "Free" },
  friends: { name: "Friends", line: "Free room" },
  stake: { name: "Stake", line: "Win NEAR" },
};

export function TablesLobby({
  session,
  player = null,
  clubBalance,
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
  // How to play: the first choice stands until another is picked. Without a host for free tables, only a stake.
  const modes: Mode[] = free ? ["house", "friends", "stake"] : ["stake"];
  const [pickedMode, setMode] = useState<Mode | null>(null);
  const mode = pickedMode !== null && modes.includes(pickedMode) ? pickedMode : modes[0];
  const gratis = mode !== "stake";
  // The stake of each seat at a table opened for a stake: a chip, or an amount typed in NEAR (which stands while filled in).
  const [picked, setPicked] = useState<number | null>(null);
  const chip = picked !== null && STAKE_CHIPS.includes(picked) ? picked : STAKE_CHIPS[0];
  const [typed, setTyped] = useState("");
  const [typing, setTyping] = useState(false);
  const ownTyped = typing && typed.trim() !== "";
  // Seats: heads-up against the house, a room of six for friends or for a stake, unless more or fewer are asked for.
  const [seatsPicked, setSeats] = useState<number | null>(null);
  const seatChoices = Array.from({ length: MAX_SEATS - 1 }, (_, at) => at + 2).filter((count) => mode !== "friends" || count > 2);
  const seats = mode === "house" ? 2 : seatsPicked !== null && seatChoices.includes(seatsPicked) ? seatsPicked : 6;
  const [model, setModel] = useState("");
  const own = ownStake(typed, LARGEST_STAKE, STAKE_CHIPS[0]);
  const typedProblem = !gratis && ownTyped && "problem" in own ? own.problem : null;
  const stake = near(ownTyped && "amount" in own ? own.amount : chip);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  // Where a table opened with NEAR moved from the club account is: the player's approval, then the transfer landing.
  const [step, setStep] = useState<FundStep | null>(null);
  const [returning, setReturning] = useState(false);

  const readBalance = useCallback(() => {
    if (session) void tableClient.balance(session.accountId).then(setBalance, () => undefined);
  }, [session]);
  useEffect(() => {
    if (!session) return;
    readBalance();
    const timer = setInterval(readBalance, 6_000);
    return () => clearInterval(timer);
  }, [session, readBalance]);

  const open = async () => {
    if (!session) return;
    setBusy(true);
    setNote("");
    try {
      // A poker account kept beside a wallet or Google account is filled from that account first: one approval.
      if (!gratis && short && backer) {
        await fundPoker(backer, session.accountId, needed, setStep);
        readBalance();
      }
      setStep(null);
      // The table has changed once when it is created.
      onOpen(gratis ? await openFreeTable(session, seats, model || undefined) : await openTable(session, seats, stake), 1);
    } catch (error) {
      setNote(text(error));
      setStep(null);
      setBusy(false);
    }
  };
  /** Sends what the poker account holds back to the club account it stands beside. */
  const giveBack = async () => {
    if (!session || !backer || typeof balance !== "bigint") return;
    setReturning(true);
    setNote("");
    try {
      await sendBack(session, backer.accountId, balance);
      for (let tries = 0; tries < 6; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        readBalance();
      }
    } catch (error) {
      setNote(text(error));
    }
    setReturning(false);
  };
  /**
   * What a seat with a stake needs on the account: the stake, the record fee, and about half a NEAR that the call
   * checking the seat's shuffle proof must be able to reserve (260 Tgas; nearly all of it comes back).
   */
  const needed = stake + RECORD_FEE + NEAR / 2n;
  const short = !gratis && balance !== undefined && (balance === null || balance < needed);
  // Poker is played as the club's game account, or as one kept for poker beside a wallet or Google account.
  const apart = session ? Boolean(pokerAccount()?.apart) : false;
  // The club account that fills the poker account kept beside it, and whether it holds enough to.
  const backer: Player | null = apart && session && player && player.accountId !== session.accountId ? player : null;
  const toMove = amountToMove(needed, balance);
  const backerCan = Boolean(backer) && typeof clubBalance === "bigint" && clubBalance >= toMove + NEAR / 20n;
  // A seat at a table holds the account's money: nothing goes back while it sits at one.
  const seated = Boolean(session && wall.tables?.some((table) => table.players.includes(session.accountId)));
  const canReturn = Boolean(backer) && typeof balance === "bigint" && balance > NEAR / 50n && !seated;
  // Who brings the missing NEAR: the club account when poker is played as it (an EVM wallet then pays through 1Click).
  const payer: Player | null = !session
    ? null
    : !apart && player?.via === "key" && player.accountId === session.accountId
      ? player
      : { via: "key", accountId: session.accountId, session, source: "guest", evmAddress: null, label: null };
  const label =
    step === "approve"
      ? backer?.via === "wallet"
        ? "Approve it in your wallet…"
        : "Approve it in the sign-in window…"
      : step === "moving"
        ? "Moving NEAR to your poker account…"
        : busy
          ? "Opening the table…"
          : mode === "house"
            ? "Play vs the House"
            : mode === "friends"
              ? `Open a room of ${seats}`
              : `Open a table of ${seats} · ${asNear(stake).replace(/\.?0+ NEAR$/, "")} NEAR`;
  const houseModel = model ? (model === "rules" ? "the odds alone" : model) : "its usual model";
  const options = mode === "house" ? `House bets by ${houseModel}` : mode === "friends" ? `${seats} seats · house bets by ${houseModel}` : `${seats} seats`;

  return (
    <div className="pk-hall">
      <div className="pk-wall">
        <div className="pk-wallhead">
          <h1 className="pk-line">Poker for two to nine.</h1>
          <div className="pk-wallhead__lede">
            <p className="pk-lede">
              Texas Hold&apos;em for up to nine on NEAR {CHAIN.network}, with no dealer: every seat shuffles the deck with its own key, and the contract takes a deck only with a
              zero-knowledge proof that the shuffle is honest.
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
        {session && (
          <section className="pk-stub pk-stub--thin" aria-label="Your game account">
            <div className="pk-who">
              <span className="pk-stamp" aria-hidden="true">
                {session.accountId.replace(/[^a-z0-9]/gi, "").slice(0, 2)}
              </span>
              <p>
                <strong title={session.accountId}>{shortAccount(session.accountId)}</strong>
                <small>{apart && player ? `your poker game account, beside ${shortAccount(player.accountId)}` : "your game account, its key kept in this browser"}</small>
              </p>
              <p className="pk-balance" data-low={short || undefined}>
                {balance === undefined ? (
                  <small>reading…</small>
                ) : balance === null ? (
                  <small>{free && gratis ? "no NEAR needed" : "0 NEAR"}</small>
                ) : (
                  <>
                    <strong>{asNear(balance).replace(" NEAR", "")}</strong>
                    <small>NEAR</small>
                  </>
                )}
              </p>
            </div>
            {canReturn && backer && (
              <button type="button" className="pk-pill pk-who__back" disabled={returning || busy} onClick={() => void giveBack()}>
                {returning ? "Sending it back…" : `Send it back to ${shortAccount(backer.accountId)}`}
              </button>
            )}
          </section>
        )}

        {!session && player && (
          <section className="pk-stub" aria-label="A game account for poker">
            <h2 className="pk-stub__title">
              One more step <Seat size={22} />
            </h2>
            <p className="pk-small">
              Poker signs every step of a hand (the shuffle and its proof, the shares of each card, the bets) with a key kept in this browser, so that no wallet prompt stops a
              hand. {player.via === "wallet" ? "A NEAR wallet account keeps its key in the wallet" : "A Google account keeps here a key for the board game only"}, so{" "}
              <b title={player.accountId}>{shortAccount(player.accountId)}</b> cannot sit at these tables yet.
            </p>
            <button type="button" className="pk-go" onClick={onSignIn}>
              Make my poker game account
            </button>
            <p className="pk-fine">
              One tap, nothing to install: a game account for the poker tables, its key kept in this browser. You stay signed in as {shortAccount(player.accountId)} for Deedlords.
              Free tables need no NEAR.
            </p>
          </section>
        )}

        <section className="pk-stub" aria-label="Open a table" hidden={!session}>
          <h2 className="pk-stub__title">
            New table <Seat size={22} />
          </h2>
          {modes.length > 1 && (
            <div className="pk-modes" role="group" aria-label="How to play">
              {modes.map((entry) => (
                <button key={entry} type="button" aria-pressed={entry === mode} onClick={() => setMode(entry)}>
                  <b>{MODES[entry].name}</b>
                  <small>{MODES[entry].line}</small>
                </button>
              ))}
            </div>
          )}
          {!gratis && (
            <div className="pt-stake">
              <span id="pt-stake">A seat costs, in NEAR</span>
              <div className="pt-picker pt-picker--stake" role="group" aria-labelledby="pt-stake">
                {STAKE_CHIPS.map((amount) => (
                  <button
                    key={amount}
                    type="button"
                    aria-pressed={!ownTyped && amount === chip}
                    className="pt-picker__seat"
                    onClick={() => {
                      setPicked(amount);
                      setTyping(false);
                    }}
                  >
                    {amount}
                  </button>
                ))}
                <button type="button" aria-pressed={ownTyped} aria-expanded={typing} className="pt-picker__seat pt-picker__other" onClick={() => setTyping(!typing)}>
                  Other
                </button>
              </div>
              {typing && (
                <label className="pt-stake__own">
                  <span>Your own</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    autoFocus
                    placeholder={`${STAKE_CHIPS[0]} to ${LARGEST_STAKE}`}
                    value={typed}
                    aria-invalid={typedProblem ? true : undefined}
                    onChange={(event) => setTyped(event.target.value.replace(",", "."))}
                  />
                  <b aria-hidden="true">NEAR</b>
                </label>
              )}
              {typedProblem && (
                <p className="pk-problem" role="alert">
                  {typedProblem}
                </p>
              )}
            </div>
          )}
          <button type="button" className="pk-go" disabled={!session || busy || (short && !backerCan) || Boolean(typedProblem)} onClick={() => void open()}>
            {label}
          </button>
          {note && (
            <p className="pk-problem" role="alert">
              {note}
            </p>
          )}
          <details className="pk-more">
            <summary>
              <span>
                <b>Table options</b>
                <small>{options}</small>
              </span>
            </summary>
            <div className="pk-more__body">
              {mode !== "house" && (
                <div className="pt-stake">
                  <span id="pt-seats">Seats</span>
                  <div className="pt-picker" role="radiogroup" aria-labelledby="pt-seats">
                    {seatChoices.map((count) => (
                      <button key={count} type="button" role="radio" aria-checked={seats === count} className="pt-picker__seat" onClick={() => setSeats(count)}>
                        {count}
                      </button>
                    ))}
                  </div>
                </div>
              )}
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
                  <dd>{TURN_SECONDS} seconds a step; a seat that is late is folded or given up</dd>
                </div>
                <div>
                  <dt>Starts</dt>
                  <dd>when full, or when you start it with two or more</dd>
                </div>
              </dl>
            </div>
          </details>
          {mode === "house" ? (
            <p className="pk-fine">
              The house opens the table, holds seat 1 and plays it for {FREE_TABLE_HANDS} hands; you take seat 2. Your game account signs each step and the house pays the gas.
            </p>
          ) : mode === "friends" ? (
            <p className="pk-fine">The house opens the table, holds seat 1 and pays the gas. Send the link to friends, then start when you like.</p>
          ) : short ? null : (
            <p className="pk-fine">
              You take seat 1. Send the link, or fill seats with the house{houses.length ? ` (up to ${houses.length} of its accounts)` : ""} from the table. Keep about 0.6 NEAR in
              the account: nearly all the gas of a hand goes to checking your shuffle proof, which must be able to reserve 0.26 NEAR. Your chips come back when you leave; the
              record fee does not.
            </p>
          )}
          {/* Too little on the account for this stake: the way to the missing NEAR, right under it. */}
          {/* A wallet or Google account that holds enough: one approval moves it, and the table opens. */}
          {short && backer && backerCan && !typedProblem && (
            <p className="pk-fine">
              One approval {backer.via === "wallet" ? "in your wallet" : "in the sign-in window"}: {asNear(toMove).replace(/\.?0+ NEAR$/, "")} NEAR moves from{" "}
              {shortAccount(backer.accountId)} to your poker account (the stake for 100 chips, a small record fee, and about half a NEAR that the check of your shuffle proof must
              be able to reserve), and the table opens. What you leave with goes back to {shortAccount(backer.accountId)} in one tap.
            </p>
          )}
          {short && backer && !backerCan && typeof clubBalance === "bigint" && !typedProblem && (
            <p className="pk-fine">
              {shortAccount(backer.accountId)} holds {asNear(clubBalance)}: this table needs {asNear(toMove).replace(/\.?0+ NEAR$/, "")} NEAR moved to your poker account.
            </p>
          )}
          {short && payer && !backerCan && !typedProblem && (
            <div className="pk-topup">
              <TopUp
                player={payer}
                balance={balance}
                needed={needed}
                onArrived={readBalance}
                made="the stake for 100 chips, a small record fee, and about half a NEAR that the check of your shuffle proof must be able to reserve; the chips you leave with and nearly all of the reserve come back"
              />
            </div>
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

function LiveTable({
  id,
  firstSeq,
  session,
  backer = null,
  payer = null,
  onSignIn,
  onBack,
}: {
  id: string;
  firstSeq: number;
  session: Session | null;
  /** The seat's own account as a player, for bringing NEAR it lacks (through 1Click, or to its address). */ payer?: Player | null;
  /** The club account that fills the poker account kept beside it, when there is one. */ backer?: Player | null;
  onSignIn: () => void;
  onBack: () => void;
}) {
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
  /** How far this device's clock runs ahead of the chain's (seat.ts `clockAhead`); `null` until a clock was seen to restart. */
  const [ahead, setAhead] = useState<number | null>(null);
  const lastDeadline = useRef<string | null>(null);
  const seq = useRef(firstSeq);
  /**
   * A call the node did not answer. Whether it landed is read from the table: `took` says whether a table shows what
   * the call would have changed. That the table moved on does not: on 2026-11-14 a "Leave the table" the sponsor never
   * sent was written down as landed because the house had shuffled meanwhile, and the seat ran out of time unattended.
   */
  const unsure = useRef<{ seq: number; at: number; line: string; seat?: number; duty?: boolean; took: (table: TableView | null) => boolean } | null>(null);
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
    const settle = (at: TableView | null) => {
      const pending = unsure.current;
      if (!pending) return;
      const took = pending.took(at);
      // Not there yet: it may still be on its way until the table has moved on and a while has passed.
      if (!took && at && (at.seq <= pending.seq || Date.now() - pending.at < UNSURE_MS)) return;
      unsure.current = null;
      setRefused("");
      if (took) say(`${pending.line} (the node gave no receipt; the table shows it landed)`, undefined, pending.seat);
      // The seat's own step is sent again at once; a click is the player's to make again.
      else if (pending.duty) playedStep.current = null;
      else if (at) {
        refusedAt.current = at.seq;
        setRefused(`This did not reach the table: "${pending.line}". Press it again.`);
      }
    };
    const run = async () => {
      while (alive) {
        try {
          const at = await readTable(id, seq.current, () => alive);
          if (!alive) return;
          if (!at) {
            settle(null);
            setResult(await viewResult(id));
            setView(null);
            return;
          }
          if (at.seq < seq.current) continue;
          seq.current = at.seq;
          setView(at);
          setTrouble("");
          if (lastDeadline.current !== null && at.deadline !== lastDeadline.current && at.deadline !== "0") {
            const seen = clockAhead(at, Date.now());
            setAhead((before) => (before === null ? seen : Math.min(before, seen)));
          }
          lastDeadline.current = at.deadline;
          settle(at);
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
                  unsure.current = { seq: at.seq, at: Date.now(), line, seat, duty: true, took: (now) => tookEffect(call.method, session.accountId, seat, at, now) };
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

  /** Sends a call a click asked for: `method` of the contract. Returns whether the contract took it. */
  const click = async (line: string, seat: number | undefined, method: string, send_: () => Promise<{ hash?: string }>): Promise<boolean> => {
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
      if (unanswered(error)) unsure.current = { seq: view.seq, at: Date.now(), line, seat, took: (now) => tookEffect(method, accountId ?? "", mySeat, view, now) };
      else refusedAt.current = view.seq;
      setRefused(unanswered(error) ? NO_ANSWER : text(error));
      return false;
    } finally {
      setSending(false);
    }
  };

  const mySeat = view ? seatOf(view) : null;
  const myCards = hole.hand === view?.hand ? hole.cards : null;

  // What the seat's account holds. At a table with a stake the seat pays its own gas, and the check of its shuffle
  // proof must be able to reserve about a quarter of a NEAR: an account without it cannot play its seat.
  const [held, setHeld] = useState<bigint | null | undefined>(undefined);
  const readHeld = useCallback(() => {
    if (session) void tableClient.balance(session.accountId).then(setHeld, () => undefined);
  }, [session]);
  useEffect(() => {
    if (!session) return;
    readHeld();
    const timer = setInterval(readHeld, 6_000);
    return () => clearInterval(timer);
  }, [session, readHeld]);
  const stakeHere = view ? BigInt(view.stake) : 0n;
  const seatNeeds = stakeHere + RECORD_FEE + NEAR / 2n;
  const holds = held ?? 0n;
  // Asked for a seat the account cannot afford yet: it is taken by itself once the NEAR is there.
  const [wantSeat, setWantSeat] = useState(false);
  const [adding, setAdding] = useState(false);
  const starved = stakeHere > 0n && mySeat !== null && held !== undefined && holds < PLAY_RESERVE;
  const lacking =
    !session || !view || stakeHere === 0n
      ? null
      : mySeat === null && wantSeat && holds < seatNeeds
        ? { needed: seatNeeds, sitting: true }
        : starved
          ? { needed: PLAY_TOP_UP, sitting: false }
          : null;
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
      const took = await send_(`Seat ${seat + 1}${byAgent ? "'s agent" : ""} ${line}`, seat, "act", async () => send(session, await betCall(at, seat, action, amount, keys, store)));
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
  // Signed out, "Sit down" makes a guest game account first and sits once it is there.
  const [sitting, setSitting] = useState(false);
  useEffect(() => {
    if (sitting && session && view) {
      setSitting(false);
      void click("Took a seat", undefined, "join", () => takeSeat(session, id, BigInt(view.stake)));
    }
  });

  // Past its deadline the table waits for nobody: a seated page calls time on the late seats by itself, so that one
  // player who walked away does not hold the others. Tried again every few seconds while the table stays late (the
  // chain's clock may be a little behind this one's, and somebody else's call may have been quicker).
  const calledTime = useRef<{ seq: number; at: number } | null>(null);
  /** The time by the chain's clock, as near as this page can tell. */
  const clock = now - (ahead ?? 0);
  useEffect(() => {
    // Never while this seat's own part is owed: it would be ruled late with the others.
    if (!session || !view || mySeat === null || !callsTime(view, mySeat, clock, TIME_GRACE_MS)) return;
    const last = calledTime.current;
    if (last && last.seq === view.seq && now - last.at < TIME_RETRY_MS) return;
    calledTime.current = { seq: view.seq, at: now };
    callTime(session, id).then(
      (outcome) => say("Time was called on the late seats", outcome.hash),
      () => undefined,
    );
  }, [now, clock, view, mySeat, session, id, say]);

  // The seat's own bet with its clock nearly out: the page checks for it, or folds to a bet (seat.ts `clockMove`).
  // Once per bet, and again a few seconds later if that did not go through.
  const clocked = useRef<{ bets: number; at: number } | null>(null);
  useEffect(() => {
    if (!view || mySeat === null || locked) return;
    const move = clockMove(view, mySeat, clock);
    const last = clocked.current;
    if (!move || (last && last.bets === view.bets && now - last.at < CLOCK_RETRY_MS)) return;
    clocked.current = { bets: view.bets, at: now };
    void bet(move, undefined, move === "fold" ? "folds: its clock ran down" : "checks: its clock ran down");
  }, [now, clock, view, mySeat, locked, bet]);

  // The NEAR for a seat that was asked for has arrived: the seat is taken.
  useEffect(() => {
    if (!wantSeat || !session || !view || mySeat !== null || holds < seatNeeds) return;
    setWantSeat(false);
    void latest.current.click("Took a seat", undefined, "join", () => takeSeat(session, id, stakeHere));
  }, [wantSeat, session, view, mySeat, holds, seatNeeds, id, stakeHere]);
  /** The club account behind the poker account brings it up to what the seat lacks: one approval. */
  const addFromClub = async () => {
    if (!backer || !session || !lacking) return;
    setAdding(true);
    setRefused("");
    try {
      await fundPoker(backer, session.accountId, lacking.needed);
      readHeld();
    } catch (error) {
      setRefused(text(error));
    }
    setAdding(false);
  };

  if (view === null) return <TableSettled id={id} result={result} log={log} you={accountId} houses={house.accounts ?? []} onBack={onBack} />;

  const shown = view ?? UNREAD;
  return (
    <>
      <RoundTable
        id={id}
        view={shown}
        you={accountId}
        mySeat={mySeat}
        myCards={myCards}
        locked={locked || !view}
        doing={sending ? "Sending to the contract…" : doing}
        now={clock}
        problems={[refused, trouble].filter(Boolean).map((problem) => (/NotEnoughBalance/.test(problem) ? LACKS_NEAR : problem))}
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
          opened: house.opened,
          models: house.models,
          defaultModel: house.defaultModel,
          seatModels: house.seatModels,
          seating,
        }}
        agent={{ ...agent, said: agentSaid }}
        on={{
          act: (action, amount, line) => void bet(action, amount ?? undefined, line),
          sit: () => {
            if (!session) {
              setSitting(true);
              onSignIn();
              return;
            }
            if (!view) return;
            const stake = BigInt(view.stake);
            // A seat with a stake on an account that cannot also reserve a shuffle's gas would only run out of time:
            // the NEAR is asked for first, right here, and the seat is taken when it has arrived.
            if (stake > 0n && !backer && holds < stake + RECORD_FEE + NEAR / 2n) {
              setWantSeat(true);
              return;
            }
            void click("Took a seat", undefined, "join", async () => {
              // A seat with a stake: the poker account is brought up to it from the club account first, in one approval.
              if (backer && stake > 0n) await fundPoker(backer, session.accountId, stake + RECORD_FEE + NEAR / 2n);
              return takeSeat(session, id, stake);
            });
          },
          // A free table is hosted by the server: it is asked to start it. Any other is started by its host's own call.
          start: () =>
            session &&
            view &&
            void click("Started the table", undefined, "start", () => (isFreeStake(view) && view.host !== session.accountId ? startFreeTable(id) : startTable(session, id))),
          // Off a table between hands the seat is cashed out at once, and the page goes back to the tables.
          leave: () => {
            if (!session) return;
            const inHand = mySeat !== null && Boolean(view?.dealt.includes(mySeat));
            void click(inHand ? "Asked to leave after this hand" : "Left the table and cashed out", mySeat ?? undefined, "leave", () => leaveTable(session, id)).then(
              (left) => left && !inHand && onBack(),
            );
          },
          back: onBack,
          callTime: () => session && void click("Called time on the late seats", undefined, "timeout", () => callTime(session, id)),
          addHouse: (models) => {
            setRefused("");
            void seatHouses(models);
          },
        }}
      />
      {/* The seat's account lacks the NEAR to sit down, or to go on: the way to it, at the table. */}
      {lacking && session && (
        <section className="pk-stub pk-fund" aria-label="Add NEAR for this seat">
          {backer ? (
            <>
              <p className="pk-fund__lead">
                <b>{lacking.sitting ? "A seat here needs NEAR on your poker account." : "Your poker account is low on NEAR."}</b> It holds {asNear(holds)};{" "}
                {lacking.sitting ? "the seat" : "playing on"} needs {asNear(lacking.needed)}: {lacking.sitting ? "the stake for 100 chips, a small record fee, and " : ""}about half
                a NEAR that the check of your shuffle proof must be able to reserve. Nearly all of the reserve comes back.
              </p>
              <button type="button" className="pk-go" disabled={adding} onClick={() => void addFromClub()}>
                {adding
                  ? backer.via === "wallet"
                    ? "Approve it in your wallet…"
                    : "Approve it in the sign-in window…"
                  : `Add ${asNear(amountToMove(lacking.needed, held)).replace(/\.?0+ NEAR$/, "")} NEAR from ${shortAccount(backer.accountId)}`}
              </button>
            </>
          ) : payer ? (
            <TopUp
              player={payer}
              balance={held}
              needed={lacking.needed}
              onArrived={readHeld}
              made={
                lacking.sitting
                  ? "the stake for 100 chips, a small record fee, and about half a NEAR that the check of your shuffle proof must be able to reserve; the chips you leave with and nearly all of the reserve come back"
                  : "what the check of your shuffle proof must be able to reserve each hand; nearly all of it comes back"
              }
            />
          ) : null}
          {lacking.sitting && (
            <button type="button" className="pk-pill pk-pill--quiet" onClick={() => setWantSeat(false)}>
              Not now
            </button>
          )}
        </section>
      )}
    </>
  );
}

/** A call the node did not answer is given this long to show in the table before it is taken as not sent. */
const UNSURE_MS = 8_000;
/** A seated page calls time this long after a step's deadline, and again this often while the table stays late. */
const TIME_GRACE_MS = 4_000;
const TIME_RETRY_MS = 12_000;
/** A bet the page made because the clock ran down is tried again this often while it has not gone through. */
const CLOCK_RETRY_MS = 5_000;
/** Below this a seat at a table with a stake cannot send its shuffle: the call must be able to reserve 0.26 NEAR. */
const PLAY_RESERVE = (27n * NEAR) / 100n;
/** What a seat that ran low is brought back up to. */
const PLAY_TOP_UP = (4n * NEAR) / 10n;
const LACKS_NEAR = "Your account holds too little NEAR for this step. Add some below: the page goes on by itself when it lands.";

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
  // A long account id is cut short here as at the table; the whole of it is in the title of each line.
  const who = (account: string) => (account === you ? "You" : houses.includes(account) ? `House ${houses.indexOf(account) + 1}` : shortAccount(account));
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
