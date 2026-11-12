// The Arena in 3D: a stone duelling ground of hexes, seven wide and three deep for each side, the units standing on
// it, and a fight played back from the engine's events. The scene decides nothing: it shows floors it is given and
// events the engine produced, and reports which of your cells was tapped.

import * as THREE from "three";
import { clone as cloneWithSkeleton } from "three/addons/utils/SkeletonUtils.js";
import { merged, painted } from "../../ma-soi/scene/parts.ts";
import { GUILDS, UNITS } from "../data.ts";
import { CELLS, COLS, ROWS, hexOf, startingHealth, type Fielded, type FightEvent, type Hex } from "../engine.ts";
import { Effects, type Body } from "./effects.ts";
import { FIGURE_SCALE, figureGeometry, type FigureGeometry } from "./figures.ts";
import { disposeModel, laidOut, loadModel, manifest, standing } from "./models.ts";

const SKY = "#3b4368";
/** Centre to corner of a hex. Hexes are pointy-top: a row is offset by half a hex from the next. */
const HEX_R = 0.75;
const HEX_W = Math.sqrt(3) * HEX_R;
const HEX_H = 1.5 * HEX_R;
const BOARD_W = (COLS + 1.2) * HEX_W;
const BOARD_D = ROWS * 2 * HEX_H + 1.4;
/** Seconds one engine tick lasts at speed 1. */
const TICK = 0.18;
/** How tall a loaded unit model is made, before its role's scale. */
const MODEL_HEIGHT = 2.25;
const SIDE_COLOR = ["#35c9b4", "#f0604a"];
/**
 * The clips a model with a skeleton may bring are named `Idle`, `Walk`, `Attack` and `Cast`. The last two play once:
 * they start `from` seconds in and run `rate` times faster, so that the blow lands close to the engine's event.
 */
const ONCE: Record<string, { from: number; rate: number }> = { Attack: { from: 0.25, rate: 2 }, Cast: { from: 0.2, rate: 2 } };
/** Seconds from the engine's event to the blow landing: the reach of a lunge, the fall of a swung weapon. */
const LANDS = 0.13;
/** And to an ability going off: the top of a hop, the end of a cast's wind-up. */
const CAST = 0.2;

/** Where a hex of the board is in the world. Side 0's rows are near the camera. */
export function hexPosition(hex: Hex): THREE.Vector3 {
  return new THREE.Vector3((hex.col - (COLS - 1) / 2 + (hex.row & 1 ? 0.25 : -0.25)) * HEX_W, 0, (hex.row - (ROWS * 2 - 1) / 2) * HEX_H);
}
export const cellPosition = (side: number, cell: number): THREE.Vector3 => hexPosition(hexOf(side, cell));

type Actor = {
  key: number;
  side: number;
  unit: number;
  group: THREE.Group;
  /** What swings on an attack: the built figure's right arm, or the whole of a loaded model. */
  arm: THREE.Object3D;
  /** The clips of a model with a skeleton, by name, and the one playing; `null` for a figure the scene moves itself. */
  motion: { mixer: THREE.AnimationMixer; clips: Record<string, THREE.AnimationAction>; now: string } | null;
  bars: THREE.Sprite[];
  /** Where it stands, and where it is walking from while `walk` runs. */
  at: THREE.Vector3;
  from: THREE.Vector3;
  maxHp: number;
  health: number;
  shield: number;
  alive: boolean;
  /** Seconds since each motion started; `Infinity` when it is not running. */
  walk: number;
  lunge: number;
  flinch: number;
  hop: number;
  fall: number;
  toward: THREE.Vector3;
};

function floorTexture(): THREE.CanvasTexture {
  const size = 2048;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const sx = size / BOARD_W;
  const sz = size / BOARD_D;
  // Flagstones first: rows of uneven slabs in a few greys.
  ctx.fillStyle = "#3f434c";
  ctx.fillRect(0, 0, size, size);
  let seed = 7;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const greys = ["#666b75", "#5c616b", "#70757f", "#565a64", "#62666f"];
  for (let y = 0; y < size; y += 96) {
    for (let x = -Math.floor(random() * 90); x < size; ) {
      const w = 110 + Math.floor(random() * 110);
      ctx.fillStyle = greys[Math.floor(random() * greys.length)];
      ctx.fillRect(x + 4, y + 4, w - 8, 88);
      x += w;
    }
  }
  // The hexes: teal inlay for your side, coral for the other.
  for (let row = 0; row < ROWS * 2; row++) {
    for (let col = 0; col < COLS; col++) {
      const { x, z } = hexPosition({ col, row });
      const side = row >= ROWS ? 0 : 1;
      ctx.beginPath();
      for (let corner = 0; corner < 6; corner++) {
        const angle = (Math.PI / 3) * corner + Math.PI / 6;
        const px = (x + BOARD_W / 2 + Math.cos(angle) * HEX_R * 0.93) * sx;
        const py = (z + BOARD_D / 2 + Math.sin(angle) * HEX_R * 0.93) * sz;
        if (corner) ctx.lineTo(px, py);
        else ctx.moveTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = side === 0 ? "rgba(30, 110, 105, 0.38)" : "rgba(150, 45, 35, 0.38)";
      ctx.fill();
      ctx.lineWidth = 7;
      ctx.strokeStyle = SIDE_COLOR[side];
      ctx.stroke();
    }
  }
  ctx.strokeStyle = "#e8c15a";
  ctx.lineWidth = 9;
  ctx.setLineDash([46, 30]);
  ctx.beginPath();
  ctx.moveTo(30, size / 2);
  ctx.lineTo(size - 30, size / 2);
  ctx.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

const part = (geometry: THREE.BufferGeometry, color: string) => painted(geometry.index ? geometry.toNonIndexed() : geometry, color);
const EDGE_X = BOARD_W / 2 + 0.9;
const EDGE_Z = BOARD_D / 2 + 0.7;
/** Where the four braziers burn. */
const BRAZIERS = [[-EDGE_X, -EDGE_Z], [EDGE_X, -EDGE_Z], [-EDGE_X, EDGE_Z], [EDGE_X, EDGE_Z]];

/** Around the floor: a low wall, broken pillars, braziers, banners for each side. `glow` is drawn unlit. */
function surroundings(): { solid: THREE.BufferGeometry; glow: THREE.BufferGeometry } {
  const solid: THREE.BufferGeometry[] = [];
  const glow: THREE.BufferGeometry[] = [];
  const pillar = (x: number, z: number, h: number) =>
    solid.push(part(new THREE.CylinderGeometry(0.46, 0.55, h, 8).translate(x, h / 2 - 0.4, z), "#7b7f88"), part(new THREE.BoxGeometry(1.3, 0.3, 1.3).translate(x, -0.25, z), "#6a6e77"), part(new THREE.BoxGeometry(1.15, 0.24, 1.15).rotateY(0.3).translate(x, h - 0.3, z), "#8a8e97"));
  [3.6, 1.7, 2.9, 4.2, 1.3, 3.1].forEach((h, i) => pillar((i < 3 ? -1 : 1) * (EDGE_X + 1.5), (i % 3) * 3.4 - 3.4, h));
  [3.0, 4.4, 1.8, 3.8, 2.4].forEach((h, i) => pillar((i - 2) * 3.1, -EDGE_Z - 1.6, h));
  // A low wall along the far side, with gaps.
  for (const x of [-4.7, -1.5, 1.6, 4.6]) solid.push(part(new THREE.BoxGeometry(2.4, 0.9, 0.5).translate(x, 0.05, -EDGE_Z - 0.6), "#6a6e77"));
  for (const [x, z] of BRAZIERS) {
    solid.push(part(new THREE.CylinderGeometry(0.1, 0.16, 1.5, 6).translate(x, 0.35, z), "#3b3f48"), part(new THREE.CylinderGeometry(0.42, 0.2, 0.3, 8).translate(x, 1.2, z), "#3b3f48"));
    glow.push(part(new THREE.ConeGeometry(0.3, 0.7, 6).translate(x, 1.65, z), "#ff9a3d"), part(new THREE.ConeGeometry(0.16, 0.5, 5).translate(x, 1.75, z), "#ffe08a"));
  }
  for (const [z, color] of [[HEX_H * 1.5, SIDE_COLOR[0]], [-HEX_H * 1.5, SIDE_COLOR[1]]] as [number, string][]) {
    for (const x of [-EDGE_X - 0.1, EDGE_X + 0.1]) {
      solid.push(part(new THREE.CylinderGeometry(0.05, 0.06, 3.8, 6).translate(x, 1.5, z), "#2a2d35"), part(new THREE.BoxGeometry(0.06, 1.8, 1.0).translate(x, 2.4, z + 0.55), color), part(new THREE.BoxGeometry(0.07, 0.16, 1.0).translate(x, 1.55, z + 0.55), "#e8c15a"));
    }
  }
  return { solid: merged(solid), glow: merged(glow) };
}

export class ArenaScene {
  private canvas: HTMLCanvasElement;
  private onCell: ((cell: number) => void) | undefined;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(36, 1, 0.1, 200);
  private material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  private glowMaterial = new THREE.MeshBasicMaterial({ vertexColors: true });
  private figures = new Map<number, FigureGeometry>();
  private owned: { dispose(): void }[] = [];
  private ringShape = new THREE.RingGeometry(0.44, 0.58, 6).rotateX(-Math.PI / 2);
  private actors: Actor[] = [];
  private fx = new Effects(this.scene);
  /** The hexes of your side, drawn on the map only while you are placing units. */
  private grid: THREE.Mesh[] = [];
  private placing = false;
  private marks: THREE.Mesh[] = [];
  private queue: { at: number; event: FightEvent }[] = [];
  private clock = 0;
  private speed = 1;
  private last = 0;
  private frame = 0;
  private onDone: (() => void) | null = null;
  private resizeObserver: ResizeObserver;
  private pressed: { x: number; y: number } | null = null;
  /** What the scene builds around the board, taken away when a map is loaded. */
  private built: THREE.Object3D[] = [];
  private top: THREE.Mesh;
  private map: THREE.Object3D | null = null;
  /** How high the map's ground is under each hex of the board (`row * COLS + col`); flat without a map. */
  private heights: number[] | null = null;
  /** Loaded figures by unit index, each standing on the origin; and the files of those that can be loaded. */
  private models = new Map<number, THREE.Object3D>();
  private files = new Map<number, string>();
  private loading = new Map<number, Promise<void>>();
  /** Shows again what was last asked for, once models have arrived. */
  private again: (() => void) | null = null;
  /** The roster is on the floor: a tapped unit shows what it does. */
  private roster = false;
  private gone = false;

  /** `onCell` is called with the cell of your side that was tapped. */
  constructor(canvas: HTMLCanvasElement, onCell?: (cell: number) => void) {
    this.canvas = canvas;
    this.onCell = onCell;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, coarse ? 1.75 : 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const { scene } = this;
    scene.background = new THREE.Color(SKY);
    scene.fog = new THREE.Fog(SKY, 30, 70);
    // A low warm sun from the side for long shadows, a cool sky, a soft fill from the camera, firelight at the corners.
    const sun = new THREE.DirectionalLight("#ffc48a", 2.6);
    sun.position.set(-10, 10, 6);
    sun.castShadow = true;
    sun.shadow.mapSize.setScalar(coarse ? 1024 : 2048);
    Object.assign(sun.shadow.camera, { left: -11, right: 11, top: 10, bottom: -10, near: 1, far: 40 });
    sun.shadow.bias = -0.0006;
    const fill = new THREE.DirectionalLight("#dfe6ff", 1.1);
    fill.position.set(2, 6, 10);
    scene.add(new THREE.HemisphereLight("#c9d2ff", "#5a4a44", 1.5), sun, fill);
    for (const [x, z] of BRAZIERS) {
      const fire = new THREE.PointLight("#ff9a4d", 9, 9, 1.6);
      fire.position.set(x, 1.9, z);
      scene.add(fire);
    }

    const own = <T extends { dispose(): void }>(thing: T): T => (this.owned.push(thing), thing);
    const ground = new THREE.Mesh(own(new THREE.CircleGeometry(80, 40).rotateX(-Math.PI / 2).translate(0, -0.42, 0)), own(new THREE.MeshLambertMaterial({ color: "#4b4a52" })));
    const slab = new THREE.Mesh(own(new THREE.BoxGeometry(BOARD_W + 0.4, 0.4, BOARD_D + 0.4).translate(0, -0.21, 0)), own(new THREE.MeshLambertMaterial({ color: "#5a5e68" })));
    const top = new THREE.Mesh(own(new THREE.PlaneGeometry(BOARD_W, BOARD_D).rotateX(-Math.PI / 2)), new THREE.MeshLambertMaterial({ map: floorTexture() }));
    const things = surroundings();
    const around = new THREE.Mesh(own(things.solid), this.material);
    const flames = new THREE.Mesh(own(things.glow), this.glowMaterial);
    for (const mesh of [ground, slab, top]) mesh.receiveShadow = true;
    slab.castShadow = around.castShadow = true;
    scene.add(ground, slab, top, around, flames);
    this.built = [slab, around, flames];
    this.top = top;
    void this.loadModels();

    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointerup", this.onPointerUp);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
    this.frame = requestAnimationFrame(this.tick);
  }

  /** Brings in the map and the unit models listed in `/arena/models.json`, if any. */
  private async loadModels(): Promise<void> {
    const list = await manifest();
    if (list.map) {
      const map = await loadModel(`/arena/${list.map}`).catch(() => null);
      if (this.gone) return void (map && disposeModel(map));
      if (map) {
        // The map brings its own ground and walls. Its courtyard is not perfectly level, so units stand at the height
        // of the ground under them. The hexes of your side are laid on it one by one, to be shown while you place units.
        this.map = laidOut(map, BOARD_W * 1.24);
        this.scene.remove(...this.built, this.top);
        this.scene.add(this.map);
        const down = new THREE.Raycaster();
        const heights: number[] = [];
        const lines: THREE.BufferGeometry[] = [];
        const fills: THREE.BufferGeometry[] = [];
        for (let row = 0; row < ROWS * 2; row++) {
          for (let col = 0; col < COLS; col++) {
            const at = hexPosition({ col, row });
            down.set(new THREE.Vector3(at.x, 50, at.z), new THREE.Vector3(0, -1, 0));
            // A stray prop under a hex would lift it: nothing on the courtyard is higher than a step.
            const y = Math.min(0.4, Math.max(-0.4, down.intersectObject(this.map, true)[0]?.point.y ?? 0));
            heights.push(y);
            if (row < ROWS) continue;
            lines.push(part(new THREE.RingGeometry(HEX_R * 0.87, HEX_R * 0.93, 6, 1, Math.PI / 6).rotateX(-Math.PI / 2).translate(at.x, y + 0.05, at.z), SIDE_COLOR[0]));
            fills.push(part(new THREE.CircleGeometry(HEX_R * 0.87, 6, Math.PI / 6).rotateX(-Math.PI / 2).translate(at.x, y + 0.045, at.z), SIDE_COLOR[0]));
          }
        }
        this.heights = heights;
        const own = <T extends { dispose(): void }>(thing: T): T => (this.owned.push(thing), thing);
        const flat = (opacity: number) => own(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity, depthWrite: false }));
        this.grid = [new THREE.Mesh(own(merged(lines)), flat(0.8)), new THREE.Mesh(own(merged(fills)), flat(0.1))];
        for (const mesh of this.grid) mesh.visible = this.placing;
        this.scene.add(...this.grid);
      }
    }
    for (const [id, file] of Object.entries(list.units)) {
      const unit = UNITS.findIndex((def) => def.id === id);
      if (unit >= 0) this.files.set(unit, file);
    }
    // Units already on the floor were built from primitives: show them again, which fetches their models.
    if (this.files.size && !this.queue.length && !this.onDone) this.again?.();
  }

  /** Fetches the models of these units, those that have one and are not here yet. A model is fetched once, when first needed. */
  private fetch(units: number[]): Promise<void[]> {
    return Promise.all(
      units.map((unit) => {
        const file = this.files.get(unit);
        if (!file || this.models.has(unit)) return Promise.resolve();
        let pending = this.loading.get(unit);
        if (!pending) {
          pending = loadModel(`/arena/units/${file}`).then(
            (model) => {
              if (this.gone) return disposeModel(model);
              this.models.set(unit, standing(model, MODEL_HEIGHT));
            },
            () => void this.files.delete(unit),
          );
          this.loading.set(unit, pending);
        }
        return pending;
      }),
    );
  }

  /** How tall a unit stands before its role's scale: its loaded model, or the figure built for it. */
  private tall(unit: number): number {
    return this.models.has(unit) ? MODEL_HEIGHT + 0.25 : this.figure(unit).height;
  }

  /** Where a hex is in the world, on the map's ground when there is a map. */
  private spot(hex: Hex): THREE.Vector3 {
    const at = hexPosition(hex);
    if (this.heights) at.y = this.heights[hex.row * COLS + hex.col];
    return at;
  }

  private resize(): void {
    const { clientWidth: width, clientHeight: height } = this.canvas;
    if (!width || !height) return;
    this.renderer.setSize(width, height, false);
    const aspect = width / height;
    this.camera.aspect = aspect;
    // A tall screen needs the camera further back to keep the whole width of the floor in view, a wide and low one to keep its depth.
    const distance = 17.5 * Math.max(1, 1.5 / aspect, aspect / 2.5);
    this.camera.position.set(0, distance * 0.66, distance * 0.75);
    this.camera.lookAt(0, 0, 0.5);
    this.camera.updateProjectionMatrix();
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.pressed = { x: event.clientX, y: event.clientY };
  };

  /** A tap (not a drag) on one of your hexes reports its cell. On the roster, a tap on a unit has it show its blow and its ability. */
  private onPointerUp = (event: PointerEvent): void => {
    const pressed = this.pressed;
    this.pressed = null;
    if (!pressed || Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > 10) return;
    const box = this.canvas.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((event.clientX - box.left) / box.width) * 2 - 1, -((event.clientY - box.top) / box.height) * 2 + 1), this.camera);
    if (this.roster) {
      // The figure itself is what was tapped, not the ground behind it.
      let hit: THREE.Object3D | null = ray.intersectObjects(this.actors.map((actor) => actor.group), true)[0]?.object ?? null;
      while (hit && !this.actors.some((actor) => actor.group === hit)) hit = hit.parent;
      const tapped = this.actors.find((actor) => actor.group === hit);
      if (tapped) this.perform(tapped);
      return;
    }
    if (!this.onCell) return;
    const point = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
    if (!point) return;
    for (let cell = 0; cell < CELLS; cell++) {
      if (cellPosition(0, cell).distanceTo(point) < HEX_R * 0.9) return this.onCell(cell);
    }
  };

  private figure(unit: number): FigureGeometry {
    let geometry = this.figures.get(unit);
    if (!geometry) this.figures.set(unit, (geometry = figureGeometry(unit)));
    return geometry;
  }

  private clear(): void {
    for (const actor of this.actors) {
      this.scene.remove(actor.group);
      for (const bar of actor.bars) {
        this.scene.remove(bar);
        bar.material.dispose();
      }
      ((actor.group.children[0] as THREE.Mesh).material as THREE.Material).dispose();
      if (actor.motion) {
        actor.motion.mixer.stopAllAction();
        actor.motion.mixer.uncacheRoot(actor.arm);
        // Each copy of a model has bones of its own, and what the renderer keeps for them.
        actor.arm.traverse((node) => (node as THREE.SkinnedMesh).skeleton?.dispose());
      }
    }
    this.fx.clear();
    this.actors = [];
    this.queue = [];
    this.onDone = null;
  }

  private addActor(key: number, side: number, unit: number, rank: number, at: THREE.Vector3, facing: number, maxHp: number, ringColor = SIDE_COLOR[side]): void {
    const group = new THREE.Group();
    const base = new THREE.Mesh(this.ringShape, new THREE.MeshBasicMaterial({ color: ringColor, transparent: true, opacity: 0.9, depthWrite: false }));
    base.position.y = 0.07;
    const figure = new THREE.Group();
    const model = this.models.get(unit);
    let arm: THREE.Object3D;
    let motion: Actor["motion"] = null;
    if (model?.animations.length) {
      // A model with a skeleton plays its own clips, on bones of its own.
      arm = cloneWithSkeleton(model);
      figure.add(arm);
      const mixer = new THREE.AnimationMixer(arm);
      const clips: Record<string, THREE.AnimationAction> = {};
      for (const clip of model.animations) {
        const action = (clips[clip.name] = mixer.clipAction(clip));
        if (!ONCE[clip.name]) continue;
        action.setLoop(THREE.LoopOnce, 1).timeScale = ONCE[clip.name].rate;
        action.clampWhenFinished = true;
      }
      clips.Idle?.play();
      motion = { mixer, clips, now: "Idle" };
    } else if (model) {
      // A loaded model without one has no separate arm: it leans into the blow as one piece.
      arm = model.clone();
      figure.add(arm);
    } else {
      const shape = this.figure(unit);
      const body = new THREE.Mesh(shape.body, this.material);
      arm = new THREE.Mesh(shape.arm, this.material);
      arm.position.copy(shape.shoulder);
      body.castShadow = arm.castShadow = true;
      figure.add(body, arm);
      if (shape.bodyGlow) figure.add(new THREE.Mesh(shape.bodyGlow, this.glowMaterial));
      if (shape.armGlow) arm.add(new THREE.Mesh(shape.armGlow, this.glowMaterial));
    }
    figure.scale.setScalar(FIGURE_SCALE[UNITS[unit].role] * (1 + (rank - 1) * 0.14));
    group.add(base, figure);
    group.position.copy(at);
    figure.rotation.y = facing;
    const bars: THREE.Sprite[] = [];
    if (maxHp > 0) {
      // Back plate, health, shield: three flat sprites that grow from their left edge.
      for (const color of ["#1b2430", side === 0 ? "#3fc98a" : "#f06a55", "#dff1ff"]) {
        const bar = new THREE.Sprite(new THREE.SpriteMaterial({ color, depthTest: false, transparent: true }));
        bar.center.set(0, 0.5);
        bar.renderOrder = 5 + bars.length;
        bars.push(bar);
        this.scene.add(bar);
      }
    }
    this.scene.add(group);
    this.actors.push({ key, side, unit, group, arm, motion, bars, at: at.clone(), from: at.clone(), maxHp, health: 1, shield: 0, alive: true, walk: Infinity, lunge: Infinity, flinch: Infinity, hop: Infinity, fall: Infinity, toward: new THREE.Vector3() });
  }

  /** All sixteen units on the floor, a guild per row and a role per column, looking at the camera. */
  showRoster(): void {
    this.again = () => this.showRoster();
    this.showWhenFetched(UNITS.map((_, unit) => unit));
    this.clear();
    this.roster = true;
    this.place(false);
    this.setMarks([]);
    UNITS.forEach((def, unit) => this.addActor(unit, 0, unit, 1, new THREE.Vector3((def.role - 1.5) * 2.1, 0, (def.guild - 1.5) * 1.7), 0, 0, GUILDS[def.guild].color));
  }

  /** Shows or hides the hexes of your side. */
  private place(on: boolean): void {
    this.placing = on;
    for (const mesh of this.grid) mesh.visible = on;
  }

  /** Two floors standing ready. `placing`: you are arranging yours, so the hexes of your side are drawn. */
  setTeams(teams: Fielded[][], placing = false): void {
    this.again = () => this.setTeams(teams, placing);
    this.showWhenFetched(teams.flat().map((piece) => piece.unit));
    this.clear();
    this.roster = false;
    this.place(placing);
    const health = startingHealth(teams);
    teams.forEach((team, side) => {
      for (const piece of team) {
        const key = side * CELLS + piece.cell;
        this.addActor(key, side, piece.unit, piece.rank, this.spot(hexOf(side, piece.cell)), side === 0 ? Math.PI : 0, health[key]);
      }
    });
  }

  /** A unit of the roster strikes towards the camera, then uses its ability. */
  private perform(actor: Actor): void {
    actor.toward.set(0, 0, 1);
    actor.lunge = 0;
    this.show(actor, "Attack", true);
    // Nobody stands in front of it: the blow and the ability land a step ahead, or on the unit itself when the
    // ability is one for its own side.
    const self = this.body(actor);
    const step = new THREE.Vector3(0, 0, 1.4);
    const ahead: Body = { foot: self.foot.clone().add(step), chest: self.chest.clone().add(step), head: self.head.clone().add(step) };
    this.strike(actor, ahead);
    const { op, who } = UNITS[actor.unit].ability;
    this.fx.later(0.9, () => {
      actor.hop = 0;
      this.show(actor, "Cast", true);
      this.fx.later(CAST, () => this.fx.cast(op, who, this.tint(actor.unit), self, [["self", "allies", "allyNear", "allyWeakest"].includes(who) ? self : ahead]));
    });
  }

  /** Fetches the models these units still lack and, when any arrived, shows the floor again with them. */
  private showWhenFetched(units: number[]): void {
    const missing = units.filter((unit) => this.files.has(unit) && !this.models.has(unit));
    if (!missing.length) return;
    const asked = this.again;
    void this.fetch(missing).then(() => {
      // Only if nothing else was shown meanwhile and no fight has started.
      if (!this.gone && this.again === asked && !this.queue.length && !this.onDone) asked?.();
    });
  }

  /** Gold rings on cells of your side: where a unit you are bidding for would stand. */
  setMarks(cells: number[]): void {
    for (const mark of this.marks) {
      this.scene.remove(mark);
      (mark.material as THREE.Material).dispose();
    }
    this.marks = cells.map((cell) => {
      const mark = new THREE.Mesh(this.ringShape, new THREE.MeshBasicMaterial({ color: "#e8c15a", transparent: true, opacity: 0.95, depthWrite: false }));
      mark.position.copy(this.spot(hexOf(0, cell)));
      mark.position.y += 0.06;
      this.scene.add(mark);
      return mark;
    });
  }

  /** Plays a fight from the engine's events and calls `onDone` shortly after the last one. */
  play(teams: Fielded[][], events: FightEvent[], onDone?: () => void, waited = false): void {
    this.setTeams(teams);
    this.setMarks([]);
    const missing = teams.flat().map((piece) => piece.unit).filter((unit) => this.files.has(unit) && !this.models.has(unit));
    if (missing.length && !waited) {
      // The fighters' models first, but never more than a few seconds of waiting.
      void Promise.race([this.fetch(missing), new Promise((resolve) => setTimeout(resolve, 4000))]).then(() => !this.gone && this.play(teams, events, onDone, true));
      return;
    }
    const perTick = new Map<number, number>();
    for (const event of events) perTick.set(event.t, (perTick.get(event.t) ?? 0) + 1);
    const seen = new Map<number, number>();
    this.queue = events.map((event) => {
      const index = seen.get(event.t) ?? 0;
      seen.set(event.t, index + 1);
      return { at: (event.t - 1 + (index / perTick.get(event.t)!) * 0.85) * TICK + 0.6, event };
    });
    this.clock = 0;
    this.onDone = onDone ?? null;
  }

  setSpeed(speed: number): void {
    this.speed = speed;
  }

  private actor(key: number): Actor | undefined {
    return this.actors.find((actor) => actor.key === key);
  }

  /** A unit's guild colour, lightened so that it glows. */
  private tint(unit: number): string {
    return new THREE.Color(GUILDS[UNITS[unit].guild].color).lerp(new THREE.Color("#ffffff"), 0.35).getStyle();
  }

  /** A blow from `from` landing on `struck`: a shot for those who fight from afar, a slash for the rest. `landed` runs as it lands. */
  private strike(from: Actor, struck: Body, landed?: () => void): void {
    const tint = this.tint(from.unit);
    const land = () => {
      this.fx.hit(struck.chest, tint);
      landed?.();
    };
    if (UNITS[from.unit].ranged) this.fx.shot(this.body(from).chest, struck.chest, tint, 0.16, 0.2, land);
    else
      this.fx.later(LANDS, () => {
        this.fx.slash(struck.chest, from.toward, "#fff4d6");
        land();
      });
  }

  /** Where an actor can be hit, where it stands now. */
  private body(actor: Actor): Body {
    const tall = this.tall(actor.unit) * FIGURE_SCALE[UNITS[actor.unit].role];
    const foot = actor.at.clone();
    return { foot, chest: foot.clone().setY(foot.y + tall * 0.5), head: foot.clone().setY(foot.y + tall * 0.95) };
  }

  /** Has a model with a skeleton play the clip `name`, from its start again when `restart`. Does nothing for other figures and missing clips. */
  private show(actor: Actor, name: string, restart = false): void {
    const motion = actor.motion;
    const next = motion?.clips[name];
    if (!motion || !next) return;
    const last = motion.clips[motion.now];
    if (next === last && !restart) return;
    if (ONCE[name]) next.reset().time = ONCE[name].from;
    else next.enabled = true;
    next.play();
    if (last && last !== next) last.crossFadeTo(next, 0.08, false);
    motion.now = name;
  }

  /** Turns the figure to look from where it stands towards `point`. */
  private face(actor: Actor, from: THREE.Vector3, point: THREE.Vector3): void {
    actor.group.children[1].rotation.y = Math.atan2(point.x - from.x, point.z - from.z);
  }

  private apply(event: FightEvent): void {
    const from = this.actor(event.from);
    if (!from) return;
    if (event.kind === "move") {
      from.from.copy(from.group.position);
      from.at.copy(this.spot(event.to));
      from.walk = 0;
      this.face(from, from.from, from.at);
    } else if (event.kind === "attack") {
      const to = this.actor(event.to);
      if (!to) return;
      from.lunge = 0;
      this.show(from, "Attack", true);
      from.toward.copy(to.at).sub(from.at).normalize();
      this.face(from, from.at, to.at);
      this.strike(from, this.body(to), () => {
        if (this.actors.includes(to)) to.flinch = 0;
      });
    } else {
      from.hop = 0;
      this.show(from, "Cast", true);
      const self = this.body(from);
      const reached = event.to.flatMap((key) => {
        const to = this.actor(key);
        return to ? [to === from ? self : this.body(to)] : [];
      });
      this.fx.later(CAST, () => this.fx.cast(event.op, UNITS[from.unit].ability.who, this.tint(from.unit), self, reached));
    }
    for (const actor of this.actors) {
      const hp = event.hp[actor.key];
      // What the event took or gave rises from the unit as a number, as the blow lands.
      const before = Math.round(actor.health * actor.maxHp);
      if (actor.alive && actor.maxHp > 0 && hp !== before) {
        const head = this.body(actor).head;
        this.fx.later(event.kind === "cast" ? CAST : LANDS, () => this.fx.number(head, hp < before ? `${before - hp}` : `+${hp - before}`, hp < before ? "#ffd27a" : "#8dffb5"));
      }
      if (actor.alive && hp === 0) {
        actor.alive = false;
        actor.fall = 0;
      }
      actor.health = hp / actor.maxHp;
      actor.shield = event.shield[actor.key] / actor.maxHp;
    }
  }

  private tick = (now: number): void => {
    this.frame = requestAnimationFrame(this.tick);
    // Motions here are functions of elapsed time, so a long gap between frames (a background tab) skips ahead instead of slowing the fight down.
    const dt = Math.min(1, (now - this.last) / 1000 || 0);
    this.last = now;
    const step = dt * this.speed;

    if (this.queue.length || this.onDone) {
      this.clock += step;
      while (this.queue.length && this.queue[0].at <= this.clock) this.apply(this.queue.shift()!.event);
      if (!this.queue.length && this.onDone && !this.fx.busy && this.actors.every((actor) => actor.lunge > 0.5 && (actor.alive || actor.fall > 0.9))) {
        const done = this.onDone;
        this.onDone = null;
        done();
      }
    }

    const seconds = now / 1000;
    for (const actor of this.actors) {
      actor.walk += step;
      actor.lunge += step;
      actor.flinch += step;
      actor.hop += step;
      actor.fall += step;
      const figure = actor.group.children[1];
      const walked = Math.min(1, actor.walk / TICK);
      // Out and back in 0.3 s; the arm swings with it.
      const reach = actor.lunge < 0.3 ? Math.sin((actor.lunge / 0.3) * Math.PI) : 0;
      const shake = actor.flinch < 0.2 ? Math.sin((actor.flinch / 0.2) * Math.PI) : 0;
      const jump = actor.hop < 0.45 ? Math.sin((actor.hop / 0.45) * Math.PI) : 0;
      const far = UNITS[actor.unit].ranged ? 0.18 : 0.5;
      actor.group.position.lerpVectors(actor.from, actor.at, walked).addScaledVector(actor.toward, reach * far);
      if (actor.motion) {
        // Its own clips do the swinging, hopping and stepping. A blow or a cast is played to its end; between them it
        // walks while it is on its way (steps follow one another a tick apart) and stands otherwise.
        const { clips, now, mixer } = actor.motion;
        if (!ONCE[now] || !clips[now].isRunning()) this.show(actor, actor.walk < TICK * 1.5 ? "Walk" : "Idle");
        mixer.update(step);
      } else {
        actor.arm.rotation.x = this.models.has(actor.unit) ? reach * 0.35 : reach * 1.3 - jump * 2.4;
        figure.position.y = actor.alive ? jump * 0.5 + (walked < 1 ? Math.abs(Math.sin(walked * Math.PI * 2)) * 0.12 : Math.sin(seconds * 2.4 + actor.key) * 0.02) : 0;
      }
      figure.rotation.z = shake * 0.22;
      if (!actor.alive) {
        const gone = Math.min(1, actor.fall / 0.6);
        figure.rotation.x = -gone * 1.45;
        actor.group.scale.setScalar(1 - Math.max(0, (actor.fall - 0.6) / 0.3) * 0.999);
        actor.group.visible = actor.fall < 0.9;
      }
      // The bars ride above the head wherever the unit is.
      const width = 0.9;
      const y = this.tall(actor.unit) * FIGURE_SCALE[UNITS[actor.unit].role] + 0.1;
      const sizes = [width, width * actor.health, width * Math.min(1, actor.shield)];
      actor.bars.forEach((bar, index) => {
        bar.visible = actor.alive && sizes[index] > 0;
        bar.scale.set(sizes[index], index === 0 ? 0.13 : index === 1 ? 0.09 : 0.05, 1);
        bar.position.set(actor.group.position.x - width / 2, actor.group.position.y + y + (index === 2 ? 0.1 : 0), actor.group.position.z);
      });
    }
    this.fx.update(step, this.renderer.domElement.height, this.camera);
    // A heavy blow shakes the ground: the whole scene is nudged, the camera stays where it is.
    this.scene.position.set((Math.random() - 0.5) * this.fx.shake, (Math.random() - 0.5) * this.fx.shake, 0);

    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    this.gone = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.clear();
    this.setMarks([]);
    for (const shape of this.figures.values()) {
      shape.body.dispose();
      shape.arm.dispose();
      shape.bodyGlow?.dispose();
      shape.armGlow?.dispose();
    }
    for (const model of [this.map, ...this.models.values()]) if (model) disposeModel(model);
    const top = this.top.material as THREE.MeshLambertMaterial;
    top.map?.dispose();
    for (const thing of [...this.owned, top, this.material, this.glowMaterial, this.ringShape, this.fx]) thing.dispose();
    this.renderer.dispose();
  }
}
