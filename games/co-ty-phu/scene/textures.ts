// Mặt bàn cờ vẽ một lần lên một tấm ảnh: 40 ô, dải màu, tên đất, giá, biểu tượng, và khu phố giữa bàn.
// Cả bàn chỉ là một mặt phẳng dán ảnh này, nên điện thoại chỉ tốn một lần vẽ cho cả bàn.

import * as THREE from "three";
import { paint } from "../../ma-soi/scene/textures";
import { GROUPS, SQUARES } from "../board";
import type { BoardArt, CornerKind } from "./art";
import { BAND, CORNER, HALF, SIDE, TILE, VIEW_YAW, tileCenter, tileYaw } from "./layout";

/** Cạnh tấm ảnh mặt bàn, đủ nét để đọc tên ô khi camera theo sát quân. */
export const BOARD_PX = 2048;
const K = BOARD_PX / SIDE;
/** Xoay chừng này thì chữ nằm ngang trên màn hình, vì camera nhìn chéo từ góc Xuất phát. */
const LEVEL = -VIEW_YAW;

// Giấy trắng, mực xanh đen, đường kẻ xám: màu trung tính, không ngả vàng, cho ảnh minh họa và dải màu của đất nổi lên.
const PAPER = "#fafbfc";
const INK = "#17212b";
const LINE = "#aab4bf";
const LAWN = "#9fd39a";
const ROAD = "#7d848c";
const PAVEMENT = "#e4e8ec";
/** Nền ô góc và màu tấm tên của từng góc. */
const CORNER_PAPER = "#eef2f5";
const CORNER_INK: Record<CornerKind, string> = { start: "#e8543f", jail: "#12838f", rest: "#1f9d6b", arrest: "#c8352a" };

/** Hai dòng: chữ đầu một dòng, phần còn lại một dòng. */
function lines(text: string): string[] {
  const space = text.indexOf(" ");
  return space < 0 ? [text] : [text.slice(0, space), text.slice(space + 1)];
}

/** Viết chữ vừa khung: chữ dài thì thu nhỏ lại cho khỏi tràn ô. */
function fitText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, maxWidth: number, family: string, weight = "800"): void {
  ctx.font = `${weight} ${size}px ${family}`;
  const width = ctx.measureText(text).width;
  if (width > maxWidth) ctx.font = `${weight} ${Math.floor((size * maxWidth) / width)}px ${family}`;
  ctx.fillText(text, x, y);
}

/** Vẽ ảnh vừa khung rộng `width`, cao `height`, tâm ở (`x`, `y`), giữ tỉ lệ. */
function fitImage(ctx: CanvasRenderingContext2D, image: HTMLImageElement, x: number, y: number, width: number, height: number): void {
  const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
  const w = image.naturalWidth * scale;
  const h = image.naturalHeight * scale;
  ctx.drawImage(image, x - w / 2, y - h / 2, w, h);
}

function drawIcon(ctx: CanvasRenderingContext2D, kind: string, y: number): void {
  const u = K;
  ctx.save();
  ctx.translate(0, y * u);
  if (kind === "chance") {
    ctx.fillStyle = "#f08a1c";
    ctx.font = `900 ${0.9 * u}px sans-serif`;
    ctx.fillText("?", 0, 0);
  } else if (kind === "chest") {
    // Bao lì xì: nền đỏ, nắp vàng.
    ctx.fillStyle = "#d32f22";
    ctx.beginPath();
    ctx.roundRect(-0.36 * u, -0.42 * u, 0.72 * u, 0.84 * u, 0.06 * u);
    ctx.fill();
    ctx.fillStyle = "#f2c14e";
    ctx.beginPath();
    ctx.moveTo(-0.36 * u, -0.42 * u);
    ctx.lineTo(0.36 * u, -0.42 * u);
    ctx.lineTo(0, -0.12 * u);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, 0.12 * u, 0.12 * u, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === "station") {
    // Toa xe: thân bo góc, hai cửa sổ, hai bánh.
    ctx.fillStyle = "#3b4a5c";
    ctx.beginPath();
    ctx.roundRect(-0.42 * u, -0.34 * u, 0.84 * u, 0.56 * u, 0.12 * u);
    ctx.fill();
    ctx.fillStyle = "#cfe6f5";
    ctx.fillRect(-0.32 * u, -0.24 * u, 0.26 * u, 0.2 * u);
    ctx.fillRect(0.06 * u, -0.24 * u, 0.26 * u, 0.2 * u);
    ctx.fillStyle = INK;
    for (const x of [-0.24, 0.24]) {
      ctx.beginPath();
      ctx.arc(x * u, 0.26 * u, 0.09 * u, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (kind === "power") {
    ctx.fillStyle = "#f5c518";
    ctx.strokeStyle = INK;
    ctx.lineWidth = 0.04 * u;
    ctx.beginPath();
    for (const [x, py] of [[0.08, -0.48], [-0.26, 0.04], [-0.02, 0.04], [-0.1, 0.48], [0.26, -0.06], [0.02, -0.06]]) ctx.lineTo(x * u, py * u);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else if (kind === "water") {
    ctx.fillStyle = "#2f8fd8";
    ctx.beginPath();
    ctx.moveTo(0, -0.46 * u);
    ctx.bezierCurveTo(0.34 * u, -0.06 * u, 0.32 * u, 0.36 * u, 0, 0.38 * u);
    ctx.bezierCurveTo(-0.32 * u, 0.36 * u, -0.34 * u, -0.06 * u, 0, -0.46 * u);
    ctx.fill();
  } else if (kind === "tax") {
    ctx.fillStyle = "#e0b33a";
    ctx.beginPath();
    ctx.arc(0, 0, 0.36 * u, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = INK;
    ctx.font = `800 ${0.46 * u}px sans-serif`;
    ctx.fillText("₫", 0, 0.02 * u);
  }
  ctx.restore();
}

/**
 * Ô thường vẽ như ở hàng dưới: dải màu phía trên (phía xa người đọc), tên ở giữa, giá ở mép trước. Nhìn cả bàn trên điện thoại
 * thì ô rất nhỏ, tên khó đọc, nên giá viết thật to; muốn đọc tên thì chạm ô hay phóng to.
 */
function drawTile(ctx: CanvasRenderingContext2D, index: number, fonts: { text: string; title: string }, art: BoardArt | null): void {
  const square = SQUARES[index];
  const u = K;
  const w = TILE * u;
  const h = CORNER * u;
  ctx.fillStyle = square.kind === "card" ? (square.deck === "chest" ? "#ffe9e4" : "#e4f3fb") : PAPER;
  ctx.fillRect(-w / 2, -h / 2, w, h);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  let nameY = -0.3;
  if (square.kind === "city") {
    ctx.fillStyle = GROUPS[square.group].color;
    ctx.fillRect(-w / 2, -h / 2, w, BAND * u);
  } else if (square.kind === "station" || square.kind === "utility" || square.kind === "tax" || square.kind === "card") {
    const icon = square.kind === "utility" ? (/power/i.test(square.name) ? "power" : "water") : square.kind === "card" ? square.deck : square.kind;
    // Ô có giá thì hình nhỏ lại, chừa chỗ cho giá.
    const card = square.kind === "card";
    if (card && art) {
      fitImage(ctx, art.decks[square.deck], 0, 0.36 * u, w * 0.9, 1.6 * u);
    } else {
      ctx.save();
      ctx.translate(0, (card ? 0.25 : 0.02) * u);
      if (!card) ctx.scale(0.75, 0.75);
      drawIcon(ctx, icon, 0);
      ctx.restore();
    }
    nameY = -0.85;
  }

  ctx.fillStyle = INK;
  const rest = square.name.slice(square.short.length).trim();
  const [first, second] = square.kind === "station" ? [square.short, rest] : lines(square.short);
  const size = 0.32 * u;
  if (second) {
    fitText(ctx, first, 0, (nameY - 0.18) * u, size, w * 0.92, fonts.text);
    fitText(ctx, second, 0, (nameY + 0.18) * u, size, w * 0.92, fonts.text);
  } else {
    fitText(ctx, first, 0, nameY * u, size, w * 0.92, fonts.text);
  }

  // Thuế ghi số tiền phải trả, có dấu trừ.
  const price = "price" in square ? square.price : square.kind === "tax" ? square.amount : null;
  if (price !== null) fitText(ctx, square.kind === "tax" ? `−${price}` : String(price), 0, (square.kind === "city" ? 0.66 : 0.72) * u, 0.6 * u, w * 0.92, fonts.text, "900");
}

/** Tấm tên bo góc, chữ trắng trên nền màu của góc. */
function plateText(ctx: CanvasRenderingContext2D, text: string, y: number, size: number, maxWidth: number, family: string, color: string): void {
  ctx.font = `400 ${size}px ${family}`;
  const width = Math.min(maxWidth, ctx.measureText(text).width) + size * 0.9;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(-width / 2, y - size * 0.74, width, size * 1.48, size * 0.74);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  fitText(ctx, text, 0, y + size * 0.04, size, maxWidth, family, "400");
}

const CORNER_TITLE: Record<CornerKind, string> = { start: "DEPARTURE", jail: "CUSTOMS", rest: "TRANSIT LOUNGE", arrest: "VISA DENIED" };

/**
 * Ô góc: tấm tên ở trên, ảnh minh họa ở giữa, một dòng nhỏ ở dưới. Ai đứng ở ô góc thì đứng ở nửa ngoài của ô, trên ảnh
 * (xem `standSpot`); tên ở mép trong nên không bị che. Chưa có ảnh thì chỉ có chữ.
 */
function drawCorner(ctx: CanvasRenderingContext2D, index: number, fonts: { text: string; title: string }, salary: number, art: BoardArt | null): void {
  const u = K;
  const h = CORNER * u;
  const kind = SQUARES[index].kind as CornerKind;
  ctx.fillStyle = CORNER_PAPER;
  ctx.fillRect(-h / 2, -h / 2, h, h);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // Camera nhìn chéo thì chữ và hình xoay theo cho nằm ngang trên màn hình.
  ctx.rotate(LEVEL);
  if (art) fitImage(ctx, art.corners[kind], 0, 0.12 * u, 2.3 * u, 1.62 * u);
  plateText(ctx, CORNER_TITLE[kind], -0.98 * u, 0.26 * u, 1.9 * u, fonts.title, CORNER_INK[kind]);

  const noteY = 1.06 * u;
  if (kind === "start") {
    // Tiền qua Xuất phát của ván này, và mũi tên chỉ hướng đi: sang trái, về phía Tạm giữ.
    ctx.fillStyle = CORNER_INK.start;
    fitText(ctx, `+${salary.toLocaleString("en-US")}`, 0.3 * u, noteY, 0.3 * u, 1.3 * u, fonts.text, "900");
    ctx.beginPath();
    for (const [x, y] of [[-1.05, 0], [-0.72, -0.17], [-0.72, -0.07], [-0.3, -0.07], [-0.3, 0.07], [-0.72, 0.07], [-0.72, 0.17]]) ctx.lineTo(x * u, noteY + y * u);
    ctx.closePath();
    ctx.fill();
  } else if (kind !== "rest") {
    ctx.fillStyle = INK;
    fitText(ctx, kind === "jail" ? "Just visiting" : "Go to Customs Hold", 0, noteY, 0.22 * u, 2.3 * u, fonts.text, "800");
  }
}

/** Khu phố giữa bàn: ảnh công viên và hai con đường cắt nhau, mâm xúc xắc đặt trên vòng xuyến ở giữa. Chưa có ảnh thì vẽ bãi cỏ và đường. */
const CENTRE_VEIL = "rgb(240 247 243 / 46%)";

function drawCenter(ctx: CanvasRenderingContext2D, art: BoardArt | null): void {
  const u = K;
  const inner = (HALF - CORNER) * u;
  const mid = BOARD_PX / 2;
  if (art) {
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(art.centre, mid - inner, mid - inner, inner * 2, inner * 2);
    // The middle is scenery: at full strength its parks and roads were the loudest thing on the table and the pieces
    // and the owners' colours were lost against them. A pale veil sets it back, so the ring of squares reads first.
    ctx.fillStyle = CENTRE_VEIL;
    ctx.fillRect(mid - inner, mid - inner, inner * 2, inner * 2);
    return;
  }
  ctx.fillStyle = PAVEMENT;
  ctx.fillRect(mid - inner, mid - inner, inner * 2, inner * 2);
  const margin = 0.35 * u;
  ctx.fillStyle = LAWN;
  ctx.fillRect(mid - inner + margin, mid - inner + margin, inner * 2 - margin * 2, inner * 2 - margin * 2);
  const road = 1.1 * u;
  ctx.fillStyle = ROAD;
  ctx.fillRect(mid - road / 2, mid - inner + margin, road, inner * 2 - margin * 2);
  ctx.fillRect(mid - inner + margin, mid - road / 2, inner * 2 - margin * 2, road);
  ctx.fillStyle = PAVEMENT;
  ctx.beginPath();
  ctx.arc(mid, mid, 1.9 * u, 0, Math.PI * 2);
  ctx.fill();
}

/** `salary`: tiền nhận mỗi lần đi qua Xuất phát của ván này, ghi trên ô Xuất phát. `art`: ảnh minh họa, `null` khi chưa tải xong. */
export function boardTexture(fonts: { text: string; title: string }, anisotropy: number, salary: number, art: BoardArt | null = null): THREE.CanvasTexture {
  const texture = paint(BOARD_PX, BOARD_PX, (ctx) => {
    ctx.fillStyle = LINE;
    ctx.fillRect(0, 0, BOARD_PX, BOARD_PX);
    drawCenter(ctx, art);
    const gap = 0.025 * K;
    for (let index = 0; index < SQUARES.length; index++) {
      const center = tileCenter(index);
      ctx.save();
      ctx.translate((center.x + HALF) * K, (center.z + HALF) * K);
      // Ô thường quay theo chiều đọc của ô (hai cạnh xa quay ngược), ô góc giữ nguyên rồi tự xoay chữ cho ngang màn hình.
      if (index % 10 !== 0) ctx.rotate(-tileYaw(index));
      // Chừa một đường viền mảnh giữa các ô.
      ctx.beginPath();
      const w = (index % 10 === 0 ? CORNER : TILE) * K - gap * 2;
      const h = CORNER * K - gap * 2;
      ctx.rect(-w / 2, -h / 2, w, h);
      ctx.clip();
      if (index % 10 === 0) drawCorner(ctx, index, fonts, salary, art);
      else drawTile(ctx, index, fonts, art);
      ctx.restore();
    }
  });
  texture.anisotropy = anisotropy;
  return texture;
}

/** Mặt tiền nhà cao tầng: lưới cửa kính trên tường sáng, lặp lại theo kích thước từng nhà. Màu tường lấy từ màu đỉnh của khối. */
export function windowTexture(): THREE.CanvasTexture {
  const texture = paint(128, 128, (ctx) => {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = "#9fc4dc";
    for (const x of [14, 74]) for (const y of [14, 74]) ctx.fillRect(x, y, 40, 40);
    ctx.fillStyle = "rgb(255 255 255 / 55%)";
    for (const x of [14, 74]) for (const y of [14, 74]) ctx.fillRect(x + 4, y + 4, 10, 30);
  });
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/** Sáu mặt xúc xắc xếp 3 × 2: mặt số n ở cột (n - 1) % 3, hàng (n - 1) / 3. Mặt 1 và 4 chấm đỏ như xúc xắc bày bán ở chợ. */
export function diceTexture(anisotropy: number): THREE.CanvasTexture {
  const cell = 128;
  const spots: Record<number, number[][]> = {
    1: [[1, 1]],
    2: [[0, 0], [2, 2]],
    3: [[0, 0], [1, 1], [2, 2]],
    4: [[0, 0], [2, 0], [0, 2], [2, 2]],
    5: [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]],
    6: [[0, 0], [2, 0], [0, 1], [2, 1], [0, 2], [2, 2]],
  };
  const texture = paint(cell * 3, cell * 2, (ctx) => {
    ctx.fillStyle = "#fffdf6";
    ctx.fillRect(0, 0, cell * 3, cell * 2);
    for (let value = 1; value <= 6; value++) {
      const left = ((value - 1) % 3) * cell;
      const top = Math.floor((value - 1) / 3) * cell;
      ctx.fillStyle = value === 1 || value === 4 ? "#d32f22" : "#2a1208";
      const radius = value === 1 ? 22 : 14;
      for (const [column, row] of spots[value]) {
        ctx.beginPath();
        ctx.arc(left + 32 + column * 32, top + 32 + row * 32, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  });
  texture.anisotropy = anisotropy;
  return texture;
}

/** Mũi tên vàng chỉ xuống, treo trên đầu người đang tới lượt. Ảnh cao gấp 1,25 lần rộng. */
export function arrowTexture(): THREE.CanvasTexture {
  return paint(64, 80, (ctx) => {
    ctx.beginPath();
    ctx.moveTo(22, 6);
    ctx.lineTo(42, 6);
    ctx.lineTo(42, 38);
    ctx.lineTo(58, 38);
    ctx.lineTo(32, 74);
    ctx.lineTo(6, 38);
    ctx.lineTo(22, 38);
    ctx.closePath();
    ctx.lineJoin = "round";
    ctx.lineWidth = 6;
    ctx.strokeStyle = "#2a1208";
    ctx.stroke();
    ctx.fillStyle = "#f2c14e";
    ctx.fill();
  });
}

/** Số tiền nổi trên đầu người chơi: đỏ khi mất tiền, xanh khi được tiền, viền đậm cho nền nào cũng đọc được. */
export function moneyTexture(amount: number, family: string): { texture: THREE.CanvasTexture; aspect: number } {
  const text = `${amount > 0 ? "+" : "−"}${Math.abs(amount).toLocaleString("en-US")}`;
  const height = 64;
  const font = `900 44px ${family}`;
  const measure = document.createElement("canvas").getContext("2d")!;
  measure.font = font;
  const width = Math.ceil(measure.measureText(text).width) + 28;
  const texture = paint(width, height, (ctx) => {
    ctx.font = font;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = 10;
    ctx.strokeStyle = "#2a1208";
    ctx.strokeText(text, width / 2, height / 2 + 2);
    ctx.fillStyle = amount > 0 ? "#5ee08f" : "#ff5a4a";
    ctx.fillText(text, width / 2, height / 2 + 2);
  });
  return { texture, aspect: width / height };
}
