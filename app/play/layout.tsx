import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { alfaSlab, beVietnam } from "@/lib/fonts";
import "../co-ty-phu/co-ty-phu.css";
import "./play.css";

export const metadata: Metadata = {
  title: "Deedlords",
  description: "A property game whose rules, dice and stakes live in a NEAR contract. Buy capitals, collect rent, win the pot.",
};

export const viewport: Viewport = {
  themeColor: "#7a1712",
  viewportFit: "cover",
};

export default function PlayLayout({ children }: { children: ReactNode }) {
  return <div className={`${alfaSlab.variable} ${beVietnam.variable}`}>{children}</div>;
}
