// Server phòng chơi cho máy thường (VPS): cùng địa chỉ và cùng tin nhắn với bản trên Cloudflare, phòng lưu thành file JSON.
// Standalone deedlords copy: only the property game (Cờ tỷ phú) room. The other games' rooms and the town were removed.

import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { bearerToken, cleanCreateBody, lobbyList, type RoomReport } from "../lib/roomAccess.ts";
import { randomCode } from "../lib/roomCode.ts";
import { devAuth, eitherAuth, setTownAuth, supabaseAuth, verifyTownToken } from "../lib/townAuth.ts";
import { RoomHost, type RoomClass, type StoredRoom } from "./room-host.ts";

const PORT = Number(process.env.PORT ?? 8080);
const DATA_DIR = process.env.DATA_DIR ?? "/data";
const SERVER_NUMBER = Number(process.env.SERVER_NUMBER ?? 1);
const MAX_ROOMS = 5000;
const ALIVE_CHECK_MS = 30_000;
const MAX_MESSAGE_BYTES = 16 * 1024;

// Tên file không viết thẳng để TypeScript không kéo kiểu dữ liệu của Cloudflare vào đây.
const loadRoom = async (file: string, name: string) => (await import(new URL(file, import.meta.url).href))[name] as RoomClass;
const CLASSES: Record<string, RoomClass> = {
  "co-ty-phu": await loadRoom("../worker/co-ty-phu-room.ts", "TycoonRoom"),
};

// Phòng chơi gọi lớp này trong constructor, trên Cloudflare đây là lớp có sẵn.
Object.assign(globalThis, {
  WebSocketRequestResponsePair: class {
    request: string;
    response: string;
    constructor(request: string, response: string) {
      this.request = request;
      this.response = response;
    }
  },
});

// Ai được mở phòng. TOWN_DEV_AUTH=1 chỉ bật ở máy (`npm run dev:server`): nhận mã thử `dev:<tên>`, cũng là mã trình duyệt tự tạo
// (games/town/rooms.ts). SUPABASE_URL + SUPABASE_ANON_KEY là tùy chọn, repo này không cấu hình.
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY ? supabaseAuth(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY) : null;
if (process.env.TOWN_DEV_AUTH === "1") {
  console.warn("Nhận tài khoản thử dev:<tên>. Chỉ dùng ở máy, không bật trên VPS.");
  setTownAuth(supabase ? eitherAuth(devAuth, supabase) : devAuth);
} else if (supabase) {
  setTownAuth(supabase);
} else {
  console.warn("Không có TOWN_DEV_AUTH=1 hay SUPABASE_URL/SUPABASE_ANON_KEY: không ai mở được phòng, phòng đã có vẫn chạy.");
}

const rooms = new Map<string, RoomHost>();

function hostFor(game: string, code: string, stored: StoredRoom | null = null): RoomHost {
  const key = `${game}-${code}`;
  let host = rooms.get(key);
  if (!host) {
    host = new RoomHost(join(DATA_DIR, `${key}.json`), stored, () => rooms.delete(key));
    rooms.set(key, host);
    host.object = new CLASSES[game](host, {});
  }
  return host;
}

// Bật lại sau khi tắt: các phòng còn hạn sống lại đúng chỗ dừng.
mkdirSync(DATA_DIR, { recursive: true });
for (const file of readdirSync(DATA_DIR)) {
  const match = file.match(/^(co-ty-phu)-([A-Z0-9]{4})\.json$/);
  if (!match) continue;
  try {
    hostFor(match[1], match[2], JSON.parse(readFileSync(join(DATA_DIR, file), "utf8")) as StoredRoom);
  } catch (error) {
    console.error("Bỏ qua file phòng hỏng", file, error);
  }
}
console.log(`Đã nạp lại ${rooms.size} phòng từ ${DATA_DIR}`);

// Mở phòng gửi kèm mã đăng nhập nên trình duyệt hỏi trước bằng OPTIONS; phải cho phép header Authorization.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
};
/** Các game có phòng, cũng là phần đầu của khóa trong `rooms`. */
const GAMES = ["co-ty-phu"];
const MAX_BODY_BYTES = 2048;

function reply(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { ...CORS, "Content-Type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

/** Đọc body JSON nhỏ. Hỏng hay quá cỡ thì trả `null`, phòng vẫn mở được với mặc định. */
function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      text += chunk;
      if (text.length > MAX_BODY_BYTES) {
        request.destroy();
        resolve(null);
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(null);
      }
    });
    request.on("error", () => resolve(null));
  });
}

/** Chỉ người có mã được nhận mới mở được phòng; khách vãng lai chỉ vào phòng. */
async function createRoom(game: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const ownerId = await verifyTownToken(bearerToken(request.headers.authorization));
  if (!ownerId) return reply(response, 401, { error: "auth" });
  const body = cleanCreateBody(await readJson(request));
  if (rooms.size >= MAX_ROOMS) return reply(response, 503, { error: "full" });
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode(SERVER_NUMBER);
    const host = hostFor(game, code);
    const hostKey = await host.run(() => host.object.create(code, { ownerId, ...body }));
    if (hostKey) return reply(response, 200, { code, hostKey });
  }
  reply(response, 503, { error: "busy" });
}

/** Danh sách phòng đang hiện của một game. */
function lobby(game: string, response: ServerResponse): void {
  const reports: RoomReport[] = [];
  for (const [key, host] of rooms) {
    if (!key.startsWith(`${game}-`)) continue;
    const report = host.object.summary?.();
    if (report) reports.push(report);
  }
  reply(response, 200, { rooms: lobbyList(reports) }, { "Cache-Control": "no-store" });
}

/** Địa chỉ mạng của máy người chơi. Có proxy đứng trước thì lấy từ x-forwarded-for. */
function ipOf(request: IncomingMessage): string | undefined {
  const forwarded = request.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first || request.socket.remoteAddress || undefined;
}

const server = createServer((request, response) => {
  const { pathname, searchParams } = new URL(request.url ?? "/", "http://room");
  if (request.method === "OPTIONS") {
    response.writeHead(204, CORS);
    return void response.end();
  }
  if (request.method === "GET" && pathname === "/health") return reply(response, 200, { rooms: rooms.size });
  if (request.method === "GET" && pathname === "/lobby") {
    const game = searchParams.get("game") ?? "";
    return GAMES.includes(game) ? lobby(game, response) : reply(response, 404, { error: "not-found" });
  }
  if (request.method === "POST" && pathname === "/co-ty-phu/rooms") return void createRoom("co-ty-phu", request, response);
  reply(response, 404, { error: "not-found" });
});

// Nén để mỗi lần cập nhật tốn ít dữ liệu di động. Không giữ bộ nhớ nén cho từng kết nối để 40 người vẫn nhẹ.
const sockets = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_MESSAGE_BYTES,
  perMessageDeflate: { threshold: 1024, serverNoContextTakeover: true, clientNoContextTakeover: true },
});

server.on("upgrade", (request, socket, head) => {
  const { pathname } = new URL(request.url ?? "/", "http://room");
  const match = pathname.match(/^\/(co-ty-phu)\/rooms\/([A-Z0-9]{4})\/ws$/);
  if (!match || (rooms.size >= MAX_ROOMS && !rooms.has(`${match[1]}-${match[2]}`))) {
    socket.destroy();
    return;
  }
  const host = hostFor(match[1], match[2]);
  sockets.handleUpgrade(request, socket, head, (ws) => host.accept(ws, ipOf(request)));
});

const aliveTimer = setInterval(() => {
  for (const host of rooms.values()) host.checkAlive();
}, ALIVE_CHECK_MS);

function shutdown(): void {
  clearInterval(aliveTimer);
  for (const host of rooms.values()) {
    host.flush();
    host.closeAll();
  }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(PORT, () => console.log(`Phòng chơi đang chạy ở cổng ${PORT}, server số ${SERVER_NUMBER}`));
