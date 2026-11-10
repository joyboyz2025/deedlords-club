// Danh sách phòng, khóa PIN và cài đặt của chủ phòng, chạy thật từng lớp phòng trên RoomHost với socket giả.
// Bộ đếm sai PIN dùng chung cả server, nên mỗi lần thử dùng một địa chỉ mạng riêng để các test không dính nhau.

import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_PEOPLE } from "../games/co-ty-phu/engine.ts";
import { TycoonRoom } from "../worker/co-ty-phu-room.ts";
import { TestRoom, useFakeClock } from "./room-harness.ts";

useFakeClock(Date.UTC(2026, 10, 3, 12));

const OWNER = { ownerId: "u-1", hostName: "Hải", listed: true };
let lastIp = 0;
const freshIp = () => `10.0.${Math.floor(++lastIp / 250)}.${lastIp % 250}`;

// Các game dựng phần nhìn cho từng người (Ma Sói, Cờ vua, Cờ tỷ phú): chủ phòng là một người chơi có khóa chủ phòng.

type ViewRoom = { name: string; Class: unknown; maxPlayers: number; playingPhase: string };

function viewRoomTests({ name, Class, maxPlayers, playingPhase }: ViewRoom): void {
  test(`${name}: phòng mở từ thị trấn hiện trong danh sách với tên chủ phòng, chưa khóa, đang chờ`, async () => {
    const room = await TestRoom.create(Class, OWNER);
    const host = await room.connect({ name: "Hải", hostKey: room.hostKey }, freshIp());
    await room.connect({ name: "An" }, freshIp());
    assert.deepEqual(room.summary(), {
      code: "ABCD",
      hostName: "Hải",
      players: 2,
      maxPlayers,
      status: "waiting",
      locked: false,
      listed: true,
      createdAt: Date.now(),
    });
    assert.deepEqual(host.view.access, { listed: true, locked: false, pin: null });
  });

  test(`${name}: chủ phòng đặt PIN thì chỉ chủ phòng thấy PIN; người mới phải đúng PIN, người cũ thì khỏi`, async () => {
    const room = await TestRoom.create(Class, OWNER);
    const host = await room.connect({ name: "Hải", hostKey: room.hostKey }, freshIp());
    const an = await room.connect({ name: "An" }, freshIp());
    await room.say(host, { t: "pin", pin: "0427" });
    assert.deepEqual(host.view.access, { listed: true, locked: true, pin: "0427" });
    assert.deepEqual(an.view.access, { listed: true, locked: true, pin: null });

    const ip = freshIp();
    assert.equal((await room.connect({ name: "Bình" }, ip)).lastError, "pin");
    assert.equal((await room.connect({ name: "Bình", pin: "1111" }, ip)).lastError, "pin");
    assert.equal((await room.connect({ name: "Bình", pin: "0427" }, ip)).lastError, undefined);
    assert.equal((await room.connect({ name: "An", ...an.identity }, freshIp())).lastError, undefined);
    assert.equal((await room.connect({ name: "Hải", ...host.identity }, freshIp())).lastError, undefined);
  });

  test(`${name}: chủ phòng vào lần đầu bằng khóa chủ phòng thì không cần PIN`, async () => {
    const room = await TestRoom.create(Class, OWNER);
    const host = await room.connect({ name: "Hải", hostKey: room.hostKey }, freshIp());
    await room.say(host, { t: "pin", pin: "0427" });
    assert.equal((await room.connect({ name: "Hải máy khác", hostKey: room.hostKey }, freshIp())).lastError, undefined);
  });

  test(`${name}: một địa chỉ sai PIN 10 lần thì bị chặn kể cả khi đúng`, async () => {
    const room = await TestRoom.create(Class, OWNER);
    const host = await room.connect({ name: "Hải", hostKey: room.hostKey }, freshIp());
    await room.say(host, { t: "pin", pin: "0427" });
    const ip = freshIp();
    for (let i = 0; i < 10; i++) assert.equal((await room.connect({ name: "Dò", pin: String(1000 + i) }, ip)).lastError, "pin");
    assert.equal((await room.connect({ name: "Dò", pin: "0427" }, ip)).lastError, "pin-wait");
    assert.equal((await room.connect({ name: "Bạn", pin: "0427" }, freshIp())).lastError, undefined);
  });

  test(`${name}: chỉ chủ phòng đổi được cài đặt; PIN sai dạng bị bỏ qua, null là bỏ khóa`, async () => {
    const room = await TestRoom.create(Class, OWNER);
    const host = await room.connect({ name: "Hải", hostKey: room.hostKey }, freshIp());
    const an = await room.connect({ name: "An" }, freshIp());
    await room.say(an, { t: "pin", pin: "1234" });
    await room.say(an, { t: "listed", listed: false });
    assert.equal(room.summary().locked, false);
    assert.equal(room.summary().listed, true);
    await room.say(host, { t: "pin", pin: "12" });
    assert.equal(room.summary().locked, false);
    await room.say(host, { t: "pin", pin: "0427" });
    await room.say(host, { t: "pin", pin: null });
    assert.equal(room.summary().locked, false);
    await room.say(host, { t: "listed", listed: false });
    assert.equal(room.summary().listed, false);
    assert.equal(host.view.access.listed, false);
  });

  test(`${name}: đang chơi thì báo đang chơi, chơi xong thì lại đang chờ`, async () => {
    const room = await TestRoom.create(Class, OWNER);
    await room.connect({ name: "Hải", hostKey: room.hostKey }, freshIp());
    await room.restart((stored) => {
      stored.game.phase = playingPhase;
    });
    assert.equal(room.summary().status, "playing");
    await room.restart((stored) => {
      stored.game.phase = "ended";
    });
    assert.equal(room.summary().status, "waiting");
  });

  test(`${name}: phòng mở từ bản cũ không có phần quyền thì coi như ẩn, không khóa`, async () => {
    const room = await TestRoom.create(Class);
    await room.connect({ name: "Hải", hostKey: room.hostKey }, freshIp());
    await room.restart((stored) => {
      delete stored.access;
      delete stored.createdAt;
    });
    assert.equal(room.summary().listed, false);
    assert.equal(room.summary().locked, false);
    assert.equal((await room.connect({ name: "An" }, freshIp())).lastError, undefined);
  });
}

viewRoomTests({ name: "Cờ tỷ phú", Class: TycoonRoom, maxPlayers: MAX_PEOPLE, playingPhase: "playing" });
