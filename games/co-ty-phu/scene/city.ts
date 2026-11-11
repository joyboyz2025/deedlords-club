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

/** Phần không có cửa sổ: mâm tung xúc xắc. Khu phố giữa bàn giờ là ảnh in trên mặt bàn (`drawCenter`), không còn khối 3D che chữ. */
function plainParts(): THREE.BufferGeometry[] {
  // Mâm đặt trên vòng xuyến giữa ảnh, để cả bàn cùng nhìn số: đế trắng, lòng nỉ xanh cổ vịt, vành san hô cao hơn mặt nỉ.
  return [
    painted(new THREE.CylinderGeometry(TRAY_RADIUS + 0.18, TRAY_RADIUS + 0.28, 0.12, 40).translate(0, 0.06, 0), "#f4f6f8"),
    painted(new THREE.CylinderGeometry(TRAY_RADIUS, TRAY_RADIUS, 0.04, 40).translate(0, TRAY_TOP - 0.02, 0), "#157f8c"),
    painted(new THREE.TorusGeometry(TRAY_RADIUS + 0.08, 0.08, 8, 48).rotateX(Math.PI / 2).translate(0, TRAY_TOP - 0.01, 0), "#f0624d"),
  ];
}

/** Dãy nhà xa quanh bàn cờ để nền không trống: cao thấp xen nhau, màu nhạt dần như chìm trong sương. */
function skyline(): THREE.BufferGeometry[] {
  const colors = ["#dfe9f1", "#e6ebef", "#cfe0ea", "#f1f3f5", "#d6e4e2"];
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

/** Dãy nhà xa gắn ảnh cửa sổ, và phần trơn tô màu (mâm xúc xắc). */
export function cityGeometry(): { towers: THREE.BufferGeometry; plain: THREE.BufferGeometry } {
  return { towers: merged(skyline()), plain: merged(plainParts()) };
}

/** Hạng nhà theo bộ màu: đất càng đắt nhà càng lớn. Quầy hàng, nhà phố, biệt thự, biệt thự ba tầng; khách sạn nhỏ, khách sạn lớn, tháp nghỉ dưỡng, tháp kính. */
export const TIER_OF_GROUP = [0, 0, 1, 1, 2, 2, 3, 3];
export const TIERS = 4;
/** Bốn nhà xếp hàng trên dải màu, nhà nọ cách nhà kia chừng này. */
export const HOUSE_SLOT = 0.42;

// Nhà trên đất ghép từ khối cơ bản theo bộ ảnh ý tưởng trong `_notes/concepts/pack`: tường trắng, kính xanh, điểm màu san hô,
// xanh cổ vịt và xanh cô-ban, sân thượng có dù, cây và hồ bơi. Ánh sáng trắng, không ngả vàng. Camera nhìn chếch từ trên xuống
// nên chi tiết dồn vào mặt tiền và mái. Gốc ở giữa chân nhà, mặt tiền nhìn về +z, tức ra phía ngoài bàn.

type Parts = THREE.BufferGeometry[];

const HOUSE_WIDTH = 0.38;
const HOUSE_DEPTH = 0.5;
const HOTEL_WIDTH = 1.6;
const HOTEL_DEPTH = 0.54;

const WHITE = "#f7f8f9";
const SHADE = "#dfe5ea";
const PLINTH = "#c9d0d7";
const CORAL = "#f0624d";
const TEAL = "#16939b";
const DEEP = "#1d5c68";
const COBALT = "#2f6fdc";
const NAVY = "#22384d";
const FRAME = "#2b3640";
const WOOD = "#b9824f";
const DECK = "#dcbf93";
const LEAF = "#3f9a4f";
const LIME = "#6dbb55";
const POOL = "#3fc3ea";
const LIT = "#ffe9b0";
const STEEL = "#e3e8ed";
const TRUNK = "#7a5a3c";
const PETAL = "#5b8def";
const BLOSSOM = "#ffffff";
/** Kính: dưới sẫm, trên sáng như đang soi trời. */
const GLASS: [string, string] = ["#2e6f9e", "#c4e6f7"];
const RAIL: [string, string] = ["#a9d6ee", "#e9f6fc"];

/** Khối hộp, đáy đặt ở độ cao `y`. */
function box(width: number, height: number, depth: number, color: string, x = 0, y = 0, z = 0): THREE.BufferGeometry {
  return painted(new THREE.BoxGeometry(width, height, depth).translate(x, y + height / 2, z), color);
}

/** Cột tròn, chân đặt ở độ cao `y`. */
function post(radius: number, height: number, color: string, x: number, y: number, z: number, segments = 6): THREE.BufferGeometry {
  return painted(new THREE.CylinderGeometry(radius, radius, height, segments).translate(x, y + height / 2, z), color);
}

/** Khối kính đổi màu từ dưới lên. Màu theo đỉnh nên không tốn thêm vật liệu. */
function glass(width: number, height: number, depth: number, [bottom, top]: [string, string], x = 0, y = 0, z = 0): THREE.BufferGeometry {
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

/** Ô cửa sáng đèn có khung, mặt kính nhô hơn khung một chút cho khỏi nhấp nháy. */
function pane(width: number, height: number, frame: string, x: number, y: number, z: number): Parts {
  return [box(width + 0.016, height + 0.016, 0.01, frame, x, y - 0.008, z), box(width, height, 0.014, LIT, x, y, z)];
}

/** Mái hiên vải sọc hai màu, dốc xuống phía trước; mép sát tường ở độ cao `y`. */
function awning(width: number, depth: number, y: number, z: number, a: string, b: string, x = 0): Parts {
  const slope = 0.5;
  const stripes = Math.max(3, Math.round(width / 0.05)) | 1;
  const each = width / stripes;
  return Array.from({ length: stripes }, (_, i) =>
    painted(
      new THREE.BoxGeometry(each, 0.012, depth)
        .rotateX(slope)
        .translate(x - width / 2 + each * (i + 0.5), y - (depth / 2) * Math.sin(slope), z + (depth / 2) * Math.cos(slope)),
      i % 2 ? b : a,
    ),
  );
}

/** Dù che nắng trên sân thượng. */
function parasol(x: number, y: number, z: number, color: string, size = 1): Parts {
  return [post(0.005 * size, 0.1 * size, STEEL, x, y, z, 5), painted(new THREE.ConeGeometry(0.085 * size, 0.035 * size, 8).translate(x, y + 0.115 * size, z), color)];
}

/** Bồn hoa dài: thành gỗ, cây xen hoa màu `bloom`. */
function planter(width: number, x: number, y: number, z: number, bloom: string = LEAF): Parts {
  const count = Math.max(1, Math.round(width / 0.05));
  return [
    box(width, 0.022, 0.032, WOOD, x, y, z),
    ...Array.from({ length: count }, (_, i) => sphere(0.022, i % 2 ? bloom : LEAF, x - width / 2 + (width / count) * (i + 0.5), y + 0.032, z, 1.2, 0.9, 1, 6)),
  ];
}

/** Chậu cây tròn trước cửa. */
function potted(x: number, z: number, size = 1, y = 0.02): Parts {
  return [post(0.022 * size, 0.035 * size, WHITE, x, y, z, 8), sphere(0.04 * size, LEAF, x, y + 0.04 + 0.03 * size, z, 1, 0.9, 1, 7)];
}

/** Cây tán tròn hai lớp lá. */
function tree(x: number, y: number, z: number, size = 1): Parts {
  return [
    post(0.008 * size, 0.07 * size, TRUNK, x, y, z, 5),
    sphere(0.055 * size, LEAF, x, y + 0.1 * size, z, 1, 0.85, 1, 7),
    sphere(0.038 * size, LIME, x + 0.028 * size, y + 0.128 * size, z + 0.01 * size, 1, 0.85, 1, 6),
  ];
}

/** Cây cọ: thân cao, tán dẹt. */
function palm(x: number, y: number, z: number, size = 1): Parts {
  return [
    post(0.007 * size, 0.15 * size, TRUNK, x, y, z, 5),
    sphere(0.07 * size, LEAF, x, y + 0.155 * size, z, 1, 0.28, 1, 7),
    sphere(0.042 * size, LIME, x, y + 0.172 * size, z, 1, 0.35, 1, 6),
  ];
}

/** Hồ bơi: thành trắng, mặt nước xanh. */
function pool(width: number, depth: number, x: number, y: number, z: number): Parts {
  return [box(width + 0.024, 0.012, depth + 0.024, WHITE, x, y, z), box(width, 0.015, depth, POOL, x, y, z)];
}

/** Ban công: sàn mỏng chìa ra trước, lan can kính ở mép. */
function balcony(width: number, x: number, y: number, z: number, depth = 0.045): Parts {
  return [box(width, 0.012, depth, SHADE, x, y, z + depth / 2), glass(width, 0.03, 0.005, RAIL, x, y + 0.012, z + depth - 0.003)];
}

/** Tường chắn mái bốn phía quanh sân thượng rộng `width`, sâu `depth`, tâm ở `z`. */
function parapet(width: number, depth: number, y: number, z: number, color: string, height = 0.035): Parts {
  return [
    box(width, height, 0.012, color, 0, y, z + depth / 2 - 0.006),
    box(width, height, 0.012, color, 0, y, z - depth / 2 + 0.006),
    box(0.012, height, depth, color, -width / 2 + 0.006, y, z),
    box(0.012, height, depth, color, width / 2 - 0.006, y, z),
  ];
}

/** Hạng một, nhà: quầy hàng nhỏ tường trắng, mái hiên sọc xanh cổ vịt, sân thượng có bàn và dù san hô, bồn hoa trước cửa. */
function kiosk(): Parts {
  const front = 0.1;
  const body = front - 0.16;
  const roof = 0.22;
  return [
    box(HOUSE_WIDTH, 0.02, HOUSE_DEPTH, PLINTH),
    box(0.32, 0.2, 0.32, WHITE, 0, 0.02, body),
    box(0.335, 0.016, 0.335, TEAL, 0, roof - 0.016, body),
    ...parapet(0.34, 0.34, roof, body, WHITE),
    ...pane(0.15, 0.1, TEAL, -0.06, 0.05, front),
    glass(0.06, 0.14, 0.012, GLASS, 0.1, 0.02, front),
    ...awning(0.32, 0.09, 0.19, front, TEAL, WHITE),
    box(0.07, 0.03, 0.07, WOOD, 0.03, roof, body),
    ...parasol(0.03, roof, body, CORAL, 1.15),
    sphere(0.045, LEAF, -0.1, roof + 0.035, body - 0.09, 1, 0.9, 1, 7),
    ...planter(0.14, -0.1, 0.02, front + 0.11, PETAL),
    ...potted(0.13, front + 0.09),
  ];
}

/** Hạng hai, nhà: nhà phố hai tầng, gian hàng xanh sẫm có mái hiên sọc san hô, cửa sổ khung sẫm treo bồn hoa, sân thượng có lan can và chòi cầu thang. */
function townhouse(): Parts {
  const front = 0.12;
  const body = front - 0.18;
  const roof = 0.48;
  return [
    box(HOUSE_WIDTH, 0.02, HOUSE_DEPTH, PLINTH),
    box(0.34, 0.2, 0.36, DEEP, 0, 0.02, body),
    box(0.34, 0.25, 0.36, WHITE, 0, 0.22, body),
    box(0.36, 0.02, 0.38, DEEP, 0, 0.21, body),
    ...pane(0.19, 0.11, "#0f3d47", -0.05, 0.05, front),
    glass(0.06, 0.15, 0.012, GLASS, 0.11, 0.02, front),
    ...awning(0.34, 0.09, 0.2, front, CORAL, WHITE),
    ...[-1, 1].flatMap((side) => [...pane(0.08, 0.1, FRAME, side * 0.085, 0.3, front), ...planter(0.1, side * 0.085, 0.262, front + 0.02, BLOSSOM)]),
    box(0.36, 0.02, 0.38, SHADE, 0, roof - 0.02, body),
    ...parapet(0.35, 0.37, roof, body, FRAME, 0.03),
    box(0.12, 0.1, 0.12, WHITE, 0.08, roof, body - 0.09),
    box(0.05, 0.075, 0.01, FRAME, 0.08, roof, body - 0.028),
    sphere(0.045, LEAF, -0.1, roof + 0.04, body + 0.06, 1, 0.9, 1, 7),
    sphere(0.035, LIME, -0.11, roof + 0.035, body - 0.11, 1, 0.9, 1, 6),
    ...potted(0.14, front + 0.08),
    ...planter(0.14, -0.09, 0.02, front + 0.1, BLOSSOM),
  ];
}

/** Hạng ba, nhà: biệt thự hiện đại hai tầng, tầng trệt kính, sàn trắng chìa ra, mảng gỗ, pin mặt trời và cây trên mái, hồ bơi trước nhà. */
function villa(): Parts {
  const front = 0.05;
  const body = front - 0.13;
  return [
    box(HOUSE_WIDTH, 0.02, HOUSE_DEPTH, PLINTH),
    glass(0.26, 0.17, 0.26, GLASS, -0.04, 0.02, body),
    box(0.07, 0.17, 0.27, WOOD, 0.13, 0.02, body),
    box(0.045, 0.12, 0.012, TEAL, 0.06, 0.02, front),
    box(0.37, 0.02, 0.32, WHITE, 0, 0.19, body + 0.01),
    glass(0.37, 0.03, 0.005, RAIL, 0, 0.21, front + 0.035),
    box(0.3, 0.18, 0.24, WHITE, -0.02, 0.21, body - 0.03),
    glass(0.2, 0.12, 0.012, GLASS, -0.05, 0.235, body + 0.09),
    box(0.06, 0.16, 0.012, WOOD, 0.09, 0.22, body + 0.09),
    box(0.34, 0.02, 0.28, WHITE, -0.02, 0.39, body - 0.03),
    box(0.16, 0.008, 0.11, "#27508c", -0.08, 0.41, body - 0.03),
    box(0.165, 0.004, 0.012, STEEL, -0.08, 0.416, body - 0.03),
    ...tree(0.09, 0.41, body - 0.07, 1.7),
    ...pool(0.19, 0.09, -0.07, 0.02, front + 0.12),
    box(0.11, 0.012, 0.12, DECK, 0.12, 0.02, front + 0.12),
    ...parasol(0.12, 0.03, front + 0.13, WHITE, 0.75),
    box(0.3, 0.035, 0.028, LEAF, -0.02, 0.02, front + 0.215),
  ];
}

/** Hạng tư, nhà: biệt thự ba tầng lệch khối, hồ bơi trên sân tầng hai, vườn và cây trên mái, mảng gỗ, ga-ra có xe xanh. */
function mansion(): Parts {
  const front = 0.08;
  const body = front - 0.15;
  const second = 0.18;
  const third = 0.35;
  const roof = 0.51;
  return [
    box(HOUSE_WIDTH, 0.02, HOUSE_DEPTH, PLINTH),
    box(0.36, 0.16, 0.3, "#eceff2", 0, 0.02, body),
    box(0.05, 0.12, 0.012, WOOD, -0.13, 0.02, front),
    glass(0.1, 0.11, 0.012, GLASS, -0.04, 0.03, front),
    box(0.14, 0.1, 0.012, NAVY, 0.1, 0.02, front),
    box(0.1, 0.028, 0.07, COBALT, 0.1, 0.02, front + 0.08),
    box(0.07, 0.022, 0.04, "#1b3f8f", 0.1, 0.048, front + 0.075),
    box(0.38, 0.018, 0.34, WHITE, 0, second, body + 0.01),
    glass(0.2, 0.152, 0.24, GLASS, -0.08, second + 0.018, body - 0.03),
    box(0.02, 0.152, 0.25, WOOD, -0.18, second + 0.018, body - 0.03),
    ...pool(0.13, 0.13, 0.1, second + 0.018, body + 0.07),
    glass(0.38, 0.03, 0.005, RAIL, 0, second + 0.018, front + 0.027),
    sphere(0.03, LEAF, 0.16, second + 0.045, body - 0.1, 1, 0.9, 1, 6),
    box(0.3, 0.018, 0.3, WHITE, -0.04, third, body - 0.02),
    box(0.2, 0.142, 0.2, WHITE, -0.07, third + 0.018, body - 0.04),
    glass(0.13, 0.09, 0.012, GLASS, -0.09, third + 0.04, body + 0.06),
    box(0.04, 0.13, 0.012, WOOD, 0.005, third + 0.024, body + 0.06),
    box(0.24, 0.016, 0.24, WHITE, -0.07, roof, body - 0.04),
    box(0.18, 0.01, 0.18, LIME, -0.07, roof + 0.016, body - 0.04),
    ...tree(-0.09, roof + 0.02, body - 0.05, 1.8),
    sphere(0.03, LEAF, 0.0, roof + 0.045, body + 0.02, 1, 0.9, 1, 6),
    box(0.2, 0.035, 0.028, LEAF, -0.08, 0.02, front + 0.2),
    ...potted(-0.165, front + 0.07, 0.8),
  ];
}

/** Hạng một, khách sạn: khách sạn nhỏ bốn tầng tường trắng, cửa sổ khung xanh cổ vịt, ban công treo hoa, mái đón san hô, sân thượng có hai chiếc dù. */
function boutique(): Parts {
  const front = 0.1;
  const body = front - 0.18;
  const floor = 0.165;
  const roof = 0.025 + floor * 4;
  const columns = [-0.34, -0.17, 0, 0.17, 0.34];
  return [
    box(HOTEL_WIDTH, 0.025, HOTEL_DEPTH, PLINTH),
    box(0.9, floor * 4, 0.36, WHITE, 0, 0.025, body),
    ...[1, 2, 3].flatMap((level) => {
      const y = 0.025 + floor * level;
      return [
        box(0.92, 0.012, 0.38, SHADE, 0, y - 0.006, body),
        ...columns.flatMap((x) => pane(0.085, 0.1, TEAL, x, y + 0.035, front)),
        ...balcony(0.5, 0, y + 0.012, front, 0.04),
        ...[-1, 1].flatMap((side) => [box(0.1, 0.02, 0.03, WOOD, side * 0.34, y + 0.006, front + 0.02), box(0.09, 0.016, 0.024, PETAL, side * 0.34, y + 0.026, front + 0.02)]),
      ];
    }),
    glass(0.16, 0.13, 0.012, GLASS, 0, 0.025, front),
    box(0.28, 0.03, 0.1, CORAL, 0, 0.16, front + 0.05),
    ...[-0.34, -0.2, 0.2, 0.34].flatMap((x) => pane(0.085, 0.09, TEAL, x, 0.05, front)),
    box(0.94, 0.02, 0.4, SHADE, 0, roof, body),
    ...parapet(0.92, 0.38, roof + 0.02, body, WHITE, 0.03),
    box(0.16, 0.1, 0.14, WHITE, 0.34, roof + 0.02, body - 0.08),
    ...parasol(-0.24, roof + 0.02, body, CORAL, 1.2),
    ...parasol(0.04, roof + 0.02, body + 0.02, COBALT, 1.2),
    sphere(0.045, LEAF, -0.4, roof + 0.05, body - 0.1, 1, 0.9, 1, 7),
    sphere(0.04, LEAF, 0.2, roof + 0.05, body + 0.12, 1, 0.9, 1, 6),
    ...[-1, 1].flatMap((side) => [...tree(side * 0.64, 0.025, front - 0.1, 1.5), ...planter(0.2, side * 0.3, 0.025, front + 0.11, PETAL), ...potted(side * 0.12, front + 0.07, 0.9, 0.025)]),
  ];
}

/** Hạng hai, khách sạn: khách sạn sáu tầng trên sảnh kính, trụ góc san hô, ban công kính có ghế xanh, mái đón xanh cô-ban trên cửa xoay, quầy bar trên mái. */
function grand(): Parts {
  const front = 0.1;
  const body = front - 0.18;
  const lobby = 0.2;
  const floor = 0.15;
  const base = 0.025 + lobby;
  const roof = base + floor * 6;
  return [
    box(HOTEL_WIDTH, 0.025, HOTEL_DEPTH, PLINTH),
    glass(0.94, lobby, 0.34, ["#1f3a52", "#7fb4d6"], 0, 0.025, body),
    post(0.055, 0.15, RAIL[0], 0, 0.025, front + 0.02, 10),
    box(0.36, 0.035, 0.13, COBALT, 0, 0.175, front + 0.05),
    box(1.0, floor * 6, 0.36, WHITE, 0, base, body),
    ...[-1, 1].map((side) => box(0.045, floor * 6 + lobby, 0.045, CORAL, side * 0.5, 0.025, front - 0.005)),
    ...Array.from({ length: 6 }, (_, level) => {
      const y = base + floor * level;
      return [
        glass(0.88, floor * 0.6, 0.012, GLASS, 0, y + floor * 0.22, front),
        ...balcony(0.92, 0, y, front),
        box(0.03, 0.022, 0.022, COBALT, level % 2 ? -0.26 : 0.26, y + 0.012, front + 0.022),
        sphere(0.02, LEAF, level % 2 ? 0.3 : -0.3, y + 0.03, front + 0.022, 1, 1, 1, 5),
      ];
    }).flat(),
    box(1.04, 0.022, 0.4, SHADE, 0, roof, body),
    ...parapet(1.02, 0.38, roof + 0.022, body, WHITE, 0.03),
    box(0.3, 0.012, 0.16, WOOD, 0.1, roof + 0.13, body - 0.04),
    ...[-0.04, 0.24].flatMap((x) => [-0.11, 0.03].map((z) => post(0.006, 0.11, WOOD, x, roof + 0.022, body + z, 4))),
    box(0.2, 0.05, 0.06, DECK, 0.1, roof + 0.022, body - 0.05),
    ...parasol(-0.3, roof + 0.022, body + 0.03, CORAL, 1.1),
    ...parasol(0.4, roof + 0.022, body + 0.05, CORAL, 1.0),
    sphere(0.04, LEAF, -0.44, roof + 0.05, body - 0.12, 1, 0.9, 1, 6),
    ...[-1, 1].flatMap((side) => [...tree(side * 0.68, 0.025, front - 0.12, 1.6), box(0.2, 0.04, 0.03, LEAF, side * 0.34, 0.025, front + 0.13), ...potted(side * 0.22, front + 0.08, 0.9, 0.025)]),
  ];
}

/** Hạng ba, khách sạn: tháp nghỉ dưỡng hai đầu bo tròn, trục thang kính xanh giữa mặt tiền, ban công ôm vòng treo cây, mái đón tròn san hô, hồ bơi, cọ và dù trên mái. */
function resort(): Parts {
  const front = 0.1;
  const body = front - 0.18;
  const lobby = 0.2;
  const floor = 0.155;
  const floors = 7;
  const base = 0.025 + lobby;
  const roof = base + floor * floors;
  const ends = [-0.36, 0.36];
  return [
    box(HOTEL_WIDTH, 0.025, HOTEL_DEPTH, PLINTH),
    glass(0.8, lobby, 0.32, ["#1f3a52", "#7fb4d6"], 0, 0.025, body),
    post(0.17, 0.03, CORAL, 0, 0.17, front + 0.05, 12),
    ...pane(0.14, 0.12, STEEL, 0, 0.03, front + 0.002),
    box(0.72, floor * floors, 0.36, WHITE, 0, base, body),
    ...ends.map((x) => post(0.18, floor * floors, WHITE, x, base, body, 12)),
    glass(0.16, floor * floors + 0.06, 0.05, ["#1f6fb5", "#9ad4f5"], 0, base, front),
    ...Array.from({ length: floors }, (_, level) => {
      const y = base + floor * level;
      return [
        box(0.74, 0.012, 0.41, SHADE, 0, y, body),
        ...ends.map((x) => post(0.205, 0.012, SHADE, x, y, body, 8)),
        ...[-1, 1].map((side) => glass(0.24, floor * 0.56, 0.012, GLASS, side * 0.22, y + floor * 0.24, front)),
        box(0.07, 0.03, 0.02, level % 2 ? LIME : LEAF, level % 2 ? -0.3 : 0.3, y - 0.02, front + 0.03),
      ];
    }).flat(),
    box(0.74, 0.022, 0.4, WHITE, 0, roof, body),
    ...ends.map((x) => post(0.2, 0.022, WHITE, x, roof, body, 12)),
    ...pool(0.4, 0.14, -0.14, roof + 0.022, body + 0.04),
    box(0.3, 0.1, 0.2, WHITE, 0.3, roof + 0.022, body - 0.04),
    glass(0.2, 0.06, 0.012, GLASS, 0.3, roof + 0.04, body + 0.06),
    ...parasol(-0.3, roof + 0.022, body - 0.1, CORAL, 1.0),
    ...parasol(0.0, roof + 0.022, body - 0.11, CORAL, 1.0),
    ...palm(-0.46, roof + 0.022, body + 0.02, 0.9),
    ...palm(0.5, roof + 0.022, body + 0.05, 0.8),
    ...[-1, 1].flatMap((side) => [...palm(side * 0.68, 0.025, front + 0.02, 1.5), box(0.16, 0.04, 0.03, LEAF, side * 0.38, 0.025, front + 0.13)]),
  ];
}

/** Hạng tư, khách sạn: tháp kính xanh nhiều tầng vạch ban công trắng, sọc san hô, hai cánh thấp có hồ bơi và vườn mái, sân đỗ trực thăng trên đỉnh. */
function skyTower(): Parts {
  const front = 0.1;
  const body = front - 0.18;
  const podium = 0.26;
  const height = 1.7;
  const top = podium + height;
  return [
    box(HOTEL_WIDTH, 0.025, HOTEL_DEPTH, PLINTH),
    box(1.3, podium - 0.025, 0.4, WHITE, 0, 0.025, body),
    glass(1.1, 0.13, 0.012, ["#1f3a52", "#7fb4d6"], 0, 0.06, front + 0.02),
    ...pane(0.2, 0.15, CORAL, 0, 0.04, front + 0.022),
    box(0.42, 0.03, 0.13, CORAL, 0, 0.2, front + 0.07),
    glass(0.62, height, 0.36, ["#1b4f86", "#8fd0f4"], 0, podium, body),
    ...[-1, 1].map((side) => box(0.03, height, 0.38, WHITE, side * 0.32, podium, body)),
    box(0.035, height, 0.012, CORAL, 0.2, podium, front + 0.003),
    ...Array.from({ length: 11 }, (_, level) => box(0.66, 0.014, 0.4, WHITE, 0, podium + 0.145 * (level + 1), body)),
    // Cánh trái: kính, thấp hơn, hồ bơi trên mái.
    glass(0.32, 0.9, 0.32, GLASS, -0.49, podium, body),
    ...Array.from({ length: 5 }, (_, level) => box(0.34, 0.014, 0.35, WHITE, -0.49, podium + 0.15 * (level + 1), body)),
    box(0.34, 0.02, 0.35, WHITE, -0.49, podium + 0.9, body),
    ...pool(0.2, 0.18, -0.5, podium + 0.92, body),
    ...parasol(-0.6, podium + 0.92, body - 0.12, CORAL, 0.9),
    // Cánh phải: khối trắng, vườn trên mái.
    box(0.32, 0.55, 0.32, WHITE, 0.49, podium, body),
    ...[0.08, 0.24, 0.4].map((y) => glass(0.26, 0.09, 0.012, GLASS, 0.49, podium + y, front - 0.02)),
    box(0.3, 0.012, 0.3, LIME, 0.49, podium + 0.55, body),
    ...tree(0.44, podium + 0.56, body - 0.04, 1.5),
    ...tree(0.57, podium + 0.56, body + 0.07, 1.1),
    // Đỉnh tháp: mũ trắng, sân đỗ trực thăng tròn có vòng vàng và chữ thập trắng, cột thu sóng có đèn đỏ.
    box(0.68, 0.04, 0.42, WHITE, 0, top, body),
    post(0.17, 0.03, "#8d98a3", -0.08, top + 0.04, body, 16),
    post(0.13, 0.004, "#f2c94c", -0.08, top + 0.07, body, 16),
    post(0.115, 0.005, "#8d98a3", -0.08, top + 0.071, body, 16),
    box(0.12, 0.004, 0.026, WHITE, -0.08, top + 0.076, body),
    box(0.026, 0.004, 0.12, WHITE, -0.08, top + 0.076, body),
    box(0.14, 0.08, 0.14, STEEL, 0.22, top + 0.04, body - 0.08),
    post(0.006, 0.2, "#9aa1aa", 0.24, top + 0.12, body - 0.1, 4),
    sphere(0.016, "#ff3b30", 0.24, top + 0.33, body - 0.1, 1, 1, 1, 6),
    ...[-1, 1].flatMap((side) => [...tree(side * 0.72, 0.025, front + 0.06, 1.3), box(0.22, 0.04, 0.03, LEAF, side * 0.42, 0.025, front + 0.14)]),
  ];
}

const DESIGNS: [house: () => Parts, hotel: () => Parts][] = [
  [kiosk, boutique],
  [townhouse, grand],
  [villa, resort],
  [mansion, skyTower],
];

/** Nhà (`hotel` sai) hoặc khách sạn của hạng `tier`, gộp thành một khối để vẽ cả loạt nhà cùng kiểu một lượt. */
export function buildingGeometry(tier: number, hotel: boolean): THREE.BufferGeometry {
  return merged(DESIGNS[tier][hotel ? 1 : 0]());
}
