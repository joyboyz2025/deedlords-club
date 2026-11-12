import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { alfaSlab, beVietnam } from "@/lib/fonts";
import "../landing.css";
import "./trailer.css";

// The Arena's gate is closed: `/arena` is its trailer, drawn in the hall's world. `arena.css` belongs to the game's
// own screen (games/arena/components/ArenaScreen.tsx), which no route shows for now.

export const metadata: Metadata = {
  title: "Deedlords Arena: the trailer",
  description: "A duel of sealed bids: hire a crew from four guilds, place it, and watch a fight with no dice in it. The trailer; the gate is not open yet.",
};

export const viewport: Viewport = { themeColor: "#5d100a", viewportFit: "cover" };

export default function ArenaLayout({ children }: { children: ReactNode }) {
  return <div className={`${alfaSlab.variable} ${beVietnam.variable}`}>{children}</div>;
}
