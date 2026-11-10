import { serverOfCode } from "./roomCode";

/** Mỗi server là một tài khoản Cloudflare riêng. Có server 2 thì người tạo phòng được chọn. */
export const SERVER_COUNT = process.env.NEXT_PUBLIC_ROOM_URL_2 ? 2 : 1;

/**
 * Địa chỉ server phòng chơi. Không cấu hình thì dùng cùng hostname với trang,
 * để điện thoại trong cùng wifi nối được với máy đang chạy `npm run dev`.
 */
export function roomServerUrl(server: number): string {
  const devPort = devRoomPort();
  if (devPort) return `http://${window.location.hostname}:${devPort}`;
  const url = server === 2 ? process.env.NEXT_PUBLIC_ROOM_URL_2 : process.env.NEXT_PUBLIC_ROOM_URL;
  return (url ?? `http://${window.location.hostname}:8787`).replace(/\/$/, "");
}

/**
 * Chạy thử ở máy khi nhiều phiên cùng làm game: mỗi phiên có server phòng riêng ở một cổng.
 * Mở trang với `?room=8791` để trỏ sang cổng đó; tab ấy nhớ cổng cho tới khi đóng. Bản build thật bỏ qua phần này.
 */
function devRoomPort(): string | null {
  if (process.env.NODE_ENV !== "development") return null;
  const asked = new URLSearchParams(window.location.search).get("room");
  if (asked && /^\d{4,5}$/.test(asked)) sessionStorage.setItem("devRoomPort", asked);
  return sessionStorage.getItem("devRoomPort");
}

/** Server đang giữ phòng này. Web chỉ có một server thì mọi mã phòng đều về đó. */
export function roomUrlOfCode(code: string): string {
  return roomServerUrl(SERVER_COUNT === 2 ? serverOfCode(code) : 1);
}
