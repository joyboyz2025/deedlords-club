// Nhân vật mỗi người tự chọn khi vào phòng. Chỉ là số thứ tự trỏ vào các bảng dưới đây,
// nên server chỉ cần kiểm tra số có nằm trong bảng không. File này không đụng tới Three.js vì server cũng dùng.
// Chỉ được đổi trong phòng chờ, lúc chưa ai có vai, nên phụ kiện không thể là ám hiệu giữa ván.
// Đồ (quần áo, phụ kiện, giày, thú cưng, xe, kiểu tóc) có bốn cấp: Cơ bản ai cũng có; Hiếm, Quý, Cực quý phải mua ở Tiệm may hoặc mở rương kho báu trong thị trấn. Giá và chỉ số ở games/town/items.ts.

export type Look = {
  body: number;
  skin: number;
  hair: number;
  hairColor: number;
  outfit: number;
  robe: number;
  neck: number;
  hat: number;
  face: number;
  held: number;
  /** Có sau cùng: bộ đồ lưu từ trước không có giày thì là 0, đi giày của bộ đồ. */
  shoes: number;
  /** Thú cưng đi theo, chỉ có trong thị trấn. Có sau giày: bộ đồ lưu từ trước không có thì là 0, không có thú cưng. */
  pet: number;
  /** Xe để đi lại, chỉ có trong thị trấn. Có sau giày: bộ đồ lưu từ trước không có thì là 0, đi bộ. */
  ride: number;
};

export type LookPart = keyof Look;
/** 0 Cơ bản, 1 Hiếm, 2 Quý, 3 Cực quý. */
export type Rarity = 0 | 1 | 2 | 3;
export type LookChoice = {
  name: string;
  color?: string;
  accent?: string;
  /** Bộ đồ có màu riêng, không dùng màu áo người chơi chọn. */
  fixed?: boolean;
  /** Đồ Hiếm (1), Quý (2) hoặc Cực quý (3); không ghi là Cơ bản. */
  rarity?: 1 | 2 | 3;
};

/** Chỉ thêm vào cuối bảng: phòng đang chơi, máy người chơi và túi đồ ở Supabase đã lưu số thứ tự cũ. Số 0 của phụ kiện là không dùng. */
export const LOOK_CHOICES: Record<LookPart, LookChoice[]> = {
  body: [{ name: "Nam" }, { name: "Nữ" }],
  skin: [
    { name: "Trắng hồng", color: "#ffe0c4" },
    { name: "Trung bình", color: "#f6cda3" },
    { name: "Bánh mật", color: "#e0a878" },
    { name: "Nâu", color: "#b97c50" },
    { name: "Nâu đậm", color: "#86573a" },
  ],
  hair: [
    { name: "Trái đào" },
    { name: "Búi tó" },
    { name: "Tóc ngắn" },
    { name: "Hai búi" },
    { name: "Tóc dài" },
    { name: "Đuôi ngựa" },
    { name: "Đầu trọc" },
    { name: "Hai bím" },
    { name: "Tóc bob" },
    { name: "Tóc dựng" },
    { name: "Tóc xoăn" },
    { name: "Mái bằng" },
    { name: "Hai đuôi" },
    { name: "Mái lệch" },
    { name: "Chẻ ngôi" },
    { name: "Tóc sói" },
    { name: "Tóc nấm" },
    { name: "Ngôi giữa" },
    { name: "Búi củ tỏi" },
    { name: "Xoăn sóng" },
    { name: "Xoắn ốc", rarity: 1 },
    { name: "Mào gà", rarity: 1 },
    { name: "Tóc lửa", rarity: 1 },
    { name: "Vấn tóc", rarity: 1 },
    { name: "Phi tiên", rarity: 1 },
    { name: "Xù bông", rarity: 1 },
  ],
  hairColor: [
    { name: "Đen", color: "#2a1d17" },
    { name: "Nâu", color: "#5a3a22" },
    { name: "Hạt dẻ", color: "#8e4b28" },
    { name: "Vàng", color: "#d6a13c" },
    { name: "Bạc", color: "#c9c6c0" },
    { name: "Hồng", color: "#d9668c" },
    { name: "Xanh", color: "#3d6fb0" },
  ],
  outfit: [
    { name: "Áo thường" },
    { name: "Áo dài" },
    { name: "Áo tứ thân", fixed: true },
    { name: "Áo bà ba" },
    { name: "Áo the", fixed: true },
    { name: "Long bào", fixed: true, rarity: 2 },
    { name: "Phượng bào", fixed: true, rarity: 2 },
    { name: "Giáp tướng", fixed: true, rarity: 2 },
    { name: "Cà sa", fixed: true },
    { name: "Nông dân", fixed: true },
    { name: "Học sinh", fixed: true, rarity: 1 },
    { name: "Cổ động viên", fixed: true },
    { name: "Cướp biển", fixed: true, rarity: 1 },
    { name: "Ninja", fixed: true, rarity: 1 },
    { name: "Phù thủy", fixed: true, rarity: 1 },
    { name: "Siêu nhân", fixed: true, rarity: 1 },
    { name: "Đồ ngủ" },
    { name: "Áo mưa" },
    { name: "Hanbok", rarity: 1 },
    { name: "Kimono", rarity: 1 },
    { name: "Tiên nữ", rarity: 1 },
    { name: "Ông Địa", fixed: true, rarity: 2 },
  ],
  // Màu lấy từ tranh Đông Hồ, cộng thêm vài màu để phân biệt được 40 người.
  robe: [
    { name: "Vàng hòe", color: "#edb92e", accent: "#c8321e" },
    { name: "Đỏ son", color: "#c8321e", accent: "#edb92e" },
    { name: "Xanh lá", color: "#3f7a4d", accent: "#edb92e" },
    { name: "Chàm", color: "#3d4f9e", accent: "#f4ebd6" },
    { name: "Giấy điệp", color: "#f4ebd6", accent: "#c8321e" },
    { name: "Hồng đào", color: "#e58aa0", accent: "#7a2f4a" },
    { name: "Cam", color: "#e07b2e", accent: "#3f2410" },
    { name: "Tím", color: "#7b5aa6", accent: "#edb92e" },
  ],
  neck: [
    { name: "Không" },
    { name: "Khăn quàng" },
    { name: "Chuỗi hạt" },
    { name: "Yếm" },
    { name: "Áo choàng", rarity: 1 },
    { name: "Khăn rằn" },
    { name: "Khăn đỏ" },
    { name: "Vòng bạc", rarity: 1 },
    { name: "Nơ cổ" },
    { name: "Cánh tiên", rarity: 2 },
    { name: "Cánh dơi", rarity: 2 },
  ],
  hat: [
    { name: "Không" },
    { name: "Nón lá" },
    { name: "Khăn đóng" },
    { name: "Quai thao" },
    { name: "Mũ rơm" },
    { name: "Vòng hoa" },
    { name: "Cánh chuồn", rarity: 1 },
    { name: "Băng đỏ" },
    { name: "Khăn mỏ quạ" },
    { name: "Khăn vấn" },
    { name: "Mũ vua", rarity: 2 },
    { name: "Mũ phượng", rarity: 2 },
    { name: "Mũ tướng", rarity: 1 },
    { name: "Mũ cối" },
    { name: "Mũ bảo hiểm" },
    { name: "Mũ cướp biển", rarity: 1 },
    { name: "Mũ phù thủy", rarity: 1 },
    { name: "Mũ ngủ" },
    { name: "Khăn ninja", rarity: 1 },
    { name: "Tai thỏ", rarity: 1 },
    { name: "Sừng quỷ", rarity: 1 },
    { name: "Hoa cài" },
  ],
  face: [
    { name: "Không" },
    { name: "Kính tròn", rarity: 1 },
    { name: "Kính râm", rarity: 1 },
    { name: "Bịt một mắt" },
    { name: "Ria mép" },
    { name: "Râu dài" },
    { name: "Khẩu trang" },
    { name: "Râu quai nón" },
    { name: "Mũi hề" },
    { name: "Kính phi công", rarity: 2 },
  ],
  held: [
    { name: "Không" },
    { name: "Quạt giấy" },
    { name: "Đèn lồng" },
    { name: "Cành đào" },
    { name: "Gậy trúc" },
    { name: "Trà đá" },
    { name: "Kiếm", rarity: 1 },
    { name: "Hoa sen" },
    { name: "Bánh mì" },
    { name: "Mõ" },
    { name: "Đàn nguyệt", rarity: 1 },
    { name: "Điện thoại" },
    { name: "Gậy phép", rarity: 2 },
    { name: "Cờ hội", rarity: 1 },
  ],
  shoes: [{ name: "Theo bộ đồ" }, { name: "Dép tổ ong" }, { name: "Guốc mộc" }, { name: "Giày thể thao", rarity: 1 }, { name: "Giày patin", rarity: 2 }],
  // Thú cưng và xe chỉ có trong thị trấn, chỉ ra từ rương kho báu.
  pet: [
    { name: "Không" },
    { name: "Mèo mướp", rarity: 1 },
    { name: "Chó vàng", rarity: 1 },
    { name: "Gà trống", rarity: 1 },
    { name: "Vịt con", rarity: 1 },
    { name: "Heo ỉ", rarity: 1 },
    { name: "Rồng con", rarity: 2 },
    { name: "Phượng con", rarity: 2 },
    { name: "Lân con", rarity: 2 },
    { name: "Rùa vàng", rarity: 2 },
  ],
  ride: [
    { name: "Không" },
    { name: "Xe đạp", rarity: 1 },
    { name: "Ván trượt", rarity: 1 },
    { name: "Xe máy", rarity: 2 },
    { name: "Trâu", rarity: 2 },
    { name: "Ngựa", rarity: 2 },
    { name: "Siêu xe", rarity: 3 },
    { name: "Thảm bay", rarity: 3 },
    { name: "Mây ngũ sắc", rarity: 3 },
  ],
};

const LOOK_PARTS = Object.keys(LOOK_CHOICES) as LookPart[];
/** Các nhóm có cấp. Giới tính, màu da, màu tóc và màu áo luôn miễn phí. Kiểu tóc có cấp từ đợt tóc mới (5/11/2026), nối cuối bảng. */
export const ITEM_PARTS = ["outfit", "neck", "hat", "face", "held", "shoes", "pet", "ride", "hair"] as const;
export type ItemPart = (typeof ITEM_PARTS)[number];
/** Thú cưng và xe chỉ có trong thị trấn: phòng game không vẽ; bốc ngẫu nhiên ngoài thị trấn không bốc. */
export const TOWN_ONLY: readonly LookPart[] = ["pet", "ride"];
/** Các nhóm thêm sau cùng: bộ đồ lưu từ trước thiếu thì coi là 0. */
const LATE_PARTS: readonly LookPart[] = ["shoes", "pet", "ride"];
/** Phụ kiện, giày, thú cưng, xe chỉ có một nửa số lần khi bốc ngẫu nhiên, không thì ai cũng đeo đủ thứ. */
const OPTIONAL: LookPart[] = ["neck", "hat", "face", "held", "shoes", "pet", "ride"];
/** Chưa có món Hiếm, Quý nào: khách trong phòng game, người mới. */
export const NO_ITEMS: ReadonlySet<string> = new Set();
/** Ria mép, râu dài, râu quai nón: nữ vẫn tự chọn được, chỉ là không bốc ngẫu nhiên ra. */
const BEARDS = [4, 5, 7];
const NATURAL_HAIR_COLORS = 3;

export function isItemPart(part: LookPart): part is ItemPart {
  return (ITEM_PARTS as readonly string[]).includes(part);
}

/** Mã một món: `outfit:5` là Long bào. Túi đồ ở Supabase lưu theo mã này. */
export function itemId(part: ItemPart, index: number): string {
  return `${part}:${index}`;
}

export function rarityOf(part: LookPart, index: number): Rarity {
  return (isItemPart(part) && LOOK_CHOICES[part][index]?.rarity) || 0;
}

/** Đồ Cơ bản ai cũng mặc được; đồ Hiếm, Quý phải có trong túi. `owned` là mã các món Hiếm, Quý đang có. */
export function canWear(part: LookPart, index: number, owned: ReadonlySet<string>): boolean {
  return rarityOf(part, index) === 0 || owned.has(itemId(part as ItemPart, index));
}

/** Tóc Hiếm chưa có đổi về kiểu thường hợp giới tính, không về số 0 (Trái đào): Tóc ngắn cho nam, Tóc dài cho nữ. */
const PLAIN_HAIR: Readonly<Record<number, number>> = { 0: 2, 1: 4 };

/** Đưa bộ đồ về những món mặc được: món chưa có đổi về số 0 của nhóm (Áo thường, Không, giày theo bộ đồ); tóc thì về PLAIN_HAIR. */
export function fitLook(look: Look, owned: ReadonlySet<string>): Look {
  const fitted = { ...look };
  for (const part of ITEM_PARTS) {
    if (!canWear(part, fitted[part] ?? 0, owned)) fitted[part] = part === "hair" ? (PLAIN_HAIR[fitted.body] ?? 2) : 0;
  }
  return fitted;
}

/** Kiểu tóc và đồ đội đầu cho người chưa chọn gì, xếp xen kẽ để cả phòng không giống nhau: [hair, hat]. */
const SEAT_HEADS = [
  [0, 0],
  [1, 0],
  [2, 2],
  [2, 1],
  [2, 0],
  [3, 0],
];

/** Nhân vật mặc định theo thứ tự vào phòng. */
export function lookFromSeat(seat: number): Look {
  // Nhân với số nguyên tố để màu áo và kiểu tóc không lặp cùng nhịp.
  const [hair, hat] = SEAT_HEADS[(seat * 5) % SEAT_HEADS.length];
  return { body: seat % 2, skin: 1, hair, hairColor: 0, outfit: 0, robe: seat % LOOK_CHOICES.robe.length, neck: 0, hat, face: 0, held: 0, shoes: 0, pet: 0, ride: 0 };
}

/**
 * `body` là giới tính cần giữ nguyên, không truyền thì bốc luôn. Chỉ bốc trong những món mặc được; mặc định chỉ có đồ Cơ bản.
 * `town`: đang ở thị trấn thì bốc cả thú cưng, xe; ngoài thị trấn hai nhóm này luôn là 0.
 */
export function randomLook(body?: number, random: () => number = Math.random, owned: ReadonlySet<string> = NO_ITEMS, town = false): Look {
  const look = {} as Look;
  for (const part of LOOK_PARTS) {
    if (!town && TOWN_ONLY.includes(part)) {
      look[part] = 0;
      continue;
    }
    const choices = LOOK_CHOICES[part].flatMap((_, index) => (canWear(part, index, owned) ? [index] : []));
    const bare = OPTIONAL.includes(part) && random() < 0.5;
    look[part] = bare ? 0 : choices[Math.floor(random() * choices.length)];
  }
  if (body !== undefined) look.body = body;
  if (look.body === 1 && BEARDS.includes(look.face)) look.face = 0;
  return look;
}

/** Người mới vào lần đầu: một người bình thường mặc áo thường, rồi tự mặc thêm cho đúng ý. */
export function starterLook(random: () => number = Math.random): Look {
  return { ...randomLook(undefined, random), hairColor: Math.floor(random() * NATURAL_HAIR_COLORS), outfit: 0, neck: 0, hat: 0, face: 0, held: 0, shoes: 0, pet: 0, ride: 0 };
}

/** Trả về bản đã kiểm tra, hoặc `null` nếu có phần nào không hợp lệ. */
export function cleanLook(value: unknown): Look | null {
  if (typeof value !== "object" || value === null) return null;
  const look = {} as Look;
  for (const part of LOOK_PARTS) {
    const raw = (value as Record<string, unknown>)[part];
    // Giày, thú cưng, xe có sau cùng: bộ đồ lưu ở Supabase, trong máy hay trong phòng đang chơi từ trước đó không có.
    const choice = LATE_PARTS.includes(part) && raw === undefined ? 0 : raw;
    if (typeof choice !== "number" || !Number.isInteger(choice) || choice < 0 || choice >= LOOK_CHOICES[part].length) return null;
    look[part] = choice;
  }
  return look;
}

export function lookKey(look: Look): string {
  // Phòng lưu từ trước có thể còn bộ đồ chưa qua cleanLook, chưa có giày, thú cưng, xe.
  return LOOK_PARTS.map((part) => look[part] ?? 0).join(".");
}

/** Bộ đồ mang vào phòng game: bỏ thú cưng và xe, vì chỉ thị trấn mới có. */
export function roomLook(look: Look): Look {
  return { ...look, pet: 0, ride: 0 };
}
