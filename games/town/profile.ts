// Hồ sơ trong thị trấn của mỗi tài khoản: tên, ngày sinh, nhân vật. Lưu ở bảng town_profiles của Supabase
// (hoặc trong máy với tài khoản thử). Thuần để test được.

import { cleanLook, starterLook, type Look } from "../ma-soi/look.ts";

export type TownProfile = { name: string; birthDate: string; look: Look };

export const MAX_NAME_LENGTH = 20;

/**
 * Tên hiện trên đầu nhân vật: bỏ khoảng trắng hai đầu, tối đa 20 ký tự như bảng town_profiles.
 * Đổi về dạng dựng sẵn (NFC) trước khi đếm, vì bộ gõ kiểu tổ hợp tách dấu thành ký tự riêng làm tên dài ra;
 * cắt theo ký tự để không làm vỡ emoji.
 */
export function cleanTownName(name: string): string {
  return Array.from(name.normalize("NFC").trim()).slice(0, MAX_NAME_LENGTH).join("").trim();
}

/**
 * Dòng town_profiles thành hồ sơ. Bảng đã tự kiểm tra dữ liệu, nhưng lỡ có phần hỏng thì vẫn vào được thị trấn:
 * nhân vật hỏng thì thay bằng nhân vật mới, tên rỗng thì gọi là Khách. Ngày sinh để nguyên, sai thì coi như chưa đủ tuổi.
 */
export function profileFromRow(row: unknown): TownProfile | null {
  if (typeof row !== "object" || row === null) return null;
  const { town_name, birth_date, look } = row as Record<string, unknown>;
  return {
    name: (typeof town_name === "string" && cleanTownName(town_name)) || "Khách",
    birthDate: typeof birth_date === "string" ? birth_date : "",
    look: cleanLook(look) ?? starterLook(),
  };
}
