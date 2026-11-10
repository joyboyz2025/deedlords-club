// Luật đóng phòng, dùng chung cho mọi game.

/** Giữa ván hoặc đã hết ván mà không ai làm gì trong chừng này thì đóng phòng. Phòng chờ không tính: mọi người còn đang đợi nhau. */
export const IDLE_MS = 10 * 60 * 1000;
/** Quản trò vắng giữa ván: ván đứng yên, chờ chừng này rồi đóng phòng. */
export const HOST_AWAY_MS = 10 * 60 * 1000;
/** Tải lại trang hay đổi mạng thì vài giây là về, nên mất kết nối chừng này mới dừng ván. */
export const HOST_GRACE_MS = 10 * 1000;
