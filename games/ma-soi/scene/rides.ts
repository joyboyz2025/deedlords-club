// Hình 3D xe trong thị trấn và tư thế người ngồi, đứng trên xe. Thân xe gộp thành một khối; bánh xe là khối riêng để quay.
// Xe đặt trên mặt đất, đầu xe nhìn về phía +z như nhân vật.

import * as THREE from "three";
import type { Look } from "../look.ts";
import type { ChibiKit } from "./chibi";
import { capsule, cylinder, merged, painted, sphere } from "./parts.ts";

type Parts = THREE.BufferGeometry[];
type At = [number, number, number];

/** Người trên xe: `seat` ngồi (không thì đứng), `y` độ cao chỗ ngồi hay mặt đứng, `arms` góc giơ tay ra trước (cầm lái). */
export type Mount = { seat: boolean; y: number; arms: number };
export type RideShape = {
  mount: Mount;
  /** Thảm bay, mây: dập dềnh lên xuống. */
  bob: boolean;
  /** Trâu, ngựa: nhún theo bước khi đi. */
  gait: boolean;
  /** Bánh xe: bán kính và chỗ đặt từng bánh (tâm bánh); trục bánh nằm ngang theo x. */
  wheels: { radius: number; spots: At[] } | null;
};

/** Theo số thứ tự trong nhóm Xe của LOOK_CHOICES; số 0 là đi bộ. */
export const RIDE_SHAPES: Readonly<Record<number, RideShape>> = {
  1: { mount: { seat: true, y: 0.42, arms: -1 }, bob: false, gait: false, wheels: { radius: 0.2, spots: [[0, 0.2, 0.38], [0, 0.2, -0.36]] } },
  2: {
    mount: { seat: false, y: 0.12, arms: -0.15 },
    bob: false,
    gait: false,
    wheels: { radius: 0.045, spots: [[-0.1, 0.045, 0.3], [0.1, 0.045, 0.3], [-0.1, 0.045, -0.3], [0.1, 0.045, -0.3]] },
  },
  3: { mount: { seat: true, y: 0.48, arms: -1 }, bob: false, gait: false, wheels: { radius: 0.2, spots: [[0, 0.2, 0.42], [0, 0.2, -0.42]] } },
  4: { mount: { seat: true, y: 0.7, arms: -0.6 }, bob: false, gait: true, wheels: null },
  5: { mount: { seat: true, y: 0.8, arms: -0.7 }, bob: false, gait: true, wheels: null },
  6: {
    mount: { seat: true, y: 0.24, arms: -1.1 },
    bob: false,
    gait: false,
    wheels: { radius: 0.16, spots: [[-0.36, 0.16, 0.5], [0.36, 0.16, 0.5], [-0.36, 0.16, -0.48], [0.36, 0.16, -0.48]] },
  },
  7: { mount: { seat: false, y: 0.3, arms: -0.25 }, bob: true, gait: false, wheels: null },
  8: { mount: { seat: false, y: 0.3, arms: -0.25 }, bob: true, gait: false, wheels: null },
};

/** Tư thế trên xe của bộ đồ này; đi bộ thì `null`. */
export function mountOf(look: Look): Mount | null {
  return RIDE_SHAPES[look.ride ?? 0]?.mount ?? null;
}

const DARK = "#2a2a2e";
const STEEL = "#9aa3ad";
const SILVER = "#c9ccd4";
const GOLD = "#edb92e";
const RED = "#c8321e";
const CREAM = "#f4ebd6";

/** Thanh tròn nối hai điểm, như khung xe đạp. */
function stick(from: At, to: At, radius: number, color: string): THREE.BufferGeometry {
  const a = new THREE.Vector3(...from);
  const b = new THREE.Vector3(...to);
  const direction = b.clone().sub(a);
  const geometry = new THREE.CapsuleGeometry(radius, Math.max(direction.length() - 2 * radius, 0.001), 1, 6);
  geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()));
  return painted(geometry.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2), color);
}

/** Bốn chân của trâu, ngựa, đứng trên mặt đất. */
function legs(x: number, z: number, length: number, radius: number, color: string): Parts {
  return [-1, 1].flatMap((sx) => [-1, 1].map((sz) => capsule(radius, length, color, 6).translate(sx * x, radius + length / 2, sz * z)));
}

function eyes(x: number, y: number, z: number): Parts {
  return [-1, 1].map((side) => sphere(0.018, "#1b1712", side * x, y, z, 1, 1.2, 0.6, 6));
}

function bicycle(): Parts {
  return [
    stick([0, 0.2, -0.36], [0, 0.46, -0.1], 0.018, RED),
    stick([0, 0.46, -0.1], [0, 0.5, 0.28], 0.018, RED),
    stick([0, 0.2, -0.36], [0, 0.22, 0.02], 0.018, RED),
    stick([0, 0.22, 0.02], [0, 0.5, 0.28], 0.018, RED),
    stick([0, 0.5, 0.28], [0, 0.2, 0.38], 0.016, RED),
    stick([0, 0.5, 0.28], [0, 0.62, 0.3], 0.014, DARK),
    stick([-0.17, 0.63, 0.28], [0.17, 0.63, 0.28], 0.014, DARK),
    sphere(0.06, DARK, 0, 0.49, -0.12, 1.1, 0.35, 1.5, 8),
    painted(new THREE.BoxGeometry(0.2, 0.12, 0.14).translate(0, 0.52, 0.42), "#b9824f"),
    cylinder(0.035, 0.035, 0.06, DARK, 0, 0, 0, 8).rotateZ(Math.PI / 2).translate(0, 0.22, 0.02),
  ];
}

function skateboard(): Parts {
  const deck = "#3d6fb0";
  const end = (z: number, turn: number) => painted(new THREE.CylinderGeometry(0.13, 0.13, 0.03, 12, 1, false, -Math.PI / 2, Math.PI).rotateY(turn).translate(0, 0.1, z), deck);
  return [
    painted(new THREE.BoxGeometry(0.26, 0.03, 0.66).translate(0, 0.1, 0), deck),
    end(0.33, 0),
    end(-0.33, Math.PI),
    painted(new THREE.BoxGeometry(0.22, 0.006, 0.6).translate(0, 0.118, 0), DARK),
    ...[-0.3, 0.3].map((z) => painted(new THREE.BoxGeometry(0.2, 0.03, 0.05).translate(0, 0.075, z), STEEL)),
  ];
}

function motorbike(): Parts {
  const paint = "#2f6db0";
  return [
    sphere(0.2, paint, 0, 0.36, -0.14, 0.62, 0.55, 1.25, 12),
    sphere(0.06, DARK, 0, 0.52, -0.12, 1.5, 0.45, 2.6, 10),
    painted(new THREE.BoxGeometry(0.16, 0.08, 0.36).translate(0, 0.26, 0.08), paint),
    sphere(0.2, CREAM, 0, 0.42, 0.24, 0.85, 1.25, 0.32, 12),
    stick([0, 0.2, 0.42], [0, 0.66, 0.34], 0.022, STEEL),
    stick([-0.2, 0.68, 0.33], [0.2, 0.68, 0.33], 0.016, DARK),
    sphere(0.06, "#ffe8a0", 0, 0.66, 0.4, 1, 1, 0.7, 10),
    sphere(0.17, paint, 0, 0.3, 0.42, 0.35, 0.3, 0.75, 8),
    painted(new THREE.BoxGeometry(0.06, 0.03, 0.3).translate(-0.1, 0.18, -0.25), STEEL),
    ...[-1, 1].map((side) => stick([side * 0.17, 0.68, 0.32], [side * 0.2, 0.8, 0.3], 0.008, DARK)),
    ...[-1, 1].map((side) => sphere(0.025, SILVER, side * 0.2, 0.81, 0.3, 1, 1, 0.4, 6)),
  ];
}

/** Trâu: thân to đặt thấp, chân ngắn chắc, sừng cong, tấm vải đỏ trên lưng cho người ngồi. */
function buffalo(): Parts {
  const hide = "#4a4a52";
  const dark = "#3a3a42";
  return [
    sphere(0.32, hide, 0, 0.47, -0.02, 0.82, 0.72, 1.35, 12),
    sphere(0.16, hide, 0, 0.52, 0.48, 1, 0.95, 1.05, 10),
    sphere(0.09, "#7a7a84", 0, 0.45, 0.6, 1.2, 0.8, 0.9, 8),
    ...eyes(0.09, 0.58, 0.6),
    // Sừng cong ra sau.
    ...[-1, 1].map((side) =>
      painted(new THREE.TorusGeometry(0.13, 0.025, 6, 12, Math.PI * 0.8).rotateY((side * Math.PI) / 2).rotateX(-0.4).translate(side * 0.1, 0.68, 0.44), "#d8cdb0"),
    ),
    ...[-1, 1].map((side) => sphere(0.04, hide, side * 0.17, 0.58, 0.44, 1.4, 0.6, 0.8, 6)),
    ...legs(0.17, 0.3, 0.2, 0.075, dark),
    stick([0, 0.5, -0.42], [0, 0.25, -0.5], 0.015, dark),
    painted(new THREE.BoxGeometry(0.42, 0.04, 0.4).translate(0, 0.7, -0.04), RED),
  ];
}

/** Ngựa nâu: thân đặt thấp, chân chắc có móng sẫm, cổ và bờm, yên đỏ. */
function horse(): Parts {
  const coat = "#8b5a2b";
  const mane = "#3a2414";
  return [
    sphere(0.3, coat, 0, 0.58, -0.02, 0.75, 0.75, 1.35, 12),
    stick([0, 0.7, 0.3], [0, 0.95, 0.45], 0.11, coat),
    sphere(0.13, coat, 0, 0.98, 0.52, 0.66, 0.7, 1.2, 10),
    sphere(0.065, "#6b4320", 0, 0.94, 0.66, 0.9, 0.8, 0.8, 8),
    ...eyes(0.075, 1.02, 0.56),
    ...[-1, 1].map((side) => painted(new THREE.ConeGeometry(0.03, 0.08, 6).translate(side * 0.05, 1.1, 0.48), coat)),
    ...Array.from({ length: 5 }, (_, i) => sphere(0.045, mane, 0, 0.8 + i * 0.05, 0.3 + i * 0.035, 0.6, 1, 1, 6)),
    ...legs(0.14, 0.3, 0.3, 0.06, "#7a4c22"),
    ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => cylinder(0.065, 0.07, 0.05, mane, sx * 0.14, 0.025, sz * 0.3, 8))),
    stick([0, 0.65, -0.42], [0, 0.35, -0.55], 0.04, mane),
    sphere(0.16, RED, 0, 0.8, -0.04, 0.95, 0.25, 1.1, 10),
  ];
}

/** Siêu xe mui trần đỏ: thân thấp, nắp capo cao che chân người lái, cánh gió sau. */
function supercar(): Parts {
  const paint = "#e0302a";
  return [
    painted(new THREE.BoxGeometry(0.74, 0.2, 1.36).translate(0, 0.26, 0), paint),
    painted(new THREE.BoxGeometry(0.76, 0.03, 0.9).translate(0, 0.3, 0), CREAM),
    sphere(0.37, paint, 0, 0.26, 0.62, 1, 0.3, 0.45, 12),
    sphere(0.37, paint, 0, 0.27, -0.62, 1, 0.32, 0.35, 12),
    painted(new THREE.BoxGeometry(0.72, 0.1, 0.32).translate(0, 0.39, 0.42), paint),
    painted(new THREE.BoxGeometry(0.64, 0.1, 0.03).rotateX(-0.5).translate(0, 0.49, 0.25), "#bfe6ff"),
    painted(new THREE.BoxGeometry(0.6, 0.06, 0.5).translate(0, 0.36, -0.08), DARK),
    painted(new THREE.BoxGeometry(0.58, 0.18, 0.08).translate(0, 0.45, -0.3), DARK),
    painted(new THREE.BoxGeometry(0.7, 0.04, 0.12).translate(0, 0.5, -0.62), DARK),
    ...[-1, 1].map((side) => painted(new THREE.BoxGeometry(0.04, 0.12, 0.04).translate(side * 0.25, 0.42, -0.6), DARK)),
    ...[-1, 1].map((side) => sphere(0.045, "#fff2b0", side * 0.25, 0.3, 0.76, 1.2, 0.7, 0.5, 8)),
    ...[-1, 1].map((side) => sphere(0.035, "#ff3b3b", side * 0.26, 0.32, -0.74, 1.3, 0.7, 0.5, 8)),
    painted(new THREE.TorusGeometry(0.09, 0.015, 6, 14).rotateX(-1.1).translate(0, 0.5, 0.2), DARK),
  ];
}

function carpet(): Parts {
  const dots: [number, number][] = [
    [0, 0.3],
    [0, -0.3],
    [0.2, 0],
    [-0.2, 0],
  ];
  return [
    painted(new THREE.BoxGeometry(0.78, 0.03, 1.08).translate(0, 0.28, 0), GOLD),
    painted(new THREE.BoxGeometry(0.7, 0.035, 1).translate(0, 0.285, 0), "#8e2a3a"),
    painted(new THREE.BoxGeometry(0.44, 0.038, 0.7).translate(0, 0.287, 0), "#2f4f8a"),
    ...dots.map(([x, z]) => sphere(0.035, CREAM, x, 0.3, z, 1, 0.3, 1, 6)),
    ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => capsule(0.012, 0.06, GOLD, 5).rotateX(Math.PI / 2).translate(sx * 0.36, 0.28, sz * 0.58))),
  ];
}

/** Mây ngũ sắc: bảy cụm mây trắng, hồng, vàng, xanh, tím, ngọc. */
function cloud(): Parts {
  const puffs: [number, number, number, number, string][] = [
    [0, 0.28, 0, 0.24, "#ffffff"],
    [0.22, 0.26, 0.12, 0.17, "#ffd1dc"],
    [-0.22, 0.26, 0.1, 0.17, "#c9f0ff"],
    [0.18, 0.25, -0.18, 0.16, "#ffe9a8"],
    [-0.2, 0.25, -0.16, 0.16, "#d6c9ff"],
    [0, 0.24, 0.28, 0.15, "#c8f7d0"],
    [0, 0.25, -0.3, 0.15, "#ffffff"],
  ];
  return puffs.map(([x, y, z, radius, color]) => sphere(radius, color, x, y, z, 1, 0.55, 1, 10));
}

const BODIES: Readonly<Record<number, () => Parts>> = { 1: bicycle, 2: skateboard, 3: motorbike, 4: buffalo, 5: horse, 6: supercar, 7: carpet, 8: cloud };

/** Thân một chiếc xe, không có bánh. Chỉ gọi với số có trong RIDE_SHAPES. */
export function rideBodyGeometry(index: number): THREE.BufferGeometry {
  return merged(BODIES[index]());
}

/** Một bánh của xe, tâm ở gốc, trục theo x; có nan hay vành sáng để thấy bánh quay. */
export function rideWheelGeometry(index: number): THREE.BufferGeometry {
  const radius = RIDE_SHAPES[index].wheels?.radius ?? 0.05;
  if (index === 1 || index === 3) {
    return merged([
      painted(new THREE.TorusGeometry(radius, 0.025, 6, 20).rotateY(Math.PI / 2), DARK),
      painted(new THREE.BoxGeometry(0.01, radius * 1.9, 0.012), SILVER),
      painted(new THREE.BoxGeometry(0.01, 0.012, radius * 1.9), SILVER),
      cylinder(0.025, 0.025, 0.05, SILVER, 0, 0, 0, 8).rotateZ(Math.PI / 2),
    ]);
  }
  if (index === 6) {
    return merged([
      cylinder(radius, radius, 0.12, "#1f1f24", 0, 0, 0, 16).rotateZ(Math.PI / 2),
      cylinder(radius * 0.55, radius * 0.55, 0.125, SILVER, 0, 0, 0, 12).rotateZ(Math.PI / 2),
      painted(new THREE.BoxGeometry(0.13, 0.03, radius * 1.1), DARK),
    ]);
  }
  return merged([cylinder(radius, radius, 0.04, "#f2c94c", 0, 0, 0, 10).rotateZ(Math.PI / 2), painted(new THREE.BoxGeometry(0.045, 0.01, radius * 1.4), "#c99a2e")]);
}

type RideKit = Pick<ChibiKit, "solid" | "rideBody" | "rideWheel">;

/** Một chiếc xe trong cảnh: thân và các bánh, đi theo nhân vật đang ngồi, đứng trên đó. */
export class RideModel {
  readonly root = new THREE.Group();
  readonly index: number;
  private shape: RideShape;
  private wheels: THREE.Mesh[] = [];
  private travel = 0;
  private seed = Math.random() * 10;

  constructor(kit: RideKit, index: number) {
    this.index = index;
    this.shape = RIDE_SHAPES[index];
    this.root.add(new THREE.Mesh(kit.rideBody(index), kit.solid));
    for (const [x, y, z] of this.shape.wheels?.spots ?? []) {
      const wheel = new THREE.Mesh(kit.rideWheel(index), kit.solid);
      wheel.position.set(x, y, z);
      this.wheels.push(wheel);
      this.root.add(wheel);
    }
  }

  /** Đặt xe đúng chỗ, đúng hướng nhân vật; bánh quay theo quãng đường. Trả về độ nâng (dập dềnh, nhún) để nâng cả người trên xe. */
  follow(x: number, z: number, facing: number, moving: boolean, time: number, calm: boolean): number {
    const distance = Math.hypot(x - this.root.position.x, z - this.root.position.z);
    this.root.position.x = x;
    this.root.position.z = z;
    this.root.rotation.y = facing;
    this.travel += distance;
    if (this.shape.wheels) for (const wheel of this.wheels) wheel.rotation.x += distance / this.shape.wheels.radius;
    let lift = 0;
    if (this.shape.bob) lift = calm ? 0.04 : 0.04 + Math.sin(time * 2.2 + this.seed) * 0.04;
    else if (this.shape.gait && moving && !calm) lift = Math.abs(Math.sin(this.travel * 3.2)) * 0.05;
    this.root.position.y = lift;
    return lift;
  }
}
