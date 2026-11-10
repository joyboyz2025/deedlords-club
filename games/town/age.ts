// Tuổi người chơi tính từ ngày sinh, theo giờ Việt Nam. Thuần, không phụ thuộc múi giờ của máy.
// Bản đầu chỉ dùng để đóng cửa casino với người dưới 18 tuổi; phần ví xu sau này sẽ có hàm SQL tính giống hệt cho server.

/** Việt Nam ở UTC+7 quanh năm, không đổi giờ mùa hè. */
const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;
export const ADULT_AGE = 18;
/** Ngày sinh sớm nhất nhận, giống ràng buộc của bảng town_profiles. */
const OLDEST = "1900-01-01";

type Day = { year: number; month: number; day: number };

const pad = (value: number) => String(value).padStart(2, "0");

/** Hôm nay ở Việt Nam. */
function vietnamToday(now: Date): Day {
  const shifted = new Date(now.getTime() + VIETNAM_OFFSET_MS);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/** Đọc ngày dạng `YYYY-MM-DD`. Ngày không có thật (30/2, 31/4, 29/2 năm không nhuận) thì trả `null`. */
export function parseBirthDate(text: string): Day | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day };
}

/** Ngày sinh có thật, từ 1/1/1900 tới hôm nay theo giờ Việt Nam. */
export function isValidBirthDate(text: string, now = new Date()): boolean {
  const today = vietnamToday(now);
  return parseBirthDate(text) !== null && text >= OLDEST && text <= `${today.year}-${pad(today.month)}-${pad(today.day)}`;
}

/**
 * Số tuổi tròn hôm nay, hoặc `null` nếu ngày sinh không hợp lệ. Tới đúng ngày sinh nhật mới thêm một tuổi.
 * So tháng trước rồi mới so ngày, nên người sinh 29/2 vào năm không nhuận được thêm tuổi từ 1/3.
 */
export function ageOn(birthDate: string, now = new Date()): number | null {
  const birth = parseBirthDate(birthDate);
  if (!birth || !isValidBirthDate(birthDate, now)) return null;
  const today = vietnamToday(now);
  const beforeBirthday = today.month < birth.month || (today.month === birth.month && today.day < birth.day);
  return today.year - birth.year - (beforeBirthday ? 1 : 0);
}

/** Đủ 18 tuổi. Thiếu hoặc sai ngày sinh thì coi như chưa đủ. */
export function isAdult(birthDate: string | null, now = new Date()): boolean {
  const age = birthDate === null ? null : ageOn(birthDate, now);
  return age !== null && age >= ADULT_AGE;
}
