// Mặt bàn cờ vẽ một lần lên một tấm ảnh: 40 ô, dải màu, tên đất, giá, biểu tượng, và khu phố giữa bàn.
// Cả bàn chỉ là một mặt phẳng dán ảnh này, nên điện thoại chỉ tốn một lần vẽ cho cả bàn.

import * as THREE from "three";
import { paint } from "../../ma-soi/scene/textures";
import { GROUPS, SQUARES } from "../board";
import { BAND, CORNER, HALF, SIDE, TILE, VIEW_YAW, tileCenter, tileYaw } from "./layout";

/** Cạnh tấm ảnh mặt bàn, đủ nét để đọc tên ô khi camera theo sát quân. */
export const BOARD_PX = 2048;
const K = BOARD_PX / SIDE;
/** Xoay chừng này thì chữ nằm ngang trên màn hình, vì camera nhìn chéo từ góc Xuất phát. */
const LEVEL = -VIEW_YAW;

const PAPER = "#fbf3df";
const INK = "#2a1208";
const LINE = "#5b3a24";
const LAWN = "#9fcf7c";
const ROAD = "#7d7f86";
const PAVEMENT = "#e6dcc6";

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
function drawTile(ctx: CanvasRenderingContext2D, index: number, fonts: { text: string; title: string }): void {
  const square = SQUARES[index];
  const u = K;
  const w = TILE * u;
  const h = CORNER * u;
  ctx.fillStyle = square.kind === "card" ? (square.deck === "chest" ? "#fbe2dc" : "#fff0d6") : PAPER;
  ctx.fillRect(-w / 2, -h / 2, w, h);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  let nameY = -0.3;
  if (square.kind === "city") {
    ctx.fillStyle = GROUPS[square.group].color;
    ctx.fillRect(-w / 2, -h / 2, w, BAND * u);
  } else if (square.kind === "station" || square.kind === "utility" || square.kind === "tax" || square.kind === "card") {
    const icon = square.kind === "utility" ? (square.name === "Điện lực" ? "power" : "water") : square.kind === "card" ? square.deck : square.kind;
    // Ô có giá thì hình nhỏ lại, chừa chỗ cho giá.
    const card = square.kind === "card";
    ctx.save();
    ctx.translate(0, (card ? 0.25 : 0.02) * u);
    if (!card) ctx.scale(0.75, 0.75);
    drawIcon(ctx, icon, 0);
    ctx.restore();
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

/** Chữ có viền nền sáng, để đọc được trên song sắt. */
function plateText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, maxWidth: number, family: string): void {
  ctx.font = `400 ${size}px ${family}`;
  const width = Math.min(maxWidth, ctx.measureText(text).width) + size * 0.6;
  ctx.fillStyle = PAPER;
  ctx.beginPath();
  ctx.roundRect(x - width / 2, y - size * 0.72, width, size * 1.44, size * 0.3);
  ctx.fill();
  ctx.fillStyle = INK;
  fitText(ctx, text, x, y, size, maxWidth, family, "400");
}

/**
 * Ô góc: nền vuông theo bàn, chữ và hình vẽ nằm ngang trên màn hình. Nhìn trên màn hình mỗi ô góc là một hình thoi,
 * tâm ở gốc tọa độ, đỉnh cách tâm chừng 1,84 đơn vị theo bốn hướng, nên chữ dài đặt gần giữa.
 */
function drawCorner(ctx: CanvasRenderingContext2D, index: number, fonts: { text: string; title: string }, salary: number): void {
  const u = K;
  const h = CORNER * u;
  const kind = SQUARES[index].kind;
  ctx.fillStyle = kind === "start" ? "#ffe08a" : kind === "rest" ? "#cdeccf" : kind === "arrest" ? "#f6c7bd" : PAPER;
  ctx.fillRect(-h / 2, -h / 2, h, h);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  if (kind === "jail") {
    // Phòng tạm giữ ở góc phía trong bàn, đúng chỗ người bị giữ đứng (`standSpot`); song sắt dựng đứng trên màn hình.
    ctx.save();
    ctx.beginPath();
    ctx.rect(-0.1 * u, -1.3 * u, 1.4 * u, 1.4 * u);
    ctx.fillStyle = "#f2a33a";
    ctx.fill();
    ctx.clip();
    ctx.rotate(LEVEL);
    ctx.fillStyle = "#4b3a2e";
    for (let i = -4; i <= 4; i++) ctx.fillRect((0.85 + i * 0.24 - 0.03) * u, -1.1 * u, 0.06 * u, 2.2 * u);
    ctx.restore();
  }

  // Từ đây trục x sang phải màn hình, trục y xuống dưới màn hình. Ai đứng ở ô góc thì đứng ở một phần tư (xem `standSpot`),
  // nên chữ và hình tránh phần đó.
  ctx.rotate(LEVEL);
  ctx.fillStyle = INK;
  if (kind === "start") {
    fitText(ctx, "XUẤT", 0, -0.75 * u, 0.52 * u, 1.6 * u, fonts.title, "400");
    fitText(ctx, "PHÁT", 0, -0.2 * u, 0.52 * u, 2.4 * u, fonts.title, "400");
    // Tiền qua Xuất phát của ván này.
    ctx.fillStyle = "#c0392b";
    fitText(ctx, `+${salary.toLocaleString("vi-VN")}`, 0, 0.38 * u, 0.46 * u, 2.2 * u, fonts.text, "900");
    // Mũi tên chỉ hướng đi: sang trái, về phía Tạm giữ.
    ctx.fillStyle = "#d32f22";
    ctx.beginPath();
    for (const [x, y] of [[-0.7, 0.92], [-0.3, 0.72], [-0.3, 0.84], [0.6, 0.84], [0.6, 1.0], [-0.3, 1.0], [-0.3, 1.12]]) ctx.lineTo(x * u, y * u);
    ctx.closePath();
    ctx.fill();
  } else if (kind === "jail") {
    plateText(ctx, "TẠM GIỮ", 0.85 * u, 0, 0.34 * u, 1.4 * u, fonts.title);
    // Người ghé thăm đứng ở nửa trên bên trái; chữ ở nửa dưới cho khỏi bị che.
    fitText(ctx, "GHÉ", -0.45 * u, 0.42 * u, 0.32 * u, 1.2 * u, fonts.title, "400");
    fitText(ctx, "THĂM", -0.45 * u, 0.8 * u, 0.32 * u, 1.2 * u, fonts.title, "400");
  } else if (kind === "rest") {
    fitText(ctx, "NGHỈ CHÂN", 0, 0.4 * u, 0.48 * u, 2.5 * u, fonts.title, "400");
    // Ly cà phê sữa đá, bên trái: người dừng chân đứng ở nửa trên bên phải.
    ctx.save();
    ctx.translate(-0.85 * u, -0.3 * u);
    ctx.scale(0.55, 0.55);
    ctx.fillStyle = "#8a5a35";
    ctx.beginPath();
    ctx.moveTo(-0.32 * u, -0.3 * u);
    ctx.lineTo(0.32 * u, -0.3 * u);
    ctx.lineTo(0.24 * u, 0.6 * u);
    ctx.lineTo(-0.24 * u, 0.6 * u);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#f3e6cf";
    ctx.fillRect(-0.32 * u, -0.3 * u, 0.64 * u, 0.2 * u);
    ctx.fillStyle = "#2f9a5c";
    ctx.fillRect(0.06 * u, -0.75 * u, 0.06 * u, 0.5 * u);
    ctx.restore();
  } else if (kind === "arrest") {
    fitText(ctx, "BỊ BẮT", 0, -0.5 * u, 0.56 * u, 2.0 * u, fonts.title, "400");
    ctx.fillStyle = "#6b4a33";
    fitText(ctx, "Vào thẳng tạm giữ", 0, 0.05 * u, 0.24 * u, 3.0 * u, fonts.text, "800");
    // Biển cấm đi: tròn đỏ, vạch trắng. Ai bị bắt đứng ở nửa dưới bên phải nên biển ở bên trái.
    ctx.fillStyle = "#c8352a";
    ctx.beginPath();
    ctx.arc(-0.5 * u, 0.58 * u, 0.38 * u, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.fillRect(-0.76 * u, 0.5 * u, 0.52 * u, 0.15 * u);
  }
}

/** Khu phố giữa bàn: bãi cỏ, hai con đường cắt nhau, quảng trường tròn ở giữa. Nhà cao tầng dựng bằng khối 3D đặt lên trên. */
function drawCenter(ctx: CanvasRenderingContext2D): void {
  const u = K;
  const inner = (HALF - CORNER) * u;
  const mid = BOARD_PX / 2;
  ctx.fillStyle = PAVEMENT;
  ctx.fillRect(mid - inner, mid - inner, inner * 2, inner * 2);
  const margin = 0.35 * u;
  ctx.fillStyle = LAWN;
  ctx.fillRect(mid - inner + margin, mid - inner + margin, inner * 2 - margin * 2, inner * 2 - margin * 2);
  const road = 1.1 * u;
  ctx.fillStyle = ROAD;
  ctx.fillRect(mid - road / 2, mid - inner + margin, road, inner * 2 - margin * 2);
  ctx.fillRect(mid - inner + margin, mid - road / 2, inner * 2 - margin * 2, road);
  // Vạch giữa đường.
  ctx.strokeStyle = "#f4f1e6";
  ctx.lineWidth = 0.06 * u;
  ctx.setLineDash([0.3 * u, 0.3 * u]);
  ctx.beginPath();
  ctx.moveTo(mid, mid - inner + margin);
  ctx.lineTo(mid, mid + inner - margin);
  ctx.moveTo(mid - inner + margin, mid);
  ctx.lineTo(mid + inner - margin, mid);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = PAVEMENT;
  ctx.beginPath();
  ctx.arc(mid, mid, 1.9 * u, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#7cbf5a";
  ctx.beginPath();
  ctx.arc(mid, mid, 1.3 * u, 0, Math.PI * 2);
  ctx.fill();
}

/** `salary`: tiền nhận mỗi lần đi qua Xuất phát của ván này, ghi trên ô Xuất phát. */
export function boardTexture(fonts: { text: string; title: string }, anisotropy: number, salary: number): THREE.CanvasTexture {
  const texture = paint(BOARD_PX, BOARD_PX, (ctx) => {
    ctx.fillStyle = LINE;
    ctx.fillRect(0, 0, BOARD_PX, BOARD_PX);
    drawCenter(ctx);
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
      if (index % 10 === 0) drawCorner(ctx, index, fonts, salary);
      else drawTile(ctx, index, fonts);
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
  const text = `${amount > 0 ? "+" : "−"}${Math.abs(amount).toLocaleString("vi-VN")}`;
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
