import { bearerToken, cleanCreateBody, type CreateOptions } from "../lib/roomAccess.ts";
import { randomCode } from "../lib/roomCode.ts";
import { devAuth, supabaseAuth } from "../lib/townAuth.ts";
import type { TycoonRoom } from "./co-ty-phu-room.ts";

export { TycoonRoom } from "./co-ty-phu-room.ts";

type Env = {
  TYCOON: DurableObjectNamespace<TycoonRoom>;
  /** Server này là server số mấy: "1" hoặc "2". */
  SERVER_NUMBER: string;
  /** Optional: a Supabase project (public anon key only) that says who is opening a room. Not configured in this repo. */
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  /** "1" only for local `wrangler dev` (`npm run dev:room`): accept local test identities `dev:<name>`, like the Node server's TOWN_DEV_AUTH=1. */
  TOWN_DEV_AUTH?: string;
};

// Mở phòng gửi kèm mã đăng nhập nên trình duyệt hỏi trước bằng OPTIONS; phải cho phép header Authorization.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

/** Ai đang mở phòng: tài khoản thử `dev:` khi bật TOWN_DEV_AUTH, rồi tới Supabase nếu có cấu hình. Không cách nào nhận thì `null`. */
async function ownerOf(token: string, env: Env): Promise<string | null> {
  if (!token) return null;
  const dev = env.TOWN_DEV_AUTH === "1" ? await devAuth(token) : null;
  if (dev) return dev;
  return env.SUPABASE_URL && env.SUPABASE_ANON_KEY ? supabaseAuth(env.SUPABASE_URL, env.SUPABASE_ANON_KEY)(token) : null;
}

/** Chỉ người có mã được nhận mới mở được phòng, giống server Node. Không cấu hình cách nhận nào thì không ai mở được. */
async function createRoom(request: Request, env: Env, create: (code: string, options: CreateOptions) => Promise<string | null>): Promise<Response> {
  const ownerId = await ownerOf(bearerToken(request.headers.get("Authorization")), env);
  if (!ownerId) return Response.json({ error: "auth" }, { status: 401, headers: CORS });
  const body = cleanCreateBody(await request.json().catch(() => null));
  const server = Number(env.SERVER_NUMBER);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode(server);
    const hostKey = await create(code, { ownerId, ...body });
    if (hostKey) return Response.json({ code, hostKey }, { headers: CORS });
  }
  return new Response("Không tạo được phòng, thử lại sau", { status: 503, headers: CORS });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (request.method === "POST" && url.pathname === "/co-ty-phu/rooms") {
      return createRoom(request, env, (code, options) => env.TYCOON.getByName(code).create(code, options));
    }

    if (request.headers.get("Upgrade") === "websocket") {
      const tyPhu = url.pathname.match(/^\/co-ty-phu\/rooms\/([A-Z0-9]{4})\/ws$/);
      if (tyPhu) return env.TYCOON.getByName(tyPhu[1]).fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
