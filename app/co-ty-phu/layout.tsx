import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { alfaSlab, beVietnam } from "@/lib/fonts";
import "./co-ty-phu.css";

export const metadata: Metadata = {
  title: "Cờ tỷ phú",
  description: "Mua đất, xây nhà, thu tiền thuê trên bàn cờ các tỉnh thành Việt Nam. Từ 2 tới 6 người, mỗi người một điện thoại.",
};

export const viewport: Viewport = {
  themeColor: "#7a1712",
  viewportFit: "cover",
};

export default function CoTyPhuLayout({ children }: { children: ReactNode }) {
  return <div className={`${alfaSlab.variable} ${beVietnam.variable}`}>{children}</div>;
}
