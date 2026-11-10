// Một người đứng trên chiếc chiếu, có xe, thú cưng đang dùng. Dùng chung cho khung xem trước của tủ đồ (preview.ts)
// và ảnh vẽ sẵn cho app HSK (games/town/chibi-draw.ts).

import * as THREE from "three";
import type { Look } from "../look";
import { Chibi, ChibiKit } from "./chibi";
import { PET_SHAPES } from "./pets";
import { RideModel, mountOf } from "./rides";
import type { Actor } from "./state";

export const CAMERA_FOV = 28;
export type Fit = { center: number; height: number; width: number };
/** Khung vừa một người; có xe hay thú cưng thì lùi xa hơn cho vừa cả xe, cả con. */
export const PLAIN_FIT: Fit = { center: 0.86, height: 2.1, width: 1.75 };
export const WIDE_FIT: Fit = { center: 1, height: 2.7, width: 2.7 };
/** Thú cưng đứng bên tay không cầm đồ của nhân vật, nhìn chếch về phía người xem. */
const PET_SPOT = { x: -0.62, z: 0.2, turn: 0.5 };
const PET_FLY = 0.95;
/** Máy ảnh cao hơn tâm khung một chút, nhìn hơi từ trên xuống. */
const CAMERA_LIFT = 0.28;

const actorWith = (look: Look): Actor => ({
  id: "preview",
  name: "",
  look,
  pose: "stand",
  wolf: false,
  walkTo: null,
  pointAt: null,
  mark: null,
  badge: null,
  title: null,
  self: false,
  away: false,
  pickable: false,
  mount: mountOf(look),
});

export class LookScene {
  readonly scene = new THREE.Scene();
  /** Khung vừa bộ đồ đang mặc: rộng hơn khi có xe hay thú cưng. */
  fit: Fit = PLAIN_FIT;
  private kit = new ChibiKit("sans-serif");
  private chibi: Chibi;
  private mat: THREE.Mesh;
  private spot = new THREE.Vector2();
  private turn = 0;
  private ride: RideModel | null = null;
  private pet: THREE.Mesh | null = null;
  private petIndex = 0;

  constructor(look: Look) {
    this.chibi = new Chibi(this.kit, actorWith(look));
    const hemi = new THREE.HemisphereLight("#fff3d6", "#c79a63", 2.5);
    const sun = new THREE.DirectionalLight("#ffe6b8", 2.1);
    sun.position.set(-3, 6, 5);
    this.mat = new THREE.Mesh(new THREE.CircleGeometry(0.72, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: "#1b1712", transparent: true, opacity: 0.16 }));
    this.mat.position.y = 0.005;
    this.scene.add(hemi, sun, this.mat, this.chibi.root);
    // Đặt bộ đồ ngay khi dựng để khung vừa từ đầu, kể cả khi có xe, thú cưng.
    this.setLook(look);
  }

  /** Đổi bộ đồ. Trả về `true` nếu khung đổi theo: vừa có hay vừa bỏ xe, thú cưng. */
  setLook(look: Look): boolean {
    this.chibi.assign(actorWith(look), this.turn, this.spot, null);
    const ride = look.ride ?? 0;
    if ((this.ride?.index ?? 0) !== ride) {
      if (this.ride) this.scene.remove(this.ride.root);
      this.ride = ride > 0 ? new RideModel(this.kit, ride) : null;
      if (this.ride) this.scene.add(this.ride.root);
      else this.chibi.root.position.y = 0;
    }
    const pet = look.pet ?? 0;
    if (this.petIndex !== pet) {
      if (this.pet) this.scene.remove(this.pet);
      this.pet = pet > 0 ? new THREE.Mesh(this.kit.pet(pet), this.kit.solid) : null;
      this.petIndex = pet;
      if (this.pet) {
        this.pet.position.set(PET_SPOT.x, PET_SHAPES[pet].flies ? PET_FLY : 0, PET_SPOT.z);
        this.pet.rotation.y = PET_SPOT.turn;
        this.scene.add(this.pet);
      }
    }
    const fit = ride > 0 || pet > 0 ? WIDE_FIT : PLAIN_FIT;
    if (fit === this.fit) return false;
    this.fit = fit;
    return true;
  }

  /** Đặt dáng: quay `turn` radian, chạy hoạt cảnh thêm `dt` giây tới lúc `time`. */
  pose(turn: number, dt: number, time: number, calm: boolean): void {
    this.turn = turn;
    this.chibi.assign(this.chibi.actor, turn, this.spot, null);
    this.chibi.tick(dt, time, calm, 0, 0, 0);
    if (this.ride) this.chibi.root.position.y = this.ride.follow(0, 0, this.chibi.root.rotation.y, false, time, calm);
  }

  dispose(): void {
    this.chibi.dispose();
    this.kit.dispose();
    this.mat.geometry.dispose();
    (this.mat.material as THREE.Material).dispose();
  }
}

/** Lùi máy ảnh đủ xa để khung `fit` nằm gọn trong hình tỉ lệ `aspect`, dọc hay ngang cũng vậy. */
export function frameCamera(camera: THREE.PerspectiveCamera, fit: Fit, aspect: number, lift = CAMERA_LIFT): void {
  camera.aspect = aspect;
  const halfFov = THREE.MathUtils.degToRad(camera.fov) / 2;
  const distance = Math.max(fit.height, fit.width / aspect) / (2 * Math.tan(halfFov));
  camera.position.set(0, fit.center + lift, distance);
  camera.lookAt(0, fit.center, 0);
  camera.updateProjectionMatrix();
}
