// Bỏ I, O, 0, 1 để đọc mã phòng qua miệng không nhầm.
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const ALPHABET = `${LETTERS}23456789`;
const CODE_LENGTH = 4;

/**
 * Phòng ở server 1 mở đầu bằng chữ, phòng ở server 2 mở đầu bằng số 2.
 * Nhờ vậy người vào sau chỉ cần mã phòng, không phải biết hay chọn server.
 */
export function randomCode(server: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]);
  chars[0] = server === 2 ? "2" : LETTERS[bytes[0] % LETTERS.length];
  return chars.join("");
}

export function serverOfCode(code: string): number {
  return code.startsWith("2") ? 2 : 1;
}
