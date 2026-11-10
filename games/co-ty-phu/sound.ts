import { thump, tone } from "@/lib/sound";

export const sound = {
  /** Xúc xắc lăn trên mặt bàn. */
  dice() {
    for (const at of [0, 0.07, 0.15, 0.24, 0.34]) thump(at, 0.04, 0.35, 2200);
  },
  /** Xúc xắc trên bàn 3D chạm mặt nỉ trong mâm: tiếng cộp trầm, khác hẳn tiếng bước quân; `strength` nhỏ dần qua mỗi lần nảy. */
  hit(strength: number) {
    thump(0, 0.07, 0.32 * strength, 900);
    thump(0.015, 0.04, 0.14 * strength, 1500);
  },
  /** Nhà vừa xây mọc lên. */
  build() {
    tone(392, 0, 0.1, "triangle", 0.12);
    tone(523, 0.08, 0.1, "triangle", 0.12);
    tone(784, 0.16, 0.22, "triangle", 0.1);
  },
  /** Bước quân trên bàn. */
  step() {
    tone(520, 0, 0.04, "triangle", 0.08);
  },
  coin() {
    tone(1320, 0, 0.08, "triangle", 0.18);
    tone(1760, 0.07, 0.14, "triangle", 0.16);
  },
  /** Có người vừa mất tiền: tiếng đồng xu rơi leng keng đi xuống. */
  pay() {
    thump(0, 0.04, 0.12, 5000);
    tone(1568, 0, 0.07, "triangle", 0.14);
    tone(1175, 0.06, 0.07, "triangle", 0.13);
    tone(880, 0.12, 0.14, "triangle", 0.12);
  },
  card() {
    thump(0, 0.08, 0.25, 4000);
    tone(660, 0.05, 0.12, "sine", 0.12);
  },
  turn() {
    tone(587, 0, 0.12, "triangle", 0.16);
    tone(880, 0.1, 0.18, "triangle", 0.14);
  },
  end() {
    [523, 659, 784, 1046].forEach((frequency, i) => tone(frequency, i * 0.13, 0.35, "triangle", 0.2));
  },
};
