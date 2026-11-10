// Phần mỗi người được xem. Cờ tỷ phú không có bí mật về ván chơi (thẻ rút có hoàn lại, không có chồng thẻ xáo sẵn);
// chỉ khóa `secret` của từng người là riêng, nên mọi dữ liệu gửi đi chỉ qua file này.

import type { AccessView } from "../../lib/roomAccess.ts";
import { lookFromSeat, type Look } from "../ma-soi/look.ts";
import { CARDS, type Deck } from "./board.ts";
import { canBuild, canMortgage, canSell, currentPlayer, netWorth, redeemPrice, type Game, type Owned, type Payee, type Phase, type Result, type Stage, type Trade } from "./engine.ts";

export type PublicPlayer = {
  id: string;
  name: string;
  online: boolean;
  isHost: boolean;
  wantsToPlay: boolean;
  color: number | null;
  cash: number;
  position: number;
  jail: number | null;
  freeCards: number;
  bankrupt: boolean;
  worth: number;
  look: Look;
};

export type View = {
  t: "view";
  code: string;
  phase: Phase;
  you: {
    id: string;
    secret: string;
    name: string;
    isHost: boolean;
    /** Những ô người này đang xây thêm, bán bớt nhà, cầm cố hay chuộc được, để máy chỉ sáng đúng nút. */
    can: { build: number[]; sell: number[]; mortgage: number[]; redeem: number[] };
  };
  players: PublicPlayer[];
  settings: Game["settings"];
  order: string[];
  current: string | null;
  stage: Stage;
  dice: [number, number] | null;
  again: boolean;
  /** Completed rounds; the game ends when it reaches `settings.maxRounds` (if set). */
  round: number;
  props: Record<number, Owned>;
  debt: Payee[] | null;
  card: { deck: Deck; text: string } | null;
  log: string[];
  trade: Trade | null;
  /** Còn bao lâu thì hết giờ, `null` khi chơi tới khi còn một người hoặc đang tạm dừng. */
  endsInMs: number | null;
  lastRound: boolean;
  /** Đếm số lần đổ xúc xắc, để máy biết khi nào vẽ quân đi từng bước. */
  rolls: number;
  result: Result | null;
  /** Người đang tới lượt vắng nên ván đứng yên: còn chừng này nữa chưa quay lại thì người đó bị loại. */
  pause: { away: string; leftMs: number } | null;
  /** Còn chừng này thì máy bấm hộ người đang tới lượt (đổ, bỏ qua mua đất, hết lượt); `null` là không hẹn. */
  autoInMs: number | null;
  /** Phòng có hiện trong danh sách thị trấn không, có khóa không. Phòng ghép vào sau `viewFor`; chỉ chủ phòng thấy PIN. */
  access?: AccessView;
};

export function viewFor(
  game: Game,
  viewerId: string,
  context: { code: string; online: Set<string>; now: number; pause?: { away: string; leftMs: number } | null; autoAt?: number | null },
): View {
  const viewer = game.players.find((p) => p.id === viewerId)!;
  const mine = Object.keys(game.props)
    .map(Number)
    .filter((i) => game.props[i].owner === viewer.id);
  const can = {
    build: mine.filter((i) => canBuild(game, viewer.id, i)),
    sell: mine.filter((i) => canSell(game, viewer.id, i)),
    mortgage: mine.filter((i) => canMortgage(game, viewer.id, i)),
    redeem: mine.filter((i) => game.props[i].mortgaged && viewer.cash >= redeemPrice(i)),
  };
  return {
    t: "view",
    code: context.code,
    phase: game.phase,
    you: { id: viewer.id, secret: viewer.secret, name: viewer.name, isHost: viewer.isHost, can },
    players: game.players.map((player, seat) => ({
      id: player.id,
      name: player.name,
      online: context.online.has(player.id),
      isHost: player.isHost,
      wantsToPlay: player.wantsToPlay,
      color: player.color,
      cash: player.cash,
      position: player.position,
      jail: player.jail,
      freeCards: player.freeCards.length,
      bankrupt: player.bankrupt,
      worth: netWorth(game, player.id),
      look: player.look ?? lookFromSeat(seat),
    })),
    settings: game.settings,
    order: game.order,
    current: currentPlayer(game)?.id ?? null,
    stage: game.stage,
    dice: game.dice,
    again: game.again,
    round: game.round ?? 0,
    props: game.props,
    debt: game.debt,
    card: game.card && { deck: game.card.deck, text: CARDS[game.card.deck][game.card.index].text },
    log: game.log,
    trade: game.trade,
    endsInMs: game.endsAt === null ? null : Math.max(game.endsAt - context.now, 0),
    lastRound: game.lastRound,
    rolls: game.rolls,
    result: game.result,
    pause: context.pause ?? null,
    autoInMs: context.autoAt == null ? null : Math.max(context.autoAt - context.now, 0),
  };
}
