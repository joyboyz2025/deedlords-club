// npm run loadtest:co-ty-phu          Cho 4 bot chơi trên server đang chạy và kiểm tra đồng bộ, đổi đất, người đang tới lượt rớt mạng.
// npm run bots:co-ty-phu -- K7QX 3    Thả bot vào một phòng có sẵn để chơi cùng. Bot đi sau 1–2 giây như người thật.
// Đặt ROOM_URL=https://room.srv2019428.hstgr.cloud để chạy với server đã deploy.

import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { SQUARES, isOwnable } from "../games/co-ty-phu/board.ts";
import type { ClientMessage, ServerMessage } from "../games/co-ty-phu/protocol.ts";
import type { View } from "../games/co-ty-phu/view.ts";

/** Mở phòng phải có tài khoản. Server chạy ở máy (TOWN_DEV_AUTH=1) nhận mã thử `dev:`; trên VPS thì mở phòng bằng tay rồi chạy chế độ join. */
const ROOM_CREATE = {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.ROOM_TOKEN ?? "dev:bot-host"}`, "Content-Type": "application/json" },
  body: JSON.stringify({ listed: false, hostName: "Bot" }),
};

const HTTP_URL = (process.env.ROOM_URL ?? "http://localhost:8790").replace(/\/$/, "");
const WS_URL = HTTP_URL.replace(/^http/, "ws");
const NAMES = ["Máy Bình", "Máy Châu", "Máy Dũng", "Máy Giang", "Máy Hà"];

class Client {
  ws!: WebSocket;
  view: View | null = null;
  errors: string[] = [];
  raw: string[] = [];
  onView: (view: View) => void = () => {};
  private hello: ClientMessage;
  private code: string;

  constructor(code: string, hello: ClientMessage) {
    this.code = code;
    this.hello = hello;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${WS_URL}/co-ty-phu/rooms/${this.code}/ws`);
      this.ws.onopen = () => this.send(this.hello);
      this.ws.onerror = () => reject(new Error("Không mở được WebSocket"));
      this.ws.onmessage = (event) => {
        const text = String(event.data);
        this.raw.push(text);
        const message = JSON.parse(text) as ServerMessage;
        if (message.t === "error") this.errors.push(message.code);
        else {
          this.view = message;
          this.onView(message);
        }
        resolve();
      };
    });
  }

  send(message: ClientMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  close(): void {
    this.ws.close();
  }

  get identity() {
    const { name, id, secret } = this.view!.you;
    return { name, id, secret };
  }
}

/** Một việc tiếp theo của người đang tới lượt: đổ, mua khi đủ tiền, xoay tiền trả nợ, xây nhà khi được, rồi kết thúc lượt. */
function nextMove(view: View): ClientMessage | null {
  if (view.phase !== "playing" || view.current !== view.you.id || view.pause) return null;
  const me = view.players.find((p) => p.id === view.you.id)!;
  const { can } = view.you;
  if (view.stage === "roll" || (view.stage === "end" && view.again)) return { t: "roll" };
  if (view.stage === "buy") {
    const square = SQUARES[me.position];
    return isOwnable(square) && me.cash >= square.price && Math.random() < 0.85 ? { t: "buy" } : { t: "skip" };
  }
  if (view.stage === "debt") {
    const owed = view.debt!.reduce((sum, payee) => sum + payee.amount, 0);
    if (me.cash >= owed) return { t: "pay" };
    if (can.sell.length > 0) return { t: "sell", square: can.sell[0] };
    if (can.mortgage.length > 0) return { t: "mortgage", square: can.mortgage[0] };
    return { t: "bankrupt" };
  }
  if (can.build.length > 0 && me.cash > 300 && Math.random() < 0.6) return { t: "build", square: can.build[0] };
  return { t: "end" };
}

async function waitFor(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const until = performance.now() + ms;
  while (!check()) {
    if (performance.now() > until) throw new Error(`Quá lâu: ${what}`);
    await sleep(20);
  }
}

function pass(line: string): void {
  console.log(`  ✓ ${line}`);
}

const snapshot = (view: View) => JSON.stringify({ players: view.players.map((p) => [p.id, p.cash, p.position, p.bankrupt]), props: view.props, current: view.current, stage: view.stage });

async function runTest(): Promise<void> {
  const response = await fetch(`${HTTP_URL}/co-ty-phu/rooms`, ROOM_CREATE);
  const { code, hostKey } = (await response.json()) as { code: string; hostKey: string };
  console.log(`Phòng ${code} trên ${HTTP_URL}`);
  const host = new Client(code, { t: "hello", name: "Chủ phòng", hostKey });
  await host.connect();
  const clients = [host];
  for (const name of NAMES.slice(0, 3)) {
    const client = new Client(code, { t: "hello", name });
    await client.connect();
    clients.push(client);
  }
  const watcher = new Client(code, { t: "hello", name: "Người xem" });
  await watcher.connect();
  watcher.send({ t: "play", on: false });
  await waitFor(() => host.view!.players.length === 5 && !host.view!.players.find((p) => p.name === "Người xem")!.wantsToPlay, "đủ người");
  host.send({ t: "limit", minutes: 30 });
  host.send({ t: "start" });
  await waitFor(() => clients.every((c) => c.view!.phase === "playing"), "bắt đầu ván");
  assert.equal(host.view!.order.length, 4);
  assert.equal(watcher.view!.players.find((p) => p.id === watcher.view!.you.id)!.color, null);
  pass("4 người chơi, 1 người chọn chỉ xem");

  const byId = (id: string | null) => clients.find((c) => c.view!.you.id === id)!;
  let moves = 0;
  let latency = 0;
  while (moves < 150 && watcher.view!.phase === "playing") {
    const mover = byId(watcher.view!.current);
    await waitFor(() => snapshot(mover.view!) === snapshot(watcher.view!), "máy người đang tới lượt bắt kịp");
    const move = nextMove(mover.view!);
    if (!move) break;
    const before = watcher.raw.length;
    const sentAt = performance.now();
    mover.send(move);
    // Việc nào của bot cũng làm đổi ván, nên người xem phải nhận được tin mới.
    await waitFor(() => watcher.raw.length > before, `người xem nhận được việc ${move.t}`, 3000);
    latency = Math.max(latency, performance.now() - sentAt);
    moves += 1;
  }
  await sleep(300);
  const state = snapshot(watcher.view!);
  assert.ok([...clients].every((c) => snapshot(c.view!) === state), "mọi máy phải thấy cùng một ván");
  pass(`${moves} việc tới đủ 5 máy, chậm nhất ${latency.toFixed(0)} ms, mọi máy cùng một trạng thái`);

  if (host.view!.phase !== "playing") return console.log("\nVán đã hết sớm, bỏ qua phần còn lại.");
  const props = Object.entries(host.view!.props);
  const owned = props.find(([, o]) => o.houses === 0);
  if (owned) {
    const [square, { owner }] = owned;
    const from = byId(owner);
    const to = clients.find((c) => c !== from && c.view!.players.find((p) => p.id === c.view!.you.id)!.bankrupt === false)!;
    from.send({ t: "offer", offer: { to: to.view!.you.id, give: [Number(square)], take: [], giveCash: 0, takeCash: 10 } });
    await waitFor(() => to.view!.trade !== null, "đề nghị đổi tới người nhận");
    to.send({ t: "answer", accept: true });
    await waitFor(() => watcher.view!.props[Number(square)]?.owner === to.view!.you.id, "đổi đất xong");
    pass(`đổi ${SQUARES[Number(square)].name} lấy 10 tiền: mọi máy thấy chủ mới`);
  }

  const mover = byId(host.view!.current);
  const identity = mover.identity;
  const leftAt = performance.now();
  mover.close();
  await waitFor(() => watcher.view!.pause !== null, "ván dừng khi người đang tới lượt vắng quá 10 giây", 13_000);
  const pausedMs = performance.now() - leftAt;
  assert.ok(Math.abs(pausedMs - 10_000) < 1500, `dừng sau ${pausedMs} ms`);
  assert.equal(watcher.view!.endsInMs, null, "giờ chơi đứng yên");
  pass(`người đang tới lượt vắng ${(pausedMs / 1000).toFixed(1)} giây thì ván và giờ chơi đứng yên`);
  const back = new Client(code, { t: "hello", ...identity });
  await back.connect();
  await waitFor(() => watcher.view!.pause === null, "người vắng về thì chơi tiếp");
  assert.equal(back.view!.current, identity.id);
  assert.ok(back.view!.endsInMs! > 0);
  pass("quay lại thì vẫn đúng lượt mình, giờ chơi chạy tiếp");

  for (const client of [...clients, watcher, back]) client.close();
  console.log(`\nPhòng ${code}: tất cả kiểm tra đều đạt`);
}

async function runBots(code: string, count: number): Promise<void> {
  const bots = NAMES.slice(0, count).map((name) => new Client(code, { t: "hello", name }));
  for (const bot of bots) await bot.connect();
  if (bots[0].errors.length > 0) throw new Error(`Không vào được phòng: ${bots[0].errors[0]}`);
  console.log(`${count} bot đã vào phòng ${code}. Ctrl+C để dừng.`);
  // Lỡ một việc không được server nhận thì không có tin mới, nên cứ vài giây nhìn lại một lần.
  setInterval(() => {
    for (const bot of bots) if (bot.view) bot.onView(bot.view);
  }, 3000);
  for (const bot of bots) {
    let busy = false;
    bot.onView = (view) => {
      // Ai đề nghị đổi với bot thì bot nghĩ một chút rồi đồng ý hay không.
      if (view.trade?.to === view.you.id && !busy) {
        busy = true;
        setTimeout(() => {
          busy = false;
          bot.send({ t: "answer", accept: Math.random() < 0.6 });
        }, 1500);
        return;
      }
      if (busy || !nextMove(view)) return;
      busy = true;
      setTimeout(() => {
        busy = false;
        const move = bot.view && nextMove(bot.view);
        if (move) bot.send(move);
      }, 900 + Math.random() * 1100);
    };
  }
  await new Promise(() => {});
}

const [mode, ...args] = process.argv.slice(2);
if (mode === "test") {
  await runTest();
  process.exit(0);
} else if (mode === "join" && args[0]) {
  await runBots(args[0].toUpperCase(), Math.min(Number(args[1] ?? 3), NAMES.length));
} else {
  console.error("Cách dùng: co-ty-phu-bots.ts test | co-ty-phu-bots.ts join <mã phòng> [số bot]");
  process.exit(1);
}
