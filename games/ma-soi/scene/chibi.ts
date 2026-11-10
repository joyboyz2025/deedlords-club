// Nhân vật đầu to thân nhỏ, dựng hoàn toàn từ khối cơ bản nên không phải tải model nào.
// Hình khối dùng chung giữa mọi nhân vật, mỗi người chỉ giữ tư thế của mình.

import * as THREE from "three";
import { lookKey, type Look } from "../look";
import { armGeometry, capsule, eyesGeometry, headGeometry, legGeometry, merged, painted, sphere, torsoGeometry } from "./parts";
import { petFlameGeometry, petGeometry } from "./pets";
import { rideBodyGeometry, rideWheelGeometry, type Mount } from "./rides";
import type { Actor, Mark, Pose } from "./state";
import { badgeTexture, labelTexture, sleepTexture } from "./textures";

const FUR = "#34407c";
const FUR_LIGHT = "#d7d3e2";

/** Khối hình dùng chung. Hủy một lần khi rời trang. */
export class ChibiKit {
  readonly solid = new THREE.MeshLambertMaterial({ vertexColors: true });
  readonly ghost = new THREE.MeshLambertMaterial({ color: "#e8f1ff", transparent: true, opacity: 0.62, emissive: "#8fa8d8", emissiveIntensity: 0.55 });
  readonly eyeBlack = new THREE.MeshBasicMaterial({ color: "#1b1712" });
  readonly eyeWolf = new THREE.MeshBasicMaterial({ color: "#ffd23f" });
  readonly marks: Record<Mark, THREE.MeshBasicMaterial>;
  readonly ringGeometry = new THREE.RingGeometry(0.46, 0.6, 32).rotateX(-Math.PI / 2);
  readonly sleepMap = sleepTexture();
  readonly labelFamily: string;

  private cache = new Map<string, THREE.BufferGeometry>();
  private badges = new Map<string, THREE.SpriteMaterial>();

  constructor(labelFamily: string) {
    this.labelFamily = labelFamily;
    const ring = (color: string, opacity: number) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
    this.marks = {
      chosen: ring("#ff4a2e", 0.95),
      pick: ring("#fff3c4", 0.42),
      wolf: ring("#ff2a1a", 0.9),
      safe: ring("#58d17a", 0.9),
      charm: ring("#c79bff", 0.9),
    };
  }

  private get(key: string, build: () => THREE.BufferGeometry): THREE.BufferGeometry {
    let geometry = this.cache.get(key);
    if (!geometry) {
      geometry = build();
      this.cache.set(key, geometry);
    }
    return geometry;
  }

  head(look: Look): THREE.BufferGeometry {
    return this.get(`head${look.body}.${look.skin}.${look.hair}.${look.hairColor}.${look.hat}.${look.face}`, () => headGeometry(look));
  }

  wolfHead(): THREE.BufferGeometry {
    return this.get("wolfHead", () => {
      const ear = (x: number, roll: number) => painted(new THREE.ConeGeometry(0.13, 0.3, 8).rotateZ(roll).translate(x, 0.38, -0.02), FUR);
      const inner = (x: number, roll: number) => painted(new THREE.ConeGeometry(0.07, 0.18, 8).rotateZ(roll).translate(x, 0.36, 0.06), "#c8321e");
      const fang = (x: number) => painted(new THREE.ConeGeometry(0.032, 0.09, 6).rotateX(Math.PI).translate(x, -0.2, 0.44), "#fff8e6");
      return merged([
        sphere(0.36, FUR, 0, 0, 0, 1.06, 0.94, 0.98, 20),
        ear(-0.24, 0.32),
        ear(0.24, -0.32),
        inner(-0.24, 0.32),
        inner(0.24, -0.32),
        sphere(0.19, FUR_LIGHT, 0, -0.11, 0.3, 1.05, 0.72, 1),
        sphere(0.06, "#14131c", 0, -0.04, 0.47, 1.1, 0.8, 0.8),
        fang(-0.075),
        fang(0.075),
      ]);
    });
  }

  eyes(body: number): THREE.BufferGeometry {
    return this.get(`eyes${body}`, () => eyesGeometry(body));
  }

  wolfEyes(): THREE.BufferGeometry {
    return this.get("wolfEyes", () => {
      const eye = (x: number, roll: number) => new THREE.SphereGeometry(0.058, 10, 8).scale(1.3, 0.7, 0.5).rotateZ(roll).translate(x, 0.02, 0);
      return merged([eye(-0.15, -0.35), eye(0.15, 0.35)]);
    });
  }

  torso(look: Look): THREE.BufferGeometry {
    return this.get(`torso${look.body}.${look.skin}.${look.outfit}.${look.robe}.${look.neck}`, () => torsoGeometry(look));
  }

  wolfTorso(): THREE.BufferGeometry {
    return this.get("wolfTorso", () => {
      const profile = [[0, 0], [0.28, 0], [0.31, 0.06], [0.27, 0.22], [0.2, 0.38], [0.16, 0.46], [0, 0.47]].map(([x, y]) => new THREE.Vector2(x, y));
      const tail = new THREE.CapsuleGeometry(0.085, 0.3, 3, 8).rotateX(-0.9).translate(0, 0.2, -0.36);
      const tip = new THREE.SphereGeometry(0.095, 8, 8).translate(0, 0.34, -0.5);
      return merged([
        painted(new THREE.LatheGeometry(profile, 16), FUR),
        sphere(0.17, FUR_LIGHT, 0, 0.22, 0.16, 1, 1.1, 0.7),
        painted(tail, FUR),
        painted(tip, FUR_LIGHT),
      ]);
    });
  }

  wolfArm(): THREE.BufferGeometry {
    return this.get("wolfArm", () => merged([capsule(0.07, 0.15, FUR).translate(0, -0.11, 0), sphere(0.078, FUR_LIGHT, 0, -0.25, 0)]));
  }

  wolfLeg(): THREE.BufferGeometry {
    return this.get("wolfLeg", () => merged([capsule(0.082, 0.07, FUR).translate(0, -0.08, 0), sphere(0.09, FUR_LIGHT, 0, -0.17, 0.035, 1, 0.68, 1.35)]));
  }

  /** `held` là món cầm trên cánh tay này; tay còn lại truyền 0. */
  arm(look: Look, held = 0): THREE.BufferGeometry {
    return this.get(`arm${look.body}.${look.skin}.${look.outfit}.${look.robe}.${held}`, () => armGeometry(look, held));
  }

  leg(look: Look): THREE.BufferGeometry {
    return this.get(`leg${look.body}.${look.skin}.${look.outfit}.${look.robe}.${look.shoes ?? 0}`, () => legGeometry(look));
  }

  /** Thú cưng (số thứ tự trong nhóm Thú cưng), dùng chung giữa mọi người dắt cùng một con. */
  pet(index: number): THREE.BufferGeometry {
    return this.get(`pet${index}`, () => petGeometry(index));
  }

  petFlame(): THREE.BufferGeometry {
    return this.get("petFlame", petFlameGeometry);
  }

  rideBody(index: number): THREE.BufferGeometry {
    return this.get(`ride${index}`, () => rideBodyGeometry(index));
  }

  rideWheel(index: number): THREE.BufferGeometry {
    return this.get(`rideWheel${index}`, () => rideWheelGeometry(index));
  }

  badge(text: string): THREE.SpriteMaterial {
    let material = this.badges.get(text);
    if (!material) {
      material = new THREE.SpriteMaterial({ map: badgeTexture(text), depthTest: false, sizeAttenuation: false, transparent: true });
      this.badges.set(text, material);
    }
    return material;
  }

  dispose(): void {
    for (const geometry of this.cache.values()) geometry.dispose();
    for (const material of this.badges.values()) {
      material.map?.dispose();
      material.dispose();
    }
    this.ringGeometry.dispose();
    this.sleepMap.dispose();
    for (const material of [this.solid, this.ghost, this.eyeBlack, this.eyeWolf, ...Object.values(this.marks)]) material.dispose();
  }
}

type Posture = { y: number; tilt: number; legs: number; arms: number; scale: number };

const POSTURES: Record<Pose | "walk", Posture> = {
  sit: { y: 0.1, tilt: 0, legs: -1.32, arms: -0.45, scale: 1 },
  stand: { y: 0.25, tilt: 0, legs: 0, arms: -0.05, scale: 1 },
  walk: { y: 0.25, tilt: 0, legs: 0, arms: 0, scale: 1 },
  sleep: { y: 0.15, tilt: -Math.PI / 2, legs: 0, arms: -0.05, scale: 1 },
  ghost: { y: 0.62, tilt: 0, legs: 0.3, arms: -0.2, scale: 0.86 },
  cheer: { y: 0.25, tilt: 0, legs: 0, arms: -2.75, scale: 1 },
};

const LABEL_Y: Record<Pose | "walk", number> = { sit: 1.2, stand: 1.38, walk: 1.38, sleep: 0.62, ghost: 1.62, cheer: 1.42 };

/** Tư thế trên xe: ngồi thì như ngồi chiếu, đứng thì như đứng; cả người nâng lên chỗ ngồi, tay cầm lái. */
function mounted(mount: Mount): Posture {
  const base = mount.seat ? POSTURES.sit : POSTURES.stand;
  return { y: base.y + mount.y, tilt: 0, legs: base.legs, arms: mount.arms, scale: 1 };
}

/** Góc giơ tay phải ra trước để chỉ vào người mình bầu. */
const POINT_ARM = -1.45;
const WALK_SPEED = 2.5;
const GHOST_SPEED = 1.4;
/** Một lần bấm Dùng kéo dài chừng này. */
const GESTURE_SECONDS = 1.5;

const approach = (from: number, to: number, rate: number, dt: number) => from + (to - from) * (1 - Math.exp(-rate * dt));

function turnToward(from: number, to: number, rate: number, dt: number): number {
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + delta * (1 - Math.exp(-rate * dt));
}

/** Một người trong đình. Không tự quyết định gì: làng bảo đi đâu, tư thế gì thì làm vậy. */
export class Chibi {
  readonly root = new THREE.Group();
  actor: Actor;
  /** Đang đi: làng cần vẽ nhanh hơn lúc mọi người ngồi yên. */
  moving = false;
  /** Đang làm động tác của nút Dùng: cảnh cần vẽ nhanh như lúc có người đi. */
  gesturing = false;

  private rig = new THREE.Group();
  private head = new THREE.Group();
  private skull: THREE.Mesh;
  private eyes: THREE.Mesh;
  private torso: THREE.Mesh;
  private armL: THREE.Mesh;
  private armR: THREE.Mesh;
  private legL: THREE.Mesh;
  private legR: THREE.Mesh;
  private ring: THREE.Mesh;
  private label: THREE.Sprite;
  private labelMaterial: THREE.SpriteMaterial;
  private labelKey = "";
  private labelAspect = 1;
  private badge: THREE.Sprite | null = null;
  private zzz: THREE.Sprite | null = null;

  private rest: number | null = 0;
  private dest = new THREE.Vector2();
  private faceSpot: THREE.Vector2 | null = null;
  private posture: Posture = { ...POSTURES.sit };
  private labelY = LABEL_Y.sit;
  private stride = Math.random() * 6;
  private strideWeight = 0;
  private pointWeight = 0;
  private blinkAt = 1 + Math.random() * 4;
  private blink = 0;
  private pop = 0;
  private lookKey = "";
  private seed = Math.random() * 100;
  private gestureKind: "wave" | "raise" = "wave";
  private gestureLeft = 0;
  private gestureWeight = 0;
  private glideWeight = 0;

  constructor(private kit: ChibiKit, actor: Actor) {
    this.actor = actor;
    const { solid } = kit;
    const { look } = actor;
    this.torso = new THREE.Mesh(kit.torso(look), solid);
    this.skull = new THREE.Mesh(kit.head(look), solid);
    this.eyes = new THREE.Mesh(kit.eyes(look.body), kit.eyeBlack);
    this.armL = new THREE.Mesh(kit.arm(look), solid);
    this.armR = new THREE.Mesh(kit.arm(look, look.held), solid);
    this.legL = new THREE.Mesh(kit.leg(look), solid);
    this.legR = new THREE.Mesh(kit.leg(look), solid);

    this.head.position.y = 0.72;
    this.eyes.position.set(0, 0.015, 0.325);
    this.head.add(this.skull, this.eyes);
    this.armL.position.set(-0.22, 0.4, 0);
    this.armR.position.set(0.22, 0.4, 0);
    this.armL.rotation.z = -0.22;
    this.armR.rotation.z = 0.22;
    this.legL.position.set(-0.115, 0.02, 0);
    this.legR.position.set(0.115, 0.02, 0);
    this.rig.add(this.torso, this.head, this.armL, this.armR, this.legL, this.legR);

    this.ring = new THREE.Mesh(kit.ringGeometry, kit.marks.pick);
    this.ring.position.y = 0.035;
    this.ring.visible = false;

    this.labelMaterial = new THREE.SpriteMaterial({ depthTest: false, sizeAttenuation: false, transparent: true });
    this.label = new THREE.Sprite(this.labelMaterial);
    this.label.center.set(0.5, 0);
    this.label.renderOrder = 10;

    this.root.add(this.rig, this.ring, this.label);
  }

  placeAt(x: number, z: number): void {
    this.root.position.set(x, 0, z);
  }

  get position(): THREE.Vector3 {
    return this.root.position;
  }

  /** Nhận trạng thái mới từ làng. `dest` là nơi phải tới; `faceSpot` là người phải nhìn khi tới nơi; `rest` là hướng quay mặt khi đứng yên, `null` thì giữ nguyên hướng vừa đi. */
  assign(actor: Actor, rest: number | null, dest: THREE.Vector2, faceSpot: THREE.Vector2 | null): void {
    this.actor = actor;
    this.rest = rest;
    this.dest.copy(dest);
    this.faceSpot = faceSpot;
    this.applyLook();
    this.applyLabel();
    this.applyMark();
    this.applyBadge();
    this.applySleep();
  }

  private applyLook(): void {
    const { kit } = this;
    const { look, wolf, pose } = this.actor;
    const ghost = pose === "ghost";
    const key = `${lookKey(look)}|${wolf}|${ghost}`;
    if (key === this.lookKey) return;
    if (this.lookKey && this.lookKey !== key) this.pop = 1;
    this.lookKey = key;

    this.skull.geometry = wolf ? kit.wolfHead() : kit.head(look);
    this.torso.geometry = wolf ? kit.wolfTorso() : kit.torso(look);
    this.armL.geometry = wolf ? kit.wolfArm() : kit.arm(look);
    this.armR.geometry = wolf ? kit.wolfArm() : kit.arm(look, look.held);
    this.legL.geometry = this.legR.geometry = wolf ? kit.wolfLeg() : kit.leg(look);
    this.eyes.geometry = wolf ? kit.wolfEyes() : kit.eyes(look.body);
    this.eyes.material = wolf ? kit.eyeWolf : kit.eyeBlack;

    const body = ghost ? kit.ghost : kit.solid;
    for (const mesh of [this.torso, this.skull, this.armL, this.armR, this.legL, this.legR]) mesh.material = body;
    this.eyes.visible = true;
  }

  private applyLabel(): void {
    const { name, title, self, away, rim } = this.actor;
    const shown = self ? "Bạn" : name;
    const key = `${shown}|${title}|${self}|${rim ?? ""}`;
    this.labelMaterial.opacity = away ? 0.5 : 1;
    if (key === this.labelKey) return;
    this.labelKey = key;
    this.labelMaterial.map?.dispose();
    const { texture, aspect } = labelTexture(shown, title, self, this.kit.labelFamily, rim ?? null);
    this.labelMaterial.map = texture;
    this.labelMaterial.needsUpdate = true;
    this.labelAspect = aspect;
  }

  /** Vẽ lại bảng tên khi font của trang tải xong. */
  redrawLabel(): void {
    this.labelKey = "";
    this.applyLabel();
  }

  /** Bấm Dùng: vẫy hoặc giơ món đang cầm lên. Đang làm dở thì bỏ qua, nên tin báo về của chính mình không làm lại từ đầu. */
  gesture(kind: "wave" | "raise"): void {
    if (this.gestureLeft > 0) return;
    this.gestureKind = kind;
    this.gestureLeft = GESTURE_SECONDS;
  }

  private applyMark(): void {
    const { mark } = this.actor;
    this.ring.visible = mark !== null;
    if (mark) this.ring.material = this.kit.marks[mark];
  }

  private applyBadge(): void {
    const { badge } = this.actor;
    if (!badge) {
      if (this.badge) this.badge.visible = false;
      return;
    }
    if (!this.badge) {
      this.badge = new THREE.Sprite();
      this.badge.renderOrder = 11;
      this.root.add(this.badge);
    }
    this.badge.material = this.kit.badge(badge);
    this.badge.visible = true;
  }

  private applySleep(): void {
    const asleep = this.actor.pose === "sleep";
    if (asleep && !this.zzz) {
      this.zzz = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.kit.sleepMap, transparent: true, depthWrite: false, color: "#dfe7ff" }));
      this.zzz.scale.setScalar(0.42);
      this.root.add(this.zzz);
    }
    if (this.zzz) this.zzz.visible = asleep;
  }

  /** `guard` là bán kính của trống đồng: nhân vật đi vòng quanh chứ không xuyên qua. */
  tick(dt: number, time: number, calm: boolean, pxToScale: number, labelPx: number, guard: number): void {
    const { actor, root } = this;
    const gapX = this.dest.x - root.position.x;
    const gapZ = this.dest.y - root.position.z;
    const gap = Math.hypot(gapX, gapZ);
    const ghost = actor.pose === "ghost";
    const moving = gap > 0.05;
    this.moving = moving;

    if (moving) {
      const step = Math.min(gap, (ghost ? GHOST_SPEED : (actor.speed ?? WALK_SPEED)) * dt);
      root.position.x += (gapX / gap) * step;
      root.position.z += (gapZ / gap) * step;
      root.rotation.y = turnToward(root.rotation.y, Math.atan2(gapX, gapZ), 9, dt);
      const fromCenter = Math.hypot(root.position.x, root.position.z);
      if (fromCenter < guard && fromCenter > 0.001) {
        root.position.x *= guard / fromCenter;
        root.position.z *= guard / fromCenter;
      }
    } else {
      const at = this.faceSpot;
      const facing = at ? Math.atan2(at.x - root.position.x, at.y - root.position.z) : this.rest;
      if (facing !== null) root.rotation.y = turnToward(root.rotation.y, facing, 6, dt);
    }

    // Đang trên đường thì đứng đi, tới nơi rồi mới ngồi hoặc nằm xuống. Hồn ma thì lướt. Trên xe thì giữ tư thế trên xe.
    const key: Pose | "walk" = moving && !ghost ? "walk" : actor.pose;
    const mount = actor.mount ?? null;
    const goal = mount ? mounted(mount) : POSTURES[key];
    const posture = this.posture;
    const rate = 8;
    posture.y = approach(posture.y, goal.y, rate, dt);
    posture.tilt = approach(posture.tilt, goal.tilt, rate, dt);
    posture.legs = approach(posture.legs, goal.legs, rate, dt);
    posture.arms = approach(posture.arms, goal.arms, rate, dt);
    posture.scale = approach(posture.scale, goal.scale, rate, dt);
    this.labelY = approach(this.labelY, LABEL_Y[key] + (mount?.y ?? 0), rate, dt);
    // Đi giày patin thì lướt: chân không bước, người hơi đổ về trước. Trên xe thì chân cũng không bước.
    const gliding = key === "walk" && Boolean(actor.glide) && !mount;
    this.strideWeight = approach(this.strideWeight, key === "walk" && !gliding && !mount ? 1 : 0, 10, dt);
    this.glideWeight = approach(this.glideWeight, gliding ? 1 : 0, 8, dt);

    const swing = Math.sin(this.stride) * this.strideWeight;
    // Đi nhanh thì bước nhanh theo, để chân không trượt trên mặt đất.
    if (key === "walk") this.stride += dt * 11 * ((actor.speed ?? WALK_SPEED) / WALK_SPEED);

    const t = time + this.seed;
    const breathing = calm ? 0 : Math.sin(t * 1.7) * 0.012;
    const bounce = this.strideWeight * Math.abs(Math.sin(this.stride)) * 0.07;
    const hover = ghost && !calm ? Math.sin(t * 1.8) * 0.07 : 0;
    const hop = actor.pose === "cheer" && !calm ? Math.abs(Math.sin(t * 5)) * 0.28 : 0;
    this.rig.position.y = posture.y + bounce + hover + hop;
    this.rig.rotation.x = posture.tilt + this.glideWeight * 0.14;
    this.pop = approach(this.pop, 0, 5, dt);
    const scale = posture.scale * (1 + this.pop * 0.35);
    this.rig.scale.set(scale * (1 - breathing), scale * (1 + breathing), scale * (1 - breathing));

    this.legL.rotation.x = posture.legs + swing * 0.75;
    this.legR.rotation.x = posture.legs - swing * 0.75;
    const wave = actor.pose === "cheer" && !calm ? Math.sin(t * 9) * 0.25 : 0;
    this.armL.rotation.x = posture.arms - swing * 0.65 + wave;
    this.armR.rotation.x = posture.arms + swing * 0.65 - wave;
    // Bỏ phiếu: giơ tay phải chỉ thẳng vào người mình bầu.
    this.pointWeight = approach(this.pointWeight, actor.pointAt && !moving ? 1 : 0, 6, dt);
    this.armR.rotation.x += (POINT_ARM - this.armR.rotation.x) * this.pointWeight;
    // Bấm Dùng: tay phải giơ món đang cầm lên; vẫy thì lắc qua lại.
    this.gestureLeft = Math.max(0, this.gestureLeft - dt);
    this.gestureWeight = approach(this.gestureWeight, this.gestureLeft > 0.2 ? 1 : 0, 10, dt);
    this.gesturing = this.gestureLeft > 0 || this.gestureWeight > 0.01;
    const lift = this.gestureKind === "wave" ? -2.5 : -2.9;
    this.armR.rotation.x += (lift - this.armR.rotation.x) * this.gestureWeight;
    const sway = this.gestureKind === "wave" && !calm ? Math.sin(t * 12) * 0.45 : 0;
    this.armR.rotation.z = 0.22 + (0.15 + sway) * this.gestureWeight;

    // Đầu gật nhẹ như đang nghe nhau nói.
    const nod = actor.pose === "sit" && !calm ? Math.sin(t * 0.8) * 0.05 : 0;
    this.head.rotation.x = nod;
    this.head.rotation.z = actor.pose === "sit" && !calm ? Math.sin(t * 0.53) * 0.05 : 0;

    const closed = actor.pose === "sleep" || ghost;
    if (time > this.blinkAt) {
      this.blinkAt = time + 2 + Math.random() * 4;
      this.blink = 1;
    }
    this.blink = approach(this.blink, 0, 18, dt);
    this.eyes.scale.y = closed ? 0.16 : actor.wolf ? 1 : 1 - this.blink * 0.85;

    if (this.ring.visible) {
      const pulse = actor.mark === "pick" ? 1 : 1 + Math.sin(time * 5) * 0.06;
      this.ring.scale.setScalar(pulse);
    }

    // Bảng tên giữ nguyên kích thước trên màn hình, không bị bé đi ở phía xa.
    const labelHeight = labelPx * pxToScale * (actor.title ? 1.6 : 1);
    this.label.scale.set(labelHeight * this.labelAspect, labelHeight, 1);
    this.label.position.y = this.labelY;
    if (this.badge?.visible) {
      const size = 26 * pxToScale;
      this.badge.scale.set(size, size, 1);
      // Hai tấm cùng tỉ lệ trên màn hình, nên đẩy lên đúng bằng chiều cao bảng tên là vừa khít.
      this.badge.center.set(0.5, -labelHeight / size);
      this.badge.position.y = this.labelY;
    }
    if (this.zzz?.visible) {
      const drift = calm ? 0.5 : (t * 0.35) % 1;
      this.zzz.position.set(0, 0.58 + drift * 0.34, -0.72);
      (this.zzz.material as THREE.SpriteMaterial).opacity = calm ? 0.8 : Math.sin(drift * Math.PI);
    }
  }

  dispose(): void {
    this.labelMaterial.map?.dispose();
    this.labelMaterial.dispose();
    if (this.zzz) (this.zzz.material as THREE.SpriteMaterial).dispose();
  }
}
