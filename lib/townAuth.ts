// Ai đang cầm mã đăng nhập này. Phòng thị trấn hỏi ở đây; server cài cách hỏi thật lúc khởi động, test cài cách giả.

/** Trả về id tài khoản, hoặc `null` nếu mã sai hay hết hạn. */
export type TownAuth = (token: string) => Promise<string | null>;

// Chưa cài thì từ chối hết, để server thiếu cấu hình không vô tình mở cửa cho ai.
let current: TownAuth = async () => null;

export function setTownAuth(auth: TownAuth): void {
  current = auth;
}

export function verifyTownToken(token: string): Promise<string | null> {
  return token ? current(token) : Promise.resolve(null);
}

/** Hỏi Supabase của app HSK mã này của ai, giống `auth.getUser` ở app HSK. Chỉ dùng khóa công khai. */
export function supabaseAuth(url: string, anonKey: string, fetcher: typeof fetch = fetch): TownAuth {
  const endpoint = `${url.replace(/\/$/, "")}/auth/v1/user`;
  return async (token) => {
    try {
      const response = await fetcher(endpoint, { headers: { apikey: anonKey, Authorization: `Bearer ${token}` } });
      if (!response.ok) return null;
      const user = (await response.json()) as { id?: unknown };
      return typeof user.id === "string" && user.id ? user.id : null;
    } catch {
      return null;
    }
  };
}

/** Chỉ cho server chạy ở máy để thử và chạy bot: mã dạng `dev:<tên>` là một tài khoản thử. */
export const devAuth: TownAuth = async (token) => (/^dev:[\w-]{1,40}$/.test(token) ? token : null);

/** Hỏi cách thứ nhất trước, không nhận thì mới hỏi cách thứ hai. Ở máy dùng để nhận cả tài khoản thử lẫn tài khoản thật. */
export function eitherAuth(first: TownAuth, second: TownAuth): TownAuth {
  return async (token) => (await first(token)) ?? second(token);
}
