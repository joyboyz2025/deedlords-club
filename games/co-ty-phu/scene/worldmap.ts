// The middle of the board as a map of the world: the cities of the squares are real places, so each one is pinned
// where it is, in its owner's colour, and a roll from one city to another is drawn as a flight. Under the dice tray a
// bar shares out the table's net worth between the seats. Pure canvas drawing, no Three.js: the land is painted once
// into the board's own picture (`drawLand`), the rest on a layer above it that is drawn again when the game changes
// (`drawWorld`). Coordinates are those of the board's middle, in board units, centred, text level (see textures.ts).

import { SQUARES } from "../board";

/**
 * Land on a grid of 76 by 22 cells, from 165°W eastwards all the way round, and from 66°N to 44°S: `#` where at least
 * two of five points of the cell are land in Natural Earth's 1:110m land (public domain), computed once with d3-geo.
 */
const LAND = [
  "#####################...##....##....#####################################...",
  ".##..##########...####..............###.###########################.##......",
  "........###############..........##.#############################...#.......",
  "........#############.#...........##############################............",
  "........############.............########..##.#################.............",
  ".........##########..............##....#######################..#...........",
  "..........########...............#####....##################..##............",
  "...........#####.#..............#############################...............",
  "............##.................################..###########................",
  ".............###...............############.###...###..##...................",
  "................#..............##############.....##...###..................",
  ".................#####..........##############.....#.........#..............",
  "..................######............#########..........##..#................",
  "..................########...........#######............#.###...............",
  "..................##########.........######...............#.#...##..........",
  "..................#########..........#######................................",
  "...................########..........######.##...............#####..........",
  "....................######............####..#..............#######..........",
  "....................#####.............####.................########.........",
  "....................####..............###..................########.........",
  "...................####.........................................###.........",
  "...................###...........................................#.....#....",
];
const LON0 = -165;
const LAT0 = 66;
const LAT1 = -44;

/** Where the map lies in the middle of the board: above the dice tray and the two decks. */
export const MAP_BOX = { x0: -7.2, x1: 7.2, y0: -7.35, y1: -3.25 };
/** Where the bar of net worth lies: below them. */
const SHARE_BOX = { x0: -6.7, x1: 6.7, title: 4.2, bar: 4.55, height: 1.0, notes: 6.2 };

/** The place of every square that is one: the cities, and the four sea passages. */
const GEO: Record<string, [number, number]> = {
  "São Paulo": [-46.63, -23.55],
  "Cape Town": [18.42, -33.92],
  Mumbai: [72.88, 19.08],
  Melbourne: [144.96, -37.81],
  Lisbon: [-9.14, 38.72],
  Madrid: [-3.7, 40.42],
  Berlin: [13.4, 52.52],
  Miami: [-80.19, 25.76],
  Milan: [9.19, 45.46],
  Shanghai: [121.47, 31.23],
  Sydney: [151.21, -33.87],
  Vienna: [16.37, 48.21],
  Paris: [2.35, 48.86],
  Tokyo: [139.69, 35.68],
  "Los Angeles": [-118.24, 34.05],
  Dubai: [55.27, 25.2],
  "New York": [-74.01, 40.71],
  London: [-0.13, 51.51],
  Geneva: [6.14, 46.2],
  Singapore: [103.82, 1.35],
  "Hong Kong": [114.17, 22.32],
  Monaco: [7.42, 43.74],
  "Panama Canal": [-79.68, 9.08],
  "Suez Canal": [32.55, 30.0],
  Bosphorus: [29.07, 41.12],
  "Strait of Malacca": [101.5, 2.5],
};

/** A longitude and latitude on the map, in board units. */
export function mapPoint(lon: number, lat: number): { x: number; y: number } {
  const east = lon < LON0 ? lon + 360 : lon;
  return {
    x: MAP_BOX.x0 + ((east - LON0) / 360) * (MAP_BOX.x1 - MAP_BOX.x0),
    y: MAP_BOX.y0 + ((LAT0 - lat) / (LAT0 - LAT1)) * (MAP_BOX.y1 - MAP_BOX.y0),
  };
}

/** Pins closer than this are pushed apart, so that Europe's nine cities are each one pin, not a heap. */
const PIN_GAP = 0.4;

/**
 * Where each square's pin stands: its true place, nudged until no two pins overlap (a few passes of pushing pairs
 * apart, each pin pulled a little back towards its place). Worked out once; the same everywhere.
 */
export const PINS: Map<number, { x: number; y: number }> = (() => {
  const pins = new Map<number, { x: number; y: number; home: { x: number; y: number } }>();
  SQUARES.forEach((square, index) => {
    const geo = GEO[square.name];
    if (!geo) return;
    const home = mapPoint(geo[0], geo[1]);
    pins.set(index, { ...home, home });
  });
  const all = [...pins.values()];
  for (let pass = 0; pass < 120; pass++) {
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++) {
        const [a, b] = [all[i], all[j]];
        const [dx, dy] = [b.x - a.x, b.y - a.y];
        const d = Math.hypot(dx, dy) || 0.001;
        if (d >= PIN_GAP) continue;
        const push = (PIN_GAP - d) / 2;
        const [ux, uy] = d > 0.001 ? [dx / d, dy / d] : [1, 0];
        a.x -= ux * push;
        a.y -= uy * push;
        b.x += ux * push;
        b.y += uy * push;
      }
    for (const pin of all) {
      pin.x += (pin.home.x - pin.x) * 0.04;
      pin.y += (pin.home.y - pin.y) * 0.04;
    }
  }
  return new Map([...pins].map(([index, pin]) => [index, { x: pin.x, y: pin.y }]));
})();

/** The land, as dots, in `color`: painted once into the board's picture. `u`: pixels per board unit. */
export function drawLand(ctx: CanvasRenderingContext2D, u: number, color: string): void {
  const cols = LAND[0].length;
  const [w, h] = [(MAP_BOX.x1 - MAP_BOX.x0) / cols, (MAP_BOX.y1 - MAP_BOX.y0) / LAND.length];
  ctx.fillStyle = color;
  for (let row = 0; row < LAND.length; row++)
    for (let col = 0; col < cols; col++) {
      if (LAND[row][col] !== "#") continue;
      ctx.beginPath();
      ctx.arc((MAP_BOX.x0 + (col + 0.5) * w) * u, (MAP_BOX.y0 + (row + 0.5) * h) * u, 0.068 * u, 0, Math.PI * 2);
      ctx.fill();
    }
}

/** What the layer above the land shows. */
export type WorldState = {
  /** Every owned square with a place: in whose colour, and whether it is mortgaged. */
  owned: { square: number; color: string; mortgaged: boolean }[];
  /** The last roll that went from one place to another, in the colour of whoever made it. */
  flight: { from: number; to: number; color: string } | null;
  /** Each seat still in the game, in seating order: its name, net worth, colour, cities, and a word on it. */
  share: { name: string; worth: number; color: string; note: string }[];
};

/** A key that changes exactly when the drawing would. */
export const worldKey = (state: WorldState): string => JSON.stringify(state);

const INK = "#24352d";
const MUTED = "#7f948a";
const FREE_PIN = "#9fb2a8";
const HALO = "#e7efe9";

function label(ctx: CanvasRenderingContext2D, u: number, text: string, x: number, y: number, align: CanvasTextAlign, font: string): void {
  ctx.font = `800 ${0.3 * u}px ${font}`;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.strokeStyle = HALO;
  ctx.lineWidth = 0.12 * u;
  ctx.strokeText(text, x * u, y * u);
  ctx.fillStyle = INK;
  ctx.fillText(text, x * u, y * u);
}

/** Fits `text` into `width` pixels at `size`, shrinking it, and shortening it with an ellipsis below 70%. */
function fit(ctx: CanvasRenderingContext2D, text: string, width: number, size: number, weight: string, font: string): string {
  ctx.font = `${weight} ${size}px ${font}`;
  let shown = text;
  const full = ctx.measureText(shown).width;
  if (full <= width) return shown;
  const smaller = Math.max(size * 0.7, (size * width) / full);
  ctx.font = `${weight} ${smaller}px ${font}`;
  while (shown.length > 1 && ctx.measureText(shown).width > width) shown = `${shown.slice(0, -2)}…`;
  return shown;
}

/** The pins, the last flight and the bar of net worth. `u`: pixels per board unit; the origin is the board's middle. */
export function drawWorld(ctx: CanvasRenderingContext2D, u: number, state: WorldState, font: string): void {
  const owned = new Map(state.owned.map((one) => [one.square, one]));
  // Places nobody owns yet: a small grey dot.
  for (const [square, pin] of PINS) {
    if (owned.has(square)) continue;
    ctx.fillStyle = FREE_PIN;
    ctx.beginPath();
    ctx.arc(pin.x * u, pin.y * u, 0.08 * u, 0, Math.PI * 2);
    ctx.fill();
  }
  // The last flight, under the pins it joins.
  const flight = state.flight && PINS.has(state.flight.from) && PINS.has(state.flight.to) ? state.flight : null;
  if (flight) {
    const [a, b] = [PINS.get(flight.from)!, PINS.get(flight.to)!];
    const lift = Math.min(1.6, 0.18 + Math.hypot(b.x - a.x, b.y - a.y) * 0.28);
    const control = { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - lift };
    ctx.save();
    ctx.strokeStyle = flight.color;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 0.055 * u;
    ctx.lineCap = "round";
    ctx.setLineDash([0.02 * u, 0.13 * u]);
    ctx.beginPath();
    ctx.moveTo(a.x * u, a.y * u);
    ctx.quadraticCurveTo(control.x * u, control.y * u, b.x * u, b.y * u);
    ctx.stroke();
    ctx.restore();
  }
  for (const [square, one] of owned) {
    const pin = PINS.get(square);
    if (!pin) continue;
    ctx.fillStyle = one.color;
    ctx.globalAlpha = 0.28;
    ctx.beginPath();
    ctx.arc(pin.x * u, pin.y * u, 0.25 * u, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(pin.x * u, pin.y * u, 0.15 * u, 0, Math.PI * 2);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 0.05 * u;
    // A mortgaged city is a ring: still theirs, earning nothing.
    if (one.mortgaged) {
      ctx.stroke();
      ctx.strokeStyle = one.color;
      ctx.lineWidth = 0.04 * u;
      ctx.stroke();
    } else {
      ctx.fill();
      ctx.stroke();
    }
  }
  if (flight) {
    const [a, b] = [PINS.get(flight.from)!, PINS.get(flight.to)!];
    ctx.strokeStyle = flight.color;
    ctx.lineWidth = 0.06 * u;
    ctx.beginPath();
    ctx.arc(b.x * u, b.y * u, 0.32 * u, 0, Math.PI * 2);
    ctx.stroke();
    // Each end named, on the side away from the other end.
    const leftward = b.x < a.x;
    label(ctx, u, SQUARES[flight.from].name, a.x + (leftward ? 0.26 : -0.26), a.y + 0.02, leftward ? "left" : "right", font);
    label(ctx, u, SQUARES[flight.to].name, b.x + (leftward ? -0.36 : 0.36), b.y - 0.02, leftward ? "right" : "left", font);
  }

  // Who owns the world: the net worth of each seat as a share of the table's.
  const seats = state.share.filter((seat) => seat.worth > 0);
  if (seats.length === 0) return;
  const { x0, x1, title, bar, height, notes } = SHARE_BOX;
  ctx.textBaseline = "middle";
  ctx.font = `800 ${0.27 * u}px ${font}`;
  ctx.fillStyle = MUTED;
  ctx.textAlign = "left";
  ctx.fillText("WHO OWNS THE WORLD", x0 * u, title * u);
  ctx.font = `600 ${0.26 * u}px ${font}`;
  ctx.textAlign = "right";
  ctx.fillText("net worth", x1 * u, title * u);
  const total = seats.reduce((sum, seat) => sum + seat.worth, 0);
  const gap = 0.07;
  const room = x1 - x0 - gap * (seats.length - 1);
  // Nobody's part is drawn thinner than this, so that a seat far behind can still be read.
  const floor = 0.12;
  const parts = seats.map((seat) => Math.max(floor, seat.worth / total));
  const scale = 1 / parts.reduce((sum, part) => sum + part, 0);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x0 * u, bar * u, (x1 - x0) * u, height * u, 0.3 * u);
  ctx.clip();
  let x = x0;
  seats.forEach((seat, i) => {
    const width = room * parts[i] * scale;
    ctx.fillStyle = seat.color;
    ctx.fillRect(x * u, bar * u, width * u, height * u);
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "left";
    const text = fit(ctx, `${seat.name} ${seat.worth.toLocaleString("en-US")}`, (width - 0.4) * u, 0.36 * u, "800", font);
    ctx.fillText(text, (x + 0.2) * u, (bar + height / 2) * u);
    // What the seat holds, under its part of the bar.
    ctx.restore();
    ctx.fillStyle = INK;
    ctx.textAlign = "left";
    ctx.fillText(fit(ctx, seat.note, (width - 0.05) * u, 0.26 * u, "700", font), (x + 0.05) * u, notes * u);
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x0 * u, bar * u, (x1 - x0) * u, height * u, 0.3 * u);
    ctx.clip();
    x += width + gap;
  });
  ctx.restore();
}
