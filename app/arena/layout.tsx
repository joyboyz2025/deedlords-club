import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { alfaSlab, beVietnam } from "@/lib/fonts";
import "./arena.css";

export const metadata: Metadata = {
  title: "Deedlords Arena",
  description: "A duel of sealed bids: hire a crew from four guilds, place it, and let the contract fight it out.",
};

export const viewport: Viewport = { themeColor: "#12333a", viewportFit: "cover" };

export default function ArenaLayout({ children }: { children: ReactNode }) {
  return <div className={`${alfaSlab.variable} ${beVietnam.variable}`}>{children}</div>;
}
