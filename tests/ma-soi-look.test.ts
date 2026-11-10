import assert from "node:assert/strict";
import { test } from "node:test";
import type { BufferGeometry } from "three";
import { ITEM_PARTS, LOOK_CHOICES, NO_ITEMS, TOWN_ONLY, canWear, cleanLook, fitLook, itemId, lookFromSeat, lookKey, randomLook, rarityOf, roomLook, starterLook, type Look, type LookPart } from "../games/ma-soi/look.ts";
import { armGeometry, eyesGeometry, headGeometry, legGeometry, torsoGeometry } from "../games/ma-soi/scene/parts.ts";

const PARTS = Object.keys(LOOK_CHOICES) as LookPart[];
const lastOf = (part: LookPart) => LOOK_CHOICES[part].length - 1;
const VALID = Object.fromEntries(PARTS.map((part) => [part, lastOf(part)])) as Look;
const PLAIN: Look = { body: 0, skin: 1, hair: 2, hairColor: 0, outfit: 0, robe: 3, neck: 0, hat: 0, face: 0, held: 0, shoes: 0, pet: 0, ride: 0 };
/** Túi có mọi món: để thử bốc ngẫu nhiên ra đủ mọi món và nhân vật nặng nhất. */
const ALL = new Set(ITEM_PARTS.flatMap((part) => LOOK_CHOICES[part].map((_, index) => itemId(part, index))));

test("nhân vật hợp lệ giữ nguyên và bỏ mọi trường lạ", () => {
  assert.deepEqual(cleanLook(VALID), VALID);
  assert.deepEqual(cleanLook({ ...VALID, role: "wolf", __proto__: { hat: 99 } }), VALID);
  assert.deepEqual(Object.keys(cleanLook({ ...VALID, extra: 1 })!).sort(), [...PARTS].sort());
});

test("nhân vật sai bị từ chối thay vì làm hỏng cảnh của cả phòng", () => {
  for (const junk of [null, undefined, 3, "nón lá", [], {}]) assert.equal(cleanLook(junk), null);
  for (const part of PARTS) {
    for (const bad of [-1, LOOK_CHOICES[part].length, 1.5, "1", null, NaN, Infinity]) {
      assert.equal(cleanLook({ ...VALID, [part]: bad }), null, `${part} = ${bad}`);
    }
    const { [part]: _gone, ...missing } = VALID;
    // Giày, thú cưng, xe có sau cùng: bộ đồ lưu từ trước không có vẫn dùng được, coi là 0.
    if (part === "shoes" || part === "pet" || part === "ride") assert.deepEqual(cleanLook(missing), { ...VALID, [part]: 0 });
    else assert.equal(cleanLook(missing), null, `thiếu ${part}`);
  }
});

test("mọi lựa chọn đều có tên, bảng màu đều có màu", () => {
  for (const part of PARTS) {
    assert.ok(LOOK_CHOICES[part].length >= 2, part);
    for (const choice of LOOK_CHOICES[part]) assert.ok(choice.name.length > 0, part);
    assert.equal(new Set(LOOK_CHOICES[part].map((choice) => choice.name)).size, LOOK_CHOICES[part].length, `${part} trùng tên`);
  }
  for (const part of ["skin", "hairColor", "robe"] as const) {
    for (const choice of LOOK_CHOICES[part]) assert.match(choice.color ?? "", /^#[0-9a-f]{6}$/, part);
  }
  for (const choice of LOOK_CHOICES.robe) assert.match(choice.accent ?? "", /^#[0-9a-f]{6}$/);
  assert.deepEqual(LOOK_CHOICES.body.map((choice) => choice.name), ["Nam", "Nữ"]);
});

test("nhân vật mặc định luôn hợp lệ, đủ cả nam nữ, và 8 người liền nhau không trùng áo", () => {
  for (let seat = 0; seat < 40; seat++) assert.deepEqual(cleanLook(lookFromSeat(seat)), lookFromSeat(seat), `chỗ ${seat}`);
  const robes = Array.from({ length: 8 }, (_, seat) => lookFromSeat(seat).robe);
  assert.equal(new Set(robes).size, 8);
  assert.deepEqual(new Set(Array.from({ length: 8 }, (_, seat) => lookFromSeat(seat).body)), new Set([0, 1]));
  const keys = new Set(Array.from({ length: 40 }, (_, seat) => lookKey(lookFromSeat(seat))));
  assert.ok(keys.size >= 20, `chỉ có ${keys.size} kiểu khác nhau trong 40 người`);
});

test("chọn ngẫu nhiên luôn hợp lệ, chỉ bốc trong những món mặc được, không phải lúc nào cũng đeo đủ; thú cưng, xe chỉ bốc ở thị trấn", () => {
  for (const owned of [NO_ITEMS, ALL]) {
    for (const town of [false, true]) {
      const seen = Object.fromEntries(PARTS.map((part) => [part, new Set<number>()])) as Record<LookPart, Set<number>>;
      let bareHats = 0;
      for (let i = 0; i < 4000; i++) {
        const look = randomLook(undefined, Math.random, owned, town);
        assert.deepEqual(cleanLook(look), look);
        for (const part of PARTS) seen[part].add(look[part]);
        if (look.hat === 0) bareHats += 1;
      }
      for (const part of PARTS) {
        for (const index of seen[part]) assert.ok(canWear(part, index, owned), `${part} ${index} không được bốc ra`);
        const wearable = !town && TOWN_ONLY.includes(part) ? 1 : LOOK_CHOICES[part].filter((_, index) => canWear(part, index, owned)).length;
        assert.equal(seen[part].size, wearable, `chưa từng ra hết ${part} (thị trấn: ${town})`);
      }
      assert.ok(bareHats > 1500 && bareHats < 2800, `${bareHats} lần không đội gì trên 4000`);
    }
  }
});

test("bốc ngẫu nhiên giữ đúng giới tính đã chọn, và nữ không bốc trúng râu", () => {
  const beards = LOOK_CHOICES.face.flatMap((choice, index) => (/ria|râu/i.test(choice.name) ? [index] : []));
  assert.equal(beards.length, 3);
  const faces = new Set<number>();
  for (let i = 0; i < 2000; i++) {
    const woman = randomLook(1);
    assert.equal(woman.body, 1);
    assert.ok(!beards.includes(woman.face), LOOK_CHOICES.face[woman.face].name);
    assert.equal(randomLook(0).body, 0);
    faces.add(randomLook(0).face);
  }
  for (const beard of beards) assert.ok(faces.has(beard), "nam vẫn bốc được râu");
  assert.deepEqual(new Set(Array.from({ length: 200 }, () => randomLook().body)), new Set([0, 1]));
});

test("người mới vào lần đầu là người bình thường mặc áo thường, không đeo gì", () => {
  const bodies = new Set<number>();
  const hairs = new Set<number>();
  for (let i = 0; i < 400; i++) {
    const look = starterLook();
    assert.deepEqual(cleanLook(look), look);
    assert.deepEqual([look.outfit, look.neck, look.hat, look.face, look.held, look.shoes, look.pet, look.ride], [0, 0, 0, 0, 0, 0, 0, 0]);
    assert.ok(look.hairColor < 3, "tóc màu tự nhiên");
    bodies.add(look.body);
    hairs.add(look.hair);
  }
  assert.equal(bodies.size, 2);
  assert.ok(hairs.size > 5, "kiểu tóc vẫn đa dạng");
});

test("hai nhân vật khác nhau luôn có khóa khác nhau, kể cả số có hai chữ số", () => {
  assert.notEqual(lookKey({ ...PLAIN, skin: 1, hair: 2 }), lookKey({ ...PLAIN, skin: 2, hair: 1 }));
  assert.notEqual(lookKey({ ...PLAIN, hat: 1, face: 1 }), lookKey({ ...PLAIN, hat: 11 }));
  assert.equal(lookKey(VALID), lookKey({ ...VALID }));
  for (const part of PARTS) assert.notEqual(lookKey({ ...PLAIN, [part]: 1 }), lookKey({ ...PLAIN, [part]: 0 }), part);
});

test("bốn cấp đồ: 72 lựa chọn Cơ bản, 36 món Hiếm, 18 món Quý, 3 món Cực quý; người, da, màu tóc, màu áo luôn miễn phí", () => {
  const count = (rarity: number) => ITEM_PARTS.reduce((sum, part) => sum + LOOK_CHOICES[part].filter((_, index) => rarityOf(part, index) === rarity).length, 0);
  assert.deepEqual([count(0), count(1), count(2), count(3)], [72, 36, 18, 3]);
  for (const part of PARTS.filter((part) => !(ITEM_PARTS as readonly string[]).includes(part))) {
    LOOK_CHOICES[part].forEach((choice, index) => {
      assert.equal(choice.rarity, undefined, `${part} ${choice.name}`);
      assert.equal(canWear(part, index, NO_ITEMS), true, `${part} ${choice.name}`);
    });
  }
  for (const part of ITEM_PARTS) assert.equal(rarityOf(part, 0), 0, `${part}: món số 0 phải là đồ Cơ bản`);
  // Đồ mà phòng Ma Sói tự mặc cho người chưa chọn đều là đồ Cơ bản.
  for (const [part, name] of [["outfit", "Áo thường"], ["hat", "Nón lá"], ["hat", "Khăn đóng"]] as const) {
    assert.equal(rarityOf(part, LOOK_CHOICES[part].findIndex((choice) => choice.name === name)), 0, name);
  }
});

test("món cũ giữ nguyên số thứ tự; giày và Kính phi công chỉ thêm vào cuối bảng", () => {
  // Phòng đang chơi, máy người chơi và túi đồ ở Supabase lưu số thứ tự chứ không lưu tên.
  assert.deepEqual(
    LOOK_CHOICES.face.map((choice) => choice.name),
    ["Không", "Kính tròn", "Kính râm", "Bịt một mắt", "Ria mép", "Râu dài", "Khẩu trang", "Râu quai nón", "Mũi hề", "Kính phi công"],
  );
  assert.deepEqual(LOOK_CHOICES.shoes.map((choice) => choice.name), ["Theo bộ đồ", "Dép tổ ong", "Guốc mộc", "Giày thể thao", "Giày patin"]);
  assert.deepEqual([LOOK_CHOICES.outfit[5].name, LOOK_CHOICES.outfit[21].name, LOOK_CHOICES.hat[10].name, LOOK_CHOICES.held[12].name], ["Long bào", "Ông Địa", "Mũ vua", "Gậy phép"]);
  assert.deepEqual([LOOK_CHOICES.outfit.length, LOOK_CHOICES.hat.length, LOOK_CHOICES.neck.length, LOOK_CHOICES.held.length], [22, 22, 11, 14]);
  assert.deepEqual(LOOK_CHOICES.pet.map((choice) => choice.name), ["Không", "Mèo mướp", "Chó vàng", "Gà trống", "Vịt con", "Heo ỉ", "Rồng con", "Phượng con", "Lân con", "Rùa vàng"]);
  assert.deepEqual(LOOK_CHOICES.ride.map((choice) => choice.name), ["Không", "Xe đạp", "Ván trượt", "Xe máy", "Trâu", "Ngựa", "Siêu xe", "Thảm bay", "Mây ngũ sắc"]);
  assert.deepEqual(LOOK_CHOICES.hair.map((choice) => choice.name), [
    "Trái đào", "Búi tó", "Tóc ngắn", "Hai búi", "Tóc dài", "Đuôi ngựa", "Đầu trọc", "Hai bím", "Tóc bob", "Tóc dựng", "Tóc xoăn", "Mái bằng",
    "Hai đuôi", "Mái lệch", "Chẻ ngôi", "Tóc sói", "Tóc nấm", "Ngôi giữa", "Búi củ tỏi", "Xoăn sóng",
    "Xoắn ốc", "Mào gà", "Tóc lửa", "Vấn tóc", "Phi tiên", "Xù bông",
  ]);
  assert.deepEqual(LOOK_CHOICES.hair.map((_, index) => rarityOf("hair", index)), [...Array(20).fill(0), ...Array(6).fill(1)]);
});

test("khách và người mới chỉ có đồ Cơ bản: đồ theo chỗ ngồi, người mới, bốc ngẫu nhiên", () => {
  const basic = (look: Look) => ITEM_PARTS.every((part) => rarityOf(part, look[part]) === 0);
  for (let seat = 0; seat < 40; seat++) assert.ok(basic(lookFromSeat(seat)), `chỗ ${seat}`);
  for (let i = 0; i < 400; i++) {
    assert.ok(basic(starterLook()), "người mới");
    assert.ok(basic(randomLook()), "bốc ngẫu nhiên");
  }
});

test("đưa bộ đồ về những món mặc được: món chưa có về số 0 của nhóm, món đã có và phần người giữ nguyên", () => {
  const dressed: Look = { ...PLAIN, hair: 7, robe: 2, outfit: 5, neck: 9, hat: 6, face: 9, held: 6, shoes: 4, pet: 6, ride: 7 };
  assert.deepEqual(fitLook(dressed, NO_ITEMS), { ...dressed, outfit: 0, neck: 0, hat: 0, face: 0, held: 0, shoes: 0, pet: 0, ride: 0 });
  assert.deepEqual(fitLook(dressed, new Set(["hat:6", "shoes:4", "ride:7"])), { ...dressed, outfit: 0, neck: 0, face: 0, held: 0, pet: 0 });
  assert.deepEqual(fitLook({ ...PLAIN, outfit: 1, hat: 1 }, NO_ITEMS), { ...PLAIN, outfit: 1, hat: 1 }, "đồ Cơ bản không bị đổi");
  // Tóc Hiếm chưa có thì về kiểu thường hợp giới tính, không về số 0 (Trái đào).
  assert.equal(fitLook({ ...PLAIN, body: 0, hair: 22 }, NO_ITEMS).hair, 2, "nam về Tóc ngắn");
  assert.equal(fitLook({ ...PLAIN, body: 1, hair: 22 }, NO_ITEMS).hair, 4, "nữ về Tóc dài");
  assert.equal(fitLook({ ...PLAIN, hair: 22 }, new Set(["hair:22"])).hair, 22, "có rồi thì giữ");
  assert.equal(fitLook({ ...PLAIN, hair: 19 }, NO_ITEMS).hair, 19, "kiểu thường không đổi");
  assert.equal(itemId("outfit", 5), "outfit:5");
  assert.equal(canWear("outfit", 10, NO_ITEMS), false);
  assert.equal(canWear("outfit", 10, new Set(["outfit:10"])), true);
});

test("thú cưng, xe chỉ có trong thị trấn: phòng game nhận bộ đồ đã bỏ hai nhóm này; Cực quý chỉ ở nhóm Xe", () => {
  const dressed: Look = { ...PLAIN, outfit: 5, held: 6, pet: 6, ride: 7 };
  assert.deepEqual(roomLook(dressed), { ...dressed, pet: 0, ride: 0 });
  assert.deepEqual(TOWN_ONLY, ["pet", "ride"]);
  assert.deepEqual(LOOK_CHOICES.pet.map((_, index) => rarityOf("pet", index)), [0, 1, 1, 1, 1, 1, 2, 2, 2, 2]);
  assert.deepEqual(LOOK_CHOICES.ride.map((_, index) => rarityOf("ride", index)), [0, 1, 1, 2, 2, 2, 3, 3, 3]);
  for (const part of ITEM_PARTS) {
    LOOK_CHOICES[part].forEach((choice, index) => {
      if (rarityOf(part, index) === 3) assert.equal(part, "ride", choice.name);
    });
  }
  for (let seat = 0; seat < 10; seat++) assert.deepEqual([lookFromSeat(seat).pet, lookFromSeat(seat).ride], [0, 0]);
});

function assertSound(geometry: BufferGeometry, label: string, reach: { x: number; z: number; low: number; high: number }): void {
  assert.ok(geometry, `${label}: không gộp được hình`);
  const { position, color } = geometry.attributes;
  assert.ok(position.count > 0, label);
  assert.equal(color.count, position.count, `${label}: thiếu màu`);
  assert.ok(geometry.index, `${label}: phải có index để gộp được`);
  geometry.computeBoundingBox();
  const { min, max } = geometry.boundingBox!;
  for (const value of [...position.array, ...color.array]) assert.ok(Number.isFinite(value), `${label}: có số hỏng`);
  assert.ok(Math.max(-min.x, max.x) <= reach.x, `${label}: rộng tới ${Math.max(-min.x, max.x)}`);
  assert.ok(Math.max(-min.z, max.z) <= reach.z, `${label}: sâu tới ${Math.max(-min.z, max.z)}`);
  assert.ok(min.y >= reach.low && max.y <= reach.high, `${label}: cao từ ${min.y} tới ${max.y}`);
}

/** Một món hỏng sẽ làm đơ cảnh 3D của cả phòng, nên mọi món đều phải dựng được ở cả hai giới tính. */
test("mọi món đều dựng được trên cả nam và nữ, không méo hình và không to quá khung", () => {
  for (const body of [0, 1]) {
    const base = { ...PLAIN, body };
    for (const part of PARTS) {
      LOOK_CHOICES[part].forEach((choice, index) => {
        const look = { ...base, [part]: index };
        const label = `${LOOK_CHOICES.body[body].name} ${part} ${choice.name}`;
        assertSound(headGeometry(look), `${label} (đầu)`, { x: 0.82, z: 0.78, low: -0.85, high: 1.05 });
        assertSound(torsoGeometry(look), `${label} (thân)`, { x: 0.9, z: 0.72, low: -0.32, high: 1.1 });
        assertSound(armGeometry(look, look.held), `${label} (tay)`, { x: 0.5, z: 0.5, low: -0.75, high: 0.55 });
        assertSound(legGeometry(look), `${label} (chân)`, { x: 0.2, z: 0.2, low: -0.3, high: 0.1 });
      });
    }
  }
  assert.ok(eyesGeometry(0).attributes.position.count > 0);
  assert.ok(eyesGeometry(1).attributes.position.count > eyesGeometry(0).attributes.position.count, "mắt nữ có thêm mi");
});

/** Chọn món nào cũng phải thấy khác đi: món không hiện gì thì người chơi bấm vào mà chẳng có gì xảy ra. */
test("mọi lựa chọn đều làm nhân vật khác đi, không có món nào trống hay trùng", () => {
  const print = (geometry: BufferGeometry) => `${[...geometry.attributes.position.array].join()}|${[...geometry.attributes.color.array].join()}`;
  const shapeOf: Partial<Record<LookPart, (look: Look) => string>> = {
    skin: (look) => print(headGeometry(look)) + print(armGeometry(look, 0)),
    hair: (look) => print(headGeometry(look)),
    hairColor: (look) => print(headGeometry(look)),
    robe: (look) => print(torsoGeometry(look)),
    neck: (look) => print(torsoGeometry(look)),
    hat: (look) => print(headGeometry(look)),
    face: (look) => print(headGeometry(look)),
    held: (look) => print(armGeometry(look, look.held)),
    shoes: (look) => print(legGeometry(look)),
  };
  for (const body of [0, 1]) {
    for (const [part, shape] of Object.entries(shapeOf) as [LookPart, (look: Look) => string][]) {
      const seen = new Map<string, string>();
      LOOK_CHOICES[part].forEach((choice, index) => {
        const key = shape({ ...PLAIN, body, [part]: index });
        assert.equal(seen.get(key), undefined, `${part}: ${choice.name} giống hệt ${seen.get(key)}`);
        seen.set(key, choice.name);
      });
    }
  }
  assert.equal(armGeometry({ ...PLAIN, held: 6 }, 0).attributes.position.count, armGeometry(PLAIN, 0).attributes.position.count, "tay kia không cầm gì");
});

test("nam và nữ khác nhau thật: mắt, môi, dáng người đều khác", () => {
  const sameShape = (a: BufferGeometry, b: BufferGeometry) => a.attributes.position.count === b.attributes.position.count && a.attributes.position.array.every((value, i) => value === b.attributes.position.array[i]);
  const man = { ...PLAIN, body: 0 };
  const woman = { ...PLAIN, body: 1 };
  assert.ok(!sameShape(torsoGeometry(man), torsoGeometry(woman)), "thân phải khác dáng");
  assert.ok(!sameShape(headGeometry(man), headGeometry(woman)), "mặt phải khác");
  assert.ok(!sameShape(armGeometry(man, 0), armGeometry(woman, 0)), "tay phải khác");
});

test("bộ đồ có màu riêng thì màu áo không đổi được, bộ thường thì đổi được", () => {
  const colorsOf = (look: Look) => [...torsoGeometry(look).attributes.color.array].join();
  LOOK_CHOICES.outfit.forEach((choice, outfit) => {
    const yellow = colorsOf({ ...PLAIN, outfit, robe: 0 });
    const purple = colorsOf({ ...PLAIN, outfit, robe: 7 });
    assert.equal(yellow === purple, Boolean(choice.fixed), `${choice.name}: ${choice.fixed ? "phải giữ màu riêng" : "phải đổi theo màu áo"}`);
  });
});

test("trang phục nào cũng trông khác nhau, không có hai bộ giống hệt", () => {
  const shapes = new Map<string, string>();
  LOOK_CHOICES.outfit.forEach((choice, outfit) => {
    const look = { ...PLAIN, outfit };
    const key = [torsoGeometry(look), armGeometry(look, 0), legGeometry(look)].map((g) => `${g.attributes.position.count}:${[...g.attributes.color.array].join()}`).join("|");
    assert.equal(shapes.get(key), undefined, `${choice.name} giống hệt ${shapes.get(key)}`);
    shapes.set(key, choice.name);
  });
});

/** Số ngẫu nhiên có hạt giống (mulberry32): test độ nặng lần nào cũng bốc cùng các bộ đồ, không lúc qua lúc hỏng. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("đeo nhiều nhất vẫn đủ nhẹ cho 40 người trên điện thoại", () => {
  const countOf = (look: Look) => {
    const parts = [headGeometry(look), torsoGeometry(look), armGeometry(look, look.held), armGeometry(look, 0), legGeometry(look), legGeometry(look)];
    return parts.reduce((sum, g) => sum + g.attributes.position.count, 0);
  };
  let worst = 0;
  let total = 0;
  const runs = 600;
  const random = seeded(2026);
  for (let i = 0; i < runs; i++) {
    const count = countOf(randomLook(undefined, random, ALL));
    worst = Math.max(worst, count);
    total += count;
  }
  assert.ok(total / runs < 4000, `trung bình ${Math.round(total / runs)} đỉnh một người`);
  assert.ok(worst < 8000, `nặng nhất ${worst} đỉnh một người`);
});

/** Ván đã lưu (Cờ tỷ phú, Ma Sói trên VPS) nạp lại bộ đồ cũ không qua cleanLook, nên không có giày: phải vẽ như giày của bộ đồ. */
test("bộ đồ cũ chưa có giày vẫn dựng được và giống hệt giày của bộ đồ, khóa nhân vật cũng như vậy", () => {
  const print = (geometry: BufferGeometry) => `${[...geometry.attributes.position.array].join()}|${[...geometry.attributes.color.array].join()}`;
  for (const outfit of [0, 7, 9, 21]) {
    const look = { ...PLAIN, outfit };
    const { shoes: _none, ...old } = look;
    assert.equal(print(legGeometry(old as Look)), print(legGeometry(look)), LOOK_CHOICES.outfit[outfit].name);
    assert.equal(lookKey(old as Look), lookKey(look));
  }
});
