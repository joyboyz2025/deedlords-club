import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { alfaSlab, beVietnam } from "@/lib/fonts";
import "../co-ty-phu/co-ty-phu.css";
import "./play.css";
import "./desk.css";
import "./pregame.css";
import "./chibi.css";

export const metadata: Metadata = {
  title: "Deedlords",
  description: "A property game whose rules, dice and stakes live in a NEAR contract. Buy the world's priciest cities, collect rent, win the pot.",
};

export const viewport: Viewport = {
  themeColor: "#5d100a",
  viewportFit: "cover",
};

export default function PlayLayout({ children }: { children: ReactNode }) {
  return <div className={`${alfaSlab.variable} ${beVietnam.variable}`}>{children}</div>;
}
