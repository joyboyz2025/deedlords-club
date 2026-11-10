"use client";

// PIN của phòng có khóa. Link mời mang sẵn PIN (`#pin=0427`): đọc một lần, giữ trong tab này để nối lại khỏi nhập,
// rồi xóa khỏi địa chỉ để PIN không nằm trong lịch sử hay lộ khi chụp màn hình.

import { useCallback, useEffect, useState } from "react";

const PIN_IN_LINK = /^#pin=(\d{4})$/;

function readPin(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePin(key: string, pin: string | null): void {
  try {
    if (pin === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, pin);
  } catch {
    // Không lưu được thì lần nối lại hỏi PIN lần nữa.
  }
}

/** PIN đang có cho một phòng, `scope` là game và mã phòng. `undefined` là chưa đọc xong, đợi rồi mới gửi lời chào. */
export function usePin(scope: string): [string | null | undefined, (pin: string | null) => void] {
  const key = `pin:${scope}`;
  const [pin, setPinState] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    const fromLink = PIN_IN_LINK.exec(window.location.hash)?.[1];
    if (fromLink) {
      writePin(key, fromLink);
      history.replaceState(history.state, "", window.location.pathname + window.location.search);
    }
    setPinState(fromLink ?? readPin(key));
  }, [key]);

  const setPin = useCallback(
    (next: string | null) => {
      writePin(key, next);
      setPinState(next);
    },
    [key],
  );

  return [pin, setPin];
}
