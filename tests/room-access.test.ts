// Luật vào phòng dùng chung: ai mở phòng, hiện hay ẩn, khóa PIN, đếm sai PIN, danh sách cho thị trấn.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OPEN_ACCESS,
  PinGuard,
  accessFor,
  accessView,
  bearerToken,
  cleanCreateBody,
  cleanPin,
  lobbyList,
  mayEnter,
  socketIp,
  type RoomReport,
} from "../lib/roomAccess.ts";

const MINUTE = 60_000;

test("mở phòng: tên chủ phòng gọn lại, tối đa 20 ký tự; chỉ hiện khi gửi đúng true", () => {
  assert.deepEqual(cleanCreateBody({ hostName: "  Hải  ", listed: true }), { hostName: "Hải", listed: true });
  assert.deepEqual(cleanCreateBody({ hostName: "a".repeat(30), listed: "true" }), { hostName: "a".repeat(20), listed: false });
  assert.deepEqual(cleanCreateBody(null), { hostName: "Chủ phòng", listed: false });
  assert.equal(cleanCreateBody({ hostName: "Nguyễn Thị Hồng Nhưn".normalize("NFD") }).hostName, "Nguyễn Thị Hồng Nhưn");
});

test("quyền vào phòng: phòng mới lưu chủ tài khoản, phòng cũ coi như ẩn và không khóa", () => {
  assert.deepEqual(accessFor({ ownerId: "u-1", hostName: "Hải", listed: true }), { ownerId: "u-1", hostName: "Hải", listed: true, pin: null });
  assert.deepEqual(accessFor(undefined), OPEN_ACCESS);
  assert.deepEqual(OPEN_ACCESS, { ownerId: null, hostName: "", listed: false, pin: null });
});

test("PIN: đúng 4 chữ số, null là bỏ khóa, còn lại không nhận", () => {
  assert.equal(cleanPin("0427"), "0427");
  assert.equal(cleanPin(null), null);
  for (const bad of ["123", "12345", "12a4", 1234, undefined, " 1234"]) assert.equal(cleanPin(bad), undefined, String(bad));
});

test("PIN: người mới phải đúng PIN, người đã trong phòng và chủ phòng thì khỏi", () => {
  const locked = { ...OPEN_ACCESS, pin: "0427" };
  assert.equal(mayEnter(OPEN_ACCESS, undefined, false), true);
  assert.equal(mayEnter(locked, "0427", false), true);
  assert.equal(mayEnter(locked, "1111", false), false);
  assert.equal(mayEnter(locked, undefined, false), false);
  assert.equal(mayEnter(locked, undefined, true), true);
});

test("phần nhìn: chỉ chủ phòng thấy PIN, người khác chỉ biết phòng có khóa", () => {
  const locked = { ...OPEN_ACCESS, listed: true, pin: "0427" };
  assert.deepEqual(accessView(locked, true), { listed: true, locked: true, pin: "0427" });
  assert.deepEqual(accessView(locked, false), { listed: true, locked: true, pin: null });
  assert.deepEqual(accessView(OPEN_ACCESS, true), { listed: false, locked: false, pin: null });
});

test("đếm sai PIN: 10 lần trong 10 phút thì chặn địa chỉ đó, qua 10 phút thì mở lại, địa chỉ khác không sao", () => {
  const guard = new PinGuard();
  const start = Date.UTC(2026, 10, 3, 12);
  for (let i = 0; i < 9; i++) guard.miss("1.1.1.1", start + i * 1000);
  assert.equal(guard.blocked("1.1.1.1", start + 10_000), false);
  guard.miss("1.1.1.1", start + 10_000);
  assert.equal(guard.blocked("1.1.1.1", start + 11_000), true);
  assert.equal(guard.blocked("2.2.2.2", start + 11_000), false);
  assert.equal(guard.blocked("1.1.1.1", start + 10 * MINUTE + 11_000), false);
});

test("địa chỉ mạng: đọc từ socket server gắn vào, không có thì bỏ qua", () => {
  assert.equal(socketIp({ ip: "1.2.3.4" }), "1.2.3.4");
  assert.equal(socketIp({ ip: "" }), null);
  assert.equal(socketIp({}), null);
});

test("danh sách: chỉ phòng đang hiện; chờ trước, đông trước, mới trước; tối đa 50; không lộ gì thêm", () => {
  const room = (code: string, extra: Partial<RoomReport>): RoomReport => ({
    code,
    hostName: code,
    players: 1,
    maxPlayers: 40,
    status: "waiting",
    locked: false,
    listed: true,
    createdAt: 0,
    ...extra,
  });
  const list = lobbyList([
    room("AN", { listed: false }),
    room("BA", { status: "playing", players: 9 }),
    room("CA", { players: 2, createdAt: 1 }),
    room("DA", { players: 2, createdAt: 5 }),
    room("EA", { players: 7 }),
  ]);
  assert.deepEqual(
    list.map((r) => r.code),
    ["EA", "DA", "CA", "BA"],
  );
  assert.deepEqual(Object.keys(list[0]).sort(), ["code", "hostName", "locked", "maxPlayers", "players", "status"]);
  assert.equal(lobbyList(Array.from({ length: 60 }, (_, i) => room(`R${i}`, {}))).length, 50);
});

test("mã đăng nhập: đọc từ header Authorization dạng Bearer", () => {
  assert.equal(bearerToken("Bearer abc.def"), "abc.def");
  assert.equal(bearerToken("bearer abc"), "");
  assert.equal(bearerToken(undefined), "");
});
