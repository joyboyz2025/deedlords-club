// Tóc nhân vật kiểu chibi hoạt hình (tham khảo cách vẽ tóc của Gunny): dựng từ nhiều lọn nhọn thay cho một chỏm cầu trơn.
// Duyệt hình ở reports/toc-moi-ban-duyet.pdf; bộ dựng nháp và cách vẽ lại ở toc-gunny/ trong thư mục ghi chú chung.
// Mỗi lọn là một ống dẹt chạy theo đường cong, to ở gốc, nhọn ở ngọn, mặt trong áp vào đầu; dưới các lọn là lớp vỏ tối hơn,
// nên khe giữa hai lọn đọc như bóng tóc. Kiểu Hiếm (số 20–25) có thêm vệt nhuộm theo bảng DYES.

import * as THREE from "three";
import { LOOK_CHOICES } from "../look.ts";

type Parts = THREE.BufferGeometry[];
type Vec = THREE.Vector3;

/** Sọ: sphere(0.36) co giãn (1.04, 0.94, 0.98), như skullParts. */
const RX = 0.36 * 1.04;
const RY = 0.36 * 0.94;
const RZ = 0.36 * 0.98;
const TAU = Math.PI * 2;
const EAR = { x: 0.365, y: -0.03, r: 0.055 };
const SON = "#c8321e";
const HOE = "#edb92e";
const WOOD = "#7a4a26";

/** Màu nhuộm của tóc Hiếm theo số màu tóc: đen với đỏ, nâu với vàng mật, vàng với hồng, bạc với xanh băng… */
export const DYES: readonly string[] = ["#c8402f", "#e3a83f", "#f2b04a", "#ef7fa8", "#8fb8ff", "#9b6be0", "#7ee8f0"];
/** Bản nhẹ: bớt khúc và cạnh của mỗi lọn; ở cỡ hình trong game gần như không thấy khác. */
const DETAIL = { seg: 0.7, rad: 0.72 };

/** Độ phồng của tóc: mũ không che đỉnh đầu (vòng hoa, tai thỏ, Mũ phượng...) phóng ra theo để không chìm trong tóc. */
export const HAIR_VOLUME: readonly number[] = [1, 1.03, 1.1, 1.1, 1.1, 1.08, 1, 1.08, 1.12, 1.1, 1.14, 1.08, 1.08, 1.1, 1.1, 1.13, 1.12, 1.1, 1.03, 1.12, 1.1, 1.02, 1.05, 1.06, 1.08, 1.5];
/**
 * Mũ không che đỉnh: đặt trên tóc, to theo tóc. Mũ phượng (11) vào nhóm này từ 5/11/2026 (người dùng chọn): tóc giữ nguyên dáng, không bị ép.
 * Mũ nào cũng phải ở đúng một trong hai nhóm, nhóm này hoặc HATS_OVER_HAIR trong parts.ts (có test): thêm mũ mới thì xếp nhóm cho nó.
 */
export const OPEN_HATS: ReadonlySet<number> = new Set([5, 7, 11, 19, 20, 21]);

/**
 * Mặt trong của mũ che đỉnh: đi từ tâm đầu theo hướng `dir` (vector đơn vị) bao xa thì chạm mũ; không chạm thì OPEN.
 * Tóc dưới mũ được ép cho nằm gọn dưới mặt này (xem HairKit.fit), nên mũ ôm đầu hay mũ vành nổi đều đúng.
 */
export type Ceiling = (dir: THREE.Vector3) => number;
const OPEN = 9;
/**
 * Lưới hướng để chiếu tia: chỉ tới ngang dưới tai, thấp hơn nữa thì tóc thả tự do (khăn ninja che cả cằm).
 * Ô cỡ 0,04 rad theo độ nghiêng, 0,065 rad theo vòng quanh (quai mảnh của quai thao rộng chừng 0,08 rad).
 */
const CEIL_POLAR = Math.PI * 0.62;
const CEIL_ROWS = 49;
const CEIL_COLS = 96;

/**
 * Dựng Ceiling cho một chiếc mũ: theo mỗi hướng của lưới, chỗ đầu tiên bên ngoài sọ mà tia từ tâm đầu ra khỏi mũ (mặt quay lưng về phía đầu).
 * Chỗ tia đi vào một khối mũ (đĩa đáy nón lá, mặt đáy chóp quai thao, mặt dưới vành, mặt trong vòng khăn) không tính: tóc lọt vào trong
 * khối mũ thì mũ che mất. Không chiếu từng tia qua cả chiếc mũ (chậm trên điện thoại): duyệt từng tam giác của mũ, chỉ thử những ô lưới
 * mà tam giác đó che. Tra thì lấy số nhỏ nhất của bốn ô quanh hướng cần tra.
 */
export function hatCeiling(parts: Parts): Ceiling {
  const rowStep = CEIL_POLAR / (CEIL_ROWS - 1);
  const colStep = TAU / CEIL_COLS;
  const dirs = new Float32Array(CEIL_ROWS * CEIL_COLS * 3);
  const inside = new Float32Array(CEIL_ROWS * CEIL_COLS);
  const grid = new Float32Array(CEIL_ROWS * CEIL_COLS).fill(OPEN);
  const d = v3(0, 0, 0);
  for (let i = 0; i < CEIL_ROWS; i++) {
    for (let j = 0; j < CEIL_COLS; j++) {
      const polar = i * rowStep;
      const spin = j * colStep;
      d.set(Math.sin(polar) * Math.sin(spin), Math.cos(polar), Math.sin(polar) * Math.cos(spin));
      dirs.set([d.x, d.y, d.z], (i * CEIL_COLS + j) * 3);
      inside[i * CEIL_COLS + j] = skull(d) + 0.002;
    }
  }
  const A = v3(0, 0, 0);
  const B = v3(0, 0, 0);
  const C = v3(0, 0, 0);
  const e1 = v3(0, 0, 0);
  const e2 = v3(0, 0, 0);
  const n = v3(0, 0, 0);
  const pv = v3(0, 0, 0);
  const qv = v3(0, 0, 0);
  const up = v3(0, 1, 0);
  const polarOf = (v: Vec) => Math.acos(THREE.MathUtils.clamp(v.y / (v.length() || 1), -1, 1));
  const spinOf = (v: Vec) => (Math.atan2(v.x, v.z) + TAU) % TAU;
  // Tia từ tâm đầu (gốc toạ độ) theo hướng `dir` cắt tam giác ABC đang xét ở khoảng cách bao nhiêu (Möller–Trumbore); không cắt thì -1.
  const hit = (dir: Vec): number => {
    pv.crossVectors(dir, e2);
    const det = e1.dot(pv);
    if (Math.abs(det) < 1e-12) return -1;
    const inv = 1 / det;
    const u = -A.dot(pv) * inv;
    if (u < 0 || u > 1) return -1;
    qv.crossVectors(A, e1).negate();
    const v = dir.dot(qv) * inv;
    if (v < 0 || u + v > 1) return -1;
    return e2.dot(qv) * inv;
  };
  for (const part of parts) {
    const pos = part.attributes.position;
    const index = part.index;
    const count = index ? index.count : pos.count;
    for (let k = 0; k + 2 < count; k += 3) {
      A.fromBufferAttribute(pos, index ? index.getX(k) : k);
      B.fromBufferAttribute(pos, index ? index.getX(k + 1) : k + 1);
      C.fromBufferAttribute(pos, index ? index.getX(k + 2) : k + 2);
      e1.subVectors(B, A);
      e2.subVectors(C, A);
      n.crossVectors(e1, e2);
      if (n.lengthSq() < 1e-14) continue;
      // Khung góc (độ nghiêng, vòng quanh) của tam giác nhìn từ tâm đầu: lấy cả các điểm dọc ba cạnh (cạnh thẳng võng về phía đỉnh đầu),
      // nới thêm một ô. Tam giác che hướng thẳng lên, hay trải rộng quanh đầu, thì xét từ hàng 0 và mọi cột.
      let pMin = Infinity;
      let pMax = -Infinity;
      let lo = 0;
      let hi = 0;
      const sa = spinOf(A);
      for (let edge = 0; edge < 3; edge++) {
        const from = edge === 0 ? A : edge === 1 ? B : C;
        const to = edge === 0 ? B : edge === 1 ? C : A;
        for (let step = 0; step < 8; step++) {
          pv.copy(from).lerp(to, step / 8);
          const polar = polarOf(pv);
          pMin = Math.min(pMin, polar);
          pMax = Math.max(pMax, polar);
          const off = spinOf(pv) - sa;
          const wrapped = off - TAU * Math.round(off / TAU);
          lo = Math.min(lo, wrapped);
          hi = Math.max(hi, wrapped);
        }
      }
      if (pMin - rowStep > CEIL_POLAR) continue;
      // Tam giác chứa hướng thẳng lên thì ba đỉnh không nằm gọn trong nửa vòng quanh trục đứng, nên khung vòng quanh ở trên đã trải rộng.
      // Tia thẳng lên chạm đúng đỉnh hay cạnh tam giác (đỉnh chóp nón, đỉnh mặt cầu) thì khung đó có thể hẹp: xét thêm tia thẳng lên.
      const cap = hit(up) > 0 || hi - lo >= Math.PI / 2;
      const i0 = cap ? 0 : Math.max(0, Math.floor((pMin - rowStep) / rowStep));
      const i1 = Math.min(CEIL_ROWS - 1, Math.ceil((pMax + rowStep) / rowStep));
      const j0 = cap ? 0 : Math.floor((sa + lo) / colStep) - 1;
      const j1 = cap ? CEIL_COLS - 1 : Math.ceil((sa + hi) / colStep) + 1;
      for (let i = i0; i <= i1; i++) {
        for (let jj = j0; jj <= j1; jj++) {
          const j = ((jj % CEIL_COLS) + CEIL_COLS) % CEIL_COLS;
          const cell = i * CEIL_COLS + j;
          d.fromArray(dirs, cell * 3);
          // Chỉ lấy chỗ tia ra khỏi mũ: mặt quay lưng về phía đầu.
          if (d.dot(n) <= 0) continue;
          const t = hit(d);
          if (t > inside[cell] && t < grid[cell]) grid[cell] = t;
        }
      }
    }
  }
  return (q) => {
    const polar = Math.acos(THREE.MathUtils.clamp(q.y / (q.length() || 1), -1, 1));
    if (polar > CEIL_POLAR) return OPEN;
    const fi = polar / rowStep;
    const fj = ((Math.atan2(q.x, q.z) + TAU) % TAU) / colStep;
    const r0 = Math.min(CEIL_ROWS - 1, Math.floor(fi));
    const r1 = Math.min(CEIL_ROWS - 1, r0 + 1);
    const c0 = Math.floor(fj) % CEIL_COLS;
    const c1 = (c0 + 1) % CEIL_COLS;
    return Math.min(grid[r0 * CEIL_COLS + c0], grid[r0 * CEIL_COLS + c1], grid[r1 * CEIL_COLS + c0], grid[r1 * CEIL_COLS + c1]);
  };
}

/** Bán kính sọ theo hướng đơn vị `d`. */
function skull(d: Vec): number {
  return 1 / Math.hypot(d.x / RX, d.y / RY, d.z / RZ);
}

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/**
 * Mẫu gợn xoăn của Xù bông theo hướng đơn vị (x, y, z), từ 0 tới 1: hai lớp gợn tròn, tần số vừa, mỗi cụm cỡ 0,1,
 * nhỏ hơn đầu nhiều nhưng to hơn khoảng cách hai đỉnh.
 */
function curlField(x: number, y: number, z: number): number {
  const a = Math.sin(x * 15 + 1.1) * Math.sin(y * 14 + 0.3) * Math.sin(z * 16 + 2.2);
  const b = Math.sin(x * 26 + 2.4) * Math.sin(y * 24 + 1.7) * Math.sin(z * 25 + 0.5);
  return 0.5 + 0.5 * (0.62 * Math.cbrt(a) + 0.38 * Math.cbrt(b));
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tint(geometry: THREE.BufferGeometry, color: THREE.Color): THREE.BufferGeometry {
  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) colors.set([color.r, color.g, color.b], i * 3);
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.deleteAttribute("uv");
  return geometry;
}

/** Quay khối dựng theo trục y sang hướng `dir`. */
function aim(geometry: THREE.BufferGeometry, dir: Vec, roll = 0): THREE.BufferGeometry {
  if (roll) geometry.rotateY(roll);
  const q = new THREE.Quaternion().setFromUnitVectors(v3(0, 1, 0), dir.clone().normalize());
  return geometry.applyQuaternion(q);
}

type LockOpts = {
  /** Nửa bề ngang ở gốc. */
  w: number;
  /** Độ dày so với bề ngang. */
  flat?: number;
  /** Mặt trong (áp vào đầu) dày bằng chừng này lần mặt ngoài. */
  inner?: number;
  /** Thân lọn: số lớn thì lọn giữ bề ngang tới gần ngọn rồi mới nhọn (mái bằng), số nhỏ thì thon đều như mũi chông. */
  body?: number;
  /** Độ nhọn của ngọn. */
  point?: number;
  /** Phình ở giữa lọn (đuôi tóc, bím). */
  bulge?: number;
  seg?: number;
  rad?: number;
  /** Tâm để tính mặt ngoài của lọn; không có thì theo mặt đầu. */
  from?: Vec;
  /** Nhân màu riêng cho lọn này. */
  shade?: number;
  /** Có vệt sáng không. */
  shine?: boolean;
  /** Độ tối ở gốc lọn (1 là không tối). */
  root?: number;
  /** Nhuộm từ khúc này (0 là gốc, 1 là ngọn) ra tới ngọn, sáng dần sang màu nhuộm. Không ghi là không nhuộm. */
  dye?: number;
  /** Lọn quấn quanh một trục (lọn xoắn lò xo, vòng tóc, vành vấn): mặt ngoài tính từ trục này. */
  axis?: { at: Vec; dir: Vec };
  /** Hướng cố định cho bề dày lọn, như vây Mào gà dẹt sang hai bên. */
  normal?: Vec;
};

class HairKit {
  readonly parts: Parts = [];
  readonly base: THREE.Color;
  readonly dark: THREE.Color;
  readonly glow: THREE.Color;
  /** Màu nhuộm của tóc Hiếm, đi theo màu tóc. */
  readonly dyeTone: THREE.Color;
  readonly rand: () => number;
  /** Mặt trong của mũ che đỉnh đang đội; null là không đội mũ che đỉnh. */
  readonly ceiling: Ceiling | null;
  /** Đội mũ che đỉnh đầu: bỏ các món chĩa lên (búi, gai, vòng tóc), tóc ép gọn dưới mũ. */
  readonly covered: boolean;
  private readonly dir = v3(0, 0, 0);
  private readonly edge = v3(0, 0, 0);

  constructor(colorIndex: number, seed: number, ceiling: Ceiling | null) {
    this.base = new THREE.Color(LOOK_CHOICES.hairColor[colorIndex]?.color ?? LOOK_CHOICES.hairColor[0].color!);
    this.dyeTone = new THREE.Color(DYES[colorIndex] ?? "#ffffff");
    this.dark = this.base.clone().multiplyScalar(0.55);
    // Tóc đen cần vệt sáng hơi xanh mới thấy; tóc sáng thì chỉ cần trắng ra một chút.
    const light = this.base.getHSL({ h: 0, s: 0, l: 0 }).l;
    this.glow = this.base.clone().lerp(new THREE.Color(light < 0.12 ? "#8d93ad" : "#ffffff"), light < 0.12 ? 0.55 : 0.42);
    this.rand = rng(seed);
    this.ceiling = ceiling;
    this.covered = Boolean(ceiling);
  }

  /** Một điểm trên đầu: `tilt` tính từ đỉnh (π/2 là ngang tai), `spin` quanh đầu (0 là trước mặt, π/2 sang phía +x), `lift` phồng ra ngoài. */
  S(tilt: number, spin: number, lift = 0): Vec {
    const s = Math.sin(tilt);
    return v3(RX * s * Math.sin(spin), RY * Math.cos(tilt), RZ * s * Math.cos(spin)).multiplyScalar(1 + lift);
  }

  /**
   * Dưới mũ che đỉnh: tâm của một khối tròn cỡ `size` (búi, chỗ buộc đuôi tóc) ở hướng `spin`, nâng `lift`, độ nghiêng thấp nhất
   * từ `tilt` trở xuống mà khối nằm gọn dưới mũ, tức lòi ra dưới vành. Không đội mũ thì ở `tilt`. Mũ trùm kín tới gáy hay ôm sát
   * xuống ngang cổ (dưới vành không còn chỗ) thì trả null: nơi gọi giấu búi, đuôi trong mũ, kẻo búi rơi xuống chạm vai.
   */
  below(spin: number, tilt: number, lift: number, size: number): Vec | null {
    const ceiling = this.ceiling;
    if (!ceiling) return this.S(tilt, spin, lift);
    const d = v3(0, 0, 0);
    for (let t = tilt; t < 2.3; t += 0.04) {
      const center = this.S(t, spin, lift);
      const r = center.length();
      const spread = Math.asin(Math.min(1, size / r));
      // Lưới hướng dày bằng ô lưới mặt mũ, phủ hết khối tròn (vành, quai mảnh dễ lọt giữa các hướng thưa); theo mỗi hướng,
      // mặt mũ phải ở xa hơn điểm xa nhất của khối tròn.
      const k = Math.max(2, Math.ceil(spread / 0.04));
      let clear = true;
      for (let i = -k; i <= k && clear; i++) {
        for (let j = -k; j <= k && clear; j++) {
          // Chỉ các hướng trong vòng tròn: hướng ở góc ô vuông không cắt khối tròn, đo ở đó chỉ làm búi bị đẩy thấp hơn cần.
          if (i * i + j * j > k * k) continue;
          d.copy(this.S(t + (i / k) * spread, spin + ((j / k) * spread) / Math.max(0.2, Math.sin(t)))).normalize();
          const along = d.dot(center);
          const far = along + Math.sqrt(Math.max(0, size * size - (r * r - along * along)));
          if (ceiling(d) < far) clear = false;
        }
      }
      if (clear) return center;
    }
    return null;
  }

  /**
   * Đặt khúc lọn ở `c` cho nằm gọn dưới mũ; trả về độ dày mới. Mặt cắt của lọn là elip: nửa bề ngang `w` theo `B`,
   * dày `h` ra ngoài và `h * inner` vào trong theo `N`, nên phần nhô ra theo hướng tâm đầu tính theo hướng thật của B, N
   * (lọn xoăn, lọn cong lên có bề ngang quay ra ngoài). Giữ bề ngang để các lọn vẫn phủ kín, không hở da thành sọc;
   * hạ xuống trước, chưa đủ thì mỏng lại, không còn chỗ thì chìm hẳn vào trong đầu.
   */
  private fit(c: Vec, w: number, h: number, inner: number, N: Vec, B: Vec, T: Vec, step: number): number {
    const r = c.length();
    if (r < 1e-6) return h;
    const ceiling = this.ceiling!;
    // Lấy mặt mũ thấp nhất quanh khúc lọn: tâm, lưng lọn, hai mép và nửa đường tới hai vòng kề bên, cả ở tâm lẫn hai mép (gần vành mũ,
    // mép, lưng lọn dày hay đoạn nối giữa hai vòng có thể lấn sang chỗ mũ thấp hơn).
    const edge = this.edge;
    let roofAt = ceiling(edge.copy(c).addScaledVector(N, h).normalize());
    for (const along of [-step / 2, 0, step / 2]) {
      for (const across of [-w, 0, w]) {
        if (along === 0 && across === 0) continue;
        roofAt = Math.min(roofAt, ceiling(edge.copy(c).addScaledVector(T, along).addScaledVector(B, across).normalize()));
      }
    }
    const d = this.dir.copy(c).divideScalar(r);
    const roof = Math.min(roofAt, ceiling(d)) - 0.006;
    if (roof >= OPEN - 1) return h;
    const bn = w * B.dot(d);
    const nn = N.dot(d);
    // Phần nhô ra ngoài, thụt vào trong theo hướng tâm đầu; cộng thêm chỗ mép lọn dẹt xa tâm đầu hơn (chừng w²/2r).
    const outward = (hh: number) => Math.hypot(bn, hh * nn) + (w * w + hh * hh) / (2 * r);
    const inward = (hh: number) => Math.hypot(bn, hh * inner * nn);
    if (r + outward(h) <= roof) return h;
    const floor = skull(d) + 0.008;
    for (const hh of [h, h * 0.6, h * 0.35, h * 0.15]) {
      if (roof - outward(hh) - inward(hh) >= floor) {
        c.multiplyScalar(Math.min(r, roof - outward(hh)) / r);
        return hh;
      }
    }
    c.multiplyScalar(Math.max(0.05, skull(d) - outward(h) - 0.012) / r);
    return h;
  }

  /** Một đỉnh lẻ (ngọn, gốc lọn) dưới mũ: nhô ra ngoài mặt trong của mũ thì kéo xuống; không còn chỗ thì chìm vào trong đầu. */
  private tuck(c: Vec): void {
    const r = c.length();
    if (r < 1e-6) return;
    const d = this.dir.copy(c).divideScalar(r);
    const roof = this.ceiling!(d) - 0.006;
    if (r <= roof) return;
    const rs = skull(d);
    c.multiplyScalar((roof >= rs + 0.008 ? roof : rs - 0.012) / r);
  }

  /**
   * Khối liền (vỏ tóc, khối Xù bông) dưới mũ: đỉnh nào nhô ra ngoài mặt trong của mũ thì hạ xuống ngay dưới mũ, thành lớp tóc ép dẹt;
   * mũ ôm sát quá, không còn chỗ (dưới 0,012) thì kéo vào trong đầu, mũ che mất chỗ đó.
   */
  clip(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
    if (!this.ceiling) return geometry;
    const position = geometry.attributes.position;
    const p = v3(0, 0, 0);
    const d = v3(0, 0, 0);
    for (let i = 0; i < position.count; i++) {
      p.fromBufferAttribute(position, i);
      const r = p.length();
      if (r < 1e-6) continue;
      d.copy(p).divideScalar(r);
      const roof = this.ceiling(d) - 0.006;
      if (r > roof) {
        const rs = skull(d);
        p.copy(d).multiplyScalar(roof >= rs + 0.012 ? roof : rs - 0.012);
        position.setXYZ(i, p.x, p.y, p.z);
      }
    }
    geometry.computeVertexNormals();
    return geometry;
  }

  /** Một điểm của phần tóc thả xuống dưới ngang tai: rơi thẳng xuống từ chỗ đầu rộng nhất. */
  D(spin: number, y: number, lift = 0): Vec {
    return v3(RX * Math.sin(spin) * (1 + lift), y, RZ * Math.cos(spin) * (1 + lift));
  }

  jitter(amount: number): number {
    return (this.rand() * 2 - 1) * amount;
  }

  /** Lọn tóc đi qua các điểm `points` (gốc trước, ngọn sau). */
  lock(points: Vec[], options: LockOpts): void {
    const o = { flat: 0.46, inner: 0.45, body: 1.7, point: 1, bulge: 0, seg: 9, rad: 7, shade: 0.92 + this.rand() * 0.16, shine: true, root: 0.62, ...options };
    const curve = new THREE.CatmullRomCurve3(points, false, "centripetal");
    const n = Math.max(4, Math.round(o.seg * DETAIL.seg));
    // Khoảng cách giữa hai vòng mặt cắt, để ép dưới mũ xét cả đoạn nối giữa hai vòng.
    const step = this.ceiling ? curve.getLength() / n : 0;
    const R = Math.max(4, Math.round(o.rad * DETAIL.rad));
    const total = n * R + 2;
    const pos = new Float32Array(total * 3);
    const col = new Float32Array(total * 3);
    const index: number[] = [];
    const c = v3(0, 0, 0);
    const T = v3(0, 0, 0);
    const out = v3(0, 0, 0);
    const N = v3(0, 0, 0);
    const B = v3(0, 0, 0);
    const p = v3(0, 0, 0);
    const prev = v3(0, 0, 0);
    const color = new THREE.Color();
    const tone = new THREE.Color();
    const shineY = 0.2 + this.jitter(0.025);
    // Lọn có trục riêng hay tâm riêng (búi, vòng, lọn xoắn) thì không đẩy theo sọ, không ép dưới mũ: các món đó tự đặt dưới vành.
    const free = Boolean(o.from || o.axis);
    let hasPrev = false;
    const write = (k: number, at: Vec, shade: number, glow: number, dyed: number) => {
      pos.set([at.x, at.y, at.z], k * 3);
      color.copy(this.base).multiplyScalar(shade);
      if (dyed > 0) color.lerp(tone.copy(this.dyeTone).multiplyScalar(shade), dyed);
      if (glow > 0) color.lerp(this.glow, glow);
      col.set([color.r, color.g, color.b], k * 3);
    };
    for (let i = 0; i < n; i++) {
      const u = i / n;
      curve.getPointAt(u, c);
      curve.getTangentAt(u, T);
      const f = Math.pow(1 - Math.pow(u, o.body), o.point) * (1 + o.bulge * Math.sin(Math.PI * u));
      const w = o.w * f;
      let h = w * o.flat;
      // Không cho lõi lọn chui vào sọ hay xuyên qua tai.
      const k = Math.hypot(c.x / RX, c.y / RY, c.z / RZ);
      const need = 1 + (h * o.inner + 0.008) / 0.34;
      if (!free && c.y > -0.22 && k < need) c.multiplyScalar(need / k);
      const side = Math.sign(c.x) || 1;
      const ear = v3(side * EAR.x, EAR.y, 0);
      const reach = EAR.r + h * o.inner + 0.012;
      const gap = c.distanceTo(ear);
      if (gap < reach) c.sub(ear).multiplyScalar(reach / Math.max(gap, 1e-4)).add(ear);

      if (o.axis) {
        out.copy(c).sub(o.axis.at);
        out.addScaledVector(o.axis.dir, -out.dot(o.axis.dir));
      } else if (o.from) out.copy(c).sub(o.from);
      else out.set(c.x / (RX * RX), Math.max(c.y, 0) / (RY * RY), c.z / (RZ * RZ));
      if (out.lengthSq() < 1e-8) out.set(0, 1, 0);
      out.normalize();
      const facing = o.normal ?? out;
      N.copy(facing).addScaledVector(T, -facing.dot(T));
      if (N.length() < 0.3) {
        // Lọn chĩa thẳng ra ngoài (chỏm, mũi dựng): giữ hướng của khúc trước, khúc đầu thì lấy một hướng vuông góc bất kỳ.
        const ref = hasPrev ? prev : Math.abs(T.z) < 0.9 ? v3(0, 0, 1) : v3(1, 0, 0);
        N.copy(ref).addScaledVector(T, -ref.dot(T));
      }
      N.normalize();
      prev.copy(N);
      hasPrev = true;
      B.crossVectors(T, N).normalize();
      // Dưới mũ che đỉnh: khúc lọn ép cho nằm gọn dưới mặt trong của mũ (hướng N, B không đổi khi khúc lọn chỉ dời theo hướng tâm đầu).
      if (this.ceiling && !free) h = this.fit(c, w, h, o.inner, N, B, T, step);
      const rootShade = THREE.MathUtils.lerp(o.root, 1, THREE.MathUtils.smoothstep(u, 0, 0.45));
      const dyed = o.dye === undefined ? 0 : THREE.MathUtils.smoothstep(u, o.dye, Math.min(1, o.dye + 0.3));
      for (let j = 0; j < R; j++) {
        const a = (j / R) * TAU;
        const cs = Math.cos(a);
        const sn = Math.sin(a);
        p.copy(c)
          .addScaledVector(B, w * cs)
          .addScaledVector(N, (sn >= 0 ? h : h * o.inner) * sn);
        const shade = o.shade * rootShade * (sn < -0.2 ? 0.78 : 1);
        let glow = 0;
        if (o.shine && sn > 0.2) glow = Math.max(0, 1 - Math.abs(p.y - shineY) / 0.045) * 0.75 * sn;
        write(i * R + j, p, shade, glow, dyed);
      }
    }
    // Ngọn: một đỉnh nhọn. Gốc: bịt kín bằng một đỉnh giữa. Dưới mũ, hai đỉnh này cũng phải nằm gọn dưới mũ.
    curve.getPointAt(1, c);
    if (this.ceiling && !free) this.tuck(c);
    write(n * R, c, o.shade, 0, o.dye === undefined ? 0 : 1);
    curve.getPointAt(0, c);
    if (this.ceiling && !free) this.tuck(c);
    write(n * R + 1, c, o.shade * o.root, 0, 0);
    for (let i = 0; i < n - 1; i++) {
      for (let j = 0; j < R; j++) {
        const a = i * R + j;
        const b = i * R + ((j + 1) % R);
        const d = (i + 1) * R + j;
        const e = (i + 1) * R + ((j + 1) % R);
        index.push(a, d, b, b, d, e);
      }
    }
    const last = (n - 1) * R;
    for (let j = 0; j < R; j++) index.push(last + j, n * R, last + ((j + 1) % R));
    for (let j = 0; j < R; j++) index.push(j, (j + 1) % R, n * R + 1);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geometry.setIndex(index);
    geometry.computeVertexNormals();
    this.parts.push(geometry);
  }

  /**
   * Lớp vỏ dưới các lọn. `reach` là độ dài chỏm tính từ đỉnh, `back` là độ ngả ra sau: chân tóc trước trán ở reach - back, sau gáy ở reach + back.
   * Mặc định tối màu để khe giữa các lọn đọc như bóng. `sleek`: tóc chải ngược sát đầu, vỏ chính là mặt tóc nên cùng màu tóc và có vệt sáng.
   */
  shell(reach = 1.45, back = 0.5, lift = 0.03, sleek = false, shade = 0.55): void {
    // Vỏ tối nằm dưới các lọn, gần như không lộ ra, nên thưa hơn; vỏ trơn (sleek) là mặt tóc nên mịn hơn.
    // Vỏ sát da (phần cạo của Tóc nấm, Mào gà, lift dưới 0,03) phải dày mặt: mặt phẳng của vỏ thưa võng xuống dưới da đầu, da lộ lấm tấm.
    // Dưới mũ che đỉnh, đỉnh nào của vỏ nhô ra ngoài mặt trong của mũ thì hạ xuống dưới mũ (clip), chỗ khác giữ nguyên.
    const [around, down] = lift < 0.03 ? [24, 14] : sleek ? [18, 10] : [16, 9];
    const g = new THREE.SphereGeometry(0.36 * (1 + lift), around, down, 0, TAU, 0, reach).rotateX(-back).scale(1.04, 0.94, 0.98);
    this.clip(g);
    if (!sleek) {
      this.parts.push(tint(g, shade === 0.55 ? this.dark : this.base.clone().multiplyScalar(shade)));
      return;
    }
    const position = g.attributes.position;
    const colors = new Float32Array(position.count * 3);
    const color = new THREE.Color();
    for (let i = 0; i < position.count; i++) {
      const y = position.getY(i);
      const z = position.getZ(i);
      color.copy(this.base).multiplyScalar(0.88 + 0.12 * THREE.MathUtils.smoothstep(y, -0.2, 0.3));
      const band = Math.max(0, 1 - Math.abs(y - 0.2) / 0.05) * (z > -0.3 ? 0.6 : 0.3);
      color.lerp(this.glow, band);
      colors.set([color.r, color.g, color.b], i * 3);
    }
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    g.deleteAttribute("uv");
    this.parts.push(g);
  }

  /**
   * Sợi chải ngược nằm sát vỏ: chỉ để thấy thớ tóc, gốc lún vào vỏ nên không lộ đầu cắt.
   * Đội mũ che đỉnh thì bỏ: sợi chìm vào đầu sẽ cắt qua vỏ thành vệt lốm đốm, mà vỏ trơn đã đủ là tóc chải ngược.
   */
  strand(points: Vec[], w = 0.05): void {
    if (this.covered) return;
    this.lock(points, { w, flat: 0.3, inner: 0.3, body: 1.5, seg: 9, rad: 6, shade: 0.95 + this.rand() * 0.1, root: 0.97, shine: false });
  }

  solid(geometry: THREE.BufferGeometry, shade = 1): void {
    this.parts.push(tint(geometry, this.base.clone().multiplyScalar(shade)));
  }

  paint(geometry: THREE.BufferGeometry, hex: string): void {
    this.parts.push(tint(geometry, new THREE.Color(hex)));
  }

  /** Mặt tóc xoăn tít của Xù bông: đẩy từng đỉnh ra theo một mẫu gợn (nhiều cụm nhỏ liền nhau), chỗ lồi sáng hơn và ngả màu nhuộm nhẹ. */
  curly(geometry: THREE.BufferGeometry, center: Vec, depth: number): void {
    const position = geometry.attributes.position;
    const colors = new Float32Array(position.count * 3);
    const p = v3(0, 0, 0);
    const d = v3(0, 0, 0);
    const color = new THREE.Color();
    for (let i = 0; i < position.count; i++) {
      p.fromBufferAttribute(position, i);
      d.copy(p).sub(center).normalize();
      const bump = curlField(d.x, d.y, d.z);
      p.addScaledVector(d, bump * depth);
      position.setXYZ(i, p.x, p.y, p.z);
      color.copy(this.base).multiplyScalar(0.74 + 0.26 * bump).lerp(this.dyeTone, THREE.MathUtils.smoothstep(bump, 0.82, 1) * 0.22);
      colors.set([color.r, color.g, color.b], i * 3);
    }
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.deleteAttribute("uv");
    geometry.computeVertexNormals();
    this.parts.push(geometry);
  }

  /**
   * Khối tóc kín của Xù bông: mỗi đỉnh nằm theo một hướng từ tâm sọ; trong vùng tóc thì nằm trên quả cầu to (tâm `center`, bán kính `R`),
   * tới chân tóc quanh mặt và ở gáy thì hạ dần theo cung tròn về sát da. Nhờ vậy khối tóc ôm lấy mặt như một vành tròn,
   * không có mép hở hay lòng rỗng nhìn xuyên qua. Vùng mặt, cổ bỏ đi. Mặt tóc gợn xoăn như `curly`.
   */
  afro(center: Vec, R: number, depth: number, around = 56, down = 40): void {
    const g = new THREE.SphereGeometry(1, around, down);
    const position = g.attributes.position;
    const count = position.count;
    const colors = new Float32Array(count * 3);
    const keep = new Uint8Array(count);
    const w = v3(0, 0, 0);
    const color = new THREE.Color();
    // Chân tóc quanh mặt: hình bầu dục theo (vòng quanh, độ nghiêng), giữa ngang mắt; gáy ở độ nghiêng NAPE.
    const FACE_W = 1.15;
    const FACE_C = 1.78;
    const FACE_H = 0.9;
    const NAPE = 2.12;
    const BAND = 0.34;
    for (let i = 0; i < count; i++) {
      w.fromBufferAttribute(position, i).normalize();
      const spin = Math.atan2(w.x, w.z);
      const polar = Math.acos(THREE.MathUtils.clamp(w.y, -1, 1));
      // Chân tóc ở trán lởm chởm: lệch ra vào theo vòng quanh.
      const ragged = 0.05 * Math.sin(spin * 11 + 0.7) + 0.03 * Math.sin(spin * 23 + 2.1);
      const face = (Math.hypot(spin / FACE_W, (polar - FACE_C) / FACE_H) - 1) * FACE_H + ragged;
      const m = Math.min(face, NAPE - polar);
      // Giữ thêm một dải ngoài chân tóc, chìm dần vào trong da: chỗ mặt tóc cắt mặt da là chân tóc, nên chân tóc mịn theo đường cong
      // chứ không thành bậc thang theo ô lưới.
      keep[i] = m > -0.12 ? 1 : 0;
      const f = THREE.MathUtils.clamp(m / BAND, 0, 1);
      const skin = skull(w) + 0.012;
      const along = w.dot(center);
      const ball = Math.max(skin, along + Math.sqrt(Math.max(0, R * R - (center.lengthSq() - along * along))));
      // Cung tròn: sát chân tóc thì dựng đứng lên, vào trong vùng tóc thì phẳng ra theo quả cầu.
      const lift = Math.sqrt(1 - (1 - f) * (1 - f));
      const bump = curlField(w.x, w.y, w.z);
      const r = m < 0 ? skin + m * 0.4 : skin + (ball - skin) * lift + bump * depth * lift;
      position.setXYZ(i, w.x * r, w.y * r, w.z * r);
      color.copy(this.base).multiplyScalar((0.74 + 0.26 * bump) * (0.82 + 0.18 * lift)).lerp(this.dyeTone, THREE.MathUtils.smoothstep(bump, 0.82, 1) * 0.22 * lift);
      colors.set([color.r, color.g, color.b], i * 3);
    }
    // Chỉ giữ tam giác có đỉnh trong dải giữ, rồi bỏ các đỉnh không còn dùng (vùng mặt, cổ) cho khối nhẹ. Đỉnh trùng chỗ của mặt cầu
    // (đường nối, chỏm đầu) gộp làm một, để pháp tuyến tính từ mọi tam giác quanh đó: không thành vệt ở đường nối, chong chóng ở chỏm.
    const index = g.index!;
    const used = new Int32Array(count).fill(-1);
    const seen = new Map<string, number>();
    const xyz: number[] = [];
    const rgb: number[] = [];
    const tris: number[] = [];
    for (let k = 0; k < index.count; k += 3) {
      const corner = [index.getX(k), index.getX(k + 1), index.getX(k + 2)];
      if (!keep[corner[0]] && !keep[corner[1]] && !keep[corner[2]]) continue;
      for (const v of corner) {
        if (used[v] < 0) {
          const key = `${Math.round(position.getX(v) * 1e5)},${Math.round(position.getY(v) * 1e5)},${Math.round(position.getZ(v) * 1e5)}`;
          let at = seen.get(key);
          if (at === undefined) {
            at = xyz.length / 3;
            seen.set(key, at);
            xyz.push(position.getX(v), position.getY(v), position.getZ(v));
            rgb.push(colors[v * 3], colors[v * 3 + 1], colors[v * 3 + 2]);
          }
          used[v] = at;
        }
        tris.push(used[v]);
      }
    }
    const mass = new THREE.BufferGeometry();
    mass.setAttribute("position", new THREE.Float32BufferAttribute(xyz, 3));
    mass.setAttribute("color", new THREE.Float32BufferAttribute(rgb, 3));
    mass.setIndex(tris);
    mass.computeVertexNormals();
    g.dispose();
    this.parts.push(mass);
  }

  /** Mái trước trán. Mỗi phần tử: [spin giữa lọn, tilt của ngọn, nửa bề ngang]. `sweep` đẩy ngọn lệch sang một bên. */
  fringe(list: Array<[number, number, number?]>, sweep = 0, lift = 0.19, extra: Partial<LockOpts> = {}, root = 0.08): void {
    for (const [s, tip, w] of list) {
      const sw = sweep + this.jitter(0.04);
      this.lock(
        [this.S(root, s * 0.25, 0), this.S(Math.max(0.55, root + 0.25), s * 0.78 + sw * 0.15, lift), this.S(0.55 + (tip - 0.55) * 0.62, s + sw * 0.6, lift * 0.78), this.S(tip, s + sw, 0.045)],
        // Dưới mũ che đỉnh, mái rộng và đầy ngọn hơn: phần ló ra dưới vành phủ kín trán, không hở giữa các lọn.
        { w: (w ?? 0.105) * (this.covered ? 1.18 : 1), flat: 0.42, inner: 0.4, body: this.covered ? 2.2 : 1.6, ...extra },
      );
    }
  }

  /** Lọn ôm mặt hai bên, thả xuống tới `tipY` (dưới tai là số âm), ngọn hơi cong về phía trước. */
  sidelock(side: number, spin: number, tipY: number, w = 0.1, lift = 0.17, extra: Partial<LockOpts> = {}): void {
    const s = side * spin;
    const points = [this.S(0.3, side * 0.75, 0.02), this.S(0.9, s, lift), this.S(1.4, s, lift * 0.9)];
    if (tipY > 0.02) points.push(this.S(Math.acos(tipY / RY), s - side * 0.18, 0.05));
    else points.push(this.D(s - side * 0.04, tipY * 0.45, lift * 0.75), this.D(s - side * 0.2, tipY, 0.06));
    this.lock(points, { w, flat: 0.42, body: tipY < -0.2 ? 2.3 : 1.6, ...extra });
  }

  /** Các lọn phủ sau đầu và hai bên, từ đỉnh xuống. `tip` > 0 là tilt của ngọn (tóc ngắn), < 0 là độ cao ngọn khi tóc thả dài. */
  mass(from: number, to: number, count: number, tip: number, options: { w?: number; lift?: number; flick?: number; spread?: number; vary?: number; extra?: Partial<LockOpts> } = {}): void {
    const { w = 0.145, lift = 0.17, flick = 0.03, spread = 0.12, vary = 0.08, extra = {} } = options;
    for (let i = 0; i < count; i++) {
      const s = count === 1 ? from : from + ((to - from) * i) / (count - 1);
      const points = [this.S(0.1, s, 0), this.S(0.65, s, lift), this.S(1.25, s, lift * 0.95)];
      if (tip > 0) {
        const t = tip + this.jitter(vary);
        points.push(this.S((1.25 + t) / 2 + 0.05, s, lift * 0.9), this.S(t, s + this.jitter(spread), lift * 0.85 + flick));
      } else {
        const y = tip + this.jitter(vary);
        points.push(this.D(s, -0.08, lift * 0.92), this.D(s, (y - 0.08) / 2, lift * 0.85), this.D(s + this.jitter(spread), y, lift * 0.85 + flick));
      }
      this.lock(points, { w: w * (0.9 + this.rand() * 0.2), flat: 0.45, seg: tip > 0 ? 9 : 12, body: tip > 0 ? 1.7 : 2.6, ...extra });
    }
  }

  /** Búi tóc: một khối tròn có mấy lọn quấn quanh cho ra thớ. Cả búi rộng chừng 1,5 lần `r` (lọn quấn rộng thêm nửa `r`): đặt dưới mũ thì tính cỡ đó. */
  bun(center: Vec, r: number, axis: Vec): void {
    const up = axis.clone().normalize();
    this.parts.push(tint(new THREE.SphereGeometry(r, 10, 7).translate(center.x, center.y, center.z), this.base.clone().multiplyScalar(0.78)));
    const a1 = new THREE.Vector3().crossVectors(up, Math.abs(up.y) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0)).normalize();
    for (let k = 0; k < 4; k++) {
      const q = new THREE.Quaternion().setFromAxisAngle(up, (k * Math.PI) / 4);
      const e1 = a1.clone().applyQuaternion(q);
      const e2 = new THREE.Vector3().crossVectors(up, e1).normalize().multiplyScalar(0.6).addScaledVector(up, 0.8).normalize();
      const start = k * 1.3;
      const points = Array.from({ length: 5 }, (_, i) => {
        const a = start + i * 0.62;
        return center.clone().addScaledVector(e1, Math.cos(a) * r * 1.0).addScaledVector(e2, Math.sin(a) * r * 1.0);
      });
      this.lock(points, { w: r * 0.5, flat: 0.5, inner: 0.6, body: 1.35, from: center, seg: 8, rad: 6 });
    }
  }

  /** Nơ hai cánh, `dir` là hướng nơ nhìn ra. */
  bow(center: Vec, size: number, dir: Vec, hex = SON): void {
    const front = dir.clone().normalize();
    const side = new THREE.Vector3().crossVectors(v3(0, 1, 0), front).normalize();
    for (const s of [-1, 1]) {
      const g = new THREE.SphereGeometry(size, 7, 5).scale(1.25, 0.8, 0.45);
      const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(side, v3(0, 1, 0), front));
      g.rotateZ(s * 0.3).applyQuaternion(q);
      const at = center.clone().addScaledVector(side, s * size * 1.05);
      this.paint(g.translate(at.x, at.y, at.z), hex);
    }
    this.paint(new THREE.SphereGeometry(size * 0.45, 6, 5).translate(center.x, center.y, center.z), "#8c1f12");
  }

  /** Vòng buộc tóc. */
  tie(center: Vec, r: number, dir: Vec, hex = SON): void {
    this.paint(aim(new THREE.TorusGeometry(r, r * 0.32, 6, 14).rotateX(Math.PI / 2), dir).translate(center.x, center.y, center.z), hex);
  }

  /** Bím tóc: các múi bầu dục xếp so le dọc theo đường cong. */
  braid(points: Vec[], count: number, r0: number, r1: number): void {
    const curve = new THREE.CatmullRomCurve3(points, false, "centripetal");
    for (let i = 0; i < count; i++) {
      const u = (i + 0.5) / count;
      const at = curve.getPointAt(u);
      const dir = curve.getTangentAt(u);
      const r = THREE.MathUtils.lerp(r0, r1, u);
      const g = new THREE.SphereGeometry(r, 7, 5).scale(1, 1.45, 0.78).rotateZ(i % 2 ? 0.5 : -0.5);
      const q = new THREE.Quaternion().setFromUnitVectors(v3(0, 1, 0), dir);
      g.applyQuaternion(q).translate(at.x, at.y, at.z);
      this.parts.push(tint(g, this.base.clone().multiplyScalar(i % 2 ? 0.9 : 1.02)));
    }
  }
}

export function hairParts(style: number, colorIndex: number, ceiling: Ceiling | null): Parts {
  const h = new HairKit(colorIndex, 1000 + style * 7919, ceiling);
  const S = h.S.bind(h);
  const D = h.D.bind(h);
  const top = !ceiling;
  const ahoge = (spin = 0.2) => top && h.lock([S(0.2, spin, 0.08), S(0.04, spin * 0.5, 0.26), S(0.16, spin - 0.8, 0.4)], { w: 0.035, flat: 0.5, body: 1.2, seg: 7, rad: 6 });
  switch (style) {

    case 0: {
      // Trái đào: đầu cạo, một chỏm trước đỉnh tròn như quả đào có ngọn nhọn cong ra trước, hai chỏm nhỏ hai bên.
      if (!top) return [];
      const base = S(0.3, 0, 0);
      h.solid(new THREE.SphereGeometry(0.088, 12, 9).scale(1, 0.85, 1.1).translate(base.x, base.y + 0.045, base.z + 0.01), 0.95);
      h.lock([v3(0, base.y + 0.03, base.z - 0.04), v3(0, base.y + 0.13, base.z + 0.01), v3(0, base.y + 0.165, base.z + 0.1), v3(0, base.y + 0.12, base.z + 0.18)], { w: 0.075, flat: 0.85, inner: 0.85, body: 1.25, from: v3(0, base.y - 0.06, base.z), shine: false });
      for (const side of [-1, 1]) {
        const at = S(0.66, side * 1.8, 0);
        h.solid(new THREE.SphereGeometry(0.052, 10, 8).scale(1, 0.8, 1).translate(at.x, at.y + 0.02, at.z), 0.95);
        h.lock([at.clone().multiplyScalar(1.03), at.clone().multiplyScalar(1.16).add(v3(0, 0.03, 0)), at.clone().multiplyScalar(1.24).add(v3(side * 0.05, 0.02, -0.06))], { w: 0.042, flat: 0.85, inner: 0.85, body: 1.2, from: at.clone().multiplyScalar(0.85), shine: false });
      }
      return h.parts;
    }


    case 1: {
      // Búi tó: chải ngược sát đầu (vỏ trơn cùng màu tóc), các sợi đi từ búi ra tới chân tóc, ngọn nhọn nên chân tóc không thành đường cắt bằng.
      h.shell(1.62, 0.66, 0.035, true);
      const rim = (s: number) => 1.62 - 0.66 * Math.cos(s) - 0.02;
      const bunAt = top ? S(0.42, Math.PI, 0.45) : h.below(Math.PI, 1.25, 0.24, 0.2);
      const from = (s: number) => S(top ? 0.5 : 1.0, Math.PI + s * 0.2, 0.05);
      for (let i = 0; i < 9; i++) {
        const s = -1.2 + (i * 2.4) / 8;
        h.strand([from(s), S(0.08, s * 0.5 + (s >= 0 ? 0.8 : -0.8), 0.05), S(0.4, s * 0.85, 0.05), S(rim(s) - 0.2, s, 0.04), S(rim(s) + 0.03, s, 0.0)], 0.06);
      }
      for (let i = 0; i < 6; i++) {
        const s = 1.75 + (i * (TAU - 3.5)) / 5;
        h.strand([from(s - Math.PI), S(1.2, Math.PI + (s - Math.PI) * 0.6, 0.05), S(rim(s) - 0.3, s, 0.04), S(rim(s) + 0.03, s, 0.0)], 0.065);
      }
      if (bunAt) h.bun(bunAt, 0.13, bunAt.clone().normalize());
      if (top && bunAt) {
        h.paint(new THREE.CylinderGeometry(0.013, 0.013, 0.46, 6).rotateZ(Math.PI / 2 - 0.25).translate(bunAt.x, bunAt.y + 0.02, bunAt.z), WOOD);
        h.paint(new THREE.SphereGeometry(0.028, 8, 6).translate(bunAt.x + 0.22, bunAt.y + 0.08, bunAt.z), HOE);
      }
      for (const side of [-1, 1]) h.lock([S(1.2, side * 1.0, 0.03), S(1.4, side * 1.08, 0.08), D(side * 1.08, -0.05, 0.09), D(side * 0.98, -0.22, 0.07)], { w: 0.036, flat: 0.5, body: 1.4, seg: 8, rad: 6 });
      return h.parts;
    }
    case 2: {
      // Tóc ngắn: mái chẻ lệch thành từng lọn to, mai hai bên vểnh nhọn, gáy so le.
      h.shell(1.48, 0.5, 0.04);
      h.mass(1.75, TAU - 1.75, 7, 2.02, { w: 0.15, lift: 0.17, flick: 0.06 });
      for (const side of [-1, 1]) {
        h.lock([S(0.25, side * 0.9, 0.02), S(0.85, side * 1.5, 0.18), S(1.3, side * 1.55, 0.15), S(1.52, side * 1.35, 0.07)], { w: 0.12 });
        h.lock([S(0.3, side * 0.85, 0.02), S(0.85, side * 1.12, 0.19), S(1.35, side * 1.18, 0.15), S(1.66, side * 1.05, 0.06)], { w: 0.1 });
      }
      h.fringe([[-0.78, 1.2, 0.1], [-0.4, 1.32, 0.11], [0.0, 1.37, 0.11], [0.4, 1.28, 0.11], [0.78, 1.16, 0.1]], -0.24);
      ahoge();
      return h.parts;
    }
    case 3: {
      // Hai búi: búi tròn hai bên đỉnh, mái thưa, tóc mai dài tới má.
      h.shell(1.48, 0.5, 0.04);
      h.mass(1.8, TAU - 1.8, 7, 2.08, { w: 0.15, lift: 0.15, flick: 0.03 });
      for (const side of [-1, 1]) {
        h.sidelock(side, 1.12, -0.14);
        h.lock([S(0.3, side * 1.2, 0.02), S(0.9, side * 1.55, 0.16), S(1.38, side * 1.55, 0.13), S(1.52, side * 1.4, 0.07)], { w: 0.11 });
        const at = top ? S(0.6, side * 1.3, 0.36) : h.below(side * 1.95, 1.25, 0.22, 0.19);
        if (at) h.bun(at, 0.12, at.clone().normalize());
      }
      h.fringe([[-0.7, 1.22, 0.1], [-0.33, 1.33, 0.105], [0.05, 1.29, 0.105], [0.43, 1.34, 0.105], [0.78, 1.2, 0.095]], 0.06);
      return h.parts;
    }
    case 4: {
      // Tóc dài: mái chẻ giữa, hai lọn ôm mặt dài tới ngực, sau lưng thả dài nhiều lọn so le.
      h.shell(1.5, 0.45, 0.04);
      h.mass(1.8, TAU - 1.8, 8, -0.68, { w: 0.15, lift: 0.18, flick: 0.06, vary: 0.07 });
      for (const side of [-1, 1]) {
        h.sidelock(side, 1.05, -0.46, 0.105, 0.17);
        h.sidelock(side, 1.36, -0.34, 0.1, 0.19);
      }
      h.fringe([[-0.74, 1.22, 0.1], [-0.38, 1.34, 0.105], [-0.06, 1.28, 0.1]], -0.12);
      h.fringe([[0.2, 1.3, 0.1], [0.5, 1.36, 0.105], [0.82, 1.2, 0.1]], 0.12);
      return h.parts;
    }

    case 5: {
      // Đuôi ngựa buộc cao: mái lệch, phía sau chải gọn về chỗ buộc, đuôi dày cong như lưỡi liềm.
      h.shell(1.52, 0.5, 0.035, true);
      const rim = (s: number) => 1.52 - 0.5 * Math.cos(s) - 0.04;
      const high = S(1.02, Math.PI, 0.12);
      // Đội mũ che đỉnh: chỗ buộc dời xuống dưới vành mũ; đoạn đầu đuôi dời theo, khúc giữa và ngọn chỉ hạ thêm ít (tối đa 0,15 và 0,1),
      // nên đuôi ngắn lại chứ không rủ tới chân. Mũ trùm kín tới gáy (dưới vành không còn chỗ, như Khăn ninja) thì đuôi giấu trong mũ.
      const spot = top ? high : h.below(Math.PI, 1.02, 0.12, 0.13);
      const tucked = spot === null;
      const knot = spot ?? high;
      const shift = knot.clone().sub(high);
      const sink = (most: number) => v3(shift.x, Math.max(shift.y, -most), shift.z);
      for (let i = 0; i < 7; i++) {
        const s = 1.45 + (i * (TAU - 2.9)) / 6;
        h.strand([S(rim(s), s, 0), S(rim(s) - 0.22, s, 0.045), S(1.22, Math.PI + (s - Math.PI) * 0.45, 0.05), knot], 0.055);
      }
      for (let i = 0; i < 4; i++) {
        const s = Math.PI + (i - 1.5) * 0.55;
        h.strand([S(0.3, s, 0.02), S(0.65, Math.PI + (s - Math.PI) * 0.7, 0.05), knot], 0.055);
      }
      for (const side of [-1, 1]) {
        h.sidelock(side, 1.12, -0.2, 0.095);
        h.lock([S(0.3, side * 1.1, 0.02), S(0.9, side * 1.5, 0.15), S(1.35, side * 1.6, 0.12), S(1.5, side * 1.4, 0.06)], { w: 0.1 });
      }
      if (!tucked) {
        h.tie(knot, 0.07, v3(0, 0.35, -1));
        for (let i = 0; i < 5; i++) {
          const dx = (i - 2) * 0.055;
          const len = 0.06 * Math.abs(i - 2);
          h.lock([knot.clone().add(v3(0, 0, 0.02)), knot.clone().add(v3(dx * 0.5, top ? 0.09 : 0, -0.1)), v3(dx, top ? 0.12 : 0.02, -0.62).add(shift), v3(dx * 1.3, -0.2, -0.68).add(sink(0.15)), v3(dx * 1.8, -0.5 + len, -0.55 + len * 0.3).add(sink(0.1))], { w: 0.11, flat: 0.72, inner: 0.72, bulge: 0.7, body: 1.5, seg: 12, rad: 8 });
        }
      }
      h.fringe([[-0.75, 1.2, 0.1], [-0.38, 1.33, 0.105], [0.0, 1.3, 0.105], [0.38, 1.24, 0.1], [0.72, 1.12, 0.09]], 0.2);
      return h.parts;
    }
    case 7: {
      // Hai bím thả trước vai, buộc nơ đỏ; mái chẻ giữa.
      h.shell(1.5, 0.45, 0.04);
      h.mass(1.8, TAU - 1.8, 7, 2.05, { w: 0.145, lift: 0.14, flick: 0 });
      for (const side of [-1, 1]) {
        h.sidelock(side, 1.1, -0.1, 0.09);
        const root = D(side * 1.85, -0.04, 0.16);
        const path = [root, v3(side * 0.38, -0.2, 0.0), v3(side * 0.35, -0.36, 0.1), v3(side * 0.33, -0.56, 0.15)];
        h.braid(path, 7, 0.075, 0.056);
        const end = path[3];
        h.bow(end.clone().add(v3(0, 0.0, 0.03)), 0.05, v3(side * 0.3, 0, 1));
        for (const dx of [-0.028, 0.028]) h.lock([end.clone().add(v3(0, 0.01, 0)), end.clone().add(v3(dx, -0.08, 0.01)), end.clone().add(v3(dx * 1.8, -0.17, 0.0))], { w: 0.04, flat: 0.6, seg: 6, rad: 6, from: end });
      }
      h.fringe([[-0.75, 1.22, 0.1], [-0.4, 1.33, 0.105], [-0.08, 1.28, 0.1]], -0.12);
      h.fringe([[0.16, 1.3, 0.1], [0.48, 1.34, 0.105], [0.8, 1.2, 0.095]], 0.12);
      return h.parts;
    }
    case 8: {
      // Tóc bob: phồng tròn, ngọn cụp vào ngang cằm, mái dày.
      h.shell(1.5, 0.45, 0.05);
      for (let i = 0; i < 10; i++) {
        const s = 1.05 + (i * (TAU - 2.1)) / 9;
        const front = Math.cos(s) > 0.3;
        const y = -0.2 + h.jitter(0.02);
        h.lock([S(0.1, s, 0), S(0.65, s, 0.2), S(1.3, s, 0.2), D(s, -0.08, 0.21), D(s, y + 0.07, 0.17), D(s - Math.sign(Math.sin(s)) * (front ? 0.12 : 0), y, 0.05)], { w: 0.16, flat: 0.45, seg: 11, body: 1.8 });
      }
      h.fringe([[-0.82, 1.25, 0.1], [-0.48, 1.32, 0.105], [-0.15, 1.35, 0.105], [0.18, 1.33, 0.105], [0.5, 1.3, 0.105], [0.82, 1.22, 0.1]], 0.05, 0.2);
      return h.parts;
    }
    case 9: {
      // Tóc dựng: mũi nhọn to vuốt ngược ra sau và hất lên, mái ngắn lởm chởm.
      h.shell(1.45, 0.5, 0.04, true);
      h.mass(1.9, TAU - 1.9, 6, 1.95, { w: 0.14, lift: 0.12, flick: 0.1 });
      for (const side of [-1, 1]) h.lock([S(0.4, side * 1.2, 0.02), S(0.95, side * 1.45, 0.15), S(1.4, side * 1.4, 0.11), S(1.6, side * 1.2, 0.06)], { w: 0.11 });
      if (top) {
        // [tilt, spin, dài, lệch ngang]: dài ngắn, nghiêng trái phải xen kẽ cho khỏi đều như vương miện.
        const spikes: Array<[number, number, number, number]> = [
          [0.42, 0.0, 0.3, 0], [0.48, 0.75, 0.38, 0.12], [0.48, -0.75, 0.27, -0.08], [0.62, 1.5, 0.33, 0.16], [0.6, -1.55, 0.37, -0.12],
          [0.55, 2.4, 0.41, 0.1], [0.58, -2.35, 0.3, -0.14], [0.5, Math.PI, 0.43, 0], [0.98, 2.05, 0.26, 0.2], [0.95, -2.15, 0.34, -0.16], [1.1, Math.PI, 0.3, 0.06],
        ];
        for (const [t, s, len, sway] of spikes) {
          // Gốc nằm dọc theo đầu rồi mới hất lên, nên chân mũi không thành một gờ tối.
          const lie = S(Math.max(0.02, t - 0.24), s, 0.03);
          const base = S(t, s, 0.09);
          const out = base.clone().normalize();
          const dir = out.clone().multiplyScalar(0.7).add(v3(sway, 0.4, -0.65)).normalize();
          const mid = base.clone().addScaledVector(dir, len * 0.45).addScaledVector(out, 0.03);
          const tip = base.clone().addScaledVector(dir, len).add(v3(sway * 0.5, 0.07, -0.04));
          h.lock([lie, base, mid, tip], { w: 0.15, flat: 0.55, inner: 0.7, body: 1.3, seg: 9, root: 0.9 });
        }
      }
      h.fringe([[-0.7, 1.14, 0.1], [-0.32, 1.24, 0.105], [0.06, 1.2, 0.105], [0.44, 1.26, 0.1], [0.78, 1.12, 0.09]], 0.16, 0.17, { body: 1.25, root: 0.95 }, 0.3);
      return h.parts;
    }
    case 10: {
      // Tóc xoăn: nhiều lọn cong chữ C chồng lên nhau.
      h.shell(1.5, 0.45, 0.07);
      const rows: Array<[number, number, number]> = [[0.05, 1, 0], [0.42, 6, 0.3], [0.82, 8, 0.1], [1.2, 9, 0.4], [1.58, 8, 0.15]];
      for (const [t, count, offset] of rows) {
        for (let i = 0; i < count; i++) {
          const s = ((i + offset) / count) * TAU;
          if (Math.cos(s) > 0.55 && t > 0.9) continue; // chừa mặt
          if (Math.abs(Math.sin(s)) > 0.92 && t > 1.3) continue; // chừa tai
          const tt = t + h.jitter(0.05);
          const ss = s + h.jitter(0.1);
          h.lock([S(tt, ss, 0.04), S(tt + 0.1, ss, 0.18), S(tt + 0.27, ss + 0.05, 0.22), S(tt + 0.35, ss + 0.08, 0.13), S(tt + 0.28, ss + 0.1, 0.08), S(tt + 0.21, ss + 0.08, 0.12)], { w: 0.1, flat: 0.85, inner: 0.8, body: 1.6, seg: 8, rad: 7, shine: false, root: 0.75 });
        }
      }
      for (const s of [-0.62, -0.21, 0.21, 0.62]) h.lock([S(0.75, s, 0.06), S(0.95, s, 0.2), S(1.15, s + 0.05, 0.17), S(1.24, s + 0.1, 0.09), S(1.16, s + 0.12, 0.07), S(1.1, s + 0.1, 0.12)], { w: 0.095, flat: 0.85, inner: 0.8, body: 1.6, seg: 8, rad: 7, shine: false, root: 0.75 });
      return h.parts;
    }
    case 11: {
      // Mái bằng: mái cắt ngang thành nhiều lọn đều, hai lọn ôm má cắt ngang, sau lưng thẳng dài.
      h.shell(1.5, 0.45, 0.04);
      h.mass(1.8, TAU - 1.8, 8, -0.62, { w: 0.15, lift: 0.16, flick: 0, spread: 0.02, vary: 0.012, extra: { body: 4 } });
      for (const side of [-1, 1]) {
        h.sidelock(side, 1.08, -0.2, 0.1, 0.17, { body: 4 });
        h.sidelock(side, 1.34, -0.26, 0.1, 0.18, { body: 4 });
      }
      const bangs: Array<[number, number, number]> = [];
      for (let i = 0; i < 7; i++) bangs.push([-0.86 + (i * 1.72) / 6, 1.3 + h.jitter(0.01), 0.085]);
      h.fringe(bangs, 0, 0.18, { body: 4 });
      return h.parts;
    }
    case 12: {
      // Hai đuôi buộc cao hai bên, nơ đỏ, đuôi xòe rộng cong ra ngoài.
      h.shell(1.48, 0.5, 0.04);
      h.mass(1.8, TAU - 1.8, 7, 2.05, { w: 0.15, lift: 0.15, flick: 0.02 });
      for (const side of [-1, 1]) {
        h.sidelock(side, 1.1, -0.16, 0.09);
        // Dưới mũ không còn chỗ buộc (mũ ôm sát xuống ngang cổ) thì đuôi giấu trong mũ.
        const knot = top ? S(0.72, side * 1.8, 0.18) : h.below(side * 1.8, 1.1, 0.12, 0.17);
        if (!knot) continue;
        // Đội mũ che đỉnh: đuôi không vồng lên khỏi chỗ buộc, kẻo chạm vành mũ.
        const bump = top ? 0.07 : 0;
        h.tie(knot, 0.055, v3(side, 0.2, -0.2));
        h.bow(knot.clone().add(v3(side * 0.02, 0.06, 0)), 0.055, v3(side, 0.15, 0.3));
        for (let i = 0; i < 4; i++) {
          const dz = (i - 1.5) * 0.045;
          const drop = 0.05 * Math.abs(i - 1.5);
          h.lock([knot.clone(), knot.clone().add(v3(side * 0.12, bump, dz * 0.5)), v3(side * 0.64, -0.06, knot.z + dz - 0.05), v3(side * 0.64, -0.38 + drop, knot.z + dz * 1.3), v3(side * (0.52 - drop), -0.64 + drop * 1.5, knot.z + dz * 1.6 + 0.04)], { w: 0.11, flat: 0.72, inner: 0.72, bulge: 0.6, body: 1.5, seg: 12, rad: 8 });
        }
      }
      h.fringe([[-0.72, 1.2, 0.1], [-0.36, 1.33, 0.105], [0.0, 1.27, 0.105], [0.36, 1.34, 0.105], [0.72, 1.2, 0.1]], -0.05);
      return h.parts;
    }
    case 13: {
      // Mái lệch dài che một bên mắt.
      h.shell(1.48, 0.5, 0.04);
      h.mass(1.8, TAU - 1.8, 7, 2.12, { w: 0.15, lift: 0.16, flick: 0.07 });
      for (const side of [-1, 1]) h.lock([S(0.3, side * 1.0, 0.02), S(0.9, side * 1.45, 0.17), S(1.4, side * 1.45, 0.13), S(1.66, side * 1.25, 0.07)], { w: 0.115 });
      const sweepers: Array<[number, number, number, number]> = [
        [-1.05, -0.55, 1.14, 0.09], [-0.8, -0.12, 1.38, 0.11], [-0.6, 0.3, 1.62, 0.12], [-0.35, 0.64, 1.52, 0.11], [-0.1, 0.98, 1.38, 0.1],
      ];
      for (const [root, end, tip, w] of sweepers) {
        h.lock([S(0.12, root * 0.4, 0), S(0.55, root * 0.6 + end * 0.2, 0.2), S(0.95, (root + end) * 0.5 + 0.1, 0.16), S(tip, end, 0.05)], { w, flat: 0.4, inner: 0.4, body: 1.6 });
      }
      h.lock([S(0.2, 1.1, 0.02), S(0.8, 1.2, 0.18), S(1.3, 1.22, 0.14), D(1.12, -0.08, 0.12), D(1.0, -0.2, 0.07)], { w: 0.095 });
      return h.parts;
    }


    case 14: {
      // Chẻ ngôi: rẽ ngôi một bên, cả mảng tóc vuốt phồng sang bên kia rồi ra sau, lộ trán; bên ngôi chải gọn xuống.
      h.shell(1.45, 0.5, 0.04);
      h.mass(1.8, TAU - 1.8, 7, 2.02, { w: 0.145, lift: 0.14, flick: 0.04 });
      const part = -0.62;
      const sweep: Array<[number, number, number]> = [[0.5, 0.0, 0.13], [0.42, 0.35, 0.13], [0.35, 0.75, 0.125], [0.3, 1.15, 0.12]];
      for (const [t, lead, w] of sweep) {
        h.lock([S(t, part + 0.05, 0), S(t + 0.12, part * 0.35 + lead * 0.6, 0.2), S(t + 0.32, lead + 0.35, 0.21), S(t + 0.72, lead + 0.85, 0.16), S(t + 1.05, lead + 1.2, 0.08)], { w, flat: 0.48, body: 1.8, seg: 11 });
      }
      h.lock([S(0.45, part + 0.2, 0), S(0.78, 0.0, 0.19), S(1.02, 0.28, 0.13), S(1.22, 0.42, 0.05)], { w: 0.09, flat: 0.42, body: 1.6 });
      for (const [s, tip] of [[-0.95, 1.45], [-1.3, 1.55]] as Array<[number, number]>) h.lock([S(0.55, part - 0.05, 0), S(0.9, s, 0.16), S(1.3, s - 0.2, 0.12), S(tip, s - 0.35, 0.06)], { w: 0.11 });
      h.lock([S(0.3, 1.2, 0.02), S(0.9, 1.45, 0.16), S(1.35, 1.5, 0.12), S(1.58, 1.3, 0.06)], { w: 0.11 });
      return h.parts;
    }
    case 15: {
      // Tóc sói: nhiều tầng, ngọn vểnh ra ngoài ở má và gáy, mái lởm chởm.
      h.shell(1.5, 0.45, 0.05);
      for (let i = 0; i < 9; i++) {
        const s = 1.2 + (i * (TAU - 2.4)) / 8;
        const y = -0.28 + h.jitter(0.04);
        h.lock([S(0.4, s, 0.02), S(1.0, s, 0.18), S(1.45, s, 0.18), D(s, -0.1, 0.2), D(s + h.jitter(0.1), y, 0.32)], { w: 0.14, flat: 0.45, seg: 10 });
      }
      for (let i = 0; i < 7; i++) {
        const s = 1.6 + (i * (TAU - 3.2)) / 6;
        h.lock([S(0.08, s, 0), S(0.5, s, 0.21), S(0.95, s, 0.25), S(1.2 + h.jitter(0.06), s + h.jitter(0.1), 0.36)], { w: 0.14, flat: 0.45, body: 1.35 });
      }
      for (const side of [-1, 1]) h.lock([S(0.3, side * 0.8, 0.02), S(0.9, side * 1.1, 0.19), S(1.4, side * 1.12, 0.16), D(side * 1.08, -0.12, 0.15), D(side * 1.25, -0.22, 0.27)], { w: 0.1 });
      h.fringe([[-0.82, 1.12, 0.09], [-0.52, 1.3, 0.09], [-0.25, 1.2, 0.09], [0.02, 1.36, 0.095], [0.3, 1.22, 0.09], [0.57, 1.32, 0.09], [0.85, 1.1, 0.085]], 0.08, 0.2, { body: 1.35 });
      return h.parts;
    }
    case 16: {
      // Tóc nấm (two-block): vòm dày tròn như mũ nấm, trước rủ tới chân mày, hai bên phủ quá tai, ngọn cắt gần một đường; dưới vòm cạo ngắn.
      h.shell(1.75, 0.75, 0.012, false, 0.4);
      h.shell(1.4, 0.45, 0.06);
      const cut = (s: number) => 1.3 + (0.42 * (1 - Math.cos(s))) / 2;
      for (let i = 0; i < 16; i++) {
        const s = (i / 16) * TAU + h.jitter(0.05);
        const t = cut(s) + h.jitter(0.02);
        h.lock([S(0.06, s, 0), S(0.6, s, 0.2), S(t - 0.3, s, 0.2), S(t, s + 0.03, 0.13)], { w: 0.13, flat: 0.45, body: 2.6, point: 1.2 });
      }
      return h.parts;
    }
    case 17: {
      // Ngôi giữa (tóc 5/5): rẽ giữa, hai cánh mái cong ra hai bên như rèm, lộ tam giác trán; hai bên phủ nửa tai.
      h.shell(1.48, 0.5, 0.04);
      h.mass(1.75, TAU - 1.75, 7, 2.05, { w: 0.145, lift: 0.16, flick: 0.04 });
      for (const side of [-1, 1]) {
        const wing: Array<[number, number, number]> = [[0.12, 1.42, 0.115], [0.42, 1.5, 0.11], [0.75, 1.55, 0.1]];
        for (const [start, tip, w] of wing) {
          h.lock([S(0.12, side * start * 0.5, 0), S(0.55, side * (start + 0.1), 0.2), S(1.0, side * (start + 0.45), 0.18), S(tip, side * (start + 0.75), 0.07)], { w, flat: 0.42, body: 1.7 });
        }
        h.lock([S(0.3, side * 1.2, 0.02), S(0.9, side * 1.45, 0.17), S(1.4, side * 1.45, 0.13), D(side * 1.3, -0.12, 0.08)], { w: 0.1 });
      }
      return h.parts;
    }
    case 18: {
      // Búi củ tỏi: chải gọn lên đỉnh thành một búi to rối, vài lọn lòi ra khỏi búi, hai lọn mai mảnh xuống má, gáy gọn.
      h.shell(1.6, 0.55, 0.035, true);
      const rim = (s: number) => 1.6 - 0.55 * Math.cos(s) - 0.02;
      const bunAt = top ? S(0.2, Math.PI, 0.5) : h.below(Math.PI, 1.28, 0.2, 0.19);
      const into = (s: number) => S(top ? 0.3 : 1.3, Math.PI + s * 0.15, 0.05);
      for (let i = 0; i < 12; i++) {
        const s = (i / 12) * TAU;
        h.strand([into(s - Math.PI), S((rim(s) + 0.3) / 2, s, 0.05), S(rim(s) + 0.03, s, 0)], 0.065);
      }
      if (bunAt) h.bun(bunAt, top ? 0.16 : 0.12, bunAt.clone().normalize());
      if (top && bunAt) {
        // búi rối: một cục nhỏ lệch bên cạnh và mấy lọn lòi ra, dài ngắn khác nhau
        h.solid(new THREE.SphereGeometry(0.09, 10, 8).translate(bunAt.x + 0.08, bunAt.y + 0.06, bunAt.z + 0.03), 0.8);
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * TAU + 0.4;
          const reach = 0.17 + (i % 3) * 0.04;
          const tip = bunAt.clone().add(v3(Math.cos(a) * reach, 0.06 + (i % 2) * 0.07, Math.sin(a) * reach));
          h.lock([bunAt.clone(), bunAt.clone().lerp(tip, 0.6).add(v3(0, 0.04, 0)), tip], { w: 0.045, flat: 0.6, body: 1.3, from: bunAt, seg: 6, rad: 6 });
        }
      }
      for (const side of [-1, 1]) h.lock([S(1.1, side * 1.0, 0.02), S(1.35, side * 1.08, 0.07), D(side * 1.05, -0.06, 0.08), D(side * 0.95, -0.2, 0.06)], { w: 0.035, flat: 0.5, body: 1.4, seg: 8, rad: 6 });
      return h.parts;
    }
    case 19: {
      // Xoăn sóng: tóc dài gợn sóng chữ S lớn, sóng to dần về ngọn; mái lệch nhẹ.
      h.shell(1.5, 0.45, 0.04);
      const wave = (s: number, phase: number, tipY: number, w: number) => {
        const points = [S(0.1, s, 0), S(0.65, s, 0.18), S(1.25, s, 0.18)];
        for (let k = 1; k <= 5; k++) {
          const y = -0.02 + (k / 5) * (tipY + 0.02);
          const swing = Math.sin(phase + k * 1.6);
          points.push(D(s + swing * 0.14, y, 0.18 + swing * 0.12 + k * 0.015));
        }
        h.lock(points, { w, flat: 0.45, body: 2.6, seg: 14 });
      };
      for (let i = 0; i < 8; i++) wave(1.8 + (i * (TAU - 3.6)) / 7, i * 0.9, -0.66 + h.jitter(0.05), 0.14);
      for (const side of [-1, 1]) {
        wave(side * 1.05, 0.5, -0.45, 0.1);
        wave(side * 1.35, 1.7, -0.38, 0.1);
      }
      h.fringe([[-0.75, 1.22, 0.1], [-0.38, 1.33, 0.105], [0.0, 1.3, 0.105], [0.38, 1.25, 0.1], [0.72, 1.15, 0.09]], 0.15);
      return h.parts;
    }
    case 20: {
      // Xoắn ốc: tóc dài vừa, mái thưa, hai lọn xoắn lò xo to hai bên mặt, gốc mỗi lọn có nơ; nửa dưới lọn xoắn nhuộm sáng dần.
      h.shell(1.5, 0.45, 0.04);
      h.mass(1.8, TAU - 1.8, 8, -0.5, { w: 0.15, lift: 0.17, flick: 0.04, vary: 0.05, extra: { dye: 0.7 } });
      for (const side of [-1, 1]) {
        // Đội mũ che đỉnh: lọn xoắn bắt đầu thấp hơn, ngay dưới vành mũ, bỏ đoạn dẫn từ thái dương (đoạn đó sẽ xuyên qua mũ).
        const top0 = D(side * 1.38, top ? -0.02 : -0.1, 0.22);
        const coil: Vec[] = top ? [S(1.05, side * 1.2, 0.06), S(1.35, side * 1.33, 0.14)] : [];
        // Vòng khít (bước xoắn gần bằng bề dày lọn) và nhỏ dần xuống dưới: thành mũi khoan có rãnh xoắn.
        for (let k = 0; k <= 52; k++) {
          const a = k * 0.6 + (side > 0 ? Math.PI : 0);
          const r = 0.09 * (1 - k / 80);
          coil.push(top0.clone().add(v3(Math.cos(a) * r, -k * 0.0095, Math.sin(a) * r)));
        }
        h.lock(coil, { w: 0.065, flat: 0.92, inner: 0.92, body: 3.5, seg: 70, rad: 7, axis: { at: top0, dir: v3(0, -1, 0) }, dye: 0.45 });
        h.bow(top0.clone().add(v3(side * 0.02, 0.04, 0.04)), 0.045, v3(side * 0.4, 0, 1));
      }
      h.fringe([[-0.7, 1.24, 0.095], [-0.35, 1.3, 0.1], [0, 1.28, 0.1], [0.35, 1.3, 0.1], [0.7, 1.24, 0.095]], 0, 0.18, { body: 2.4 });
      return h.parts;
    }
    case 21: {
      // Mào gà: hai bên cạo sát (vỏ tối), giữa một dải tóc từ trán ra gáy, trên dải một hàng vây dựng cao, vây giữa cao nhất; ngọn vây nhuộm.
      h.shell(1.6, 0.55, 0.012, false, 0.4);
      // Dải mào chạy từ gáy lên, ngọn thon ở trán: đầu gốc bằng của lọn nằm thấp ở gáy, sát da, không thành khối hộp trên trán.
      h.lock([S(2.0, Math.PI, -0.01), S(1.6, Math.PI, 0.03), S(1.2, Math.PI, 0.035), S(0.5, Math.PI, 0.04), S(0.05, 0, 0.045), S(0.5, 0, 0.04), S(0.98, 0, 0.02)], { w: 0.11, flat: 0.35, body: 3, seg: 12 });
      if (top) {
        // [tilt, dài]; ba vây đầu ở phía trước đỉnh (spin 0), còn lại phía sau (spin π).
        const fins: Array<[number, number]> = [[0.62, 0.2], [0.32, 0.3], [0.05, 0.38], [0.35, 0.36], [0.7, 0.3], [1.1, 0.24], [1.5, 0.17]];
        fins.forEach(([t, len], i) => {
          const spin = i >= 3 ? Math.PI : 0;
          const root = S(t, spin, 0.03);
          const out = root.clone().normalize();
          const tip = root.clone().addScaledVector(out, len).add(v3(0, 0, -0.05));
          h.lock([S(t + 0.12, spin, 0.02), root.clone().addScaledVector(out, 0.04), root.clone().addScaledVector(out, len * 0.55), tip], { w: 0.12, flat: 0.32, inner: 1, body: 1.25, seg: 9, normal: v3(1, 0, 0), dye: 0.55 });
        });
      }
      return h.parts;
    }
    case 22: {
      // Tóc lửa: lọn từ chân tóc quanh đầu hất ngược lên thành khối lửa, ngọn cao thấp so le uốn ra sau; từ giữa lọn lên ngọn nhuộm sáng dần.
      h.shell(1.55, 0.5, 0.04, true);
      const rim = (s: number) => 1.55 - 0.5 * Math.cos(s) - 0.03;
      for (let i = 0; i < 14; i++) {
        const s = (i / 14) * TAU + h.jitter(0.06);
        const t0 = rim(s);
        if (!top && t0 < 1.2) continue;
        const tall = 0.75 + 0.2 * Math.cos(s * 2 + 0.6) + h.jitter(0.05);
        const peak = v3(Math.sin(s) * 0.3, 0.34 + tall * 0.42, Math.cos(s) * 0.14 - 0.05);
        const points = [S(t0 + 0.02, s, 0), S(t0 - 0.45, s, 0.12)];
        if (top) points.push(S(0.45, s, 0.28), peak, peak.clone().add(v3(Math.sin(s) * 0.05, 0.08, -0.12)));
        h.lock(points, { w: 0.12, flat: 0.5, body: 1.4, bulge: 0.15, seg: 11, dye: 0.35 });
      }
      return h.parts;
    }
    case 23: {
      // Vấn tóc (Bắc Bộ xưa): rẽ giữa, tóc chải ép sát; vành tóc vấn tròn quanh đầu gồm ba sợi xoắn, một sợi nhuộm;
      // đuôi tóc thò ra cạnh tai trái nhân vật (phía +x) rủ xuống má. Mối vành nằm đúng chỗ đuôi thò ra.
      h.shell(1.62, 0.5, 0.03, true);
      for (const side of [-1, 1]) {
        for (let i = 0; i < 4; i++) {
          const s = side * (0.12 + i * 0.38);
          h.strand([S(0.12, side * 0.1, 0.03), S(0.7, s, 0.04), S(1.2, s * 1.05, 0.04)], 0.06);
        }
      }
      if (top) {
        const start = 1.42;
        const ring = (a: number) => S(0.9 + 0.1 * Math.cos(a), a, 0.2);
        for (let j = 0; j < 3; j++) {
          const points: Vec[] = [];
          for (let k = 0; k <= 48; k++) {
            const a = start + (k / 48) * TAU;
            const c = ring(a);
            const along = ring(a + 0.01).sub(c).normalize();
            const outward = c.clone().setY(0).normalize();
            const up = new THREE.Vector3().crossVectors(along, outward).normalize();
            const twist = a * 4 + (j * TAU) / 3;
            points.push(c.clone().addScaledVector(outward, Math.cos(twist) * 0.035).addScaledVector(up, Math.sin(twist) * 0.035));
          }
          h.lock(points, { w: 0.04, flat: 0.9, inner: 0.9, body: 6, seg: 60, rad: 6, from: v3(0, 0.2, 0), dye: j === 0 ? 0 : undefined });
        }
      }
      h.lock([S(1.0, 1.42, 0.24), S(1.25, 1.5, 0.22), D(1.5, -0.12, 0.2), D(1.45, -0.32, 0.12)], { w: 0.07, flat: 0.6, body: 1.6 });
      return h.parts;
    }
    case 24: {
      // Phi tiên: tóc dài thẳng chẻ giữa, hai lọn mảnh rủ hai bên mặt; trên đỉnh hai vòng tóc rỗng dựng nghiêng ra ngoài, chân vòng cài trâm vàng có hạt hồng.
      // Ngọn tóc dài và nửa sau mỗi vòng nhuộm.
      h.shell(1.5, 0.45, 0.04);
      h.mass(1.8, TAU - 1.8, 8, -0.7, { w: 0.15, lift: 0.15, flick: 0, spread: 0.03, vary: 0.03, extra: { dye: 0.75 } });
      for (const side of [-1, 1]) {
        h.sidelock(side, 1.12, -0.42, 0.06, 0.15, { dye: 0.75 });
        h.lock([S(0.85, side * 0.55, 0.05), S(1.2, side * 0.75, 0.08), D(side * 0.85, -0.1, 0.07), D(side * 0.8, -0.3, 0.05)], { w: 0.035, flat: 0.5, body: 1.5, seg: 8, rad: 6 });
        if (!top) continue;
        const base = S(0.42, side * 1.05, 0.12);
        const tiltOut = v3(side * 0.5, 1, 0).normalize();
        const center = base.clone().addScaledVector(tiltOut, 0.14);
        const e1 = tiltOut.clone().negate();
        const e2 = new THREE.Vector3().crossVectors(v3(0, 0, 1), e1).normalize();
        const loop: Vec[] = [];
        for (let k = 0; k <= 20; k++) {
          const a = (k / 20) * TAU * 0.92;
          loop.push(center.clone().addScaledVector(e1, Math.cos(a) * 0.14).addScaledVector(e2, Math.sin(a) * 0.14 * side));
        }
        h.lock(loop, { w: 0.075, flat: 0.75, inner: 0.85, body: 4, seg: 26, axis: { at: center, dir: v3(0, 0, 1) }, dye: 0.5 });
        h.paint(new THREE.CylinderGeometry(0.011, 0.011, 0.2, 6).rotateZ(side * 0.9).translate(base.x, base.y + 0.02, base.z + 0.03), HOE);
        h.paint(new THREE.SphereGeometry(0.024, 8, 6).translate(base.x + side * 0.08, base.y + 0.07, base.z + 0.03), "#e05a7a");
      }
      h.fringe([[-0.62, 1.24, 0.09], [-0.25, 1.2, 0.08]], -0.1, 0.16);
      h.fringe([[0.25, 1.2, 0.08], [0.62, 1.24, 0.09]], 0.1, 0.16);
      return h.parts;
    }
    case 25: {
      // Xù bông (afro): khối tóc tròn to gấp rưỡi đầu, chừa mặt, viền chân tóc lởm chởm ở trán. Mặt tóc là một mặt cầu gợn lồi lõm
      // như nhiều cụm xoăn nhỏ liền nhau; chỗ lồi nhất ngả màu nhuộm nhẹ. Đội mũ che đỉnh thì chỉ còn vành xù dưới vành mũ, chừa mặt.
      if (top) {
        h.afro(v3(0, 0.1, -0.04), 0.53, 0.05);
      } else {
        const center = v3(0, 0, -0.03);
        h.curly(new THREE.SphereGeometry(0.41, 40, 8, Math.PI / 2 + 0.9, TAU - 1.8, 1.25, 0.9).translate(center.x, center.y, center.z), center, 0.04);
        h.clip(h.parts[h.parts.length - 1]);
      }
      return h.parts;
    }
    default: // Đầu trọc
      return [];
  }
}

/** Mũ không che đỉnh đầu phóng ra theo độ phồng của tóc, để vòng hoa, tai thỏ không chìm trong tóc. */
export function fitHat(hair: number, hat: number, parts: Parts): Parts {
  const k = HAIR_VOLUME[hair] ?? 1;
  if (!OPEN_HATS.has(hat) || k === 1) return parts;
  return parts.map((part) => part.scale(k, k, k));
}
