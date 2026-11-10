// Nhóm thẻ và tên từng phần của tủ đồ: dùng chung cho tủ đồ của game (components/Wardrobe.tsx)
// và file vẽ nhân vật cho app HSK (games/town/chibi-catalog.ts). Thuần để test được.

import type { LookPart } from "./look.ts";

export type WardrobeTab = { title: string; parts: LookPart[] };

/** Ba thẻ của phòng game. */
export const ROOM_TABS: WardrobeTab[] = [
  { title: "Người", parts: ["body", "skin", "hair", "hairColor"] },
  { title: "Trang phục", parts: ["outfit", "robe", "neck", "shoes"] },
  { title: "Phụ kiện", parts: ["hat", "face", "held"] },
];
/** Chỉ ở thị trấn: thú cưng và xe. */
export const TOWN_TAB: WardrobeTab = { title: "Thú cưng & xe", parts: ["pet", "ride"] };
/** Các thẻ của tủ đồ thị trấn. */
export const WARDROBE_TABS: WardrobeTab[] = [...ROOM_TABS, TOWN_TAB];

export const PART_TITLES: Record<LookPart, string> = {
  body: "Giới tính",
  skin: "Màu da",
  hair: "Kiểu tóc",
  hairColor: "Màu tóc",
  outfit: "Bộ đồ",
  robe: "Màu áo",
  neck: "Cổ và lưng",
  hat: "Trên đầu",
  face: "Trên mặt",
  held: "Cầm tay",
  shoes: "Giày",
  pet: "Thú cưng",
  ride: "Xe",
};
