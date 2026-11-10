"use client";

import { SERVER_COUNT } from "@/lib/config";

/** Chỉ hiện khi có hai server. Mã phòng tự mang số server nên người vào sau không phải chọn gì. */
export function ServerPicker({ server, onChange, className }: { server: number; onChange: (server: number) => void; className: string }) {
  if (SERVER_COUNT < 2) return null;
  return (
    <div className={className} role="group" aria-label="Chọn server">
      {[1, 2].map((n) => (
        <button key={n} type="button" aria-pressed={server === n} onClick={() => onChange(n)}>
          Server {n}
        </button>
      ))}
    </div>
  );
}

export function createRoomProblem(server: number): string {
  return SERVER_COUNT < 2 ? "Không tạo được phòng. Kiểm tra mạng rồi thử lại." : `Server ${server} không tạo được phòng. Thử server còn lại.`;
}
