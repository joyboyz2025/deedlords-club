import { thump, tone } from "@/lib/sound";

// Chỉ có tiếng chung cho cả làng. Không có tiếng riêng theo vai, vì ngồi chung phòng thì tiếng đó sẽ lộ vai.
export const sound = {
  /** Cồng trầm khi trời tối. */
  night() {
    tone(98, 0, 2.4, "sine", 0.5);
    tone(196, 0, 1.6, "sine", 0.22);
    tone(147, 0.04, 2, "triangle", 0.14);
  },
  /** Tiếng mõ làng khi trời sáng. */
  day() {
    for (const at of [0, 0.22, 0.44]) {
      tone(620, at, 0.09, "triangle", 0.34);
      tone(980, at, 0.05, "sine", 0.12);
      thump(at, 0.03, 0.14, 2500);
    }
  },
  death() {
    tone(70, 0, 0.5, "sine", 0.55);
    thump(0, 0.14, 0.32, 500);
  },
  tap() {
    tone(420, 0, 0.05, "triangle", 0.16);
  },
  win() {
    [392, 440, 523, 587, 659, 784].forEach((frequency, i) => {
      tone(frequency, i * 0.13, 0.3, "triangle", 0.24);
      tone(frequency / 2, i * 0.13, 0.3, "sine", 0.14);
    });
    for (const frequency of [523, 659, 784]) tone(frequency, 0.8, 1.2, "triangle", 0.12);
  },
};
