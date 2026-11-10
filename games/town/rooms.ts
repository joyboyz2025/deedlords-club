"use client";

// Mở phòng game từ trình duyệt.
//
// Standalone deedlords copy: the town game, its Supabase/HSK login and the other games were removed, so this file
// only knows the property game and has no login. The room server still asks for a bearer token before it opens a
// room, so every device gets a local identity: a random `dev:<hex>` token kept in localStorage. That is the same
// "test account" format the room servers accept when started with TOWN_DEV_AUTH=1 (`npm run dev:server`,
// `npm run dev:room`). A server that does not accept it answers 401, which is shown as "could not create a room".
// Replace `localToken()` with real sign-in (e.g. a NEAR account) when there is one.

import { useEffect, useState } from "react";
import { roomServerUrl } from "@/lib/config";
import { randomHex } from "@/lib/random";
import { readStored, writeStored } from "@/lib/storage";
import { hostKeyStorage as tyPhuHostKey } from "../co-ty-phu/useRoom";
import { loadTownMe } from "./me";

export type GameId = "co-ty-phu";

type GameRoom = {
  name: string;
  /** Gọi một phòng của trò này là gì. */
  roomWord: "bàn" | "phòng";
  /** Đường dẫn mở phòng trên server phòng chơi. */
  createPath: string;
  hostKeyStorage: (code: string) => string;
  /** Trang của người vừa mở phòng. */
  hostPage: (code: string) => string;
  /** Trang người khác vào bằng mã. */
  joinPage: (code: string) => string;
};

export const GAME_ROOMS: Record<GameId, GameRoom> = {
  "co-ty-phu": {
    name: "Cờ tỷ phú",
    roomWord: "phòng",
    createPath: "/co-ty-phu/rooms",
    hostKeyStorage: tyPhuHostKey,
    hostPage: (code) => `/co-ty-phu/${code}`,
    joinPage: (code) => `/co-ty-phu/${code}`,
  },
};

/** Local identity of this device (no sign-in in the standalone build). Same pattern the room server's devAuth accepts. */
const TOKEN_KEY = "local:token";
/** Tên người chơi đã nhập ở Cờ tỷ phú (TycoonScreen), làm tên chủ phòng gợi ý. */
const NAME_KEY = "typhu:name";

function localToken(): string {
  const stored = readStored<unknown>(TOKEN_KEY);
  if (typeof stored === "string" && /^dev:[\w-]{1,40}$/.test(stored)) return stored;
  const token = `dev:${randomHex(8)}`;
  writeStored(TOKEN_KEY, token);
  return token;
}

/** Ai cũng mở được phòng (không có đăng nhập). `null` cho tới khi trang chạy trong trình duyệt, giống bản gốc. */
export function useCanCreate(): boolean | null {
  const [can, setCan] = useState<boolean | null>(null);
  useEffect(() => {
    setCan(true);
  }, []);
  return can;
}

/**
 * Mở phòng rồi lưu khóa chủ phòng vào máy. Phòng mở từ trang game thì ẩn (`listed: false`).
 * Không có trang đăng nhập, nên server từ chối mã (401) cũng báo là không tạo được phòng ("busy"), không bao giờ "signed-out".
 */
export async function openRoom(game: GameId, { listed, server = 1 }: { listed: boolean; server?: number }): Promise<{ code: string } | { problem: "signed-out" | "busy" }> {
  const room = GAME_ROOMS[game];
  const hostName = loadTownMe()?.name ?? readStored<string>(NAME_KEY) ?? "";
  try {
    const response = await fetch(`${roomServerUrl(server)}${room.createPath}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${localToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ listed, hostName }),
    });
    if (!response.ok) return { problem: "busy" };
    const { code, hostKey } = (await response.json()) as { code: string; hostKey: string };
    writeStored(room.hostKeyStorage(code), hostKey);
    return { code };
  } catch {
    return { problem: "busy" };
  }
}
