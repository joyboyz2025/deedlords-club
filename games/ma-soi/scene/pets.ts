// Hình 3D thú cưng trong thị trấn, dựng từ khối cơ bản như quần áo: mỗi con gộp thành một khối, đầu nhìn về phía +z.
// Con đi dưới đất đặt chân ở y = 0; con biết bay có tâm ở gốc tọa độ, cảnh thị trấn nâng lên ngang vai chủ.

import * as THREE from "three";
import { capsule, cylinder, merged, painted } from "./parts.ts";

type Parts = THREE.BufferGeometry[];
type At = [number, number, number];

/** `center`: độ cao tâm con vật, để lăn, xoay quanh tâm khi làm trò. `flies`: bay lơ lửng chứ không đi dưới đất. */
export type PetShape = { center: number; flies: boolean };

/** Theo số thứ tự trong nhóm Thú cưng của LOOK_CHOICES; số 0 là không có thú cưng. */
export const PET_SHAPES: Readonly<Record<number, PetShape>> = {
  1: { center: 0.2, flies: false },
  2: { center: 0.22, flies: false },
  3: { center: 0.26, flies: false },
  4: { center: 0.16, flies: false },
  5: { center: 0.22, flies: false },
  6: { center: 0, flies: true },
  7: { center: 0, flies: true },
  8: { center: 0.28, flies: false },
  9: { center: 0.13, flies: false },
};

const EYE = "#1b1712";
const GOLD = "#edb92e";
const RED = "#c8321e";
const CREAM = "#f4ebd6";

/** Khối tròn bóp méo, nghiêng quanh trục ngang (`tilt`) và trục dọc thân (`roll`) rồi mới đặt vào chỗ. */
function blob(radius: number, color: string, at: At, scale: At = [1, 1, 1], tilt = 0, roll = 0, detail = 8): THREE.BufferGeometry {
  return painted(new THREE.SphereGeometry(radius, detail, Math.max(5, detail - 2)).scale(...scale).rotateX(tilt).rotateZ(roll).translate(...at), color);
}

/** Hai mắt đen nhìn về phía trước. */
function eyes(x: number, y: number, z: number, size = 0.022): Parts {
  return [blob(size, EYE, [-x, y, z], [1, 1.2, 0.6], 0, 0, 6), blob(size, EYE, [x, y, z], [1, 1.2, 0.6], 0, 0, 6)];
}

/** Bốn chân ngắn đứng trên mặt đất. */
function legs(x: number, z: number, length: number, radius: number, color: string): Parts {
  return [-1, 1].flatMap((sx) => [-1, 1].map((sz) => capsule(radius, length, color, 6).translate(sx * x, radius + length / 2, sz * z)));
}

/** Nón nhỏ (tai, sừng, mỏ), nghiêng rồi mới đặt vào chỗ. */
function cone(radius: number, height: number, color: string, at: At, tilt = 0, roll = 0): THREE.BufferGeometry {
  return painted(new THREE.ConeGeometry(radius, height, 6).rotateX(tilt).rotateZ(roll).translate(...at), color);
}

function cat(): Parts {
  const fur = "#e0913e";
  return [
    blob(0.15, fur, [0, 0.19, -0.02], [0.85, 0.78, 1.25], 0, 0, 10),
    // Sọc mướp: vòng sẫm hơi to hơn thân, chỉ lộ ra một viền quanh lưng.
    ...[-0.12, -0.04, 0.04].map((z) => blob(0.15, "#a85b22", [0, 0.19, z], [0.885, 0.81, 0.22], 0, 0, 10)),
    blob(0.13, fur, [0, 0.35, 0.15], [1, 0.92, 0.95], 0, 0, 10),
    cone(0.045, 0.1, fur, [-0.075, 0.47, 0.13], 0, 0.25),
    cone(0.045, 0.1, fur, [0.075, 0.47, 0.13], 0, -0.25),
    ...eyes(0.048, 0.37, 0.265),
    blob(0.014, "#e88a9a", [0, 0.335, 0.278], [1, 1, 1], 0, 0, 6),
    capsule(0.025, 0.24, fur, 6).rotateX(-0.9).translate(0, 0.3, -0.25),
    ...legs(0.07, 0.1, 0.06, 0.035, "#f0b070"),
  ];
}

function dog(): Parts {
  const fur = "#d9a441";
  const light = "#f2cf86";
  return [
    blob(0.16, fur, [0, 0.22, -0.03], [0.82, 0.8, 1.3], 0, 0, 10),
    blob(0.14, fur, [0, 0.39, 0.16], [1, 0.95, 0.95], 0, 0, 10),
    blob(0.07, light, [0, 0.35, 0.28], [1.05, 0.8, 1.1]),
    blob(0.024, EYE, [0, 0.37, 0.355], [1, 0.8, 0.8], 0, 0, 6),
    ...eyes(0.055, 0.42, 0.27),
    blob(0.07, "#a87a2a", [-0.12, 0.38, 0.13], [0.45, 1.1, 0.75]),
    blob(0.07, "#a87a2a", [0.12, 0.38, 0.13], [0.45, 1.1, 0.75]),
    painted(new THREE.TorusGeometry(0.095, 0.018, 6, 16).rotateX(Math.PI / 2 - 0.3).translate(0, 0.3, 0.1), RED),
    capsule(0.03, 0.16, fur, 6).rotateX(-0.7).translate(0, 0.32, -0.25),
    ...legs(0.075, 0.11, 0.08, 0.04, light),
  ];
}

function rooster(): Parts {
  const body = "#c4521f";
  const yellow = "#e0a92e";
  return [
    blob(0.14, body, [0, 0.27, -0.02], [0.85, 1, 1.1], 0, 0, 10),
    blob(0.1, "#e3823a", [0, 0.25, 0.08], [0.85, 0.95, 0.7]),
    blob(0.075, body, [0, 0.44, 0.08], [1, 1.05, 1]),
    ...[0.03, 0.08, 0.13].map((z, i) => blob(0.03, "#d62a1e", [0, i === 1 ? 0.535 : 0.52, z], [0.6, 1, 1], 0, 0, 6)),
    cone(0.025, 0.07, "#f2c94c", [0, 0.43, 0.175], Math.PI / 2),
    blob(0.022, "#d62a1e", [0, 0.38, 0.14], [0.8, 1.4, 0.8], 0, 0, 6),
    ...eyes(0.04, 0.46, 0.14, 0.014),
    // Đuôi: ba chiếc lông cong vểnh ra sau.
    ...["#1f4a3a", "#2b2433", "#1f4a3a"].map((color, i) => blob(0.09, color, [0, 0.36 + i * 0.04, -0.18 - i * 0.02], [0.25, 1, 0.55], -0.5 - i * 0.15)),
    ...[-0.045, 0.045].map((x) => capsule(0.012, 0.12, yellow, 5).translate(x, 0.08, 0)),
    ...[-0.045, 0.045].map((x) => painted(new THREE.BoxGeometry(0.05, 0.012, 0.07).translate(x, 0.006, 0.02), yellow)),
  ];
}

function duckling(): Parts {
  const down = "#f6d34a";
  const orange = "#f08a24";
  return [
    blob(0.13, down, [0, 0.15, -0.01], [0.9, 0.85, 1.15], 0, 0, 10),
    blob(0.09, down, [0, 0.3, 0.09], [1, 1, 1], 0, 0, 10),
    blob(0.045, orange, [0, 0.28, 0.18], [1.2, 0.45, 1.1]),
    ...eyes(0.04, 0.32, 0.165, 0.014),
    blob(0.07, "#efc23a", [-0.11, 0.17, -0.01], [0.3, 0.7, 1], 0.2),
    blob(0.07, "#efc23a", [0.11, 0.17, -0.01], [0.3, 0.7, 1], 0.2),
    blob(0.04, down, [0, 0.21, -0.14], [0.6, 0.5, 1], -0.6),
    ...[-0.05, 0.05].map((x) => painted(new THREE.BoxGeometry(0.06, 0.014, 0.08).translate(x, 0.007, 0.03), orange)),
  ];
}

/** Heo ỉ tranh Đông Hồ: đen, béo tròn, hai vòng trắng trên mình. */
function pig(): Parts {
  const skin = "#2b2626";
  return [
    blob(0.19, skin, [0, 0.22, -0.02], [0.95, 0.82, 1.25], 0, 0, 12),
    ...[-1, 1].map((side) => blob(0.07, CREAM, [side * 0.17, 0.25, -0.02], [0.25, 1, 1])),
    ...[-1, 1].map((side) => blob(0.035, skin, [side * 0.183, 0.26, 0], [0.25, 1, 1], 0, 0, 6)),
    blob(0.12, skin, [0, 0.3, 0.2], [1, 0.95, 0.95], 0, 0, 10),
    cylinder(0.055, 0.06, 0.05, "#4a3d3d", 0, 0, 0, 12).rotateX(Math.PI / 2).translate(0, 0.28, 0.32),
    ...[-0.02, 0.02].map((x) => blob(0.01, EYE, [x, 0.28, 0.347], [1, 1, 0.5], 0, 0, 6)),
    ...[-0.05, 0.05].map((x) => blob(0.022, CREAM, [x, 0.34, 0.3], [1, 1, 0.6], 0, 0, 6)),
    ...eyes(0.05, 0.34, 0.31, 0.012),
    cone(0.04, 0.07, skin, [-0.07, 0.41, 0.17], 0, 0.5),
    cone(0.04, 0.07, skin, [0.07, 0.41, 0.17], 0, -0.5),
    painted(new THREE.TorusGeometry(0.03, 0.01, 5, 10).translate(0, 0.27, -0.25), skin),
    ...legs(0.1, 0.12, 0.04, 0.045, skin),
  ];
}

/** Rồng con: xanh lá, bụng vàng, sừng và gai vàng, cánh nhỏ; tâm ở gốc vì bay. */
function dragon(): Parts {
  const scale = "#46a36b";
  return [
    blob(0.12, scale, [0, 0, -0.02], [0.85, 0.9, 1.2], 0, 0, 10),
    blob(0.09, "#f2d27a", [0, -0.02, 0.06], [0.8, 0.85, 0.7]),
    blob(0.1, scale, [0, 0.13, 0.14], [1, 0.95, 1.05], 0, 0, 10),
    blob(0.055, scale, [0, 0.1, 0.24], [1, 0.75, 1]),
    ...[-0.02, 0.02].map((x) => blob(0.008, EYE, [x, 0.11, 0.29], [1, 1, 0.5], 0, 0, 6)),
    ...eyes(0.045, 0.16, 0.22, 0.018),
    cone(0.022, 0.08, GOLD, [-0.045, 0.24, 0.1], -0.5),
    cone(0.022, 0.08, GOLD, [0.045, 0.24, 0.1], -0.5),
    ...[0, 1, 2].map((i) => cone(0.022, 0.05, GOLD, [0, 0.1 - i * 0.03, -0.05 - i * 0.07])),
    blob(0.11, "#2f7a4c", [-0.14, 0.08, -0.04], [1, 0.15, 0.7], 0, 0.5),
    blob(0.11, "#2f7a4c", [0.14, 0.08, -0.04], [1, 0.15, 0.7], 0, -0.5),
    blob(0.06, scale, [0, -0.06, -0.16]),
    blob(0.045, scale, [0, -0.1, -0.24]),
    blob(0.03, GOLD, [0, -0.12, -0.3], [1, 1, 1], 0, 0, 6),
    ...[-1, 1].map((side) => capsule(0.006, 0.1, GOLD, 5).rotateZ(side * 1.2).translate(side * 0.07, 0.1, 0.25)),
  ];
}

/** Phượng con: đỏ, mào vàng, cánh cam, ba lông đuôi dài; tâm ở gốc vì bay. */
function phoenix(): Parts {
  const red = "#e0473a";
  return [
    blob(0.1, red, [0, 0, 0], [0.85, 0.95, 1.15], 0, 0, 10),
    blob(0.075, red, [0, 0.12, 0.09], [1, 1, 1], 0, 0, 10),
    cone(0.02, 0.06, "#f2c94c", [0, 0.11, 0.18], Math.PI / 2),
    ...eyes(0.035, 0.14, 0.15, 0.013),
    ...[-0.2, 0, 0.2].map((roll) => capsule(0.008, 0.08, GOLD, 5).rotateX(-0.6).rotateZ(roll).translate(0, 0.22, 0.05)),
    blob(0.1, "#f0a030", [-0.12, 0.04, -0.02], [1, 0.14, 0.65], 0, 0.55),
    blob(0.1, "#f0a030", [0.12, 0.04, -0.02], [1, 0.14, 0.65], 0, -0.55),
    ...[-0.06, 0, 0.06].map((x, i) => capsule(0.012, i === 1 ? 0.28 : 0.22, i === 1 ? RED : GOLD, 5).rotateX(-1.2).translate(x, -0.06, -0.2)),
    ...[-0.06, 0, 0.06].map((x, i) => blob(0.025, i === 1 ? GOLD : RED, [x, i === 1 ? -0.15 : -0.12, i === 1 ? -0.34 : -0.31], [1, 1, 1], 0, 0, 6)),
  ];
}

/** Lân con múa lân: đầu đỏ to, mắt to, bờm trắng vàng, thân vải vàng sọc xanh. */
function lion(): Parts {
  const red = "#e04a2a";
  return [
    blob(0.15, GOLD, [0, 0.2, -0.08], [0.85, 0.75, 1.25], 0, 0, 10),
    ...[-0.2, -0.1, 0].map((z) => blob(0.15, "#3f7a4d", [0, 0.2, z], [0.88, 0.78, 0.18], 0, 0, 8)),
    blob(0.16, red, [0, 0.36, 0.13], [1, 0.95, 0.95], 0, 0, 12),
    ...Array.from({ length: 10 }, (_, i) => {
      const angle = (i / 10) * Math.PI * 2;
      return blob(0.04, i % 2 ? CREAM : GOLD, [Math.cos(angle) * 0.17, 0.36 + Math.sin(angle) * 0.15, 0.08], [1, 1, 0.7], 0, 0, 6);
    }),
    blob(0.045, CREAM, [-0.07, 0.42, 0.26], [1, 1, 0.6]),
    blob(0.045, CREAM, [0.07, 0.42, 0.26], [1, 1, 0.6]),
    ...eyes(0.07, 0.42, 0.29, 0.02),
    blob(0.03, GOLD, [0, 0.5, 0.25], [1, 1, 0.5], 0, 0, 6),
    blob(0.1, GOLD, [0, 0.27, 0.22], [1, 0.35, 0.8]),
    cone(0.03, 0.09, GOLD, [0, 0.55, 0.12]),
    ...legs(0.08, 0.12, 0.06, 0.04, red),
    blob(0.05, CREAM, [0, 0.26, -0.27], [1, 1, 1], 0, 0, 6),
  ];
}

/** Rùa vàng Hồ Gươm: mai vàng đồng có vân, da xanh rêu. */
function turtle(): Parts {
  const shell = "#c99a2e";
  const dark = "#9a7420";
  const skin = "#9cb36a";
  const plates: At[] = [
    [0, 0.235, 0],
    [0.09, 0.2, 0.08],
    [-0.09, 0.2, 0.08],
    [0.09, 0.2, -0.08],
    [-0.09, 0.2, -0.08],
  ];
  return [
    blob(0.2, shell, [0, 0.13, 0], [1, 0.55, 1.15], 0, 0, 12),
    ...plates.map((at) => blob(0.06, dark, at, [1, 0.3, 1], 0, 0, 6)),
    painted(new THREE.TorusGeometry(0.2, 0.018, 5, 20).rotateX(Math.PI / 2).scale(1, 1, 1.15).translate(0, 0.08, 0), dark),
    blob(0.07, skin, [0, 0.12, 0.26], [1, 0.9, 1.1]),
    ...eyes(0.035, 0.15, 0.315, 0.012),
    ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => blob(0.05, skin, [sx * 0.15, 0.04, sz * 0.13], [0.9, 0.5, 1.2], 0, 0, 6))),
    cone(0.025, 0.06, skin, [0, 0.07, -0.24], -Math.PI / 2),
  ];
}

const BUILDERS: Readonly<Record<number, () => Parts>> = { 1: cat, 2: dog, 3: rooster, 4: duckling, 5: pig, 6: dragon, 7: phoenix, 8: lion, 9: turtle };

/** Một con thú cưng gộp thành một khối. Chỉ gọi với số có trong PET_SHAPES. */
export function petGeometry(index: number): THREE.BufferGeometry {
  return merged(BUILDERS[index]());
}

/** Luồng lửa của Rồng con: hẹp ở miệng, loe ra phía trước (+z), gốc ở 0. Cảnh kéo dài theo z khi phun. */
export function petFlameGeometry(): THREE.BufferGeometry {
  return merged([
    painted(new THREE.ConeGeometry(0.06, 0.32, 10).rotateX(-Math.PI / 2).translate(0, 0, 0.16), "#ff7a1f"),
    painted(new THREE.ConeGeometry(0.035, 0.22, 8).rotateX(-Math.PI / 2).translate(0, 0, 0.11), "#ffd23f"),
  ]);
}
