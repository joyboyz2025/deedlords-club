// Xem trước nhân vật trong tủ đồ: một khung vẽ nhỏ riêng, chỉ có một người đứng trên chiếc chiếu (look-scene.ts).

import * as THREE from "three";
import type { Look } from "../look";
import { CAMERA_FOV, LookScene, frameCamera } from "./look-scene";

const TURN_PER_PX = 0.012;
/** Điện thoại chạy 30 hình mỗi giây là đủ và đỡ nóng máy. */
const COARSE_FRAME_MS = 31;

export class LookPreview {
  private renderer: THREE.WebGLRenderer;
  private camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 30);
  private stage: LookScene;
  private turn = 0;
  private dragX: number | null = null;
  private frame = 0;
  private lastTime = 0;
  private lastDraw = 0;
  private frameMs: number;
  private calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  private resizeObserver: ResizeObserver;

  constructor(
    private canvas: HTMLCanvasElement,
    look: Look,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, coarse ? 1.75 : 2));
    this.frameMs = coarse ? COARSE_FRAME_MS : 0;
    this.stage = new LookScene(look);

    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
    this.frame = requestAnimationFrame(this.tick);
  }

  setLook(look: Look): void {
    if (this.stage.setLook(look)) this.resize();
  }

  private resize(): void {
    const { clientWidth: width, clientHeight: height } = this.canvas;
    if (width === 0 || height === 0) return;
    this.renderer.setSize(width, height, false);
    // Lùi đủ xa để cả mũ rộng lẫn đồ cầm tay đều nằm gọn trong khung, dọc hay ngang cũng vậy.
    frameCamera(this.camera, this.stage.fit, width / height);
    this.draw(this.lastTime);
  }

  private tick = (now: number): void => {
    this.frame = requestAnimationFrame(this.tick);
    if (now - this.lastDraw < this.frameMs) return;
    this.draw(now / 1000);
    this.lastDraw = now;
  };

  private draw(time: number): void {
    const dt = Math.min(time - this.lastTime, 0.1);
    this.lastTime = time;
    // Đung đưa nhẹ để thấy được cả hông nhân vật; đang kéo thì đứng yên theo tay.
    const sway = this.calm || this.dragX !== null ? 0 : Math.sin(time * 0.7) * 0.38;
    this.stage.pose(this.turn + sway, Math.max(dt, 0), time, this.calm);
    this.renderer.render(this.stage.scene, this.camera);
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.dragX = event.clientX;
    this.canvas.setPointerCapture(event.pointerId);
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (this.dragX === null) return;
    this.turn += (event.clientX - this.dragX) * TURN_PER_PX;
    this.dragX = event.clientX;
  };

  private onPointerUp = (): void => {
    this.dragX = null;
  };

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.stage.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
