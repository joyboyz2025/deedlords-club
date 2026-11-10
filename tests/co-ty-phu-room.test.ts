// Phòng Cờ tỷ phú chạy thật trên RoomHost với socket giả và đồng hồ giả: người đang tới lượt rớt mạng, hẹn giờ, đóng phòng, server bật lại.

import assert from "node:assert/strict";
import { test } from "node:test";
import { HOST_AWAY_MS, HOST_GRACE_MS, IDLE_MS } from "../lib/roomTimers.ts";
import { TycoonRoom } from "../worker/co-ty-phu-room.ts";
import { FakeSocket, HOUR, MINUTE, TestRoom, pass, settle, useFakeClock } from "./room-harness.ts";

useFakeClock(Date.UTC(2026, 10, 3, 12));

/** An tạo phòng, Bình và Chi vào sau; cả ba cùng chơi. Máy bấm hộ tắt sẵn, trừ khi truyền `auto`, để các test hẹn giờ khác khỏi bị xen vào. */
async function startTycoon(limit = 0, auto = 0) {
  const room = await TestRoom.create(TycoonRoom);
  const an = await room.connect({ name: "An", hostKey: room.hostKey });
  const binh = await room.connect({ name: "Bình" });
  const chi = await room.connect({ name: "Chi" });
  an.say({ t: "limit", minutes: limit });
  an.say({ t: "auto", seconds: auto });
  binh.say({ t: "start" });
  await settle();
  assert.equal(an.view.phase, "lobby", "chỉ chủ phòng bắt đầu được");
  an.say({ t: "start" });
  await settle();
  assert.equal(chi.view.phase, "playing");
  const everyone = [an, binh, chi];
  const byId = (id: string) => everyone.find((ws) => ws.view.you.id === id)!;
  return { room, an, binh, chi, everyone, byId, current: () => byId(an.view.current) };
}

/** Người đang tới lượt đi hết lượt của mình: đổ, không mua, trả nợ nếu có, rồi kết thúc. */
async function playTurn(ws: FakeSocket): Promise<void> {
  const me = ws.view.you.id;
  for (let i = 0; i < 20 && ws.view.current === me && ws.view.phase === "playing"; i++) {
    const { stage, again } = ws.view;
    if (stage === "roll" || (stage === "end" && again)) ws.say({ t: "roll" });
    else if (stage === "buy") ws.say({ t: "skip" });
    else if (stage === "debt") ws.say({ t: "bankrupt" });
    else ws.say({ t: "end" });
    await settle();
  }
}

test("cờ tỷ phú phòng: mọi máy thấy cùng một ván, người không tới lượt không đổ được", async () => {
  const { everyone, current } = await startTycoon();
  const mover = current();
  const waiter = everyone.find((ws) => ws !== mover)!;
  waiter.say({ t: "roll" });
  await settle();
  assert.equal(mover.view.rolls, 0);
  mover.say({ t: "roll" });
  await settle();
  for (const ws of everyone) assert.equal(ws.view.rolls, 1);
  const positions = everyone.map((ws) => JSON.stringify(ws.view.players.map((p: { position: number }) => p.position)));
  assert.equal(new Set(positions).size, 1);
  const secrets = everyone.map((ws) => ws.identity.secret);
  assert.ok(
    everyone.every((ws, i) => ws.messages.every((m) => secrets.every((secret, j) => j === i || !JSON.stringify(m).includes(secret)))),
    "không ai nhận được khóa của người khác",
  );
});

test("cờ tỷ phú phòng: người không tới lượt rớt mạng thì ván vẫn chạy", async () => {
  const { everyone, current } = await startTycoon();
  const mover = current();
  const idle = everyone.find((ws) => ws !== mover)!;
  idle.close();
  await pass(HOST_GRACE_MS + MINUTE);
  assert.equal(mover.view.pause, null);
});

test("cờ tỷ phú phòng: người đang tới lượt vắng quá 10 giây thì ván và giờ chơi đứng yên, quay lại thì chạy tiếp", async () => {
  const { room, everyone, current } = await startTycoon(30);
  const mover = current();
  const watcher = everyone.find((ws) => ws !== mover)!;
  const identity = mover.identity;
  await pass(MINUTE);
  mover.close();
  await pass(HOST_GRACE_MS - 1000);
  assert.equal(watcher.view.pause, null);
  await pass(1000);
  assert.equal(watcher.view.pause.away, identity.id);
  assert.equal(watcher.view.endsInMs, null, "giờ chơi đứng yên");
  await pass(5 * MINUTE);
  const back = await room.connect(identity);
  assert.equal(back.view.pause, null);
  assert.equal(back.view.endsInMs, 30 * MINUTE - MINUTE - HOST_GRACE_MS, "giờ chơi chạy tiếp đúng thời gian còn lại");
  assert.equal(back.view.current, identity.id);
});

test("cờ tỷ phú phòng: vắng quá 10 phút thì người đó bị loại, lượt sang người kế, phòng vẫn mở", async () => {
  const { room, everyone, current } = await startTycoon();
  const mover = current();
  const left = mover.view.you.id;
  const others = everyone.filter((ws) => ws !== mover);
  mover.close();
  await pass(HOST_GRACE_MS + HOST_AWAY_MS);
  const view = others[0].view;
  assert.equal(view.players.find((p: { id: string }) => p.id === left).bankrupt, true);
  assert.notEqual(view.current, left);
  assert.equal(view.phase, "playing");
  assert.equal(view.pause, null);
  room.assertOpen();
});

test("cờ tỷ phú phòng: chủ phòng hủy được ván đang dừng", async () => {
  const { an, everyone, current } = await startTycoon();
  const mover = current();
  if (mover === an) return; // Chủ phòng là người vắng thì không có ai để bấm, đã có test riêng cho việc bị loại.
  mover.close();
  await pass(HOST_GRACE_MS);
  const watcher = everyone.find((ws) => ws !== mover && ws !== an)!;
  assert.ok(watcher.view.pause);
  watcher.say({ t: "lobby" });
  await settle();
  assert.equal(watcher.view.phase, "playing");
  an.say({ t: "lobby" });
  await settle();
  assert.equal(watcher.view.phase, "lobby");
  assert.equal(watcher.view.pause, null);
});

test("cờ tỷ phú phòng: hết giờ thì chơi nốt vòng rồi xếp hạng", async () => {
  const { everyone, byId, an } = await startTycoon(30);
  // Mỗi 5 phút có người đi một lượt, nên phòng không bị đóng vì không ai chơi.
  for (let i = 0; i < 6; i++) {
    await playTurn(byId(an.view.current));
    await pass(5 * MINUTE - 1000, MINUTE / 2);
  }
  assert.equal(an.view.lastRound, false);
  await pass(6000);
  assert.equal(an.view.lastRound, true);
  for (let i = 0; i < 4 && an.view.phase === "playing"; i++) await playTurn(byId(an.view.current));
  assert.equal(an.view.phase, "ended");
  assert.equal(an.view.result.reason, "time");
  assert.equal(an.view.result.ranking.length, 3);
  for (const ws of everyone) assert.deepEqual(ws.view.result, an.view.result);
});

test("cờ tỷ phú phòng: người tới lượt có mặt mà để quá giờ thì máy bấm hộ; bấm gì đó là đếm lại từ đầu", async () => {
  const { current, everyone } = await startTycoon(0, 10);
  const mover = current();
  // Chờ 10 giây chủ phòng chọn, cộng 4 giây cho xúc xắc lăn và quân chạy trên máy người chơi.
  assert.ok(mover.view.autoInMs > 10_000 && mover.view.autoInMs <= 14_000);
  await pass(13_000);
  assert.equal(mover.view.rolls, 0, "chưa tới giờ");
  await pass(1000);
  assert.equal(mover.view.rolls, 1, "quá giờ thì máy đổ hộ");
  for (const ws of everyone) assert.ok(ws.view.log.some((line: string) => line.endsWith("timed out; the game rolls for them.")));

  // Bàn khác: người tới lượt tự đổ thì đồng hồ đếm lại từ lúc đó.
  const next = await startTycoon(0, 10);
  const player = next.current();
  await pass(10_000);
  player.say({ t: "roll" });
  await settle();
  const log = player.view.log.length;
  await pass(13_000);
  assert.equal(player.view.log.length, log, "vừa bấm xong thì chưa bấm hộ");
  await pass(1000);
  assert.ok(player.view.log.length > log, "quá giờ kể từ lần bấm cuối thì máy bấm hộ");
  assert.ok(player.view.log.some((line: string) => line.includes("timed out")));
});

test("cờ tỷ phú phòng: máy bấm hộ mà không ai thật chơi thì vẫn đóng phòng sau 10 phút", async () => {
  const { room, everyone } = await startTycoon(0, 10);
  await pass(IDLE_MS - 1000);
  room.assertOpen();
  assert.ok(everyone[0].view.rolls > 10, "ván vẫn đi tiếp nhờ máy bấm hộ");
  await pass(1000);
  await room.assertClosed("closed-idle", everyone);
});

test("cờ tỷ phú phòng: giữa ván 10 phút không ai làm gì thì đóng phòng; phòng chờ thì sau 24 giờ", async () => {
  const { room, everyone } = await startTycoon();
  await pass(IDLE_MS - 1000);
  room.assertOpen();
  await pass(1000);
  await room.assertClosed("closed-idle", everyone);

  const lobby = await TestRoom.create(TycoonRoom);
  const host = await lobby.connect({ name: "An", hostKey: lobby.hostKey });
  await pass(23 * HOUR, MINUTE);
  lobby.assertOpen();
  await pass(HOUR, MINUTE);
  await lobby.assertClosed("no-room", [host]);
});

test("cờ tỷ phú phòng: server bật lại giữa ván thì đúng người, đúng tiền, đúng đất", async () => {
  const { room, byId, an, everyone } = await startTycoon();
  for (let i = 0; i < 6; i++) await playTurn(byId(an.view.current));
  const before = JSON.stringify({ players: an.view.players.map((p: Record<string, unknown>) => [p.id, p.cash, p.position]), props: an.view.props, current: an.view.current });
  const ids = everyone.map((ws) => ws.identity);
  await room.restart();
  const back = await room.connect({ ...ids[0], hostKey: room.hostKey });
  for (const id of ids.slice(1)) await room.connect(id);
  const after = JSON.stringify({ players: back.view.players.map((p: Record<string, unknown>) => [p.id, p.cash, p.position]), props: back.view.props, current: back.view.current });
  assert.equal(after, before);
  assert.equal(back.view.you.isHost, true);
});

test("cờ tỷ phú phòng: tối đa 6 người chơi, người vào sau chỉ xem", async () => {
  const room = await TestRoom.create(TycoonRoom);
  const host = await room.connect({ name: "An", hostKey: room.hostKey });
  const others = [];
  for (let i = 0; i < 7; i++) others.push(await room.connect({ name: `Người ${i}` }));
  host.say({ t: "start" });
  await settle();
  assert.equal(host.view.order.length, 6);
  assert.equal(others[6].view.players.find((p: { id: string }) => p.id === others[6].view.you.id).color, null);
});
