// Danh mục đồ của thị trấn: giá, luật rương, chỉ số từng món. Thuần: server, trình duyệt, test và lệnh sinh SQL dùng chung.
// Cấp của từng món ghi ở LOOK_CHOICES (games/ma-soi/look.ts), vì phòng Ma Sói cũng cần biết khách được chọn món nào.
// Đổi giá, tỉ lệ hay món Chăm học ở đây thì chạy `npm run catalog:sql` rồi chạy lại supabase/town/0003_town_catalog.sql trên Supabase.
// Rương kho báu trong code vẫn gọi là chest (bảng town_chests); chữ người chơi thấy là "rương".

import { ITEM_PARTS, LOOK_CHOICES, isItemPart, itemId, rarityOf, type ItemPart, type Look, type LookPart, type Rarity } from "../ma-soi/look.ts";

/** Giá mỗi món Hiếm ở Tiệm may (quần áo, phụ kiện, kiểu tóc). Đồ Quý, Cực quý, thú cưng, xe không bán, chỉ ra từ rương. */
export const RARE_PRICE = 300;
/**
 * Rương kho báu: quay cấp rồi chọn đều một món mình chưa có trong cấp đó.
 * - đã mở đủ `ultraPity - 1` rương và không rương nào trong số đó ra Cực quý thì rương này chắc chắn Cực quý;
 * - không thì đã mở đủ `pity - 1` rương và rương nào cũng ra Hiếm thì rương này ra Quý;
 * - không thì Cực quý `ultraChance`, Quý `preciousChance`, còn lại Hiếm.
 * Quay ra cấp mình đã có hết đồ thì nhận xu thay cho món đồ: Cực quý `ultraDuplicateCoins`, cấp khác `duplicateCoins`.
 */
export const CHEST_RULES = { preciousChance: 0.15, ultraChance: 0.02, pity: 10, ultraPity: 50, duplicateCoins: 300, ultraDuplicateCoins: 1000 } as const;
/** Chăm học: đang mặc món Chăm học thì xu học nhân với số này, mặc hai món vẫn chỉ một lần. */
export const STUDY_BONUS = 1.1;
/** Kéo camera ra xa tối đa chừng này lần khi không đeo kính nhìn xa. */
export const BASE_REACH = 1.5;

export const RARITY_NAMES: Record<Rarity, string> = { 0: "Cơ bản", 1: "Hiếm", 2: "Quý", 3: "Cực quý" };
/** Viền bảng tên theo món có cấp cao nhất đang dùng; đồ Cơ bản không viền. */
export const RIM_COLORS: Record<Rarity, string | null> = { 0: null, 1: "#4aa8ff", 2: "#ffcf3a", 3: "#c27bff" };

export type Gesture = "wave" | "raise";
/** Trò của thú cưng khi bấm Dùng; cảnh thị trấn vẽ theo tên trò. */
export type Trick = "pounce" | "spin" | "crow" | "waddle" | "roll" | "fire" | "circle" | "shake" | "shell";
export type Item = { id: string; part: ItemPart; index: number; name: string; rarity: Rarity; price: number | null };

/** Thú cưng và xe chỉ ra từ rương: không bán, dù là đồ Hiếm. */
const CHEST_ONLY: ReadonlySet<ItemPart> = new Set<ItemPart>(["pet", "ride"]);

/** Mọi món của các nhóm có cấp, kể cả các ô "Không": Supabase cần biết món Cơ bản cũng có thật. */
export const ITEMS: readonly Item[] = ITEM_PARTS.flatMap((part) =>
  LOOK_CHOICES[part].map((choice, index): Item => {
    const rarity = rarityOf(part, index);
    return { id: itemId(part, index), part, index, name: choice.name, rarity, price: rarity === 1 && !CHEST_ONLY.has(part) ? RARE_PRICE : null };
  }),
);
const BY_ID = new Map(ITEMS.map((item) => [item.id, item]));

export function itemOf(id: string): Item | undefined {
  return BY_ID.get(id);
}

/** Mọi món Hiếm và Quý: bot và bài thử mặc được hết. */
export const ALL_ITEMS: ReadonlySet<string> = new Set(ITEMS.filter((item) => item.rarity > 0).map((item) => item.id));

/** Tiệm may bày đồ Hiếm, cả kiểu tóc Hiếm (bán), và đồ Quý (chỉ có trong rương); đồ Cơ bản, thú cưng, xe không bày. */
export function onShelf(item: Item): boolean {
  return item.rarity > 0 && !CHEST_ONLY.has(item.part);
}

/** Tốc độ đi bộ theo cấp của giày. Cơ bản như trước đây: góc này sang góc kia quảng trường khoảng 13 giây; Hiếm 11 giây; Quý 9,5 giây. */
const WALK_SPEED: Readonly<Record<number, number>> = { 0: 2.5, 1: 3, 2: 3.5 };
/** Tốc độ đi xe theo cấp của xe: Hiếm nhanh hơn đi bộ 40%, Quý 60%, Cực quý gấp đôi. Đang đi xe thì giày không có tác dụng. */
const RIDE_SPEED: Readonly<Record<number, number>> = { 1: 3.5, 2: 4, 3: 5 };
/** Giày patin: lướt, chân không bước. */
const SKATES = 4;
/** Kính nhìn xa (số thứ tự trong nhóm Trên mặt): kéo camera ra xa tối đa chừng này lần. */
const REACH: Readonly<Record<number, number>> = { 2: 1.8, 9: 2.1 };
/** Bấm Dùng thì đồ cầm tay vẫy, hay giơ lên. */
const WAVES = new Set([1, 3, 4, 7, 12, 13]);
const RAISES = new Set([2, 5, 6, 8, 9, 10, 11]);
/** Món Chăm học: Bộ đồ Học sinh, Kính tròn. */
const STUDIOUS = new Set(["outfit:10", "face:1"]);
/** Trò của từng thú cưng (số thứ tự trong nhóm Thú cưng) và chữ trên dòng chỉ số. */
const TRICKS: Readonly<Record<number, { trick: Trick; text: string }>> = {
  1: { trick: "pounce", text: "nhảy vồ" },
  2: { trick: "spin", text: "quay vòng đuổi đuôi" },
  3: { trick: "crow", text: "vỗ cánh, nhảy lên gáy" },
  4: { trick: "waddle", text: "lạch bạch nhún nhảy" },
  5: { trick: "roll", text: "lăn một vòng" },
  6: { trick: "fire", text: "phun một luồng lửa nhỏ" },
  7: { trick: "circle", text: "bay một vòng quanh chủ" },
  8: { trick: "shake", text: "lắc đầu múa lân" },
  9: { trick: "shell", text: "rụt vào mai rồi xoay tròn" },
};

export function walkSpeed(look: Look): number {
  const ride = look.ride ?? 0;
  return ride > 0 ? RIDE_SPEED[rarityOf("ride", ride)] : WALK_SPEED[rarityOf("shoes", look.shoes ?? 0)];
}

export function glides(look: Look): boolean {
  // Đang đi xe thì ngồi, đứng trên xe chứ không lướt bằng giày.
  return look.shoes === SKATES && (look.ride ?? 0) === 0;
}

export function zoomReach(look: Look): number {
  return REACH[look.face] ?? BASE_REACH;
}

export function gestureOf(look: Look): Gesture | null {
  return WAVES.has(look.held) ? "wave" : RAISES.has(look.held) ? "raise" : null;
}

export function trickOf(look: Look): Trick | null {
  return TRICKS[look.pet ?? 0]?.trick ?? null;
}

/** Cấp cao nhất trong những món đang mặc, để tô viền bảng tên. */
export function topRarity(look: Look): Rarity {
  return ITEM_PARTS.reduce<Rarity>((top, part) => Math.max(top, rarityOf(part, look[part] ?? 0)) as Rarity, 0);
}

export function isStudiousItem(id: string): boolean {
  return STUDIOUS.has(id);
}

export function isStudious(look: Look): boolean {
  return ITEM_PARTS.some((part) => STUDIOUS.has(itemId(part, look[part] ?? 0)));
}

/** Dòng chỉ số của một món trong Túi đồ và trên kệ Tiệm may; `null` là không có. Mỗi món có nhiều nhất một chỉ số. */
export function statLine(part: LookPart, index: number): string | null {
  if (!isItemPart(part)) return null;
  const more = (ratio: number) => `${Math.round((ratio - 1) * 100)}%`;
  if (part === "ride" && index > 0) {
    const ratio = RIDE_SPEED[rarityOf(part, index)] / WALK_SPEED[0];
    return ratio === 2 ? "Đi nhanh gấp đôi" : `Đi nhanh hơn ${more(ratio)}`;
  }
  if (part === "pet" && TRICKS[index]) return `Bấm Dùng: ${TRICKS[index].text}`;
  if (part === "shoes" && rarityOf(part, index) > 0) {
    const faster = more(WALK_SPEED[rarityOf(part, index)] / WALK_SPEED[0]);
    return index === SKATES ? `Lướt nhanh hơn ${faster}` : `Đi nhanh hơn ${faster}`;
  }
  if (part === "face" && REACH[index]) return `Nhìn xa hơn ${more(REACH[index] / BASE_REACH)}`;
  if (part === "held" && WAVES.has(index)) return "Bấm Dùng để vẫy";
  if (part === "held" && RAISES.has(index)) return "Bấm Dùng để giơ lên";
  if (STUDIOUS.has(itemId(part, index))) return `Chăm học: thêm ${more(STUDY_BONUS)} xu khi học`;
  return null;
}
