// Hợp đồng tin nhắn giữa trình duyệt và TycoonRoom.

import type { Look } from "../ma-soi/look.ts";
import type { View } from "./view.ts";

/** Độ dài ván chủ phòng được chọn, tính bằng phút. 0 là chơi tới khi chỉ còn một người. */
export const LIMIT_CHOICES = [0, 30, 45, 60] as const;
/** Mỗi lần đi qua Xuất phát nhận chừng này, chủ phòng chọn ở phòng chờ. */
export const SALARY_CHOICES = [200, 500, 700, 1000] as const;
/** Vốn mỗi người lúc vào ván, chủ phòng chọn ở phòng chờ. */
export const CASH_CHOICES = [1500, 3000, 5000] as const;
/** Người tới lượt để quá chừng này giây thì máy bấm hộ: đổ xúc xắc, bỏ qua mua đất, hết lượt. 0 là chờ mãi. */
export const AUTO_CHOICES = [0, 10, 20, 30] as const;

/** Đề nghị đổi: `give` là đất người đề nghị đưa, `take` là đất muốn lấy của người kia. */
export type Offer = { to: string; give: number[]; take: number[]; giveCash: number; takeCash: number };

export type ClientMessage =
  /** `look` chỉ dùng khi đây là người mới vào phòng. `pin` chỉ cần khi phòng có khóa và đây là người mới. */
  | { t: "hello"; name: string; id?: string; secret?: string; hostKey?: string; look?: Look; pin?: string }
  /** Chủ phòng cho phòng hiện hay ẩn trong danh sách thị trấn. */
  | { t: "listed"; listed: boolean }
  /** Chủ phòng đặt PIN 4 số, `null` là bỏ khóa. */
  | { t: "pin"; pin: string | null }
  /** Ở phòng chờ: vào chơi ván tới hay chỉ xem. */
  | { t: "play"; on: boolean }
  /** Chủ phòng, ở phòng chờ. */
  | { t: "limit"; minutes: number }
  | { t: "salary"; amount: number }
  | { t: "cash"; amount: number }
  | { t: "auto"; seconds: number }
  | { t: "start" }
  /** Người đang tới lượt. */
  | { t: "roll" }
  | { t: "buy" }
  | { t: "skip" }
  | { t: "end" }
  | { t: "bail" }
  | { t: "card" }
  | { t: "pay" }
  | { t: "bankrupt" }
  /** Give up the game, at any time (on-chain matches). */
  | { t: "resign" }
  /** Play a ticket (on-chain matches with tickets). `steps`: 2 to 12, for "Pick your steps". */
  | { t: "ticket"; ticket: "waiver" | "steps" | "takeover" | "festival"; steps?: number }
  /** Người chơi nào cũng làm được với đất của mình, bất cứ lúc nào trong ván. */
  | { t: "build"; square: number }
  | { t: "sell"; square: number }
  | { t: "mortgage"; square: number }
  | { t: "redeem"; square: number }
  | { t: "offer"; offer: Offer }
  | { t: "answer"; accept: boolean }
  | { t: "withdraw" }
  /** Chủ phòng: hết ván thì về phòng chờ, giữa ván thì hủy ván. */
  | { t: "lobby" };

/** `closed-idle`: không ai chơi nên phòng tự đóng. `pin`: phòng có khóa mà PIN thiếu hoặc sai. `pin-wait`: nhập sai quá nhiều lần, đợi 10 phút. */
export type ErrorCode = "no-room" | "full" | "closed-idle" | "pin" | "pin-wait";

export type ServerMessage = View | { t: "error"; code: ErrorCode };
