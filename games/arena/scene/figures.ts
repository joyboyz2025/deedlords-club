// The sixteen Arena fighters, built from faceted primitives: adult proportions with broad shoulders, big forearms and a
// small head, armour by role, colours and helmet by guild, and a weapon no other unit carries. Each is merged into a
// body and a right arm (the arm swings on an attack), plus optional glowing parts drawn unlit. A figure stands on the
// origin, about 1.7 units tall, facing +z.

import * as THREE from "three";
import { merged, painted } from "../../ma-soi/scene/parts.ts";
import { BROKER, GUARD, RUNNER, UNITS } from "../data.ts";

type Parts = THREE.BufferGeometry[];
type Look = { cloth: string; trim: string; metal: string; glow: string };

const SKIN = ["#d9a57e", "#a8714b", "#7a4c33", "#c98f68"];
const LEATHER = "#6e4a30";
const DARK = "#1f232b";
const STEEL = "#8d98a6";
const WOOD = "#6b4a30";

/** Cloth, trim, armour metal and glow per guild, in the order of `shared/arena.json`. */
const GUILD_LOOK: Look[] = [
  { cloth: "#0f6e73", trim: "#e8c15a", metal: "#5d7078", glow: "#7ff0e0" },
  { cloth: "#e4dcc6", trim: "#2f6fd0", metal: "#a9b3c0", glow: "#a8dcff" },
  { cloth: "#a3211b", trim: "#f0c04a", metal: "#3d4350", glow: "#ffd36b" },
  { cloth: "#27375a", trim: "#f5a623", metal: "#5a657c", glow: "#ffb347" },
];
/** Half the shoulder width per role: Guard, Runner, Signaller, Broker. */
const WIDE = [0.37, 0.27, 0.29, 0.31];
/** Size on the floor per role. */
export const FIGURE_SCALE = [0.88, 0.76, 0.8, 0.82];

// Every part is un-indexed so the faceted ball (an icosahedron) merges with boxes and cylinders.
const part = (geometry: THREE.BufferGeometry, color: string, x: number, y: number, z: number) => painted((geometry.index ? geometry.toNonIndexed() : geometry).translate(x, y, z), color);
const box = (w: number, h: number, d: number, color: string, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => part(new THREE.BoxGeometry(w, h, d).rotateX(rx).rotateY(ry).rotateZ(rz), color, x, y, z);
const cyl = (top: number, bottom: number, h: number, color: string, x = 0, y = 0, z = 0, rx = 0, rz = 0, sides = 7) => part(new THREE.CylinderGeometry(top, bottom, h, sides).rotateX(rx).rotateZ(rz), color, x, y, z);
const orb = (r: number, color: string, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1) => part(new THREE.IcosahedronGeometry(r, 1).scale(sx, sy, sz), color, x, y, z);
const spike = (r: number, h: number, color: string, x = 0, y = 0, z = 0, rx = 0, rz = 0) => cyl(0, r, h, color, x, y, z, rx, rz, 5);

const HEAD = 1.47;
const SHOULDER = 1.2;

/** Helmet by guild; Finch wears a hood instead. Returns lit parts and glowing parts. */
function helmet(guild: number, hooded: boolean, look: Look): { solid: Parts; glow: Parts } {
  if (hooded) return { solid: [orb(0.17, DARK, 0, HEAD + 0.03, -0.03, 1, 1.05, 1.1), spike(0.1, 0.2, DARK, 0, HEAD + 0.18, -0.1, -0.7), box(0.2, 0.07, 0.04, look.cloth, 0, HEAD - 0.06, 0.12)], glow: [] };
  if (guild === 0)
    // A kettle helm with a wide brim and a mail curtain.
    return { solid: [orb(0.16, look.metal, 0, HEAD + 0.06, 0, 1, 0.8, 1), cyl(0.2, 0.26, 0.05, look.metal, 0, HEAD + 0.03, 0, 0, 0, 9), cyl(0.17, 0.19, 0.14, look.cloth, 0, HEAD - 0.1, -0.03, 0, 0, 8), orb(0.035, look.trim, 0, HEAD + 0.2, 0)], glow: [] };
  if (guild === 1)
    // A winged helm with a visor slit.
    return {
      solid: [orb(0.165, look.metal, 0, HEAD + 0.03, 0), box(0.2, 0.035, 0.06, DARK, 0, HEAD + 0.01, 0.14), box(0.03, 0.3, 0.14, look.cloth, -0.17, HEAD + 0.17, -0.04, -0.5, 0, 0.35), box(0.03, 0.3, 0.14, look.cloth, 0.17, HEAD + 0.17, -0.04, -0.5, 0, -0.35), box(0.035, 0.1, 0.2, look.trim, 0, HEAD + 0.17, 0)],
      glow: [],
    };
  if (guild === 2)
    // A closed helm with a tall crest.
    return { solid: [cyl(0.15, 0.17, 0.3, look.metal, 0, HEAD + 0.01, 0, 0, 0, 8), box(0.05, 0.2, 0.36, look.cloth, 0, HEAD + 0.24, -0.02), box(0.24, 0.03, 0.05, look.trim, 0, HEAD + 0.09, 0.15)], glow: [box(0.16, 0.025, 0.02, look.glow, 0, HEAD + 0.02, 0.165)] };
  // A storm hood with two horns and a lit visor.
  return {
    solid: [orb(0.17, look.metal, 0, HEAD + 0.03, -0.01, 1, 1, 1.05), spike(0.04, 0.22, look.trim, -0.13, HEAD + 0.22, 0, 0, 0.35), spike(0.04, 0.22, look.trim, 0.13, HEAD + 0.22, 0, 0, -0.35)],
    glow: [box(0.18, 0.04, 0.02, look.glow, 0, HEAD + 0.02, 0.165)],
  };
}

/** The weapon in the right fist, around the fist at the origin: `+y` is up, `+z` is forward. */
function weapon(id: string, look: Look): { solid: Parts; glow: Parts } {
  const blade = (length: number, width: number, y: number) => [box(width, length, 0.03, STEEL, 0, y + length / 2, 0), spike(width / 2, width, STEEL, 0, y + length + width / 2, 0)];
  switch (id) {
    case "brann": // a flanged mace
      return { solid: [cyl(0.03, 0.035, 0.7, WOOD, 0, 0.2, 0), orb(0.13, look.metal, 0, 0.62, 0), ...[0, 1, 2, 3].map((i) => spike(0.05, 0.14, STEEL, Math.cos((i * Math.PI) / 2) * 0.15, 0.62, Math.sin((i * Math.PI) / 2) * 0.15, i % 2 ? (i === 1 ? 1.57 : -1.57) : 0, i % 2 ? 0 : i === 0 ? -1.57 : 1.57)), spike(0.05, 0.14, STEEL, 0, 0.8, 0)], glow: [] };
    case "eel": // a hooked river blade
      return { solid: [cyl(0.025, 0.025, 0.2, LEATHER, 0, 0, 0), box(0.14, 0.03, 0.05, look.trim, 0, 0.11, 0), part(new THREE.TorusGeometry(0.26, 0.035, 4, 10, Math.PI * 0.9).rotateZ(Math.PI * 0.55), STEEL, 0.22, 0.2, 0)], glow: [] };
    case "ysolde": // a barbed harpoon
      return { solid: [cyl(0.022, 0.022, 1.5, WOOD, 0, 0.35, 0), spike(0.07, 0.28, STEEL, 0, 1.24, 0), spike(0.04, 0.16, STEEL, -0.07, 1.04, 0, 0, -2.6), spike(0.04, 0.16, STEEL, 0.07, 1.04, 0, 0, 2.6), part(new THREE.TorusGeometry(0.08, 0.02, 4, 8), look.trim, 0, -0.3, 0)], glow: [] };
    case "odo": // a tide staff with a lantern
      return { solid: [cyl(0.03, 0.035, 1.5, WOOD, 0, 0.3, 0), cyl(0.1, 0.07, 0.05, look.trim, 0, 0.98, 0), cyl(0.07, 0.1, 0.05, look.trim, 0, 1.22, 0), spike(0.05, 0.12, look.trim, 0, 1.31, 0)], glow: [orb(0.09, look.glow, 0, 1.1, 0)] };
    case "tamsin": // a broadsword
      return { solid: [cyl(0.028, 0.028, 0.2, LEATHER, 0, 0, 0), orb(0.045, look.trim, 0, -0.13, 0), box(0.3, 0.045, 0.06, look.trim, 0, 0.12, 0), ...blade(0.78, 0.12, 0.14)], glow: [] };
    case "pip": // a long glaive
      return { solid: [cyl(0.022, 0.022, 1.0, WOOD, 0, 0.2, 0), box(0.16, 0.5, 0.03, STEEL, 0.05, 0.92, 0, 0, 0, -0.12), spike(0.06, 0.16, STEEL, 0.08, 1.24, 0, 0, -0.12), box(0.1, 0.05, 0.05, look.trim, 0, 0.68, 0)], glow: [] };
    case "ko": // a hand cannon
      return { solid: [box(0.07, 0.16, 0.08, WOOD, 0, -0.04, 0), cyl(0.085, 0.1, 0.52, look.metal, 0, 0.07, 0.24, Math.PI / 2, 0, 8), cyl(0.11, 0.11, 0.06, look.trim, 0, 0.07, 0.48, Math.PI / 2, 0, 8), cyl(0.1, 0.1, 0.05, look.trim, 0, 0.07, 0.1, Math.PI / 2, 0, 8)], glow: [cyl(0.06, 0.06, 0.03, "#ff7a3d", 0, 0.07, 0.52, Math.PI / 2, 0, 8)] };
    case "bel": // a war standard
      return { solid: [cyl(0.025, 0.03, 1.7, WOOD, 0, 0.4, 0), spike(0.06, 0.18, look.trim, 0, 1.34, 0), box(0.46, 0.5, 0.02, look.trim, 0.25, 0.96, 0), box(0.38, 0.4, 0.03, look.cloth, 0.25, 0.97, 0), spike(0.08, 0.16, look.trim, 0.25, 0.63, 0, Math.PI)], glow: [] };
    case "grigg": // a halberd
      return { solid: [cyl(0.027, 0.03, 1.7, WOOD, 0, 0.4, 0), box(0.3, 0.34, 0.03, STEEL, 0.14, 1.06, 0), spike(0.1, 0.22, STEEL, 0.34, 1.06, 0, 0, -1.57), spike(0.05, 0.3, STEEL, 0, 1.4, 0), spike(0.06, 0.16, STEEL, -0.1, 1.06, 0, 0, 1.57)], glow: [] };
    case "finch": // a long dagger
      return { solid: [cyl(0.024, 0.024, 0.16, LEATHER, 0, 0, 0), box(0.16, 0.03, 0.05, look.trim, 0, 0.09, 0), ...blade(0.42, 0.07, 0.1)], glow: [] };
    case "mirela": // a crossbow
      return { solid: [box(0.07, 0.09, 0.6, WOOD, 0, 0.05, 0.2), part(new THREE.TorusGeometry(0.3, 0.025, 4, 10, Math.PI * 0.7).rotateZ(Math.PI * 0.15).rotateX(Math.PI / 2), STEEL, 0, 0.1, 0.22), cyl(0.012, 0.012, 0.5, STEEL, 0, 0.11, 0.3, Math.PI / 2), spike(0.03, 0.1, look.trim, 0, 0.11, 0.6, Math.PI / 2)], glow: [] };
    case "vane": // a sceptre hung with scales
      return { solid: [cyl(0.026, 0.03, 1.2, look.metal, 0, 0.3, 0), box(0.5, 0.03, 0.03, look.trim, 0, 0.9, 0), cyl(0.1, 0.06, 0.04, look.trim, -0.24, 0.72, 0, 0, 0, 8), cyl(0.1, 0.06, 0.04, look.trim, 0.24, 0.72, 0, 0, 0, 8), cyl(0.006, 0.006, 0.18, look.trim, -0.24, 0.81, 0), cyl(0.006, 0.006, 0.18, look.trim, 0.24, 0.81, 0)], glow: [orb(0.07, look.glow, 0, 1.0, 0)] };
    case "hask": // a great hammer with a lit core
      return { solid: [cyl(0.04, 0.045, 1.3, WOOD, 0, 0.3, 0), box(0.52, 0.3, 0.3, look.metal, 0, 0.96, 0), box(0.08, 0.34, 0.34, look.trim, -0.2, 0.96, 0), box(0.08, 0.34, 0.34, look.trim, 0.2, 0.96, 0), spike(0.07, 0.16, STEEL, 0, 1.19, 0)], glow: [box(0.16, 0.16, 0.32, look.glow, 0, 0.96, 0)] };
    case "jory": // a storm fork
      return { solid: [cyl(0.024, 0.026, 1.4, look.metal, 0, 0.3, 0), box(0.3, 0.035, 0.035, STEEL, 0, 0.98, 0), spike(0.03, 0.3, STEEL, -0.14, 1.14, 0), spike(0.03, 0.3, STEEL, 0.14, 1.14, 0), cyl(0.04, 0.04, 0.2, look.trim, 0, 0.6, 0)], glow: [orb(0.07, "#fff27a", 0, 1.12, 0), spike(0.03, 0.26, "#fff27a", 0, 1.3, 0)] };
    case "sena": // an arc lance
      return { solid: [cyl(0.05, 0.06, 0.6, look.metal, 0, 0.06, 0.22, Math.PI / 2, 0, 8), box(0.07, 0.16, 0.08, DARK, 0, -0.04, 0), cyl(0.08, 0.08, 0.06, look.trim, 0, 0.06, 0.0, Math.PI / 2, 0, 8), cyl(0.03, 0.05, 0.2, STEEL, 0, 0.06, 0.6, Math.PI / 2)], glow: [orb(0.065, "#8fe3ff", 0, 0.06, 0.73)] };
    default: // opal: a coil staff
      return { solid: [cyl(0.026, 0.03, 1.3, WOOD, 0, 0.3, 0), ...[0, 1, 2].map((i) => part(new THREE.TorusGeometry(0.08, 0.018, 4, 8).rotateX(Math.PI / 2), look.trim, 0, 0.74 + i * 0.07, 0)), box(0.12, 0.14, 0.08, look.metal, 0.06, 0.4, 0.05)], glow: [orb(0.1, look.glow, 0, 1.06, 0)] };
  }
}

export type FigureGeometry = {
  body: THREE.BufferGeometry;
  arm: THREE.BufferGeometry;
  /** Unlit parts of the body and of the arm, when the unit has any. */
  bodyGlow: THREE.BufferGeometry | null;
  armGlow: THREE.BufferGeometry | null;
  /** Where the arm hangs from. */
  shoulder: THREE.Vector3;
  height: number;
};

export function figureGeometry(index: number): FigureGeometry {
  const def = UNITS[index];
  const look = GUILD_LOOK[def.guild];
  const wide = WIDE[def.role];
  const skin = SKIN[index % SKIN.length];
  const armour = def.role === GUARD ? look.metal : def.role === RUNNER ? LEATHER : look.cloth;
  const head = helmet(def.guild, def.id === "finch", look);
  const body: Parts = [];
  const glow: Parts = [...head.glow];

  for (const side of [-1, 1]) {
    body.push(
      box(0.2, 0.16, 0.34, DARK, side * 0.15, 0.08, 0.04),
      cyl(0.09, 0.11, 0.32, def.role === GUARD ? look.metal : LEATHER, side * 0.15, 0.31, 0),
      orb(0.085, look.metal, side * 0.15, 0.48, 0.07, 1, 1, 0.7),
      cyl(0.12, 0.1, 0.28, DARK, side * 0.15, 0.61, 0),
    );
  }
  body.push(
    cyl(0.25, 0.24, 0.13, LEATHER, 0, 0.8, 0, 0, 0, 8),
    box(0.1, 0.1, 0.04, look.trim, 0, 0.8, 0.23),
    // The tabard: guild cloth to the knees, front and back, with a trimmed hem.
    box(0.24, 0.42, 0.03, look.cloth, 0, 0.55, 0.2, -0.06),
    box(0.24, 0.05, 0.035, look.trim, 0, 0.36, 0.215),
    box(0.26, 0.4, 0.03, look.cloth, 0, 0.56, -0.19, 0.06),
    // A chest that widens to the shoulders, a collar, the head.
    cyl(wide, 0.23, 0.44, armour, 0, 1.07, 0, 0, 0, 8),
    box(wide * 1.3, 0.2, 0.06, def.role === GUARD ? STEEL : def.role === RUNNER ? look.cloth : LEATHER, 0, 1.12, wide * 0.72, -0.12),
    box(0.13, 0.13, 0.03, look.trim, 0, 1.12, wide * 0.72 + 0.04, -0.12, 0, Math.PI / 4),
    cyl(0.1, 0.13, 0.08, armour, 0, 1.32, 0),
    orb(0.135, skin, 0, HEAD, 0),
    ...head.solid,
    // The left arm hangs at the side: upper arm, a heavy bracer, a fist.
    cyl(0.09, 0.085, 0.26, armour, -wide - 0.05, 1.06, 0, 0, -0.12),
    cyl(0.115, 0.1, 0.26, def.role === RUNNER ? LEATHER : look.metal, -wide - 0.09, 0.82, 0.03),
    orb(0.1, skin, -wide - 0.09, 0.66, 0.04),
  );

  if (def.role === GUARD) {
    for (const side of [-1, 1]) body.push(orb(0.21, look.metal, side * (wide + 0.04), SHOULDER + 0.05, 0, 1.1, 0.75, 1.1), cyl(0.2, 0.22, 0.04, look.trim, side * (wide + 0.04), SHOULDER - 0.02, 0, 0, 0, 8), spike(0.05, 0.16, STEEL, side * (wide + 0.1), SHOULDER + 0.22, 0, 0, -side * 0.5));
    // A tall shield on the left arm, and a short cape.
    body.push(box(0.44, 0.7, 0.05, look.metal, -wide - 0.12, 0.84, 0.2, 0, 0.25), box(0.34, 0.58, 0.06, look.cloth, -wide - 0.12, 0.84, 0.215, 0, 0.25), box(0.1, 0.36, 0.07, look.trim, -wide - 0.12, 0.84, 0.23, 0, 0.25), box(0.3, 0.1, 0.07, look.trim, -wide - 0.12, 0.9, 0.23, 0, 0.25), box(wide * 1.7, 0.6, 0.03, look.cloth, 0, 0.94, -0.26, 0.16));
  } else if (def.role === RUNNER) {
    // One light pauldron, a scarf that trails, a strap of knives.
    body.push(orb(0.14, look.metal, -wide - 0.03, SHOULDER + 0.04, 0, 1, 0.7, 1), cyl(0.16, 0.18, 0.1, look.cloth, 0, 1.33, 0, 0, 0, 8), box(0.12, 0.5, 0.025, look.cloth, 0.08, 1.06, -0.24, 0.5), box(0.06, 0.5, 0.03, LEATHER, 0, 1.06, wide * 0.72 + 0.02, -0.12, 0, 0.7));
  } else if (def.role === BROKER) {
    // A mantle over the shoulders, a long robe, a full cape.
    body.push(cyl(wide + 0.09, wide + 0.02, 0.14, look.trim, 0, SHOULDER + 0.02, 0, 0, 0, 8), cyl(0.25, 0.36, 0.5, look.cloth, 0, 0.5, 0, 0, 0, 8), cyl(0.36, 0.37, 0.05, look.trim, 0, 0.27, 0, 0, 0, 8), box(wide * 1.9, 0.95, 0.03, look.cloth, 0, 0.78, -0.3, 0.14), box(0.14, 0.18, 0.1, LEATHER, wide - 0.02, 0.76, 0.2));
  } else {
    // Signaller: leather pauldrons, a pack and a quiver.
    for (const side of [-1, 1]) body.push(orb(0.15, LEATHER, side * (wide + 0.03), SHOULDER + 0.03, 0, 1, 0.7, 1));
    body.push(box(0.34, 0.36, 0.16, LEATHER, 0, 1.06, -0.27), box(0.36, 0.06, 0.18, look.trim, 0, 1.2, -0.27), cyl(0.07, 0.06, 0.46, look.cloth, 0.2, 1.12, -0.3, 0.2, -0.3), cyl(0.012, 0.012, 0.2, STEEL, 0.25, 1.4, -0.34, 0.2, -0.3));
  }

  // The right arm is modelled around the shoulder: the upper arm hangs, the forearm reaches forward, the fist is at `FIST`.
  const fist = new THREE.Vector3(0.04, -0.3, 0.3);
  const held = weapon(def.id, look);
  const at = (parts: Parts) => parts.map((g) => g.translate(fist.x, fist.y, fist.z));
  const arm: Parts = [cyl(0.09, 0.085, 0.3, armour, 0.02, -0.14, 0.02), cyl(0.1, 0.115, 0.28, def.role === RUNNER ? LEATHER : look.metal, 0.04, -0.3, 0.14, Math.PI / 2), orb(0.1, skin, fist.x, fist.y, fist.z), ...at(held.solid)];
  const armGlow = at(held.glow);
  return {
    body: merged(body),
    arm: merged(arm),
    bodyGlow: glow.length ? merged(glow) : null,
    armGlow: armGlow.length ? merged(armGlow) : null,
    shoulder: new THREE.Vector3(wide + 0.05, SHOULDER, 0),
    height: HEAD + 0.5,
  };
}
