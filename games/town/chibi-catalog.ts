// Phần thuần của file vẽ nhân vật cho app HSK (public/town/chibi-v1.js): danh mục món và các luật của thị trấn,
// xuất lại đúng code của thị trấn nên app HSK luôn khớp. Thuần để test được.
// Đổi tên hay kiểu của thứ gì ở đây thì ra chibi-v2.js, giữ v1 tới khi app HSK đổi theo.

export { ITEM_PARTS, LOOK_CHOICES, TOWN_ONLY, canWear, cleanLook, fitLook, itemId, lookKey, randomLook, rarityOf, starterLook } from "../ma-soi/look.ts";
export type { ItemPart, Look, LookChoice, LookPart, Rarity } from "../ma-soi/look.ts";
export { PART_TITLES, WARDROBE_TABS } from "../ma-soi/wardrobe-tabs.ts";
export { isValidBirthDate } from "./age.ts";
export { bagItems as ownedItems } from "./bag.ts";
export { RARITY_NAMES, RIM_COLORS, statLine } from "./items.ts";
export { MAX_NAME_LENGTH, cleanTownName } from "./profile.ts";

export const VERSION = 1;
