// Từ thứ server gửi cho người này, tính ra ai đang ngồi, ngủ, đi lại ở đâu trong đình.
// File này chỉ đọc View, nên người đang ngủ không thể thấy gì mà server chưa gửi cho họ.
//
// Standalone deedlords copy: only the types and pure helpers that the chibi characters (chibi.ts, look-scene.ts)
// and the property-game scene (games/co-ty-phu/scene/tycoon.ts) use. The werewolf-only `sceneFromView` and
// `SeatPicks` were removed so this file no longer pulls in the Ma Sói engine, roles and view.

import type { Look } from "../look.ts";
import type { Mount } from "./rides.ts";

export type Pose = "sit" | "sleep" | "stand" | "ghost" | "cheer";
export type Mark = "chosen" | "pick" | "wolf" | "safe" | "charm";

/** Đi tới đâu thay vì về chỗ ngồi của mình. Tọa độ tính trên vòng tròn, chưa xoay theo góc nhìn. */
export type Spot = { x: number; z: number } | { near: string; slot: number } | "center";

export type Actor = {
  id: string;
  name: string;
  look: Look;
  pose: Pose;
  wolf: boolean;
  walkTo: Spot | null;
  /** Người này đang bầu cho ai: quay mặt về phía đó và giơ tay chỉ, như bỏ phiếu ngoài đời. */
  pointAt: string | null;
  mark: Mark | null;
  badge: string | null;
  title: string | null;
  self: boolean;
  away: boolean;
  pickable: boolean;
  /** Tốc độ đi, mét mỗi giây; không có thì như cũ. Thị trấn đặt theo giày. */
  speed?: number;
  /** Đi giày patin: lướt chứ không bước. */
  glide?: boolean;
  /** Màu viền bảng tên theo món có cấp cao nhất đang mặc; chỉ thị trấn đặt. */
  rim?: string | null;
  /** Đang ngồi, đứng trên xe: tư thế và độ cao; chỉ thị trấn đặt. */
  mount?: Mount | null;
};

export type SceneState = {
  time: "day" | "night";
  actors: Actor[];
  threads: { from: string; to: string; kind: "love" }[];
  /** Người xem chạm sàn để đi lại được: lúc đang thức ban đêm, và trong phòng chờ. */
  canWalk: boolean;
  selfId: string | null;
  /** Người mới vào phòng chờ thì đi bộ vào chỗ. */
  arriving: boolean;
};

export function ringRadius(count: number): number {
  return Math.max(2.4, (count * 1.2) / (2 * Math.PI));
}

export function seatAngle(index: number, count: number): number {
  return (index / Math.max(count, 1)) * Math.PI * 2;
}
