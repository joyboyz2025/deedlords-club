// Hình học bàn cờ 3D: ô nào nằm đâu, quân đứng chỗ nào trong ô, đi từ ô này sang ô kia qua những ô nào, camera đặt ở đâu.
// Thuần, không dùng Three.js, nên test được và giao diện 2D cũng dùng được.
// Nhìn từ trên xuống giống bàn cờ giấy: Xuất phát ở góc dưới bên phải, đi sang trái rồi vòng lên.
// Trục x sang phải, trục z hướng về phía mép dưới của bàn. Camera đứng ở mép dưới nhìn gần như thẳng từ trên xuống
// (xem `VIEW_YAW`): bàn hiện thành hình vuông đứng, như bàn cờ giấy đặt trước mặt.

export const TILE = 1.8;
/** Ô góc vuông, và cũng là bề sâu của mọi ô tính từ mép bàn vào trong. */
export const CORNER = 2.6;
export const SIDE = 2 * CORNER + 9 * TILE;
export const HALF = SIDE / 2;
/** Dải màu ở mép trong của ô đất, chỗ mọc nhà. */
export const BAND = 0.62;

export type Point = { x: number; z: number };

/** Nhịp diễn trên bàn 3D: xúc xắc lăn chừng này. */
export const THROW_MS = 1200;
/** Xúc xắc dừng rồi còn chờ chừng này cho mọi người kịp nhìn số, quân mới bắt đầu chạy. */
export const SETTLE_MS = 450;
/** Đi xa hơn chừng này ô (vào tạm giữ, đi theo thẻ) thì chạy nhanh hơn, cả quãng vẫn chỉ mất chừng ấy thời gian. */
export const LONG_WALK = 12;
/** Nhà mới xây mọc lên trong chừng này. */
export const GROW_MS = 900;

/** Hướng đi dọc cạnh và hướng vào giữa bàn của từng cạnh. Cạnh 0 là hàng dưới, đi ngược chiều kim đồng hồ nhìn từ trên. */
const ALONG: Point[] = [
  { x: -1, z: 0 },
  { x: 0, z: -1 },
  { x: 1, z: 0 },
  { x: 0, z: 1 },
];
const INWARD: Point[] = [
  { x: 0, z: -1 },
  { x: 1, z: 0 },
  { x: 0, z: 1 },
  { x: -1, z: 0 },
];
/** Góc của bốn ô góc: Xuất phát, Tạm giữ, Nghỉ chân, Bị bắt. */
const CORNERS: Point[] = [
  { x: HALF - CORNER / 2, z: HALF - CORNER / 2 },
  { x: -HALF + CORNER / 2, z: HALF - CORNER / 2 },
  { x: -HALF + CORNER / 2, z: -HALF + CORNER / 2 },
  { x: HALF - CORNER / 2, z: -HALF + CORNER / 2 },
];

export const sideOf = (index: number) => Math.floor(index / 10) % 4;
export const isCorner = (index: number) => index % 10 === 0;

/** Tâm của ô. */
export function tileCenter(index: number): Point {
  const side = sideOf(index);
  const step = index % 10;
  if (step === 0) return CORNERS[side];
  const start = CORNERS[side];
  const along = ALONG[side];
  // Ô thường sâu bằng ô góc, nên từ tâm ô góc chỉ cần đi dọc cạnh: nửa ô góc rồi từng ô thường.
  const distance = CORNER / 2 + (step - 0.5) * TILE;
  return { x: start.x + along.x * distance, z: start.z + along.z * distance };
}

/** Góc quay quanh trục đứng để nhìn từ ngoài bàn vào giữa bàn ở cạnh này: 0 là nhìn từ mép dưới. */
export function sideYaw(side: number): number {
  return (-side * Math.PI) / 2;
}

/**
 * Hướng camera nhìn vào giữa bàn, không bao giờ xoay. Tính như `sideYaw`. 0: đứng ở mép dưới, bàn hiện thành hình vuông
 * đứng, Xuất phát ở góc dưới bên phải, chiếm hết bề ngang màn hình điện thoại. (Trước 2026-11-11 là `Math.PI / 4` với
 * `BOARD_PITCH = 0.95`: nhìn chéo từ góc Xuất phát, bàn hiện thành hình thoi nằm. Mọi phép tính bên dưới đúng với cả hai.)
 */
export const VIEW_YAW = 0;
/** Nhìn cả bàn thì camera chếch xuống chừng này (radian): gần như từ trên xuống, còn thấy mặt trước của nhà và quân. */
export const BOARD_PITCH = 1.22;
/** Góc nhìn dọc của camera, tính bằng độ. */
export const FOV = 45;

/**
 * Cạnh trái và hàng trên vẽ quay ngược so với bàn cờ giấy: dải màu và nhà ở mép ngoài, chữ quay vào giữa bàn.
 * Nhờ vậy hàng trên đọc xuôi như hàng dưới, hai cạnh bên cùng đọc theo một chiều (nghiêng đầu sang trái), không ô nào
 * lộn ngược, và nhà không bao giờ đứng trước chữ.
 */
export const turned = (index: number) => !isCorner(index) && (sideOf(index) === 1 || sideOf(index) === 2);

/** Hướng đọc của ô: đứng nhìn theo góc này thì chữ trên ô xuôi chiều. Nhà trên ô quay mặt tiền về hướng này. */
export function tileYaw(index: number): number {
  return sideYaw(sideOf(index)) + (turned(index) ? Math.PI : 0);
}

/**
 * Đổi tọa độ trong ô sang tọa độ bàn cờ. `along`: sang trái theo chiều đọc chữ của ô. `inward`: lùi về phía dải màu
 * (ô góc: vào giữa bàn). Ô quay ngược thì cả hai đều quay theo, như ảnh mặt bàn.
 */
export function inTile(index: number, along: number, inward: number): Point {
  const center = tileCenter(index);
  const side = sideOf(index);
  const flip = turned(index) ? -1 : 1;
  return {
    x: center.x + (ALONG[side].x * along + INWARD[side].x * inward) * flip,
    z: center.z + (ALONG[side].z * along + INWARD[side].z * inward) * flip,
  };
}

/** Khung nhìn cả bàn chừa lề: bàn chiếm chừng này phần nửa bề ngang và nửa bề cao của khung. */
const FIT_WIDE = 0.97;
const FIT_HIGH = 0.95;
/** Góc xa nhất của bàn tính thêm chừng này bề cao cho nhà và quân đứng trên đó. */
const FIT_TALL = 1.6;

/**
 * Nhìn cả bàn trong khung có tỉ lệ `aspect` (rộng chia cao): camera cách điểm nhìn bao xa (`distance`), và điểm nhìn dời
 * từ giữa bàn về phía góc Xuất phát bao nhiêu (`shift`, tính dọc đường chéo), để bàn hình thoi vừa khung và nằm giữa khung.
 * `roomX`, `roomY`: phần bề ngang, bề cao của khung dành cho bàn; phần còn lại chia đều hai bên, trên dưới cho thẻ người chơi và các nút.
 * Góc gần camera hiện to hơn góc xa nên điểm nhìn phải dời về phía góc gần. Tính dần cho khít, vài chục vòng là đủ.
 */
export function boardFit(aspect: number, roomX = 1, roomY = 1): { distance: number; shift: number } {
  const tanY = Math.tan((FOV * Math.PI) / 360);
  const tanX = tanY * aspect;
  const cos = Math.cos(BOARD_PITCH);
  const sin = Math.sin(BOARD_PITCH);
  // Bốn góc bàn: [về phía camera, sang phải trên màn hình, độ cao]. Góc ở nửa xa camera tính thêm bề cao nhà và quân.
  const sinYaw = Math.sin(VIEW_YAW);
  const cosYaw = Math.cos(VIEW_YAW);
  const points = [
    [HALF, HALF],
    [HALF, -HALF],
    [-HALF, HALF],
    [-HALF, -HALF],
  ].map(([x, z]) => {
    const toward = x * sinYaw + z * cosYaw;
    return [toward, x * cosYaw - z * sinYaw, toward < -1e-9 ? FIT_TALL : 0];
  });
  let distance = 3 * SIDE;
  let shift = 0;
  for (let round = 0; round < 40; round++) {
    let wide = 0;
    let top = -Infinity;
    let bottom = Infinity;
    for (const [toward, right, height] of points) {
      const depth = distance - ((toward - shift) * cos + height * sin);
      wide = Math.max(wide, Math.abs(right) / (depth * tanX));
      const up = (-(toward - shift) * sin + height * cos) / (depth * tanY);
      top = Math.max(top, up);
      bottom = Math.min(bottom, up);
    }
    distance *= Math.max(wide / (FIT_WIDE * roomX), (top - bottom) / 2 / (FIT_HIGH * roomY));
    // Bàn lệch lên trên khung thì dời điểm nhìn ra xa camera, lệch xuống thì dời lại gần.
    shift -= ((top + bottom) / 2) * distance * tanY / sin;
  }
  return { distance, shift };
}

/** Chỗ đặt camera khi nhìn cả bàn chưa phóng to, chưa kéo: lùi `distance` từ điểm nhìn theo hướng nhìn chéo. */
export function boardEye(aspect: number): { x: number; y: number; z: number } {
  const { distance, shift } = boardFit(aspect);
  const flat = Math.cos(BOARD_PITCH) * distance + shift;
  return { x: Math.sin(VIEW_YAW) * flat, y: Math.sin(BOARD_PITCH) * distance, z: Math.cos(VIEW_YAW) * flat };
}

/**
 * Chỗ đứng của quân thứ `slot` (theo màu quân, 0 tới 5) trong ô, để quân không chồng lên nhau và đứng yên chỗ khi người khác tới.
 * Ô thường đứng ở nửa trước, phía có chữ, chừa dải màu cho nhà. Ở Tạm giữ, người bị giữ đứng trong góc song sắt, người ghé thăm đứng ở mép ngoài.
 */
export function standSpot(index: number, slot: number, jailed = false): Point {
  const column = slot % 3;
  const row = Math.floor(slot / 3) % 2;
  if (isCorner(index)) {
    // Góc phía trong của ô góc là hướng đi tiếp và hướng vào giữa bàn.
    if (jailed) return inTile(index, 0.3 + column * 0.36, 0.42 + row * 0.48);
    return inTile(index, (column - 1) * 0.6, -0.55 - row * 0.5);
  }
  return inTile(index, (column - 1) * 0.52, -0.35 - row * 0.62 + 0.25);
}

/**
 * Những ô quân đi qua để tới ô mới, không kể ô đang đứng. Lùi vài ô thì đi lùi;
 * còn lại luôn đi xuôi như thật, kể cả bị bắt vào tạm giữ hay đi theo thẻ.
 */
export function stepsBetween(from: number, to: number): number[] {
  if (from === to) return [];
  const back = (from - to + 40) % 40;
  if (back <= 3) return Array.from({ length: back }, (_, i) => (from - i - 1 + 40) % 40);
  const ahead = (to - from + 40) % 40;
  return Array.from({ length: ahead }, (_, i) => (from + i + 1) % 40);
}

/** Ô nằm dưới điểm chạm, hoặc `null` nếu chạm ra ngoài bàn hay vào khu phố giữa bàn. */
export function tileAt(x: number, z: number): number | null {
  const inner = HALF - CORNER;
  if (Math.abs(x) > HALF || Math.abs(z) > HALF) return null;
  if (Math.abs(x) < inner && Math.abs(z) < inner) return null;
  if (z > inner) {
    if (x > inner) return 0;
    if (x < -inner) return 10;
    return 1 + Math.min(8, Math.floor((inner - x) / TILE));
  }
  if (x < -inner) {
    if (z < -inner) return 20;
    return 11 + Math.min(8, Math.floor((inner - z) / TILE));
  }
  if (z < -inner) {
    if (x > inner) return 30;
    return 21 + Math.min(8, Math.floor((x + inner) / TILE));
  }
  return 31 + Math.min(8, Math.floor((z + inner) / TILE));
}
