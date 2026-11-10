"use client";

import { useCallback, useState } from "react";
import { needsPin } from "@/lib/roomAccess";
import { useSocket } from "@/lib/useSocket";
import type { ClientMessage, ErrorCode, ServerMessage } from "./protocol";
import type { View } from "./view";

export const hostKeyStorage = (code: string) => `typhu:host:${code}`;

export type Send = (message: ClientMessage) => void;

/** Phản chiếu phòng Cờ tỷ phú vào React. Mỗi tin `view` là toàn bộ phần người này được xem, kèm lúc nhận để đồng hồ tự đếm. */
export function useRoom(code: string, getHello: () => ClientMessage, onView: (view: View) => void) {
  const [state, setState] = useState<{ view: View; at: number } | null>(null);
  const [error, setError] = useState<ErrorCode | null>(null);

  const handle = useCallback(
    (message: ServerMessage) => {
      if (message.t === "error") {
        setError(message.code);
      } else {
        setState({ view: message, at: Date.now() });
        onView(message);
      }
    },
    [onView],
  );

  // Phòng có khóa từ chối thì thôi nối, đợi người chơi nhập PIN rồi gọi `retry`.
  const { link, send } = useSocket<ServerMessage>(code, `/co-ty-phu/rooms/${code}/ws`, needsPin(error) ? null : getHello, handle);
  const retry = useCallback(() => setError(null), []);
  return { view: state?.view ?? null, receivedAt: state?.at ?? 0, link, error, send: send as Send, retry };
}
