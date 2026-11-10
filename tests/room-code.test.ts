import assert from "node:assert/strict";
import { test } from "node:test";
import { randomCode, serverOfCode } from "../lib/roomCode.ts";

test("mã phòng cho biết phòng thuộc server nào", () => {
  for (let i = 0; i < 2000; i++) {
    const first = randomCode(1);
    const second = randomCode(2);
    assert.match(first, /^[A-HJ-NP-Z][A-HJ-NP-Z2-9]{3}$/);
    assert.match(second, /^2[A-HJ-NP-Z2-9]{3}$/);
    assert.equal(serverOfCode(first), 1);
    assert.equal(serverOfCode(second), 2);
  }
});

test("mã phòng ở mỗi server vẫn đủ ngẫu nhiên", () => {
  for (const server of [1, 2]) {
    const codes = new Set(Array.from({ length: 300 }, () => randomCode(server)));
    assert.ok(codes.size > 280, `server ${server}: ${codes.size} mã khác nhau`);
  }
});
