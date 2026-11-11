"use client";

import Link from "next/link";
import { useEffect, useId, useState, type CSSProperties, type ReactNode } from "react";
import goldFoil from "@/assets/plates/gold-foil.webp";
import paper from "@/assets/plates/strip-paper.png";
import { Arrow, Bot, Chain, Copy, Gem, NearMark, Plane, Sliders, Spark, User } from "@/components/landing/icons";
import { CHAIN } from "@/lib/chain/config";
import { RULES_MODEL } from "../agent/llm";
import { BAIL_RULES, BUILD_ORDERS, MAX_CAUTION, MAX_CUSHION, MAX_RESERVE, PRESETS, SELL_ORDERS, describePlaybook, type Playbook } from "../agent/playbook";
import { formatNear, seatNames, shortAccount } from "../chain/adapt";
import { SMALLEST_STAKE, near, neededToOpen } from "../chain/calls";
import { devFund, type DevConfig } from "../chain/devSession";
import { googleSignInOffered, warmGoogleSignIn } from "../chain/googleSession";
import { exportGameKey } from "../chain/keySession";
import type { ChainListed } from "../chain/types";
import type { AgentDesk } from "../chain/useAgent";
import type { Player, PlayerState } from "../chain/usePlayer";

// The front desk of the game, shared by /play and by the gate of one match: the top row, the departures board on the
// wall, and the stubs of the player's own ticket (who they are, the agent that can fly their seat). The forms are the
// landing page's: red hall, cream ticket paper, a dark board with a gold hairline.

const problemText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The page shell: it carries the two plates the stylesheet paints with, ticket paper and gold foil. */
export function Hall({ children, gate = false }: { children: ReactNode; gate?: boolean }) {
  return (
    <main
      className="fd"
      data-gate={gate || undefined}
      style={
        {
          "--fd-paper": `url(${paper.src})`,
          "--fd-foil": `url(${goldFoil.src})`,
        } as CSSProperties
      }
    >
      <header className="fd-top">
        <Link className="fd-mark" href="/">
          Deedlords
        </Link>
        <nav aria-label="Deedlords">
          <Link href="/play" aria-current={gate ? undefined : "page"}>
            Departures
          </Link>
          <Link href="/#how">How it works</Link>
          <Link href="/#agents">AI agents</Link>
        </nav>
        <span className="fd-net">
          <Chain size={16} /> NEAR {CHAIN.network}
          <small>{CHAIN.contractId}</small>
        </span>
      </header>
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
export function DeparturesBoard({ matches, offline, linkTo, you }: { matches: ChainListed[] | null; offline: boolean; linkTo: (id: string) => string; you: string | null }) {
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
            {matches.map((match) => {
              const names = seatNames(match);
              const open = match.seats.filter((seat) => seat.backer === null).length;
              const mine = you !== null && match.seats.some((seat) => seat.backer === you);
              const boarding = match.status === "lobby";
              return (
                <Link key={match.id} className="fd-row" role="row" href={linkTo(match.id)} data-mine={mine || undefined}>
                  <span className="fd-row__code" role="cell">
                    {match.id}
                  </span>
                  <span className="fd-row__seats" role="cell">
                    {match.seats.map((seat) => (
                      <b key={seat.seat} data-open={seat.backer === null || undefined}>
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
                    {match.rules.maxRounds}
                  </span>
                  <span className="fd-row__status" role="cell">
                    {boarding ? (
                      <span className="fd-chip">{open > 0 ? "Boarding" : "Starting"}</span>
                    ) : (
                      <Flap text={`ROUND ${Math.min(match.round + 1, match.rules.maxRounds)}/${match.rules.maxRounds}`} />
                    )}
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
        </>
      )}
    </section>
  );
}

function sourceLine(player: Player): string {
  if (player.via === "wallet") return `NEAR wallet · ${player.walletName.replace(/-/g, " ")}`;
  if (player.via === "helper") return "Test account of the local helper";
  if (player.source === "google") return `${player.label ?? "Google account"} · signed in through NEAR Auth`;
  return player.source === "evm"
    ? `Game account from ${player.evmAddress ? `${player.evmAddress.slice(0, 6)}…${player.evmAddress.slice(-4)}` : "your EVM wallet"}`
    : "Guest account, key kept in this browser";
}

/** Below this a game account cannot open the smallest match, and the helper's faucet may top it up. */
const LOW_BALANCE = near(0.25);
/** What the smallest match of the page needs on a game account: the one amount a newcomer is told to send. */
const TO_START = neededToOpen({ stake: near(SMALLEST_STAKE), maxRounds: 6, turnSeconds: 60 });

/** The first stub: who plays here. Three ways in for a visitor; the account, its balance and its keys for a player. */
export function PassengerStub({
  state,
  helper,
  freePlay = false,
}: {
  state: PlayerState;
  helper: DevConfig | null;
  /** Somebody sponsors free tables here: an account with no NEAR can play them. */ freePlay?: boolean;
}) {
  const { player, balance, problem, busy, grant } = state;
  const [note, setNote] = useState<string | null>(null);
  const [funding, setFunding] = useState(false);
  // Google sign-in rests on the sponsor: it pays for the one signature and for every move after it.
  const google = freePlay && googleSignInOffered();
  useEffect(() => {
    if (google && player === null) warmGoogleSignIn();
  }, [google, player]);

  if (player === undefined) {
    return (
      <section className="fd-stub" aria-live="polite">
        <h2 className="fd-stub__title">Passenger</h2>
        <p className="fd-small">Checking you in…</p>
      </section>
    );
  }

  if (player === null && grant) {
    return (
      <section className="fd-stub" aria-label="Finish signing in">
        <h2 className="fd-stub__title">Passenger</h2>
        <div className="fd-who">
          <span className="fd-stamp" aria-hidden="true">
            G
          </span>
          <p>
            <strong title={grant.identity.accountId}>{grant.identity.label}</strong>
            <small>Your NEAR account: {shortAccount(grant.identity.accountId)}</small>
          </p>
        </div>
        <p className="fd-small">
          One approval and this browser can play for you. It gets a key that moves your seat in Deedlords and nothing else: it cannot spend, and you are not asked again.
        </p>
        <button type="button" className="fd-go" disabled={busy} onClick={state.confirmGoogle}>
          {busy ? "Waiting for your approval…" : "Approve this browser"}
        </button>
        <div className="fd-acts">
          <button type="button" className="fd-pill fd-pill--quiet" disabled={busy} onClick={state.cancelGoogle}>
            Cancel
          </button>
        </div>
        {problem && (
          <p className="fd-problem" role="alert">
            {problem}
          </p>
        )}
      </section>
    );
  }

  if (player === null) {
    return (
      <section className="fd-stub" aria-label="Sign in">
        <h2 className="fd-stub__title">Passenger</h2>
        <p className="fd-small">
          {freePlay ? "No wallet and no NEAR needed for a free table. A move never opens a wallet." : "You confirm a stake once. A move never opens a wallet."}
        </p>
        <button type="button" className="fd-go" disabled={busy} onClick={state.signInGuest}>
          <User size={20} /> Play now as guest
        </button>
        <p className="fd-fine">A new game account. Its key stays in this browser.</p>
        <div className="fd-ways">
          {google && (
            <button type="button" className="fd-way fd-way--wide" disabled={busy} onClick={state.signInGoogle}>
              <b className="fd-way__g" aria-hidden="true">
                G
              </b>
              <span>
                <strong>{busy ? "Signing you in…" : "Continue with Google"}</strong>
                <small>No wallet. A NEAR account of your own, through NEAR Auth</small>
              </span>
            </button>
          )}
          <button type="button" className="fd-way" disabled={busy} onClick={state.signInEvm}>
            <Gem size={20} />
            <span>
              <strong>EVM wallet</strong>
              <small>MetaMask, Rabby, Coinbase</small>
            </span>
          </button>
          {CHAIN.wallets && (
            <button type="button" className="fd-way" disabled={busy} onClick={state.signInWallet}>
              <NearMark size={20} />
              <span>
                <strong>NEAR wallet</strong>
                <small>Meteor, Intear, Nightly</small>
              </span>
            </button>
          )}
        </div>
        {helper && helper.players.length > 0 && <TestAccounts players={helper.players} current={null} onChange={state.playAs} />}
        {problem && (
          <p className="fd-problem" role="alert">
            {problem}
          </p>
        )}
      </section>
    );
  }

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

  return (
    <section className="fd-stub" aria-label="Your account">
      <h2 className="fd-stub__title">Passenger</h2>
      <div className="fd-who">
        <span className="fd-stamp" aria-hidden="true">
          {player.accountId
            .replace(/[^a-z0-9]/gi, "")
            .slice(0, 2)
            .toUpperCase()}
        </span>
        <p>
          <strong title={player.accountId}>{shortAccount(player.accountId)}</strong>
          <small>{sourceLine(player)}</small>
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
            : `This account cannot play yet. The smallest match needs ${formatNear(TO_START.toString(), 2)} NEAR on it: send that much or more from any NEAR wallet (test NEAR on ${CHAIN.network}).`}
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
          {player.via === "key" && player.source === "google"
            ? "This account plays free tables: the key in this browser moves your seat and cannot spend."
            : `Free tables are open to this account as it is. To play for a stake, send it ${formatNear(TO_START.toString(), 2)} NEAR or more (test NEAR on ${CHAIN.network}).`}
        </p>
      )}
      <div className="fd-acts">
        {player.via === "key" && player.source !== "google" && !(needsFunds && !faucet) && (
          <button type="button" className="fd-pill" onClick={() => copy(player.accountId, "Address copied: send NEAR to it from any NEAR account.")}>
            <Copy /> Address
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
      {player.via === "helper" && helper && <TestAccounts players={helper.players} current={player.accountId} onChange={state.playAs} />}
      {(note ?? problem) && (
        <p className="fd-fine" role="status">
          {note ?? problem}
        </p>
      )}
    </section>
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
 * The second stub: the agent that can fly this account's seat. Its owner picks a model, has it write a playbook from a
 * wish in plain words (or starts from a preset), then adjusts the six rules by hand.
 */
export function AgentStub({ desk, signedIn }: { desk: AgentDesk; signedIn: boolean }) {
  const { agent, models, save, write, writing, problem } = desk;
  const [adjusting, setAdjusting] = useState(false);
  const [wish, setWish] = useState<string | null>(null);
  const ids = useId();
  const typed = wish ?? agent.wish;
  const hasModel = agent.model !== RULES_MODEL && (models ?? []).includes(agent.model);
  const preset = PRESETS.find((entry) => JSON.stringify(entry.book) === JSON.stringify(agent.playbook));
  const set = (change: Partial<Playbook>) => save({ playbook: { ...agent.playbook, ...change }, written: null });

  if (!signedIn) {
    return (
      <section className="fd-stub" aria-label="Your AI agent">
        <h2 className="fd-stub__title">
          Co-pilot <Bot size={22} />
        </h2>
        <p className="fd-small">An AI agent that can fly your seat, from this tab, with your own game key.</p>
        <ul className="fd-rules" aria-label="The playbook it starts with">
          {describePlaybook(agent.playbook).map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
        <p className="fd-fine">Check in to pick its model and rewrite these rules.</p>
      </section>
    );
  }

  return (
    <section className="fd-stub" aria-label="Your AI agent">
      <h2 className="fd-stub__title">
        Co-pilot <Bot size={22} />
      </h2>
      <p className="fd-small">An AI agent that can fly your seat, from this tab, with your own game key.</p>

      <label className="fd-field">
        <span>Model</span>
        <select value={hasModel ? agent.model : RULES_MODEL} onChange={(event) => save({ model: event.target.value })}>
          {(models ?? []).map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
          <option value={RULES_MODEL}>Playbook only, no model</option>
        </select>
      </label>
      {models !== null && models.length === 0 && <p className="fd-fine">No model is configured on this server: the playbook alone plays.</p>}

      {hasModel ? (
        <form
          className="fd-wish"
          onSubmit={(event) => {
            event.preventDefault();
            if (typed.trim().length >= 3) void write(typed.trim());
          }}
        >
          <label htmlFor={`${ids}-wish`}>How should it play?</label>
          <div>
            <input
              id={`${ids}-wish`}
              type="text"
              maxLength={280}
              value={typed}
              placeholder="Grab cheap cities early, keep 200 back"
              onChange={(event) => setWish(event.target.value)}
              disabled={writing}
            />
            <button type="submit" className="fd-pill fd-pill--ink" disabled={writing || typed.trim().length < 3}>
              <Spark size={16} /> {writing ? "Writing…" : "Write playbook"}
            </button>
          </div>
        </form>
      ) : (
        <label className="fd-field">
          <span>Start from</span>
          <select
            value={preset?.id ?? ""}
            onChange={(event) => {
              const pick = PRESETS.find((entry) => entry.id === event.target.value);
              if (pick) save({ playbook: pick.book, written: null });
            }}
          >
            {!preset && <option value="">Your own rules</option>}
            {PRESETS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {problem && (
        <p className="fd-problem" role="alert">
          The playbook was not written: {problem}. The rules below still play.
        </p>
      )}
      {agent.written && (
        <p className="fd-quote">
          <b>{agent.written.by}</b> {agent.written.reason}
        </p>
      )}

      <ul className="fd-rules" aria-label="The playbook">
        {describePlaybook(agent.playbook).map((rule) => (
          <li key={rule}>{rule}</li>
        ))}
      </ul>

      <div className="fd-acts">
        <button type="button" className="fd-pill" aria-expanded={adjusting} aria-controls={`${ids}-rules`} onClick={() => setAdjusting(!adjusting)}>
          <Sliders size={16} /> {adjusting ? "Done" : "Adjust the rules"}
        </button>
        <label className="fd-switch">
          <input type="checkbox" checked={agent.auto} onChange={(event) => save({ auto: event.target.checked })} />
          <span>Fly my seat from the first roll</span>
        </label>
      </div>

      {adjusting && (
        <div className="fd-editor" id={`${ids}-rules`}>
          <Range label="Cash always kept back" value={agent.playbook.reserve} max={MAX_RESERVE} step={10} onChange={(reserve) => set({ reserve })} />
          <Range label="Share of the worst rent ahead to cover" value={agent.playbook.caution} max={MAX_CAUTION} step={0.25} suffix="×" onChange={(caution) => set({ caution })} />
          <Choice label="Houses go" value={agent.playbook.build} options={BUILD_ORDERS} labels={BUILD_LABELS} onChange={(build) => set({ build })} />
          <Range label="Extra cash a house must leave" value={agent.playbook.cushion} max={MAX_CUSHION} step={10} onChange={(cushion) => set({ cushion })} />
          <Choice label="Bail out of Customs" value={agent.playbook.bail} options={BAIL_RULES} labels={BAIL_LABELS} onChange={(bail) => set({ bail })} />
          <Choice label="In debt, sell first" value={agent.playbook.sell} options={SELL_ORDERS} labels={SELL_LABELS} onChange={(sell) => set({ sell })} />
        </div>
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
