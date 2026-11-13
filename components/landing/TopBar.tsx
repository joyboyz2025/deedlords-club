import { HallBar } from "@/components/hall/HallBar";

export type HallGame = "board" | "poker" | "arena";

/**
 * The top row of the hall's own pages (the landing and the Arena's trailer): the club's one bar, on a ground that has
 * no side padding of its own.
 */
export function TopBar({ current }: { current?: HallGame }) {
  return <HallBar current={current === "board" ? "play" : (current ?? "home")} padded />;
}
