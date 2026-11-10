// File vẽ nhân vật cho app HSK (public/town/chibi-v1.js): phần thuần lấy đúng từ code thị trấn, file đóng gói có đủ
// tên của phiên bản 1, và web cho domain khác tải file.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildChibi } from "../scripts/build-chibi.ts";
import { ITEM_PARTS, LOOK_CHOICES, TOWN_ONLY, canWear, cleanLook, fitLook, itemId, lookKey, randomLook, rarityOf, starterLook } from "../games/ma-soi/look.ts";
import * as catalog from "../games/town/chibi-catalog.ts";
import { isValidBirthDate } from "../games/town/age.ts";
import { bagItems } from "../games/town/bag.ts";
import { RARITY_NAMES, RIM_COLORS, statLine } from "../games/town/items.ts";
import { MAX_NAME_LENGTH, cleanTownName } from "../games/town/profile.ts";

test("file vẽ: phiên bản 1; danh mục và luật là đúng code của thị trấn, không phải bản chép", () => {
  assert.equal(catalog.VERSION, 1);
  const same: [unknown, unknown][] = [
    [catalog.LOOK_CHOICES, LOOK_CHOICES], [catalog.ITEM_PARTS, ITEM_PARTS], [catalog.TOWN_ONLY, TOWN_ONLY],
    [catalog.itemId, itemId], [catalog.rarityOf, rarityOf], [catalog.canWear, canWear], [catalog.fitLook, fitLook],
    [catalog.randomLook, randomLook], [catalog.starterLook, starterLook], [catalog.cleanLook, cleanLook], [catalog.lookKey, lookKey],
    [catalog.RARITY_NAMES, RARITY_NAMES], [catalog.RIM_COLORS, RIM_COLORS], [catalog.statLine, statLine],
    [catalog.ownedItems, bagItems], [catalog.cleanTownName, cleanTownName], [catalog.MAX_NAME_LENGTH, MAX_NAME_LENGTH],
    [catalog.isValidBirthDate, isValidBirthDate],
  ];
  same.forEach(([got, want], index) => assert.equal(got, want, `tên thứ ${index + 1}`));
});

test("file vẽ: bốn thẻ tủ đồ như thị trấn, mỗi phần của nhân vật nằm đúng một thẻ và có tên", () => {
  assert.deepEqual(catalog.WARDROBE_TABS.map((tab) => tab.title), ["Người", "Trang phục", "Phụ kiện", "Thú cưng & xe"]);
  const parts = catalog.WARDROBE_TABS.flatMap((tab) => tab.parts);
  assert.equal(new Set(parts).size, parts.length, "không phần nào ở hai thẻ");
  assert.deepEqual([...parts].sort(), Object.keys(LOOK_CHOICES).sort());
  for (const part of parts) assert.ok(catalog.PART_TITLES[part], `phần ${part} có tên`);
  assert.equal(catalog.PART_TITLES.body, "Giới tính");
  assert.equal(catalog.PART_TITLES.pet, "Thú cưng");
});

/** Mọi tên app HSK dùng, đúng như thiết kế đợt 2 (mục "Cách gọi, phiên bản 1"). */
const V1_NAMES = [
  "VERSION", "LOOK_CHOICES", "ITEM_PARTS", "TOWN_ONLY", "WARDROBE_TABS", "PART_TITLES", "RARITY_NAMES", "RIM_COLORS", "MAX_NAME_LENGTH",
  "itemId", "rarityOf", "canWear", "ownedItems", "fitLook", "randomLook", "starterLook", "cleanLook", "lookKey", "statLine",
  "cleanTownName", "isValidBirthDate", "drawPortrait", "drawFigure", "mountPreview",
];

test("file vẽ đóng gói thành một ES module có đủ tên của phiên bản 1, kèm three", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chibi-"));
  try {
    const result = await buildChibi(join(dir, "chibi-v1.js"));
    const outputs = Object.entries(result.metafile.outputs);
    assert.equal(outputs.length, 1, "chỉ một file");
    const [path, output] = outputs[0];
    assert.ok(path.endsWith("chibi-v1.js"), path);
    for (const name of V1_NAMES) assert.ok(output.exports.includes(name), `thiếu ${name}`);
    assert.ok(Object.keys(output.inputs).some((input) => input.includes("node_modules/three/")), "có three");
    assert.ok(output.bytes < 1_500_000, `nặng ${output.bytes} byte`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("web cho domain khác (app HSK) tải file vẽ", async () => {
  const { default: config } = await import("../next.config.ts");
  const rules = (await config.headers?.()) ?? [];
  const rule = rules.find((one) => one.source === "/town/chibi-v1.js");
  assert.deepEqual(rule?.headers, [{ key: "Access-Control-Allow-Origin", value: "*" }]);
});
