import type { Viewport } from "next";
import type { ReactNode } from "react";
import { alfaSlab, beVietnam } from "@/lib/fonts";
import "./poker.css";

export const viewport: Viewport = { themeColor: "#5d100a", viewportFit: "cover" };

export default function PokerLayout({ children }: { children: ReactNode }) {
  return <div className={`${alfaSlab.variable} ${beVietnam.variable}`}>{children}</div>;
}
