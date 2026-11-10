// Ai mở phòng, phòng có hiện trong danh sách thị trấn không, có khóa PIN không. Dùng chung cho mọi loại phòng,
// trên server ở VPS lẫn server dự phòng Cloudflare. Thuần, để test được.

const MAX_HOST_NAME = 20;
const LOBBY_LIMIT = 50;
const PIN_TRIES = 10;
const PIN_WINDOW_MS = 10 * 60 * 1000;

/** Phần "ai, hiện, khóa" của một phòng. Phòng mở trước bản này không có, coi như `OPEN_ACCESS`. */
export type Access = { ownerId: string | null; hostName: string; listed: boolean; pin: string | null };
export type CreateOptions = { ownerId: string; hostName: string; listed: boolean };
/** Phần gửi cho trình duyệt: chỉ chủ phòng có PIN. */
export type AccessView = { listed: boolean; locked: boolean; pin: string | null };
export type RoomStatus = "waiting" | "playing";
export type RoomSummary = { code: string; hostName: string; players: number; maxPlayers: number; status: RoomStatus; locked: boolean };
/** Phòng tự báo cho server, thêm hai thứ server dùng để lọc và xếp mà không gửi ra ngoài. */
export type RoomReport = RoomSummary & { listed: boolean; createdAt: number };

export const OPEN_ACCESS: Access = { ownerId: null, hostName: "", listed: false, pin: null };

export function accessFor(options: CreateOptions | undefined): Access {
  return options ? { ownerId: options.ownerId, hostName: options.hostName, listed: options.listed, pin: null } : OPEN_ACCESS;
}

export function accessView(access: Access, isHost: boolean): AccessView {
  return { listed: access.listed, locked: access.pin !== null, pin: isHost ? access.pin : null };
}

/** Body của lời mở phòng `{ listed, hostName }`. Thiếu hay sai thì ẩn, tên là "Chủ phòng". */
export function cleanCreateBody(body: unknown): { hostName: string; listed: boolean } {
  const { hostName, listed } = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const name = typeof hostName === "string" ? Array.from(hostName.normalize("NFC").trim()).slice(0, MAX_HOST_NAME).join("").trim() : "";
  return { hostName: name || "Chủ phòng", listed: listed === true };
}

/** PIN đúng 4 chữ số; `null` là bỏ khóa; không hợp lệ thì `undefined`. */
export function cleanPin(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && /^\d{4}$/.test(value) ? value : undefined;
}

/** `member`: người đã có trong phòng hoặc chủ phòng, không bị hỏi PIN. */
export function mayEnter(access: Access, pin: unknown, member: boolean): boolean {
  return member || access.pin === null || pin === access.pin;
}

/** Lỗi khi vào phòng có khóa: trình duyệt hỏi PIN rồi nối lại, không coi là phòng đã đóng. */
export function needsPin(code: string | null): code is "pin" | "pin-wait" {
  return code === "pin" || code === "pin-wait";
}

/** Địa chỉ mạng server gắn vào socket lúc nhận kết nối. Không có thì không đếm sai PIN. */
export function socketIp(ws: unknown): string | null {
  const ip = (ws as { ip?: unknown }).ip;
  return typeof ip === "string" && ip ? ip : null;
}

/** Đếm lần nhập sai PIN theo địa chỉ mạng: quá 10 lần trong 10 phút thì chặn, để không ai dò ra PIN. */
export class PinGuard {
  private misses = new Map<string, number[]>();

  blocked(ip: string, now: number): boolean {
    return this.recent(ip, now).length >= PIN_TRIES;
  }

  miss(ip: string, now: number): void {
    this.misses.set(ip, [...this.recent(ip, now), now]);
  }

  private recent(ip: string, now: number): number[] {
    const kept = (this.misses.get(ip) ?? []).filter((at) => now - at < PIN_WINDOW_MS);
    if (kept.length > 0) this.misses.set(ip, kept);
    else this.misses.delete(ip);
    return kept;
  }
}

/** Mọi phòng trên cùng một server dùng chung bộ đếm, nên dò PIN ở phòng này cũng bị tính khi sang phòng khác. */
export const pinGuard = new PinGuard();

/** Danh sách cho thị trấn: chỉ phòng đang hiện; phòng chờ trước, đông người trước, mới mở trước; tối đa 50. */
export function lobbyList(reports: RoomReport[]): RoomSummary[] {
  return reports
    .filter((report) => report.listed)
    .sort((a, b) => Number(a.status === "playing") - Number(b.status === "playing") || b.players - a.players || b.createdAt - a.createdAt)
    .slice(0, LOBBY_LIMIT)
    .map(({ code, hostName, players, maxPlayers, status, locked }) => ({ code, hostName, players, maxPlayers, status, locked }));
}

/** Mở phòng gửi kèm `Authorization: Bearer <mã đăng nhập>`. */
export function bearerToken(header: string | null | undefined): string {
  return /^Bearer (\S+)$/.exec(header ?? "")?.[1] ?? "";
}
