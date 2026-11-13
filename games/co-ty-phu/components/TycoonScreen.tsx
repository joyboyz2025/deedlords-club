"use client";

import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { PinForm } from "@/components/PinForm";
import { RoomAccessPanel } from "@/components/RoomAccessPanel";
import { SoundToggle } from "@/components/SoundToggle";
import { loadTownMe } from "@/games/town/me";
import { needsPin } from "@/lib/roomAccess";
import { unlockSound } from "@/lib/sound";
import { readStored, writeStored } from "@/lib/storage";
import { formatClock, useCountdown } from "@/lib/useCountdown";
import { usePin } from "@/lib/usePin";
import { useWakeLock } from "@/lib/useWakeLock";
import { DECK_NAMES, GROUPS, JAIL_FINE, SALARY, SQUARES, TOKEN_COLORS, groupSquares, houseCost, isOwnable } from "../board";
import { autoSecondsOf, redeemPrice, startCashOf } from "../engine";
import { AUTO_CHOICES, CASH_CHOICES, LIMIT_CHOICES, SALARY_CHOICES, type ErrorCode } from "../protocol";
import { sound } from "../sound";
import { savedLook } from "../../ma-soi/components/Wardrobe";
import { hostKeyStorage, useRoom, type Send } from "../useRoom";
import type { PublicPlayer, View } from "../view";
import { DECK_ART, TROPHY_ART } from "../scene/art";
import type { CameraMode } from "../scene/tycoon";
import { Board, SquareDetail, money } from "./Board";
import { Board3D } from "./Board3D";

type Identity = { name: string; id?: string; secret?: string };

const identityKey = (code: string) => `typhu:player:${code}`;
const NAME_KEY = "typhu:name";
const LOCK_KEY = "typhu:lock";
const MAX_SEATS = 6;

const nameOf = (view: View, id: string | null | undefined) => view.players.find((p) => p.id === id)?.name ?? "?";

/** Lỗi khi vào phòng. Phòng có khóa thì hỏi PIN chứ không báo lỗi, nên không có ở đây. */
function errorText(code: string, error: Exclude<ErrorCode, "pin" | "pin-wait">): { title: string; line: string } {
  switch (error) {
    case "full":
      return { title: `Room ${code} is full`, line: "Ask the host whether another room is open." };
    case "no-room":
      return { title: `No room ${code}`, line: "Check the code with the host. A room closes after 10 minutes without play, a lobby after 24 hours." };
    case "closed-idle":
      return { title: `Room ${code} is closed`, line: "Nobody played for 10 minutes, so the room closed." };
  }
}

export function TycoonScreen({ code }: { code: string }) {
  const [identity, setIdentity] = useState<Identity | null | undefined>(undefined);
  const [pin, setPin] = usePin(`co-ty-phu:${code}`);

  useEffect(() => {
    // Người có tài khoản thị trấn thì vào luôn bằng tên và nhân vật trong thị trấn.
    const me = loadTownMe();
    setIdentity(readStored<Identity>(identityKey(code)) ?? (me && { name: me.name }));
  }, [code]);

  if (identity === undefined || pin === undefined) return <main className="tp" />;
  if (identity === null) return <JoinForm code={code} onJoin={(name) => setIdentity({ name })} />;
  return <Table code={code} identity={identity} pin={pin} onPin={setPin} />;
}

function JoinForm({ code, onJoin }: { code: string; onJoin: (name: string) => void }) {
  const [name, setName] = useState("");

  useEffect(() => {
    // Người đã chơi game khác trên web thì điền sẵn tên đó.
    setName(readStored<string>(NAME_KEY) ?? readStored<string>("covua:name") ?? readStored<string>("masoi:name") ?? "");
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    unlockSound();
    writeStored(NAME_KEY, name.trim());
    onJoin(name.trim());
  };

  return (
    <main className="tp tp--center">
      <form className="tp-join" onSubmit={submit}>
        <h1 className="tp-logo">Deedlords</h1>
        <p className="tp-lede">Room {code}</p>
        <input
          className="tp-input"
          aria-label="Your name"
          placeholder="Your name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={20}
          autoComplete="nickname"
          required
        />
        <button type="submit" className="tp-btn tp-btn--main tp-btn--big">
          Join
        </button>
      </form>
    </main>
  );
}

function Table({ code, identity, pin, onPin }: { code: string; identity: Identity; pin: string | null; onPin: (pin: string) => void }) {
  const current = useRef(identity);

  const getHello = useCallback(
    () => ({
      t: "hello" as const,
      ...current.current,
      hostKey: readStored<string>(hostKeyStorage(code)) ?? undefined,
      look: loadTownMe()?.look ?? savedLook(),
      pin: pin ?? undefined,
    }),
    [code, pin],
  );
  const onView = useCallback(
    (view: View) => {
      const { name, id, secret } = view.you;
      if (current.current.secret === secret) return;
      current.current = { name, id, secret };
      writeStored(identityKey(code), current.current);
    },
    [code],
  );

  const { view, link, error, send, retry } = useRoom(code, getHello, onView);

  if (needsPin(error)) {
    return (
      <main className="tp tp--center">
        <PinForm
          problem={error === "pin-wait" ? "pin-wait" : pin ? "pin" : null}
          onSubmit={(value) => {
            onPin(value);
            retry();
          }}
          classes={{ form: "tp-join", input: "tp-input tp-input--code", button: "tp-btn tp-btn--main tp-btn--big", problem: "tp-problem" }}
        >
          <h1 className="tp-join__title">Room {code} is locked</h1>
          <p className="tp-lede">Ask the host for the 4-digit PIN.</p>
        </PinForm>
      </main>
    );
  }

  if (error) {
    const { title, line } = errorText(code, error);
    return (
      <main className="tp tp--center">
        <div className="tp-join">
          <h1 className="tp-join__title">{title}</h1>
          <p className="tp-lede">{line}</p>
          <Link className="tp-btn tp-btn--big" href={error === "closed-idle" ? "/choi-nhanh" : "/co-ty-phu"}>
            {error === "closed-idle" ? "Pick another game" : "Enter another code"}
          </Link>
        </div>
      </main>
    );
  }

  if (!view) {
    return (
      <main className="tp tp--center">
        <p className="tp-lede" aria-live="polite">
          {link === "offline" ? "Cannot reach the room, trying again…" : "Joining the room…"}
        </p>
      </main>
    );
  }

  return <Stage view={view} offline={link !== "online"} send={send} />;
}

const me = (view: View) => view.players.find((p) => p.id === view.you.id)!;
const isActive = (player: PublicPlayer | undefined) => !!player && player.color !== null && !player.bankrupt;

/**
 * Bàn 3D tung xúc xắc vào mâm rồi quân mới đi: trong lúc đó giữ nguyên tiền, diễn biến, thẻ và các nút. Bàn 3D báo quân
 * đã tới nơi (`arrived`) thì mới đổi, kẻo thấy trừ tiền hay nút mua đất trước khi quân tới ô, kể cả trên máy vẽ chậm. Bàn 2D không giữ.
 */
function useRollHold(view: View, enabled: boolean): { holding: boolean; arrived: (rolls: number) => void } {
  // Lượt đổ mà quân đã đi tới nơi. Giữ khi lượt đổ hiện tại khác lượt đó, tính ngay lúc vẽ nên không lộ tiền hay nút dù một khung hình.
  const [settled, setSettled] = useState(view.rolls);
  const arrived = useCallback((rolls: number) => setSettled(rolls), []);
  useEffect(() => {
    if (view.rolls === settled) return;
    // Bàn 3D báo lúc quân tới nơi; đồng hồ này chỉ phòng khi bàn 3D không vẽ (tab bị ẩn, máy treo cảnh).
    const timer = setTimeout(() => setSettled(view.rolls), HOLD_LIMIT_MS);
    return () => clearTimeout(timer);
  }, [view.rolls, settled]);
  return { holding: enabled && view.dice !== null && view.rolls !== settled, arrived };
}

/** Bàn 3D không báo quân tới nơi sau chừng này thì thôi giữ. */
const HOLD_LIMIT_MS = 20_000;

/** Tiếng rút thẻ, tới lượt mình và hết ván; rung nhẹ khi tới lượt. Thẻ kêu lúc hiện ra, tức sau khi quân tới nơi. */
function useStageEffects(view: View, holding: boolean) {
  const myTurn = view.phase === "playing" && view.current === view.you.id;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) return;
    if (myTurn) {
      sound.turn();
      if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(60);
    }
  }, [myTurn]);

  const cardText = view.card?.text;
  useEffect(() => {
    if (!first.current && cardText && !holding) sound.card();
  }, [cardText, view.rolls, holding]);

  const ended = view.phase === "ended";
  useEffect(() => {
    if (!first.current && ended) sound.end();
  }, [ended]);

  useEffect(() => {
    first.current = false;
  }, []);
}

/** What differs when the game runs on the contract instead of the room server (see `ChainScreen`): no trades, no "new game". */
export type ChainStage = {
  /** Shown where a room shows its code: the network and who the viewer plays as. */
  label: string;
  /** A roll is on its way to the chain: the turn buttons rest until it lands. */
  busy: boolean;
  /** The payout card of a settled match, shown in place of the room server's result card. */
  result: (onClose: () => void) => ReactNode;
  /** Seats an agent plays, by player id: who drives and the sentence it gave for its last plan. */
  agents?: Record<string, AgentTag>;
  /** The viewer's own seat handed to an agent; `null` for somebody without a seat. */
  autopilot?: { on: boolean; thinking: boolean; toggle: () => void; note: string | null } | null;
  /** The match's transactions, opened from the menu. */
  ledger?: (onClose: () => void) => ReactNode;
  /** Gives up the match for the viewer's seat. Absent for somebody without a seat. */
  resign?: () => void;
};

export type AgentTag = { driver: string; reason: string; fallback: boolean };

export function Stage({ view, offline, send, chain }: { view: View; offline: boolean; send: Send; chain?: ChainStage }) {
  // Máy không vẽ được 3D thì dùng bàn cờ 2D.
  const [has3D, setHas3D] = useState(true);
  const { holding, arrived } = useRollHold(view, has3D);
  useStageEffects(view, holding);
  // Người đang chơi giữ màn hình sáng: máy tự tắt màn hình đúng lượt mình là cả bàn phải chờ.
  useWakeLock(view.phase === "playing" && isActive(me(view)));

  // Đang chơi trên bàn 3D thì bàn chiếm cả màn hình: tên phòng, đồng hồ, nút tiếng nằm đè lên bàn (`Game`).
  const fullScreen = has3D && view.phase !== "lobby";
  return (
    <main className="tp" data-phase={view.phase} data-view={has3D ? "3d" : "2d"}>
      {offline && <p className="tp-offline">Connection lost, reconnecting…</p>}
      {!fullScreen && (
        <header className="tp-top">
          <div className="tp-top__title">
            <span className="tp-top__game">Deedlords</span>
            <strong>{chain?.label ?? `Room ${view.code}`}</strong>
          </div>
          {view.phase === "playing" && <GameClock view={view} />}
          <SoundToggle />
        </header>
      )}
      {view.phase === "lobby" ? (
        <Lobby view={view} send={send} />
      ) : (
        <Game view={view} send={send} chain={chain} has3D={has3D} holding={holding} onArrive={arrived} onBroken={() => setHas3D(false)} />
      )}
    </main>
  );
}

/** Đếm lùi từ lúc nhận tin, không phụ thuộc giờ của từng máy. */
function GameClock({ view }: { view: View }) {
  const left = useCountdown(view.endsInMs ?? 0);
  if (view.lastRound) return <span className="tp-clock tp-clock--last">Last round</span>;
  if (view.pause) return <span className="tp-clock">Paused</span>;
  if (view.endsInMs === null) return null;
  return (
    <span className="tp-clock" role="timer" aria-label="Time left in the game">
      {formatClock(left)} left
    </span>
  );
}

function Lobby({ view, send }: { view: View; send: Send }) {
  const [origin, setOrigin] = useState<string | null>(null);
  useEffect(() => setOrigin(window.location.origin), []);
  const joinUrl = origin && `${origin}/co-ty-phu/${view.code}`;
  // Phòng có khóa: mã QR mang sẵn PIN, người quét vào thẳng. Người gõ địa chỉ thì được hỏi PIN.
  const inviteUrl = joinUrl && (view.access?.pin ? `${joinUrl}#pin=${view.access.pin}` : joinUrl);
  const { you, settings } = view;
  const players = view.players.filter((p) => p.wantsToPlay && p.online).slice(0, MAX_SEATS);
  const watchers = view.players.filter((p) => !players.includes(p));
  const mine = me(view);
  const problem = players.length < 2 ? `Needs at least 2 players, has ${players.length}.` : null;

  return (
    <div className="tp-lobby">
      <details className="tp-invite" open={you.isHost}>
        <summary className="tp-invite__bar">
          <span>Room code</span>
          <strong>{view.code}</strong>
        </summary>
        <div className="tp-invite__body">
          <div className="tp-invite__qr">{inviteUrl && <QRCodeSVG value={inviteUrl} size={320} marginSize={0} bgColor="#fff7e6" fgColor="#3a120c" />}</div>
          <p className="tp-invite__hint">Scan the code, or enter the room code on the Deedlords page</p>
          <p className="tp-invite__url">{joinUrl?.replace(/^https?:\/\//, "")}</p>
          {you.isHost && view.access && <RoomAccessPanel access={view.access} send={send} className="tp-access" />}
        </div>
      </details>

      <section className="tp-section">
        <h2 className="tp-heading">Players ({players.length}/6)</h2>
        <ol className="tp-seats">
          {players.map((player, i) => (
            <li key={player.id} className="tp-seat">
              <i className="tp-token tp-token--big" style={{ background: TOKEN_COLORS[i] }} />
              <span>
                {player.name}
                {player.id === you.id && " (you)"}
                {player.isHost && " · host"}
              </span>
            </li>
          ))}
        </ol>
        {watchers.length > 0 && <p className="tp-hint">Watching: {watchers.map((p) => p.name + (p.online ? "" : " (away)")).join(", ")}</p>}
        <button type="button" className="tp-btn" onClick={() => send({ t: "play", on: !mine.wantsToPlay })}>
          {mine.wantsToPlay ? "I'll just watch" : "I'll play too"}
        </button>
      </section>

      <section className="tp-section">
        <h2 className="tp-heading">Game length</h2>
        {you.isHost ? (
          <div className="tp-segments" role="group" aria-label="Game length">
            {LIMIT_CHOICES.map((minutes) => (
              <button key={minutes} type="button" aria-pressed={settings.limitMinutes === minutes} onClick={() => send({ t: "limit", minutes })}>
                {minutes === 0 ? "Until one is left" : `${minutes} min`}
              </button>
            ))}
          </div>
        ) : (
          <p className="tp-lede">{settings.limitMinutes === 0 ? "Until only one player is left" : `${settings.limitMinutes} minutes`}</p>
        )}
        <p className="tp-hint">
          {settings.limitMinutes === 0
            ? "This can take long: it goes on until everybody else is bankrupt."
            : "When time is up the round is finished, then the highest net worth (cash, land, houses) wins."}
        </p>
      </section>

      <section className="tp-section">
        <h2 className="tp-heading">Passing Departure pays</h2>
        {you.isHost ? (
          <div className="tp-segments" role="group" aria-label="Pay for passing Departure">
            {SALARY_CHOICES.map((amount) => (
              <button key={amount} type="button" aria-pressed={(settings.salary ?? SALARY) === amount} onClick={() => send({ t: "salary", amount })}>
                {money(amount)}
              </button>
            ))}
          </div>
        ) : (
          <p className="tp-lede">{money(settings.salary ?? SALARY)}</p>
        )}
        <p className="tp-hint">The more it pays, the more cash there is and the longer it takes for anybody to go bankrupt.</p>
      </section>

      <section className="tp-section">
        <h2 className="tp-heading">Starting cash</h2>
        {you.isHost ? (
          <div className="tp-segments" role="group" aria-label="Cash each player starts with">
            {CASH_CHOICES.map((amount) => (
              <button key={amount} type="button" aria-pressed={startCashOf(view) === amount} onClick={() => send({ t: "cash", amount })}>
                {money(amount)}
              </button>
            ))}
          </div>
        ) : (
          <p className="tp-lede">{money(startCashOf(view))}</p>
        )}
        <p className="tp-hint">More cash means bankruptcy comes later and more houses get built.</p>
      </section>

      <section className="tp-section">
        <h2 className="tp-heading">Auto-move when slow</h2>
        {you.isHost ? (
          <div className="tp-segments" role="group" aria-label="How long before the game moves for a slow player">
            {AUTO_CHOICES.map((seconds) => (
              <button key={seconds} type="button" aria-pressed={autoSecondsOf(view) === seconds} onClick={() => send({ t: "auto", seconds })}>
                {seconds === 0 ? "Off" : `${seconds} s`}
              </button>
            ))}
          </div>
        ) : (
          <p className="tp-lede">{autoSecondsOf(view) === 0 ? "Off: the game waits for the player" : `After ${autoSecondsOf(view)} seconds`}</p>
        )}
        <p className="tp-hint">When the player to move runs out of time the game rolls, declines the purchase or ends the turn for them, so the game never stalls. Any move restarts the count.</p>
      </section>

      <Rules view={view} />

      <div className="tp-start">
        {you.isHost ? (
          <>
            {problem && <p className="tp-problem">{problem}</p>}
            <button type="button" className="tp-btn tp-btn--main tp-btn--big" disabled={problem !== null} onClick={() => send({ t: "start" })}>
              Start
            </button>
          </>
        ) : (
          <p className="tp-lede">Waiting for the host to start.</p>
        )}
      </div>
      <nav className="tp-links">
        <Link className="tp-link" href="/thi-tran">
          ← Back to town
        </Link>
        <Link className="tp-link" href="/choi-nhanh">
          Pick another game
        </Link>
      </nav>
    </div>
  );
}

function Rules({ view }: { view: View }) {
  const auto = autoSecondsOf(view);
  return (
    <details className="tp-rules">
      <summary>Quick rules</summary>
      <ul>
        <li>
          Everybody starts with {money(startCashOf(view))}. Passing Departure pays {money(view.settings.salary ?? SALARY)}. The turn order is drawn at random.
        </li>
        <li>Land on an unowned property and you may buy it; if you don't, it stays free. There is no auction.</li>
        <li>Land on somebody else's property and you pay rent. When you later stop on your own city you may add one house; after 4 houses the next stop makes it a hotel. Owning a whole colour group doubles the rent of its empty lots.</li>
        <li>A double rolls again; three doubles in a row send you to Customs Hold. Leave by rolling a double, paying 50 or using a card.</li>
        <li>Short of cash? Sell houses or mortgage properties to pay. If you still cannot, you go bankrupt and your assets go to the creditor.</li>
        <li>Trade properties and cash with another player at any time, if they agree.</li>
        {auto > 0 && <li>After {auto} seconds without a move the game rolls, declines the purchase or ends the turn for the player.</li>}
      </ul>
    </details>
  );
}

/** Màn hình ngang đủ rộng thì xếp bàn cờ nằm ngang, khung 13 × 9 thay cho 9 × 13. */
function useLandscape(): boolean {
  const [landscape, setLandscape] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(orientation: landscape) and (min-width: 600px)");
    const update = () => setLandscape(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return landscape;
}

/** Quân đi từng ô một tới chỗ mới. Đi lùi, vào tạm giữ hay bay theo thẻ thì nhảy thẳng tới nơi. */
function useWalkingTokens(view: View): Record<string, number> {
  const targets = Object.fromEntries(view.players.filter((p) => p.color !== null).map((p) => [p.id, p.position]));
  const [shown, setShown] = useState(targets);
  const shownRef = useRef(targets);
  const key = JSON.stringify(targets);

  useEffect(() => {
    const step = () => {
      const next: Record<string, number> = {};
      let walking = false;
      for (const [id, to] of Object.entries(targets)) {
        const from = shownRef.current[id] ?? to;
        const ahead = (to - from + 40) % 40;
        if (ahead === 0 || ahead > 12) next[id] = to;
        else {
          next[id] = (from + 1) % 40;
          walking = true;
        }
      }
      shownRef.current = next;
      setShown(next);
      if (walking) sound.step();
      return walking;
    };
    if (!step()) return;
    const timer = setInterval(() => {
      if (!step()) clearInterval(timer);
    }, 170);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return shown;
}

type Sheet = { kind: "assets"; playerId: string } | { kind: "trade" } | { kind: "rules" } | { kind: "menu" } | { kind: "ledger" } | null;

function Game({
  view,
  send,
  chain,
  has3D,
  holding,
  onArrive,
  onBroken,
}: {
  view: View;
  send: Send;
  chain?: ChainStage;
  has3D: boolean;
  holding: boolean;
  onArrive: (rolls: number) => void;
  onBroken: () => void;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [showResult, setShowResult] = useState(true);
  // Mặc định khóa màn hình: camera đứng yên nhìn cả bàn, không tự xoay theo quân cho khỏi chóng mặt. Ai mở khóa thì camera tự bám theo lượt.
  const [locked, setLocked] = useState(true);
  useEffect(() => setLocked(readStored<boolean>(LOCK_KEY) ?? true), []);
  const toggleLock = () => {
    writeStored(LOCK_KEY, !locked);
    setLocked(!locked);
  };
  const camera: CameraMode = locked ? "board" : "follow";
  const cash = useShown(view, holding, (player) => player.cash);
  const worth = useShown(view, holding, (player) => player.worth);
  const log = useShownLog(view, holding);
  const mine = me(view);
  const active = isActive(mine);
  const paused = view.pause !== null;
  const partners = view.players.filter((p) => isActive(p) && p.id !== mine.id);

  useEffect(() => {
    if (view.phase === "ended") setShowResult(true);
  }, [view.phase]);

  // Tới lượt mình thì đóng bảng thông tin ô đang xem, để thấy ngay nút đổ xúc xắc.
  const myTurn = view.current === mine.id;
  useEffect(() => {
    if (myTurn) setSelected(null);
  }, [myTurn]);

  const pick = (index: number) => setSelected(selected === index ? null : index);
  const closeResult = () => setShowResult(false);
  const result = view.phase === "ended" && showResult && (chain ? chain.result(closeResult) : <ResultCard view={view} send={send} onClose={closeResult} />);

  // Bán nhà, cầm cố ngay trên bàn 3D: đang nợ thì tự bật, không nợ thì chọn "Cầm cố, bán nhà" trong bảng thêm. Bàn tối các ô khác,
  // chỉ sáng đất bán hay cầm cố được kèm số tiền nhận; chạm ô sáng là bán một nhà (ô có nhà) hay cầm cố (ô không nhà) luôn.
  const [raising, setRaising] = useState(false);
  const debt = view.phase === "playing" && myTurn && view.stage === "debt";
  // Đang nợ thì chờ quân tới nơi mới bật; tự chọn thì bật ngay, kể cả lúc quân người khác đang chạy.
  const selling = has3D && view.phase === "playing" && active && ((debt && !holding) || raising);
  const offers = sellOffers(view);
  const tap = (index: number) => {
    if (!selling) return pick(index);
    if (offers.has(index)) send({ t: view.props[index].houses > 0 ? "sell" : "mortgage", square: index });
  };
  useEffect(() => {
    if (!active || view.phase !== "playing") setRaising(false);
  }, [active, view.phase]);

  // Cầm dọc thì chừa dải trên, dải dưới cho thẻ người chơi và nút; xoay ngang thì chừa hai cột hai bên.
  const landscape = useLandscape();
  const crowded = view.order.length > SEATS_IN_CORNERS;
  const insets = landscape ? { x: SIDE_COLUMN_PX, y: crowded ? CROWDED_ROW_PX : 0 } : { x: 0, y: BAND_PX };
  const canTrade = active && view.phase === "playing" && !paused && view.trade === null && partners.length > 0;
  // The contract has no trades between players.
  const trades = active && view.phase === "playing" && !chain;

  if (has3D) {
    const close = () => setSheet(null);
    return (
      <div className="tp-game3d">
        <div className="tp-stage">
          <Board3D
            view={view}
            cash={cash}
            selected={selected}
            mode={camera}
            insets={insets}
            focus={selling ? offers : null}
            rolling={chain?.busy ?? false}
            onTile={tap}
            onArrive={onArrive}
            onBroken={onBroken}
          />
          <PlayerCards view={view} cash={cash} worth={worth} agents={chain?.agents} onOpen={(playerId) => setSheet({ kind: "assets", playerId })} />
          <div className="tp-tools">
            {view.phase === "playing" && <GameClock view={view} />}
            {chain?.ledger && (
              <button type="button" className="tp-round" aria-label="Transactions of this match on NEAR" title="Transactions" onClick={() => setSheet({ kind: "ledger" })}>
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.700-5.700l-1 1M14 10a4 4 0 0 0-5.700 0l-3 3a4 4 0 0 0 5.700 5.700l1-1" />
                </svg>
              </button>
            )}
            <button type="button" className="tp-round" aria-label="More: trades, mortgages, rules, camera lock, sound" onClick={() => setSheet({ kind: "menu" })}>
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
                <path d="M5 7h14M5 12h14M5 17h14" />
              </svg>
            </button>
          </div>
          {view.phase === "playing" && (
            <TurnControls
              view={view}
              send={send}
              holding={holding}
              busy={chain?.busy ?? false}
              autopilot={chain?.autopilot ?? null}
              raising={raising && !debt}
              offers={offers.size}
              onStopRaising={() => setRaising(false)}
            />
          )}
          <CardPopup view={view} holding={holding} />
          {result}
        </div>
        {selected !== null && (
          <div className="tp-sheet" role="dialog" aria-label={SQUARES[selected].name} onClick={(event) => event.target === event.currentTarget && setSelected(null)}>
            <div className="tp-detail-card">
              <SquareDetail view={view} index={selected} onClose={() => setSelected(null)} />
            </div>
          </div>
        )}
        {sheet?.kind === "menu" && (
          <div className="tp-sheet" role="dialog" aria-label="More" onClick={(event) => event.target === event.currentTarget && close()}>
            <div className="tp-sheet__body tp-more">
              <div className="tp-more__head">
                <strong>{chain?.label ?? `Room ${view.code}`}</strong>
                {view.phase === "playing" && <GameClock view={view} />}
              </div>
              <div className="tp-more__row">
                <span>Sound</span>
                <SoundToggle />
              </div>
              {/* Khóa màn hình: camera đứng yên nhìn cả bàn. Tắt thì camera lại gần người đang tới lượt. */}
              <button type="button" className="tp-more__row" aria-pressed={locked} onClick={toggleLock}>
                <span>Lock the camera</span>
                <span className="tp-switch">{locked ? "on" : "off"}</span>
              </button>
              {chain?.autopilot && view.phase === "playing" && (
                <button type="button" className="tp-more__row" aria-pressed={chain.autopilot.on} onClick={chain.autopilot.toggle}>
                  <span>Let the AI play my seat</span>
                  <span className="tp-switch">{chain.autopilot.on ? "on" : "off"}</span>
                </button>
              )}
              <div className="tp-more__buttons">
                {chain?.ledger && (
                  <button type="button" className="tp-btn" onClick={() => setSheet({ kind: "ledger" })}>
                    Transactions
                  </button>
                )}
                {trades && (
                  <button type="button" className="tp-btn" disabled={!canTrade} onClick={() => setSheet({ kind: "trade" })}>
                    Trade
                  </button>
                )}
                {active && view.phase === "playing" && !debt && (
                  <button
                    type="button"
                    className="tp-btn"
                    disabled={offers.size === 0}
                    onClick={() => {
                      setRaising(true);
                      close();
                    }}
                  >
                    Mortgage, sell houses
                  </button>
                )}
                <button type="button" className="tp-btn" onClick={() => setSheet({ kind: "rules" })}>
                  Rules
                </button>
                {chain?.resign && active && view.phase === "playing" && (
                  <button
                    type="button"
                    className="tp-btn tp-btn--quit"
                    onClick={() => {
                      if (!window.confirm("Give up this match? Your cities go back to the bank and you take the last place. This cannot be undone.")) return;
                      chain.resign?.();
                      close();
                    }}
                  >
                    Give up
                  </button>
                )}
                {view.phase === "ended" && !showResult && (
                  <button
                    type="button"
                    className="tp-btn"
                    onClick={() => {
                      setShowResult(true);
                      close();
                    }}
                  >
                    Result
                  </button>
                )}
              </div>
              <Log log={log} lines={8} />
              <button type="button" className="tp-btn tp-btn--big" onClick={close}>
                Close
              </button>
            </div>
          </div>
        )}
        {sheet?.kind === "assets" && <AssetsSheet view={view} playerId={sheet.playerId} send={send} onClose={close} />}
        {sheet?.kind === "trade" && <TradeSheet view={view} send={send} onClose={close} />}
        {sheet?.kind === "rules" && <RulesSheet view={view} onClose={close} />}
        {sheet?.kind === "ledger" && chain?.ledger && (
          <div className="tp-sheet" role="dialog" aria-label="Transactions" onClick={(event) => event.target === event.currentTarget && close()}>
            <div className="tp-sheet__body tp-more">{chain.ledger(close)}</div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="tp-game">
      <Board2D view={view} send={send} selected={selected} onSelect={pick} busy={chain?.busy ?? false}>
        {result}
      </Board2D>
      <div className="tp-side">
        <PlayersBar view={view} onOpen={(playerId) => setSheet({ kind: "assets", playerId })} />
        <div className="tp-bar">
          {mine.color !== null && (
            <button type="button" className="tp-btn" onClick={() => setSheet({ kind: "assets", playerId: mine.id })}>
              Assets
            </button>
          )}
          {trades && (
            <button type="button" className="tp-btn" disabled={!canTrade} onClick={() => setSheet({ kind: "trade" })}>
              Trade
            </button>
          )}
          <button type="button" className="tp-btn tp-btn--quiet" onClick={() => setSheet({ kind: "rules" })}>
            Rules
          </button>
          {view.phase === "ended" && !showResult && (
            <button type="button" className="tp-btn" onClick={() => setShowResult(true)}>
              Result
            </button>
          )}
        </div>
        <Log log={log} />
      </div>
      {sheet?.kind === "assets" && <AssetsSheet view={view} playerId={sheet.playerId} send={send} onClose={() => setSheet(null)} />}
      {sheet?.kind === "trade" && <TradeSheet view={view} send={send} onClose={() => setSheet(null)} />}
      {sheet?.kind === "rules" && <RulesSheet view={view} onClose={() => setSheet(null)} />}
    </div>
  );
}

function RulesSheet({ view, onClose }: { view: View; onClose: () => void }) {
  return (
    <div className="tp-sheet" role="dialog" aria-label="Quick rules">
      <div className="tp-sheet__body">
        <Rules view={view} />
        <button type="button" className="tp-btn tp-btn--big" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

/**
 * Nút của lượt nằm ngay trên bàn 3D, chỉ hiện khi cần. Tới lượt mình: nút tròn ĐỔ ở góc dưới bên phải ngay trên thẻ của mình (đổ đôi
 * thì ĐỔ TIẾP, đi xong thì XONG để hết lượt), kèm nút xây nhà khi đứng trên đất mình. Dừng ở đất trống thì hộp mua đất, mắc nợ hay
 * đang cầm cố thì một dải, hiện giữa bàn, chỗ khu phố, nên không che ô nào. Lượt người khác thì không hiện gì: mũi tên trên đầu quân
 * và viền vàng ở thẻ đã cho biết tới lượt ai.
 */
function TurnControls({
  view,
  send,
  holding,
  busy,
  autopilot,
  raising,
  offers,
  onStopRaising,
}: {
  view: View;
  send: Send;
  holding: boolean;
  /** On chain: the roll just made has not landed yet. */
  busy: boolean;
  /** On chain: the viewer's seat handed to an agent. */
  autopilot: NonNullable<ChainStage["autopilot"]> | null;
  raising: boolean;
  offers: number;
  onStopRaising: () => void;
}) {
  const mine = me(view);
  const myTurn = view.current === mine.id && !view.pause && !holding && !busy;
  const square = SQUARES[mine.position];
  const autoLeft = useAutoLeft(view);
  const center: ReactNode[] = [];
  if (view.pause) center.push(<PauseNote key="pause" view={view} send={send} />);
  if (view.trade && (view.trade.from === mine.id || view.trade.to === mine.id)) center.push(<TradeNote key="trade" view={view} send={send} />);

  let corner: ReactNode = null;
  if (raising) {
    center.push(
      <div key="raise" className="tp-strip">
        <p>{offers > 0 ? "Tap a lit property to sell a house or mortgage it." : "Nothing left to sell or mortgage."}</p>
        <button type="button" className="tp-btn tp-btn--main" onClick={onStopRaising}>
          Done
        </button>
      </div>,
    );
  } else if (myTurn && view.stage === "buy" && isOwnable(square)) {
    center.push(
      <div key="buy" className="tp-offer" role="dialog" aria-label={`Buy ${square.name}?`}>
        {square.kind === "city" && <i className="tp-offer__band" style={{ background: GROUPS[square.group].color }} />}
        <strong>{square.name}</strong>
        <span>
          Price {money(square.price)} · you have {money(mine.cash)}
        </span>
        {autoLeft !== null && <small className="tp-offer__auto">Skips by itself in {autoLeft} s</small>}
        <div className="tp-row">
          <button type="button" className="tp-btn tp-btn--main" disabled={mine.cash < square.price} onClick={() => send({ t: "buy" })}>
            Buy
          </button>
          <button type="button" className="tp-btn" onClick={() => send({ t: "skip" })}>
            Skip
          </button>
        </div>
      </div>,
    );
  } else if (myTurn && view.stage === "debt" && view.debt) {
    const owed = view.debt.reduce((sum, payee) => sum + payee.amount, 0);
    const bankrupt = () => {
      if (window.confirm("Go bankrupt and leave the game? Your assets go to the creditor.")) send({ t: "bankrupt" });
    };
    center.push(
      <div key="debt" className="tp-strip tp-strip--urgent">
        <p>
          You owe {money(owed)} and have {money(mine.cash)}. Tap a lit property to sell a house or mortgage it.
        </p>
        <div className="tp-row">
          <button type="button" className="tp-btn tp-btn--main" disabled={mine.cash < owed} onClick={() => send({ t: "pay" })}>
            Pay the debt
          </button>
          <button type="button" className="tp-btn" onClick={bankrupt}>
            Go bankrupt
          </button>
        </div>
      </div>,
    );
  } else if (autopilot?.on && isActive(mine)) {
    corner = (
      <div className="tp-turn">
        <span className="tp-turn__note" aria-live="polite">
          {view.current !== mine.id ? (autopilot.note ?? "The AI plays your seat") : autopilot.thinking ? "The AI is planning…" : "The AI is playing…"}
        </span>
        <button type="button" className="tp-btn" onClick={autopilot.toggle}>
          Take back
        </button>
      </div>
    );
  } else if (myTurn) {
    const jailed = view.stage === "roll" && mine.jail !== null;
    const again = view.stage === "end" && view.again;
    const roll = view.stage === "roll" || again;
    const index = mine.position;
    const build = view.you.can.build.includes(index);
    corner = (
      <div className="tp-turn">
        {jailed && <span className="tp-turn__note">Roll a double to get out ({mine.jail! + 1}/3)</span>}
        {jailed && (
          <button type="button" className="tp-btn" disabled={mine.cash < JAIL_FINE} onClick={() => send({ t: "bail" })}>
            Pay {JAIL_FINE} to leave
          </button>
        )}
        {jailed && mine.freeCards > 0 && (
          <button type="button" className="tp-btn" onClick={() => send({ t: "card" })}>
            Use a release card
          </button>
        )}
        {build && (
          <button type="button" className="tp-btn tp-btn--main" onClick={() => send({ t: "build", square: index })}>
            {view.props[index].houses === 4 ? "Build a hotel" : "Build a house"} · {money(houseCost(index))}
          </button>
        )}
        {autopilot && (
          <button type="button" className="tp-btn tp-turn__ai" onClick={autopilot.toggle}>
            Let AI play
          </button>
        )}
        <button type="button" className="tp-roll" onClick={() => send({ t: roll ? "roll" : "end" })} aria-label={roll ? "Roll the dice" : "End the turn"}>
          {roll ? (again ? "AGAIN" : "ROLL") : "END"}
          {/* Số giây còn lại trước khi máy bấm hộ. */}
          {autoLeft !== null && (
            <span className="tp-roll__timer" data-low={autoLeft <= 5 || undefined} aria-label={`The game moves for you in ${autoLeft} seconds`}>
              {autoLeft}
            </span>
          )}
        </button>
      </div>
    );
  }
  // A roll on its way shows as the dice themselves, tumbling until their numbers come: no words over the table.
  return (
    <>
      {center.length > 0 && <div className="tp-center">{center}</div>}
      {corner}
    </>
  );
}

/** Số giây còn lại trước khi máy bấm hộ người đang tới lượt, `null` khi không hẹn. */
function useAutoLeft(view: View): number | null {
  const left = useCountdown(view.autoInMs ?? 0);
  return view.autoInMs === null ? null : Math.ceil(left / 1000);
}

/** Bàn cờ 2D cho máy không vẽ được 3D: ô quanh viền, bảng điều khiển ở giữa bàn. */
function Board2D({ view, send, selected, onSelect, busy, children }: { view: View; send: Send; selected: number | null; onSelect: (index: number) => void; busy: boolean; children: ReactNode }) {
  const landscape = useLandscape();
  const positions = useWalkingTokens(view);
  return (
    <div className="tp-board-wrap">
      <Board view={view} cols={landscape ? 13 : 9} rows={landscape ? 9 : 13} positions={positions} selected={selected} onSelect={onSelect}>
        {selected !== null ? <SquareDetail view={view} index={selected} onClose={() => onSelect(selected)} /> : <Panel view={view} send={send} busy={busy} />}
      </Board>
      {children}
    </div>
  );
}

/** Xúc xắc trong bảng của bàn 2D. Bàn 3D đã có xúc xắc tung trong mâm nên không vẽ thêm. */
function Dice({ view, busy = false }: { view: View; busy?: boolean }) {
  const [thrown, setRolling] = useState(false);
  const [faces, setFaces] = useState<[number, number]>([1, 1]);
  const seen = useRef(view.rolls);

  useEffect(() => {
    if (view.rolls === seen.current) return;
    seen.current = view.rolls;
    sound.dice();
    setRolling(true);
    const shake = setInterval(() => setFaces([1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)]), 70);
    const stop = setTimeout(() => {
      clearInterval(shake);
      setRolling(false);
    }, 450);
    return () => {
      clearInterval(shake);
      clearTimeout(stop);
      // A second roll within the 450 ms cancels this one's stop: without this the faces kept turning until a third.
      setRolling(false);
    };
  }, [view.rolls]);

  // A roll on its way: the faces keep changing until its numbers come.
  useEffect(() => {
    if (!busy) return;
    const shake = setInterval(() => setFaces([1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)]), 70);
    return () => clearInterval(shake);
  }, [busy]);

  const rolling = thrown || busy;
  const shown = rolling ? faces : view.dice;
  if (!shown) return null;
  return (
    <div className={`tp-dice${rolling ? " tp-dice--rolling" : ""}`} aria-label={rolling ? "Rolling" : `Rolled ${shown[0]} and ${shown[1]}`}>
      {shown.map((face, i) => (
        <Die key={i} face={face} />
      ))}
    </div>
  );
}

const PIPS: Record<number, number[]> = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };

function Die({ face }: { face: number }) {
  return (
    <span className="tp-die">
      {Array.from({ length: 9 }, (_, i) => (
        <i key={i} className={PIPS[face].includes(i) ? "tp-die__pip" : undefined} />
      ))}
    </span>
  );
}

/** Bảng điều khiển giữa bàn 2D: tới lượt ai, xúc xắc, thẻ vừa rút, và các nút của người đang tới lượt. Bàn 3D dùng `TurnControls`. */
function Panel({ view, send, busy = false }: { view: View; send: Send; busy?: boolean }) {
  const current = view.players.find((p) => p.id === view.current);
  const mine = me(view);
  const myTurn = view.phase === "playing" && current?.id === mine.id && !view.pause;
  const color = current?.color ?? null;

  return (
    <div className="tp-panel">
      {view.pause && <PauseNote view={view} send={send} />}
      {view.phase === "playing" && current && (
        <p className="tp-panel__turn">
          <i className="tp-token" style={{ background: TOKEN_COLORS[color ?? 0] }} />
          {myTurn ? "Your turn" : `${current.name}'s turn`}
        </p>
      )}
      <Dice view={view} busy={busy} />
      {view.card && (
        <div className={`tp-card tp-card--${view.card.deck}`}>
          <strong>{DECK_NAMES[view.card.deck]}</strong>
          <span>{view.card.text}</span>
        </div>
      )}
      <TradeNote view={view} send={send} />
      {myTurn ? <Actions view={view} send={send} /> : view.phase === "playing" && !view.pause && current && <p className="tp-panel__wait">{waitingText(view, current)}</p>}
    </div>
  );
}

function waitingText(view: View, current: PublicPlayer): string {
  const square = SQUARES[current.position];
  switch (view.stage) {
    case "roll":
      return current.jail !== null ? `${current.name} is in Customs Hold and rolls for a double.` : `Waiting for ${current.name} to roll.`;
    case "buy":
      return `${current.name} is deciding whether to buy ${square.name}.`;
    case "debt":
      return `${current.name} is raising cash to pay a debt.`;
    case "end":
      return view.again ? `${current.name} rolled a double and rolls again.` : `Waiting for ${current.name} to end the turn.`;
  }
}

function Actions({ view, send }: { view: View; send: Send }) {
  const mine = me(view);
  const square = SQUARES[mine.position];

  if (view.stage === "roll" && mine.jail !== null) {
    return (
      <div className="tp-actions">
        <p className="tp-panel__note">You are in Customs Hold. Roll a double to get out (try {mine.jail + 1}/3).</p>
        <button type="button" className="tp-btn tp-btn--main" onClick={() => send({ t: "roll" })}>
          Roll the dice
        </button>
        <div className="tp-row">
          <button type="button" className="tp-btn" disabled={mine.cash < JAIL_FINE} onClick={() => send({ t: "bail" })}>
            Pay {JAIL_FINE} to leave
          </button>
          {mine.freeCards > 0 && (
            <button type="button" className="tp-btn" onClick={() => send({ t: "card" })}>
              Use a release card
            </button>
          )}
        </div>
      </div>
    );
  }
  if (view.stage === "roll" || (view.stage === "end" && view.again)) {
    return (
      <div className="tp-actions">
        {view.stage === "end" && <p className="tp-panel__note">You rolled a double: roll again.</p>}
        <button type="button" className="tp-btn tp-btn--main tp-btn--big" onClick={() => send({ t: "roll" })}>
          {view.stage === "end" ? "Roll again" : "Roll the dice"}
        </button>
        <BuildHere view={view} send={send} />
      </div>
    );
  }
  if (view.stage === "buy" && isOwnable(square)) {
    const short = mine.cash < square.price;
    return (
      <div className="tp-actions">
        <p className="tp-panel__note">
          {square.name} has no owner. {short && `You only have ${money(mine.cash)}.`}
        </p>
        <button type="button" className="tp-btn tp-btn--main" disabled={short} onClick={() => send({ t: "buy" })}>
          Buy · {money(square.price)}
        </button>
        <button type="button" className="tp-btn" onClick={() => send({ t: "skip" })}>
          Don't buy
        </button>
      </div>
    );
  }
  if (view.stage === "debt" && view.debt) {
    const owed = view.debt.reduce((sum, payee) => sum + payee.amount, 0);
    const creditors = view.debt.map((payee) => (payee.id ? nameOf(view, payee.id) : "the bank"));
    const bankrupt = () => {
      if (window.confirm("Go bankrupt and leave the game? Your assets go to the creditor.")) send({ t: "bankrupt" });
    };
    return (
      <div className="tp-actions">
        <p className="tp-panel__note tp-panel__note--urgent">
          You owe {[...new Set(creditors)].join(", ")} {money(owed)} and have {money(mine.cash)}. Sell houses or mortgage under Assets to cover it.
        </p>
        <button type="button" className="tp-btn tp-btn--main" disabled={mine.cash < owed} onClick={() => send({ t: "pay" })}>
          Pay the debt
        </button>
        <button type="button" className="tp-btn" onClick={bankrupt}>
          Go bankrupt
        </button>
      </div>
    );
  }
  return (
    <div className="tp-actions">
      <BuildHere view={view} send={send} />
      <button type="button" className="tp-btn tp-btn--main tp-btn--big" onClick={() => send({ t: "end" })}>
        End the turn
      </button>
    </div>
  );
}

/** Đứng trên đất của mình thì xây ngay tại chỗ, khỏi phải mở mục Tài sản. */
function BuildHere({ view, send }: { view: View; send: Send }) {
  const index = me(view).position;
  if (!view.you.can.build.includes(index)) return null;
  return (
    <button type="button" className="tp-btn" onClick={() => send({ t: "build", square: index })}>
      {view.props[index].houses === 4 ? "Build a hotel" : "Build a house"} in {SQUARES[index].name} · {money(houseCost(index))}
    </button>
  );
}

/** Người đang tới lượt vắng: ai cũng thấy còn bao lâu nữa thì người đó bị loại. */
function PauseNote({ view, send }: { view: View; send: Send }) {
  const pause = view.pause!;
  const left = useCountdown(pause.leftMs);
  const name = nameOf(view, pause.away);
  return (
    <div className="tp-pause" role="status">
      <p>
        <strong>Game paused.</strong> {name} lost the connection and is out unless back within {formatClock(left)}.
      </p>
      {view.you.isHost && (
        <button type="button" className="tp-btn" onClick={() => window.confirm("Cancel this game and go back to the lobby?") && send({ t: "lobby" })}>
          Cancel the game
        </button>
      )}
    </div>
  );
}

function propertyNames(indexes: number[]): string {
  return indexes.map((i) => SQUARES[i].name).join(", ");
}

/** Đề nghị đổi đất đang chờ: người nhận đồng ý hoặc từ chối, người gửi rút lại được, người khác chỉ xem. */
function TradeNote({ view, send }: { view: View; send: Send }) {
  const trade = view.trade;
  if (!trade || view.phase !== "playing") return null;
  const from = nameOf(view, trade.from);
  const to = nameOf(view, trade.to);
  const side = (squares: number[], cash: number) => [propertyNames(squares), cash > 0 ? `${money(cash)} cash` : ""].filter(Boolean).join(" and ") || "nothing";

  if (trade.to === view.you.id) {
    return (
      <div className="tp-trade" role="alert">
        <p>
          <strong>{from}</strong> offers a trade:
        </p>
        <p>You get: {side(trade.give, trade.giveCash)}</p>
        <p>You give: {side(trade.take, trade.takeCash)}</p>
        <div className="tp-row">
          <button type="button" className="tp-btn tp-btn--main" disabled={view.pause !== null} onClick={() => send({ t: "answer", accept: true })}>
            Accept
          </button>
          <button type="button" className="tp-btn" disabled={view.pause !== null} onClick={() => send({ t: "answer", accept: false })}>
            Decline
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="tp-trade">
      <p>
        {trade.from === view.you.id ? "You" : from} offered {trade.to === view.you.id ? "you" : to} a trade: {side(trade.give, trade.giveCash)} for {side(trade.take, trade.takeCash)}.
      </p>
      {trade.from === view.you.id && (
        <button type="button" className="tp-btn" onClick={() => send({ t: "withdraw" })}>
          Withdraw
        </button>
      )}
    </div>
  );
}

function PlayersBar({ view, onOpen }: { view: View; onOpen: (id: string) => void }) {
  const players = view.order.map((id) => view.players.find((p) => p.id === id)!);
  return (
    <ul className="tp-players">
      {players.map((player) => (
        <li key={player.id}>
          <button
            type="button"
            className={`tp-chip${player.id === view.current ? " tp-chip--turn" : ""}${player.bankrupt ? " tp-chip--out" : ""}${player.online ? "" : " tp-chip--away"}`}
            onClick={() => onOpen(player.id)}
            aria-label={`${player.name}, ${player.bankrupt ? "bankrupt" : `${money(player.cash)} cash`}. See assets`}
          >
            <i className="tp-token" style={{ background: TOKEN_COLORS[player.color ?? 0] }} />
            <span className="tp-chip__name">
              {player.name}
              {player.id === view.you.id && " (you)"}
            </span>
            <span className="tp-chip__cash">{player.bankrupt ? "bankrupt" : money(player.cash)}</span>
            {player.jail !== null && <span className="tp-chip__flag">held</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Số của từng người để hiện (tiền mặt, tổng tài sản): quân chưa đi tới nơi thì giữ số cũ, để tiền thuê hay thuế trừ đúng lúc quân
 * tới ô, và người khác mua đất xong ngay trong lúc quân còn chạy thì tài sản cũng chưa đổi.
 */
function useShown(view: View, holding: boolean, pick: (player: PublicPlayer) => number): Record<string, number> {
  const shown = useRef<Record<string, number>>({});
  if (!holding) shown.current = Object.fromEntries(view.players.map((p) => [p.id, pick(p)]));
  return shown.current;
}

/** Bàn 3D có tới chừng này người thì mỗi người một góc; đông hơn thì thêm người ở giữa hàng trên, hàng dưới. */
const SEATS_IN_CORNERS = 4;
/** Đông người thì bàn 3D xoay ngang chừa chừng này điểm ảnh ở trên và dưới cho hàng thẻ người chơi, kẻo thẻ ở giữa che góc bàn. */
const CROWDED_ROW_PX = 56;
/** Bàn 3D xoay ngang chừa hai cột hai bên rộng chừng này: cột trái cho đồng hồ, nút thêm; cột phải cho nút của lượt (khớp với CSS `.tp-tools`, `.tp-turn`). */
const SIDE_COLUMN_PX = 172;
/**
 * Bàn 3D cầm dọc chừa dải trên, dải dưới cao chừng này cho hàng thẻ người chơi. Đồng hồ, nút thêm và nút tròn ĐỔ nằm sát hai mép,
 * chỗ hình thoi của bàn không với tới, nên không cần chừa thêm.
 */
const BAND_PX = 120;

/** Đất bán nhà hay cầm cố được ngay lúc này, kèm số tiền nhận: bán một nhà được nửa giá nhà, cầm cố được nửa giá đất. */
function sellOffers(view: View): Map<number, number> {
  const offers = new Map<number, number>();
  for (const index of view.you.can.sell) offers.set(index, houseCost(index) / 2);
  for (const index of view.you.can.mortgage) {
    const square = SQUARES[index];
    if (isOwnable(square)) offers.set(index, square.price / 2);
  }
  return offers;
}
/** Ảnh nhân vật trên thẻ người chơi vẽ vuông chừng này điểm ảnh, đủ nét cho màn hình điện thoại. */
const PORTRAIT_PX = 128;

/** Ảnh vẽ sẵn theo bộ đồ, dùng chung cho mọi lần vào ván: đổi bộ đồ mới phải vẽ lại. */
const portraitCache = new Map<string, Promise<string>>();

/**
 * Ảnh đầu và vai nhân vật của từng người, vẽ bằng file vẽ nhân vật của thị trấn (tải sau, cùng Three.js với bàn 3D).
 * Máy không vẽ được thì không có ảnh, thẻ dùng chữ cái đầu tên.
 */
function usePortraits(players: PublicPlayer[]): Record<string, string> {
  const [portraits, setPortraits] = useState<Record<string, string>>({});
  const key = JSON.stringify(players.map((p) => [p.id, p.look]));
  useEffect(() => {
    let cancelled = false;
    import("../../town/chibi-draw")
      .then(({ drawPortrait }) =>
        Promise.all(
          players.map(async (player) => {
            const look = JSON.stringify(player.look);
            let job = portraitCache.get(look);
            if (!job) {
              job = drawPortrait(player.look, PORTRAIT_PX);
              portraitCache.set(look, job);
            }
            return [player.id, await job.catch(() => "")] as const;
          }),
        ),
      )
      .then((pairs) => {
        if (!cancelled) setPortraits(Object.fromEntries(pairs.filter(([, url]) => url)));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return portraits;
}

/**
 * Người chơi ngồi quanh bàn 3D: nửa đầu theo thứ tự lượt ngồi hàng trên từ trái sang, nửa sau ngồi hàng dưới từ phải sang,
 * nên lượt đi vòng theo chiều kim đồng hồ như ngồi bàn thật. Thẻ to: ảnh nhân vật, tên, tiền mặt, tổng tài sản. Chạm để xem tài sản.
 */
function PlayerCards({
  view,
  cash,
  worth: worths,
  agents,
  onOpen,
}: {
  view: View;
  cash: Record<string, number>;
  worth: Record<string, number>;
  /** On chain: the seats an agent plays. */
  agents?: Record<string, AgentTag>;
  onOpen: (id: string) => void;
}) {
  const half = Math.ceil(view.order.length / 2);
  // Mình luôn ngồi góc dưới bên phải, cạnh nút tròn ĐỔ, như game cờ tỷ phú trên điện thoại; người khác vẫn ngồi theo thứ tự lượt.
  const mine = view.order.indexOf(view.you.id);
  const order = mine < 0 ? view.order : view.order.map((_, i) => view.order[(mine - half + i + view.order.length * 2) % view.order.length]);
  const players = order.map((id) => view.players.find((p) => p.id === id)!);
  const portraits = usePortraits(players);
  const rows = [players.slice(0, half), players.slice(half)];
  return (
    <div className="tp-hud" data-crowded={players.length > SEATS_IN_CORNERS || undefined} aria-label="Players">
      {rows.map((row, r) => (
        <ul key={r} className={`tp-hud__row${r === 1 ? " tp-hud__row--bottom" : ""}`}>
          {row.map((player, i) => {
            // Thẻ sát mép phải thì ảnh nằm bên phải, chữ canh phải. Hàng dưới xếp từ phải sang nên thẻ đầu ở mép phải.
            const right = r === 0 ? row.length > 1 && i === row.length - 1 : i === 0;
            const shown = cash[player.id] ?? player.cash;
            const worth = worths[player.id] ?? player.worth;
            const agent = agents?.[player.id];
            return (
              <li key={player.id} data-side={right ? "right" : "left"}>
                <button
                  type="button"
                  className={`tp-hud__chip${player.id === view.current ? " tp-hud__chip--turn" : ""}${player.bankrupt ? " tp-chip--out" : ""}${player.online ? "" : " tp-hud__chip--away"}`}
                  onClick={() => onOpen(player.id)}
                  aria-label={`${player.name}, ${player.bankrupt ? "bankrupt" : `${money(shown)} cash, net worth ${money(worth)}`}. See assets`}
                >
                  <span className="tp-hud__face" style={{ "--seat": TOKEN_COLORS[player.color ?? 0] } as CSSProperties}>
                    {portraits[player.id] ? <img src={portraits[player.id]} alt="" /> : <b>{player.name.slice(0, 1).toUpperCase()}</b>}
                    {player.jail !== null && <i className="tp-hud__flag">Held</i>}
                    {!player.online && player.jail === null && <i className="tp-hud__flag">Away</i>}
                  </span>
                  <span className="tp-hud__name">
                    {player.name}
                    {player.id === view.you.id && <small> (you)</small>}
                  </span>
                  {player.bankrupt ? <span className="tp-hud__cash">Bankrupt</span> : <Wallet cash={shown} />}
                  {!player.bankrupt && <span className="tp-hud__worth">Worth {money(worth)}</span>}
                </button>
                {agent && !player.bankrupt && (
                  <p className="tp-hud__agent" data-fallback={agent.fallback || undefined} data-mine={player.id === view.you.id || undefined}>
                    <b>
                      AI · {agent.driver}
                      {agent.fallback ? " (fallback)" : ""}
                    </b>
                    {agent.reason && <span>{agent.reason}</span>}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      ))}
    </div>
  );
}

/** Số tiền chạy dần tới số mới, kèm số cộng trừ hiện ra rồi trôi xuống, mờ đi. Tiếng tiền do bàn 3D phát. */
function Wallet({ cash }: { cash: number }) {
  const [shown, setShown] = useState(cash);
  const [changes, setChanges] = useState<{ key: number; amount: number }[]>([]);
  const target = useRef(cash);
  const current = useRef(cash);

  useEffect(() => {
    if (cash === target.current) return;
    const amount = cash - target.current;
    target.current = cash;
    setChanges((list) => [...list, { key: performance.now(), amount }]);
    const from = current.current;
    const began = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - began) / 700);
      current.current = Math.round(from + (cash - from) * (1 - (1 - t) ** 3));
      setShown(current.current);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [cash]);

  return (
    <span className="tp-hud__cash">
      {money(shown)}
      {changes.map((change) => (
        <b
          key={change.key}
          className={`tp-hud__delta tp-hud__delta--${change.amount > 0 ? "up" : "down"}`}
          onAnimationEnd={() => setChanges((list) => list.filter((item) => item.key !== change.key))}
        >
          {change.amount > 0 ? "+" : "−"}
          {money(Math.abs(change.amount))}
        </b>
      ))}
    </span>
  );
}

/** Thẻ vừa rút bật lên giữa bàn khi quân đã tới nơi, cả bàn cùng đọc. Chạm để đóng, không chạm thì tự đóng sau vài giây. */
function CardPopup({ view, holding }: { view: View; holding: boolean }) {
  const card = view.card;
  const key = card ? `${view.rolls}:${card.deck}:${card.text}` : null;
  // Thẻ đã có sẵn lúc mới vào xem thì không bật lên nữa.
  const seen = useRef(key);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (!key || holding || key === seen.current) return;
    seen.current = key;
    setOpen(key);
    const timer = setTimeout(() => setOpen(null), 5000);
    return () => clearTimeout(timer);
  }, [key, holding]);

  if (!card || open !== key) return null;
  const drawer = view.players.find((p) => p.id === view.current);
  return (
    <div className="tp-popup" role="dialog" aria-label={`${DECK_NAMES[card.deck]} card`} onClick={() => setOpen(null)}>
      <div className={`tp-popup__card tp-popup__card--${card.deck}`}>
        <img className="tp-popup__art" src={DECK_ART[card.deck]} alt="" width={96} height={96} />
        <strong>{DECK_NAMES[card.deck]}</strong>
        <span>{card.text}</span>
        <small>Drawn by {drawer && drawer.id === view.you.id ? "you" : drawer?.name} · tap to close</small>
      </div>
    </div>
  );
}

/** Diễn biến để hiện: quân chưa tới nơi thì chưa có dòng mới, kẻo đọc được "trả tiền thuê" trước khi quân tới ô. */
function useShownLog(view: View, holding: boolean): string[] {
  const shown = useRef(view.log);
  if (!holding) shown.current = view.log;
  return shown.current;
}

/** Mấy dòng diễn biến cuối, mới nhất ở dưới. */
function Log({ log, lines = 3 }: { log: string[]; lines?: number }) {
  const shown = log.slice(-lines);
  if (shown.length === 0) return null;
  return (
    <ol className="tp-log" aria-label="Recent events">
      {shown.map((line, i) => (
        <li key={`${log.length}-${i}`}>{line}</li>
      ))}
    </ol>
  );
}

/** Đất của một người. Của mình thì có nút xây, bán nhà, cầm cố, chuộc. */
function AssetsSheet({ view, playerId, send, onClose }: { view: View; playerId: string; send: Send; onClose: () => void }) {
  const player = view.players.find((p) => p.id === playerId)!;
  const mine = playerId === view.you.id && view.phase === "playing" && !view.pause;
  const owned = Object.keys(view.props)
    .map(Number)
    .filter((i) => view.props[i].owner === playerId)
    .sort((a, b) => a - b);
  const { can } = view.you;

  return (
    <div className="tp-sheet" role="dialog" aria-label={`${player.name}'s assets`}>
      <div className="tp-sheet__body">
        <header className="tp-sheet__head">
          <h2>{playerId === view.you.id ? "Your assets" : `${player.name}'s assets`}</h2>
          <p>
            Cash {money(player.cash)} · Net worth {money(player.worth)}
            {player.freeCards > 0 && ` · ${player.freeCards} release card${player.freeCards > 1 ? "s" : ""}`}
          </p>
        </header>
        {owned.length === 0 && <p className="tp-hint">No properties yet.</p>}
        <ul className="tp-assets">
          {owned.map((index) => {
            const square = SQUARES[index];
            const props = view.props[index];
            return (
              <li key={index} className={`tp-asset${props.mortgaged ? " tp-asset--mortgaged" : ""}`}>
                <span className="tp-asset__band" style={{ background: square.kind === "city" ? GROUPS[square.group].color : "#6b6b6b" }} />
                <span className="tp-asset__name">
                  <strong>{square.name}</strong>
                  <small>{props.mortgaged ? "Mortgaged" : props.houses === 5 ? "Hotel" : props.houses > 0 ? `${props.houses} house${props.houses > 1 ? "s" : ""}` : square.kind === "city" ? "Empty lot" : ""}</small>
                </span>
                {mine && (
                  <span className="tp-asset__actions">
                    {can.build.includes(index) && (
                      <button type="button" className="tp-btn tp-btn--small tp-btn--main" onClick={() => send({ t: "build", square: index })}>
                        +{props.houses === 4 ? "Hotel" : "House"} {houseCost(index)}
                      </button>
                    )}
                    {can.sell.includes(index) && (
                      <button type="button" className="tp-btn tp-btn--small" onClick={() => send({ t: "sell", square: index })}>
                        Sell house +{houseCost(index) / 2}
                      </button>
                    )}
                    {can.mortgage.includes(index) && (
                      <button type="button" className="tp-btn tp-btn--small" onClick={() => send({ t: "mortgage", square: index })}>
                        Mortgage +{(square as { price: number }).price / 2}
                      </button>
                    )}
                    {can.redeem.includes(index) && (
                      <button type="button" className="tp-btn tp-btn--small" onClick={() => send({ t: "redeem", square: index })}>
                        Redeem −{redeemPrice(index)}
                      </button>
                    )}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        {mine && <p className="tp-hint">To build, stop on your own city: one house per stop. A house sells for half its price; a property with houses cannot be mortgaged or traded. Redeeming costs 10% more.</p>}
        <button type="button" className="tp-btn tp-btn--big" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

/** Đất đổi được: cả bộ màu không có nhà. */
function tradableOf(view: View, playerId: string): number[] {
  return Object.keys(view.props)
    .map(Number)
    .filter((i) => {
      const square = SQUARES[i];
      if (view.props[i].owner !== playerId) return false;
      return square.kind !== "city" || groupSquares(square.group).every((j) => (view.props[j]?.houses ?? 0) === 0);
    })
    .sort((a, b) => a - b);
}

function TradeSheet({ view, send, onClose }: { view: View; send: Send; onClose: () => void }) {
  const mine = me(view);
  const partners = view.players.filter((p) => isActive(p) && p.id !== mine.id);
  const [to, setTo] = useState(partners[0]?.id ?? "");
  const [give, setGive] = useState<number[]>([]);
  const [take, setTake] = useState<number[]>([]);
  const [giveCash, setGiveCash] = useState(0);
  const [takeCash, setTakeCash] = useState(0);
  const partner = partners.find((p) => p.id === to);

  const toggle = (list: number[], set: (next: number[]) => void, index: number) => set(list.includes(index) ? list.filter((i) => i !== index) : [...list, index]);
  const pickPartner = (id: string) => {
    setTo(id);
    setTake([]);
    setTakeCash(0);
  };
  const empty = give.length + take.length + giveCash + takeCash === 0;
  const submit = () => {
    send({ t: "offer", offer: { to, give, take, giveCash, takeCash } });
    onClose();
  };

  const choices = (owner: string, list: number[], set: (next: number[]) => void) => {
    const options = tradableOf(view, owner);
    if (options.length === 0) return <p className="tp-hint">No properties to trade.</p>;
    return (
      <ul className="tp-picks">
        {options.map((index) => {
          const square = SQUARES[index];
          return (
            <li key={index}>
              <label className="tp-pick">
                <input type="checkbox" checked={list.includes(index)} onChange={() => toggle(list, set, index)} />
                <span className="tp-asset__band" style={{ background: square.kind === "city" ? GROUPS[square.group].color : "#6b6b6b" }} />
                {square.name}
                {view.props[index].mortgaged && " (mortgaged)"}
              </label>
            </li>
          );
        })}
      </ul>
    );
  };

  const cashInput = (value: number, max: number, set: (value: number) => void, label: string) => (
    <label className="tp-cash">
      {label}
      <input
        className="tp-input tp-input--small"
        type="number"
        inputMode="numeric"
        min={0}
        max={max}
        step={10}
        value={value}
        onChange={(event) => set(Math.max(0, Math.min(max, Math.floor(Number(event.target.value) || 0))))}
      />
      <small>up to {money(max)}</small>
    </label>
  );

  return (
    <div className="tp-sheet" role="dialog" aria-label="Trade">
      <div className="tp-sheet__body">
        <header className="tp-sheet__head">
          <h2>Trade</h2>
          <p>A property with houses must have them sold before it can be traded.</p>
        </header>
        <div className="tp-segments" role="group" aria-label="Trade with">
          {partners.map((p) => (
            <button key={p.id} type="button" aria-pressed={p.id === to} onClick={() => pickPartner(p.id)}>
              {p.name}
            </button>
          ))}
        </div>
        <section className="tp-section">
          <h3 className="tp-heading">You give</h3>
          {choices(mine.id, give, setGive)}
          {cashInput(giveCash, mine.cash, setGiveCash, "Cash")}
        </section>
        {partner && (
          <section className="tp-section">
            <h3 className="tp-heading">You take from {partner.name}</h3>
            {choices(partner.id, take, setTake)}
            {cashInput(takeCash, partner.cash, setTakeCash, "Cash")}
          </section>
        )}
        <div className="tp-row">
          <button type="button" className="tp-btn tp-btn--main" disabled={empty || !partner} onClick={submit}>
            Send the offer
          </button>
          <button type="button" className="tp-btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function ResultCard({ view, send, onClose }: { view: View; send: Send; onClose: () => void }) {
  const result = view.result!;
  const ranking = result.ranking.map((id) => view.players.find((p) => p.id === id)!);
  const winner = ranking[0];
  return (
    <div className="tp-result" role="dialog" aria-label="Result of the game">
      <img className="tp-result__trophy" src={TROPHY_ART} alt="" width={132} height={132} />
      <p className="tp-result__title">{winner.id === view.you.id ? "You win!" : `${winner.name} wins`}</p>
      <p className="tp-result__line">{result.reason === "time" ? "Time is up: ranked by net worth." : "Everybody else went bankrupt."}</p>
      <ol className="tp-ranking">
        {ranking.map((player) => (
          <li key={player.id}>
            <i className="tp-token" style={{ background: TOKEN_COLORS[player.color ?? 0] }} />
            <span>{player.name}</span>
            <strong>{player.bankrupt ? "bankrupt" : money(player.worth)}</strong>
          </li>
        ))}
      </ol>
      <div className="tp-row">
        {view.you.isHost ? (
          <button type="button" className="tp-btn tp-btn--main" onClick={() => send({ t: "lobby" })}>
            New game
          </button>
        ) : (
          <p className="tp-hint">Waiting for the host to open a new game.</p>
        )}
        <button type="button" className="tp-btn" onClick={onClose}>
          View the board
        </button>
      </div>
    </div>
  );
}
