"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CLOSE_FATAL } from "./closeCodes";
import { roomUrlOfCode } from "./config";

const PING_EVERY_MS = 15_000;
const PONG_GRACE_MS = 3_000;
const MAX_RETRY_MS = 5_000;

export type Link = "connecting" | "online" | "offline";

/**
 * Giữ một WebSocket tới phòng chơi: tự nối lại, phát hiện kết nối đã chết, gửi lời chào mỗi lần nối.
 * `getHello` trả về `null` thì chưa kết nối. Hàm được gọi lại mỗi lần nối, nên luôn dùng danh tính mới nhất.
 */
export function useSocket<Message>(code: string, path: string, getHello: (() => unknown) | null, onMessage: (message: Message) => void) {
  const [link, setLink] = useState<Link>("connecting");
  const socket = useRef<WebSocket | null>(null);

  const latest = useRef({ getHello, onMessage });
  latest.current = { getHello, onMessage };
  const enabled = getHello !== null;

  useEffect(() => {
    if (!enabled) return;

    let stopped = false;
    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let pongTimer: ReturnType<typeof setTimeout> | undefined;

    const scheduleConnect = () => {
      clearTimeout(retryTimer);
      // Thêm độ lệch ngẫu nhiên để cả phòng không nối lại cùng một khoảnh khắc.
      const delay = Math.min(500 * 2 ** attempts, MAX_RETRY_MS) * (0.75 + Math.random() / 2);
      attempts += 1;
      retryTimer = setTimeout(connect, delay);
    };

    /** Bỏ socket hiện tại ngay, không đợi trình duyệt phát hiện socket đã chết. */
    const dropSocket = () => {
      clearTimeout(pongTimer);
      const ws = socket.current;
      if (!ws) return;
      ws.onclose = ws.onmessage = ws.onopen = null;
      ws.close();
      socket.current = null;
      if (!stopped) setLink("offline");
    };

    const reconnect = () => {
      dropSocket();
      scheduleConnect();
    };

    const connect = () => {
      dropSocket();
      const ws = new WebSocket(`${roomUrlOfCode(code).replace(/^http/, "ws")}${path}`);
      socket.current = ws;
      ws.onopen = () => ws.send(JSON.stringify(latest.current.getHello?.()));
      ws.onmessage = (event) => {
        if (event.data === "pong") {
          clearTimeout(pongTimer);
          return;
        }
        attempts = 0;
        setLink("online");
        latest.current.onMessage(JSON.parse(event.data) as Message);
      };
      ws.onclose = (event) => {
        socket.current = null;
        clearTimeout(pongTimer);
        if (event.code === CLOSE_FATAL) return;
        setLink("offline");
        scheduleConnect();
      };
    };

    const ping = () => {
      const ws = socket.current;
      if (ws?.readyState !== WebSocket.OPEN) return;
      ws.send("ping");
      clearTimeout(pongTimer);
      pongTimer = setTimeout(reconnect, PONG_GRACE_MS);
    };

    // Điện thoại vừa mở khóa hoặc đổi mạng: kiểm tra ngay thay vì đợi tới lần ping kế tiếp.
    const wake = () => {
      if (document.visibilityState !== "visible") return;
      if (socket.current?.readyState === WebSocket.OPEN) {
        ping();
      } else if (!socket.current) {
        attempts = 0;
        clearTimeout(retryTimer);
        connect();
      }
    };

    connect();
    const pingTimer = setInterval(ping, PING_EVERY_MS);
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);

    return () => {
      stopped = true;
      clearInterval(pingTimer);
      clearTimeout(retryTimer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      dropSocket();
    };
  }, [path, enabled]);

  const send = useCallback((message: unknown) => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }, []);

  return { link, send };
}
