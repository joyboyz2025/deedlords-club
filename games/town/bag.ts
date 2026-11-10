// Túi đồ và rương kho báu ở trình duyệt, phần thuần để test được. Luật thật nằm ở Supabase (0004_town_items.sql, 0006_town_pets_rides.sql):
// ở đây đọc kết quả, viết ra chữ, và chạy lại đúng luật đó cho tài khoản thử, vì tài khoản thử không có Supabase.
// Trong code rương vẫn gọi là chest; chữ người chơi thấy là "rương".

import { ITEM_PARTS, itemId, type Look } from "../ma-soi/look.ts";
import { CHEST_RULES, ITEMS, itemOf } from "./items.ts";

/** Một rương chưa mở. `reason`: `bai:<mã bài>` khi xong một bài, `thu:<số>` với rương thử. */
export type Chest = { id: number; reason: string };
/** Cấp quay ra từ rương: Hiếm, Quý hoặc Cực quý. */
export type ChestRarity = 1 | 2 | 3;
/** Kết quả mở rương: cấp quay ra; món ra, hoặc `null` khi đã có hết đồ cấp đó và nhận `coins` xu thay; số dư sau khi mở. */
export type ChestResult = { rarity: ChestRarity; item: string | null; coins: number; balance: number };
/** Số bài và tên khóa học theo mã bài, đọc ở app HSK. */
export type LessonNames = ReadonlyMap<string, { number: number; course: string }>;
/** Túi đồ, rương của tài khoản thử. `opened`: cấp của các rương mở gần nhất, để tính hai luật chắc chắn ra như Supabase. */
export type DevBag = { items: string[]; chests: Chest[]; opened: ChestRarity[]; nextId: number };

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const isChestRarity = (value: unknown): value is ChestRarity => value === 1 || value === 2 || value === 3;
const percent = (chance: number) => Math.round(chance * 100);

/** Dòng tỉ lệ ghi công khai trên màn mở rương. */
export const CHEST_ODDS = [
  `Hiếm ${100 - percent(CHEST_RULES.preciousChance) - percent(CHEST_RULES.ultraChance)}%`,
  `Quý ${percent(CHEST_RULES.preciousChance)}%`,
  `Cực quý ${percent(CHEST_RULES.ultraChance)}%`,
  `${CHEST_RULES.pity - 1} rương liền chỉ ra Hiếm thì rương thứ ${CHEST_RULES.pity} ít nhất ra Quý`,
  `${CHEST_RULES.ultraPity - 1} rương liền không ra Cực quý thì rương thứ ${CHEST_RULES.ultraPity} chắc chắn ra Cực quý`,
].join(" · ");

/** Mã các món Hiếm, Quý có thật, mỗi món một lần; bỏ mọi thứ khác (bản lưu hỏng, đồ Cơ bản). */
export function cleanItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === "string" && (itemOf(id)?.rarity ?? 0) > 0))];
}

/**
 * Túi đồ đọc ở Supabase, cộng các món đang mặc. Sau khi khóa đồ, món đang mặc luôn có trong túi;
 * còn nếu đọc túi lỗi thì người chơi vẫn không bị lột mất đồ đang mặc khi bấm "Mặc bộ này".
 */
export function bagItems(rows: unknown, look: Look): string[] {
  const read = Array.isArray(rows) ? rows.map((row) => (row as { item?: unknown } | null)?.item) : [];
  return cleanItems([...read, ...ITEM_PARTS.map((part) => itemId(part, look[part] ?? 0))]);
}

export function chestsFromRows(rows: unknown): Chest[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const { id, reason } = (row ?? {}) as Record<string, unknown>;
    return Number.isInteger(id) && typeof reason === "string" ? [{ id: id as number, reason }] : [];
  });
}

/** Kết quả của town_open_chest. Sai kiểu thì `null`: máy coi như chưa mở được và đọc lại rương, túi đồ, số xu. */
export function parseChestResult(data: unknown): ChestResult | null {
  if (typeof data !== "object" || data === null) return null;
  const { rarity, item, coins, balance } = data as Record<string, unknown>;
  if (!isChestRarity(rarity)) return null;
  if (item !== null && !(typeof item === "string" && itemOf(item)?.rarity === rarity)) return null;
  if (!isCount(coins) || !isCount(balance) || (item === null) === (coins === 0)) return null;
  return { rarity, item, coins, balance };
}

/** Mã bài của rương, để đọc tên bài ở app HSK. */
export function lessonOf(reason: string): string | null {
  return reason.startsWith("bai:") && reason.length > 4 ? reason.slice(4) : null;
}

/** Dòng lessons kèm tên khóa (`select("id, number, courses(title)")`) thành bảng tên bài. */
export function lessonNamesFromRows(rows: unknown): Map<string, { number: number; course: string }> {
  const names = new Map<string, { number: number; course: string }>();
  if (!Array.isArray(rows)) return names;
  for (const row of rows) {
    const { id, number, courses } = (row ?? {}) as Record<string, unknown>;
    const course = (courses as { title?: unknown } | null)?.title;
    if (typeof id === "string" && Number.isInteger(number) && typeof course === "string") names.set(id, { number: number as number, course });
  }
  return names;
}

/** "Xong bài 12, HSK 1". Chưa đọc được tên bài thì ghi chung chung. */
export function chestLabel(reason: string, names: LessonNames): string {
  if (reason.startsWith("thu:")) return "Rương thử";
  const lesson = lessonOf(reason);
  const name = lesson ? names.get(lesson) : undefined;
  return name ? `Xong bài ${name.number}, ${name.course}` : "Xong một bài học";
}

/** Câu báo khi mua không được, theo mã lỗi của town_buy. */
export function buyProblem(message: string | undefined): string {
  if (message?.includes("da-co")) return "Bạn đã có món này rồi.";
  if (message?.includes("thieu-xu")) return "Chưa đủ xu.";
  if (message?.includes("khong-ban")) return "Món này không bán.";
  return "Chưa mua được, thử lại sau một lát.";
}

/** Quay rương đúng luật của town_open_chest (0006): luật 50 rương, rồi luật 10 rương, rồi tỉ lệ; trong cấp đó chọn đều một món chưa có. */
export function rollChest(owned: ReadonlySet<string>, opened: readonly ChestRarity[], random: () => number): { rarity: ChestRarity; item: string | null } {
  const long = opened.slice(-(CHEST_RULES.ultraPity - 1));
  const recent = opened.slice(-(CHEST_RULES.pity - 1));
  const roll = random();
  const rarity: ChestRarity =
    long.length === CHEST_RULES.ultraPity - 1 && long.every((r) => r < 3)
      ? 3
      : recent.length === CHEST_RULES.pity - 1 && recent.every((r) => r === 1)
        ? 2
        : roll < CHEST_RULES.ultraChance
          ? 3
          : roll < CHEST_RULES.ultraChance + CHEST_RULES.preciousChance
            ? 2
            : 1;
  const left = ITEMS.filter((item) => item.rarity === rarity && !owned.has(item.id));
  return { rarity, item: left.length > 0 ? left[Math.floor(random() * left.length)].id : null };
}

export const EMPTY_DEV_BAG: DevBag = { items: [], chests: [], opened: [], nextId: 1 };

/** Bản lưu trong máy của tài khoản thử; hỏng phần nào thì bỏ phần đó. */
export function cleanDevBag(value: unknown): DevBag {
  if (typeof value !== "object" || value === null) return EMPTY_DEV_BAG;
  const { items, chests, opened, nextId } = value as Record<string, unknown>;
  const list = chestsFromRows(chests);
  const rarities = Array.isArray(opened) ? opened.filter(isChestRarity).slice(-CHEST_RULES.ultraPity) : [];
  const next = Number.isInteger(nextId) && (nextId as number) > 0 ? (nextId as number) : 1;
  return { items: cleanItems(items), chests: list, opened: rarities, nextId: Math.max(next, ...list.map((chest) => chest.id + 1)) };
}

/** Nút "Thêm rương thử". */
export function devAddChest(bag: DevBag): DevBag {
  return { ...bag, chests: [...bag.chests, { id: bag.nextId, reason: `thu:${bag.nextId}` }], nextId: bag.nextId + 1 };
}

/** Mua như town_buy, cho tài khoản thử. */
export function devBuy(bag: DevBag, balance: number, id: string): { bag: DevBag; balance: number } | { problem: string } {
  const price = itemOf(id)?.price;
  if (!price) return { problem: buyProblem("khong-ban") };
  if (bag.items.includes(id)) return { problem: buyProblem("da-co") };
  if (balance < price) return { problem: buyProblem("thieu-xu") };
  return { bag: { ...bag, items: [...bag.items, id] }, balance: balance - price };
}

/** Mở rương như town_open_chest, cho tài khoản thử. Không có rương này thì `null`. */
export function devOpen(bag: DevBag, balance: number, id: number, random: () => number): { bag: DevBag; result: ChestResult } | null {
  if (!bag.chests.some((chest) => chest.id === id)) return null;
  const { rarity, item } = rollChest(new Set(bag.items), bag.opened, random);
  const coins = item ? 0 : rarity === 3 ? CHEST_RULES.ultraDuplicateCoins : CHEST_RULES.duplicateCoins;
  return {
    bag: {
      ...bag,
      items: item ? [...bag.items, item] : bag.items,
      chests: bag.chests.filter((chest) => chest.id !== id),
      opened: [...bag.opened, rarity].slice(-CHEST_RULES.ultraPity),
    },
    result: { rarity, item, coins, balance: balance + coins },
  };
}
