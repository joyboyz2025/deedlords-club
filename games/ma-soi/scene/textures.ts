// Mọi hình trong đình đều vẽ bằng canvas lúc chạy: không phải tải file nào, nhẹ cho điện thoại.

import * as THREE from "three";

export function paint(width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext("2d")!);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function repeating(texture: THREE.Texture, x: number, y: number): THREE.Texture {
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(x, y);
  texture.anisotropy = 4;
  return texture;
}

/** Sàn đình lát ván, mỗi tấm một sắc gỗ. */
export function floorTexture(): THREE.Texture {
  const size = 512;
  const rows = 8;
  const rowHeight = size / rows;
  const texture = paint(size, size, (ctx) => {
    ctx.fillStyle = "#6e4324";
    ctx.fillRect(0, 0, size, size);
    for (let row = 0; row < rows; row++) {
      const y = row * rowHeight;
      let x = -Math.random() * 180;
      while (x < size) {
        const width = 150 + Math.random() * 160;
        const light = 50 + Math.random() * 9;
        ctx.fillStyle = `hsl(${27 + Math.random() * 6} 52% ${light}%)`;
        ctx.fillRect(x + 1, y + 1, width - 2, rowHeight - 3);
        ctx.strokeStyle = "rgb(70 36 12 / 16%)";
        ctx.lineWidth = 1;
        for (let grain = 0; grain < 5; grain++) {
          const gy = y + 5 + Math.random() * (rowHeight - 12);
          ctx.beginPath();
          ctx.moveTo(x + 3, gy);
          ctx.bezierCurveTo(x + width * 0.3, gy + 3, x + width * 0.6, gy - 3, x + width - 3, gy + 1);
          ctx.stroke();
        }
        x += width;
      }
    }
  });
  return repeating(texture, 14, 14);
}

/** Mặt trống đồng: ngôi sao giữa, các vành hoa văn tỏa ra. */
export function drumTexture(): THREE.Texture {
  const size = 512;
  const c = size / 2;
  return paint(size, size, (ctx) => {
    ctx.fillStyle = "#c79a45";
    ctx.fillRect(0, 0, size, size);
    const dark = "#5e3f18";
    const light = "#f0cf7c";
    ctx.save();
    ctx.translate(c, c);

    const ring = (radius: number, width: number, color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.stroke();
    };

    // Ngôi sao mười bốn cánh, nét riêng của trống đồng.
    const points = 14;
    ctx.fillStyle = light;
    ctx.beginPath();
    for (let i = 0; i < points * 2; i++) {
      const angle = (i / (points * 2)) * Math.PI * 2;
      const radius = i % 2 === 0 ? 92 : 30;
      ctx.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
    }
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = dark;
    ctx.lineWidth = 3;
    ctx.stroke();

    ring(108, 4, dark);
    for (let i = 0; i < 40; i++) {
      ctx.save();
      ctx.rotate((i / 40) * Math.PI * 2);
      ctx.fillStyle = i % 2 === 0 ? dark : light;
      ctx.fillRect(114, -3, 16, 6);
      ctx.restore();
    }
    ring(136, 4, dark);
    for (let i = 0; i < 18; i++) {
      ctx.save();
      ctx.rotate((i / 18) * Math.PI * 2);
      ctx.fillStyle = dark;
      ctx.beginPath();
      ctx.moveTo(146, 0);
      ctx.quadraticCurveTo(164, -13, 182, -4);
      ctx.lineTo(196, -9);
      ctx.lineTo(186, 3);
      ctx.quadraticCurveTo(162, 13, 146, 0);
      ctx.fill();
      ctx.restore();
    }
    ring(204, 4, dark);
    for (let i = 0; i < 60; i++) {
      ctx.save();
      ctx.rotate((i / 60) * Math.PI * 2);
      ctx.fillStyle = light;
      ctx.beginPath();
      ctx.arc(216, 0, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ring(230, 5, dark);
    ctx.restore();
  });
}

/** Vách đình: chân vách sơn son, phía trên là ô lưới con tiện, mép trên thếp vàng. */
export function wallTexture(): THREE.Texture {
  const width = 256;
  const height = 512;
  const texture = paint(width, height, (ctx) => {
    ctx.fillStyle = "#3b2214";
    ctx.fillRect(0, 0, width, height);

    const top = 58;
    const panel = 360;
    ctx.fillStyle = "#26130b";
    ctx.fillRect(16, top, width - 32, panel - top - 12);
    ctx.strokeStyle = "#8a5a30";
    ctx.lineWidth = 5;
    const cell = (width - 32) / 5;
    for (let x = 16; x <= width - 16; x += cell) {
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, panel - 12);
      ctx.stroke();
    }
    for (let y = top; y <= panel - 12; y += cell) {
      ctx.beginPath();
      ctx.moveTo(16, y);
      ctx.lineTo(width - 16, y);
      ctx.stroke();
    }

    ctx.fillStyle = "#8e2a1a";
    ctx.fillRect(16, panel + 8, width - 32, height - panel - 28);
    ctx.strokeStyle = "#d8a944";
    ctx.lineWidth = 4;
    ctx.strokeRect(32, panel + 24, width - 64, height - panel - 60);

    ctx.fillStyle = "#d8a944";
    ctx.fillRect(0, 0, width, 12);
    ctx.fillRect(0, 44, width, 6);
    ctx.fillStyle = "#8e2a1a";
    ctx.fillRect(0, 14, width, 28);
    ctx.fillStyle = "#d8a944";
    for (let x = 12; x < width; x += 32) {
      ctx.beginPath();
      ctx.arc(x, 28, 7, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  return repeating(texture, 16, 1);
}

/** Chiếu cói đỏ viền xanh. */
export function matTexture(): THREE.Texture {
  const width = 128;
  const height = 200;
  const texture = paint(width, height, (ctx) => {
    ctx.fillStyle = "#d9b877";
    ctx.fillRect(0, 0, width, height);
    for (let y = 0; y < height; y += 3) {
      ctx.fillStyle = y % 2 === 0 ? "rgb(255 240 200 / 22%)" : "rgb(120 80 30 / 18%)";
      ctx.fillRect(0, y, width, 1);
    }
    ctx.fillStyle = "#b53a24";
    ctx.fillRect(14, 14, width - 28, 10);
    ctx.fillRect(14, height - 24, width - 28, 10);
    ctx.fillStyle = "#3f7a4d";
    ctx.fillRect(14, 30, width - 28, 5);
    ctx.fillRect(14, height - 35, width - 28, 5);
  });
  texture.anisotropy = 4;
  return texture;
}

/** Lũy tre ngoài đình. Vẽ màu trắng để nhuộm theo ngày đêm. */
export function bambooTexture(): THREE.Texture {
  const width = 2048;
  const height = 512;
  const texture = paint(width, height, (ctx) => {
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#fff";
    for (let i = 0; i < 46; i++) {
      const x = (i / 46) * width + Math.random() * 24;
      const lean = (Math.random() - 0.5) * 70;
      const top = 30 + Math.random() * 200;
      ctx.lineWidth = 5 + Math.random() * 6;
      ctx.beginPath();
      ctx.moveTo(x, height);
      ctx.quadraticCurveTo(x, height * 0.5, x + lean, top);
      ctx.stroke();
      for (let leaf = 0; leaf < 16; leaf++) {
        const t = 0.35 + (leaf / 16) * 0.65;
        const lx = x + lean * t * t;
        const ly = height + (top - height) * t;
        const dir = leaf % 2 === 0 ? 1 : -1;
        const length = 26 + Math.random() * 38;
        ctx.beginPath();
        ctx.moveTo(lx, ly);
        ctx.quadraticCurveTo(lx + dir * length * 0.5, ly - 14, lx + dir * length, ly + 8);
        ctx.quadraticCurveTo(lx + dir * length * 0.5, ly + 4, lx, ly);
        ctx.fill();
      }
    }
    ctx.fillRect(0, height - 90, width, 90);
  });
  return repeating(texture, 2, 1);
}

/** Quầng sáng quanh đèn lồng và đống lửa. */
export function glowTexture(): THREE.Texture {
  return paint(128, 128, (ctx) => {
    const gradient = ctx.createRadialGradient(64, 64, 2, 64, 64, 64);
    gradient.addColorStop(0, "rgb(255 255 255 / 100%)");
    gradient.addColorStop(0.3, "rgb(255 255 255 / 42%)");
    gradient.addColorStop(1, "rgb(255 255 255 / 0%)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 128, 128);
  });
}

function fontFamily(variable: string, fallback: string): string {
  const family = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  return family || fallback;
}

/** Bảng hoành phi sơn son thếp vàng treo trên vách. */
export function boardTexture(text: string, family: string): THREE.Texture {
  const width = 512;
  const height = 128;
  return paint(width, height, (ctx) => {
    ctx.fillStyle = "#8e2a1a";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "#d8a944";
    ctx.lineWidth = 10;
    ctx.strokeRect(8, 8, width - 16, height - 16);
    ctx.lineWidth = 3;
    ctx.strokeRect(22, 22, width - 44, height - 44);
    ctx.fillStyle = "#f0cf7c";
    ctx.font = `62px ${family || "serif"}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, width / 2, height / 2 + 4);
  });
}

export type LabelTexture = { texture: THREE.CanvasTexture; aspect: number };

/** Bảng tên trên đầu mỗi người. Tên có dấu tiếng Việt nên dùng đúng font của trang. */
export function labelTexture(name: string, title: string | null, self: boolean, family: string, rim: string | null = null): LabelTexture {
  const scale = 44;
  const measure = document.createElement("canvas").getContext("2d")!;
  const nameFont = `800 ${scale}px ${family}`;
  const titleFont = `700 ${scale * 0.72}px ${family}`;
  measure.font = nameFont;
  const nameWidth = measure.measureText(name).width;
  measure.font = titleFont;
  const titleWidth = title ? measure.measureText(title).width : 0;
  const width = Math.ceil(Math.max(nameWidth, titleWidth) + scale * 0.9);
  const height = Math.ceil(title ? scale * 2.1 : scale * 1.32);

  const texture = paint(width, height, (ctx) => {
    ctx.fillStyle = self ? "rgb(237 185 46 / 96%)" : "rgb(27 23 18 / 66%)";
    ctx.beginPath();
    ctx.roundRect(0, 0, width, height, scale * 0.42);
    ctx.fill();
    if (rim) {
      const line = scale * 0.13;
      // Bảng tên của mình nền vàng: thêm một vạch mực bên trong để viền vàng của đồ Quý vẫn nổi.
      if (self) {
        ctx.strokeStyle = "#1b1712";
        ctx.lineWidth = line * 1.8;
        ctx.beginPath();
        ctx.roundRect(line, line, width - line * 2, height - line * 2, scale * 0.42 - line);
        ctx.stroke();
      }
      ctx.strokeStyle = rim;
      ctx.lineWidth = line;
      ctx.beginPath();
      ctx.roundRect(line / 2, line / 2, width - line, height - line, scale * 0.42 - line / 2);
      ctx.stroke();
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = nameFont;
    ctx.fillStyle = self ? "#1b1712" : "#fff";
    ctx.fillText(name, width / 2, title ? scale * 0.72 : height / 2 + 2);
    if (title) {
      ctx.font = titleFont;
      ctx.fillStyle = self ? "#1b1712" : "#f6d56b";
      ctx.fillText(title, width / 2, scale * 1.54);
    }
  });
  return { texture, aspect: width / height };
}

/** Dấu tròn trên đầu: số phiếu hoặc dấu hỏi. */
export function badgeTexture(text: string): THREE.Texture {
  const size = 96;
  return paint(size, size, (ctx) => {
    ctx.fillStyle = "#c8321e";
    ctx.beginPath();
    ctx.arc(48, 48, 42, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#1b1712";
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = `800 54px ${fontFamily("--font-alegreya", "sans-serif")}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 48, 52);
  });
}

export function sleepTexture(): THREE.Texture {
  return paint(128, 128, (ctx) => {
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "800 58px sans-serif";
    ctx.fillText("z", 40, 84);
    ctx.font = "800 40px sans-serif";
    ctx.fillText("z", 74, 52);
    ctx.font = "800 26px sans-serif";
    ctx.fillText("z", 100, 28);
  });
}
