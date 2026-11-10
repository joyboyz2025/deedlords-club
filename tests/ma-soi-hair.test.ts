// Tóc dựng bằng lọn (games/ma-soi/scene/hair.ts): kiểu nào cũng dựng được, nằm trong ngân sách, đội mũ không chọc qua mũ.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { BufferGeometry } from "three";
import { LOOK_CHOICES, rarityOf, type Look } from "../games/ma-soi/look.ts";
import { BoxGeometry, Vector3 } from "three";
import { DYES, HAIR_VOLUME, OPEN_HATS, fitHat, hairParts } from "../games/ma-soi/scene/hair.ts";
import { HATS_OVER_HAIR, hatCeilingOf, headGeometry } from "../games/ma-soi/scene/parts.ts";

const PLAIN: Look = { body: 0, skin: 1, hair: 2, hairColor: 0, outfit: 0, robe: 3, neck: 0, hat: 0, face: 0, held: 0, shoes: 0, pet: 0, ride: 0 };
/** Số kiểu tóc hair.ts dựng được: thêm kiểu tóc mới thì tăng số này, thêm một số vào HAIR_VOLUME. */
const STYLES = 26;
const BALD = 6;
const UP = new Vector3(0, 1, 0);
const lowest = (parts: BufferGeometry[]) => {
  let y = Infinity;
  for (const part of parts) {
    const position = part.attributes.position;
    for (let i = 0; i < position.count; i++) y = Math.min(y, position.getY(i));
  }
  return y;
};
const tris = (parts: BufferGeometry[]) => parts.reduce((sum, g) => sum + (g.index ? g.index.count : g.attributes.position.count) / 3, 0);
const top = (look: Look) => {
  const geometry = headGeometry(look);
  geometry.computeBoundingBox();
  return geometry.boundingBox!.max.y;
};

test("tóc: 26 kiểu dựng được với mọi màu, không có số hỏng, nằm trong ngân sách bản nhẹ", () => {
  for (let style = 0; style < STYLES; style++) {
    for (let color = 0; color < LOOK_CHOICES.hairColor.length; color++) {
      const parts = hairParts(style, color, null);
      for (const part of parts) {
        for (const value of [...part.attributes.position.array, ...part.attributes.color.array]) assert.ok(Number.isFinite(value), `kiểu ${style}: số hỏng`);
        assert.ok(part.index, `kiểu ${style}: phải có index để gộp được`);
      }
    }
    // Kiểu 20–25 là Hiếm theo thiết kế; dùng số thay cho rarityOf để test chạy được cả khi danh mục chưa có tên.
    const budget = style >= 20 ? 5000 : 3500;
    assert.ok(tris(hairParts(style, 0, null)) <= budget, `kiểu ${style}: ${tris(hairParts(style, 0, null))} tam giác`);
  }
  assert.deepEqual(hairParts(BALD, 0, null), [], "đầu trọc không có tóc");
});

test("tóc: mỗi màu tóc có một màu nhuộm, mỗi kiểu có một độ phồng", () => {
  assert.equal(DYES.length, LOOK_CHOICES.hairColor.length);
  assert.equal(HAIR_VOLUME.length, STYLES);
  for (const style of [20, 21, 22, 23, 24, 25]) assert.ok(style < LOOK_CHOICES.hair.length ? rarityOf("hair", style) === 1 : true, `kiểu ${style} là Hiếm`);
});

test("mũ nào cũng ở đúng một nhóm: che đỉnh (ép tóc dưới mũ) hoặc đặt trên tóc", () => {
  // Quên xếp nhóm cho mũ mới thì tóc chọc qua mũ.
  for (let hat = 1; hat < LOOK_CHOICES.hat.length; hat++) {
    assert.ok(HATS_OVER_HAIR.has(hat) !== OPEN_HATS.has(hat), `${LOOK_CHOICES.hat[hat].name}: phải ở đúng một nhóm`);
  }
});

test("mặt trong của mũ: mũ che đỉnh nào cũng chặn tia thẳng lên", () => {
  // Lưới mặt mũ từng bỏ sót vùng ngay trên đỉnh đầu (nón lá, quai thao, mũ cướp biển, mũ phù thủy): Xù bông khi đó tưởng mũ hở đỉnh.
  for (const hat of HATS_OVER_HAIR) assert.ok(hatCeilingOf(hat)!(UP) < 8, `${LOOK_CHOICES.hat[hat].name}: tia thẳng lên không chạm mũ`);
});

test("đội mũ che đỉnh: tóc không tụt xuống quá 0,22 so với không đội mũ", () => {
  // Búi, chỗ buộc dời xuống dưới vành mũ nên tụt tới 0,203 (dưới vành không còn chỗ thì giấu trong mũ). Đuôi ngựa trước khi sửa
  // (5/11/2026) dời cả đuôi theo chỗ buộc, tụt 0,11–0,45: dưới Khăn đóng, Mũ bảo hiểm ngọn đuôi gần chạm đất, lúc ngồi cắm xuống đất.
  for (let style = 0; style < STYLES; style++) {
    if (style === BALD) continue;
    const bare = lowest(hairParts(style, 0, null));
    for (const hat of HATS_OVER_HAIR) {
      const drop = bare - lowest(hairParts(style, 0, hatCeilingOf(hat)));
      assert.ok(drop <= 0.22, `kiểu ${style} với ${LOOK_CHOICES.hat[hat].name}: tụt ${drop.toFixed(3)}`);
    }
  }
});

test("đội mũ kín đỉnh: tóc không cao hơn đỉnh mũ, như đầu trọc đội cùng mũ", () => {
  for (const hat of HATS_OVER_HAIR) {
    const bald = top({ ...PLAIN, hair: BALD, hat });
    for (let style = 0; style < STYLES; style++) {
      assert.ok(top({ ...PLAIN, hair: style, hat }) <= bald + 1e-6, `kiểu ${style} với ${LOOK_CHOICES.hat[hat].name}`);
    }
  }
});

test("mũ không che đỉnh phóng theo độ phồng của tóc; mũ che đỉnh và đầu trọc giữ nguyên", () => {
  const height = (hair: number, hat: number) => {
    const [box] = fitHat(hair, hat, [new BoxGeometry(1, 1, 1)]);
    box.computeBoundingBox();
    return box.boundingBox!.max.y - box.boundingBox!.min.y;
  };
  assert.equal(LOOK_CHOICES.hat[11].name, "Mũ phượng");
  assert.ok(OPEN_HATS.has(11), "Mũ phượng đặt trên tóc (người dùng chọn 5/11/2026)");
  for (const hat of OPEN_HATS) {
    assert.ok(Math.abs(height(25, hat) - HAIR_VOLUME[25]) < 1e-9, `Xù bông với ${LOOK_CHOICES.hat[hat].name}`);
    assert.equal(height(BALD, hat), 1, `đầu trọc với ${LOOK_CHOICES.hat[hat].name}`);
  }
  for (const hat of HATS_OVER_HAIR) assert.equal(height(25, hat), 1, `mũ che đỉnh ${LOOK_CHOICES.hat[hat].name}`);
});

test("dưới mũ che đỉnh, phần tóc trên ngang tai không nhô ra ngoài mặt trong của mũ", () => {
  const p = new Vector3();
  const d = new Vector3();
  for (const hat of HATS_OVER_HAIR) {
    const ceiling = hatCeilingOf(hat)!;
    for (let style = 0; style < STYLES; style++) {
      let worst = 0;
      for (const part of hairParts(style, 0, ceiling)) {
        const position = part.attributes.position;
        for (let i = 0; i < position.count; i++) {
          p.fromBufferAttribute(position, i);
          const r = p.length();
          d.copy(p).divideScalar(r);
          // Dưới ngang tai tóc thả tự do; hướng mũ không che thì ceiling trả số lớn.
          if (Math.acos(d.y) > 1.5 || ceiling(d) >= 8) continue;
          worst = Math.max(worst, r - ceiling(d));
        }
      }
      // Ngưỡng 0,045: lọn ép theo từng vòng mặt cắt, nên sát vành mũ (trong lòng mũ, bị mũ che) đoạn nối giữa hai vòng còn nhô
      // chừng 0,02–0,04. Tóc chọc qua mũ thật (trước khi có phần ép) nhô 0,1–0,3.
      assert.ok(worst <= 0.045, `kiểu ${style} với ${LOOK_CHOICES.hat[hat].name}: nhô ra ${worst.toFixed(3)}`);
    }
  }
});
