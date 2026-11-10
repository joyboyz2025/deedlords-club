// Phần vẽ của file vẽ nhân vật cho app HSK (public/town/chibi-v1.js): ảnh đầu và vai, ảnh toàn thân, khung tủ đồ.
// Chỉ chạy trong trình duyệt có WebGL; không có thì hai hàm vẽ ảnh báo lỗi, mountPreview ném lỗi.

import * as THREE from "three";
import type { Look } from "../ma-soi/look.ts";
import { CAMERA_FOV, LookScene, frameCamera, type Fit } from "../ma-soi/scene/look-scene.ts";
import { LookPreview } from "../ma-soi/scene/preview.ts";

/** Ảnh đầu và vai: đầu đứng yên cao khoảng 0,97, chừa chỗ phía trên cho mũ cao như Mũ vua (thử trên trình duyệt). */
const PORTRAIT_FIT: Fit = { center: 1.08, height: 1.36, width: 1.36 };
/** Chụp gần ngang tầm mắt. */
const PORTRAIT_LIFT = 0.08;
/** Quay chếch một chút cho thấy khối, như dáng đứng trong tủ đồ. */
const TURN = 0.3;

type Still = { renderer: THREE.WebGLRenderer; camera: THREE.PerspectiveCamera; stage: LookScene };
let still: Still | null = null;
/** Vẽ lần lượt trên một khung ẩn duy nhất: vẽ cả lớp 30 người vẫn chỉ mở một khung WebGL. */
let queue: Promise<unknown> = Promise.resolve();

function stillFor(look: Look): Still {
  if (!still) {
    const renderer = new THREE.WebGLRenderer({ canvas: document.createElement("canvas"), antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    still = { renderer, camera: new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 30), stage: new LookScene(look) };
  } else {
    still.stage.setLook(look);
  }
  return still;
}

function draw(look: Look, px: number, fit: (stage: LookScene) => Fit, lift?: number): Promise<string> {
  const job = queue.then(() => {
    const { renderer, camera, stage } = stillFor(look);
    renderer.setSize(px, px, false);
    // Chạy hoạt cảnh tới khi đứng yên hẳn rồi mới chụp.
    for (let time = 1; time <= 3; time++) stage.pose(TURN, 1, time, true);
    frameCamera(camera, fit(stage), 1, lift);
    renderer.render(stage.scene, camera);
    const webp = renderer.domElement.toDataURL("image/webp", 0.9);
    return webp.startsWith("data:image/webp") ? webp : renderer.domElement.toDataURL("image/png");
  });
  queue = job.catch(() => undefined);
  return job;
}

/** Ảnh đầu và vai, nền trong suốt, vuông `px` × `px`. Không vẽ thú cưng, xe. */
export function drawPortrait(look: Look, px: number): Promise<string> {
  return draw({ ...look, pet: 0, ride: 0 }, px, () => PORTRAIT_FIT, PORTRAIT_LIFT);
}

/** Ảnh toàn thân như khung tủ đồ, có cả thú cưng, xe đang dùng, vuông `px` × `px`. */
export function drawFigure(look: Look, px: number): Promise<string> {
  return draw(look, px, (stage) => stage.fit);
}

/** Khung xem trước của tủ đồ thị trấn trên `canvas` của app HSK: kéo để xoay. */
export function mountPreview(canvas: HTMLCanvasElement, look: Look): { setLook(look: Look): void; dispose(): void } {
  const preview = new LookPreview(canvas, look);
  return { setLook: (next) => preview.setLook(next), dispose: () => preview.dispose() };
}
