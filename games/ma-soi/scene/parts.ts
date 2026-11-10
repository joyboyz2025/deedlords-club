// Hình khối của nhân vật: dáng nam nữ, tóc, trang phục và phụ kiện, dựng hoàn toàn từ khối cơ bản.
// Mọi món gộp vào đầu, thân, tay, chân có sẵn, nên ai đeo gì cũng không tốn thêm lượt vẽ.

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { LOOK_CHOICES, type Look } from "../look.ts";
import { fitHat, hairParts, hatCeiling, type Ceiling } from "./hair.ts";

type Parts = THREE.BufferGeometry[];

const SON = "#c8321e";
const HOE = "#edb92e";
const DIEP = "#f4ebd6";
const MUC = "#1d1a20";
const NAVY = "#27346e";
const WOOD = "#5a3a22";
const SHOE = "#3f2410";
const STEEL = "#8d96a3";
const BRONZE = "#c58f3e";
const CRIMSON = "#b3261a";

/**
 * Những món đội đầu ôm lấy đầu: tóc dưới mũ ép cho nằm gọn dưới mặt trong của mũ, búi, gai, vòng tóc trên đỉnh bỏ đi.
 * Khăn vấn (9) thêm vào từ đợt tóc mới (5/11/2026): tóc mới phồng hơn sẽ vùi mất vòng khăn.
 * Mũ phượng (11) không ở đây: nó đặt trên tóc, to theo tóc như vòng hoa (OPEN_HATS trong hair.ts).
 */
export const HATS_OVER_HAIR = new Set([1, 2, 3, 4, 6, 8, 9, 10, 12, 13, 14, 15, 16, 17, 18]);
/** Mặt trong của từng mũ che đỉnh, dựng một lần cho mỗi mũ (chiếu tia, xem hatCeiling): tóc dưới mũ ép theo đúng dáng mũ. */
const CEILINGS = new Map<number, Ceiling>();
/** Phần trang trí mà tóc được phủ lên, không tính là mặt chắn tóc: hai quai đỏ của nón quai thao rủ cạnh tai. */
const NOT_CEILING: Readonly<Record<number, readonly number[]>> = { 3: [2, 3] };

export function hatCeilingOf(hat: number): Ceiling | null {
  if (!HATS_OVER_HAIR.has(hat)) return null;
  let ceiling = CEILINGS.get(hat);
  if (!ceiling) {
    const parts = hatParts(hat);
    ceiling = hatCeiling(parts.filter((_, i) => !NOT_CEILING[hat]?.includes(i)));
    for (const part of parts) part.dispose();
    CEILINGS.set(hat, ceiling);
  }
  return ceiling;
}

export function painted(geometry: THREE.BufferGeometry, color: string): THREE.BufferGeometry {
  const { r, g, b } = new THREE.Color(color);
  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) colors.set([r, g, b], i * 3);
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.deleteAttribute("uv");
  return geometry;
}

export function sphere(radius: number, color: string, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, detail = 12): THREE.BufferGeometry {
  return painted(new THREE.SphereGeometry(radius, detail, Math.max(5, detail - 2)).scale(sx, sy, sz).translate(x, y, z), color);
}

/** Đồ mảnh như que, dây thì `radial` nhỏ cho nhẹ. */
export function capsule(radius: number, length: number, color: string, radial = 10): THREE.BufferGeometry {
  return painted(new THREE.CapsuleGeometry(radius, length, radial < 8 ? 1 : 3, radial), color);
}

export function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const geometry = mergeGeometries(parts)!;
  for (const part of parts) part.dispose();
  return geometry;
}

function mix(from: string, to: string, amount: number): string {
  return `#${new THREE.Color(from).lerp(new THREE.Color(to), amount).getHexString()}`;
}

function lathe(points: number[][], color: string): THREE.BufferGeometry {
  return painted(new THREE.LatheGeometry(points.map(([x, y]) => new THREE.Vector2(x, y)), 16), color);
}

export function cylinder(top: number, bottom: number, height: number, color: string, x = 0, y = 0, z = 0, segments = 14): THREE.BufferGeometry {
  return painted(new THREE.CylinderGeometry(top, bottom, height, segments).translate(x, y, z), color);
}

/** Mảnh che đỉnh đầu, ngả ra sau để còn thấy mặt. */
function cap(color: string, tilt = -0.25): THREE.BufferGeometry {
  return painted(new THREE.SphereGeometry(0.375, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.52).rotateX(tilt).scale(1.04, 0.94, 0.98), color);
}

/** Vòng nằm ngang quanh đầu hoặc cổ. */
function band(radius: number, thickness: number, y: number, color: string, tilt = 0, z = 0): THREE.BufferGeometry {
  return painted(new THREE.TorusGeometry(radius, thickness, thickness < 0.025 ? 5 : 8, 22).rotateX(Math.PI / 2 - tilt).scale(1.05, 1, 1).translate(0, y, z), color);
}

/** Vòng quanh thân và cổ. */
function hoop(radius: number, thickness: number, y: number, color: string, tilt = 0, z = 0): THREE.BufferGeometry {
  return painted(new THREE.TorusGeometry(radius, thickness, thickness < 0.025 ? 5 : 8, 20).rotateX(Math.PI / 2 - tilt).translate(0, y, z), color);
}

/** Bán kính của dáng áo ở một độ cao, để viền và sọc nằm sát mặt áo. */
function radiusAt(profile: number[][], y: number): number {
  for (let i = 1; i < profile.length; i++) {
    const [from, low] = profile[i - 1];
    const [to, high] = profile[i];
    if (high > low && y >= low && y <= high) return from + ((to - from) * (y - low)) / (high - low);
  }
  return 0;
}

/** Vòng ôm quanh mặt, đi qua đỉnh đầu và dưới cằm. */
function faceRing(thickness: number, color: string): THREE.BufferGeometry {
  return painted(new THREE.TorusGeometry(0.37, thickness, 8, 24).scale(1.03, 0.97, 1).translate(0, -0.01, 0.03), color);
}

/** Một dải trên mặt tính theo chiều cao đầu: 0 là đỉnh, 1 là cằm. `width` là độ rộng sang mỗi bên, tính bằng radian. */
function faceSlice(color: string, from: number, to: number, width: number): THREE.BufferGeometry {
  return painted(new THREE.SphereGeometry(0.394, 16, 6, Math.PI / 2 - width, width * 2, Math.PI * from, Math.PI * (to - from)).scale(1.04, 0.94, 0.98), color);
}

function star(outer: number, inner: number, color: string, x: number, y: number, z: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const radius = i % 2 ? inner : outer;
    const angle = Math.PI / 2 + (i * Math.PI) / 5;
    if (i === 0) shape.moveTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
    else shape.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
  }
  return painted(new THREE.ShapeGeometry(shape).translate(x, y, z), color);
}

/** Mấy chấm nhỏ đính trên áo: cúc, sao, ngọc. */
function dots(spots: number[][], color: string, radius = 0.018): Parts {
  return spots.map(([x, y, z]) => sphere(radius, color, x, y, z, 1, 1, 1, 6));
}

/** Những vòng sọc chạy quanh áo ở nhiều độ cao. */
function stripes(profile: number[][], rows: number[], color: string, thickness = 0.016): Parts {
  return rows.map((y) => hoop(radiusAt(profile, y) + thickness * 0.3, thickness, y, color));
}

/** Một đầu khối hướng ra ngoài chỏm đầu, dùng cho tóc dựng và tóc xoăn. */
function aroundCrown(tilt: number, spin: number, radius: number): THREE.Vector3 {
  return new THREE.Vector3(Math.sin(tilt) * Math.sin(spin), Math.cos(tilt), Math.sin(tilt) * Math.cos(spin)).multiplyScalar(radius);
}

function skullParts(skin: string, woman: boolean, tone: string): Parts {
  const blush = mix(skin, "#e8503c", woman ? 0.6 : 0.42);
  const brow = (side: number) =>
    woman
      ? capsule(0.007, 0.07, tone, 5).rotateZ(Math.PI / 2 - side * 0.22).translate(side * 0.135, 0.087, 0.335)
      : capsule(0.014, 0.07, tone, 6).rotateZ(Math.PI / 2 - side * 0.1).translate(side * 0.135, 0.083, 0.335);
  return [
    sphere(0.36, skin, 0, 0, 0, 1.04, 0.94, 0.98, 20),
    sphere(0.055, skin, -0.365, -0.03, 0, 1, 1, 1, 8),
    sphere(0.055, skin, 0.365, -0.03, 0, 1, 1, 1, 8),
    sphere(0.06, blush, -0.2, -0.1, 0.285, 1.25, 0.72, 0.4, 8),
    sphere(0.06, blush, 0.2, -0.1, 0.285, 1.25, 0.72, 0.4, 8),
    woman ? sphere(0.034, "#d8334a", 0, -0.14, 0.335, 1.35, 0.62, 0.5, 8) : sphere(0.034, mix(skin, "#6b1f12", 0.7), 0, -0.14, 0.335, 1.5, 0.62, 0.5, 8),
    brow(-1),
    brow(1),
  ];
}

function hatParts(hat: number): Parts {
  switch (hat) {
    case 1: // Nón lá ngả ra sau để còn thấy mặt
      return [
        painted(new THREE.ConeGeometry(0.52, 0.36, 20, 1, true).rotateX(-0.3).translate(0, 0.42, -0.08), "#e9cf8e"),
        painted(new THREE.CircleGeometry(0.52, 20).rotateX(Math.PI / 2 - 0.3).translate(0, 0.25, -0.03), "#c4a76a"),
      ];
    case 2: // Khăn đóng
      return [cap("#27346e", -0.08), painted(new THREE.TorusGeometry(0.33, 0.07, 8, 22).rotateX(Math.PI / 2 - 0.12).translate(0, 0.14, -0.015), "#1d2a5e"), sphere(0.05, HOE, 0, 0.16, 0.355)];
    case 3: { // Nón quai thao: vành rộng phẳng, quai đỏ thả hai bên
      // NOT_CEILING chọn hai quai theo thứ tự phần (2, 3): đổi thứ tự hay thêm phần thì sửa NOT_CEILING theo.
      const flat = (geometry: THREE.BufferGeometry) => geometry.rotateX(-0.2).translate(0, 0.29, -0.05);
      return [
        painted(flat(new THREE.CylinderGeometry(0.58, 0.66, 0.04, 24)), "#3b2b1e"),
        painted(flat(new THREE.CylinderGeometry(0.26, 0.3, 0.1, 18).translate(0, 0.06, 0)), "#55402c"),
        capsule(0.016, 0.34, SON, 6).translate(-0.4, 0.06, 0),
        capsule(0.016, 0.34, SON, 6).translate(0.4, 0.06, 0),
      ];
    }
    case 4: { // Mũ rơm có dải đỏ
      const brim = (geometry: THREE.BufferGeometry) => geometry.rotateX(-0.16).translate(0, 0.2, -0.03);
      return [
        painted(new THREE.SphereGeometry(0.35, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.55).scale(1.03, 0.82, 1).rotateX(-0.16).translate(0, 0.16, -0.03), "#e6c46c"),
        painted(brim(new THREE.CylinderGeometry(0.58, 0.6, 0.025, 24)), "#d9b458"),
        painted(new THREE.TorusGeometry(0.33, 0.036, 6, 22).rotateX(Math.PI / 2 - 0.16).translate(0, 0.25, -0.02), SON),
      ];
    }
    case 5: { // Vòng hoa
      const flowers = Array.from({ length: 8 }, (_, i) => {
        const angle = (i / 8) * Math.PI * 2;
        return sphere(0.052, ["#f0a6bd", DIEP, HOE][i % 3], Math.cos(angle) * 0.33, 0.25 + Math.sin(angle) * 0.05, Math.sin(angle) * 0.31 - 0.03, 1, 0.7, 1, 6);
      });
      return [band(0.32, 0.026, 0.25, "#4f8a4d", 0.15, -0.03), ...flowers];
    }
    case 6: // Mũ cánh chuồn của quan
      return [
        cap(MUC, -0.08),
        sphere(0.22, MUC, 0, 0.32, -0.1, 1, 0.72, 0.9, 14),
        sphere(0.12, "#2a2433", -0.45, 0.3, -0.12, 1.9, 0.4, 0.14),
        sphere(0.12, "#2a2433", 0.45, 0.3, -0.12, 1.9, 0.4, 0.14),
        sphere(0.038, HOE, 0, 0.23, 0.34, 1, 1, 1, 8),
      ];
    case 7: // Băng đỏ buộc đầu
      return [
        band(0.345, 0.03, 0.1, SON, 0.1, -0.005),
        sphere(0.05, SON, 0, 0.1, -0.36),
        capsule(0.02, 0.17, SON, 6).rotateZ(0.3).translate(-0.06, -0.03, -0.38),
        capsule(0.02, 0.17, SON, 6).rotateZ(-0.3).translate(0.06, -0.03, -0.38),
      ];
    case 8: // Khăn mỏ quạ: khăn đen nhọn trước trán, vòng qua cằm
      return [cap(MUC, -0.1), sphere(0.12, MUC, 0, 0.27, 0.28, 0.85, 0.62, 0.62), faceRing(0.042, MUC)];
    case 9: // Khăn vấn tròn như vành
      return [band(0.3, 0.085, 0.22, "#4b2d5e", 0.18, -0.03), sphere(0.26, "#3a2148", 0, 0.25, -0.04, 1, 0.48, 1, 14)];
    case 10: { // Mũ vua: đỉnh bằng, chuỗi ngọc rủ trước trán và sau gáy
      const board = (geometry: THREE.BufferGeometry) => geometry.rotateX(-0.08).translate(0, 0.46, -0.02);
      const strand = (x: number, z: number) => dots([0, 1, 2].map((i) => [x, 0.42 - i * 0.052, z]), SON, 0.017);
      return [
        painted(new THREE.SphereGeometry(0.37, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.5).scale(1.03, 0.95, 1).rotateX(-0.08).translate(0, 0.08, -0.02), "#e0ac2a"),
        band(0.36, 0.032, 0.13, CRIMSON, 0.08, -0.02),
        painted(board(new THREE.BoxGeometry(0.74, 0.03, 0.48)), MUC),
        painted(board(new THREE.BoxGeometry(0.76, 0.012, 0.5).translate(0, -0.02, 0)), HOE),
        ...[-0.26, -0.13, 0, 0.13, 0.26].flatMap((x) => strand(x, 0.235)),
      ];
    }
    case 11: { // Mũ phượng
      const peak = (angle: number, height: number) => painted(new THREE.ConeGeometry(0.05, height, 6).translate(Math.sin(angle) * 0.34, 0.2 + height / 2, Math.cos(angle) * 0.31 - 0.02), HOE);
      return [
        band(0.335, 0.034, 0.17, HOE, 0.14, -0.02),
        peak(0, 0.2),
        peak(-0.5, 0.16),
        peak(0.5, 0.16),
        peak(-1, 0.13),
        peak(1, 0.13),
        sphere(0.045, "#d9334a", 0, 0.19, 0.33, 1, 1, 1, 8),
        sphere(0.095, HOE, -0.38, 0.22, -0.06, 1.5, 0.5, 0.22, 8),
        sphere(0.095, HOE, 0.38, 0.22, -0.06, 1.5, 0.5, 0.22, 8),
        ...dots([[-0.385, 0.13, 0.02], [-0.385, 0.08, 0.02], [0.385, 0.13, 0.02], [0.385, 0.08, 0.02]], DIEP, 0.02),
      ];
    }
    case 12: // Mũ tướng có chỏm đỏ
      return [
        painted(new THREE.SphereGeometry(0.385, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.52).scale(1.04, 0.96, 1).rotateX(-0.1), STEEL),
        band(0.365, 0.03, 0.1, BRONZE, 0.1, -0.01),
        sphere(0.3, "#6f7885", 0, -0.02, -0.2, 1.1, 0.6, 0.4, 10),
        cylinder(0.03, 0.05, 0.1, BRONZE, 0, 0.39, -0.03, 8),
        sphere(0.09, CRIMSON, 0, 0.5, -0.1, 0.7, 1.3, 1.4, 10),
      ];
    case 13: { // Mũ cối xanh có sao
      const worn = (geometry: THREE.BufferGeometry) => geometry.rotateX(-0.25).translate(0, 0.1, -0.02);
      return [
        painted(worn(new THREE.SphereGeometry(0.41, 18, 8, 0, Math.PI * 2, 0, Math.PI * 0.5).scale(1.02, 0.82, 1.12)), "#5d6b3a"),
        painted(worn(new THREE.CylinderGeometry(0.47, 0.5, 0.028, 24).scale(1, 1, 1.16)), "#4d5a30"),
        star(0.05, 0.022, HOE, 0, 0.3, 0.37),
      ];
    }
    case 14: // Mũ bảo hiểm
      return [
        painted(new THREE.SphereGeometry(0.392, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.52).scale(1.05, 0.96, 1.02).rotateX(-0.14), "#2a55c9"),
        painted(new THREE.TorusGeometry(0.378, 0.034, 6, 18, Math.PI).rotateY(Math.PI / 2).rotateX(-0.14).translate(0, 0.01, 0), DIEP),
        sphere(0.2, "#1c3d99", 0, 0.13, 0.35, 1.05, 0.16, 0.72, 10),
        faceRing(0.011, "#15131a"),
      ];
    case 15: { // Mũ cướp biển
      const worn = (geometry: THREE.BufferGeometry) => geometry.rotateX(-0.25).translate(0, 0.27, -0.03);
      return [
        painted(worn(new THREE.SphereGeometry(0.3, 14, 8).scale(1.2, 0.5, 1.02)), MUC),
        painted(worn(new THREE.SphereGeometry(0.56, 14, 8).scale(1.02, 0.1, 0.68)), "#2a2433"),
        sphere(0.06, DIEP, 0, 0.36, 0.25, 1, 1, 0.5),
        ...dots([[-0.022, 0.37, 0.28], [0.022, 0.37, 0.28]], MUC, 0.012),
      ];
    }
    case 16: { // Mũ phù thủy
      const worn = (geometry: THREE.BufferGeometry) => geometry.rotateX(-0.2).translate(0, 0.25, -0.05);
      return [
        painted(worn(new THREE.CylinderGeometry(0.58, 0.62, 0.025, 24)), "#2b2140"),
        painted(worn(new THREE.ConeGeometry(0.31, 0.64, 16).translate(0, 0.32, 0).rotateZ(0.12)), "#3b2a66"),
        painted(worn(new THREE.TorusGeometry(0.29, 0.03, 6, 20).rotateX(Math.PI / 2).translate(0, 0.05, 0)), HOE),
      ];
    }
    case 17: // Mũ ngủ có quả bông
      return [
        painted(new THREE.SphereGeometry(0.378, 14, 7, 0, Math.PI * 2, 0, Math.PI * 0.46).scale(1.04, 0.94, 0.98).translate(0, 0.02, -0.01), SON),
        band(0.34, 0.045, 0.17, DIEP, 0.12, -0.01),
        painted(new THREE.ConeGeometry(0.28, 0.46, 12).translate(0, 0.23, 0).rotateZ(-0.95).translate(0.06, 0.2, -0.02), SON),
        sphere(0.07, DIEP, 0.44, 0.47, -0.02, 1, 1, 1, 8),
      ];
    case 18: // Khăn ninja chỉ chừa đôi mắt
      return [
        painted(new THREE.SphereGeometry(0.38, 18, 8, 0, Math.PI * 2, 0, Math.PI * 0.42).scale(1.04, 0.94, 0.98), "#23202a"),
        painted(new THREE.SphereGeometry(0.395, 18, 8, 0, Math.PI * 2, Math.PI * 0.56, Math.PI * 0.44).scale(1.04, 0.94, 0.98), "#23202a"),
        band(0.366, 0.018, 0.09, SON, 0, -0.005),
        capsule(0.018, 0.16, SON, 6).rotateZ(0.35).translate(-0.05, 0, -0.39),
        capsule(0.018, 0.16, SON, 6).rotateZ(-0.35).translate(0.05, 0, -0.39),
      ];
    case 19: { // Tai thỏ
      const ear = (side: number): Parts => [
        painted(new THREE.SphereGeometry(0.08, 10, 8).scale(1, 2.7, 0.5).rotateZ(-side * 0.14).translate(side * 0.17, 0.53, -0.05), DIEP),
        painted(new THREE.SphereGeometry(0.046, 8, 8).scale(1, 2.8, 0.4).rotateZ(-side * 0.14).translate(side * 0.17, 0.53, -0.014), "#f0a6bd"),
      ];
      return [band(0.345, 0.018, 0.18, "#e58aa0", 0.14, -0.01), ...ear(-1), ...ear(1)];
    }
    case 20: { // Sừng quỷ
      const horn = (side: number) => painted(new THREE.ConeGeometry(0.062, 0.26, 8).translate(0, 0.13, 0).rotateZ(-side * 0.45).translate(side * 0.2, 0.26, 0.03), SON);
      return [horn(-1), horn(1)];
    }
    case 21: { // Hoa cài bên tai
      const petals = Array.from({ length: 5 }, (_, i) => {
        const angle = (i / 5) * Math.PI * 2;
        return sphere(0.04, "#f0a6bd", 0.31 + Math.cos(angle) * 0.05, 0.17 + Math.sin(angle) * 0.05, 0.11, 1, 1, 0.55, 6);
      });
      return [...petals, sphere(0.03, HOE, 0.31, 0.17, 0.13, 1, 1, 0.6, 6)];
    }
    default:
      return [];
  }
}

function faceParts(face: number, tone: string): Parts {
  const rim = (x: number) => painted(new THREE.TorusGeometry(0.086, 0.013, 6, 18).translate(x, 0.015, 0.34), "#2b211b");
  const lens = (x: number) => sphere(0.09, "#15131a", x, 0.015, 0.335, 1.15, 0.82, 0.3, 10);
  const bridge = (color: string) => capsule(0.011, 0.06, color, 5).rotateZ(Math.PI / 2).translate(0, 0.03, 0.36);
  const whisker = (x: number) => sphere(0.06, tone, x, -0.102, 0.335, 1.4, 0.42, 0.5, 8);
  switch (face) {
    case 1: // Kính tròn
      return [rim(-0.135), rim(0.135), bridge("#2b211b")];
    case 2: // Kính râm
      return [lens(-0.135), lens(0.135), bridge("#15131a")];
    case 3: // Bịt một mắt
      return [sphere(0.082, "#15131a", 0.135, 0.02, 0.335, 1.1, 1, 0.32, 10), band(0.352, 0.012, 0.1, "#15131a", 0.2, -0.01)];
    case 4: // Ria mép
      return [whisker(-0.06), whisker(0.06)];
    case 5: // Râu dài
      return [whisker(-0.06), whisker(0.06), sphere(0.13, tone, 0, -0.3, 0.2, 0.85, 1.3, 0.62, 12)];
    case 6: // Khẩu trang
      return [faceSlice("#cfe3ee", 0.56, 0.84, 1.1), capsule(0.006, 0.1, "#b4cbd8", 5).rotateZ(Math.PI / 2 + 0.2).translate(-0.34, -0.06, 0.1), capsule(0.006, 0.1, "#b4cbd8", 5).rotateZ(Math.PI / 2 - 0.2).translate(0.34, -0.06, 0.1)];
    case 7: // Râu quai nón
      return [faceSlice(tone, 0.66, 1, 1.5), whisker(-0.06), whisker(0.06)];
    case 8: // Mũi hề
      return [sphere(0.058, "#e0301e", 0, -0.055, 0.365, 1, 1, 1, 12)];
    case 9: { // Kính phi công: tròng giọt nước xanh rêu, gọng vàng, thanh ngang trên
      const tilt = (x: number) => (x < 0 ? 0.22 : -0.22);
      const lens = (x: number) => painted(new THREE.SphereGeometry(0.086, 10, 8).scale(1.18, 1.02, 0.3).rotateZ(tilt(x)).translate(x, 0, 0.338), "#2e4a3b");
      const frame = (x: number) => painted(new THREE.TorusGeometry(0.092, 0.01, 5, 18).scale(1.18, 1.02, 1).rotateZ(tilt(x)).translate(x, 0, 0.346), "#c9a227");
      return [lens(-0.135), lens(0.135), frame(-0.135), frame(0.135), capsule(0.008, 0.21, "#c9a227", 5).rotateZ(Math.PI / 2).translate(0, 0.07, 0.36), bridge("#c9a227")];
    }
    default:
      return [];
  }
}

function neckParts(neck: number, accent: string): Parts {
  const wing = (side: number, color: string, length: number, spread: number, y: number) =>
    painted(new THREE.SphereGeometry(0.2, 8, 7).scale(0.5, length, 0.12).rotateZ(side * spread).translate(side * (0.2 + Math.sin(spread) * 0.2 * length), y, -0.27), color);
  switch (neck) {
    case 1: // Khăn quàng
      return [hoop(0.205, 0.056, 0.365, accent, 0.1, 0.005), capsule(0.044, 0.12, accent).rotateZ(0.2).translate(0.1, 0.25, 0.225)];
    case 2: // Chuỗi hạt
      return Array.from({ length: 11 }, (_, i) => {
        const angle = ((i - 5) / 5) * 1.75;
        return sphere(0.027, i % 2 ? DIEP : HOE, Math.sin(angle) * 0.19, 0.42 - Math.cos(angle) * 0.1, Math.cos(angle) * 0.2 + 0.015, 1, 1, 1, 6);
      });
    case 3: // Yếm
      return [sphere(0.19, accent, 0, 0.27, 0.19, 0.92, 1.05, 0.32, 12)];
    case 4: // Áo choàng sau lưng
      return [sphere(0.37, accent, 0, 0.2, -0.2, 0.98, 1.05, 0.44, 14)];
    case 5: // Khăn rằn đen trắng
      return [
        hoop(0.205, 0.056, 0.365, "#26242c", 0.1, 0.005),
        capsule(0.044, 0.14, "#26242c").rotateZ(0.2).translate(0.1, 0.24, 0.225),
        ...Array.from({ length: 9 }, (_, i) => {
          const angle = ((i - 4) / 4) * 1.5;
          return sphere(0.014, DIEP, Math.sin(angle) * 0.25, 0.375 - Math.cos(angle) * 0.02, Math.cos(angle) * 0.248, 1, 1, 0.6, 6);
        }),
      ];
    case 6: // Khăn đỏ thắt nút
      return [
        hoop(0.2, 0.03, 0.36, SON, 0.1, 0.005),
        sphere(0.036, SON, 0, 0.32, 0.225),
        painted(new THREE.ConeGeometry(0.055, 0.17, 3).rotateX(Math.PI).rotateZ(0.32).translate(-0.04, 0.23, 0.235), SON),
        painted(new THREE.ConeGeometry(0.055, 0.17, 3).rotateX(Math.PI).rotateZ(-0.32).translate(0.04, 0.23, 0.235), SON),
      ];
    case 7: // Vòng bạc nhiều tầng
      return [hoop(0.205, 0.018, 0.345, "#dfe2e8"), hoop(0.226, 0.018, 0.31, "#c9ccd4"), hoop(0.246, 0.018, 0.275, "#dfe2e8"), sphere(0.03, "#dfe2e8", 0, 0.235, 0.255, 1, 1.2, 0.5, 8)];
    case 8: // Nơ cổ
      return [sphere(0.055, SON, -0.055, 0.345, 0.205, 1.1, 0.75, 0.5, 10), sphere(0.055, SON, 0.055, 0.345, 0.205, 1.1, 0.75, 0.5, 10), sphere(0.024, "#8c1f12", 0, 0.345, 0.225, 1, 1, 0.8, 8)];
    case 9: // Cánh tiên
      return [wing(-1, "#fbf7ee", 1.5, 0.75, 0.42), wing(1, "#fbf7ee", 1.5, 0.75, 0.42), wing(-1, "#efe6d4", 1, 1.35, 0.22), wing(1, "#efe6d4", 1, 1.35, 0.22)];
    case 10: // Cánh dơi
      return [wing(-1, "#3a2a4e", 1.5, 0.6, 0.44), wing(1, "#3a2a4e", 1.5, 0.6, 0.44), wing(-1, "#2d2040", 1.3, 1.05, 0.32), wing(1, "#2d2040", 1.3, 1.05, 0.32), wing(-1, "#3a2a4e", 1, 1.5, 0.2), wing(1, "#3a2a4e", 1, 1.5, 0.2)];
    default:
      return [];
  }
}

/** Đồ dài dựng từ bàn tay, ngả ra ngoài để không đâm vào đầu. Các khối dựng sẵn với bàn tay ở gốc tọa độ. */
function inHand(parts: Parts, lean = -0.5, forward = 0): Parts {
  return parts.map((part) => part.rotateZ(lean).rotateX(forward).translate(0, -0.25, 0.06));
}

/** Đồ cầm ở tay phải, tính từ vai. Bàn tay nằm ở y = -0.25. */
function heldParts(held: number): Parts {
  switch (held) {
    case 1: { // Quạt giấy xòe nửa vòng
      const half = (radius: number, depth: number, color: string, z: number) =>
        painted(new THREE.CylinderGeometry(radius, radius, depth, 14, 1, false, Math.PI / 2, Math.PI).rotateX(Math.PI / 2).translate(0, -0.2, z), color);
      return [half(0.21, 0.012, HOE, 0.075), half(0.185, 0.014, SON, 0.08), capsule(0.012, 0.06, WOOD, 5).translate(0, -0.25, 0.075)];
    }
    case 2: // Đèn lồng đỏ
      return [
        capsule(0.008, 0.06, SHOE, 5).translate(0, -0.36, 0.05),
        sphere(0.115, SON, 0, -0.51, 0.05, 1, 0.82, 1, 10),
        cylinder(0.05, 0.05, 0.03, HOE, 0, -0.42, 0.05, 10),
        cylinder(0.05, 0.05, 0.03, HOE, 0, -0.6, 0.05, 10),
      ];
    case 3: { // Cành đào
      const spots = [[0.14, 0.04, 0.2], [0.06, 0.02, 0.19], [0.21, -0.04, 0.17], [0.11, 0.12, 0.22], [0.2, 0.08, 0.2], [0.05, -0.08, 0.16]];
      return [capsule(0.014, 0.36, WOOD, 5).rotateZ(-0.42).rotateX(0.3).translate(0.08, -0.12, 0.13), ...spots.map(([x, y, z], i) => sphere(0.042, i % 3 ? "#f0a6bd" : "#fbd4de", x, y, z, 1, 1, 1, 6))];
    }
    case 4: // Gậy trúc
      return inHand([capsule(0.021, 1, "#8aa24a", 7).translate(0, 0.1, 0), ...[-0.26, 0.12, 0.44].map((y) => painted(new THREE.TorusGeometry(0.024, 0.007, 5, 10).rotateX(Math.PI / 2).translate(0, y, 0), "#62782f"))]);
    case 5: // Ly trà đá
      return [
        cylinder(0.066, 0.052, 0.15, "#b0642a", 0, -0.27, 0.1, 12),
        cylinder(0.069, 0.066, 0.022, "#fff6e6", 0, -0.185, 0.1, 12),
        painted(new THREE.BoxGeometry(0.04, 0.04, 0.04).rotateY(0.5).translate(-0.016, -0.165, 0.1), "#e8f6ff"),
        painted(new THREE.BoxGeometry(0.036, 0.036, 0.036).rotateY(1.1).translate(0.024, -0.168, 0.11), "#e8f6ff"),
      ];
    case 6: // Kiếm chĩa lên trước
      return inHand(
        [
          painted(new THREE.BoxGeometry(0.036, 0.6, 0.012).translate(0, 0.4, 0), "#dfe6ee"),
          painted(new THREE.BoxGeometry(0.15, 0.026, 0.04).translate(0, 0.09, 0), HOE),
          painted(new THREE.CylinderGeometry(0.02, 0.02, 0.13, 8).translate(0, 0.02, 0), WOOD),
        ],
        -0.6,
        0.55,
      );
    case 7: { // Hoa sen
      const petal = (spin: number, lift: number) => {
        const at = aroundCrown(lift, spin, 0.08);
        return painted(new THREE.SphereGeometry(0.05, 6, 5).scale(0.7, 1.35, 0.4).rotateX(lift).rotateY(spin).translate(at.x, at.y + 0.3, at.z), "#ef8fb0");
      };
      return inHand(
        [
          capsule(0.012, 0.26, "#4f8a4d", 5).translate(0, 0.13, 0),
          ...Array.from({ length: 7 }, (_, i) => petal((i / 7) * Math.PI * 2, 0.72)),
          ...Array.from({ length: 4 }, (_, i) => petal((i / 4) * Math.PI * 2 + 0.4, 0.2)),
          sphere(0.03, HOE, 0, 0.31, 0, 1, 1, 1, 6),
        ],
        -0.7,
        0.45,
      );
    }
    case 8: // Bánh mì kẹp
      return [
        capsule(0.05, 0.26, "#d9a25a", 8).rotateZ(1.25).translate(0.02, -0.28, 0.09),
        capsule(0.014, 0.24, "#5d8a3a", 5).rotateZ(1.25).translate(0.02, -0.245, 0.122),
        capsule(0.012, 0.22, "#a0472f", 5).rotateZ(1.25).translate(0.02, -0.25, 0.135),
      ];
    case 9: // Mõ gỗ và dùi
      return [
        sphere(0.095, "#8e4b28", 0, -0.36, 0.11, 1.2, 0.92, 1, 10),
        capsule(0.009, 0.1, "#4a2616", 5).rotateZ(Math.PI / 2).translate(0, -0.34, 0.205),
        capsule(0.011, 0.16, WOOD, 5).rotateX(1.1).translate(0, -0.22, 0.13),
      ];
    case 10: // Đàn nguyệt: bầu tròn, cần dài
      return [
        painted(new THREE.CylinderGeometry(0.13, 0.13, 0.035, 20).rotateX(Math.PI / 2).translate(-0.04, -0.33, 0.14), "#a5622c"),
        painted(new THREE.CylinderGeometry(0.095, 0.095, 0.038, 18).rotateX(Math.PI / 2).translate(-0.04, -0.33, 0.142), "#d9a25a"),
        capsule(0.016, 0.44, WOOD, 5).rotateZ(-0.55).translate(0.1, -0.08, 0.14),
        sphere(0.024, "#3a2415", 0.235, 0.135, 0.14, 1.2, 1.6, 1, 6),
      ];
    case 11: // Điện thoại
      return [
        painted(new THREE.BoxGeometry(0.095, 0.17, 0.014).rotateX(-0.45).translate(0, -0.2, 0.13), "#15131a"),
        painted(new THREE.BoxGeometry(0.078, 0.14, 0.004).rotateX(-0.45).translate(0, -0.2, 0.14), "#7fd4ff"),
      ];
    case 12: // Gậy phép đầu ngọc
      return inHand([capsule(0.019, 0.82, "#4b2d5e", 6).translate(0, 0.1, 0), ...dots([[0, 0.44, 0], [0, 0.48, 0]], HOE, 0.026), sphere(0.075, "#7fd4ff", 0, 0.62, 0, 1, 1, 1, 8)]);
    case 13: // Cờ hội
      return inHand([capsule(0.014, 0.85, WOOD, 5).translate(0, 0.1, 0), sphere(0.02, HOE, 0, 0.55, 0, 1, 1, 1, 6), sphere(0.16, SON, 0.17, 0.42, 0, 1.1, 0.72, 0.05, 8), sphere(0.05, HOE, 0.17, 0.42, 0.012, 1, 1, 0.1, 6)], -0.35);
    default:
      return [];
  }
}

/** Giày trên bàn chân, tính từ hông: bàn chân nằm quanh y = -0.17, mũi giày hướng về phía trước. 0 là giày của bộ đồ. */
function shoeParts(shoes: number, shoe: string, skin: string): Parts {
  switch (shoes) {
    case 1: // Dép tổ ong: nhựa xanh nhạt đục lỗ, đế trắng
      return [
        painted(new THREE.BoxGeometry(0.15, 0.03, 0.25).translate(0, -0.222, 0.04), "#f2f4ef"),
        sphere(0.085, "#86c8e6", 0, -0.18, 0.045, 1, 0.62, 1.38, 10),
        ...dots([[-0.035, -0.135, 0.07], [0.035, -0.135, 0.07], [0, -0.13, 0.12], [-0.04, -0.15, 0], [0.04, -0.15, 0], [0, -0.127, 0.02]], "#3f86ad", 0.013),
      ];
    case 2: // Guốc mộc: đế gỗ dày, quai da ngang mu, lộ bàn chân
      return [
        painted(new THREE.BoxGeometry(0.15, 0.055, 0.26).translate(0, -0.215, 0.04), "#b9824f"),
        sphere(0.07, skin, 0, -0.17, 0.05, 1, 0.55, 1.45, 10),
        painted(new THREE.BoxGeometry(0.16, 0.035, 0.07).translate(0, -0.155, 0.075), "#6b3b1f"),
      ];
    case 3: // Giày thể thao: thân đỏ, đế và mũi trắng, dây buộc
      return [
        painted(new THREE.BoxGeometry(0.16, 0.035, 0.27).translate(0, -0.222, 0.045), "#f7f6f0"),
        sphere(0.088, "#d8392b", 0, -0.175, 0.035, 1, 0.68, 1.36, 10),
        sphere(0.052, "#f7f6f0", 0, -0.19, 0.13, 1.35, 0.72, 1, 8),
        painted(new THREE.BoxGeometry(0.022, 0.012, 0.09).translate(0, -0.118, 0.05), "#f7f6f0"),
      ];
    case 4: { // Giày patin: ủng cao cổ, viền vàng, bốn bánh xe cam
      const wheel = (z: number) => painted(new THREE.CylinderGeometry(0.03, 0.03, 0.035, 10).rotateZ(Math.PI / 2).translate(0, -0.262, z), "#ff7a3d");
      return [
        sphere(0.09, "#6a4fa3", 0, -0.168, 0.035, 1, 0.74, 1.35, 10),
        cylinder(0.083, 0.088, 0.07, "#6a4fa3", 0, -0.12, 0, 12),
        cylinder(0.086, 0.086, 0.018, "#f2c94c", 0, -0.088, 0, 12),
        painted(new THREE.BoxGeometry(0.045, 0.022, 0.25).translate(0, -0.232, 0.035), "#3a3a44"),
        wheel(-0.06),
        wheel(0.01),
        wheel(0.08),
        wheel(0.15),
      ];
    }
    default:
      return [sphere(0.09, shoe, 0, -0.17, 0.035, 1, 0.68, 1.35, 10)];
  }
}

const TUNIC_MAN = [[0, 0], [0.3, 0], [0.32, 0.05], [0.28, 0.2], [0.2, 0.38], [0.16, 0.46], [0, 0.47]];
const TUNIC_WOMAN = [[0, -0.08], [0.33, -0.08], [0.34, -0.04], [0.25, 0.14], [0.175, 0.27], [0.19, 0.37], [0.15, 0.46], [0, 0.47]];
const GOWN_MAN = [[0, -0.17], [0.29, -0.17], [0.3, -0.13], [0.28, 0.1], [0.21, 0.34], [0.16, 0.46], [0, 0.47]];
const GOWN_WOMAN = [[0, -0.17], [0.32, -0.17], [0.33, -0.13], [0.24, 0.12], [0.175, 0.27], [0.19, 0.37], [0.15, 0.46], [0, 0.47]];
const ROYAL_MAN = [[0, -0.19], [0.37, -0.19], [0.38, -0.15], [0.32, 0.08], [0.25, 0.3], [0.18, 0.44], [0, 0.47]];
const ROYAL_WOMAN = [[0, -0.19], [0.39, -0.19], [0.4, -0.15], [0.28, 0.1], [0.18, 0.27], [0.195, 0.37], [0.15, 0.46], [0, 0.47]];
/** Áo ngắn tới hông, để lộ phần quần hoặc váy ráp ở dưới. */
const SHIRT_MAN = [[0, 0.02], [0.28, 0.02], [0.29, 0.06], [0.26, 0.2], [0.2, 0.38], [0.16, 0.46], [0, 0.47]];
const SHIRT_WOMAN = [[0, 0.12], [0.22, 0.12], [0.225, 0.16], [0.18, 0.27], [0.19, 0.37], [0.15, 0.46], [0, 0.47]];
const SHORTS = [[0, -0.09], [0.25, -0.09], [0.285, 0.04], [0.2, 0.16], [0, 0.17]];
const SKIRT = [[0, -0.1], [0.33, -0.1], [0.34, -0.07], [0.23, 0.16], [0, 0.17]];
const PANTS = [[0, -0.17], [0.22, -0.17], [0.235, -0.02], [0.2, 0.16], [0, 0.17]];

type Dress = {
  torso: () => Parts;
  sleeve: string;
  /** Tay áo rộng, thụng dần về cổ tay. */
  wide?: boolean;
  /** Găng tay, không có thì để lộ tay. */
  glove?: string;
  leg: string;
  shoe: string;
};

/** Vạt áo dài rủ xuống trước và sau. */
function flap(color: string, side: number): THREE.BufferGeometry {
  return painted(new THREE.CylinderGeometry(0.11, 0.2, 0.42, 12).scale(1, 1, 0.1).rotateX(side * -0.16).translate(0, -0.035, side * 0.25), color);
}

function dressOf(look: Look): Dress {
  const { color, accent } = LOOK_CHOICES.robe[look.robe];
  const main = color!;
  const trim = accent!;
  const skin = LOOK_CHOICES.skin[look.skin].color!;
  const woman = look.body === 1;
  const tunic = woman ? TUNIC_WOMAN : TUNIC_MAN;
  const gown = woman ? GOWN_WOMAN : GOWN_MAN;
  const shirt = woman ? SHIRT_WOMAN : SHIRT_MAN;
  const royal = woman ? ROYAL_WOMAN : ROYAL_MAN;
  /** Độ cao và bán kính thắt lưng: nữ thắt cao và nhỏ hơn. */
  const waist = woman ? ([0.27, 0.172] as const) : ([0.21, 0.262] as const);
  const sash = (color: string, thickness = 0.03) => hoop(waist[1], thickness, waist[0], color);
  const legs = (trousers: string) => (woman ? skin : trousers);

  switch (look.outfit) {
    case 1: // Áo dài: thân ôm, hai vạt dài, quần trắng
      return {
        torso: () => [
          lathe(PANTS, DIEP),
          lathe(shirt.map(([x, y]) => [x, Math.max(y, 0.1)]), main),
          flap(main, 1),
          flap(main, -1),
          ...dots([[0.075, 0.345, 0.17], [0.105, 0.3, 0.17], [0.135, 0.25, 0.17]], trim),
        ],
        sleeve: main,
        leg: DIEP,
        shoe: SHOE,
      };
    case 2: { // Áo tứ thân: hai vạt trước buộc lại, yếm đỏ, váy đen, thắt lưng xanh
      const brown = "#8a5a2e";
      const front = (side: number) => painted(new THREE.SphereGeometry(0.1, 10, 8).scale(1, 1.9, 0.2).rotateX(-0.18).translate(side * 0.14, 0.04, 0.245), brown);
      return {
        torso: () => [
          lathe([[0, -0.17], [0.31, -0.17], [0.32, -0.13], [0.24, 0.12], [0.18, 0.24], [0, 0.25]], MUC),
          lathe([[0, 0.2], [0.2, 0.2], [0.2, 0.3], [0.19, 0.37], [0.15, 0.46], [0, 0.47]], brown),
          sphere(0.12, "#d9433a", 0, 0.31, 0.15, 0.9, 1.1, 0.42),
          front(-1),
          front(1),
          painted(new THREE.SphereGeometry(0.17, 10, 8).scale(1, 1.7, 0.18).rotateX(0.18).translate(0, 0.06, -0.26), brown),
          hoop(0.19, 0.03, 0.22, "#4f8a4d"),
          capsule(0.024, 0.15, HOE, 6).translate(-0.03, 0.1, 0.215),
          capsule(0.024, 0.15, "#e58aa0", 6).translate(0.03, 0.1, 0.215),
        ],
        sleeve: brown,
        leg: MUC,
        shoe: SHOE,
      };
    }
    case 3: // Áo bà ba: áo ngắn hàng cúc, quần đen
      return {
        torso: () => [
          lathe(PANTS, MUC),
          lathe(SHIRT_MAN, main),
          ...dots([[0, 0.3, 0.232], [0, 0.22, 0.262], [0, 0.14, 0.285]], trim),
          sphere(0.07, mix(main, MUC, 0.18), -0.14, 0.1, 0.25, 1, 0.8, 0.2),
          sphere(0.07, mix(main, MUC, 0.18), 0.14, 0.1, 0.25, 1, 0.8, 0.2),
        ],
        sleeve: main,
        leg: MUC,
        shoe: SHOE,
      };
    case 4: // Áo the đen dài, quần trắng, cúc vàng
      return {
        torso: () => [
          lathe(GOWN_MAN, MUC),
          hoop(0.205, 0.02, 0.34, DIEP, 0.15, 0.008),
          ...dots([[0.06, 0.3, 0.235], [0.09, 0.24, 0.255], [0.11, 0.17, 0.27], [0.12, 0.1, 0.27]], HOE),
        ],
        sleeve: MUC,
        wide: true,
        leg: DIEP,
        shoe: MUC,
      };
    case 5: // Long bào vàng, đai đỏ, tay thụng
      return {
        torso: () => [
          lathe(royal, "#e8b923"),
          hoop(radiusAt(royal, -0.16), 0.022, -0.16, CRIMSON),
          hoop(woman ? 0.19 : 0.285, 0.036, woman ? 0.25 : 0.17, CRIMSON),
          capsule(0.03, 0.2, CRIMSON).translate(0, -0.03, radiusAt(royal, -0.03)),
          sphere(0.085, CRIMSON, 0, 0.32, radiusAt(royal, 0.32), 1, 1, 0.22),
          sphere(0.05, "#f7d560", 0, 0.32, radiusAt(royal, 0.32) + 0.015, 1, 1, 0.25, 8),
          sphere(0.05, "#4fb286", 0, woman ? 0.25 : 0.17, woman ? 0.21 : 0.31, 1.25, 0.9, 0.5, 10),
          ...Array.from({ length: 8 }, (_, i) => {
            const angle = (i / 8) * Math.PI * 2 + 0.39;
            return sphere(0.038, "#f7d560", Math.sin(angle) * 0.35, -0.09, Math.cos(angle) * 0.35, 1, 0.6, 1, 6);
          }),
        ],
        sleeve: "#e8b923",
        wide: true,
        leg: "#e8b923",
        shoe: MUC,
      };
    case 6: // Phượng bào đỏ, viền vàng, tà dài phía sau
      return {
        torso: () => [
          lathe(royal, CRIMSON),
          hoop(radiusAt(royal, -0.16), 0.022, -0.16, HOE),
          hoop(woman ? 0.19 : 0.285, 0.034, woman ? 0.25 : 0.17, HOE),
          sphere(0.3, CRIMSON, 0, -0.14, -0.3, 1, 0.3, 1.15, 12),
          sphere(0.11, "#f2c24e", 0, 0.32, radiusAt(royal, 0.32), 1, 0.85, 0.2, 10),
          sphere(0.05, CRIMSON, 0, 0.32, radiusAt(royal, 0.32) + 0.018, 1, 1, 0.25, 8),
          ...Array.from({ length: 5 }, (_, i) => painted(new THREE.SphereGeometry(0.05, 6, 5).scale(0.65, 1.7, 0.2).rotateX(0.2).translate((i - 2) * 0.09, -0.02 - Math.abs(i - 2) * 0.02, woman ? 0.31 : 0.35), "#f2c24e")),
        ],
        sleeve: CRIMSON,
        wide: true,
        leg: CRIMSON,
        shoe: HOE,
      };
    case 7: // Giáp tướng: giáp sắt, ngực đồng, váy và áo choàng đỏ
      return {
        torso: () => [
          lathe([[0, -0.12], [0.31, -0.12], [0.31, -0.08], [0.3, 0.04], [0, 0.05]], CRIMSON),
          lathe(SHIRT_MAN, STEEL),
          ...stripes(SHIRT_MAN, [0.09, 0.14, 0.19], "#5b6470", 0.012),
          lathe([[0, 0.235], [0.255, 0.235], [0.262, 0.26], [0.21, 0.38], [0.165, 0.46], [0, 0.47]], BRONZE),
          sphere(0.058, "#a87830", 0, 0.31, 0.235, 1, 1, 0.22, 8),
          hoop(0.285, 0.03, 0.03, BRONZE),
          sphere(0.105, BRONZE, -0.25, 0.41, 0, 1.05, 0.62, 1.05),
          sphere(0.105, BRONZE, 0.25, 0.41, 0, 1.05, 0.62, 1.05),
          sphere(0.37, CRIMSON, 0, 0.2, -0.2, 0.98, 1.05, 0.44, 14),
        ],
        sleeve: STEEL,
        glove: BRONZE,
        leg: "#5b6470",
        shoe: MUC,
      };
    case 8: { // Cà sa vàng nghệ, dải chéo qua vai
      const saffron = "#e08a1e";
      const fold = "#b3541a";
      const strap = (z: number) => capsule(0.05, 0.4, fold).rotateZ(z > 0 ? 0.72 : -0.72).translate(0, 0.25, z);
      return {
        torso: () => [lathe(gown, saffron), strap(woman ? 0.17 : 0.215), strap(woman ? -0.17 : -0.215), hoop(waist[1], 0.022, waist[0], fold)],
        sleeve: saffron,
        wide: true,
        leg: saffron,
        shoe: WOOD,
      };
    }
    case 9: // Nông dân: áo nâu vá, dây lưng, chân trần
      return {
        torso: () => [
          lathe(PANTS, "#5e4630"),
          lathe(SHIRT_MAN, "#7d5a36"),
          sphere(0.055, "#a98556", 0.13, 0.13, 0.25, 1, 1, 0.2, 8),
          sphere(0.045, "#5e4630", -0.1, 0.27, 0.205, 1, 1, 0.2, 8),
          hoop(0.285, 0.016, 0.06, "#d9c28a"),
        ],
        sleeve: "#7d5a36",
        leg: "#5e4630",
        shoe: skin,
      };
    case 10: // Học sinh: áo trắng, khăn đỏ, quần hoặc váy xanh
      return {
        torso: () => [
          lathe(woman ? SKIRT : SHORTS, NAVY),
          lathe(shirt, "#f7f5ee"),
          ...dots([[0, 0.26, woman ? 0.18 : 0.245], [0, 0.18, woman ? 0.21 : 0.27]], "#c9c6c0", 0.014),
          hoop(0.2, 0.03, 0.36, SON, 0.1, 0.005),
          sphere(0.036, SON, 0, 0.32, 0.225),
          painted(new THREE.ConeGeometry(0.055, 0.17, 3).rotateX(Math.PI).rotateZ(0.32).translate(-0.04, 0.23, woman ? 0.22 : 0.25), SON),
          painted(new THREE.ConeGeometry(0.055, 0.17, 3).rotateX(Math.PI).rotateZ(-0.32).translate(0.04, 0.23, woman ? 0.22 : 0.25), SON),
        ],
        sleeve: "#f7f5ee",
        leg: skin,
        shoe: MUC,
      };
    case 11: // Cổ động viên: áo đỏ sao vàng
      return {
        torso: () => [lathe(SHORTS, DIEP), lathe(shirt, "#d0281b"), star(0.095, 0.04, HOE, 0, 0.25, woman ? 0.205 : 0.262)],
        sleeve: "#d0281b",
        leg: skin,
        shoe: DIEP,
      };
    case 12: // Cướp biển: áo sọc, dây lưng đỏ, ủng đen
      return {
        torso: () => [
          lathe(PANTS, "#2b2b33"),
          lathe(SHIRT_MAN, DIEP),
          ...stripes(SHIRT_MAN, [0.13, 0.2, 0.27, 0.34], NAVY, 0.018),
          hoop(0.285, 0.036, 0.05, SON),
          capsule(0.024, 0.12, SON).rotateZ(-0.3).translate(0.13, -0.03, 0.26),
          sphere(0.04, SON, 0.11, 0.04, 0.27),
        ],
        sleeve: DIEP,
        leg: "#2b2b33",
        shoe: "#15131a",
      };
    case 13: { // Ninja đen, dải chéo ngực, đai đỏ
      const black = "#23202a";
      return {
        torso: () => [
          lathe(tunic, black),
          capsule(0.024, 0.32, "#3f3b4a").rotateZ(0.7).translate(0, 0.27, woman ? 0.17 : 0.225),
          capsule(0.024, 0.32, "#3f3b4a").rotateZ(-0.7).translate(0, 0.27, woman ? 0.175 : 0.23),
          sash(SON, 0.034),
          capsule(0.02, 0.13, SON).rotateZ(0.2).translate(0.1, waist[0] - 0.1, woman ? 0.17 : 0.25),
        ],
        sleeve: black,
        glove: black,
        leg: black,
        shoe: black,
      };
    }
    case 14: { // Phù thủy: áo tím dài rắc sao, tay thụng
      const purple = "#3b2a66";
      return {
        torso: () => [
          lathe(gown, purple),
          hoop(radiusAt(gown, -0.15), 0.018, -0.15, HOE),
          sash(HOE, 0.024),
          sphere(0.37, "#1f1838", 0, 0.2, -0.2, 0.98, 1.05, 0.44, 14),
          ...Array.from({ length: 7 }, (_, i) => {
            const angle = -1.1 + (i / 6) * 2.2;
            const y = i % 2 ? 0.02 : -0.09;
            return sphere(0.022, "#f7d560", Math.sin(angle) * 0.29, y, Math.cos(angle) * 0.29, 1, 1, 0.6, 6);
          }),
        ],
        sleeve: purple,
        wide: true,
        leg: purple,
        shoe: "#1f1838",
      };
    }
    case 15: // Siêu nhân: đồ xanh, áo choàng đỏ, đai vàng
      return {
        torso: () => [
          lathe(shirt, "#2a55c9"),
          lathe(SHORTS, CRIMSON),
          sash(HOE, 0.03),
          sphere(0.08, HOE, 0, 0.32, woman ? 0.185 : 0.215, 1.1, 1, 0.2),
          sphere(0.046, CRIMSON, 0, 0.32, woman ? 0.2 : 0.23, 1, 1, 0.25, 8),
          sphere(0.37, CRIMSON, 0, 0.2, -0.2, 0.98, 1.05, 0.44, 14),
        ],
        sleeve: "#2a55c9",
        glove: CRIMSON,
        leg: "#2a55c9",
        shoe: CRIMSON,
      };
    case 16: { // Đồ ngủ màu nhạt có sọc, dép lê
      const soft = mix(main, "#ffffff", 0.55);
      return {
        torso: () => [lathe(PANTS, soft), lathe(SHIRT_MAN, soft), ...stripes(SHIRT_MAN, [0.09, 0.17, 0.25, 0.33], main, 0.012), ...dots([[0, 0.28, 0.24], [0, 0.2, 0.27], [0, 0.12, 0.29]], DIEP, 0.016)],
        sleeve: soft,
        leg: soft,
        shoe: "#e58aa0",
      };
    }
    case 17: { // Áo mưa rộng thùng thình
      const coat = mix(main, "#ffffff", 0.25);
      return {
        torso: () => [lathe([[0, -0.14], [0.42, -0.14], [0.43, -0.1], [0.3, 0.2], [0.2, 0.4], [0.13, 0.47], [0, 0.48]], coat), sphere(0.17, coat, 0, 0.32, -0.21, 1, 0.75, 0.7), hoop(0.425, 0.012, -0.11, trim)],
        sleeve: coat,
        wide: true,
        leg: "#3a3a44",
        shoe: SHOE,
      };
    }
    case 18: // Hanbok: nữ váy chuông buộc nơ cao, nam áo ngắn quần phồng
      return woman
        ? {
            torso: () => [
              lathe([[0, -0.18], [0.37, -0.18], [0.38, -0.14], [0.33, 0.1], [0.22, 0.28], [0.16, 0.33], [0, 0.34]], main),
              lathe([[0, 0.3], [0.2, 0.3], [0.2, 0.37], [0.15, 0.46], [0, 0.47]], DIEP),
              hoop(0.195, 0.016, 0.31, trim),
              sphere(0.04, trim, 0.03, 0.33, 0.19, 1.3, 0.8, 0.6, 8),
              capsule(0.018, 0.17, trim).rotateZ(-0.1).translate(0.05, 0.2, 0.22),
              capsule(0.018, 0.13, trim).rotateZ(0.1).translate(0.01, 0.22, 0.22),
            ],
            sleeve: DIEP,
            leg: main,
            shoe: DIEP,
          }
        : {
            torso: () => [
              lathe([[0, -0.15], [0.26, -0.15], [0.33, 0], [0.26, 0.14], [0, 0.15]], DIEP),
              lathe(SHIRT_MAN.map(([x, y]) => [x, Math.max(y, 0.1)]), main),
              hoop(0.275, 0.02, 0.12, trim),
              capsule(0.018, 0.13, trim).rotateZ(-0.12).translate(0.06, 0.28, 0.23),
            ],
            sleeve: main,
            leg: DIEP,
            shoe: SHOE,
          };
    case 19: // Kimono: áo chéo cổ, đai to, nơ sau lưng, tay thụng
      return {
        torso: () => [
          lathe(gown, main),
          hoop(waist[1] + 0.008, 0.052, waist[0], trim),
          sphere(0.11, trim, 0, waist[0] + 0.01, woman ? -0.22 : -0.3, 1.5, 0.85, 0.55),
          capsule(0.018, 0.2, DIEP).rotateZ(0.62).translate(-0.045, 0.335, woman ? 0.165 : 0.2),
          capsule(0.018, 0.2, DIEP).rotateZ(-0.62).translate(0.045, 0.335, woman ? 0.17 : 0.205),
        ],
        sleeve: main,
        wide: true,
        leg: DIEP,
        shoe: SHOE,
      };
    case 20: { // Tiên nữ: váy nhạt, dải lụa bay vòng sau lưng
      const silk = mix(main, "#ffffff", 0.5);
      return {
        torso: () => [
          lathe(gown, silk),
          sash(trim, 0.024),
          capsule(0.016, 0.2, trim).translate(0.03, waist[0] - 0.12, woman ? 0.17 : 0.26),
          painted(new THREE.TorusGeometry(0.62, 0.02, 6, 26, Math.PI).translate(0, 0.42, -0.26), trim),
          sphere(0.03, trim, -0.62, 0.42, -0.26, 1, 1.6, 1, 8),
          sphere(0.03, trim, 0.62, 0.42, -0.26, 1, 1.6, 1, 8),
        ],
        sleeve: silk,
        wide: true,
        leg: skin,
        shoe: silk,
      };
    }
    case 21: // Ông Địa: bụng phệ, áo khoác đỏ, quần vàng
      return {
        torso: () => [
          lathe([[0, -0.13], [0.31, -0.13], [0.37, 0.02], [0.3, 0.1], [0, 0.11]], "#edb92e"),
          lathe(SHIRT_MAN, CRIMSON),
          sphere(0.3, skin, 0, 0.17, 0.11, 0.96, 0.98, 0.92, 16),
          sphere(0.018, mix(skin, "#6b1f12", 0.6), 0, 0.15, 0.385, 1, 1, 0.5, 8),
          hoop(0.3, 0.03, 0.03, "#e07b2e"),
        ],
        sleeve: CRIMSON,
        leg: "#edb92e",
        shoe: SHOE,
      };
    default: // Áo thường: nam áo ngắn quần cùng màu, nữ váy xòe lộ chân
      return {
        torso: () => [
          lathe(tunic, main),
          sash(trim),
          painted(new THREE.TorusGeometry(0.135, 0.03, 6, 16).rotateX(Math.PI / 2 - 0.3).translate(0, 0.45, 0.012), trim),
          ...(woman ? [sphere(0.04, trim, 0, waist[0], waist[1] + 0.015, 1.3, 0.8, 0.5, 8)] : []),
        ],
        sleeve: main,
        leg: legs(main),
        shoe: SHOE,
      };
  }
}

export function headGeometry(look: Look): THREE.BufferGeometry {
  const tone = LOOK_CHOICES.hairColor[look.hairColor].color!;
  const skin = LOOK_CHOICES.skin[look.skin].color!;
  return merged([
    ...skullParts(skin, look.body === 1, tone),
    ...hairParts(look.hair, look.hairColor, hatCeilingOf(look.hat)),
    ...fitHat(look.hair, look.hat, hatParts(look.hat)),
    ...faceParts(look.face, tone),
  ]);
}

export function torsoGeometry(look: Look): THREE.BufferGeometry {
  return merged([...dressOf(look).torso(), ...neckParts(look.neck, LOOK_CHOICES.robe[look.robe].accent!)]);
}

/** `held` là món cầm trên cánh tay này; tay còn lại truyền 0. */
export function armGeometry(look: Look, held: number): THREE.BufferGeometry {
  const { sleeve, wide, glove } = dressOf(look);
  const hand = glove ?? LOOK_CHOICES.skin[look.skin].color!;
  const cloth = wide ? [cylinder(0.072, 0.13, 0.27, sleeve, 0, -0.12, 0, 10), sphere(0.074, sleeve, 0, 0.01, 0, 1, 1, 1, 10)] : [capsule(look.body === 1 ? 0.062 : 0.07, 0.15, sleeve).translate(0, -0.11, 0)];
  return merged([...cloth, sphere(0.078, hand, 0, -0.25, 0, 1, 1, 1, 10), ...heldParts(held)]);
}

export function legGeometry(look: Look): THREE.BufferGeometry {
  const { leg, shoe } = dressOf(look);
  const skin = LOOK_CHOICES.skin[look.skin].color!;
  return merged([capsule(look.body === 1 ? 0.072 : 0.082, 0.07, leg).translate(0, -0.08, 0), ...shoeParts(look.shoes ?? 0, shoe, skin)]);
}

/** Mắt nữ to hơn một chút và có mi cong. Mắt không có màu riêng từng đỉnh vì dùng vật liệu đen chung. */
export function eyesGeometry(body: number): THREE.BufferGeometry {
  const eye = (x: number, size: number) => new THREE.SphereGeometry(size, 10, 8).scale(1, 1.2, 0.5).translate(x, 0, 0);
  if (body !== 1) return mergeGeometries([eye(-0.135, 0.046), eye(0.135, 0.046)])!;
  const lash = (side: number) => new THREE.SphereGeometry(0.022, 6, 6).scale(1.5, 0.42, 0.45).rotateZ(side * 0.75).translate(side * 0.19, 0.05, 0);
  return mergeGeometries([eye(-0.135, 0.052), eye(0.135, 0.052), lash(-1), lash(1)])!;
}
