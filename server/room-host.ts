// Cho một phòng chơi viết cho Cloudflare chạy trên máy thường: cung cấp đúng phần Durable Object mà phòng dùng tới.

import { renameSync, rmSync, writeFileSync } from "node:fs";
import type { WebSocket } from "ws";
import type { CreateOptions, RoomReport } from "../lib/roomAccess.ts";

/** Ghi xuống đĩa cách nhau chừng này, để nhiều thay đổi liên tiếp chỉ thành một lần ghi. */
const WRITE_GAP_MS = 300;
const TEXT_LIMIT = 16 * 1024;

export type StoredRoom = { values: Record<string, string>; alarm: number | null };

export type RoomObject = {
  webSocketMessage(ws: unknown, raw: string): Promise<void>;
  webSocketClose(ws: unknown): Promise<void>;
  webSocketError(ws: unknown): Promise<void>;
  alarm(): Promise<void>;
  /** `options`: ai mở phòng và phòng có hiện trong danh sách thị trấn không. Thị trấn không dùng. */
  create(code: string, options?: CreateOptions): Promise<string | null>;
  /** Thông tin cho danh sách phòng trong thị trấn; loại phòng nào không có thì không hiện. */
  summary?(): RoomReport | null;
};

export type RoomClass = new (ctx: RoomHost, env: Record<string, never>) => RoomObject;

type Socket = WebSocket & {
  attachment?: unknown;
  alive?: boolean;
  /** Địa chỉ mạng của máy, để đếm số lần nhập sai PIN. */
  ip?: string;
  serializeAttachment?: (value: unknown) => void;
  deserializeAttachment?: () => unknown;
};

export class RoomHost {
  readonly storage = {
    get: async <T>(key: string): Promise<T | undefined> => {
      const text = this.values[key];
      return text === undefined ? undefined : (JSON.parse(text) as T);
    },
    put: async (key: string, value: unknown): Promise<void> => {
      this.values[key] = JSON.stringify(value);
      this.persistSoon();
    },
    deleteAll: async (): Promise<void> => {
      this.values = {};
      this.setTimer(null);
      this.removed = true;
      if (this.writeTimer) clearTimeout(this.writeTimer);
      this.writeTimer = null;
      rmSync(this.file, { force: true });
      this.onGone();
    },
    getAlarm: async (): Promise<number | null> => this.alarmAt,
    setAlarm: async (at: number): Promise<void> => {
      this.setTimer(at);
      this.persistSoon();
    },
  };

  object!: RoomObject;

  private sockets = new Set<Socket>();
  private queue: Promise<unknown> = Promise.resolve();
  private values: Record<string, string>;
  private alarmAt: number | null = null;
  private alarmTimer: ReturnType<typeof setTimeout> | null = null;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private autoRequest: string | null = null;
  private autoResponse: string | null = null;
  private removed = false;
  private file: string;
  private onGone: () => void;

  constructor(file: string, stored: StoredRoom | null, onGone: () => void) {
    this.file = file;
    this.onGone = onGone;
    this.values = stored?.values ?? {};
    // Sống lại sau khi tắt máy: alarm đã quá giờ thì chạy ngay, ván chơi tiếp đúng chỗ dừng.
    this.setTimer(stored?.alarm ?? null);
  }

  // Phần phòng chơi gọi tới

  setWebSocketAutoResponse(pair: { request: string; response: string }): void {
    this.autoRequest = pair.request;
    this.autoResponse = pair.response;
  }

  blockConcurrencyWhile(work: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(work);
    return this.queue as Promise<void>;
  }

  getWebSockets(): Socket[] {
    return [...this.sockets].filter((ws) => ws.readyState === ws.OPEN);
  }

  // Phần server gọi tới

  /** Mọi sự kiện của một phòng chạy lần lượt, như Durable Object: kinh, rút số và alarm không thể chen nhau. */
  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch((error) => console.error("Lỗi trong phòng", this.file, error));
    return result;
  }

  accept(ws: Socket, ip?: string): void {
    ws.alive = true;
    ws.ip = ip;
    ws.serializeAttachment = (value) => {
      ws.attachment = value;
    };
    ws.deserializeAttachment = () => ws.attachment ?? null;
    this.sockets.add(ws);

    ws.on("pong", () => {
      ws.alive = true;
    });
    ws.on("message", (data, isBinary) => {
      ws.alive = true;
      if (isBinary) return;
      const text = data.toString();
      if (text.length > TEXT_LIMIT) return;
      if (text === this.autoRequest) {
        ws.send(this.autoResponse!);
        return;
      }
      void this.run(() => this.object.webSocketMessage(ws, text)).catch(() => {});
    });
    ws.on("close", () => {
      this.sockets.delete(ws);
      void this.run(() => this.object.webSocketClose(ws))
        .catch(() => {})
        .then(() => {
          // Kết nối tới mã phòng không tồn tại: không có gì để giữ lại.
          if (this.sockets.size === 0 && Object.keys(this.values).length === 0) this.onGone();
        });
    });
    ws.on("error", () => {
      void this.run(() => this.object.webSocketError(ws)).catch(() => {});
    });
  }

  /** Máy mất mạng đột ngột không kịp báo: hỏi thăm định kỳ, không trả lời thì đóng để cả phòng biết người đó đã rớt. */
  checkAlive(): void {
    for (const ws of this.sockets) {
      if (ws.alive === false) {
        ws.terminate();
        continue;
      }
      ws.alive = false;
      ws.ping();
    }
  }

  /** Ghi ngay, dùng khi tắt máy. */
  flush(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = null;
    if (this.removed || Object.keys(this.values).length === 0) return;
    const stored: StoredRoom = { values: this.values, alarm: this.alarmAt };
    writeFileSync(`${this.file}.tmp`, JSON.stringify(stored));
    renameSync(`${this.file}.tmp`, this.file);
  }

  closeAll(): void {
    if (this.alarmTimer) clearTimeout(this.alarmTimer);
    for (const ws of this.sockets) ws.terminate();
  }

  private persistSoon(): void {
    this.writeTimer ??= setTimeout(() => this.flush(), WRITE_GAP_MS);
  }

  private setTimer(at: number | null): void {
    if (this.alarmTimer) clearTimeout(this.alarmTimer);
    this.alarmTimer = null;
    this.alarmAt = at;
    if (at === null) return;
    this.alarmTimer = setTimeout(
      () => {
        this.alarmAt = null;
        this.alarmTimer = null;
        void this.run(() => this.object.alarm()).catch(() => {});
      },
      Math.max(at - Date.now(), 0),
    );
  }
}
