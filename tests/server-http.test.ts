// Server ở VPS qua HTTP thật: mở phòng phải đăng nhập, danh sách phòng cho thị trấn, trả lời trình duyệt hỏi trước (CORS).
// Bật server ở máy với tài khoản thử `dev:`, cổng riêng và thư mục phòng tạm; không có Supabase.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const PORT = 8792;
const HTTP = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(join(tmpdir(), "phong-http-"));
const SUMMARY_KEYS = ["code", "hostName", "locked", "maxPlayers", "players", "status"];
let server: ChildProcess;

before(
  () =>
    new Promise<void>((resolve, reject) => {
      server = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--import", "./server/register.mjs", "server/index.ts"], {
        env: { ...process.env, PORT: String(PORT), DATA_DIR, TOWN_DEV_AUTH: "1", SUPABASE_URL: "", SUPABASE_ANON_KEY: "" },
        stdio: ["ignore", "pipe", "ignore"],
      });
      server.stdout!.on("data", (chunk) => {
        if (String(chunk).includes("đang chạy")) resolve();
      });
      server.on("exit", () => reject(new Error("Server tắt ngay khi vừa bật")));
    }),
  { timeout: 15_000 },
);

// Lúc tắt, server ghi các phòng ra file: đợi tắt hẳn rồi mới xóa thư mục.
after(async () => {
  const exited = new Promise((resolve) => server.once("exit", resolve));
  server.kill();
  await exited;
  rmSync(DATA_DIR, { recursive: true, force: true });
});

function open(path: string, token: string | null, body: unknown = { listed: true, hostName: "Hải" }): Promise<Response> {
  return fetch(`${HTTP}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token === null ? {} : { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });
}

const lobby = async (game: string) => ((await (await fetch(`${HTTP}/lobby?game=${game}`)).json()) as { rooms: Record<string, unknown>[] }).rooms;

test("mở phòng mà không có mã đăng nhập, hay mã sai, thì bị từ chối", async () => {
  for (const path of ["/co-ty-phu/rooms"]) {
    assert.equal((await open(path, null)).status, 401, path);
    assert.equal((await open(path, "khong-phai-ma")).status, 401, path);
  }
});

test("người đăng nhập mở phòng từ thị trấn thì phòng hiện trong danh sách, chỉ có phần tóm tắt", async () => {
  const response = await open("/co-ty-phu/rooms", "dev:hai");
  assert.equal(response.status, 200);
  const { code, hostKey } = (await response.json()) as { code: string; hostKey: string };
  const listing = await (await fetch(`${HTTP}/lobby?game=co-ty-phu`)).text();
  assert.ok(!listing.includes(hostKey), "danh sách không được lộ khóa chủ phòng");
  const room = (JSON.parse(listing) as { rooms: Record<string, unknown>[] }).rooms.find((r) => r.code === code);
  assert.ok(room);
  assert.deepEqual(Object.keys(room).sort(), SUMMARY_KEYS);
  assert.equal(room.hostName, "Hải");
  assert.equal(room.status, "waiting");
  assert.equal(room.locked, false);
});

test("phòng mở từ trang game thì ẩn khỏi danh sách", async () => {
  const { code } = (await (await open("/co-ty-phu/rooms", "dev:hai", { listed: false, hostName: "Hải" })).json()) as { code: string };
  assert.ok(!(await lobby("co-ty-phu")).some((room) => room.code === code));
});

test("chỉ còn phòng Cờ tỷ phú: game lạ hay game đã bỏ thì không có danh sách, không mở được phòng", async () => {
  for (const game of ["bai-cao", "lo-to", "ma-soi"]) assert.equal((await fetch(`${HTTP}/lobby?game=${game}`)).status, 404, game);
  for (const path of ["/rooms", "/ma-soi/rooms", "/co-vua/rooms"]) assert.equal((await open(path, "dev:hai")).status, 404, path);
});

test("trình duyệt hỏi trước bằng OPTIONS thì được gửi kèm mã đăng nhập", async () => {
  const response = await fetch(`${HTTP}/co-ty-phu/rooms`, { method: "OPTIONS" });
  assert.equal(response.status, 204);
  assert.match(response.headers.get("access-control-allow-headers") ?? "", /authorization/i);
  assert.match(response.headers.get("access-control-allow-methods") ?? "", /POST/);
});
