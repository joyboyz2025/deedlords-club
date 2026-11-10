// Chạy thật một lớp phòng trên RoomHost với socket giả và đồng hồ giả, dùng chung cho test phòng Cờ vua, Cờ tỷ phú
// và test danh sách phòng, khóa PIN của cả bốn game.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, mock } from "node:test";
import type { CreateOptions } from "../lib/roomAccess.ts";
import { RoomHost, type RoomClass, type StoredRoom } from "../server/room-host.ts";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

Object.assign(globalThis, {
  WebSocketRequestResponsePair: class {
    request: string;
    response: string;
    constructor(request: string, response: string) {
      this.request = request;
      this.response = response;
    }
  },
});

let dir = "";

/** Gọi một lần ở đầu file test: mỗi test có đồng hồ giả và thư mục lưu phòng riêng. */
export function useFakeClock(now: number): void {
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now });
    dir = mkdtempSync(join(tmpdir(), "phong-thu-"));
  });
  afterEach(() => {
    mock.timers.reset();
    rmSync(dir, { recursive: true, force: true });
  });
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Cho thời gian trôi. Mỗi bước để mọi việc của bước đó chạy xong, nên alarm mới hẹn cũng được tính. */
export async function pass(ms: number, step = 1000): Promise<void> {
  await settle();
  for (let left = ms; left > 0; left -= step) {
    mock.timers.tick(Math.min(step, left));
    await settle();
  }
}

export type Message = { t: string; [key: string]: any };

export class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  messages: Message[] = [];
  closeCode: number | null = null;

  send(text: string): void {
    if (this.readyState !== 1) throw new Error("socket đã đóng");
    this.messages.push(JSON.parse(text));
  }

  close(code = 1000): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.closeCode = code;
    this.emit("close");
  }

  terminate(): void {
    this.close(1006);
  }

  ping(): void {}

  say(message: Message): void {
    this.emit("message", JSON.stringify(message), false);
  }

  get lastError(): string | undefined {
    return this.messages.findLast((m) => m.t === "error")?.code;
  }

  get view(): Message {
    return this.messages.findLast((m) => m.t === "view")!;
  }

  get identity() {
    const { name, id, secret } = this.view.you;
    return { name, id, secret };
  }

  /** Tin cuối cùng thuộc loại `t`. */
  last(t: string): Message | undefined {
    return this.messages.findLast((m) => m.t === t);
  }
}

export class TestRoom {
  host!: RoomHost;
  hostKey = "";
  gone = false;
  sockets: FakeSocket[] = [];
  file = join(dir, "phong.json");
  private Class: RoomClass;

  constructor(Class: unknown) {
    this.Class = Class as RoomClass;
  }

  /** Mở phòng mới với mã ABCD, trả về khóa chủ phòng. `options`: ai mở và phòng có hiện trong danh sách không. */
  static async create(Class: unknown, options?: CreateOptions): Promise<TestRoom> {
    const room = new TestRoom(Class);
    room.open();
    room.hostKey = (await room.host.run(() => room.host.object.create("ABCD", options)))!;
    return room;
  }

  open(stored: StoredRoom | null = null): void {
    this.gone = false;
    this.host = new RoomHost(this.file, stored, () => {
      this.gone = true;
    });
    this.host.object = new this.Class(this.host, {});
  }

  /** `ip`: địa chỉ mạng server gắn vào socket, để thử đếm số lần nhập sai PIN. */
  async connect(hello: object, ip?: string): Promise<FakeSocket> {
    const ws = new FakeSocket();
    this.host.accept(ws as never, ip);
    this.sockets.push(ws);
    ws.say({ t: "hello", ...hello } as Message);
    await settle();
    return ws;
  }

  async say(ws: FakeSocket, message: Message): Promise<void> {
    ws.say(message);
    await settle();
  }

  /** Thông tin phòng tự báo cho danh sách trong thị trấn. */
  summary(): any {
    return this.host.object.summary?.() ?? null;
  }

  /**
   * Server chết đột ngột rồi bật lại từ file: kết nối cũ mất mà không có sự kiện đóng nào.
   * `edit` sửa phòng trước khi nạp lại, ví dụ để giả một phòng mở từ bản cũ.
   */
  async restart(edit?: (room: any) => void): Promise<void> {
    this.host.flush();
    const stored = JSON.parse(readFileSync(this.file, "utf8")) as StoredRoom;
    if (edit) {
      const room = JSON.parse(stored.values.room);
      edit(room);
      stored.values.room = JSON.stringify(room);
    }
    for (const ws of this.sockets) {
      ws.removeAllListeners();
      ws.readyState = 3;
    }
    this.sockets = [];
    this.host.closeAll();
    // Object cũ coi như đã chết, không được ghi đè file nữa.
    (this.host as any).removed = true;
    this.open(stored);
    await settle();
  }

  assertOpen(): void {
    assert.equal(this.gone, false, "phòng đã đóng quá sớm");
    assert.ok(existsSync(this.file), "file phòng phải còn");
  }

  /** Mọi người đang ở trong phòng đều biết lý do, không máy nào tự nối lại, phòng mất hẳn. */
  async assertClosed(code: string, inside: FakeSocket[]): Promise<void> {
    for (const ws of inside) {
      assert.equal(ws.lastError, code);
      assert.equal(ws.closeCode, 4000, "phải là mã đóng báo client đừng nối lại");
    }
    assert.equal(this.gone, true, "phòng phải được bỏ khỏi server");
    assert.ok(!existsSync(this.file), "file phòng phải bị xóa");
    this.open();
    const late = await this.connect({ name: "Đến muộn" });
    assert.equal(late.lastError, "no-room");
  }
}
