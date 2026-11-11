"use client";

import { useEffect, useState } from "react";
import { lookFromSeat } from "../../ma-soi/look";
import { GROUPS, SQUARES } from "../board";

// The pictures of the lobby: the board drawn small, the faces at the seats, a few icons. All of it is drawn from the
// game's own data (the squares, the seats' characters), so the lobby shows the table people are about to sit at.

const CELL_W = 15;
const CELL_H = 7.5;
const ORIGIN_X = 170;
const ORIGIN_Y = 26;

/** A point of the 11 × 11 board, seen from the corner as the 3D table shows it. */
const at = (x: number, y: number, z = 0) => `${(ORIGIN_X + (x - y) * CELL_W).toFixed(1)},${(ORIGIN_Y + (x + y) * CELL_H - z).toFixed(1)}`;
const tile = (x: number, y: number, w = 1, d = 1, z = 0) => [at(x, y, z), at(x + w, y, z), at(x + w, y + d, z), at(x, y + d, z)].join(" ");

/** Where square `i` of the ring sits: Departure at the near corner, then clockwise as the pieces walk. */
function ring(i: number): [number, number] {
  if (i < 10) return [10 - i, 10];
  if (i < 20) return [0, 20 - i];
  if (i < 30) return [i - 20, 0];
  return [10, i - 30];
}

function squareColor(i: number): string {
  const square = SQUARES[i];
  if (square.kind === "city") return GROUPS[square.group].color;
  if (square.kind === "station") return "#3b2a20";
  if (square.kind === "utility") return "#8fb7c9";
  if (square.kind === "card") return "#f2c14e";
  if (square.kind === "tax") return "#d98f6a";
  return "#fff7e6";
}

/** The towers in the middle of the table: [x, y, footprint, height, colour]. */
const TOWERS: [number, number, number, number, string][] = [
  [2, 2, 1.6, 20, "#e8b7a8"],
  [5, 1.6, 1.4, 34, "#f0d9a8"],
  [7.4, 2.6, 1.5, 24, "#f6e9d4"],
  [1.8, 5, 1.5, 26, "#b9d4a3"],
  [4.2, 4.2, 1.8, 48, "#9cc4e4"],
  [7.2, 5.4, 1.5, 30, "#e9c46a"],
  [2.6, 7.6, 1.4, 16, "#d98f6a"],
  [5.2, 7.2, 1.6, 22, "#c9b6e4"],
  [8, 8, 1.2, 14, "#f6e9d4"],
];

/** The board as a small picture: the ring of 40 squares in their real colours, a park, a skyline, the dice. */
export function BoardArt() {
  const towers = [...TOWERS].sort((a, b) => a[0] + a[1] - (b[0] + b[1]));
  return (
    <svg className="dl-art" viewBox="0 0 340 210" role="img" aria-label="The Deedlords board: forty squares around a small city">
      <polygon points={tile(-0.25, -0.25, 11.5, 11.5, -7)} fill="#3a0a07" opacity="0.55" />
      <polygon points={tile(-0.25, -0.25, 11.5, 11.5)} fill="#5a120d" />
      <polygon points={tile(1, 1, 9, 9)} fill="#b9d98f" />
      <polygon points={tile(1.5, 4.6, 8, 0.7)} fill="#8f8a84" />
      <polygon points={tile(4.6, 1.5, 0.7, 8)} fill="#8f8a84" />
      {Array.from({ length: 40 }, (_, i) => {
        const [x, y] = ring(i);
        return <polygon key={i} points={tile(x + 0.04, y + 0.04, 0.92, 0.92)} fill={squareColor(i)} stroke="#3a0a07" strokeWidth="0.6" />;
      })}
      {towers.map(([x, y, size, height, color]) => (
        <g key={`${x}-${y}`}>
          <polygon points={[at(x, y + size), at(x + size, y + size), at(x + size, y + size, height), at(x, y + size, height)].join(" ")} fill={color} />
          <polygon points={[at(x, y + size), at(x + size, y + size), at(x + size, y + size, height), at(x, y + size, height)].join(" ")} fill="#000" opacity="0.2" />
          <polygon points={[at(x + size, y), at(x + size, y + size), at(x + size, y + size, height), at(x + size, y, height)].join(" ")} fill={color} />
          <polygon points={[at(x + size, y), at(x + size, y + size), at(x + size, y + size, height), at(x + size, y, height)].join(" ")} fill="#000" opacity="0.07" />
          <polygon points={tile(x, y, size, size, height)} fill={color} />
          <polygon points={tile(x, y, size, size, height)} fill="#fff" opacity="0.28" />
        </g>
      ))}
      {[
        [8.9, 6.4],
        [9.7, 7.6],
      ].map(([x, y]) => (
        <g key={x}>
          <polygon points={[at(x, y + 0.9), at(x + 0.9, y + 0.9), at(x + 0.9, y + 0.9, 12), at(x, y + 0.9, 12)].join(" ")} fill="#d9d2c4" />
          <polygon points={[at(x + 0.9, y), at(x + 0.9, y + 0.9), at(x + 0.9, y + 0.9, 12), at(x + 0.9, y, 12)].join(" ")} fill="#efe9dc" />
          <polygon points={tile(x, y, 0.9, 0.9, 12)} fill="#fff" />
          <circle cx={ORIGIN_X + (x - y) * CELL_W} cy={ORIGIN_Y + (x + y + 0.9) * CELL_H - 12} r="1.6" fill="#2a1208" />
        </g>
      ))}
    </svg>
  );
}

const PORTRAIT_PX = 160;
const drawn = new Map<number, Promise<string>>();

/**
 * The face of the character that will stand for each seat, drawn by the same code as the 3D table (loaded on demand,
 * with Three.js). A machine that cannot draw it gets none, and the seat shows its number instead.
 */
export function useSeatPortraits(seats: number): (string | null)[] {
  const [faces, setFaces] = useState<(string | null)[]>([]);
  useEffect(() => {
    let stale = false;
    import("../../town/chibi-draw")
      .then(({ drawPortrait }) =>
        Promise.all(
          Array.from({ length: seats }, (_, seat) => {
            let job = drawn.get(seat);
            if (!job) {
              job = drawPortrait(lookFromSeat(seat), PORTRAIT_PX);
              drawn.set(seat, job);
            }
            return job.catch(() => null);
          }),
        ),
      )
      .then((urls) => !stale && setFaces(urls))
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [seats]);
  return faces;
}

/** A colour and two letters for an account, the same every time: a face for somebody who has none yet. */
export function AccountBadge({ accountId, size = 44 }: { accountId: string; size?: number }) {
  let hash = 0;
  for (const char of accountId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  const letters = /^[0-9a-f]{64}$/.test(accountId) ? accountId.slice(0, 2).toUpperCase() : accountId.slice(0, 2).toUpperCase();
  return (
    <span className="dl-badge" style={{ width: size, height: size, background: `linear-gradient(135deg, hsl(${hue} 70% 62%), hsl(${(hue + 50) % 360} 65% 42%))`, fontSize: size * 0.36 }} aria-hidden="true">
      {letters}
    </span>
  );
}

type IconName = "evm" | "near" | "guest" | "copy" | "coins" | "clock" | "laps" | "seat" | "plane";

const ICONS: Record<IconName, string> = {
  // A cut gem: an EVM wallet, without anybody's logo.
  evm: "M12 2 4 12l8 10 8-10L12 2Zm0 3.2 4.9 6.3L12 13.6 7.1 11.5 12 5.2Zm0 10.3 4.3-1.8L12 19.1 7.7 13.7 12 15.5Z",
  near: "M5 4h3.2l7.6 10.6V4H19v16h-3.2L8.2 9.4V20H5V4Z",
  guest: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 2c-4.4 0-8 2.2-8 5v1h16v-1c0-2.8-3.6-5-8-5Z",
  copy: "M8 3h10a2 2 0 0 1 2 2v11h-2V5H8V3ZM5 7h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Zm0 2v10h10V9H5Z",
  coins: "M12 3c4.4 0 8 1.3 8 3v3c0 1.7-3.6 3-8 3s-8-1.3-8-3V6c0-1.7 3.6-3 8-3Zm-8 9.3c1.5 1.3 4.6 2 8 2s6.500-.7 8-2V15c0 1.700-3.6 3-8 3s-8-1.300-8-3v-2.700Zm0 5.700c1.5 1.3 4.6 2 8 2s6.500-.7 8-2V18c0 1.700-3.6 3-8 3s-8-1.300-8-3Z",
  clock: "M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18Zm0 2a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm-1 2h2v4.600l3.200 1.900-1 1.700L11 12.800V7Z",
  laps: "M12 4V1l4.500 4L12 9V6a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8Z",
  seat: "M7 3h7a2 2 0 0 1 2 2v7h2a2 2 0 0 1 2 2v3h-2v4h-2v-4H8v4H6v-4H5v-3a2 2 0 0 1 2-2V3Zm2 2v7h5V5H9Z",
  plane: "M21 3 3 10.500l6.500 2L12 19l2.700-4.800L19 17 21 3Zm-3.200 4.200-6.900 5.200-.6 3.100-1-3.300-2.600-.8 11.100-4.200Z",
};

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg className="dl-icon" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path d={ICONS[name]} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}
