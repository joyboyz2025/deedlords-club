// Hai con xúc xắc tung giữa bàn: khối bo góc dán ảnh sáu mặt, bay từ phía người đổ vào mâm,
// nảy hai lần rồi nằm yên đúng số server đã đổ. Phần tính toán ở đây không vẽ gì nên test được.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

/** To cỡ này để nhìn cả bàn từ xa vẫn đọc được số. */
export const DIE_SIZE = 1.3;
/** Mặt hộp theo thứ tự +x, -x, +y, -y, +z, -z mang số này; hai mặt đối nhau cộng lại bằng 7 như xúc xắc thật. */
const FACE_VALUES = [2, 5, 1, 6, 3, 4];
const NORMALS = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, -1, 0),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(0, 0, -1),
];
const UP = new THREE.Vector3(0, 1, 0);

/** Khối xúc xắc bo góc. Mỗi mặt lấy một ô trong ảnh sáu mặt xếp 3 × 2, ô của số `n` ở cột `(n - 1) % 3`, hàng `(n - 1) / 3`. */
export function dieGeometry(): THREE.BufferGeometry {
  const geometry = new RoundedBoxGeometry(DIE_SIZE, DIE_SIZE, DIE_SIZE, 3, 0.17);
  const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
  // Khối bo góc không dùng chỉ số đỉnh: sáu mặt nối đuôi nhau theo thứ tự +x, -x, +y, -y, +z, -z, mỗi mặt một phần sáu số đỉnh.
  const perFace = uv.count / 6;
  for (let i = 0; i < uv.count; i++) {
    const value = FACE_VALUES[Math.floor(i / perFace)];
    const column = (value - 1) % 3;
    const row = Math.floor((value - 1) / 3);
    // Ảnh lật dọc khi dán: hàng trên cùng của ảnh nằm ở nửa trên của tọa độ ảnh.
    uv.setXY(i, (column + uv.getX(i)) / 3, (1 - row) * 0.5 + uv.getY(i) / 2);
  }
  geometry.clearGroups();
  return geometry;
}

/** Hướng quay để mặt mang số `value` ngửa lên trời, rồi xoay quanh trục đứng một góc `yaw`. */
export function restQuaternion(value: number, yaw: number): THREE.Quaternion {
  const face = NORMALS[FACE_VALUES.indexOf(value)];
  const upright = new THREE.Quaternion().setFromUnitVectors(face, UP);
  return new THREE.Quaternion().setFromAxisAngle(UP, yaw).multiply(upright);
}

/** Số đang ngửa lên của con xúc xắc quay theo `quaternion`. */
export function valueUp(quaternion: THREE.Quaternion): number {
  let best = 0;
  let value = 1;
  NORMALS.forEach((normal, i) => {
    const height = normal.clone().applyQuaternion(quaternion).y;
    if (height > best) {
      best = height;
      value = FACE_VALUES[i];
    }
  });
  return value;
}

/** Độ cao trên mặt mâm theo tiến độ `t` từ 0 tới 1: rơi xuống, nảy hai lần nhỏ dần, rồi nằm yên. */
export function bounceHeight(t: number): number {
  if (t < 0.5) return 3 * (1 - (t / 0.5) ** 2);
  if (t < 0.72) {
    const s = (t - 0.5) / 0.22;
    return 0.65 * 4 * s * (1 - s);
  }
  if (t < 0.86) {
    const s = (t - 0.72) / 0.14;
    return 0.2 * 4 * s * (1 - s);
  }
  return 0;
}

/** Chạy nhanh rồi chậm dần: dùng cho đường bay ngang và vòng lăn của xúc xắc. */
export const easeOut = (t: number) => 1 - (1 - Math.min(Math.max(t, 0), 1)) ** 3;
