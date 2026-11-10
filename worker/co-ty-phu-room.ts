import { DurableObject } from "cloudflare:workers";
import {
  MAX_PEOPLE,
  answerTrade,
  autoAct,
  autoSecondsOf,
  build,
  buy,
  checkTime,
  createGame,
  currentPlayer,
  declareBankruptcy,
  endTurn,
  mortgage,
  newPlayer,
  payBail,
  payDebt,
  proposeTrade,
  redeem,
  removeAbsent,
  returnToLobby,
  roll,
  sellHouse,
  setAutoSeconds,
  setLimit,
  setSalary,
  setStartCash,
  setPlaying,
  skipBuying,
  startGame,
  useFreeCard,
  withdrawTrade,
  type Game,
} from "../games/co-ty-phu/engine.ts";
import type { ClientMessage, ErrorCode, ServerMessage } from "../games/co-ty-phu/protocol.ts";
import { cleanLook, lookFromSeat } from "../games/ma-soi/look.ts";
import { viewFor } from "../games/co-ty-phu/view.ts";
import { CLOSE_FATAL } from "../lib/closeCodes.ts";
import { randomHex } from "../lib/random.ts";
import { OPEN_ACCESS, accessFor, accessView, cleanPin, mayEnter, pinGuard, socketIp, type Access, type CreateOptions, type RoomReport } from "../lib/roomAccess.ts";
import { HOST_AWAY_MS, HOST_GRACE_MS, IDLE_MS } from "../lib/roomTimers.ts";

type RoomState = {
  code: string;
  hostKey: string;
  game: Game;
  /** Lần cuối có người thật làm gì đó. Máy tự nối lại mạng không tính, nếu không một máy chập chờn sẽ giữ phòng sống mãi. */
  touchedAt: number;
  /** Người đang tới lượt vắng: ván đứng yên từ lúc `since`, giữ lại thời gian còn của ván có hẹn giờ. */
  pause: { since: number; leftMs: number | null } | null;
  /** Ai mở phòng, có hiện trong danh sách thị trấn không, có khóa không. Phòng mở từ bản cũ không có. */
  access?: Access;
  createdAt?: number;
  /** Lúc máy bấm hộ người đang tới lượt nếu người đó vẫn chưa bấm gì (`autoAct`). Phòng lưu từ bản cũ không có. */
  autoAt?: number | null;
};

type Attachment = { id: string };
type Env = Record<string, never>;
type Hello = Extract<ClientMessage, { t: "hello" }>;

const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_NAME_LENGTH = 20;
/**
 * Giờ máy bấm hộ tính thêm chừng này cho xúc xắc lăn và quân chạy trên máy người chơi: nút chỉ hiện khi quân đã tới nơi,
 * nên lúc nút hiện ra người chơi còn gần đủ số giây chủ phòng chọn.
 */
const AUTO_GRACE_MS = 4000;

function attachmentOf(ws: WebSocket): Attachment | null {
  return ws.deserializeAttachment() as Attachment | null;
}

/**
 * Một phòng Cờ tỷ phú. Luật nằm trong `games/co-ty-phu/engine.ts`; object này chỉ lưu, hẹn giờ và phát kết quả.
 * Mỗi việc lưu ngay, vì người chơi làm lần lượt và cách nhau vài giây.
 *
 * Luật vắng mặt tính theo người đang tới lượt, vì chỉ người đó làm ván đứng lại; người khác tắt màn hình lúc chờ là chuyện thường.
 * Vắng quá 10 giây thì ván và đồng hồ hẹn giờ đứng yên; quay lại trong 10 phút thì chơi tiếp, không thì người đó bị loại.
 */
export class TycoonRoom extends DurableObject<Env> {
  private room: RoomState | null = null;
  /** Giờ alarm đang hẹn. Đặt alarm cũng tính một dòng ghi nên chỉ đặt khi cần đổi. */
  private armedAt: number | null = null;
  /** Lúc người đang tới lượt bắt đầu vắng, để tính thời gian ân hạn. */
  private awaySince: number | null = null;
  /** Tin cuối đã gửi cho từng máy. Không có gì mới thì khỏi gửi. */
  private lastSent = new WeakMap<WebSocket, string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    void ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get<RoomState>("room")) ?? null;
      this.armedAt = await ctx.storage.getAlarm();
    });
  }

  /** Trả về khóa chủ phòng, hoặc `null` nếu mã phòng này đang được dùng. */
  async create(code: string, options?: CreateOptions): Promise<string | null> {
    if (this.room) return null;
    this.room = { code, hostKey: randomHex(16), game: createGame(), touchedAt: Date.now(), pause: null, access: accessFor(options), createdAt: Date.now() };
    await this.save();
    await this.schedule();
    return this.room.hostKey;
  }

  async fetch(): Promise<Response> {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return;
    let message: ClientMessage | null;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;
    if (message.t === "hello") return this.hello(ws, message);

    const room = this.room;
    const player = room?.game.players.find((p) => p.id === attachmentOf(ws)?.id);
    if (!room || !player) return;
    const now = Date.now();
    room.touchedAt = now;
    const { game } = room;
    const id = player.id;
    // Cài đặt phòng đổi được cả khi ván đang dừng, vì không đụng tới ván chơi.
    if (message.t === "listed" || message.t === "pin") {
      if (player.isHost) await this.changeAccess(message);
      return;
    }
    // Ván đứng yên chờ người đang tới lượt quay lại. Chủ phòng vẫn hủy ván được nếu người đó không về nữa.
    if (room.pause && !(message.t === "lobby" && player.isHost)) return;

    const snapshot = JSON.stringify(game);
    switch (message.t) {
      case "play":
        setPlaying(game, id, message.on);
        break;
      case "limit":
        if (player.isHost) setLimit(game, message.minutes);
        break;
      case "salary":
        if (player.isHost) setSalary(game, message.amount);
        break;
      case "cash":
        if (player.isHost) setStartCash(game, message.amount);
        break;
      case "auto":
        if (player.isHost) setAutoSeconds(game, message.seconds);
        break;
      case "start":
        if (player.isHost) startGame(game, this.onlineIds(), now);
        break;
      case "roll":
        roll(game, id);
        break;
      case "buy":
        buy(game, id);
        break;
      case "skip":
        skipBuying(game, id);
        break;
      case "end":
        endTurn(game, id);
        break;
      case "bail":
        payBail(game, id);
        break;
      case "card":
        useFreeCard(game, id);
        break;
      case "pay":
        payDebt(game, id);
        break;
      case "bankrupt":
        declareBankruptcy(game, id);
        break;
      case "build":
        build(game, id, message.square);
        break;
      case "sell":
        sellHouse(game, id, message.square);
        break;
      case "mortgage":
        mortgage(game, id, message.square);
        break;
      case "redeem":
        redeem(game, id, message.square);
        break;
      case "offer":
        proposeTrade(game, id, message.offer);
        break;
      case "answer":
        answerTrade(game, id, message.accept === true);
        break;
      case "withdraw":
        withdrawTrade(game, id);
        break;
      case "lobby":
        if (!player.isHost) return;
        returnToLobby(game);
        room.pause = null;
        break;
      default:
        return;
    }
    // Bấm trùng hoặc sai lượt thì không có gì để ghi hay phát lại.
    if (JSON.stringify(game) === snapshot) return;
    await this.commit(now);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.socketGone(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.socketGone(ws);
  }

  async alarm(): Promise<void> {
    this.armedAt = null;
    const room = this.room;
    if (!room) return;
    const { game } = room;
    const now = Date.now();
    // Hết giờ thì báo vòng cuối trước, vì việc này không đóng phòng.
    if (checkTime(game, now)) {
      room.touchedAt = now;
      return this.commit(now);
    }
    const deadline = this.deadline();
    if (deadline && now >= deadline.at) return this.closeRoom(deadline.code);

    // Người đang tới lượt để quá giờ mà vẫn có mặt: máy bấm hộ. Không tính là có người làm gì, nên cả bàn bỏ đi thì phòng vẫn đóng.
    if (room.autoAt != null && now >= room.autoAt && !room.pause && autoAct(game)) return this.commit(now);

    const current = currentPlayer(game);
    if (room.pause && now >= room.pause.since + HOST_AWAY_MS) {
      if (current) removeAbsent(game, current.id);
      this.resume(now);
      room.touchedAt = now;
      return this.commit(now);
    }
    const graceOver = this.awaySince !== null && now >= this.awaySince + HOST_GRACE_MS;
    if (graceOver && !room.pause && current && !this.onlineIds().has(current.id)) {
      room.pause = { since: now, leftMs: game.endsAt === null ? null : Math.max(game.endsAt - now, 0) };
      game.endsAt = null;
      this.awaySince = null;
      return this.commit(now);
    }
    await this.schedule();
  }

  private async hello(ws: WebSocket, hello: Hello): Promise<void> {
    const room = this.room;
    if (!room) return this.reject(ws, "no-room");

    const { game } = room;
    const now = Date.now();
    let changed = false;
    let player = game.players.find((p) => p.id === hello.id && p.secret === hello.secret);
    if (!player) {
      // Phòng có khóa: người mới phải đúng PIN, trừ chủ phòng vào bằng khóa chủ phòng. Một địa chỉ sai nhiều lần thì phải đợi.
      const member = hello.hostKey === room.hostKey;
      const access = room.access ?? OPEN_ACCESS;
      const ip = socketIp(ws);
      if (!member && access.pin !== null && ip && pinGuard.blocked(ip, now)) return this.reject(ws, "pin-wait");
      if (!mayEnter(access, hello.pin, member)) {
        if (ip) pinGuard.miss(ip, now);
        return this.reject(ws, "pin");
      }
      if (game.players.length >= MAX_PEOPLE) return this.reject(ws, "full");
      // Vào giữa ván thì xem, ván sau mới chơi được.
      const name = String(hello.name ?? "").trim().slice(0, MAX_NAME_LENGTH) || `Khách ${game.players.length + 1}`;
      player = newPlayer(randomHex(4), randomHex(8), name, false, cleanLook(hello.look) ?? lookFromSeat(game.players.length));
      game.players.push(player);
      room.touchedAt = now;
      changed = true;
    }
    if (hello.hostKey === room.hostKey && !player.isHost) {
      player.isHost = true;
      changed = true;
    }
    ws.serializeAttachment({ id: player.id } satisfies Attachment);

    // Người đang tới lượt đã về: ván và đồng hồ hẹn giờ chạy tiếp đúng thời gian còn lại.
    if (room.pause && currentPlayer(game)?.id === player.id) {
      this.resume(now);
      this.armAuto(now);
      room.touchedAt = now;
      changed = true;
    }
    this.watchAway(now);
    if (changed) await this.save();
    await this.schedule();
    this.sendViews();
  }

  private reject(ws: WebSocket, code: ErrorCode): void {
    this.sendSafely(ws, JSON.stringify({ t: "error", code } satisfies ServerMessage));
    try {
      ws.close(CLOSE_FATAL, code);
    } catch {
      // Socket vừa đóng.
    }
  }

  private async socketGone(ws: WebSocket): Promise<void> {
    this.sendViews(ws);
    if (this.room) {
      this.watchAway(Date.now(), ws);
      await this.schedule();
    }
  }

  /** Người đang tới lượt mất kết nối thì bắt đầu đếm ân hạn; có mặt, hết ván hoặc đang dừng thì thôi. */
  private watchAway(now: number, closing?: WebSocket): void {
    const room = this.room!;
    const current = currentPlayer(room.game);
    if (!current || room.pause || this.onlineIds(closing).has(current.id)) this.awaySince = null;
    else this.awaySince ??= now;
  }

  private resume(now: number): void {
    const room = this.room!;
    if (!room.pause) return;
    room.game.endsAt = room.pause.leftMs === null ? null : now + room.pause.leftMs;
    room.pause = null;
  }

  /** Mọi người đều bị đẩy ra và phòng mất hẳn: ai vào lại mã này sẽ nhận `no-room`. */
  private async closeRoom(code: ErrorCode): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    this.room = null;
    for (const ws of sockets) this.reject(ws, code);
    await this.ctx.storage.deleteAll();
  }

  /** Giờ phòng phải tự đóng và lý do. Đang tạm dừng thì chưa tính: hết giờ chờ thì người vắng bị loại trước đã. */
  private deadline(): { at: number; code: ErrorCode } | null {
    const { pause, game, touchedAt } = this.room!;
    if (pause) return null;
    // Phòng chờ không có gì đang chạy và mọi người còn đợi nhau, nên chỉ dọn sau một ngày.
    if (game.phase === "lobby") return { at: touchedAt + ROOM_TTL_MS, code: "no-room" };
    return { at: touchedAt + IDLE_MS, code: "closed-idle" };
  }

  private async commit(now: number): Promise<void> {
    this.watchAway(now);
    this.armAuto(now);
    await this.save();
    await this.schedule();
    this.sendViews();
  }

  /**
   * Ván vừa đổi: nếu đang chờ người tới lượt đổ, chọn mua hay đi xong thì hẹn giờ máy bấm hộ, đếm lại từ đầu mỗi khi có người
   * làm gì đó. Đang tạm dừng, đang nợ hay chủ phòng chọn chờ mãi thì thôi.
   */
  private armAuto(now: number): void {
    const room = this.room!;
    const { game } = room;
    const seconds = autoSecondsOf(game);
    const waiting = game.phase === "playing" && !room.pause && seconds > 0 && game.stage !== "debt";
    room.autoAt = waiting ? now + seconds * 1000 + AUTO_GRACE_MS : null;
  }

  /**
   * Mỗi object chỉ có một alarm: hẹn tới việc gần nhất trong lúc phòng phải đóng, lúc hết giờ chơi,
   * lúc hết ân hạn của người đang tới lượt và lúc hết giờ chờ người đó.
   * Alarm dậy sớm chỉ kiểm tra rồi hẹn lại, nên chỉ cần đặt khi phải dậy sớm hơn giờ đang hẹn.
   */
  private async schedule(): Promise<void> {
    const { game, pause } = this.room!;
    const endsAt = game.phase === "playing" && !game.lastRound ? game.endsAt : null;
    const times = [
      this.deadline()?.at,
      endsAt,
      this.awaySince === null ? null : this.awaySince + HOST_GRACE_MS,
      pause && pause.since + HOST_AWAY_MS,
      pause ? null : this.room!.autoAt,
    ];
    const wakeAt = Math.min(...times.filter((at): at is number => typeof at === "number"));
    if (this.armedAt !== null && this.armedAt <= wakeAt) return;
    this.armedAt = wakeAt;
    await this.ctx.storage.setAlarm(wakeAt);
  }

  private async save(): Promise<void> {
    if (this.room) await this.ctx.storage.put("room", this.room);
  }

  private onlineIds(closing?: WebSocket): Set<string> {
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const id = attachmentOf(ws)?.id;
      if (id && ws !== closing) ids.add(id);
    }
    return ids;
  }

  /** Chủ phòng đổi cài đặt phòng: hiện hay ẩn trong danh sách thị trấn, đặt hay bỏ PIN. */
  private async changeAccess(message: Extract<ClientMessage, { t: "listed" | "pin" }>): Promise<void> {
    const room = this.room!;
    const access = room.access ?? OPEN_ACCESS;
    if (message.t === "listed") {
      if (typeof message.listed !== "boolean") return;
      room.access = { ...access, listed: message.listed };
    } else {
      const pin = cleanPin(message.pin);
      if (pin === undefined) return;
      room.access = { ...access, pin };
    }
    await this.save();
    this.sendViews();
  }

  /** Thông tin cho danh sách phòng trong thị trấn. Người chơi tính những người đang mở máy, kể cả người xem. */
  summary(): RoomReport | null {
    const room = this.room;
    if (!room) return null;
    const access = room.access ?? OPEN_ACCESS;
    return {
      code: room.code,
      hostName: access.hostName,
      players: this.onlineIds().size,
      maxPlayers: MAX_PEOPLE,
      status: room.game.phase === "playing" ? "playing" : "waiting",
      locked: access.pin !== null,
      listed: access.listed,
      createdAt: room.createdAt ?? 0,
    };
  }

  private sendViews(closing?: WebSocket): void {
    const room = this.room;
    if (!room) return;
    const { game } = room;
    const online = this.onlineIds(closing);
    const now = Date.now();
    const current = currentPlayer(game);
    const pause = room.pause && current ? { away: current.id, leftMs: Math.max(room.pause.since + HOST_AWAY_MS - now, 0) } : null;
    const access = room.access ?? OPEN_ACCESS;
    for (const ws of this.ctx.getWebSockets()) {
      const id = attachmentOf(ws)?.id;
      if (!id || ws === closing) continue;
      const isHost = game.players.some((p) => p.id === id && p.isHost);
      const text = JSON.stringify({ ...viewFor(game, id, { code: room.code, online, now, pause, autoAt: room.autoAt ?? null }), access: accessView(access, isHost) });
      if (this.lastSent.get(ws) === text) continue;
      this.lastSent.set(ws, text);
      this.sendSafely(ws, text);
    }
  }

  private sendSafely(ws: WebSocket, text: string): void {
    try {
      ws.send(text);
    } catch {
      // Socket vừa đóng; webSocketClose sẽ cập nhật danh sách.
    }
  }
}
