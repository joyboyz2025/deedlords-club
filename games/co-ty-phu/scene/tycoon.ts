// Bàn cờ tỷ phú 3D: mặt bàn, khu phố đồ chơi giữa bàn, mâm tung xúc xắc, nhà và khách sạn mọc dần trên đất,
// và nhân vật chibi của từng người đi từng ô. File này chỉ vẽ: ai đứng đâu, đổ được mấy, đất của ai đều lấy từ View server gửi.

import * as THREE from "three";
import { Chibi, ChibiKit } from "../../ma-soi/scene/chibi";
import type { Actor } from "../../ma-soi/scene/state";
import { SALARY, SQUARES, TOKEN_COLORS } from "../board";
import type { PublicPlayer, View } from "../view";
import { type BoardArt, loadBoardArt } from "./art";
import { HOUSE_SLOT, TIERS, TIER_OF_GROUP, TRAY_RADIUS, TRAY_TOP, buildingGeometry, cityGeometry } from "./city";
import { DIE_SIZE, bounceHeight, dieGeometry, easeOut, restQuaternion } from "./dice";
import {
  BAND,
  BOARD_PITCH,
  CORNER,
  FOV,
  GROW_MS,
  HALF,
  LONG_WALK,
  SETTLE_MS,
  SIDE,
  THROW_MS,
  TILE,
  VIEW_YAW,
  boardFit,
  inTile,
  isCorner,
  sideOf,
  sideYaw,
  standSpot,
  stepsBetween,
  tileAt,
  tileCenter,
  tileYaw,
  type Point,
} from "./layout";
import { arrowTexture, boardTexture, diceTexture, moneyTexture, windowTexture } from "./textures";

/** Camera luôn nhìn chéo từ góc Xuất phát, không xoay. `follow`: lại gần người đang tới lượt. `board`: nhìn cả bàn. */
export type CameraMode = "follow" | "board";

export type TycoonEvents = {
  /** Chạm vào một ô trên bàn. */
  onTile: (index: number) => void;
  /** Quân vừa bước sang ô mới, để phát tiếng bước. */
  onStep: () => void;
  /** Xúc xắc chạm mâm; `strength` từ 1 nhỏ dần qua mỗi lần nảy. */
  onHit: (strength: number) => void;
  /** Có nhà hay khách sạn vừa bắt đầu mọc. */
  onBuild: () => void;
  /** Xúc xắc của lượt đổ `rolls` đã dừng và quân người đổ đã đi tới nơi: lúc này giao diện mới đổi tiền, hiện thẻ và các nút. */
  onArrive: (rolls: number) => void;
};

const SKY = "#c4e6f7";
const GROUND = "#d3e9df";
/** Tall enough to pick out at once on the whole board, where a square is under 50 pixels across. */
const CHIBI_SCALE = 1.12;
/**
 * The camera looks down on the board from high above (`BOARD_PITCH`), so a token standing straight shows little but
 * the top of its head. Tokens lean back by this much, from the feet, head away from the camera, so that face and body
 * turn up to the viewer, like a cut-out propped on a paper board. (Leaning towards the camera would turn the face
 * down to the board.) The base under the feet stays flat on the square.
 */
const LEAN = -0.72;
/** How far the dark outline around a token stands out from it, in its own units (before `CHIBI_SCALE`). */
const OUTLINE = 0.022;
const LABEL_PX = 15;
/** Đứng yên cả thì 20 hình mỗi giây là đủ, đỡ nóng máy. */
const IDLE_FRAME_MS = 50;
/** Quân đi nhanh gấp chừng này lần nhân vật trong đình: mỗi ô chừng một phần tư giây, một lượt đổ 12 ô chỉ mất khoảng ba giây. */
const HOP_SPEED = 3;
const TURN_EARLY = 0.25;
/** Bám theo quân: muốn thấy chừng này đơn vị bàn cờ quanh quân, camera chếch xuống chừng này. */
const FOLLOW_ACROSS = 10;
const FOLLOW_ALONG = 13;
const FOLLOW_PITCH = 0.92;
/** Xúc xắc bay vào từ phía người đổ, bắt đầu cách tâm mâm chừng này. */
const THROW_FROM = 4.2;
/** Hai con xúc xắc nằm yên cách nhau chừng này, tâm tới tâm. */
const DICE_APART = 1.62;
/** Mũi tên trên đầu người đang tới lượt cao chừng này điểm ảnh trên màn hình, dù camera xa hay gần. */
const ARROW_PX = 30;
/** Số tiền cộng trừ nổi trên đầu người chơi: chữ cao chừng này điểm ảnh, bay lên rồi mờ đi trong chừng này. */
const MONEY_PX = 26;
const MONEY_MS = 1800;
/** Đang bán nhà, cầm cố: số tiền nhận nổi trên ô sáng, chữ cao chừng này điểm ảnh. */
const OFFER_PX = 22;
/** Những lần xúc xắc chạm mâm theo tiến độ tung, khớp với `bounceHeight`, kèm độ mạnh của tiếng. */
const HITS: [at: number, strength: number][] = [
  [0.5, 1],
  [0.72, 0.5],
  [0.86, 0.25],
];
/** Nhà bị bán hay bị thu thì lún xuống đất trong chừng này. */
const SINK_MS = 450;
const UP = new THREE.Vector3(0, 1, 0);
const TRAY_SPOT = new THREE.Vector2();

type Token = {
  chibi: Chibi;
  actor: Actor;
  /** Ô quân đang đứng hoặc đang đi tới. */
  at: number;
  jailed: boolean;
  slot: number;
  /** Những điểm còn phải đi qua; điểm cuối là chỗ đứng trong ô mới. */
  path: Point[];
  speed: number;
  disc: THREE.Mesh;
  /** What lies flat under the feet, following the token: its shadow, a white rim, the disc in the player's colour. */
  base: THREE.Group;
};

/** Nhà trên một ô: mọc từ độ cao `from` (1 là đủ cao) tới `to`, bắt đầu từ `start`. */
type Built = {
  /** Chỉ số trong `buildings`: hạng nhân hai, cộng một nếu là khách sạn. */
  mesh: number;
  /** Chỗ đứng và hướng nhìn khi đã mọc xong. */
  base: THREE.Matrix4;
  from: number;
  to: 0 | 1;
  start: number;
};

/** Một lần cộng trừ tiền đang nổi trên đầu người chơi. */
type Floater = { sprite: THREE.Sprite; player: string; start: number; aspect: number };

/** Đường bay của một con xúc xắc: từ phía người đổ vào chỗ nằm, lăn quanh `axis`, nằm yên theo `rest`. */
type Flight = { from: THREE.Vector3; to: THREE.Vector3; rest: THREE.Quaternion; axis: THREE.Vector3; turns: number };

const approach = (from: number, to: number, rate: number, dt: number) => from + (to - from) * (1 - Math.exp(-rate * dt));
/** Vượt quá đích một chút rồi lùi về, như nhà vừa mọc còn nhún. */
const backOut = (t: number) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;

/** Bảng tên của nhân vật: tấm hình neo ở mép dưới. Lớp Chibi của Ma Sói không có cách ẩn tên nên tìm thẳng trong nhân vật. */
function labelOf(chibi: Chibi): THREE.Object3D {
  return chibi.root.children.find((child) => child instanceof THREE.Sprite && child.center.y === 0) ?? new THREE.Object3D();
}

export class TycoonScene {
  private canvas: HTMLCanvasElement;
  private events: TycoonEvents;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 300);
  private kit: ChibiKit;
  private tokens = new Map<string, Token>();
  private owned: { dispose(): void }[] = [];
  private boardMaterial: THREE.MeshLambertMaterial;
  /** Mỗi hạng nhà hai khối vẽ: nhà rồi khách sạn. */
  private buildings: THREE.InstancedMesh[];
  private art: BoardArt | null = null;
  private built = new Map<string, Built>();
  private buildingsMoving = false;
  private propsSeen = false;
  private plaques: THREE.InstancedMesh;
  private liens: THREE.InstancedMesh;
  private highlight: THREE.Mesh;
  /** Đang bán nhà, cầm cố: ô không bán được thì tối đi, ô bán được thì sáng vàng nhấp nháy, kèm số tiền nhận nổi trên ô. */
  private shades: THREE.InstancedMesh;
  private glows: THREE.InstancedMesh;
  private offers: { sprite: THREE.Sprite; aspect: number }[] = [];
  private focusing = false;
  private arrow: THREE.Sprite;
  private floaters: Floater[] = [];
  private fonts: { text: string; title: string };

  private dice: THREE.Mesh[];
  private diceShadows: THREE.Mesh[];
  private flights: Flight[] = [];
  private rolls: number | null = null;
  private throwAt = -Infinity;
  private hits = HITS.length;
  private diceResting = true;
  /** A roll is on its way to the chain: the dice tumble in the air above the tray until their numbers come. */
  private shaking = false;
  private shakeAt = 0;
  /** Where each die was when the shaking began, to rise from there. `null`: it was not on the table. */
  private shakeFrom: (THREE.Vector3 | null)[] = [null, null];
  /** Quân chỉ được đi sau lúc này: chờ xúc xắc dừng và mọi người kịp nhìn số. */
  private holdUntil = 0;
  private held = false;
  /** Đang chờ quân của người vừa đổ đi tới nơi để báo `onArrive`. */
  private arrivalPending = false;
  private mover: string | null = null;

  private you: string | null = null;
  private current: string | null = null;
  /** Tiền qua Xuất phát đang ghi trên mặt bàn. */
  private salary: number = SALARY;
  private playing = false;
  private mode: CameraMode = "follow";
  private focus = new THREE.Vector3(HALF - CORNER / 2, 0, HALF - CORNER / 2);
  private zoom = 1;
  /** Nhìn cả bàn mà phóng to thì điểm nhìn dời tới chỗ người xem chỉ vào, hay kéo tới. */
  private pan = new THREE.Vector3();
  private followDistance = 16;
  private boardDistance = 40;
  /** Nhìn cả bàn thì điểm nhìn dời về phía góc Xuất phát chừng này cho bàn nằm giữa khung (`boardFit`). */
  private boardShift = 0;
  /** Điểm ảnh chừa ở hai bên (`x`) và ở trên, dưới (`y`) cho thẻ người chơi và các nút khi nhìn cả bàn. */
  private insets = { x: 0, y: 0 };
  private width = 1;
  private height = 1;
  private calm = false;

  private frame = 0;
  private lastFrame = 0;
  private startedAt = performance.now();
  private busyFrameMs: number;
  private busy = true;

  private pointers = new Map<number, { x: number; y: number }>();
  private dragged = 0;
  private pinchFrom = 0;
  private zoomFrom = 1;
  private resizeObserver: ResizeObserver;
  private motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

  constructor(canvas: HTMLCanvasElement, events: TycoonEvents) {
    this.canvas = canvas;
    this.events = events;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, coarse ? 1.75 : 2));
    // Điện thoại chạy 30 hình mỗi giây là đủ và đỡ nóng máy.
    this.busyFrameMs = coarse ? 31 : 0;
    this.calm = this.motionQuery.matches;

    const style = getComputedStyle(canvas);
    this.fonts = {
      text: style.getPropertyValue("--font-be-vietnam").trim() || "sans-serif",
      title: style.getPropertyValue("--font-alfa").trim() || "serif",
    };
    this.kit = new ChibiKit(this.fonts.text);

    const solid = this.own(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    this.boardMaterial = this.own(new THREE.MeshLambertMaterial({ map: this.makeBoardTexture() }));
    // Mỗi hạng nhà một khối vẽ cho nhà, một cho khách sạn, đủ chỗ cho mọi ô đất của hạng đó.
    const room = Array.from({ length: TIERS * 2 }, () => 0);
    for (const square of SQUARES) {
      if (square.kind !== "city") continue;
      room[TIER_OF_GROUP[square.group] * 2] += 4;
      room[TIER_OF_GROUP[square.group] * 2 + 1] += 1;
    }
    this.buildings = room.map((count, i) => new THREE.InstancedMesh(this.own(buildingGeometry(Math.floor(i / 2), i % 2 === 1)), solid, count));
    this.plaques = new THREE.InstancedMesh(this.own(new THREE.BoxGeometry(TILE * 0.8, 0.06, 0.18)), this.own(new THREE.MeshLambertMaterial()), 28);
    this.liens = new THREE.InstancedMesh(
      this.own(new THREE.PlaneGeometry(TILE * 0.96, CORNER * 0.96).rotateX(-Math.PI / 2)),
      this.own(new THREE.MeshBasicMaterial({ color: "#1b0f08", transparent: true, opacity: 0.45, depthWrite: false })),
      28,
    );
    const tileShape = this.own(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
    this.highlight = new THREE.Mesh(tileShape, this.own(new THREE.MeshBasicMaterial({ color: "#ffe25a", transparent: true, opacity: 0.45, depthWrite: false })));
    this.shades = new THREE.InstancedMesh(
      tileShape,
      this.own(new THREE.MeshBasicMaterial({ color: "#0d0603", transparent: true, opacity: 0.66, depthWrite: false })),
      SQUARES.length,
    );
    this.glows = new THREE.InstancedMesh(
      tileShape,
      this.own(new THREE.MeshBasicMaterial({ color: "#ffd54a", transparent: true, opacity: 0.45, depthWrite: false })),
      SQUARES.length,
    );
    const dieShape = this.own(dieGeometry());
    const dieMaterial = this.own(new THREE.MeshLambertMaterial({ map: this.own(diceTexture(this.renderer.capabilities.getMaxAnisotropy())) }));
    this.dice = [0, 1].map(() => new THREE.Mesh(dieShape, dieMaterial));
    const shadowShape = this.own(new THREE.CircleGeometry(DIE_SIZE * 0.62, 20).rotateX(-Math.PI / 2));
    const shadowMaterial = this.own(new THREE.MeshBasicMaterial({ color: "#000000", transparent: true, opacity: 0.3, depthWrite: false }));
    this.diceShadows = [0, 1].map(() => new THREE.Mesh(shadowShape, shadowMaterial));
    // Mũi tên vẽ đè lên mọi thứ, luôn nhìn thẳng vào camera, giữ nguyên cỡ trên màn hình như bảng tên.
    this.arrow = new THREE.Sprite(this.own(new THREE.SpriteMaterial({ map: this.own(arrowTexture()), sizeAttenuation: false, depthTest: false, transparent: true })));
    this.arrow.renderOrder = 10;
    this.build(solid);

    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerCancel);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
    // Chữ trên bàn và bảng tên vẽ bằng font của trang: font tải xong thì vẽ lại.
    void document.fonts?.ready.then(() => {
      if (!this.frame) return;
      this.redrawBoard();
      for (const { chibi } of this.tokens.values()) chibi.redrawLabel();
      this.busy = true;
    });
    this.frame = requestAnimationFrame(this.tick);
    // Ảnh minh họa tải xong thì vẽ lại mặt bàn có ảnh.
    void loadBoardArt().then((art) => {
      if (!art || !this.frame) return;
      this.art = art;
      this.redrawBoard();
      this.busy = true;
    });
  }

  private own<T extends { dispose(): void }>(thing: T): T {
    this.owned.push(thing);
    return thing;
  }

  private makeBoardTexture(): THREE.Texture {
    return boardTexture(this.fonts, this.renderer.capabilities.getMaxAnisotropy(), this.salary, this.art);
  }

  private redrawBoard(): void {
    this.boardMaterial.map?.dispose();
    this.boardMaterial.map = this.makeBoardTexture();
    this.boardMaterial.needsUpdate = true;
  }

  private build(solid: THREE.Material): void {
    const { scene } = this;
    scene.background = new THREE.Color(SKY);
    scene.fog = new THREE.Fog(SKY, 70, 160);
    // Ánh sáng trắng trung tính: không ngả vàng.
    const hemi = new THREE.HemisphereLight("#ffffff", "#98a2ad", 2.2);
    const sun = new THREE.DirectionalLight("#ffffff", 2.0);
    sun.position.set(-10, 18, 12);
    scene.add(hemi, sun);

    const ground = new THREE.Mesh(this.own(new THREE.CircleGeometry(150, 48).rotateX(-Math.PI / 2).translate(0, -0.55, 0)), this.own(new THREE.MeshLambertMaterial({ color: GROUND })));
    // Bàn cờ là một tấm dày màu xanh đen, mặt trên dán ảnh bàn cờ.
    const slab = new THREE.Mesh(this.own(new THREE.BoxGeometry(SIDE + 0.5, 0.5, SIDE + 0.5).translate(0, -0.26, 0)), this.own(new THREE.MeshLambertMaterial({ color: "#22384d" })));
    const top = new THREE.Mesh(this.own(new THREE.PlaneGeometry(SIDE, SIDE).rotateX(-Math.PI / 2)), this.boardMaterial);
    scene.add(ground, slab, top);

    const city = cityGeometry();
    const towers = new THREE.Mesh(this.own(city.towers), this.own(new THREE.MeshLambertMaterial({ map: this.own(windowTexture()), vertexColors: true })));
    const plain = new THREE.Mesh(this.own(city.plain), solid);
    scene.add(towers, plain);

    for (const mesh of [...this.buildings, this.plaques, this.liens, this.shades, this.glows]) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      scene.add(mesh);
    }
    for (const mesh of [...this.dice, ...this.diceShadows]) {
      mesh.visible = false;
      scene.add(mesh);
    }
    this.highlight.visible = false;
    this.highlight.position.y = 0.02;
    this.arrow.visible = false;
    scene.add(this.highlight, this.arrow);
  }

  /** Ván vừa đổi: ai đi tới đâu, đất của ai, nhà mấy căn. */
  update(view: View): void {
    this.you = view.you.id;
    this.playing = view.phase === "playing";
    // Mỗi phòng một mức tiền qua Xuất phát: vẽ lại mặt bàn cho đúng chữ trên ô.
    const salary = view.settings.salary ?? SALARY;
    if (salary !== this.salary) {
      this.salary = salary;
      this.redrawBoard();
    }
    this.current = view.current;
    // Tung xúc xắc trước khi dời quân, để quân biết phải đứng chờ.
    this.throwDice(view);
    const playing = view.players.filter((p) => p.color !== null && !p.bankrupt);
    const present = new Set(playing.map((p) => p.id));
    for (const [id, token] of this.tokens) {
      if (present.has(id)) continue;
      this.scene.remove(token.chibi.root, token.base);
      token.chibi.dispose();
      (token.disc.material as THREE.Material).dispose();
      this.tokens.delete(id);
    }
    for (const player of playing) this.placeToken(player, view);
    this.placeBuildings(view);
    this.busy = true;
  }

  private actorOf(player: PublicPlayer, view: View): Actor {
    return {
      id: player.id,
      name: player.name,
      look: player.look,
      pose: "stand",
      wolf: false,
      walkTo: null,
      pointAt: null,
      mark: view.phase === "playing" && view.current === player.id ? "pick" : null,
      badge: null,
      title: null,
      self: player.id === view.you.id,
      away: !player.online,
      pickable: false,
    };
  }

  private placeToken(player: PublicPlayer, view: View): void {
    const actor = this.actorOf(player, view);
    const slot = player.color ?? 0;
    const jailed = player.jail !== null;
    let token = this.tokens.get(player.id);
    if (!token) {
      const chibi = new Chibi(this.kit, actor);
      chibi.root.scale.setScalar(CHIBI_SCALE);
      // Applied after the turn towards where it walks (Euler XYZ), so the lean is always towards the camera.
      chibi.root.rotation.x = LEAN;
      this.outline(chibi);
      const spot = standSpot(player.position, slot, jailed);
      chibi.placeAt(spot.x, spot.z);
      chibi.root.rotation.y = VIEW_YAW;
      // Dưới chân: một vệt bóng, một vành trắng, rồi đĩa màu cùng màu với ô tên người chơi. Vành trắng tách quân khỏi
      // hình vẽ của ô bên dưới, dù ô ấy sáng hay tối.
      // Dưới chân, phẳng trên ô và đi theo quân (không ngả theo quân): một vệt bóng, một vành trắng, rồi đĩa màu.
      const shadow = new THREE.Mesh(this.discGeometry(), this.shadowMaterial());
      shadow.scale.setScalar(1.45);
      shadow.position.y = 0.012;
      const rim = new THREE.Mesh(this.discGeometry(), this.rimMaterial());
      rim.scale.setScalar(1.18);
      rim.position.y = 0.02;
      const disc = new THREE.Mesh(this.discGeometry(), new THREE.MeshBasicMaterial({ color: TOKEN_COLORS[slot], depthWrite: false }));
      disc.position.y = 0.028;
      const base = new THREE.Group();
      base.add(shadow, rim, disc);
      base.scale.setScalar(CHIBI_SCALE);
      base.position.copy(chibi.position);
      this.scene.add(chibi.root, base);
      token = { chibi, actor, at: player.position, jailed, slot, path: [], speed: 1, disc, base };
      this.tokens.set(player.id, token);
    }
    token.actor = actor;
    if (token.at !== player.position || token.jailed !== jailed) {
      const steps = stepsBetween(token.at, player.position);
      // Đi qua từng ô theo làn riêng của mình; ô cuối thì tới đúng chỗ đứng, trong song sắt nếu bị tạm giữ.
      token.path = [...steps.slice(0, -1).map((i) => standSpot(i, slot)), standSpot(player.position, slot, jailed)];
      token.speed = HOP_SPEED * Math.max(1, steps.length / LONG_WALK);
      token.at = player.position;
      token.jailed = jailed;
    }
    this.steer(token);
  }

  private discShape: THREE.CircleGeometry | null = null;
  private shadowFill: THREE.MeshBasicMaterial | null = null;
  private rimFill: THREE.MeshBasicMaterial | null = null;
  private outlineFill: THREE.MeshBasicMaterial | null = null;

  private shadowMaterial(): THREE.MeshBasicMaterial {
    this.shadowFill ??= this.own(new THREE.MeshBasicMaterial({ color: "#1d2a33", transparent: true, opacity: 0.28, depthWrite: false }));
    return this.shadowFill;
  }

  private rimMaterial(): THREE.MeshBasicMaterial {
    this.rimFill ??= this.own(new THREE.MeshBasicMaterial({ color: "#ffffff", depthWrite: false }));
    return this.rimFill;
  }

  /**
   * A dark line around the token, so its colours do not melt into the busy art of the square it stands on: each part
   * is drawn again, from the inside, pushed out along its normals. Children of the parts, so they follow every move.
   */
  private outline(chibi: Chibi): void {
    this.outlineFill ??= this.own(
      (() => {
        const material = new THREE.MeshBasicMaterial({ color: "#2a1d14", side: THREE.BackSide });
        material.onBeforeCompile = (shader) => {
          shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>", `vec3 transformed = position + normal * ${OUTLINE.toFixed(3)};`);
        };
        return material;
      })(),
    );
    const parts: THREE.Mesh[] = [];
    chibi.root.traverse((part) => {
      // The body's parts; not the eyes (drawn on the head), nor the flat things under the feet.
      if (part instanceof THREE.Mesh && part.material === this.kit.solid) parts.push(part);
    });
    for (const part of parts) part.add(new THREE.Mesh(part.geometry, this.outlineFill));
  }

  private discGeometry(): THREE.CircleGeometry {
    this.discShape ??= this.own(new THREE.CircleGeometry(0.4, 24).rotateX(-Math.PI / 2));
    return this.discShape;
  }

  /** Giao cho quân điểm kế tiếp. Xúc xắc còn lăn thì đứng chờ, quay mặt nhìn mâm; đứng yên thì quay mặt về phía camera. */
  private steer(token: Token): void {
    const waiting = performance.now() < this.holdUntil;
    const { position } = token.chibi;
    const next = waiting ? { x: position.x, z: position.z } : (token.path[0] ?? standSpot(token.at, token.slot, token.jailed));
    token.chibi.assign(token.actor, VIEW_YAW, new THREE.Vector2(next.x, next.z), waiting ? TRAY_SPOT : null);
  }

  /**
   * A roll whose numbers are not known yet (the transaction is on its way): the dice lift off and tumble above the
   * tray. When the numbers come, `update` drops them from where they are. Turned off with no new roll (the roll was
   * refused), they go back to how they lay.
   */
  setRolling(on: boolean): void {
    if (on === this.shaking) return;
    this.shaking = on;
    if (on) {
      this.shakeAt = performance.now();
      this.shakeFrom = this.dice.map((die) => (die.visible ? die.position.clone() : null));
      for (const mesh of [...this.dice, ...this.diceShadows]) mesh.visible = true;
      this.diceResting = true;
    } else if (this.flights.length === this.dice.length) {
      this.flights.forEach((flight, i) => {
        this.dice[i].position.copy(flight.to);
        this.dice[i].quaternion.copy(flight.rest);
        this.diceShadows[i].position.set(flight.to.x, TRAY_TOP + 0.003, flight.to.z);
        this.diceShadows[i].scale.setScalar(1);
      });
    } else {
      for (const mesh of [...this.dice, ...this.diceShadows]) mesh.visible = false;
    }
    this.busy = true;
  }

  /** The dice in the air, turning over and over. Returns whether they are. */
  private poseShake(now: number): boolean {
    if (!this.shaking) return false;
    const seconds = (now - this.shakeAt) / 1000;
    const rise = easeOut(seconds / 0.28);
    // As high as a throw begins (`bounceHeight(0)`), so the drop that follows starts exactly here.
    const height = TRAY_TOP + DIE_SIZE / 2 + bounceHeight(0);
    this.dice.forEach((die, i) => {
      const side = i === 0 ? -1 : 1;
      const bob = this.calm ? 0 : Math.sin(seconds * 7 + i * 1.7) * 0.22;
      const hover = new THREE.Vector3((side * DICE_APART) / 2 + Math.sin(seconds * 3.1 + i) * 0.12, height + bob, Math.cos(seconds * 2.6 + i * 2) * 0.12);
      die.position.copy(this.shakeFrom[i] ? this.shakeFrom[i]!.clone().lerp(hover, rise) : hover);
      const speed = this.calm ? 0.35 : 1;
      die.quaternion.setFromEuler(new THREE.Euler(seconds * 9.5 * speed + i * 2.1, seconds * 6.3 * speed + i, seconds * 4.7 * speed));
      const shadow = this.diceShadows[i];
      shadow.visible = true;
      shadow.position.set(die.position.x, TRAY_TOP + 0.003, die.position.z);
      shadow.scale.setScalar(1 / (1 + (die.position.y - TRAY_TOP - DIE_SIZE / 2) * 0.4));
    });
    return true;
  }

  /** Có lượt đổ mới thì tung xúc xắc từ phía người đổ vào mâm. Lần đầu vào xem thì đặt sẵn số vừa đổ, không tung. */
  private throwDice(view: View): void {
    if (view.rolls === this.rolls) return;
    const first = this.rolls === null;
    this.rolls = view.rolls;
    const values = view.dice;
    // Tumbling in the air while the roll was on its way: they fall from where they are instead of flying in.
    const midair = this.shaking && !first && values !== null ? this.dice.map((die) => die.position.clone()) : null;
    this.shaking = false;
    for (const mesh of [...this.dice, ...this.diceShadows]) mesh.visible = values !== null;
    if (!values) return;
    // Bay vào từ cạnh bàn người đổ đang đứng, nằm lại thành hàng ngang trước mặt người đó.
    const thrower = view.current ? this.tokens.get(view.current) : undefined;
    const yaw = sideYaw(sideOf(thrower?.at ?? 0)) + (Math.random() - 0.5) * 0.6;
    const toward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const across = new THREE.Vector3(toward.z, 0, -toward.x);
    const restY = TRAY_TOP + DIE_SIZE / 2;
    const jitter = (size: number) => (Math.random() - 0.5) * size;
    this.flights = values.map((value, i) => {
      const side = i === 0 ? -1 : 1;
      return {
        from: midair ? midair[i].setY(restY) : toward.clone().multiplyScalar(THROW_FROM).addScaledVector(across, side * 0.4).setY(restY),
        // Lệch ít thôi để hai con không chạm nhau.
        to: across.clone().multiplyScalar((side * DICE_APART) / 2 + jitter(0.08)).addScaledVector(toward, jitter(0.24)).setY(restY),
        rest: restQuaternion(value, yaw + jitter(0.3)),
        axis: across.clone().applyAxisAngle(UP, jitter(0.7)),
        turns: 1.6 + Math.random() * 1.2,
      };
    });
    const now = performance.now();
    this.throwAt = first ? -Infinity : now;
    this.hits = first ? HITS.length : 0;
    this.holdUntil = first ? 0 : now + THROW_MS + SETTLE_MS;
    this.arrivalPending = !first;
    this.mover = view.current;
    this.diceResting = false;
  }

  /** Xúc xắc bay, lăn, nảy theo tiến độ tung, kêu mỗi lần chạm mâm. Trả về còn đang tung không. */
  private poseDice(now: number): boolean {
    if (this.diceResting) return false;
    const t = Math.min(1, (now - this.throwAt) / THROW_MS);
    while (this.hits < HITS.length && t >= HITS[this.hits][0]) {
      this.events.onHit(HITS[this.hits][1]);
      this.hits += 1;
    }
    const lift = bounceHeight(t);
    const slide = easeOut(t);
    const spin = (1 - easeOut(t)) * Math.PI * 2;
    this.flights.forEach((flight, i) => {
      const die = this.dice[i];
      die.position.lerpVectors(flight.from, flight.to, slide);
      die.position.y += lift;
      die.quaternion.setFromAxisAngle(flight.axis, spin * flight.turns).multiply(flight.rest);
      // Bóng trên mặt nỉ: xúc xắc càng cao bóng càng nhỏ, nhìn là biết đang nảy. Còn bay ngoài mâm thì chưa có bóng.
      const shadow = this.diceShadows[i];
      shadow.visible = Math.hypot(die.position.x, die.position.z) < TRAY_RADIUS;
      shadow.position.set(die.position.x, TRAY_TOP + 0.003, die.position.z);
      shadow.scale.setScalar(1 / (1 + lift * 0.4));
    });
    this.diceResting = t >= 1;
    return !this.diceResting;
  }

  private placeBuildings(view: View): void {
    const now = performance.now();
    // Lần đầu vào xem thì nhà đã đứng sẵn, không mọc.
    const first = !this.propsSeen;
    this.propsSeen = true;
    const wanted = new Map<string, { mesh: number; base: THREE.Matrix4 }>();
    const dummy = new THREE.Object3D();
    const set = (mesh: THREE.InstancedMesh, count: number, point: Point, yaw: number, y = 0) => {
      dummy.position.set(point.x, y, point.z);
      dummy.rotation.set(0, yaw, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(count, dummy.matrix);
    };
    let plaques = 0;
    let liens = 0;
    const color = new THREE.Color();
    for (const [key, owned] of Object.entries(view.props)) {
      const index = Number(key);
      const square = SQUARES[index];
      // Nhà quay mặt tiền theo chiều đọc chữ của ô, tức về phía camera.
      const yaw = tileYaw(index);
      if (square.kind === "city") {
        const tier = TIER_OF_GROUP[square.group];
        const spot = (along: number, mesh: number) => {
          const point = inTile(index, along, CORNER / 2 - BAND / 2);
          return { mesh, base: new THREE.Matrix4().makeRotationY(yaw).setPosition(point.x, 0.005, point.z) };
        };
        if (owned.houses === 5) wanted.set(`${index}:hotel`, spot(0, tier * 2 + 1));
        // Mỗi nhà một chỗ cố định trên dải màu, xếp từ trái sang theo chiều đọc chữ: xây thêm thì nhà cũ không phải dời.
        else for (let i = 0; i < owned.houses; i++) wanted.set(`${index}:${i}`, spot((1.5 - i) * HOUSE_SLOT, tier * 2));
      }
      // Tấm biển màu ở mép trước của ô, cạnh giá đất, cho biết đất của ai.
      const owner = view.players.find((p) => p.id === owned.owner);
      set(this.plaques, plaques, inTile(index, 0, -CORNER / 2 + 0.16), yaw, 0.03);
      this.plaques.setColorAt(plaques++, color.set(TOKEN_COLORS[owner?.color ?? 0]));
      if (owned.mortgaged) set(this.liens, liens++, tileCenter(index), yaw, 0.015);
    }
    this.plaques.count = plaques;
    this.liens.count = liens;
    for (const mesh of [this.plaques, this.liens]) mesh.instanceMatrix.needsUpdate = true;
    if (this.plaques.instanceColor) this.plaques.instanceColor.needsUpdate = true;

    // Nhà mới xây thì mọc từ dưới đất lên; nhà bán đi thì lún xuống. Đang lún mà xây lại thì mọc lên từ chỗ đang lún.
    let grew = false;
    for (const [key, spot] of wanted) {
      const old = this.built.get(key);
      if (old?.to === 1) continue;
      this.built.set(key, { ...spot, from: first ? 1 : old ? this.heightOf(old, now) : 0, to: 1, start: first ? -Infinity : now });
      grew ||= !first;
    }
    for (const [key, old] of this.built) {
      if (!wanted.has(key) && old.to === 1) this.built.set(key, { ...old, from: this.heightOf(old, now), to: 0, start: now });
    }
    if (grew) this.events.onBuild();
    this.buildingsMoving = true;
  }

  /** Nhà cao tới đâu ở thời điểm `now`, 1 là đủ cao. */
  private heightOf(built: Built, now: number): number {
    if (built.to === 1) return built.from + (1 - built.from) * backOut(Math.min(1, (now - built.start) / GROW_MS));
    const t = Math.min(1, (now - built.start) / SINK_MS);
    return built.from * (1 - t * t);
  }

  /** Ghi chỗ đứng và độ cao từng nhà vào các khối vẽ. Trả về còn nhà đang mọc hay đang lún không. */
  private poseBuildings(now: number): boolean {
    if (!this.buildingsMoving) return false;
    const counts = this.buildings.map(() => 0);
    const grow = new THREE.Matrix4();
    const matrix = new THREE.Matrix4();
    let moving = false;
    for (const [key, built] of this.built) {
      const done = now - built.start >= (built.to === 1 ? GROW_MS : SINK_MS);
      if (done && built.to === 0) {
        this.built.delete(key);
        continue;
      }
      moving ||= !done;
      // Mọc từ dưới đất lên: cao dần, bề ngang nở dần từ bảy phần.
      const height = this.heightOf(built, now);
      const spread = 0.7 + 0.3 * Math.min(1, height);
      matrix.multiplyMatrices(built.base, grow.makeScale(spread, Math.max(height, 0.001), spread));
      this.buildings[built.mesh].setMatrixAt(counts[built.mesh]++, matrix);
    }
    this.buildings.forEach((mesh, i) => {
      mesh.count = counts[i];
      mesh.instanceMatrix.needsUpdate = true;
    });
    this.buildingsMoving = moving;
    return moving;
  }

  /** Số tiền vừa cộng hay trừ hiện trên đầu người chơi, bay lên rồi mờ đi. */
  floatMoney(playerId: string, amount: number): void {
    if (amount === 0 || !this.tokens.has(playerId)) return;
    const { texture, aspect } = moneyTexture(amount, this.fonts.text);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, sizeAttenuation: false, depthTest: false, transparent: true }));
    sprite.renderOrder = 11;
    this.scene.add(sprite);
    this.floaters.push({ sprite, player: playerId, start: performance.now(), aspect });
    this.busy = true;
  }

  private dropFloater(floater: Floater): void {
    this.scene.remove(floater.sprite);
    floater.sprite.material.map?.dispose();
    floater.sprite.material.dispose();
  }

  /** Tô sáng ô đang xem, `null` để thôi. */
  select(index: number | null): void {
    this.highlight.visible = index !== null;
    if (index !== null) {
      const center = tileCenter(index);
      this.highlight.position.set(center.x, 0.02, center.z);
      this.highlight.rotation.y = sideYaw(sideOf(index));
      this.highlight.scale.set((isCorner(index) ? CORNER : TILE) * 0.96, 1, CORNER * 0.96);
    }
    this.busy = true;
  }

  setMode(mode: CameraMode): void {
    this.mode = mode;
    this.zoom = 1;
    this.pan.set(0, 0, 0);
    // Khóa màn hình thì bàn đứng yên ngay, không trượt từ chỗ cũ về.
    if (mode === "board") this.focus.copy(this.pan);
    this.busy = true;
  }

  /** Chừa `x` điểm ảnh ở hai bên, `y` điểm ảnh ở trên và dưới khi nhìn cả bàn, cho thẻ người chơi và các nút đè lên bàn. */
  setInsets(insets: { x: number; y: number }): void {
    if (insets.x === this.insets.x && insets.y === this.insets.y) return;
    this.insets = { ...insets };
    this.fitCamera();
    this.busy = true;
  }

  /**
   * Đang bán nhà, cầm cố: `offers` là những ô bán được kèm số tiền nhận. Các ô khác tối đi, ô bán được sáng vàng nhấp nháy,
   * số tiền nổi trên ô. `null` thì bàn như thường.
   */
  setFocus(offers: Map<number, number> | null): void {
    for (const { sprite } of this.offers) {
      this.scene.remove(sprite);
      sprite.material.map?.dispose();
      sprite.material.dispose();
    }
    this.offers = [];
    this.focusing = offers !== null;
    let shades = 0;
    let glows = 0;
    const dummy = new THREE.Object3D();
    for (let index = 0; offers && index < SQUARES.length; index++) {
      const center = tileCenter(index);
      dummy.position.set(center.x, offers.has(index) ? 0.035 : 0.03, center.z);
      dummy.rotation.set(0, sideYaw(sideOf(index)), 0);
      dummy.scale.set((isCorner(index) ? CORNER : TILE) * 0.98, 1, CORNER * 0.98);
      dummy.updateMatrix();
      const amount = offers.get(index);
      if (amount === undefined) {
        this.shades.setMatrixAt(shades++, dummy.matrix);
        continue;
      }
      this.glows.setMatrixAt(glows++, dummy.matrix);
      const { texture, aspect } = moneyTexture(amount, this.fonts.text);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, sizeAttenuation: false, depthTest: false, transparent: true }));
      sprite.renderOrder = 9;
      sprite.center.set(0.5, 0);
      sprite.position.set(center.x, 0.9, center.z);
      this.scene.add(sprite);
      this.offers.push({ sprite, aspect });
    }
    this.shades.count = shades;
    this.glows.count = glows;
    this.shades.instanceMatrix.needsUpdate = true;
    this.glows.instanceMatrix.needsUpdate = true;
    this.busy = true;
  }

  private fitCamera(): void {
    const aspect = this.width / this.height;
    this.camera.aspect = aspect;
    const vertical = Math.tan((FOV * Math.PI) / 360);
    const horizontal = vertical * aspect;
    this.followDistance = Math.max(FOLLOW_ACROSS / (2 * horizontal), FOLLOW_ALONG / (2 * vertical));
    // Nhìn cả bàn: bàn hình thoi vừa khít khung, cầm dọc thì vừa bề ngang, cầm ngang thì vừa bề cao.
    const room = (inset: number, size: number) => Math.max(0.4, 1 - (2 * inset) / size);
    const { distance, shift } = boardFit(aspect, room(this.insets.x, this.width), room(this.insets.y, this.height));
    this.boardDistance = distance;
    this.boardShift = shift;
    this.camera.updateProjectionMatrix();
  }

  resize(): void {
    const { clientWidth, clientHeight } = this.canvas;
    if (clientWidth === 0 || clientHeight === 0) return;
    this.width = clientWidth;
    this.height = clientHeight;
    this.renderer.setSize(clientWidth, clientHeight, false);
    this.fitCamera();
    this.placeCamera();
    this.renderer.render(this.scene, this.camera);
  }

  /** Người camera bám theo: người đang tới lượt, không có thì chính mình. */
  private followed(): Token | undefined {
    return (this.current && this.tokens.get(this.current)) || (this.you ? this.tokens.get(this.you) : undefined);
  }

  /** Đưa điểm nhìn về đích. Hướng nhìn không bao giờ đổi, chỉ điểm nhìn trôi theo. Trả về còn đang trôi không. */
  private drift(dt: number): boolean {
    const board = this.mode === "board";
    const token = this.followed();
    const goal = board ? this.pan : token ? token.chibi.position : new THREE.Vector3(0, 0, 0);
    this.focus.x = approach(this.focus.x, goal.x, 3.5, dt);
    this.focus.z = approach(this.focus.z, goal.z, 3.5, dt);
    return Math.hypot(this.focus.x - goal.x, this.focus.z - goal.z) > 0.02;
  }

  private placeCamera(): void {
    const board = this.mode === "board";
    const pitch = board ? BOARD_PITCH : FOLLOW_PITCH;
    const distance = (board ? this.boardDistance : this.followDistance) * this.zoom;
    // Nhìn cả bàn thì dời điểm nhìn về phía góc Xuất phát cho bàn nằm giữa khung. Bám theo quân thì nhìn thẳng vào quân:
    // kéo điểm nhìn vào giữa bàn thì nhà cao giữa phố chắn mất quân ở hai cạnh xa.
    const shift = board ? this.boardShift : 0;
    const x = this.focus.x + shift * Math.sin(VIEW_YAW);
    const z = this.focus.z + shift * Math.cos(VIEW_YAW);
    const flat = Math.cos(pitch) * distance;
    this.camera.position.set(x + Math.sin(VIEW_YAW) * flat, Math.sin(pitch) * distance, z + Math.cos(VIEW_YAW) * flat);
    this.camera.lookAt(x, board ? 0 : 0.6, z);
  }

  private tick = (now: number): void => {
    this.frame = requestAnimationFrame(this.tick);
    if (now - this.lastFrame < (this.busy ? this.busyFrameMs : IDLE_FRAME_MS)) return;
    // Máy vẽ ít hình mỗi giây thì mỗi hình đi xa hơn, để quân vẫn đi đúng nhịp thật và tới nơi đúng lúc.
    const dt = Math.min((now - this.lastFrame) / 1000, 0.25);
    this.lastFrame = now;
    const time = (now - this.startedAt) / 1000;
    this.calm = this.motionQuery.matches;
    // Xúc xắc dừng và mọi người đã kịp nhìn số thì quân mới đi.
    const holding = now < this.holdUntil;
    if (this.held && !holding) for (const token of this.tokens.values()) this.steer(token);
    this.held = holding;

    // Bảng tên giữ nguyên cỡ trên màn hình; nhân vật đã thu nhỏ nên bù lại cho bảng tên.
    const pxToScale = (2 * Math.tan((FOV * Math.PI) / 360)) / this.height;
    // Ô bán được nhấp nháy cho dễ thấy; số tiền nhận giữ nguyên cỡ trên màn hình.
    if (this.focusing) {
      (this.glows.material as THREE.MeshBasicMaterial).opacity = this.calm ? 0.45 : 0.3 + 0.25 * (Math.sin(time * 4) + 1) / 2;
      for (const { sprite, aspect } of this.offers) sprite.scale.set(OFFER_PX * aspect * pxToScale, OFFER_PX * pxToScale, 1);
    }
    let anyMoving = false;
    const crowd = new Map<number, number>();
    for (const token of this.tokens.values()) crowd.set(token.at, (crowd.get(token.at) ?? 0) + 1);
    for (const token of this.tokens.values()) {
      // Nhiều người cùng một ô thì bảng tên đè lên nhau: chỉ giữ tên người đang tới lượt, ai cũng nhận ra nhau qua màu đĩa dưới chân.
      labelOf(token.chibi).visible = token.actor.id === this.current || crowd.get(token.at) === 1;
      const { chibi, path } = token;
      const walking = path.length > 0 && !holding;
      if (walking && Math.hypot(path[0].x - chibi.position.x, path[0].z - chibi.position.z) < TURN_EARLY) {
        path.shift();
        if (path.length > 0) this.events.onStep();
        else token.speed = 1;
        this.steer(token);
      }
      chibi.tick(dt * (walking ? token.speed : 1), time, this.calm, pxToScale, LABEL_PX / CHIBI_SCALE, 0);
      token.base.position.set(chibi.position.x, 0, chibi.position.z);
      anyMoving ||= chibi.moving || path.length > 0;
    }
    // Mũi tên lơ lửng ngay trên bảng tên người đang tới lượt, nhấp nhô nhẹ.
    const turn = this.playing && this.current ? this.tokens.get(this.current) : undefined;
    this.arrow.visible = turn !== undefined;
    if (turn) {
      labelOf(turn.chibi).getWorldPosition(this.arrow.position);
      this.arrow.scale.set(ARROW_PX * 0.8 * pxToScale, ARROW_PX * pxToScale, 1);
      const bob = this.calm ? 2 : (Math.sin(time * 4) + 1) * 4;
      this.arrow.center.set(0.5, -(LABEL_PX + 4 + bob) / ARROW_PX);
    }
    // Số tiền nổi phía trên bảng tên (và trên mũi tên nếu đang tới lượt): phóng to một chút lúc hiện, bay lên, mờ dần.
    this.floaters = this.floaters.filter((floater) => {
      const t = (now - floater.start) / MONEY_MS;
      const token = this.tokens.get(floater.player);
      if (t >= 1 || !token) {
        this.dropFloater(floater);
        return false;
      }
      labelOf(token.chibi).getWorldPosition(floater.sprite.position);
      const pop = 1 + 0.35 * Math.max(0, 1 - t / 0.15);
      floater.sprite.scale.set(MONEY_PX * floater.aspect * pop * pxToScale, MONEY_PX * pop * pxToScale, 1);
      const lift = LABEL_PX + 6 + (token === turn ? ARROW_PX + 8 : 0) + easeOut(t) * 40;
      floater.sprite.center.set(0.5, -lift / (MONEY_PX * pop));
      floater.sprite.material.opacity = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
      return true;
    });
    // Xúc xắc đã dừng và quân người vừa đổ đã đứng yên ở ô cuối: báo cho giao diện, đúng một lần mỗi lượt đổ.
    if (this.arrivalPending && !holding) {
      const mover = this.mover ? this.tokens.get(this.mover) : undefined;
      if (!mover || (mover.path.length === 0 && !mover.chibi.moving)) {
        this.arrivalPending = false;
        this.events.onArrive(this.rolls ?? 0);
      }
    }
    const rolling = this.poseDice(now) || this.poseShake(now);
    const growing = this.poseBuildings(now);
    const drifting = this.drift(dt);
    this.busy =
      anyMoving || rolling || growing || holding || drifting || this.arrivalPending || this.floaters.length > 0 || this.pointers.size > 0 || (this.focusing && !this.calm);
    this.placeCamera();
    this.renderer.render(this.scene, this.camera);
  };

  // Chạm và kéo: bàn không xoay. Chụm hai ngón để thu phóng; nhìn cả bàn mà đã phóng to thì kéo để dời; chạm một ô để xem.

  private onPointerDown = (event: PointerEvent): void => {
    this.canvas.setPointerCapture(event.pointerId);
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pointers.size === 1) this.dragged = 0;
    if (this.pointers.size === 2) {
      this.pinchFrom = this.pinchGap();
      this.zoomFrom = this.zoom;
      this.dragged = 99;
    }
    this.busy = true;
  };

  private pinchGap(): number {
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y) || 1;
  }

  private onPointerMove = (event: PointerEvent): void => {
    const pointer = this.pointers.get(event.pointerId);
    if (!pointer) return;
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.zoomTo((this.zoomFrom * this.pinchFrom) / this.pinchGap(), (a.x + b.x) / 2, (a.y + b.y) / 2);
      return;
    }
    this.dragged += Math.abs(dx) + Math.abs(dy);
    if (this.dragged <= 8 || this.mode !== "board" || this.zoom >= 1) return;
    // Kéo bàn theo ngón tay: chỗ trên bàn nằm dưới ngón tay đi theo ngón tay.
    const from = this.groundAt(event.clientX - dx, event.clientY - dy);
    const to = this.groundAt(event.clientX, event.clientY);
    if (!from || !to) return;
    const shift = from.sub(to).setY(0);
    this.pan.add(shift).clampScalar(-HALF, HALF);
    this.focus.add(shift);
    this.busy = true;
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (!this.pointers.delete(event.pointerId)) return;
    if (this.pointers.size === 0 && this.dragged <= 8) this.tap(event.clientX, event.clientY);
  };

  private onPointerCancel = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
  };

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.zoomTo(this.zoom * (1 + event.deltaY * 0.001), event.clientX, event.clientY);
  };

  /** Thu phóng. Nhìn cả bàn thì giữ nguyên chỗ nằm dưới ngón tay hay con trỏ, để phóng to được vào góc bàn nào cũng được. */
  private zoomTo(zoom: number, clientX: number, clientY: number): void {
    const next = Math.max(0.5, Math.min(1.6, zoom));
    if (this.mode === "board") {
      const point = this.groundAt(clientX, clientY);
      if (point) {
        // Chỗ cách điểm nhìn một đoạn d hiện trên màn hình cách tâm tỉ lệ với d / zoom: dời điểm nhìn chừng này thì chỗ đó đứng yên.
        // Điểm nhìn thật đã dời về phía góc Xuất phát một đoạn `boardShift`.
        const center = this.focus.clone().addScalar(this.boardShift * Math.SQRT1_2).setY(0);
        const shift = point.sub(center).setY(0).multiplyScalar(1 - next / this.zoom);
        this.pan.add(shift).clampScalar(-HALF, HALF);
        this.focus.add(shift);
      }
      // Thu nhỏ hết cỡ thì về giữa bàn như cũ.
      if (next >= 1) this.pan.set(0, 0, 0);
    }
    this.zoom = next;
    this.busy = true;
  }

  /** Điểm trên mặt bàn nằm dưới một điểm trên màn hình. */
  private groundAt(clientX: number, clientY: number): THREE.Vector3 | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / this.width) * 2 - 1, -((clientY - rect.top) / this.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
  }

  private tap(clientX: number, clientY: number): void {
    const point = this.groundAt(clientX, clientY);
    const index = point ? tileAt(point.x, point.z) : null;
    if (index !== null && index < SQUARES.length) this.events.onTile(index);
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.resizeObserver.disconnect();
    const { canvas } = this;
    canvas.removeEventListener("pointerdown", this.onPointerDown);
    canvas.removeEventListener("pointermove", this.onPointerMove);
    canvas.removeEventListener("pointerup", this.onPointerUp);
    canvas.removeEventListener("pointercancel", this.onPointerCancel);
    canvas.removeEventListener("wheel", this.onWheel);
    for (const token of this.tokens.values()) {
      token.chibi.dispose();
      (token.disc.material as THREE.Material).dispose();
    }
    for (const floater of this.floaters) this.dropFloater(floater);
    this.setFocus(null);
    this.boardMaterial.map?.dispose();
    this.kit.dispose();
    for (const thing of this.owned) thing.dispose();
    for (const mesh of [...this.buildings, this.plaques, this.liens, this.shades, this.glows]) mesh.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
