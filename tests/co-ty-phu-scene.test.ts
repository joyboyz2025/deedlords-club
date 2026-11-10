// Hình học bàn cờ 3D của Cờ tỷ phú: ô nằm đúng chỗ, chạm đúng ô, quân đứng không chồng nhau, đi đúng đường.

import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";
import { HOUSE_SLOT, TIERS, TRAY_TOP, buildingGeometry, cityGeometry } from "../games/co-ty-phu/scene/city.ts";
import { DIE_SIZE, bounceHeight, dieGeometry, restQuaternion, valueUp } from "../games/co-ty-phu/scene/dice.ts";
import {
  BAND,
  CORNER,
  FOV,
  HALF,
  SIDE,
  TILE,
  VIEW_YAW,
  boardEye,
  boardFit,
  inTile,
  isCorner,
  sideOf,
  sideYaw,
  standSpot,
  stepsBetween,
  tileAt,
  tileCenter,
  tileYaw,
  turned,
} from "../games/co-ty-phu/scene/layout.ts";

test("cờ tỷ phú 3D: 40 ô vừa khít quanh bàn, Xuất phát ở góc dưới bên phải", () => {
  assert.equal(SIDE, 2 * CORNER + 9 * TILE);
  const start = tileCenter(0);
  assert.ok(start.x > 0 && start.z > 0, "Xuất phát ở góc dưới bên phải");
  assert.ok(tileCenter(1).x < start.x && tileCenter(1).z === start.z, "đi sang trái dọc hàng dưới");
  assert.ok(tileCenter(11).z < tileCenter(10).z, "rồi đi lên dọc cạnh trái");
  for (let i = 0; i < 40; i++) {
    const { x, z } = tileCenter(i);
    assert.ok(Math.abs(x) <= HALF - CORNER / 2 + 1e-9 && Math.abs(z) <= HALF - CORNER / 2 + 1e-9, `ô ${i} nằm trong bàn`);
    // Hai ô liền nhau cách nhau đúng một bước: ô thường một bề ngang ô, sát ô góc thì cộng thêm nửa phần chênh.
    const next = tileCenter((i + 1) % 40);
    const gap = Math.hypot(next.x - x, next.z - z);
    const expected = isCorner(i) || isCorner(i + 1) ? CORNER / 2 + TILE / 2 : TILE;
    assert.ok(Math.abs(gap - expected) < 1e-9, `ô ${i} và ô kế cách ${gap}`);
  }
});

test("cờ tỷ phú 3D: chạm vào đâu trong ô cũng ra đúng ô đó, chạm vào khu phố hay ra ngoài bàn thì không ra ô nào", () => {
  for (let i = 0; i < 40; i++) {
    const { x, z } = tileCenter(i);
    assert.equal(tileAt(x, z), i);
    // Gần mép ô (trừ một chút) vẫn là ô đó.
    const half = (isCorner(i) ? CORNER : TILE) / 2 - 0.05;
    for (const [dx, dz] of [[half, 0], [-half, 0], [0, half], [0, -half]]) {
      const side = sideOf(i);
      // Đổi lệch dọc cạnh thành lệch trên trục x hay z tùy cạnh; bề sâu của mọi ô là CORNER.
      const along = side % 2 === 0 ? { x: dx, z: dz * (CORNER / 2 - 0.05) / half } : { x: dz * (CORNER / 2 - 0.05) / half, z: dx };
      assert.equal(tileAt(x + along.x, z + along.z), i, `điểm sát mép trong ô ${i}`);
    }
  }
  assert.equal(tileAt(0, 0), null, "giữa bàn là khu phố");
  assert.equal(tileAt(HALF + 1, 0), null, "ngoài bàn");
});

test("cờ tỷ phú 3D: sáu quân cùng một ô đứng tách nhau, đứng trên ô, không đè lên dải màu chỗ mọc nhà", () => {
  for (const i of [0, 5, 10, 13, 20, 27, 30, 39]) {
    for (const jailed of i === 10 ? [false, true] : [false]) {
      const spots = Array.from({ length: 6 }, (_, slot) => standSpot(i, slot, jailed));
      for (const spot of spots) assert.equal(tileAt(spot.x, spot.z), i, `quân đứng trong ô ${i}`);
      for (let a = 0; a < 6; a++) {
        for (let b = a + 1; b < 6; b++) assert.ok(Math.hypot(spots[a].x - spots[b].x, spots[a].z - spots[b].z) > 0.33, `hai quân trong ô ${i} quá sát nhau`);
      }
      if (!isCorner(i)) {
        // Dải màu ở mép trong, riêng hai cạnh xa camera thì ở mép ngoài: quân không đứng lên dải màu.
        const edge = (spot: { x: number; z: number }) => HALF - Math.max(Math.abs(spot.x), Math.abs(spot.z));
        for (const spot of spots) {
          if (turned(i)) assert.ok(edge(spot) > BAND, `quân ở ô ${i} đứng lên dải màu`);
          else assert.ok(edge(spot) < CORNER - BAND, `quân ở ô ${i} đứng lên dải màu`);
        }
      }
    }
  }
});

test("cờ tỷ phú 3D: quân đi xuôi qua từng ô, lùi vài ô thì đi lùi, bị bắt thì đi xuôi tới tạm giữ", () => {
  assert.deepEqual(stepsBetween(0, 7), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(stepsBetween(36, 3), [37, 38, 39, 0, 1, 2, 3], "qua Xuất phát");
  assert.deepEqual(stepsBetween(7, 4), [6, 5, 4], "thẻ quay lại 3 ô");
  assert.deepEqual(stepsBetween(30, 10).length, 20, "từ Bị bắt đi xuôi về Tạm giữ");
  assert.deepEqual(stepsBetween(5, 5), []);
});

test("cờ tỷ phú 3D: camera mỗi cạnh nhìn từ ngoài bàn vào, bốn cạnh cách nhau một góc vuông", () => {
  assert.ok(Math.abs(sideYaw(0)) < 1e-9, "hàng dưới nhìn thẳng từ mép dưới");
  for (let side = 1; side < 4; side++) assert.ok(Math.abs(Math.abs(sideYaw(side) - sideYaw(side - 1)) - Math.PI / 2) < 1e-9);
});

test("cờ tỷ phú 3D: nhìn chéo từ góc Xuất phát thì chữ ô nào cũng xuôi, nhà đứng sau chữ", () => {
  const camera = { x: Math.sin(VIEW_YAW), z: Math.cos(VIEW_YAW) };
  const toward = (p: { x: number; z: number }) => p.x * camera.x + p.z * camera.z;
  for (let i = 0; i < 40; i++) {
    if (isCorner(i)) continue;
    // Chiều đọc của ô hướng về phía camera: chữ không bị ngược, cùng lắm nghiêng nửa góc vuông.
    const facing = Math.cos(tileYaw(i) - VIEW_YAW);
    assert.ok(facing > 0.7, `chữ ô ${i} bị ngược`);
    // Dải màu, chỗ mọc nhà, xa camera hơn giá đất ở mép trước.
    assert.ok(toward(inTile(i, 0, CORNER / 2 - BAND / 2)) < toward(inTile(i, 0, -CORNER / 2 + 0.5)), `nhà ở ô ${i} che chữ`);
  }
  // Hai cạnh gần camera giữ như bàn cờ giấy, hai cạnh xa quay ngược.
  assert.deepEqual([5, 15, 25, 35].map(turned), [false, true, true, false]);
});

test("cờ tỷ phú 3D: nhìn cả bàn thì bàn vừa khung và nằm giữa, cầm dọc hay cầm ngang", () => {
  for (const aspect of [0.55, 0.85, 1.3, 1.6, 2.2]) {
    const { shift } = boardFit(aspect);
    const eye = boardEye(aspect);
    const camera = new THREE.PerspectiveCamera(FOV, aspect, 0.1, 300);
    camera.position.set(eye.x, eye.y, eye.z);
    camera.lookAt(shift * Math.SQRT1_2, 0, shift * Math.SQRT1_2);
    camera.updateMatrixWorld();
    const corners = [
      [HALF, 0, HALF],
      [-HALF, 0, HALF],
      [HALF, 0, -HALF],
      [-HALF, 0, -HALF],
    ].map(([x, y, z]) => new THREE.Vector3(x, y, z).project(camera));
    for (const corner of corners) assert.ok(Math.abs(corner.x) <= 0.98 && Math.abs(corner.y) <= 0.98, `góc bàn ra ngoài khung ${aspect}`);
    // Xuất phát ở đỉnh dưới, góc xa ở đỉnh trên, hai góc kia hai bên.
    const [start, left, right, far] = corners;
    assert.ok(Math.abs(start.x) < 1e-6 && Math.abs(far.x) < 1e-6 && start.y < 0 && far.y > 0, `Xuất phát không ở đỉnh dưới ${aspect}`);
    assert.ok(left.x < -0.5 && right.x > 0.5, `bàn không thành hình thoi ${aspect}`);
    // Vừa khít một chiều: bề ngang khi cầm dọc, bề cao khi cầm ngang.
    const fill = Math.max(right.x, (far.y - start.y) / 2);
    assert.ok(fill > 0.85, `bàn nhỏ quá ${aspect}`);
    assert.ok(Math.abs(far.y + start.y) < 0.12, `bàn lệch khỏi giữa khung ${aspect}`);
  }
  // Chừa chỗ cho thẻ người chơi và các nút thì bàn lùi xa hơn: trên dưới khi cầm ngang, hai bên khi cầm dọc.
  assert.ok(boardFit(1.6, 1, 0.7).distance > boardFit(1.6).distance);
  assert.ok(boardFit(0.6, 0.7).distance > boardFit(0.6).distance);
});

test("cờ tỷ phú 3D: nhìn cả bàn thì nhà giữa bàn không che ô ở hai cạnh xa, không che mặt xúc xắc", () => {
  // Màn hình càng rộng camera càng gần bàn, nhìn càng xiên: thử ở khổ rất rộng là khó nhất.
  const eye = boardEye(3);
  const inner = HALF - CORNER;
  const diceTop = TRAY_TOP + DIE_SIZE;
  const { towers, plain } = cityGeometry();
  for (const geometry of [towers, plain]) {
    const position = geometry.getAttribute("position");
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const y = position.getY(i);
      const z = position.getZ(i);
      // Dãy nhà xa ngoài bàn chỉ làm nền, đứng sau bàn.
      if (y <= 0.05 || Math.max(Math.abs(x), Math.abs(z)) > HALF) continue;
      // Tia nhìn từ camera đi qua đỉnh này rồi chạm mặt bàn (hay chạm mặt trên xúc xắc) ở đâu: chỗ đó bị đỉnh này che.
      const hit = (level: number) => {
        const t = (eye.y - level) / (eye.y - y);
        return { x: eye.x + (x - eye.x) * t, z: eye.z + (z - eye.z) * t };
      };
      const ground = hit(0);
      const far = Math.max(Math.abs(ground.x), Math.abs(ground.z)) <= HALF && (ground.x < -inner || ground.z < -inner);
      assert.ok(!far, `đỉnh (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}) che ô ở cạnh xa`);
      if (y > diceTop) {
        const top = hit(diceTop);
        assert.ok(Math.hypot(top.x, top.z) > 1.5, `đỉnh (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}) che xúc xắc`);
      }
    }
  }
});

test("cờ tỷ phú 3D: khu phố, nhà và khách sạn dựng được và đủ nhẹ cho điện thoại", () => {
  const { towers, plain } = cityGeometry();
  // Nhà cao tầng giữ tọa độ ảnh để dán cửa sổ, phần trơn chỉ có màu.
  assert.ok(towers.getAttribute("uv") && towers.getAttribute("color"));
  assert.ok(plain.getAttribute("color"));
  const vertices = towers.getAttribute("position").count + plain.getAttribute("position").count;
  assert.ok(vertices < 30_000, `khu phố có ${vertices} đỉnh`);
  // Nhà nằm gọn trong dải màu: bốn nhà xếp hàng không chạm nhau, khách sạn không lấn sang ô bên. Đất càng đắt nhà càng cao.
  for (const hotel of [false, true]) {
    let lower = 0;
    for (let tier = 0; tier < TIERS; tier++) {
      const geometry = buildingGeometry(tier, hotel);
      geometry.computeBoundingBox();
      const box = geometry.boundingBox!;
      const name = `${hotel ? "khách sạn" : "nhà"} hạng ${tier + 1}`;
      assert.ok(box.max.x - box.min.x <= (hotel ? TILE * 0.92 : HOUSE_SLOT - 0.02) + 1e-9, `${name} quá rộng`);
      assert.ok(box.max.z - box.min.z < BAND, `${name} quá sâu`);
      assert.ok(box.min.y >= -1e-6, `${name} lún dưới mặt bàn`);
      assert.ok(box.max.y > lower, `${name} không cao hơn hạng dưới`);
      assert.ok(geometry.getAttribute("position").count < 3000, `${name} quá nặng`);
      lower = box.max.y;
    }
  }
});

test("cờ tỷ phú 3D: xúc xắc nằm yên đúng số đã đổ, nảy rồi nằm trên mâm", () => {
  for (let value = 1; value <= 6; value++) {
    for (const yaw of [0, 1.3, -2.2]) assert.equal(valueUp(restQuaternion(value, yaw)), value, `mặt ${value} ngửa lên`);
  }
  // Ba lần chạm mâm, sau cùng nằm yên.
  for (const t of [0.5, 0.72, 0.86, 0.95, 1]) assert.ok(Math.abs(bounceHeight(t)) < 1e-9, `chạm mâm lúc ${t}`);
  assert.ok(bounceHeight(0) > 2 && bounceHeight(0.61) > 0.3 && bounceHeight(0.79) > 0.1, "rơi từ trên cao, nảy thấp dần");
  // Mỗi mặt dán đúng ô của số mình trong ảnh sáu mặt: mặt trên (+y) là số 1, ô trên cùng bên trái.
  const geometry = dieGeometry();
  const uv = geometry.getAttribute("uv");
  const perFace = uv.count / 6;
  for (let i = 2 * perFace; i < 3 * perFace; i++) {
    assert.ok(uv.getX(i) >= -1e-6 && uv.getX(i) <= 1 / 3 + 1e-6 && uv.getY(i) >= 0.5 - 1e-6, "mặt số 1 lấy ô đầu tiên");
  }
});
