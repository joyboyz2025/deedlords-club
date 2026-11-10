import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Trò chơi nhóm",
  description: "Mở phòng, mời mọi người quét mã là chơi cùng nhau trên điện thoại.",
};

export const viewport: Viewport = {
  themeColor: "#14101f",
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
