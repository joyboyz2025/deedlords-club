"use client";

import Link from "next/link";
import { useEffect, useId, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import goldFoil from "@/assets/plates/gold-foil.webp";
import paper from "@/assets/plates/strip-paper.png";
import { Arrow, Bot, Copy, Plane, Sliders, Spark, User } from "@/components/landing/icons";
import { CHAIN } from "@/lib/chain/config";
import { MAX_STYLE, MAX_WISH, RULES_MODEL } from "../agent/llm";
import { BAIL_RULES, BUILD_ORDERS, MAX_CAUTION, MAX_CUSHION, MAX_RESERVE, PRESETS, SELL_ORDERS, describePlaybook, type Playbook } from "../agent/playbook";
import { MAX_NAME, MAX_RULE, MAX_RULES, instructions } from "../agent/roster";
import { formatNear, seatNames, shortAccount } from "../chain/adapt";
import { SMALLEST_STAKE, TURN_SECONDS, near, neededToOpen, roundOf, roundsLabel } from "../chain/calls";
import { devFund, type DevConfig } from "../chain/devSession";
import { exportGameKey } from "../chain/keySession";
import { QRCodeSVG } from "qrcode.react";
import type { ChainListed } from "../chain/types";
import type { AgentDesk } from "../chain/useAgent";
import { approvesInWindow, withdraw, type Player, type PlayerState } from "../chain/usePlayer";
import { ChibiFace } from "../../chibi/components/CharacterTag";
import { HallBar } from "@/components/hall/HallBar";
import { SignIn } from "@/components/hall/SignIn";
import { CrossChain } from "./CrossChain";
import { NearAiKeyPanel, useNearAi } from "./NearAiKey";
import { OWN_PREFIX, isOwnModel, modelLabel } from "@/lib/agentKey";
import { useCharacter, useCharacters } from "../../chibi/useChibi";

// The front desk of the game, shared by /play and by the gate of one match: the top row, the departures board on the
// wall, and the stubs of the player's own ticket (who they are, the agent that can fly their seat). The forms are the
// landing page's: red hall, cream ticket paper, a dark board with a gold hairline.

const problemText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export type HallPage = "play" | "gate" | "agents" | "account" | "character" | "shop" | "bag";

/**
 * The page shell: it carries the two plates the stylesheet paints with, ticket paper and gold foil. The top row is
 * the same on every page of the hall: the games' board, the visitor's agents, their account, and the network.
 * `account`: who is signed in (`null`: nobody; `undefined`: not known yet).
 */
export function Hall({ children, page = "play", account }: { children: ReactNode; page?: HallPage; account?: { accountId: string; balance: bigint | null | undefined } | null }) {
  const gate = page === "gate";
  return (
    <main
      className="fd"
      data-gate={gate || undefined}
      data-page={page}
      style={
        {
          "--fd-paper": `url(${paper.src})`,
          "--fd-foil": `url(${goldFoil.src})`,
        } as CSSProperties
      }
    >
      <HallBar current={gate ? "play" : page} account={account} />
      {children}
    </main>
  );
}

/**
 * A word on the departures board, one flap a character. A character that changes is a new flap: it drops in on its
 * own, so the eye catches the row that moved. Read aloud as the plain word.
 */
export function Flap({ text }: { text: string }) {
  return (
    <span className="fd-flap" role="img" aria-label={text}>
      {[...text].map((char, i) => (
        <i key={`${i}:${char}`} style={{ "--i": i } as CSSProperties} data-gap={char === " " || undefined} aria-hidden="true">
          {char}
        </i>
      ))}
    </span>
  );
}

/** What the winner of a duel takes from the pot, as the contract shares it. */
function winnerTakes(match: ChainListed): string {
  const pot = BigInt(match.stake) * BigInt(match.seats.length);
  const afterFee = pot - (pot * BigInt(match.fee_bps)) / 10_000n;
  return formatNear(((afterFee * BigInt(match.split[0] ?? 10_000)) / 10_000n).toString(), 3);
}

/** A departures board is never short: lines with no match stand blank, as on the real thing. */
const BOARD_LINES = 7;

/** The matches the contract holds, as a departures board. Every row opens its match. */
export function DeparturesBoard({
  matches: listed,
  offline,
  linkTo,
  you,
}: {
  matches: ChainListed[] | null;
  offline: boolean;
  linkTo: (id: string) => string;
  you: string | null;
}) {
  // Read the characters of everyone seated: the rows then show their names and faces (seatNames looks them up).
  const characters = useCharacters(listed?.flatMap((match) => match.seats.map((seat) => seat.backer)) ?? []);
  // What a player can do something about comes first: their own matches, then matches with a seat to take, then the
  // ones under way. On a phone the board shows the first few and folds the rest under one button.
  const [unfolded, setUnfolded] = useState(false);
  const rank = (match: ChainListed) =>
    you !== null && match.seats.some((seat) => seat.backer === you) ? 0 : match.status === "lobby" && match.seats.some((seat) => seat.backer === null) ? 1 : 2;
  const matches = listed && [...listed].sort((a, b) => rank(a) - rank(b));
  const folded = matches !== null && matches.length > BOARD_FOLD && !unfolded;
  return (
    <section className="fd-board" id="departures" aria-label="Matches the contract holds">
      <h2 className="fd-board__title">
        <Plane size={24} /> <span>Departures</span>
      </h2>
      {offline && (
        <p className="fd-board__note" role="status">
          Cannot reach {CHAIN.network} right now, trying again…
        </p>
      )}
      {matches === null ? (
        !offline && <p className="fd-board__note">Reading the contract…</p>
      ) : (
        <>
          {matches.length === 0 && <p className="fd-board__note">No match is open right now. Open one at the desk and send its link to a friend.</p>}
          <div className="fd-rows" role="table" aria-label="Matches">
            <div className="fd-row fd-row--head" role="row">
              <span role="columnheader">Match</span>
              <span role="columnheader">Seats</span>
              <span role="columnheader">Stake</span>
              <span role="columnheader">Winner takes</span>
              <span role="columnheader">Rounds</span>
              <span role="columnheader">Status</span>
            </div>
            {matches.map((match, line) => {
              const names = seatNames(match);
              const open = match.seats.filter((seat) => seat.backer === null).length;
              const mine = you !== null && match.seats.some((seat) => seat.backer === you);
              const boarding = match.status === "lobby";
              return (
                <Link key={match.id} className="fd-row" role="row" href={linkTo(match.id)} data-mine={mine || undefined} data-folded={(folded && line >= BOARD_FOLD) || undefined}>
                  <span className="fd-row__code" role="cell">
                    {match.id}
                  </span>
                  <span className="fd-row__seats" role="cell">
                    {match.seats.map((seat) => (
                      <b key={seat.seat} data-open={seat.backer === null || undefined}>
                        {seat.backer !== null && characters.get(seat.backer) && <ChibiFace character={characters.get(seat.backer)} size={22} />}
                        {seat.backer === null ? "open seat" : seat.backer === you ? "you" : names[seat.seat]}
                      </b>
                    ))}
                  </span>
                  <span role="cell" data-label="Stake">
                    {match.stake === "0" ? (
                      "Free"
                    ) : (
                      <>
                        {formatNear(match.stake)} <small>NEAR</small>
                      </>
                    )}
                  </span>
                  <span role="cell" data-label="Winner takes">
                    {match.stake === "0" ? (
                      "The table"
                    ) : (
                      <>
                        {winnerTakes(match)} <small>NEAR</small>
                      </>
                    )}
                  </span>
                  <span role="cell" data-label="Rounds">
                    {roundsLabel(match.rules.maxRounds)}
                  </span>
                  <span className="fd-row__status" role="cell">
                    {boarding ? <span className="fd-chip">{open > 0 ? "Boarding" : "Starting"}</span> : <Flap text={`ROUND ${roundOf(match.round, match.rules.maxRounds)}`} />}
                    <Arrow size={18} className="fd-row__go" />
                  </span>
                </Link>
              );
            })}
            {Array.from({ length: Math.max(0, BOARD_LINES - matches.length) }, (_, line) => (
              <div key={line} className="fd-row fd-row--blank" aria-hidden="true">
                <span />
                <span />
                <span />
                <span />
                <span />
                <span className="fd-flap">
                  {Array.from({ length: 8 }, (_, cell) => (
                    <i key={cell} />
                  ))}
                </span>
              </div>
            ))}
          </div>
          {folded && (
            <button type="button" className="fd-board__more" onClick={() => setUnfolded(true)}>
              Show all {matches.length} matches
            </button>
          )}
        </>
      )}
    </section>
  );
}

/** On a narrow screen the board shows this many rows before the rest is asked for. */
const BOARD_FOLD = 4;

function sourceLine(player: Player): string {
  if (player.via === "wallet") return `NEAR wallet · ${player.walletName.replace(/-/g, " ")}`;
  if (player.via === "helper") return "Test account of the local helper";
  if (player.source === "google") return `${player.label ?? "Google account"} · signed in through NEAR Auth`;
  return player.source === "evm"
    ? `Game account from ${player.evmAddress ? `${player.evmAddress.slice(0, 6)}…${player.evmAddress.slice(-4)}` : "your EVM wallet"}`
    : "Guest account, key kept in this browser";
}

/** The club's one sign-in ticket, with what the hall adds to it: the local helper's test accounts. */
export function CheckIn({ state, helper, onWatch }: { state: PlayerState; helper: DevConfig | null; onWatch?: () => void }) {
  return (
    <SignIn
      state={state}
      onWatch={onWatch}
      extra={helper && helper.players.length > 0 ? <TestAccounts players={helper.players} current={null} onChange={state.playAs} /> : undefined}
    />
  );
}

/** Below this a game account cannot open the smallest match, and the helper's faucet may top it up. */
const LOW_BALANCE = near(0.25);
/** What the smallest match of the page needs on a game account: the one amount a newcomer is told to send. */
const TO_START = neededToOpen({ stake: near(SMALLEST_STAKE), maxRounds: 6, turnSeconds: TURN_SECONDS });

/** The first stub: who plays here. Three ways in for a visitor; the account, its balance and its keys for a player. */
export function PassengerStub({
  state,
  helper,
  freePlay = false,
  wallet = false,
  compact = false,
  onSignIn,
}: {
  state: PlayerState;
  helper: DevConfig | null;
  /** Somebody sponsors free tables here: an account with no NEAR can play them. */ freePlay?: boolean;
  /** The account's own page: deposit, withdraw and keys are here. Elsewhere the stub says who plays and points to it. */
  wallet?: boolean;
  /**
   * Before a game: one line for who plays and one way to the wallet. Signed out, the ways in fold under one line, since
   * the stub that opens or joins a table signs a guest in by itself. Sign out, deposit and keys are on the account page.
   */
  compact?: boolean;
  /** For somebody looking on: back to the sign-in step. */
  onSignIn?: () => void;
}) {
  const { player, balance, problem } = state;
  const [note, setNote] = useState<string | null>(null);
  const [funding, setFunding] = useState(false);
  // The panel under the account: where NEAR comes in, or the form that sends it out.
  const [funds, setFunds] = useState<"deposit" | "withdraw" | "xchain" | null>(null);
  // The account's chibi character: its face and name stand for the account once it has one.
  const character = useCharacter(player?.accountId);
  if (player === undefined) {
    return (
      <section className="fd-stub" aria-live="polite">
        <h2 className="fd-stub__title">Passenger</h2>
        <p className="fd-small">Checking you in…</p>
      </section>
    );
  }

  // Nobody signed in. Before a game the page has already asked (the club's one sign-in step), so this is somebody
  // looking on: one line, and the way back to that step. Anywhere else, the sign-in ticket itself.
  if (player === null && compact) {
    return (
      <section className="fd-stub fd-stub--thin" aria-label="Not signed in">
        <div className="fd-watch">
          <p>
            <strong>Watching</strong>
            <small>Not signed in</small>
          </p>
          {onSignIn && (
            <button type="button" className="fd-pill fd-pill--ink" onClick={onSignIn}>
              <User size={16} /> Sign in
            </button>
          )}
        </div>
      </section>
    );
  }
  if (player === null) return <CheckIn state={state} helper={helper} />;

  const faucet = player.via === "key" && helper?.faucet ? helper.faucet : null;
  const low = balance === null || (balance !== undefined && balance < LOW_BALANCE);
  const cannotStart = balance === null || (balance !== undefined && balance < TO_START);
  // A game account with too little to open the smallest match: getting NEAR onto it is the one thing to do here.
  const unfunded = player.via === "key" && balance !== undefined && (faucet ? low : cannotStart);
  // Where free tables are sponsored an empty account can already play: funding it is for staking, not a first step.
  const needsFunds = unfunded && !freePlay;
  const copy = async (text: string, done: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNote(done);
    } catch {
      setNote(text);
    }
  };
  const fund = async () => {
    setFunding(true);
    setNote(null);
    try {
      const answer = await devFund(player.accountId);
      setNote(answer.funded ? `${formatNear(faucet ?? "0")} test NEAR is on its way.` : "This account already has enough to play.");
      // The transfer has run; the node asked next may still be a block behind it.
      for (let i = 0; i < 4; i++) {
        await new Promise((resolve) => setTimeout(resolve, 900));
        await state.refreshBalance();
      }
    } catch (error) {
      setNote(problemText(error));
    }
    setFunding(false);
  };
  const signOut = () => {
    const guest = player.via === "key" && player.source === "guest";
    if (
      guest &&
      !window.confirm("This browser will forget the key of your guest account, and whatever the account holds goes with it. Copy the key first if you want to keep it. Sign out?")
    )
      return;
    state.signOut();
  };

  if (compact) {
    return (
      <section className="fd-stub fd-stub--thin" aria-label="Your account">
        <div className="fd-who fd-who--thin">
          {character ? (
            <ChibiFace character={character} size={36} />
          ) : (
            <span className="fd-stamp" aria-hidden="true">
              {player.accountId
                .replace(/[^a-z0-9]/gi, "")
                .slice(0, 2)
                .toUpperCase()}
            </span>
          )}
          <p>
            <strong title={player.accountId}>{character?.name ?? shortAccount(player.accountId)}</strong>
            <small>{sourceLine(player)}</small>
          </p>
          <Link className="fd-balance fd-balance--link" href="/account" data-low={(low && !freePlay) || undefined} aria-label="Your wallet: balance, deposit, sign out">
            {balance === undefined ? (
              <small>reading…</small>
            ) : balance === null ? (
              <small>{freePlay ? "no NEAR needed" : "not on chain yet"}</small>
            ) : (
              <>
                <strong>{formatNear(balance.toString())}</strong>
                <small>NEAR</small>
              </>
            )}
            <Arrow size={16} />
          </Link>
        </div>
        {needsFunds &&
          (faucet ? (
            <button type="button" className="fd-go" disabled={funding} onClick={fund}>
              {funding ? "Sending…" : `Get ${formatNear(faucet)} test NEAR`}
            </button>
          ) : (
            <button
              type="button"
              className="fd-go"
              onClick={() => copy(player.accountId, `Address copied. Send it ${formatNear(TO_START.toString(), 2)} NEAR or more and this page shows the balance.`)}
            >
              <Copy size={18} /> Copy the address to fund it
            </button>
          ))}
        {needsFunds && (
          <p className="fd-fine">
            {faucet
              ? "This account cannot play yet. The local faucet sends it enough for the smallest match."
              : `This account cannot play yet. The smallest match needs ${formatNear(TO_START.toString(), 2)} NEAR on it: send that much or more from any NEAR wallet${CHAIN.network === "mainnet" ? ", or bring it in from another chain on your account page" : ` (test NEAR on ${CHAIN.network})`}.`}
          </p>
        )}
        {player.via === "helper" && helper && <TestAccounts players={helper.players} current={player.accountId} onChange={state.playAs} />}
        {(note ?? problem) && (
          <p className="fd-fine" role="status">
            {note ?? problem}
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="fd-stub" aria-label="Your account">
      <h2 className="fd-stub__title">Passenger</h2>
      <div className="fd-who">
        {character ? (
          <ChibiFace character={character} size={46} />
        ) : (
          <span className="fd-stamp" aria-hidden="true">
            {player.accountId
              .replace(/[^a-z0-9]/gi, "")
              .slice(0, 2)
              .toUpperCase()}
          </span>
        )}
        <p>
          <strong title={player.accountId}>{character?.name ?? shortAccount(player.accountId)}</strong>
          <small>
            {character ? `${shortAccount(player.accountId)} · ` : ""}
            {sourceLine(player)}
          </small>
          {character === null && (
            <Link className="fd-who__ask" href="/character">
              Make your character, free
            </Link>
          )}
        </p>
        <p className="fd-balance" data-low={(low && !freePlay) || undefined}>
          {balance === undefined ? (
            <small>reading…</small>
          ) : balance === null ? (
            <small>{freePlay ? "no NEAR needed" : "not on chain yet"}</small>
          ) : (
            <>
              <strong>{formatNear(balance.toString())}</strong>
              <small>NEAR</small>
            </>
          )}
        </p>
      </div>
      {needsFunds &&
        (faucet ? (
          <button type="button" className="fd-go" disabled={funding} onClick={fund}>
            {funding ? "Sending…" : `Get ${formatNear(faucet)} test NEAR`}
          </button>
        ) : (
          <button
            type="button"
            className="fd-go"
            onClick={() => copy(player.accountId, `Address copied. Send it ${formatNear(TO_START.toString(), 2)} NEAR or more and this page shows the balance.`)}
          >
            <Copy size={18} /> Copy the address to fund it
          </button>
        ))}
      {needsFunds && (
        <p className="fd-fine">
          {faucet
            ? "This account cannot play yet. The local faucet sends it enough for the smallest match."
            : `This account cannot play yet. The smallest match needs ${formatNear(TO_START.toString(), 2)} NEAR on it: send that much or more from any NEAR wallet${CHAIN.network === "mainnet" ? ", or bring it in from another chain on your account page" : ` (test NEAR on ${CHAIN.network})`}.`}
          {!faucet && CHAIN.network === "testnet" && (
            <>
              {" "}
              No NEAR wallet yet?{" "}
              <a href="https://docs.near.org/getting-started/faucet" target="_blank" rel="noreferrer noopener">
                Ask a testnet faucet
              </a>
              .
            </>
          )}
        </p>
      )}
      {unfunded && freePlay && (
        <p className="fd-fine">
          Free tables are open to this account as it is. To play for a stake, deposit {formatNear(TO_START.toString(), 2)} NEAR or more (
          {CHAIN.network === "mainnet" ? "from a NEAR wallet, or from another chain on your account page" : `test NEAR on ${CHAIN.network}`})
          {approvesInWindow(player) ? "; you approve each stake in the sign-in window." : "."}
        </p>
      )}
      {!wallet && (
        <div className="fd-acts">
          <Link className="fd-pill" href="/account">
            Wallet
          </Link>
          <button type="button" className="fd-pill fd-pill--quiet" onClick={signOut}>
            Sign out
          </button>
        </div>
      )}
      {wallet && (
        <div className="fd-acts">
          {player.via === "key" && (
            <button type="button" className="fd-pill" aria-expanded={funds === "deposit"} onClick={() => setFunds(funds === "deposit" ? null : "deposit")}>
              Deposit
            </button>
          )}
          {player.via === "key" && balance !== undefined && balance !== null && balance > WITHDRAW_KEEPS && (
            <button type="button" className="fd-pill" aria-expanded={funds === "withdraw"} onClick={() => setFunds(funds === "withdraw" ? null : "withdraw")}>
              Withdraw
            </button>
          )}
          {player.via === "key" && (
            <button type="button" className="fd-pill" aria-expanded={funds === "xchain"} onClick={() => setFunds(funds === "xchain" ? null : "xchain")}>
              Other chains
            </button>
          )}
          {player.via === "key" && player.source === "guest" && (
            <button type="button" className="fd-pill fd-pill--quiet" onClick={() => copy(exportGameKey() ?? "", "Key copied. Keep it somewhere safe: it is the account.")}>
              <Copy /> Back up the key
            </button>
          )}
          <button type="button" className="fd-pill fd-pill--quiet" onClick={signOut}>
            Sign out
          </button>
        </div>
      )}
      {wallet && player.via === "key" && funds === "deposit" && <Deposit accountId={player.accountId} onCopied={setNote} />}
      {wallet && player.via === "key" && funds === "withdraw" && balance !== undefined && balance !== null && (
        <Withdraw player={player} balance={balance} onSent={() => void state.refreshBalance()} />
      )}
      {wallet && player.via === "key" && funds === "xchain" && <CrossChain player={player} balance={balance} onArrived={() => void state.refreshBalance()} />}
      {player.via === "helper" && helper && <TestAccounts players={helper.players} current={player.accountId} onChange={state.playAs} />}
      {(note ?? problem) && (
        <p className="fd-fine" role="status">
          {note ?? problem}
        </p>
      )}
    </section>
  );
}

/** A transfer burns about 0.00005 NEAR; this much stays so the account can still pay for it, and for a move after. */
const WITHDRAW_KEEPS = near(0.005);
const ACCOUNT_ID = /^(?:[0-9a-f]{64}|(?=.{2,64}$)[a-z0-9]+(?:[-_.][a-z0-9]+)*)$/;

/** Where NEAR comes in: the account's address, to copy or to scan. Anything sent to it shows as the balance above. */
function Deposit({ accountId, onCopied }: { accountId: string; onCopied: (note: string) => void }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(accountId);
      onCopied("Address copied.");
    } catch {
      onCopied(accountId);
    }
  };
  return (
    <div className="fd-funds">
      <div className="fd-funds__qr">
        <QRCodeSVG value={accountId} size={112} bgColor="transparent" fgColor="#2a1208" level="M" />
      </div>
      <div className="fd-funds__how">
        <p className="fd-small">Send NEAR on {CHAIN.network} to this address from any wallet or exchange. It shows here a few seconds after it lands.</p>
        <code className="fd-funds__address">{accountId}</code>
        <div className="fd-acts">
          <button type="button" className="fd-pill" onClick={copy}>
            <Copy /> Copy address
          </button>
          {CHAIN.network === "testnet" && (
            <a className="fd-pill fd-pill--quiet" href="https://docs.near.org/getting-started/faucet" target="_blank" rel="noreferrer noopener">
              Testnet faucet
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

/** Sends NEAR out of a game account. A Google account approves it in the sign-in window; a guest's key signs it here. */
function Withdraw({ player, balance, onSent }: { player: Player; balance: bigint; onSent: () => void }) {
  const toId = useId();
  const amountId = useId();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const most = balance > WITHDRAW_KEEPS ? balance - WITHDRAW_KEEPS : 0n;
  const yocto = /^\d+(?:\.\d{1,5})?$/.test(amount.trim()) ? BigInt(Math.round(Number(amount) * 100_000)) * 10n ** 19n : null;
  const receiver = to.trim().toLowerCase();
  const problem =
    receiver && !ACCOUNT_ID.test(receiver)
      ? "That is not a NEAR account name."
      : receiver === player.accountId
        ? "That is this account."
        : amount.trim() && (yocto === null || yocto === 0n)
          ? "An amount in NEAR, with up to five decimals."
          : yocto !== null && yocto > most
            ? `At most ${formatNear(most.toString(), 5)} NEAR: a little stays to pay for the transfer.`
            : null;
  const ready = receiver !== "" && yocto !== null && yocto > 0n && problem === null;
  // Called straight from the click: for a Google account the approval window has to open in that very click.
  const send = (event: FormEvent) => {
    event.preventDefault();
    if (!ready || yocto === null) return;
    setSending(true);
    setFailed(null);
    setDone(null);
    withdraw(player, receiver, yocto)
      .then(
        (hash) => {
          setDone(hash);
          setAmount("");
          onSent();
        },
        (error) => setFailed(problemText(error)),
      )
      .finally(() => setSending(false));
  };
  return (
    <form className="fd-funds fd-funds--form" onSubmit={send}>
      <label className="fd-field" htmlFor={toId}>
        <span>To</span>
        <input
          id={toId}
          value={to}
          onChange={(event) => setTo(event.target.value)}
          placeholder={`you.${CHAIN.network === "testnet" ? "testnet" : "near"}`}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <label className="fd-field" htmlFor={amountId}>
        <span>Amount</span>
        <span className="fd-funds__amount">
          <input id={amountId} value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" placeholder="0.0" autoComplete="off" />
          <button type="button" className="fd-pill fd-pill--quiet" onClick={() => setAmount(formatNear(most.toString(), 5).replace(/,/g, ""))}>
            Max
          </button>
        </span>
      </label>
      <button type="submit" className="fd-pill fd-pill--ink" disabled={!ready || sending}>
        {sending ? (approvesInWindow(player) ? "Waiting for your approval…" : "Sending…") : approvesInWindow(player) ? "Approve and withdraw" : "Withdraw"}
      </button>
      {(problem ?? failed) && (
        <p className="fd-problem" role="alert">
          {problem ?? failed}
        </p>
      )}
      {done && (
        <p className="fd-fine" role="status">
          Sent.{" "}
          {CHAIN.explorerUrl && (
            <a href={`${CHAIN.explorerUrl}/txns/${done}`} target="_blank" rel="noreferrer noopener">
              See the transaction
            </a>
          )}
        </p>
      )}
    </form>
  );
}

/** With a local helper only: play as one of its test accounts. */
function TestAccounts({ players, current, onChange }: { players: string[]; current: string | null; onChange: (accountId: string | null) => void }) {
  const choices = current !== null && !players.includes(current) ? [current, ...players] : players;
  return (
    <label className="fd-field">
      <span>Test account</span>
      <select value={current ?? ""} onChange={(event) => onChange(event.target.value || null)}>
        <option value="">none</option>
        {choices.map((account) => (
          <option key={account} value={account}>
            {account}
          </option>
        ))}
      </select>
    </label>
  );
}

const BUILD_LABELS: Record<Playbook["build"], string> = {
  payback: "Best payback first",
  priciest: "Dearest cities first",
  cheapest: "Cheapest cities first",
  none: "Never build",
};
const BAIL_LABELS: Record<Playbook["bail"], string> = {
  smart: "While squares are for sale",
  always: "Always pay",
  never: "Never pay",
};
const SELL_LABELS: Record<Playbook["sell"], string> = {
  "least-earning": "What earns least",
  cheapest: "The cheapest",
  priciest: "The dearest",
};

/**
 * The second stub: the visitor's own AI agents. Each has a name, a model, and the owner's instructions: a prompt as
 * long as they like and any number of rules. The one picked is the one that flies the owner's seat. `roomy`: on a page
 * of its own, with room to write.
 */
export function AgentStub({ desk, signedIn, roomy = false, compact = false }: { desk: AgentDesk; signedIn: boolean; roomy?: boolean; compact?: boolean }) {
  const { agents, agent, auto, models, save, pick, add, remove, setAuto, write, writing, problem } = desk;
  const [adjusting, setAdjusting] = useState(false);
  const ids = useId();
  const nearAi = useNearAi();
  // A model on the player's own NEAR AI key plays while the key is in this browser; one of the server's while it is offered.
  // A `near:` name the server offers needs no key of the player's; with a key here it runs on that key.
  const ownKey = isOwnModel(agent.model) && nearAi.hasKey;
  const hasModel = agent.model !== RULES_MODEL && (ownKey || (models ?? []).includes(agent.model));
  const shown = modelLabel(agent.model, ownKey || !hasModel);
  const preset = PRESETS.find((entry) => JSON.stringify(entry.book) === JSON.stringify(agent.playbook));
  const set = (change: Partial<Playbook>) => save({ playbook: { ...agent.playbook, ...change }, written: null });
  const told = instructions(agent);
  const setRule = (index: number, rule: string | null) =>
    save({ rules: rule === null ? agent.rules.filter((_, i) => i !== index) : agent.rules.map((old, i) => (i === index ? rule : old)) });

  // Before a game: one switch, the agent it hands the seat to, and the way to the agents' own page.
  if (compact) {
    if (!signedIn) return null;
    return (
      <section className="fd-stub fd-stub--thin" aria-label="Your AI agent">
        <div className="fd-copilot">
          <label className="fd-switch">
            <input type="checkbox" checked={auto} onChange={(event) => setAuto(event.target.checked)} />
            <span>
              Let my agent play <small>from the first roll</small>
            </span>
          </label>
          {agents.length > 1 ? (
            <select aria-label="The agent that plays your seat" value={agent.id} onChange={(event) => pick(event.target.value)}>
              {agents.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          ) : (
            <b className="fd-copilot__name">
              <Bot size={16} /> {agent.name}
            </b>
          )}
          <Link className="fd-copilot__edit" href="/agents" aria-label={`Edit ${agent.name} and your other agents`}>
            <Sliders size={16} /> Agents
          </Link>
        </div>
        <p className="fd-fine">
          {hasModel ? shown : isOwnModel(agent.model) ? `${shown}, but no NEAR AI key in this browser: fallback numbers` : "Fallback numbers, no model"}
          {hasModel && (told ? `, told ${told.length.toLocaleString("en-US")} characters of yours.` : ", not told anything yet.")}
          {!hasModel && "."} You can also hand it your seat at the table.
        </p>
      </section>
    );
  }

  if (!signedIn) {
    return (
      <section className="fd-stub" aria-label="Your AI agents">
        <h2 className="fd-stub__title">
          Co-pilot <Bot size={22} />
        </h2>
        <p className="fd-small">An AI agent of your own that can fly your seat, from this tab, with your own game key.</p>
        <p className="fd-fine">Check in to make one: name it, pick its model, and tell it how to play in your own words. What you tell it is yours alone.</p>
      </section>
    );
  }

  // At a table the agents are only picked from: what each is told is written on the agents' own page.
  if (!roomy) {
    const rules = agent.rules.filter((rule) => rule.trim()).length;
    return (
      <section className="fd-stub" aria-label="Your AI agents">
        <h2 className="fd-stub__title">
          Co-pilot <Bot size={22} />
        </h2>
        <p className="fd-small">Pick the agent that flies your seat when you ask. It plays from this tab, with your own game key.</p>
        <div className="fd-agents" role="group" aria-label="Your agents">
          {agents.map((entry) => (
            <button key={entry.id} type="button" aria-pressed={entry.id === agent.id} onClick={() => pick(entry.id)}>
              {entry.name}
            </button>
          ))}
          <Link className="fd-agents__new" href="/agents">
            + New agent
          </Link>
        </div>
        <p className="fd-fine">
          <strong>{agent.name}</strong>:{" "}
          {hasModel ? shown : isOwnModel(agent.model) ? `${shown}, but no NEAR AI key in this browser: fallback numbers` : "fallback numbers, no model"}
          {hasModel &&
            (told
              ? `, told ${told.length.toLocaleString("en-US")} characters${rules > 0 ? ` and ${rules} ${rules === 1 ? "rule" : "rules"}` : ""} of yours`
              : ", not told anything yet")}
          .
        </p>
        <div className="fd-acts">
          <label className="fd-switch">
            <input type="checkbox" checked={auto} onChange={(event) => setAuto(event.target.checked)} />
            <span>Fly my seat from the first roll</span>
          </label>
          <Link className="fd-pill" href="/agents">
            <Sliders size={16} /> Edit my agents
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className="fd-stub" aria-label="Your AI agents">
      <h2 className="fd-stub__title">
        Co-pilot <Bot size={22} />
      </h2>
      <p className="fd-small">Your own AI agents. The one you pick flies your seat when you ask, from this tab, with your own game key.</p>

      <div className="fd-agents" role="group" aria-label="Your agents">
        {agents.map((entry) => (
          <button key={entry.id} type="button" aria-pressed={entry.id === agent.id} onClick={() => pick(entry.id)}>
            {entry.name}
          </button>
        ))}
        <button type="button" className="fd-agents__new" onClick={() => add("")}>
          + New agent
        </button>
      </div>

      <label className="fd-field">
        <span>Name</span>
        <input type="text" value={agent.name} maxLength={MAX_NAME} onChange={(event) => save({ name: event.target.value })} autoComplete="off" />
      </label>
      <NearAiKeyPanel nearAi={nearAi} />
      <label className="fd-field">
        <span>Model</span>
        <select value={hasModel ? agent.model : RULES_MODEL} onChange={(event) => save({ model: event.target.value })}>
          {(models ?? []).length > 0 && (
            <optgroup label="Offered by this server">
              {(models ?? []).map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </optgroup>
          )}
          {nearAi.hasKey && (nearAi.models ?? []).length > 0 && (
            <optgroup label="NEAR AI, on your key (USD per million tokens in / out)">
              {(nearAi.models ?? []).map((model) => (
                <option key={model.id} value={`${OWN_PREFIX}${model.id}`}>
                  {model.id} · {model.inPerMillion} / {model.outPerMillion}
                </option>
              ))}
            </optgroup>
          )}
          <option value={RULES_MODEL}>No model: fallback numbers only</option>
        </select>
      </label>
      {models !== null && models.length === 0 && !nearAi.hasKey && (
        <p className="fd-fine">No model is configured on this server: the fallback numbers alone play, unless you add a NEAR AI key above.</p>
      )}

      <div className="fd-prompt">
        <label htmlFor={`${ids}-prompt`}>
          How it should play <small>only you see this</small>
        </label>
        <textarea
          id={`${ids}-prompt`}
          rows={roomy ? 12 : 5}
          value={agent.prompt}
          maxLength={MAX_STYLE}
          placeholder="Explain your strategy in as much detail as you like: which cities to go after, how much cash to keep, when to build, what to give up first when in debt…"
          onChange={(event) => save({ prompt: event.target.value })}
        />
      </div>

      <div className="fd-rulelist" role="group" aria-label="Rules">
        <span>Rules</span>
        {agent.rules.map((rule, index) => (
          <div key={index}>
            <b aria-hidden="true">{index + 1}</b>
            <input
              type="text"
              value={rule}
              maxLength={MAX_RULE}
              aria-label={`Rule ${index + 1}`}
              placeholder="Never let cash drop below 200"
              onChange={(event) => setRule(index, event.target.value)}
            />
            <button type="button" className="fd-pill fd-pill--quiet" aria-label={`Remove rule ${index + 1}`} onClick={() => setRule(index, null)}>
              Remove
            </button>
          </div>
        ))}
        <button type="button" className="fd-pill" disabled={agent.rules.length >= MAX_RULES} onClick={() => save({ rules: [...agent.rules, ""] })}>
          + Add a rule
        </button>
      </div>
      <p className="fd-fine">
        {hasModel
          ? `Your prompt and rules stay in this browser and go to ${shown}${ownKey ? " at NEAR AI, straight from this tab," : ""} with each of your turns. Nobody else at the table is shown them, or what your agent says. ${told.length.toLocaleString("en-US")} of ${MAX_STYLE.toLocaleString("en-US")} characters.`
          : "A prompt and rules need a model to read them. Without one, this agent plays by its fallback numbers."}
      </p>

      <div className="fd-acts">
        <button type="button" className="fd-pill" aria-expanded={adjusting} aria-controls={`${ids}-rules`} onClick={() => setAdjusting(!adjusting)}>
          <Sliders size={16} /> {adjusting ? "Done" : "Fallback numbers"}
        </button>
        <label className="fd-switch">
          <input type="checkbox" checked={auto} onChange={(event) => setAuto(event.target.checked)} />
          <span>Fly my seat from the first roll</span>
        </label>
        {agents.length > 1 && (
          <button type="button" className="fd-pill fd-pill--quiet" onClick={() => window.confirm(`Delete the agent "${agent.name}" and what you told it?`) && remove()}>
            Delete agent
          </button>
        )}
      </div>

      {adjusting && (
        <div className="fd-editor" id={`${ids}-rules`}>
          <p className="fd-fine">What plays when no model is asked, or when the model is slow or refuses: six numbers and choices, worked out by arithmetic.</p>
          <label className="fd-field">
            <span>Start from</span>
            <select
              value={preset?.id ?? ""}
              onChange={(event) => {
                const chosen = PRESETS.find((entry) => entry.id === event.target.value);
                if (chosen) save({ playbook: chosen.book, written: null });
              }}
            >
              {!preset && <option value="">Your own numbers</option>}
              {PRESETS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
          {hasModel && (
            <button type="button" className="fd-pill fd-pill--ink" disabled={writing || told.trim().length < 3} onClick={() => void write(told.slice(0, MAX_WISH))}>
              <Spark size={16} /> {writing ? "Writing…" : "Set them from my prompt"}
            </button>
          )}
          {problem && (
            <p className="fd-problem" role="alert">
              The numbers were not written: {problem}. The ones below still play.
            </p>
          )}
          {agent.written && (
            <p className="fd-quote">
              <b>{agent.written.by}</b> {agent.written.reason}
            </p>
          )}
          <Range label="Cash always kept back" value={agent.playbook.reserve} max={MAX_RESERVE} step={10} onChange={(reserve) => set({ reserve })} />
          <Range label="Share of the worst rent ahead to cover" value={agent.playbook.caution} max={MAX_CAUTION} step={0.25} suffix="×" onChange={(caution) => set({ caution })} />
          <Choice label="Houses go" value={agent.playbook.build} options={BUILD_ORDERS} labels={BUILD_LABELS} onChange={(build) => set({ build })} />
          <Range label="Extra cash a house must leave" value={agent.playbook.cushion} max={MAX_CUSHION} step={10} onChange={(cushion) => set({ cushion })} />
          <Choice label="Bail out of Customs" value={agent.playbook.bail} options={BAIL_RULES} labels={BAIL_LABELS} onChange={(bail) => set({ bail })} />
          <Choice label="In debt, sell first" value={agent.playbook.sell} options={SELL_ORDERS} labels={SELL_LABELS} onChange={(sell) => set({ sell })} />
        </div>
      )}
      {!adjusting && !hasModel && (
        <ul className="fd-rules" aria-label="The fallback numbers">
          {describePlaybook(agent.playbook).map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Range({
  label,
  value,
  max,
  step,
  suffix = "",
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="fd-range">
      <span>
        {label}
        <output>
          {value}
          {suffix}
        </output>
      </span>
      <input type="range" min={0} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function Choice<T extends string>({
  label,
  value,
  options,
  labels,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  labels: Record<T, string>;
  onChange: (value: T) => void;
}) {
  return (
    <label className="fd-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value as T)}>
        {options.map((option) => (
          <option key={option} value={option}>
            {labels[option]}
          </option>
        ))}
      </select>
    </label>
  );
}
