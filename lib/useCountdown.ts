"use client";

import { useEffect, useState } from "react";

/** Đếm ngược từ số mili giây server vừa báo. */
export function useCountdown(ms: number): number {
  const [left, setLeft] = useState(ms);

  useEffect(() => {
    const deadline = Date.now() + ms;
    setLeft(ms);
    const timer = setInterval(() => setLeft(Math.max(deadline - Date.now(), 0)), 250);
    return () => clearInterval(timer);
  }, [ms]);

  return left;
}

export function formatClock(ms: number): string {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
