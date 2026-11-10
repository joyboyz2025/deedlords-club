"use client";

// Cài đặt phòng của chủ phòng, dùng chung bốn game: hiện trong danh sách thị trấn hay không, khóa bằng PIN 4 số.
// Server giữ cài đặt và báo lại cho mọi người, nên công tắc đọc thẳng từ `access` chứ không giữ trạng thái riêng.

import { useEffect, useState } from "react";
import { randomBelow } from "@/lib/random";
import type { AccessView } from "@/lib/roomAccess";

type AccessCommand = { t: "listed"; listed: boolean } | { t: "pin"; pin: string | null };

const randomPin = () => String(randomBelow(10_000)).padStart(4, "0");

export function RoomAccessPanel({ access, send, className }: { access: AccessView; send: (command: AccessCommand) => void; className: string }) {
  const [draft, setDraft] = useState(access.pin ?? "");
  useEffect(() => setDraft(access.pin ?? ""), [access.pin]);

  // Ô PIN chỉ gửi khi đủ 4 số; sửa dở mà bỏ đi thì trả về PIN đang dùng.
  const savePin = () => {
    if (/^\d{4}$/.test(draft) && draft !== access.pin) send({ t: "pin", pin: draft });
    else setDraft(access.pin ?? "");
  };

  return (
    <fieldset className={className}>
      <legend>Cài đặt phòng</legend>
      <label>
        <input type="checkbox" checked={access.listed} onChange={(event) => send({ t: "listed", listed: event.target.checked })} />
        Hiện trong danh sách thị trấn
      </label>
      <label>
        <input type="checkbox" checked={access.locked} onChange={(event) => send({ t: "pin", pin: event.target.checked ? randomPin() : null })} />
        Khóa bằng PIN
      </label>
      {access.locked && (
        <input
          aria-label="PIN 4 số"
          inputMode="numeric"
          autoComplete="off"
          maxLength={4}
          value={draft}
          onChange={(event) => setDraft(event.target.value.replace(/\D/g, ""))}
          onBlur={savePin}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      )}
    </fieldset>
  );
}
