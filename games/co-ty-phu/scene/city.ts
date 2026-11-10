// Khu phố đồ chơi giữa bàn cờ và nhà, khách sạn mọc trên đất. Dựng từ khối cơ bản, gộp lại cho ít lần vẽ.

import * as THREE from "three";
import { merged, painted, sphere } from "../../ma-soi/scene/parts.ts";

/** Mặt nỉ trong mâm xúc xắc giữa bàn cao chừng này: xúc xắc nằm trên đó. */
export const TRAY_TOP = 0.14;
/** Lòng mâm rộng chừng này tính từ tâm; vành mâm cao hơn mặt nỉ, bao quanh ngoài. */
export const TRAY_RADIUS = 2.1;

/** Một ô cửa sổ trên ảnh mặt tiền rộng chừng này, một tầng cao chừng này. */
const WINDOW = 0.9;
const FLOOR = 0.8;

/** Tô một màu cho cả khối nhưng giữ tọa độ ảnh, để ảnh cửa sổ nhân với màu tường. */
function tinted(geometry: THREE.BufferGeometry, color: string): THREE.BufferGeometry {
  const { r, g, b } = new THREE.Color(color);
  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) colors.set([r, g, b], i * 3);
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** Khối nhà có cửa sổ: tọa độ ảnh co giãn theo kích thước để cửa sổ đều nhau trên mọi nhà. Mái để trơn. */
function tower(width: number, height: number, depth: number, x: number, y: number, z: number, color: string): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(width, height, depth);
  const uv = geometry.attributes.uv as THREE.BufferAttribute;
  // Mặt hộp theo thứ tự +x, -x, +y, -y, +z, -z, mỗi mặt 4 đỉnh.
  for (let i = 0; i < uv.count; i++) {
    const face = Math.floor(i / 4);
    if (face === 2 || face === 3) {
      uv.setXY(i, 0.04, 0.04);
      continue;
    }
    const across = face < 2 ? depth : width;
    uv.setXY(i, uv.getX(i) * Math.max(1, Math.round(across / WINDOW)), uv.getY(i) * Math.max(1, Math.round(height / FLOOR)));
  }
  return tinted(geometry.translate(x, y + height / 2, z), color);
}

/**
 * Tòa tháp nhiều tầng thu nhỏ dần, có chóp, làm điểm nhấn giữa phố. Camera nhìn chéo từ góc Xuất phát nên tháp đứng ở nửa gần
 * camera, lệch khỏi đường nhìn vào mâm: đứng ở nửa xa thì che chữ trên các ô ở hai cạnh xa.
 */
const LANDMARK = { x: 6.0, z: 1.75 };

function landmark(x: number, z: number): THREE.BufferGeometry[] {
  return [
    tower(2.1, 2.8, 2.1, x, 0, z, "#9fd3ec"),
    tower(1.6, 2.4, 1.6, x, 2.8, z, "#8cc9e6"),
    tower(1.1, 1.0, 1.1, x, 5.2, z, "#f2c14e"),
  ];
}

/** Những phần không có cửa sổ: mái, chóp, cây, đài phun nước. */
function plainParts(): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  // Chóp tháp.
  parts.push(painted(new THREE.ConeGeometry(0.2, 1.2, 8).translate(LANDMARK.x, 6.8, LANDMARK.z), "#f2c14e"));
  // Mái ngói hình chóp cho mấy nhà thấp: hình nón bốn cạnh xoay 45 độ thì đáy vuông, cạnh bằng bán kính nhân căn hai.
  const roof = (x: number, z: number, width: number, y: number, color: string) =>
    painted(new THREE.ConeGeometry((width / Math.SQRT2) * 1.08, 0.9, 4).rotateY(Math.PI / 4).translate(x, y + 0.45, z), color);
  parts.push(roof(-2.7, 2.9, 1.7, 1.6, "#c8352a"), roof(-5.5, 2.5, 1.5, 1.2, "#b5562f"), roof(5.6, 5.6, 1.7, 1.8, "#c8352a"));
  // Cây tròn ven đường.
  const tree = (x: number, z: number, size = 1) => [
    painted(new THREE.CylinderGeometry(0.07 * size, 0.09 * size, 0.5 * size, 6).translate(x, 0.25 * size, z), "#7a5236"),
    sphere(0.38 * size, "#3f9a4f", x, 0.75 * size, z, 1, 1, 1, 8),
  ];
  const spots = [
    [-1.35, -2.6], [1.35, -2.6], [-1.35, 2.6], [1.35, 2.6], [-1.6, -6.8], [1.6, -6.8], [-1.6, 6.8], [1.6, 6.8],
    [-6.8, -1.5], [-6.8, 1.5], [6.8, -1.5], [-3.9, 6.6], [3.9, 6.8], [-6.7, 4.2], [6.6, 3.9],
    [-4.0, -1.4], [4.0, 1.4], [-1.4, 4.2], [1.4, -4.1],
  ];
  // Cây sát hai cạnh xa camera thấp hơn, kẻo che chữ trên ô.
  spots.forEach(([x, z], i) => parts.push(...tree(x, z, x < -6 || z < -6 ? 0.8 : [0.9, 1.05, 1.2][i % 3])));
  // Mâm tung xúc xắc giữa quảng trường, để cả bàn cùng nhìn số: đế vàng, lòng nỉ đỏ, vành tròn cao hơn mặt nỉ.
  parts.push(painted(new THREE.CylinderGeometry(TRAY_RADIUS + 0.18, TRAY_RADIUS + 0.28, 0.12, 40).translate(0, 0.06, 0), "#c98f2e"));
  parts.push(painted(new THREE.CylinderGeometry(TRAY_RADIUS, TRAY_RADIUS, 0.04, 40).translate(0, TRAY_TOP - 0.02, 0), "#8e1b1b"));
  parts.push(painted(new THREE.TorusGeometry(TRAY_RADIUS + 0.08, 0.08, 8, 48).rotateX(Math.PI / 2).translate(0, TRAY_TOP - 0.01, 0), "#e2b04a"));
  return parts;
}

/** Dãy nhà xa quanh bàn cờ để nền không trống: cao thấp xen nhau, màu nhạt dần như chìm trong sương. */
function skyline(): THREE.BufferGeometry[] {
  const colors = ["#dfe9f1", "#e8dccb", "#cfe0ea", "#f0e2d0", "#d6e4d8"];
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 44; i++) {
    const angle = (i / 44) * Math.PI * 2 + (i % 2) * 0.05;
    const radius = 31 + (i % 3) * 4;
    const height = 2 + ((i * 7) % 11) * 0.55;
    const width = 2.6 + (i % 4) * 0.6;
    parts.push(tower(width, height, width, Math.cos(angle) * radius, -0.55, Math.sin(angle) * radius, colors[i % colors.length]));
  }
  return parts;
}

/** Khu phố: nhà cao tầng gắn ảnh cửa sổ, và phần trơn tô màu. Chừa hai con đường và quảng trường giữa. */
export function cityGeometry(): { towers: THREE.BufferGeometry; plain: THREE.BufferGeometry } {
  // Nhà cao đứng ở nửa gần camera; nửa xa (phía cạnh trái và hàng trên) chỉ có nhà thấp, kẻo che chữ trên các ô ở xa.
  const towers = merged([
    ...skyline(),
    ...landmark(LANDMARK.x, LANDMARK.z),
    tower(1.8, 2.0, 1.6, -2.6, 0, -5.4, "#f4d9a6"),
    tower(1.6, 1.9, 1.8, -5.5, 0, -2.7, "#f2a65a"),
    tower(2.0, 1.6, 2.0, -5.6, 0, -5.6, "#e9e4dc"),
    tower(1.4, 2.2, 1.4, -2.6, 0, -2.6, "#c5e1a5"),
    tower(1.7, 1.6, 1.7, -2.7, 0, 2.9, "#f7d6a0"),
    tower(2.0, 1.8, 1.8, -5.4, 0, 5.4, "#f7c6c7"),
    tower(1.5, 1.2, 1.5, -5.5, 0, 2.5, "#f4e3b5"),
    tower(1.8, 2.6, 1.8, 2.7, 0, 2.7, "#b9d7f0"),
    tower(1.7, 1.8, 1.7, 5.6, 0, 5.6, "#f4d9a6"),
    tower(1.6, 2.0, 1.6, 2.6, 0, 5.6, "#c5e1a5"),
    tower(1.5, 2.6, 1.5, 2.5, 0, -2.6, "#f7c6c7"),
    tower(1.8, 1.6, 1.6, 6.0, 0, -5.8, "#e9e4dc"),
  ]);
  return { towers, plain: merged(plainParts()) };
}

/** Hạng nhà theo bộ màu: đất càng đắt nhà càng hiện đại. Hai bộ rẻ nhất là nhà mái ngói, rồi nhà phố cổ, nhà phố hiện đại, cao ốc kính. */
export const TIER_OF_GROUP = [0, 0, 1, 1, 2, 2, 3, 3];
export const TIERS = 4;
/** Bốn nhà xếp hàng trên dải màu, nhà nọ cách nhà kia chừng này. */
export const HOUSE_SLOT = 0.42;

// Nhà trên đất dựng theo đúng cách nhà trong thị trấn, chỉ thu nhỏ cho vừa dải màu: nền đá, tường, cửa sổ sáng đèn có khung,
// kính sẫm dưới sáng trên như đang soi trời, mái ngói có bờ nóc. Mái chỉ chìa ra một chút vì camera nhìn chếch từ trên xuống,
// mái chìa sâu thì che mất mặt tiền. Gốc ở giữa chân nhà, mặt tiền nhìn về +z, tức ra phía ngoài bàn.

type Parts = THREE.BufferGeometry[];

const HOUSE_WIDTH = 0.38;
const HOUSE_DEPTH = 0.5;
const HOTEL_WIDTH = 1.6;
const HOTEL_DEPTH = 0.54;

const STONE = "#9a9082";
const GRANITE = "#34353c";
const CONCRETE = "#c9c5bd";
const GOLD = "#d8a944";
const LIT = "#f6d98a";
const STEEL = "#d9dde3";
const LEAF = "#47713e";
const WHITE = "#f5f4f0";
const CREAM = "#fbf3df";
const WOOD = "#6b3a1e";
const TEAK = "#a0673a";
const POT = "#a0522d";
const SHUTTER = "#2f6b4f";
const FLOWER = "#d63a5f";
const LANTERN = "#e8473c";
const RIDGE = "#6b2416";

/** Khối hộp, đáy đặt ở độ cao `y`. */
function box(width: number, height: number, depth: number, color: string, x = 0, y = 0, z = 0): THREE.BufferGeometry {
  return painted(new THREE.BoxGeometry(width, height, depth).translate(x, y + height / 2, z), color);
}

/** Cột tròn, chân đặt ở độ cao `y`. */
function post(radius: number, height: number, color: string, x: number, y: number, z: number, segments = 6): THREE.BufferGeometry {
  return painted(new THREE.CylinderGeometry(radius, radius, height, segments).translate(x, y + height / 2, z), color);
}

/** Khối kính: dưới sẫm, trên sáng như đang soi bầu trời. Màu theo đỉnh nên không tốn thêm vật liệu. */
function glass(width: number, height: number, depth: number, bottom: string, top: string, x = 0, y = 0, z = 0): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(width, height, depth).translate(x, y + height / 2, z);
  const position = geometry.attributes.position;
  const low = new THREE.Color(bottom);
  const high = new THREE.Color(top);
  const color = new THREE.Color();
  const colors = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    color.copy(low).lerp(high, (position.getY(i) - y) / height);
    colors.set([color.r, color.g, color.b], i * 3);
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.deleteAttribute("uv");
  return geometry;
}

/** Mái hai dốc có bờ nóc chạy theo bề ngang: lăng trụ tam giác, đáy mái ở độ cao `y`, tâm mái ở `z`. */
function gable(length: number, span: number, rise: number, y: number, color: string, z = 0): Parts {
  // Hình trụ 3 cạnh có một đỉnh ở +z: xoay cho đỉnh lên trời và trục theo bề ngang, rồi kéo cho vừa.
  const prism = new THREE.CylinderGeometry(1, 1, length, 3).rotateX(-Math.PI / 2).rotateY(Math.PI / 2);
  prism.scale(1, rise / 1.5, span / 2 / 0.866).translate(0, y + rise / 3, z);
  return [painted(prism, color), box(length + 0.02, 0.025, 0.035, RIDGE, 0, y + rise - 0.015, z)];
}

/** Mái kiểu Pháp: bốn mặt dốc, đỉnh bằng. */
function mansard(width: number, depth: number, height: number, y: number, color: string, z = 0): THREE.BufferGeometry {
  const frustum = new THREE.CylinderGeometry(Math.SQRT1_2 * 0.78, Math.SQRT1_2, height, 4, 1).rotateY(Math.PI / 4);
  return painted(frustum.scale(width, 1, depth).translate(0, y + height / 2, z), color);
}

/** Ô cửa sáng đèn có khung, mặt kính nhô hơn khung một chút cho khỏi nhấp nháy. */
function pane(width: number, height: number, frame: string, x: number, y: number, z: number): Parts {
  return [box(width + 0.016, height + 0.016, 0.01, frame, x, y - 0.008, z), box(width, height, 0.014, LIT, x, y, z)];
}

/** Chậu cây tròn trước cửa. */
function potted(x: number, z: number, size = 1): Parts {
  return [post(0.025 * size, 0.04 * size, POT, x, 0.025, z, 8), sphere(0.042 * size, LEAF, x, 0.065 + 0.035 * size, z, 1, 0.9, 1, 7)];
}

/** Hạng một, nhà: nhà mái ngói một gian, cửa gỗ, hai cửa sổ sáng đèn, hai chậu cây trên hiên gạch. */
function cottage(): Parts {
  const front = 0.13;
  return [
    box(HOUSE_WIDTH, 0.025, HOUSE_DEPTH, STONE),
    box(0.3, 0.005, 0.1, "#c98f5f", 0, 0.025, front + 0.055),
    box(0.32, 0.2, 0.34, "#f1dcae", 0, 0.025, front - 0.17),
    box(0.075, 0.13, 0.012, WOOD, 0, 0.025, front),
    ...[-1, 1].flatMap((side) => [...pane(0.06, 0.06, WOOD, side * 0.095, 0.09, front), ...potted(side * 0.13, front + 0.07, 0.85)]),
    ...gable(0.36, 0.44, 0.18, 0.225, "#c4532f", front - 0.18),
  ];
}

/** Hạng một, khách sạn: nhà nghỉ hai tầng mái ngói, ban công gỗ chạy dài treo hoa, cửa lá sách xanh, đèn lồng đỏ. */
function guesthouse(): Parts {
  const front = 0.11;
  return [
    box(HOTEL_WIDTH, 0.025, HOTEL_DEPTH, STONE),
    box(1.5, 0.44, 0.36, "#f3e2bd", 0, 0.025, front - 0.18),
    box(0.14, 0.17, 0.012, WOOD, 0, 0.025, front),
    ...[-0.6, -0.36, 0.36, 0.6].flatMap((x) => pane(0.1, 0.09, WOOD, x, 0.08, front)),
    ...[-1, 1].flatMap((side) => potted(side * 0.18, front + 0.09)),
    ...[-0.6, -0.36, -0.12, 0.12, 0.36, 0.6].flatMap((x) => pane(0.09, 0.13, SHUTTER, x, 0.275, front)),
    box(1.52, 0.02, 0.1, "#8a5a3b", 0, 0.235, front + 0.05),
    box(1.52, 0.045, 0.012, "#5a3a22", 0, 0.255, front + 0.094),
    ...[-0.48, -0.24, 0, 0.24, 0.48].map((x) => sphere(0.024, FLOWER, x, 0.31, front + 0.085, 1.4, 0.8, 1, 6)),
    ...[-0.72, 0.72].map((x) => sphere(0.028, LANTERN, x, 0.18, front + 0.08, 1, 1.25, 1, 8)),
    ...gable(1.6, 0.48, 0.22, 0.465, "#b5452a", front - 0.2),
  ];
}

/** Hạng hai, nhà: nhà phố cổ hai tầng tường vàng, gian hàng gỗ có biển đỏ, ban công hoa, cửa sổ lá sách, đèn lồng. */
function shophouse(): Parts {
  const front = 0.15;
  return [
    box(HOUSE_WIDTH, 0.025, HOUSE_DEPTH, STONE),
    box(0.34, 0.4, 0.4, "#f2c94c", 0, 0.025, front - 0.2),
    ...pane(0.22, 0.12, WOOD, 0, 0.04, front),
    box(0.16, 0.03, 0.012, "#c8321e", 0, 0.172, front),
    box(0.34, 0.015, 0.06, "#7a4b30", 0, 0.205, front + 0.03),
    box(0.34, 0.035, 0.008, "#5a3a22", 0, 0.22, front + 0.056),
    ...[-0.1, 0, 0.1].map((x) => sphere(0.018, FLOWER, x, 0.262, front + 0.05, 1.4, 0.8, 1, 6)),
    ...[-1, 1].flatMap((side) => [
      ...pane(0.06, 0.09, SHUTTER, side * 0.08, 0.26, front),
      box(0.028, 0.09, 0.012, SHUTTER, side * 0.026, 0.26, front + 0.002),
      box(0.028, 0.09, 0.012, SHUTTER, side * 0.134, 0.26, front + 0.002),
      sphere(0.02, LANTERN, side * 0.14, 0.165, front + 0.05, 1, 1.25, 1, 8),
    ]),
    ...gable(0.36, 0.44, 0.16, 0.425, "#a8452c", front - 0.19),
  ];
}

/** Hạng hai, khách sạn: khách sạn kiểu Pháp ba tầng, tường vàng gờ trắng, cửa lá sách xanh, ban công sắt, mái dốc bốn phía. */
function colonial(): Parts {
  const front = 0.12;
  const body = front - 0.19;
  const opening = (x: number, y: number): Parts => [
    ...pane(0.08, 0.12, CREAM, x, y, front),
    box(0.03, 0.12, 0.012, SHUTTER, x - 0.066, y, front + 0.002),
    box(0.03, 0.12, 0.012, SHUTTER, x + 0.066, y, front + 0.002),
  ];
  const columns = [-0.63, -0.42, -0.21, 0, 0.21, 0.42, 0.63];
  return [
    box(HOTEL_WIDTH, 0.025, HOTEL_DEPTH, STONE),
    box(1.5, 0.66, 0.38, "#f2c94c", 0, 0.025, body),
    ...[0.235, 0.455].map((y) => box(1.53, 0.022, 0.4, CREAM, 0, y, body)),
    box(1.56, 0.04, 0.42, CREAM, 0, 0.685, body),
    ...pane(0.16, 0.16, GOLD, 0, 0.035, front),
    box(0.3, 0.015, 0.1, "#c8321e", 0, 0.205, front + 0.05),
    ...columns.filter((x) => x !== 0).flatMap((x) => opening(x, 0.065)),
    ...[0.28, 0.5].flatMap((y) => columns.flatMap((x) => opening(x, y))),
    ...columns.map((x) => box(0.13, 0.03, 0.03, "#2b2b2b", x, 0.27, front + 0.015)),
    ...[-1, 1].flatMap((side) => potted(side * 0.12, front + 0.1)),
    mansard(1.56, 0.42, 0.15, 0.725, "#a8452c", body),
  ];
}

/** Hạng ba, nhà: nhà phố hiện đại ba tầng tường trắng, mặt kính, lam gỗ, ban công kính, vườn và bồn nước inox trên sân thượng. */
function townhouse(): Parts {
  const front = 0.15;
  const roof = 0.635;
  return [
    box(HOUSE_WIDTH, 0.025, HOUSE_DEPTH, CONCRETE),
    box(0.34, 0.58, 0.4, WHITE, 0, 0.025, front - 0.2),
    ...pane(0.17, 0.13, GRANITE, -0.05, 0.035, front),
    glass(0.2, 0.36, 0.014, "#3f5f77", "#bfe0f2", -0.05, 0.215, front),
    box(0.09, 0.56, 0.016, TEAK, 0.115, 0.035, front),
    box(0.36, 0.02, 0.05, WHITE, 0, 0.195, front + 0.015),
    box(0.36, 0.015, 0.08, WHITE, 0, 0.385, front + 0.03),
    glass(0.36, 0.045, 0.006, "#a8d4ec", "#e8f5fc", 0, 0.4, front + 0.067),
    sphere(0.03, LEAF, 0.12, 0.43, front + 0.035, 1, 0.9, 1, 7),
    box(0.36, 0.03, 0.42, "#e6e3dc", 0, roof - 0.03, front - 0.2),
    box(0.26, 0.012, 0.3, "#6f9a4e", 0, roof, front - 0.21),
    post(0.03, 0.07, "#c7ccd3", -0.09, roof + 0.012, -0.15, 12),
    post(0.006, 0.05, "#6b4a2f", 0.08, roof + 0.012, -0.07),
    sphere(0.045, LEAF, 0.08, roof + 0.085, -0.07, 1, 0.9, 1, 7),
  ];
}

/** Hạng ba, khách sạn: khách sạn năm tầng tường trắng, sảnh kính có mái che, ban công kính từng tầng, hồ bơi và dù trên sân thượng. */
function resort(): Parts {
  const front = 0.14;
  const body = front - 0.2;
  const top = 1.185;
  return [
    box(HOTEL_WIDTH, 0.03, HOTEL_DEPTH, CONCRETE),
    glass(1.36, 0.2, 0.34, "#22313f", "#6f90ad", 0, 0.03, front - 0.21),
    box(0.32, 0.15, 0.014, LIT, 0, 0.03, front - 0.04),
    box(0.5, 0.02, 0.15, STEEL, 0, 0.2, front + 0.035),
    box(0.3, 0.035, 0.01, GOLD, 0, 0.202, front + 0.115),
    box(1.5, 0.92, 0.4, WHITE, 0, 0.23, body),
    ...[0.27, 0.49, 0.71, 0.93].flatMap((y) => [
      glass(1.36, 0.15, 0.012, "#3d6f93", "#bfe0f2", 0, y, front),
      box(1.44, 0.014, 0.05, WHITE, 0, y - 0.025, front + 0.025),
      box(1.44, 0.03, 0.006, "#cfe8f5", 0, y - 0.011, front + 0.047),
    ]),
    ...[-1, 1].map((side) => box(0.05, 0.92, 0.05, TEAK, side * 0.73, 0.23, front)),
    box(1.52, 0.035, 0.42, "#e6e3dc", 0, top - 0.035, body),
    box(1.42, 0.008, 0.34, "#c9a27a", 0, top, body),
    box(0.62, 0.006, 0.2, "#4fc3e8", -0.3, top + 0.004, body),
    ...[-0.5, -0.38, -0.26].map((x) => box(0.05, 0.012, 0.08, WHITE, x, top + 0.008, front - 0.045)),
    ...([[0.22, "#e9b949"], [0.46, "#c8321e"]] as const).flatMap(([x, color]) => [
      post(0.006, 0.09, WHITE, x, top + 0.008, front - 0.24),
      painted(new THREE.ConeGeometry(0.075, 0.035, 8).translate(x, top + 0.115, front - 0.24), color),
    ]),
    sphere(0.05, LEAF, 0.64, top + 0.05, front - 0.06, 1, 0.9, 1, 7),
    sphere(0.05, LEAF, -0.66, top + 0.05, front - 0.34, 1, 0.9, 1, 7),
  ];
}

/** Hạng tư, nhà: cao ốc kính trên đế đá sẫm, sảnh sáng đèn, khung thép, vạch tầng, ăng-ten có đèn đỏ. */
function glassTower(): Parts {
  const front = 0.13;
  const body = front - 0.17;
  return [
    box(HOUSE_WIDTH, 0.12, 0.48, GRANITE),
    ...pane(0.18, 0.08, STEEL, 0, 0.015, 0.24),
    glass(0.3, 0.86, 0.34, "#1f3a57", "#86bce0", 0, 0.12, body),
    ...[-0.075, 0, 0.075].map((x) => box(0.012, 0.86, 0.01, STEEL, x, 0.12, front)),
    // Vạch tầng nhô hơn khung đứng một chút để chỗ bắt chéo không nhấp nháy.
    ...[0.3, 0.47, 0.64, 0.81].map((y) => box(0.31, 0.01, 0.36, STEEL, 0, y, body)),
    box(0.26, 0.05, 0.3, STEEL, 0, 0.98, body),
    post(0.006, 0.18, "#9aa1aa", 0.07, 1.03, -0.1, 4),
    sphere(0.016, "#ff3b30", 0.07, 1.215, -0.1, 1, 1, 1, 6),
  ];
}

/** Hạng tư, khách sạn: tháp kính sẫm hai cánh như casino trong thị trấn, cột vàng, viền neon, vương miện vàng có chóp. */
function skyTower(): Parts {
  const front = 0.15;
  const body = front - 0.2;
  return [
    box(HOTEL_WIDTH, 0.26, HOTEL_DEPTH, GRANITE),
    ...pane(0.5, 0.17, GOLD, 0, 0.03, HOTEL_DEPTH / 2),
    box(0.7, 0.025, 0.06, GOLD, 0, 0.215, HOTEL_DEPTH / 2 + 0.03),
    glass(0.8, 1.5, 0.4, "#161b36", "#5468a8", 0, 0.26, body),
    ...[-1, 1].flatMap((side) => [
      glass(0.3, 0.9, 0.36, "#1d2747", "#6a80bb", side * 0.6, 0.26, body - 0.01),
      ...[0.5, 0.75, 1.0].map((y) => box(0.31, 0.012, 0.37, STEEL, side * 0.6, y, body - 0.01)),
      box(0.32, 0.03, 0.38, STEEL, side * 0.6, 1.16, body - 0.01),
      box(0.03, 1.5, 0.03, GOLD, side * 0.4, 0.26, front),
    ]),
    ...[0.75, 1.25].map((y) => box(0.82, 0.022, 0.42, "#ff3fb4", 0, y, body)),
    box(0.82, 0.022, 0.42, "#3fe0ff", 0, 1.7, body),
    glass(0.5, 0.3, 0.28, "#22305a", "#7a90d0", 0, 1.76, body),
    box(0.56, 0.06, 0.34, GOLD, 0, 2.06, body),
    painted(new THREE.ConeGeometry(0.07, 0.36, 8).translate(0, 2.3, body), GOLD),
    sphere(0.02, "#ff3b30", 0, 2.5, body, 1, 1, 1, 6),
  ];
}

const DESIGNS: [house: () => Parts, hotel: () => Parts][] = [
  [cottage, guesthouse],
  [shophouse, colonial],
  [townhouse, resort],
  [glassTower, skyTower],
];

/** Nhà (`hotel` sai) hoặc khách sạn của hạng `tier`, gộp thành một khối để vẽ cả loạt nhà cùng kiểu một lượt. */
export function buildingGeometry(tier: number, hotel: boolean): THREE.BufferGeometry {
  return merged(DESIGNS[tier][hotel ? 1 : 0]());
}
