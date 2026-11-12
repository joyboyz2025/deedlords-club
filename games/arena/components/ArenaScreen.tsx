"use client";

// The Arena in the browser. A practice table plays you against the rule bot with the engine alone; a chain table
// plays the same rounds through the NEAR contract, every step a transaction. Both use the same screen: the market,
// your bids, your floor, and the fight.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Session } from "@/lib/chain/client";
import { signInAsGuest } from "../../co-ty-phu/chain/keySession";
import { planFor, type Playbook } from "../agent/bot";
import { ARENA_CONTRACT, arenaClient, arenaSession, explorerLink, newTableId, openTable, playRound, takeSeat, viewMatch, viewResult, type ChainMatch } from "../chain/table";
import { C, GUILDS, ROLES, UNITS, traitLevel } from "../data";
import { CELLS, COLS, ROWS, WON, checkPlan, createMatch, drawMarket, fight, resolveRound, standings, teamCap, type Fielded, type FightEvent, type Match, type Plan, type Ref } from "../engine";
import type { ArenaScene } from "../scene/arena";

const below = (n: number) => Math.floor(Math.random() * n);
/** The bot's playbook for a match: how hard it bids and which guild it leans to. */
const newRival = (): Playbook => ({ overbid: below(3), reserve: below(2) * 5, guild: below(4), role: -1 });
/** What a seat costs at a table opened here: 0.05 NEAR. */
const STAKE = 50_000_000_000_000_000_000_000n;
const inNear = (yocto: string | bigint): string => `${(Number(BigInt(yocto) / 10n ** 20n) / 10_000).toFixed(4)} NEAR`;
const text = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Where a match is played. `submit` plays one round with your plan and resolves to the match after it. */
type Table = {
  seat: number;
  rival: string;
  submit(match: Match, plan: Plan, say: (note: string, hash?: string) => void): Promise<Match>;
  /** What happened to the stakes, once the match is over. */
  payout?(): Promise<string>;
};

type Draft = { bids: number[]; sells: number[]; promotes: number[]; floor: Ref[] };
const draftFor = (match: Match, seat: number): Draft => ({ bids: match.market.map(() => 0), sells: [], promotes: [], floor: [...match.seats[seat].formation] });

/** The draft as the plan the engine takes: pieces you already have first, then the ones you hope to win. */
function toPlan(draft: Draft): Plan {
  const placed = draft.floor.flatMap((ref, cell): [Ref, number][] => (ref < 0 ? [] : [[ref, cell]]));
  return { sells: draft.sells, bids: draft.bids, promotes: draft.promotes, formation: [...placed.filter(([ref]) => ref < WON), ...placed.filter(([ref]) => ref >= WON)] };
}

/** A fight seen from seat 1: the two sides change places, and so does every key and every hex of the events. */
function turnAround(events: FightEvent[]): FightEvent[] {
  const key = (k: number) => (k + CELLS) % (CELLS * 2);
  const halves = (list: number[]) => [...list.slice(CELLS), ...list.slice(0, CELLS)];
  return events.map((event): FightEvent => {
    const base = { t: event.t, hp: halves(event.hp), shield: halves(event.shield), from: key(event.from) };
    if (event.kind === "attack") return { ...base, kind: "attack", to: key(event.to), dmg: event.dmg };
    if (event.kind === "cast") return { ...base, kind: "cast", op: event.op, to: event.to.map(key), amount: event.amount };
    return { ...base, kind: "move", to: { col: event.to.col, row: ROWS * 2 - 1 - event.to.row } };
  });
}

/** One glyph per role, in the order of `ROLES`: a shield, a bolt, a target, a gem. */
const ROLE_ICON = [
  "M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5z",
  "M13 2L4 14h6l-1 8 9-12h-6z",
  "M12 3a9 9 0 100 18 9 9 0 000-18zm0 5a4 4 0 110 8 4 4 0 010-8z",
  "M12 2l9 9-9 11L3 11z",
];
const MAX_HP = Math.max(...UNITS.map((def) => def.hp));
const MAX_ATK = Math.max(...UNITS.map((def) => def.atk));

function RoleIcon({ role }: { role: number }) {
  return (
    <svg className="arena-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={ROLE_ICON[role]} fillRule="evenodd" />
    </svg>
  );
}

/** A unit's picture on its guild's colour, with its rank as stars. */
function Face({ unit, picture, rank = 1 }: { unit: number; picture: string | undefined; rank?: number }) {
  return (
    <span className="arena-face" style={{ background: `linear-gradient(160deg, ${GUILDS[UNITS[unit].guild].color}, #1b1e2e 85%)` }}>
      {picture ? <img src={picture} alt="" /> : null}
      {rank > 1 ? <span className="arena-rank">{"★".repeat(rank)}</span> : null}
    </span>
  );
}

function Bar({ label, value, max, tone }: { label: string; value: number; max: number; tone: "hp" | "atk" }) {
  return (
    <span className="arena-bar-row">
      <span>{label}</span>
      <span className="arena-meter" data-tone={tone}>
        <i style={{ width: `${Math.round((value / max) * 100)}%` }} />
      </span>
      <b>{value}</b>
    </span>
  );
}

type Seated = { id: string; seat: number; session: Session; match: Match; solo: boolean };

/** Nothing is rendered on the server: the practice market is random and the chain account lives in this browser. */
export function ArenaScreen() {
  const [mounted, setMounted] = useState(false);
  const [mode, setMode] = useState<"practice" | "chain">("practice");
  const [practiceNo, setPracticeNo] = useState(0);
  const [seated, setSeated] = useState<Seated | null>(null);
  useEffect(() => {
    setMounted(true);
    if (new URLSearchParams(window.location.search).has("m")) setMode("chain");
  }, []);

  // A new practice match, with a new rival, each time `practiceNo` changes.
  const practice = useMemo(() => {
    const book = newRival();
    const table: Table = { seat: 0, rival: "the bot", submit: async (match, plan) => resolveRound(match, [plan, planFor(match, 1, book)], drawMarket(match.round + 1, below)) };
    return { table, match: createMatch(7, drawMarket(1, below)) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [practiceNo]);
  const chain = useMemo((): Table | null => {
    if (!seated) return null;
    const { id, seat, session, solo } = seated;
    const book = newRival();
    return {
      seat,
      rival: solo ? "the bot in your second seat" : "the other seat",
      submit: (match, plan, say) => playRound(session, id, match, new Map<number, Plan>(solo ? [[seat, plan], [1 - seat, planFor(match, 1 - seat, book)]] : [[seat, plan]]), say),
      payout: async () => {
        const result = await viewResult(id);
        return result ? `Paid by the contract: ${inNear(result.payouts[0])} to seat ${result.ranking[0] + 1}, ${inNear(result.payouts[1])} to seat ${result.ranking[1] + 1}, fee ${inNear(result.fee)}.` : "";
      },
    };
  }, [seated]);

  if (!mounted) return <main className="arena" />;
  const tabs = (
    <span className="arena-tabs">
      <button type="button" aria-pressed={mode === "practice"} onClick={() => setMode("practice")}>
        Practice
      </button>
      <button type="button" aria-pressed={mode === "chain"} onClick={() => setMode("chain")}>
        On chain
      </button>
    </span>
  );
  if (mode === "practice") return <ArenaMatch key={`practice${practiceNo}`} initial={practice.match} table={practice.table} tabs={tabs} onAgain={() => setPracticeNo(practiceNo + 1)} />;
  if (!seated || !chain) return <ChainLobby tabs={tabs} onSeated={setSeated} />;
  return <ArenaMatch key={seated.id} initial={seated.match} table={chain} tabs={tabs} onAgain={() => setSeated(null)} />;
}

/** Before a chain match: this browser's game account, and the ways to a seat. */
function ChainLobby({ tabs, onSeated }: { tabs: ReactNode; onSeated: (seated: Seated) => void }) {
  const [session, setSession] = useState<Session | null>(() => arenaSession());
  const [balance, setBalance] = useState<bigint | null | undefined>(undefined);
  const [invited, setInvited] = useState<ChainMatch | null>(null);
  const [waiting, setWaiting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const accountId = session?.accountId ?? null;

  useEffect(() => {
    if (!accountId) return;
    const read = () => arenaClient.balance(accountId).then(setBalance, () => undefined);
    void read();
    const timer = setInterval(read, 6_000);
    return () => clearInterval(timer);
  }, [accountId]);
  // A link with `?m=<id>` leads to somebody's table.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("m");
    if (id) viewMatch(id).then((found) => (found ? setInvited(found) : setNote(`Table ${id} is not open any more.`)), (error) => setNote(text(error)));
  }, []);
  // The table you opened for a friend starts when they take the seat.
  useEffect(() => {
    if (!waiting || !session) return;
    const timer = setInterval(async () => {
      const found = await viewMatch(waiting).catch(() => null);
      if (found?.game) onSeated({ id: waiting, seat: 0, session, match: found.game, solo: false });
    }, 2_000);
    return () => clearInterval(timer);
  }, [waiting, session, onSeated]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setNote("");
    try {
      await work();
    } catch (error) {
      setNote(text(error));
    }
    setBusy(false);
  };
  const open = (solo: boolean) =>
    run(async () => {
      const id = newTableId();
      await openTable(session!, id, 5, STAKE, solo);
      if (!solo) return setWaiting(id);
      const found = await viewMatch(id);
      if (!found?.game) throw new Error("the table did not start");
      onSeated({ id, seat: 0, session: session!, match: found.game, solo: true });
    });
  const join = (table: ChainMatch) =>
    run(async () => {
      const mine = table.seats.findIndex((seat) => seat.backer === accountId);
      if (table.status === "lobby") await takeSeat(session!, table.id, BigInt(table.stake));
      else if (mine < 0) throw new Error("this table is full");
      const found = await viewMatch(table.id);
      if (!found?.game) throw new Error("the table did not start");
      onSeated({ id: table.id, seat: table.status === "lobby" ? 1 : mine, session: session!, match: found.game, solo: found.seats.every((other) => other.backer === accountId) });
    });

  return (
    <main className="arena">
      <header className="arena-bar">
        <span className="arena-title">Deedlords Arena</span>
        {tabs}
      </header>
      <section className="arena-lobby">
        <h2>Play on NEAR testnet</h2>
        <p>
          Every round is sealed, opened and fought by the contract <code>{ARENA_CONTRACT}</code>. A seat costs {inNear(STAKE)} of test NEAR; the winner takes 70% of the pot, the other seat 30%, less a 2.5% fee.
        </p>
        {session ? (
          <>
            <p>
              Your game account: <code className="arena-account">{accountId}</code>
              <br />
              Balance: {balance === undefined ? "reading…" : balance === null ? "0 (nothing has been sent to it yet)" : inNear(balance)}. Two seats and their gas need about 0.5 NEAR.
            </p>
            {invited ? (
              <button type="button" className="arena-main" disabled={busy} onClick={() => join(invited)}>
                {invited.status === "lobby" ? `Take the seat at table ${invited.id}` : `Return to table ${invited.id}`}
              </button>
            ) : waiting ? (
              <p>
                Table <code>{waiting}</code> is open. Send this link to your opponent: <code className="arena-account">{`${window.location.origin}/arena?m=${waiting}`}</code>
              </p>
            ) : (
              <div className="arena-actions">
                <button type="button" className="arena-main" disabled={busy} onClick={() => open(true)}>
                  Play the bot on chain
                </button>
                <button type="button" disabled={busy} onClick={() => open(false)}>
                  Open a table for a friend
                </button>
              </div>
            )}
          </>
        ) : (
          <button
            type="button"
            className="arena-main"
            onClick={() => {
              signInAsGuest();
              setSession(arenaSession());
            }}
          >
            Make a guest game account
          </button>
        )}
        <p className="arena-note">{busy ? "Sending to the contract…" : note}</p>
      </section>
    </main>
  );
}

function ArenaMatch({ initial, table, tabs, onAgain }: { initial: Match; table: Table; tabs: ReactNode; onAgain: () => void }) {
  const { seat } = table;
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<ArenaScene | null>(null);
  const [ready, setReady] = useState(false);
  const [match, setMatch] = useState<Match>(initial);
  const [draft, setDraft] = useState<Draft>(() => draftFor(initial, seat));
  /** What is in the hand, waiting for a cell: a piece id or `WON + slot`. */
  const [held, setHeld] = useState<Ref | null>(null);
  /** `sending`: the round is with the table. `fighting`: the fight is being shown. */
  const [stage, setStage] = useState<"plan" | "sending" | "fighting">("plan");
  const [roster, setRoster] = useState(false);
  const [note, setNote] = useState("Build your crew, then press Ready. Both sides' bids are sealed and opened together.");
  const [steps, setSteps] = useState<{ note: string; link: string | null }[]>([]);
  /** The unit whose details are shown: the one last touched in the shop, on the bench or on the floor. */
  const [inspect, setInspect] = useState<number | null>(null);
  const [portraits, setPortraits] = useState<string[]>([]);

  const me = match.seats[seat];
  const cap = teamCap(match.round);
  const unitOf = (ref: Ref): number | undefined => (ref >= WON ? match.market[ref - WON] : me.pieces.find((piece) => piece.id === ref)?.unit);
  const plan = useMemo(() => toPlan(draft), [draft]);
  const problem = match.done ? null : checkPlan(match, seat, plan);
  const refund = draft.sells.reduce((sum, id) => sum + UNITS[unitOf(id)!].cost, 0);
  const goldLeft = me.gold + refund - draft.bids.reduce((sum, bid) => sum + bid, 0);

  useEffect(() => {
    let cancelled = false;
    let built: ArenaScene | null = null;
    import("../scene/arena").then(({ ArenaScene }) => {
      if (cancelled || !canvas.current) return;
      built = new ArenaScene(canvas.current, (cell) => tap.current(cell));
      scene.current = built;
      setReady(true);
    });
    return () => {
      cancelled = true;
      scene.current = null;
      built?.dispose();
    };
  }, []);

  useEffect(() => {
    // A painted portrait where there is one, otherwise a picture taken of the unit's own figure.
    void Promise.all([import("../scene/portraits"), import("../scene/models").then(({ manifest }) => manifest())]).then(([{ unitPortraits }, list]) => {
      const taken = UNITS.every((def) => list.portraits.includes(def.id)) ? [] : unitPortraits();
      setPortraits(UNITS.map((def, unit) => (list.portraits.includes(def.id) ? `/arena/portraits/${def.id}.jpg` : taken[unit])));
    });
  }, []);

  // The floor shows what is certain: the pieces you have where you put them, and the other side as it last stood.
  useEffect(() => {
    if (!ready || stage === "fighting") return;
    if (roster) return scene.current?.showRoster();
    const mine = draft.floor.flatMap((ref, cell): Fielded[] => {
      const piece = me.pieces.find((owned) => owned.id === ref);
      return piece ? [{ unit: piece.unit, rank: piece.rank, cell }] : [];
    });
    scene.current?.setTeams([mine, match.last?.teams[1 - seat] ?? []], stage === "plan");
    scene.current?.setMarks(draft.floor.flatMap((ref, cell) => (ref >= WON ? [cell] : [])));
  }, [ready, stage, roster, draft.floor, match, me.pieces, seat]);

  /** The first free cell that suits a unit: the front row for melee, the back row for ranged, the middle first. */
  const cellFor = (unit: number, floor: Ref[]): number => {
    const middleOut = [3, 2, 4, 1, 5, 0, 6];
    const rows = UNITS[unit].ranged ? [ROWS - 1, 0, 1] : [0, 1, ROWS - 1];
    return rows.flatMap((row) => middleOut.map((col) => row * COLS + col)).find((cell) => floor[cell] < 0) ?? -1;
  };
  const setBid = (slot: number, bid: number) => {
    const unit = match.market[slot];
    const cost = UNITS[unit].cost;
    const next = bid < cost ? (bid > draft.bids[slot] ? cost : 0) : bid;
    let floor = next ? draft.floor : draft.floor.map((ref) => (ref === WON + slot ? -1 : ref));
    // A new bid is given a place straight away while there is room on the floor; it can be moved like any unit.
    if (next && !draft.bids[slot] && floor.filter((ref) => ref >= 0).length < cap) floor = floor.map((ref, cell) => (cell === cellFor(unit, floor) ? WON + slot : ref));
    setDraft({ ...draft, bids: draft.bids.map((old, i) => (i === slot ? next : old)), floor });
    setInspect(unit);
  };
  const toggle = (key: "sells" | "promotes", id: number) => {
    const on = draft[key].includes(id);
    const list = on ? draft[key].filter((other) => other !== id) : [...draft[key], id];
    setDraft({ ...draft, [key]: list, floor: key === "sells" && !on ? draft.floor.map((ref) => (ref === id ? -1 : ref)) : draft.floor });
  };
  const tapCell = (cell: number) => {
    if (stage !== "plan" || roster || match.done) return;
    const floor = [...draft.floor];
    if (held === null) {
      // An empty hand picks up what stands there.
      if (floor[cell] >= 0) {
        setHeld(floor[cell]);
        setInspect(unitOf(floor[cell]) ?? null);
      }
      floor[cell] = -1;
    } else {
      const from = floor.indexOf(held);
      if (from >= 0) floor[from] = floor[cell];
      else if (floor[cell] < 0 && floor.filter((ref) => ref >= 0).length >= cap) return setNote(`Only ${cap} can stand this round.`);
      floor[cell] = held;
      setHeld(null);
    }
    setDraft({ ...draft, floor });
  };
  // The scene is built once; it reaches the newest `tapCell` through this.
  const tap = useRef(tapCell);
  tap.current = tapCell;

  const lockIn = async () => {
    setStage("sending");
    setRoster(false);
    setHeld(null);
    setSteps([]);
    let next: Match;
    try {
      next = await table.submit(match, plan, (step, hash) => setSteps((old) => [...old, { note: step, link: hash ? explorerLink(hash) : null }]));
    } catch (error) {
      setNote(`The round was not played: ${text(error)}`);
      return setStage("plan");
    }
    const last = next.last;
    const finish = async (round: string) => {
      setStage("plan");
      setMatch(next);
      setDraft(draftFor(next, seat));
      if (!next.done) return setNote(`${round} You earned ${last?.income[seat] ?? 0} gold.`);
      setNote(`${round} ${standings(next)[0] === seat ? "You win the match." : `The match goes to ${table.rival}.`}`);
      const paid = await table.payout?.().catch(() => "");
      if (paid) setNote((old) => `${old} ${paid}`);
    };
    // The table may only know that the round was played (the other seat's reveal settled the match).
    if (!last || last.round !== match.round) return finish("The round was played.");
    const won = last.won.map((who, slot) => (who < 0 ? null : `${UNITS[last.market[slot]].name} to ${who === seat ? "you" : table.rival} for ${last.bids[who][slot]}`)).filter(Boolean);
    setNote(won.length ? `Bids opened: ${won.join("; ")}.` : "Nobody bid.");
    const events: FightEvent[] = [];
    fight(last.teams, (event) => events.push(event));
    setStage("fighting");
    const verdict = last.winner === 2 ? "A draw." : last.winner === seat ? `You won the round with ${last.survivors[seat]} standing.` : `The round went to ${table.rival} with ${last.survivors[1 - seat]} standing.`;
    scene.current?.play(seat === 0 ? last.teams : [last.teams[1], last.teams[0]], seat === 0 ? events : turnAround(events), () => void finish(verdict));
  };
  const suggest = () => {
    // The rule bot's plan for your seat, laid out as a draft you can still change.
    const hint = planFor(match, seat);
    const floor: Ref[] = Array(CELLS).fill(-1);
    for (const [ref, cell] of hint.formation ?? []) if (floor[cell] < 0 && !floor.includes(ref) && floor.filter((r) => r >= 0).length < cap) floor[cell] = ref;
    setDraft({ bids: hint.bids, sells: hint.sells, promotes: hint.promotes, floor });
    setNote("Your steward filled in a plan. Change anything, then press Ready.");
  };

  const pick = (ref: Ref) => {
    setHeld(held === ref ? null : ref);
    setInspect(unitOf(ref) ?? null);
  };
  const owned = [...me.pieces.filter((piece) => !draft.sells.includes(piece.id)).map((piece) => piece.id as Ref), ...draft.bids.flatMap((bid, slot) => (bid ? [WON + slot] : []))];
  const bench = owned.filter((ref) => !draft.floor.includes(ref) || ref === held);
  const standing = draft.floor.filter((ref) => ref >= 0).map((ref) => UNITS[unitOf(ref)!]);
  const traits = [...GUILDS.map((trait, guild) => ({ trait, count: standing.filter((def) => def.guild === guild).length, role: -1 })), ...ROLES.map((trait, role) => ({ trait, count: standing.filter((def) => def.role === role).length, role }))]
    .filter((entry) => entry.count > 0)
    .sort((a, b) => traitLevel(b.trait, b.count) - traitLevel(a.trait, a.count) || b.count - a.count);
  const heldPiece = me.pieces.find((piece) => piece.id === held);
  const shown = inspect === null ? null : UNITS[inspect];
  const hint =
    roster ? "Tap a unit to see its attack, then its ability."
    : held !== null ? `Tap a hex on your side to place ${UNITS[unitOf(held)!].name}.`
    : problem ? `Not yet: ${problem}.`
    : !owned.length ? "Tap a card in the shop to bid for it. The higher sealed bid takes the unit."
    : "Tap a unit to move it. Press Ready to seal your plan.";
  const rival = match.seats[1 - seat];

  return (
    <main className="arena">
      <header className="arena-bar">
        <span className="arena-title">Deedlords Arena</span>
        {tabs}
        <button type="button" aria-pressed={roster} onClick={() => setRoster(!roster)} disabled={stage !== "plan"}>
          Units
        </button>
      </header>

      <div className="arena-stage">
        <canvas ref={canvas} />
        <div className="arena-versus">
          <span className="arena-health" data-side="me">
            <b>You</b>
            <span className="arena-meter" data-tone="me">
              <i style={{ width: `${(me.points / C.startPoints) * 100}%` }} />
            </span>
            <b>{me.points}</b>
          </span>
          <ol className="arena-rounds" aria-label={`Round ${Math.min(match.round, match.rounds)} of ${match.rounds}`}>
            {Array.from({ length: match.rounds }, (_, index) => (
              <li key={index} data-state={index + 1 < match.round ? "done" : index + 1 === match.round ? "now" : "next"} />
            ))}
          </ol>
          <span className="arena-health" data-side="them">
            <b>{rival.points}</b>
            <span className="arena-meter" data-tone="them">
              <i style={{ width: `${(rival.points / C.startPoints) * 100}%` }} />
            </span>
            <b>Rival</b>
          </span>
        </div>
        {traits.length && stage === "plan" && !roster ? (
          <ul className="arena-traits" aria-label="Traits on your floor">
            {traits.map(({ trait, count, role }) => {
              const level = traitLevel(trait, count);
              return (
                <li key={trait.name} data-on={level > 0} title={trait.text}>
                  {role < 0 ? <span className="arena-dot" style={{ background: trait.color }} /> : <RoleIcon role={role} />}
                  <span>{trait.name}</span>
                  <b>
                    {count}/{trait.at[Math.min(level, 1)]}
                  </b>
                </li>
              );
            })}
          </ul>
        ) : null}
        {shown && stage === "plan" && !match.done ? (
          <aside className="arena-detail">
            <Face unit={inspect!} picture={portraits[inspect!]} rank={heldPiece?.unit === inspect ? heldPiece.rank : 1} />
            <div>
              <h3>{shown.name}</h3>
              <p className="arena-tags">
                <span className="arena-dot" style={{ background: GUILDS[shown.guild].color }} />
                {GUILDS[shown.guild].name} <RoleIcon role={shown.role} />
                {ROLES[shown.role].name}
              </p>
              <Bar label="Health" value={shown.hp} max={MAX_HP} tone="hp" />
              <Bar label="Attack" value={shown.atk} max={MAX_ATK} tone="atk" />
              <p className="arena-ability">
                <b>{shown.ability.name}.</b> {shown.ability.text}
              </p>
              {heldPiece && heldPiece.unit === inspect ? (
                <p className="arena-actions">
                  {heldPiece.rank < C.maxRank ? (
                    <button type="button" aria-pressed={draft.promotes.includes(heldPiece.id)} onClick={() => toggle("promotes", heldPiece.id)}>
                      Promote for {shown.cost * (heldPiece.rank + 1)}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      toggle("sells", heldPiece.id);
                      setHeld(null);
                    }}
                  >
                    Sell for {shown.cost}
                  </button>
                </p>
              ) : null}
            </div>
            <button type="button" className="arena-close" aria-label="Close" onClick={() => setInspect(null)}>
              ×
            </button>
          </aside>
        ) : null}
      </div>

      <section className="arena-panel" aria-busy={stage !== "plan"}>
        <p className="arena-note">{note}</p>
        {steps.length ? (
          <details className="arena-steps" open={stage === "sending"}>
            <summary>{steps.filter((step) => step.link).length} transactions on NEAR</summary>
            <ol>
              {steps.map((step, index) => (
                <li key={index}>
                  {step.note}{" "}
                  {step.link ? (
                    <a href={step.link} target="_blank" rel="noreferrer">
                      open
                    </a>
                  ) : null}
                </li>
              ))}
            </ol>
          </details>
        ) : null}
        {match.done ? (
          <button type="button" className="arena-main" onClick={onAgain}>
            Play again
          </button>
        ) : stage !== "plan" ? null : (
          <>
            <div className="arena-row">
              <span className="arena-gold" title="Gold left after your bids">
                <i />
                {goldLeft}
              </span>
              <span className="arena-count" title="Units standing, of the most that can stand this round">
                {standing.length}/{cap}
              </span>
              <ul className="arena-bench" aria-label="Bench">
                {bench.map((ref) => {
                  const piece = me.pieces.find((mine) => mine.id === ref);
                  return (
                    <li key={ref}>
                      <button type="button" className="arena-tile" data-held={held === ref} data-hoped={ref >= WON} onClick={() => pick(ref)} aria-label={`${UNITS[unitOf(ref)!].name}${piece ? "" : ", if won"}`}>
                        <Face unit={unitOf(ref)!} picture={portraits[unitOf(ref)!]} rank={piece?.rank} />
                      </button>
                    </li>
                  );
                })}
                {draft.sells.map((id) => (
                  <li key={`sold${id}`}>
                    <button type="button" className="arena-tile" data-sold onClick={() => toggle("sells", id)} aria-label={`Keep ${UNITS[unitOf(id)!].name} after all`}>
                      <Face unit={unitOf(id)!} picture={portraits[unitOf(id)!]} />
                    </button>
                  </li>
                ))}
              </ul>
              <span className="arena-hint">{hint}</span>
              <button type="button" onClick={suggest}>
                Auto
              </button>
              <button type="button" className="arena-main" onClick={lockIn} disabled={problem !== null}>
                Ready
              </button>
            </div>

            <div className="arena-market">
              {match.market.map((unit, slot) => {
                const def = UNITS[unit];
                const bid = draft.bids[slot];
                return (
                  <article key={slot} className="arena-card" data-bid={bid > 0}>
                    <button type="button" className="arena-buy" onClick={() => setBid(slot, bid ? 0 : def.cost)} aria-label={bid ? `Withdraw the bid for ${def.name}` : `Bid ${def.cost} for ${def.name}`}>
                      <Face unit={unit} picture={portraits[unit]} />
                      <span className="arena-cost">{bid || def.cost}</span>
                      <b>{def.name}</b>
                      <span className="arena-tags">
                        <span className="arena-dot" style={{ background: GUILDS[def.guild].color }} />
                        {GUILDS[def.guild].name.split(" ")[0]} <RoleIcon role={def.role} />
                        {ROLES[def.role].name}
                      </span>
                      <span className="arena-tags">
                        ♥ {def.hp} · ⚔ {def.atk}
                      </span>
                    </button>
                    {bid ? (
                      <div className="arena-bid">
                        <button type="button" onClick={() => setBid(slot, bid - 1)} aria-label={`Lower the bid for ${def.name}`}>
                          −
                        </button>
                        <output>Bid {bid}</output>
                        <button type="button" onClick={() => setBid(slot, bid + 1)} aria-label={`Raise the bid for ${def.name}`}>
                          +
                        </button>
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </>
        )}
      </section>
    </main>
  );
}
