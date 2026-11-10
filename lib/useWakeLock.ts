"use client";

import { useEffect } from "react";

/**
 * Giữ màn hình sáng khi `active`, để điện thoại của quản trò tự tắt màn hình không làm cả bàn bị dừng.
 * Trình duyệt tự nhả khóa khi chuyển sang ứng dụng khác nên phải xin lại lúc quay về.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || !("wakeLock" in navigator)) return;

    let stopped = false;
    let lock: WakeLockSentinel | null = null;

    const request = async () => {
      try {
        const granted = await navigator.wakeLock.request("screen");
        if (stopped) void granted.release();
        else lock = granted;
      } catch {
        // Máy từ chối, ví dụ đang tiết kiệm pin: màn hình tắt thì ván tạm dừng tới khi quản trò mở lại.
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void request();
    };

    void request();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release();
    };
  }, [active]);
}
