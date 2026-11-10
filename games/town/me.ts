// Tên, nhân vật và túi đồ trong thị trấn, chép vào máy để vào phòng game không phải nhập lại.
// Bản gốc ở Supabase (hoặc tài khoản thử); thị trấn chép lại mỗi lần mở, xóa khi chưa đăng nhập.

import { readStored, removeStored, writeStored } from "@/lib/storage";
import { cleanLook, roomLook, type Look } from "../ma-soi/look";
import { cleanItems } from "./bag";
import { cleanTownName } from "./profile";

/** `items`: mã các món Hiếm, Quý trong túi, để phòng Ma Sói cho chọn đúng những món đó. */
export type TownMe = { name: string; look: Look; items: string[] };

const KEY = "town:me";

export function loadTownMe(): TownMe | null {
  const stored = readStored<Partial<TownMe>>(KEY);
  const name = typeof stored?.name === "string" ? cleanTownName(stored.name) : "";
  const look = cleanLook(stored?.look);
  return name && look ? { name, look, items: cleanItems(stored?.items) } : null;
}

/** Chép cho phòng game: thú cưng, xe chỉ có trong thị trấn nên bỏ ra (Ma Sói, Cờ tỷ phú lấy bộ đồ ở đây). */
export function saveTownMe(me: TownMe): void {
  writeStored(KEY, { name: me.name, look: roomLook(me.look), items: me.items });
}

export function forgetTownMe(): void {
  removeStored(KEY);
}
