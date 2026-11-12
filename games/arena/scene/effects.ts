// What a fight throws off: sparks, slashes, shots with a trail, lightning, shock rings, domes and the numbers that rise
// from a blow. All of it is for the eye. Nothing here decides anything, so it may use chance freely.

import * as THREE from "three";

/** One colour per kind of ability, so that a heal reads as a heal whoever casts it. */
export const OP_COLOR: Record<string, string> = { dmg: "#ff7a3d", heal: "#5fd38a", shield: "#9fd3ff", stun: "#ffe25a", haste: "#7fe6ff", energize: "#ffe25a", weaken: "#b48cf2", drain: "#b48cf2", ramp: "#ff7a3d" };

/** Where a unit can be hit: on the ground under it, at its chest, above its head. */
export type Body = { foot: THREE.Vector3; chest: THREE.Vector3; head: THREE.Vector3 };

type Range = number | [number, number];
const within = (range: Range) => (typeof range === "number" ? range : range[0] + Math.random() * (range[1] - range[0]));
const spread = () => Math.random() * 2 - 1;

type Puff = {
  color: string | string[];
  /** `ball`: every way. `disc`: outwards along the ground. `up` and `down`: a narrow column. */
  shape?: "ball" | "disc" | "up" | "down";
  speed?: Range;
  life?: Range;
  size?: Range;
  /** How far from the point a spark may start. */
  radius?: number;
  gravity?: number;
  drag?: number;
  /** How much a spark has grown by the end of its life (smoke swells, sparks do not). */
  grow?: number;
  alpha?: number;
};

const MOST = 1800;

/** Glowing points, drawn in one call and moved on the processor: a spark lives a fraction of a second. */
class Sparks {
  readonly points: THREE.Points;
  private place = new Float32Array(MOST * 3);
  private tint = new Float32Array(MOST * 3);
  private look = new Float32Array(MOST * 2);
  private speed = new Float32Array(MOST * 3);
  private age = new Float32Array(MOST);
  private life = new Float32Array(MOST);
  private size = new Float32Array(MOST);
  private pull = new Float32Array(MOST);
  private drag = new Float32Array(MOST);
  private grow = new Float32Array(MOST);
  private alpha = new Float32Array(MOST);
  private next = 0;
  private colors = new Map<string, THREE.Color>();
  private material = new THREE.ShaderMaterial({
    uniforms: { scale: { value: 1000 } },
    vertexShader: `
      attribute vec3 tint;
      attribute vec2 look;
      uniform float scale;
      varying vec3 vTint;
      void main() {
        vTint = tint * look.y;
        vec4 seen = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = look.x * scale / -seen.z;
        gl_Position = projectionMatrix * seen;
      }`,
    fragmentShader: `
      varying vec3 vTint;
      void main() {
        float far = length(gl_PointCoord - 0.5) * 2.0;
        float halo = pow(max(0.0, 1.0 - far), 2.4);
        float core = smoothstep(0.3, 0.0, far);
        gl_FragColor = vec4(vTint * (halo * 0.8 + core * 0.7), 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });

  constructor() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(this.place, 3));
    geometry.setAttribute("tint", new THREE.BufferAttribute(this.tint, 3));
    geometry.setAttribute("look", new THREE.BufferAttribute(this.look, 2));
    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
  }

  emit(count: number, at: THREE.Vector3, puff: Puff): void {
    const colors = typeof puff.color === "string" ? [puff.color] : puff.color;
    for (let made = 0; made < count; made++) {
      const i = this.next;
      this.next = (this.next + 1) % MOST;
      const shape = puff.shape ?? "ball";
      const way =
        shape === "disc" ? new THREE.Vector3(spread(), Math.random() * 0.12, spread())
        : shape === "up" ? new THREE.Vector3(spread() * 0.3, 1, spread() * 0.3)
        : shape === "down" ? new THREE.Vector3(spread() * 0.2, -1, spread() * 0.2)
        : new THREE.Vector3(spread(), spread(), spread());
      way.normalize().multiplyScalar(within(puff.speed ?? 0));
      const off = puff.radius ?? 0;
      this.place.set([at.x + spread() * off, at.y + (shape === "ball" ? spread() * off : 0), at.z + spread() * off], i * 3);
      this.speed.set([way.x, way.y, way.z], i * 3);
      const name = colors[Math.floor(Math.random() * colors.length)];
      let color = this.colors.get(name);
      if (!color) this.colors.set(name, (color = new THREE.Color(name)));
      this.tint.set([color.r, color.g, color.b], i * 3);
      this.age[i] = 0;
      this.life[i] = within(puff.life ?? 0.4);
      this.size[i] = within(puff.size ?? 0.2);
      this.pull[i] = puff.gravity ?? 0;
      this.drag[i] = puff.drag ?? 0;
      this.grow[i] = puff.grow ?? 0;
      this.alpha[i] = puff.alpha ?? 1;
    }
  }

  /** `scale` is how many pixels a unit of length covers one unit away from the camera. */
  update(dt: number, scale: number): void {
    this.material.uniforms.scale.value = scale;
    for (let i = 0; i < MOST; i++) {
      if (this.life[i] === 0) continue;
      this.age[i] += dt;
      const k = this.age[i] / this.life[i];
      if (k >= 1) {
        this.life[i] = 0;
        this.look[i * 2] = 0;
        continue;
      }
      const slow = Math.max(0, 1 - this.drag[i] * dt);
      this.speed[i * 3 + 1] -= this.pull[i] * dt;
      for (let axis = 0; axis < 3; axis++) {
        this.speed[i * 3 + axis] *= slow;
        this.place[i * 3 + axis] += this.speed[i * 3 + axis] * dt;
      }
      this.look[i * 2] = this.size[i] * (1 + this.grow[i] * k);
      this.look[i * 2 + 1] = this.alpha[i] * (1 - k) ** 1.5;
    }
    for (const attribute of Object.values(this.points.geometry.attributes)) (attribute as THREE.BufferAttribute).needsUpdate = true;
  }

  clear(): void {
    this.life.fill(0);
    this.look.fill(0);
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}

/** Something that lasts `life` seconds: `step` is given how far through it is, from 0 to 1. */
type Timed = { object: THREE.Object3D | null; age: number; life: number; step: (k: number, dt: number) => void; end?: () => void; free?: () => void };

export class Effects {
  /** How hard the ground is shaking, in units; it dies away by itself. */
  shake = 0;
  private scene: THREE.Scene;
  private sparks = new Sparks();
  private timed: Timed[] = [];
  private waiting: { at: number; run: () => void }[] = [];
  private clock = 0;
  private circle = new THREE.RingGeometry(0.91, 1, 64).rotateX(-Math.PI / 2);
  private arc = Effects.crescent();
  private ball = new THREE.SphereGeometry(1, 28, 18);
  private digits = new Map<string, THREE.CanvasTexture>();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    scene.add(this.sparks.points);
  }

  /** A blade's sweep: an arc that bulges along +x and tapers to a point at both ends. */
  private static crescent(): THREE.ShapeGeometry {
    const blade = new THREE.Shape();
    blade.absarc(0, 0, 0.9, -1, 1, false);
    // The inner edge is a wider circle through the same two ends.
    blade.absarc(-0.5, 0, 1.243, 0.655, -0.655, true);
    return new THREE.ShapeGeometry(blade, 24);
  }

  /** True while something that should be seen to its end is still playing. */
  get busy(): boolean {
    return this.timed.length > 0 || this.waiting.length > 0;
  }

  /** Runs `run` after `delay` seconds of the fight's own time. */
  later(delay: number, run: () => void): void {
    this.waiting.push({ at: this.clock + delay, run });
  }

  private glow(color: string, opacity = 1): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  }

  private add(object: THREE.Object3D | null, life: number, step: Timed["step"], end?: () => void, free?: () => void): void {
    if (object) this.scene.add(object);
    this.timed.push({ object, age: 0, life, step, end, free });
    step(0, 0);
  }

  /** A ring on the ground that widens from `from` to `to` units across its life and fades. */
  ring(at: THREE.Vector3, color: string, life: number, from: number, to: number): void {
    const material = this.glow(color);
    const mesh = new THREE.Mesh(this.circle, material);
    mesh.position.set(at.x, at.y + 0.08, at.z);
    this.add(mesh, life, (k) => {
      mesh.scale.setScalar(from + (to - from) * (1 - (1 - k) ** 2));
      material.opacity = (1 - k) * 0.85;
    }, undefined, () => material.dispose());
  }

  /** A blow landing: a flash and sparks thrown from the point. */
  hit(at: THREE.Vector3, color: string, heavy = false): void {
    this.sparks.emit(1, at, { color: [color, "#ffffff"], life: 0.12, size: heavy ? 1.8 : 1.0, alpha: 0.55 });
    this.sparks.emit(heavy ? 32 : 14, at, { color: [color, color, "#ffffff", "#ffe6b0"], speed: [2.5, heavy ? 8 : 6], life: [0.2, 0.45], size: [0.07, 0.2], gravity: 9, drag: 1.6 });
    if (heavy) this.shake = Math.max(this.shake, 0.07);
  }

  /** The sweep of a blade or a hammer through `at`, cutting along `toward`. */
  slash(at: THREE.Vector3, toward: THREE.Vector3, color: string): void {
    const material = this.glow(color);
    const mesh = new THREE.Mesh(this.arc, material);
    const turn = new THREE.Group();
    turn.position.copy(at);
    // The arc stands in the plane of the blow, leaning a little to one side or the other.
    turn.rotation.set(0, Math.atan2(toward.x, toward.z) - Math.PI / 2, 0);
    mesh.rotation.x = spread() * 0.5;
    turn.add(mesh);
    this.add(turn, 0.18, (k) => {
      mesh.rotation.z = 1.1 - k * 1.8;
      mesh.scale.setScalar(1 + k * 0.3);
      material.opacity = 0.8 * (1 - k) ** 0.7;
    }, undefined, () => material.dispose());
  }

  /** A glowing shot from `from` to `to`, lifted by `arc` at the middle of its flight, leaving a trail. */
  shot(from: THREE.Vector3, to: THREE.Vector3, color: string, life: number, arc: number, then?: () => void): void {
    const at = new THREE.Vector3();
    let last = 0;
    const along = (k: number) => {
      at.lerpVectors(from, to, k);
      at.y += Math.sin(k * Math.PI) * arc;
      return at;
    };
    this.add(null, life, (k) => {
      // The trail is laid along the whole stretch flown since the last frame, so it has no gaps.
      for (let part = 1; part <= 5; part++) this.sparks.emit(2, along(last + ((k - last) * part) / 5), { color: [color, color, "#ffffff"], speed: [0, 0.5], life: [0.14, 0.34], size: [0.09, 0.2], radius: 0.04 });
      this.sparks.emit(1, along(k), { color: "#ffffff", life: 0.07, size: 0.5 });
      last = k;
    }, then);
  }

  /** Lightning from `from` to `to`: a crooked line that jumps twice before it goes out. */
  bolt(from: THREE.Vector3, to: THREE.Vector3, color: string): void {
    const material = this.glow(color);
    const crooked = () => {
      const points = Array.from({ length: 7 }, (_, index) => {
        const point = new THREE.Vector3().lerpVectors(from, to, index / 6);
        if (index > 0 && index < 6) point.add(new THREE.Vector3(spread(), spread(), spread()).multiplyScalar(0.28));
        return point;
      });
      return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 18, 0.045, 5);
    };
    const mesh = new THREE.Mesh(crooked(), material);
    let shape = 0;
    this.add(mesh, 0.26, (k) => {
      if (Math.floor(k * 3) !== shape) {
        shape = Math.floor(k * 3);
        mesh.geometry.dispose();
        mesh.geometry = crooked();
      }
      material.opacity = 0.55 + Math.random() * 0.45;
    }, undefined, () => {
      mesh.geometry.dispose();
      material.dispose();
    });
    for (let step = 1; step < 6; step++) this.sparks.emit(2, new THREE.Vector3().lerpVectors(from, to, step / 6), { color: [color, "#ffffff"], speed: [0.3, 1.5], life: [0.15, 0.35], size: [0.15, 0.32] });
  }

  /** A dome of light over a unit, which swells and thins out. */
  dome(body: Body, color: string): void {
    const material = new THREE.ShaderMaterial({
      uniforms: { tint: { value: new THREE.Color(color) }, strength: { value: 0 } },
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vToEye;
        void main() {
          vec4 seen = modelViewMatrix * vec4(position, 1.0);
          vNormal = normalMatrix * normal;
          vToEye = -seen.xyz;
          gl_Position = projectionMatrix * seen;
        }`,
      fragmentShader: `
        uniform vec3 tint;
        uniform float strength;
        varying vec3 vNormal;
        varying vec3 vToEye;
        void main() {
          float rim = pow(1.0 - abs(dot(normalize(vNormal), normalize(vToEye))), 2.4);
          gl_FragColor = vec4(tint * (0.05 + rim) * strength, 1.0);
        }`,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(this.ball, material);
    mesh.position.copy(body.chest);
    this.add(mesh, 0.95, (k) => {
      mesh.scale.setScalar(1.0 + 0.3 * (1 - (1 - k) ** 3));
      material.uniforms.strength.value = Math.sin(Math.min(1, k * 1.15) * Math.PI) ** 0.8;
    }, undefined, () => material.dispose());
  }

  /** A number that rises from a unit and fades: what a blow took, or what a heal gave. */
  number(at: THREE.Vector3, text: string, color: string): void {
    const key = color + text;
    let texture = this.digits.get(key);
    if (!texture) {
      const canvas = Object.assign(document.createElement("canvas"), { width: 192, height: 96 });
      const ctx = canvas.getContext("2d")!;
      ctx.font = "900 68px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineJoin = "round";
      ctx.lineWidth = 12;
      ctx.strokeStyle = "rgba(14, 16, 26, 0.9)";
      ctx.strokeText(text, 96, 50);
      ctx.fillStyle = color;
      ctx.fillText(text, 96, 50);
      texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      this.digits.set(key, texture);
    }
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(material);
    sprite.renderOrder = 9;
    const start = at.clone().add(new THREE.Vector3(spread() * 0.4, 0.1, 0));
    this.add(sprite, 0.6, (k) => {
      sprite.position.set(start.x, start.y + (1 - (1 - k) ** 2) * 0.7, start.z);
      // It pops a little larger than it settles.
      const pop = k < 0.15 ? 0.6 + (k / 0.15) * 0.55 : 1.15 - Math.min(0.15, (k - 0.15) * 0.5);
      sprite.scale.set(0.84 * pop, 0.42 * pop, 1);
      material.opacity = k < 0.65 ? 1 : 1 - (k - 0.65) / 0.35;
    }, undefined, () => material.dispose());
  }

  /**
   * An ability going off. `op` is what it does and `who` whom it reaches, as the unit data names them; `tint` is the
   * caster's guild colour, which colours the abilities that hurt.
   */
  cast(op: string, who: string, tint: string, from: Body, to: Body[]): void {
    const color = OP_COLOR[op] ?? tint;
    this.ring(from.foot, color, 0.5, 0.45, 1.25);
    if (op === "dmg" && who === "around") {
      // A blast from where the caster stands: two rings racing out, dust along the ground, steam above.
      this.ring(from.foot, "#fff1d0", 0.5, 0.4, 3.6);
      this.ring(from.foot, tint, 0.75, 0.3, 3.1);
      this.sparks.emit(90, from.foot.clone().setY(from.foot.y + 0.15), { color: [tint, tint, "#ffffff", "#ffd9a0"], shape: "disc", speed: [4, 8.5], life: [0.4, 0.75], size: [0.1, 0.3], drag: 2.2 });
      this.sparks.emit(22, from.foot, { color: ["#ffffff", "#d8e6f0"], shape: "up", speed: [1, 2.8], life: [0.6, 1.1], size: [0.5, 0.9], grow: 1.2, alpha: 0.3, radius: 0.5 });
      this.shake = 0.14;
      for (const body of to) this.later(0.08 + from.foot.distanceTo(body.foot) * 0.05, () => this.hit(body.chest, tint, true));
    } else if (op === "dmg" && who === "three") {
      // Lightning from the caster's raised hand to each target in turn.
      this.sparks.emit(1, from.head, { color: "#ffffff", life: 0.16, size: 2.2 });
      to.forEach((body, index) =>
        this.later(index * 0.07, () => {
          this.bolt(from.head, body.chest, "#bfe6ff");
          this.hit(body.chest, "#9fd3ff", true);
        }),
      );
    } else if (op === "dmg") {
      // A flare lobbed at the first target; it bursts there and its sparks reach the others.
      const [first, ...others] = to;
      if (!first) return;
      this.shot(from.head, first.chest, tint, 0.3, 0.7, () => {
        this.sparks.emit(1, first.chest, { color: "#ffffff", life: 0.16, size: 3.2 });
        this.sparks.emit(40, first.chest, { color: [tint, "#ffffff", "#ffc46b"], speed: [2.5, 7.5], life: [0.25, 0.6], size: [0.16, 0.4], gravity: 5, drag: 1.4 });
        this.ring(first.foot, tint, 0.5, 0.3, 1.9);
        this.shake = Math.max(this.shake, 0.1);
        for (const body of others) this.later(0.07, () => this.hit(body.chest, tint, true));
      });
    } else if (op === "drain") {
      // What is taken flows back from each target to the caster.
      for (const body of to) this.shot(body.chest, from.chest, color, 0.36, 0.5, () => this.sparks.emit(14, from.chest, { color: [color, "#ffffff"], speed: [1, 3], life: [0.2, 0.45], size: [0.14, 0.3] }));
    } else {
      for (const body of to.length ? to : [from]) {
        if (body !== from) this.ring(body.foot, color, 0.55, op === "weaken" ? 1.5 : 0.45, op === "weaken" ? 0.5 : 1.2);
        if (op === "shield") this.dome(body, color);
        if (op === "stun") {
          this.hit(body.chest, color, true);
          this.ring(body.head, color, 0.85, 0.35, 0.6);
          this.sparks.emit(14, body.head, { color: [color, "#ffffff"], shape: "disc", speed: [0.6, 1.4], life: [0.5, 0.9], size: [0.16, 0.3], drag: 2 });
        }
        if (op === "heal") this.sparks.emit(22, body.foot, { color: [color, "#d9ffe6"], shape: "up", speed: [0.9, 2.4], life: [0.7, 1.2], size: [0.16, 0.34], radius: 0.5 });
        if (op === "haste") this.sparks.emit(20, body.foot, { color: [color, "#ffffff"], shape: "up", speed: [5, 9], life: [0.22, 0.4], size: [0.12, 0.26], radius: 0.5 });
        if (op === "energize") this.sparks.emit(22, body.foot, { color: [color, "#ffffff"], shape: "up", speed: [2, 4.5], life: [0.4, 0.8], size: [0.14, 0.3], radius: 0.55 });
        if (op === "weaken") this.sparks.emit(22, body.head.clone().setY(body.head.y + 0.6), { color: [color, "#e6d8ff"], shape: "down", speed: [2, 4], life: [0.4, 0.7], size: [0.16, 0.32], radius: 0.45 });
        if (op === "ramp") this.sparks.emit(34, body.foot, { color: [color, "#ffd27a", "#ff4b2b"], shape: "up", speed: [2, 5.5], life: [0.4, 0.85], size: [0.2, 0.45], radius: 0.45, drag: 0.8 });
      }
    }
  }

  /** `height` is the drawing's height in pixels: sparks are sized in the scene's units. */
  update(dt: number, height: number, camera: THREE.PerspectiveCamera): void {
    this.clock += dt;
    const due = this.waiting.filter((wait) => wait.at <= this.clock);
    this.waiting = this.waiting.filter((wait) => wait.at > this.clock);
    for (const wait of due) wait.run();
    const done: Timed[] = [];
    for (const each of this.timed) {
      each.age += dt;
      each.step(Math.min(1, each.age / each.life), dt);
      if (each.age >= each.life) done.push(each);
    }
    this.timed = this.timed.filter((each) => each.age < each.life);
    for (const each of done) {
      this.drop(each);
      each.end?.();
    }
    this.sparks.update(dt, height / (2 * Math.tan((camera.fov * Math.PI) / 360)));
    this.shake *= Math.max(0, 1 - dt * 9);
  }

  private drop(each: Timed): void {
    if (each.object) this.scene.remove(each.object);
    each.free?.();
  }

  /** Takes everything off the floor at once, nothing landing afterwards. */
  clear(): void {
    for (const each of this.timed) this.drop(each);
    this.timed = [];
    this.waiting = [];
    this.sparks.clear();
    this.shake = 0;
  }

  dispose(): void {
    this.clear();
    this.scene.remove(this.sparks.points);
    this.sparks.dispose();
    for (const texture of this.digits.values()) texture.dispose();
    for (const shape of [this.circle, this.arc, this.ball]) shape.dispose();
  }
}
