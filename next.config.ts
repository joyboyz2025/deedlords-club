import type { NextConfig } from "next";

// Thiếu biến này thì trang vẫn build được nhưng không tạo được phòng, nên chặn ngay từ lúc deploy.
if (process.env.VERCEL && !process.env.NEXT_PUBLIC_ROOM_URL) {
  throw new Error("Thiếu NEXT_PUBLIC_ROOM_URL: đặt bằng địa chỉ Worker sau khi chạy npm run deploy:room");
}

const config: NextConfig = {
  // Cho phép mở bản dev từ điện thoại trong cùng wifi.
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*", "172.16.*.*"],
  // File vẽ nhân vật cho app HSK ở domain khác (study.ttech.website), tải bằng import(). Chỉ có code công khai.
  async headers() {
    return [{ source: "/town/chibi-v1.js", headers: [{ key: "Access-Control-Allow-Origin", value: "*" }] }];
  },
  // Standalone deedlords: the town (/thi-tran), quick-play hub (/choi-nhanh) and login page (/dang-nhap) are gone.
  // The copied property-game UI still links to them, so send those links to the game's lobby instead of a 404.
  async redirects() {
    return ["/thi-tran", "/choi-nhanh", "/dang-nhap"].map((source) => ({ source, destination: "/co-ty-phu", permanent: false }));
  },
};

export default config;
