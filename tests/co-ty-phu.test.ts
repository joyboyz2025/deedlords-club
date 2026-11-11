// Luật Cờ tỷ phú: đi quân, mua đất, tiền thuê, nhà, cầm cố, tạm giữ, thẻ, nợ, phá sản, đổi đất, hết giờ,
// và các ván máy tự chơi ngẫu nhiên: ván nào cũng kết thúc, tiền không tự sinh ra hay mất đi, không có trạng thái sai luật.
// Also the contract with the Rust engine (docs/ENGINE-RULES.md): Rng order, Fisher–Yates, cards with replacement,
// rounds and maxRounds, Blitz, integer rents, the snapshot, and traces that replay exactly.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CARDS, GROUPS, JAIL, OWNABLE_SQUARES, SQUARES, START_CASH, cityRents, groupSquares, houseCost, isOwnable, type Deck } from "../games/co-ty-phu/board.ts";
import {
  activePlayers,
  answerTrade,
  autoAct,
  autoSecondsOf,
  build,
  buy,
  canBuild,
  canMortgage,
  canSell,
  checkTime,
  createGame,
  currentPlayer,
  declareBankruptcy,
  defaultRng,
  endTurn,
  mortgage,
  netWorth,
  newPlayer,
  payBail,
  payDebt,
  proposeTrade,
  redeem,
  redeemPrice,
  removeAbsent,
  rentFor,
  returnToLobby,
  roll,
  sellHouse,
  setAutoSeconds,
  setLimit,
  setPlaying,
  setSalary,
  setStartCash,
  shuffleWith,
  skipBuying,
  startCashOf,
  startGame,
  useFreeCard,
  withdrawTrade,
  type Game,
  type Player,
  type Rng,
  type Settings,
} from "../games/co-ty-phu/engine.ts";
import { viewFor } from "../games/co-ty-phu/view.ts";
import { OPS, applyOp, generateGame, newTraceGame } from "../tools/diff/gen.ts";
import { RecordingRng, gameSeed, mulberry32, scriptedRng, type RngCall } from "../tools/diff/rng.ts";
import { snapshot } from "../tools/diff/snapshot.ts";

const T0 = Date.UTC(2026, 10, 3, 12);
const NAMES = ["An", "Bình", "Chi", "Dũng", "Giang", "Hà", "Khoa", "Lan"];

/** Phòng chờ có `count` người p0, p1, … với các lựa chọn `settings` (mặc định không hẹn giờ). */
function lobby(count: number, settings: Partial<Settings> = {}): Game {
  const game = createGame();
  NAMES.slice(0, count).forEach((name, i) => game.players.push(newPlayer(`p${i}`, `s${i}`, name, i === 0)));
  game.settings = { ...game.settings, limitMinutes: 0, ...settings };
  return game;
}

const everyone = (game: Game) => new Set(game.players.map((p) => p.id));

/** Ván có `count` người, thứ tự lượt đúng theo thứ tự vào phòng cho dễ đoán. */
function started(count = 3, limitMinutes = 0, settings: Partial<Settings> = {}): Game {
  const game = lobby(count, settings);
  setLimit(game, limitMinutes);
  startGame(game, everyone(game), T0);
  game.order = game.players.slice(0, count).map((p) => p.id);
  return game;
}

const player = (game: Game, i: number) => game.players[i];
const cashSum = (game: Game) => game.players.reduce((sum, p) => sum + p.cash, 0);

/** An Rng that must not be used: refused actions and moves that land on no card square draw nothing. */
const never: Rng = {
  die: () => assert.fail("unexpected die()"),
  below: (n) => assert.fail(`unexpected below(${n})`),
};

/** An Rng for one move that draws exactly these cards, in this order. */
function draws(...picks: [Deck, RegExp][]): Rng {
  const queue = picks.map(([deck, text]) => {
    const index = CARDS[deck].findIndex((card) => text.test(card.text));
    assert.ok(index >= 0, `no card ${text}`);
    return { deck, index };
  });
  return {
    die: () => assert.fail("unexpected die()"),
    below: (n) => {
      const next = queue.shift();
      assert.ok(next, `unexpected card draw below(${n})`);
      assert.equal(n, CARDS[next.deck].length);
      return next.index;
    },
  };
}

/** Rng values from a list of `[kind, n?, value]`. */
const calls = (...list: ([ "die", number ] | [ "below", number, number ])[]): RngCall[] =>
  list.map((call) => (call[0] === "die" ? { kind: "die", value: call[1] } : { kind: "below", n: call[1], value: call[2] }));

/** Cho người đang tới lượt đổ đúng hai con số này. Thẻ rút ra (nếu có) lấy từ `rng`. */
function rollAs(game: Game, a: number, b: number, rng: Rng = never): Player {
  const mover = currentPlayer(game)!;
  roll(game, mover.id, [a, b], rng);
  return mover;
}

/** Cho một người sở hữu sẵn các ô, không qua mua. */
function give(game: Game, id: string, ...squares: number[]): void {
  for (const i of squares) game.props[i] = { owner: id, houses: 0, mortgaged: false };
}


test("cờ tỷ phú: bàn cờ có 40 ô, 8 bộ màu, 4 bến và 2 công ty điện nước", () => {
  assert.equal(SQUARES.length, 40);
  assert.deepEqual(GROUPS.map((_, g) => groupSquares(g).length), [2, 3, 3, 3, 3, 3, 3, 2]);
  assert.equal(SQUARES.filter((s) => s.kind === "station").length, 4);
  assert.equal(SQUARES.filter((s) => s.kind === "utility").length, 2);
  assert.equal(SQUARES[JAIL].kind, "jail");
  assert.equal(SQUARES[30].kind, "arrest");
  for (const g of GROUPS.keys()) {
    const prices = groupSquares(g).map((i) => (SQUARES[i] as { price: number }).price);
    assert.deepEqual(prices, [...prices].sort((a, b) => a - b), "trong một bộ, đất sau không rẻ hơn đất trước");
  }
  assert.deepEqual(cityRents(60), [5, 30, 90, 180, 240, 300]);
  assert.deepEqual(cityRents(400), [40, 200, 600, 1200, 1600, 2000]);
});

test("cờ tỷ phú: 2 tới 6 người chơi, người thứ bảy trở đi và người chọn xem thì chỉ xem", () => {
  const game = createGame();
  NAMES.forEach((name, i) => game.players.push(newPlayer(`p${i}`, `s${i}`, name, i === 0)));
  setPlaying(game, "p2", false);
  startGame(game, new Set(NAMES.map((_, i) => `p${i}`)), T0);
  assert.equal(game.phase, "playing");
  assert.deepEqual([...game.order].sort(), ["p0", "p1", "p3", "p4", "p5", "p6"]);
  assert.equal(player(game, 2).color, null);
  assert.equal(player(game, 7).color, null);
  assert.equal(cashSum(game), START_CASH * 6);
  assert.equal(game.minted, START_CASH * 6);

  const lonely = createGame();
  lonely.players.push(newPlayer("a", "s", "An", true), newPlayer("b", "s", "Bình"));
  startGame(lonely, new Set(["a"]), T0);
  assert.equal(lonely.phase, "lobby", "một người thì chưa chơi được");
});

test("cờ tỷ phú: đổ xúc xắc đi đúng số ô, qua Xuất phát nhận 200", () => {
  const game = started();
  const an = rollAs(game, 2, 3);
  assert.equal(an.position, 5);
  assert.equal(game.stage, "buy");
  skipBuying(game, an.id);
  endTurn(game, an.id);
  assert.equal(currentPlayer(game)!.id, "p1");
  player(game, 1).position = 38;
  rollAs(game, 1, 2);
  assert.equal(player(game, 1).position, 1);
  assert.equal(player(game, 1).cash, START_CASH + 200);
});

test("cờ tỷ phú: chỉ người đang tới lượt làm được, và đúng bước", () => {
  const game = started();
  roll(game, "p1", [1, 2]);
  assert.equal(game.rolls, 0);
  endTurn(game, "p0");
  assert.equal(currentPlayer(game)!.id, "p0", "chưa đổ thì chưa kết thúc lượt được");
  rollAs(game, 1, 2);
  roll(game, "p0", [1, 2]);
  assert.equal(game.rolls, 1, "không đổ đôi thì không đổ tiếp");
});

test("cờ tỷ phú: mua đất trừ tiền, không đủ tiền thì không mua được, bỏ qua thì đất vẫn trống", () => {
  const game = started();
  const an = rollAs(game, 1, 2);
  buy(game, an.id);
  assert.equal(game.props[3].owner, an.id);
  assert.equal(an.cash, START_CASH - 60);
  endTurn(game, an.id);
  const binh = player(game, 1);
  binh.cash = 50;
  game.minted -= START_CASH - 50;
  rollAs(game, 3, 3);
  buy(game, binh.id);
  assert.equal(game.props[6], undefined);
  assert.equal(game.stage, "buy");
  skipBuying(game, binh.id);
  assert.equal(game.props[6], undefined);
  assert.equal(cashSum(game), game.minted);
});

test("cờ tỷ phú: tiền thuê đất, đủ bộ gấp đôi, có nhà theo bảng, cầm cố thì không thu", () => {
  const game = started();
  give(game, "p1", 1);
  assert.equal(rentFor(game, 1, 7), 5);
  give(game, "p1", 3);
  assert.equal(rentFor(game, 1, 7), 10, "đủ bộ South America");
  game.props[1].houses = 2;
  assert.equal(rentFor(game, 1, 7), 90);
  game.props[1].houses = 0;
  game.props[3].mortgaged = true;
  assert.equal(rentFor(game, 3, 7), 0);

  const an = rollAs(game, 0, 1);
  assert.equal(an.position, 1);
  assert.equal(an.cash, START_CASH - 10);
  assert.equal(player(game, 1).cash, START_CASH + 10);
});

test("cờ tỷ phú: bến xe tính theo số bến, điện nước tính theo số chấm", () => {
  const game = started();
  give(game, "p1", 5, 15);
  assert.equal(rentFor(game, 5, 7), 50);
  give(game, "p1", 25, 35);
  assert.equal(rentFor(game, 5, 7), 200);
  give(game, "p2", 12);
  assert.equal(rentFor(game, 12, 7), 28);
  give(game, "p2", 28);
  assert.equal(rentFor(game, 12, 7), 70);
});

/** Cho người đang tới lượt dừng đúng ô `square` bằng một lần đổ 1-2, không đôi nên không được đổ tiếp. */
function stopAt(game: Game, square: number): Player {
  currentPlayer(game)!.position = (square + 37) % 40;
  return rollAs(game, 1, 2);
}

test("cờ tỷ phú: chủ phòng chọn tiền qua Xuất phát 200, 500, 700 hay 1.000, đi qua thì nhận đúng mức đó", () => {
  const game = createGame();
  NAMES.slice(0, 2).forEach((name, i) => game.players.push(newPlayer(`p${i}`, `s${i}`, name, i === 0)));
  assert.equal(game.settings.salary, 200, "mặc định 200");
  setSalary(game, 700);
  setSalary(game, 123);
  setLimit(game, 30);
  assert.deepEqual(game.settings, { limitMinutes: 30, salary: 700, cash: START_CASH, autoSeconds: 20 }, "mức lạ bị bỏ qua, đổi độ dài ván không mất mức tiền");
  startGame(game, new Set(["p0", "p1"]), T0);
  game.order = ["p0", "p1"];
  setSalary(game, 1000);
  assert.equal(game.settings.salary, 700, "đang chơi thì không đổi được");
  const an = player(game, 0);
  an.position = 38;
  rollAs(game, 1, 2);
  assert.equal(an.cash, START_CASH + 700);
  assert.ok(game.log.some((line) => line.includes("passes Departure and collects 700")));
  assert.equal(cashSum(game), game.minted);
});

test("cờ tỷ phú: chủ phòng chọn vốn ban đầu 1.500, 3.000 hay 5.000 và số giây máy bấm hộ, chỉ ở phòng chờ", () => {
  const game = createGame();
  NAMES.slice(0, 3).forEach((name, i) => game.players.push(newPlayer(`p${i}`, `s${i}`, name, i === 0)));
  assert.equal(startCashOf(game), 1500, "mặc định 1.500");
  assert.equal(autoSecondsOf(game), 20, "mặc định 20 giây");
  setStartCash(game, 3000);
  setStartCash(game, 2500);
  setAutoSeconds(game, 10);
  setAutoSeconds(game, 7);
  assert.equal(startCashOf(game), 3000, "mức lạ bị bỏ qua");
  assert.equal(autoSecondsOf(game), 10);
  startGame(game, new Set(["p0", "p1", "p2"]), T0);
  assert.ok(game.players.every((p) => p.cash === 3000), "ai cũng vào ván với đúng vốn đã chọn");
  assert.equal(cashSum(game), game.minted);
  setStartCash(game, 5000);
  setAutoSeconds(game, 0);
  assert.equal(startCashOf(game), 3000, "đang chơi thì không đổi được");
  assert.equal(autoSecondsOf(game), 10);
  // Ván lưu từ bản cũ không có hai lựa chọn này thì tính theo mặc định.
  assert.equal(startCashOf({ settings: { limitMinutes: 45 } }), START_CASH);
  assert.equal(autoSecondsOf({ settings: { limitMinutes: 45 } }), 20);
});

test("cờ tỷ phú: để quá giờ thì máy bấm hộ: đổ, bỏ qua mua đất, đổ đôi thì đổ tiếp, đi xong thì hết lượt; mắc nợ thì không", () => {
  const game = started(3);
  const an = player(game, 0);
  assert.equal(autoAct(game), true, "chưa đổ thì máy đổ hộ");
  assert.equal(game.rolls, 1);
  assert.ok(game.log.includes("An timed out; the game rolls for them."));

  // Đang hỏi mua: bỏ qua, đất vẫn trống, tiền không đổi.
  Object.assign(game, { turn: 0, stage: "buy", again: false, debt: null, pendingMove: null });
  an.position = 1;
  delete game.props[1];
  const cash = an.cash;
  assert.equal(autoAct(game), true);
  assert.equal(game.stage, "end");
  assert.equal(game.props[1], undefined);
  assert.equal(an.cash, cash);
  assert.ok(game.log.includes("An timed out and does not buy São Paulo."));

  game.again = true;
  const rolls = game.rolls;
  assert.equal(autoAct(game), true);
  assert.equal(game.rolls, rolls + 1, "vừa đổ đôi thì đổ tiếp");

  Object.assign(game, { turn: 0, stage: "end", again: false, debt: null, pendingMove: null });
  assert.equal(autoAct(game), true);
  assert.equal(currentPlayer(game)!.id, "p1", "đi xong thì hết lượt");
  assert.equal(game.stage, "roll");

  Object.assign(game, { stage: "debt", debt: [{ id: null, amount: 99_999 }] });
  const before = JSON.stringify(game);
  assert.equal(autoAct(game), false, "mắc nợ thì không bấm hộ");
  assert.equal(JSON.stringify(game), before);
  assert.equal(cashSum(game), game.minted);
});

test("cờ tỷ phú: mua thì chưa xây; dừng lại ở đất mình thì xây thêm một nhà, đủ 4 nhà thì lần sau lên khách sạn", () => {
  const game = started(2);
  const [an, binh] = [player(game, 0), player(game, 1)];
  // Bình đứng ở Tạm giữ (chỉ thăm) mỗi lượt cho khỏi đụng đất của An.
  const binhTurn = () => {
    endTurn(game, an.id);
    stopAt(game, 10);
    endTurn(game, binh.id);
  };
  stopAt(game, 6);
  assert.equal(game.stage, "buy");
  buy(game, an.id);
  assert.equal(canBuild(game, an.id, 6), false, "lần đầu dừng thì chỉ mua, chưa xây");
  give(game, an.id, 8);
  for (let houses = 1; houses <= 5; houses++) {
    binhTurn();
    stopAt(game, 6);
    assert.equal(canBuild(game, an.id, 8), false, "chỉ xây ở ô vừa dừng");
    assert.equal(canBuild(game, binh.id, 6), false, "không xây trên đất người khác");
    build(game, an.id, 6);
    build(game, an.id, 6);
    assert.equal(game.props[6].houses, houses, "mỗi lần dừng một nhà, nhà thứ năm là khách sạn");
  }
  binhTurn();
  stopAt(game, 6);
  assert.equal(canBuild(game, an.id, 6), false, "khách sạn là tối đa");
  assert.equal(an.cash, START_CASH - 100 - 5 * houseCost(6));
  assert.deepEqual(game.builtThisTurn, [], "luật thường không dùng builtThisTurn");

  // Đất đang cầm cố thì dừng lại cũng không xây được; đang nợ thì không xây.
  game.props[8].mortgaged = true;
  binhTurn();
  stopAt(game, 8);
  assert.equal(canBuild(game, an.id, 8), false, "đất đang cầm cố");
  game.props[8].mortgaged = false;
  binhTurn();
  stopAt(game, 8);
  game.stage = "debt";
  assert.equal(canBuild(game, an.id, 8), false, "đang nợ thì không xây");
  game.stage = "end";
  assert.equal(canBuild(game, an.id, 8), true);

  // Bán nhà ô nào cũng được, nửa giá; còn nhà thì không cầm cố.
  const cash = an.cash;
  sellHouse(game, an.id, 6);
  assert.equal(game.props[6].houses, 4);
  assert.equal(an.cash, cash + houseCost(6) / 2);
  assert.equal(canSell(game, binh.id, 6), false, "không bán được nhà người khác");
  assert.equal(canMortgage(game, an.id, 6), false, "còn nhà thì không cầm cố được");
  assert.equal(canMortgage(game, an.id, 8), true, "ô cùng bộ không có nhà thì vẫn cầm cố được");
  assert.equal(cashSum(game), game.minted);
});

test("cờ tỷ phú: cầm cố nhận nửa giá, chuộc lại thêm 10%", () => {
  const game = started();
  give(game, "p0", 39);
  mortgage(game, "p0", 39);
  assert.equal(player(game, 0).cash, START_CASH + 200);
  assert.equal(redeemPrice(39), 220);
  redeem(game, "p0", 39);
  assert.equal(player(game, 0).cash, START_CASH - 20);
  assert.equal(game.props[39].mortgaged, false);
  redeem(game, "p1", 39);
  mortgage(game, "p1", 39);
  assert.equal(game.props[39].mortgaged, false, "đất người khác thì không đụng được");
  assert.equal(cashSum(game), game.minted);
});

test("cờ tỷ phú: đổ đôi được đổ tiếp, đôi ba lần liền thì vào tạm giữ", () => {
  const game = started();
  const an = rollAs(game, 1, 1, draws(["chest", /street-food/]));
  assert.equal(game.again, true);
  skipBuying(game, an.id);
  endTurn(game, an.id);
  assert.equal(currentPlayer(game)!.id, an.id, "đang được đổ tiếp thì chưa hết lượt");
  rollAs(game, 2, 2);
  if (game.stage === "buy") skipBuying(game, an.id);
  rollAs(game, 3, 3);
  assert.equal(an.position, JAIL);
  assert.equal(an.jail, 0);
  assert.equal(game.again, false);
  endTurn(game, an.id);
  assert.equal(currentPlayer(game)!.id, "p1");
});

test("cờ tỷ phú: tạm giữ: đổ đôi thì ra và đi nhưng không đổ tiếp, hỏng ba lần thì nộp phạt rồi đi", () => {
  const game = started(2);
  const an = player(game, 0);
  Object.assign(an, { position: JAIL, jail: 0 });
  rollAs(game, 1, 2);
  assert.equal(an.position, JAIL);
  endTurn(game, an.id);
  rollAs(game, 1, 2);
  if (game.stage === "buy") skipBuying(game, "p1");
  endTurn(game, "p1");
  rollAs(game, 4, 4);
  assert.equal(an.jail, null);
  assert.equal(an.position, 18);
  assert.equal(game.again, false);

  const other = started(2);
  const binh = player(other, 0);
  Object.assign(binh, { position: JAIL, jail: 2 });
  rollAs(other, 1, 3);
  assert.equal(binh.jail, null);
  assert.equal(binh.position, 14);
  assert.equal(binh.cash, START_CASH - 50);
});

test("cờ tỷ phú: nộp phạt hoặc dùng thẻ để ra trước khi đổ", () => {
  const game = started(2);
  const an = player(game, 0);
  Object.assign(an, { position: JAIL, jail: 0 });
  payBail(game, an.id);
  assert.equal(an.jail, null);
  assert.equal(an.cash, START_CASH - 50);

  const other = started(2);
  const binh = player(other, 0);
  Object.assign(binh, { position: JAIL, jail: 1, freeCards: ["chance", "chest"] });
  const before = snapshot(other);
  useFreeCard(other, binh.id);
  assert.equal(binh.jail, null);
  assert.deepEqual(binh.freeCards, ["chest"], "dùng thẻ giữ trước nhất");
  const after = snapshot(other);
  before.players[0] = { ...before.players[0], jail: null, freeCards: ["chest"] };
  assert.deepEqual(after, before, "không trả thẻ về chồng nào, không gì khác thay đổi");
});

test("cờ tỷ phú: thẻ đi tới, lùi, bến gần nhất trả gấp đôi, vào tạm giữ, giữ thẻ ra tù", () => {
  const game = started();
  const an = rollAs(game, 3, 4, draws(["chance", /Tokyo/]));
  assert.equal(an.position, 24);
  assert.equal(game.stage, "buy");
  assert.deepEqual(game.card, { deck: "chance", index: 1 });
  assert.match(viewFor(game, "p1", { code: "ABCD", online: new Set(), now: T0 }).card!.text, /Tokyo/);
  skipBuying(game, an.id);
  endTurn(game, an.id);

  const binh = player(game, 1);
  binh.position = 15;
  give(game, "p2", 25);
  rollAs(game, 3, 4, draws(["chance", /nearest waterway/]));
  assert.equal(binh.position, 25);
  assert.equal(binh.cash, START_CASH - 50);
  endTurn(game, binh.id);

  const chi = player(game, 2);
  chi.position = 33;
  rollAs(game, 1, 2, draws(["chance", /Go back 3/], ["chest", /street-food/]));
  assert.equal(chi.position, 33, "lùi về ô Souvenir thì rút tiếp");
  assert.equal(chi.cash, START_CASH + 50 + 10, "tiền thuê bến của Bình, rồi thẻ Souvenir");
  endTurn(game, chi.id);

  an.position = 0;
  rollAs(game, 1, 1, draws(["chest", /Good lawyer/]));
  assert.deepEqual(an.freeCards, ["chest"]);
  rollAs(game, 2, 3, draws(["chance", /Passport problem/]));
  assert.equal(an.position, JAIL);
  assert.equal(game.again, false, "vào tạm giữ thì hết lượt dù vừa đổ đôi");
  assert.equal(cashSum(game), game.minted);
});

test("cờ tỷ phú: thẻ thu của mỗi người và trả cho mỗi người", () => {
  const game = started(3);
  player(game, 2).cash = 4;
  game.minted -= START_CASH - 4;
  const an = rollAs(game, 1, 1, draws(["chest", /birthday/]));
  assert.equal(an.cash, START_CASH + 14, "người không đủ tiền thì chỉ mừng số tiền đang có");
  assert.equal(player(game, 2).cash, 0);
  assert.equal(cashSum(game), game.minted);
});

test("cờ tỷ phú: không đủ tiền thì thành nợ, bán nhà hay cầm cố rồi trả", () => {
  const game = started(2);
  give(game, "p1", 39);
  give(game, "p0", 1);
  const an = player(game, 0);
  an.cash = 20;
  game.minted -= START_CASH - 20;
  an.position = 37;
  rollAs(game, 1, 1);
  assert.equal(game.stage, "debt");
  assert.deepEqual(game.debt, [{ id: "p1", amount: 40 }]);
  endTurn(game, an.id);
  assert.equal(currentPlayer(game)!.id, an.id, "còn nợ thì chưa hết lượt");
  payDebt(game, an.id);
  assert.equal(game.stage, "debt");
  mortgage(game, an.id, 1);
  payDebt(game, an.id);
  assert.equal(game.stage, "end");
  assert.equal(an.cash, 10);
  assert.equal(player(game, 1).cash, START_CASH + 40);
  assert.equal(cashSum(game), game.minted);
});

test("cờ tỷ phú: phá sản vì nợ người chơi thì người đó nhận hết đất và tiền; còn một người thì thắng", () => {
  const game = started(2);
  const [an, binh] = [player(game, 0), player(game, 1)];
  give(game, "p0", 6, 8, 9);
  game.props[6].houses = 1;
  game.props[8].mortgaged = true;
  an.position = 37;
  an.cash = 30;
  game.minted = cashSum(game);
  give(game, "p1", 39);
  game.props[39].houses = 5;
  an.freeCards = ["chance", "chest"];
  binh.freeCards = ["chest"];
  rollAs(game, 1, 1);
  assert.equal(game.stage, "debt");
  declareBankruptcy(game, an.id);
  assert.equal(an.bankrupt, true);
  assert.deepEqual(an.freeCards, []);
  assert.deepEqual(binh.freeCards, ["chest", "chance", "chest"], "chủ nợ duy nhất nhận thẻ ra tù, nối vào cuối");
  assert.equal(game.stage, "debt", "hết ván vì phá sản thì giữ nguyên bước");
  assert.equal(game.props[6].owner, "p1");
  assert.equal(game.props[6].houses, 0);
  assert.equal(game.props[8].mortgaged, true, "đất cầm cố vẫn đang cầm cố");
  assert.equal(binh.cash, START_CASH + 30 + houseCost(6) / 2);
  assert.equal(game.phase, "ended");
  assert.deepEqual(game.result, { reason: "last", ranking: ["p1", "p0"] });
  assert.equal(cashSum(game), game.minted);
});

test("cờ tỷ phú: phá sản vì nợ ngân hàng thì đất về lại ngân hàng, lượt sang người kế", () => {
  const game = started(3);
  const an = player(game, 0);
  give(game, "p0", 5);
  game.props[5].mortgaged = true;
  an.cash = 10;
  an.freeCards = ["chance"];
  game.minted = cashSum(game);
  an.position = 2;
  rollAs(game, 1, 1);
  assert.equal(game.stage, "debt");
  declareBankruptcy(game, an.id);
  assert.equal(game.props[5], undefined);
  assert.ok(game.players.every((p) => p.freeCards.length === 0), "nợ ngân hàng thì thẻ ra tù bỏ đi");
  assert.equal(game.phase, "playing");
  assert.equal(currentPlayer(game)!.id, "p1");
  assert.equal(activePlayers(game).length, 2);
  assert.equal(cashSum(game), game.minted);
});

test("cờ tỷ phú: đổi đất và tiền, người nhận đồng ý thì mới đổi; ô có nhà thì không đổi được", () => {
  const game = started(3);
  give(game, "p0", 1, 3);
  give(game, "p1", 39);
  proposeTrade(game, "p0", { to: "p1", give: [1], take: [39], giveCash: 100, takeCash: 0 });
  assert.ok(game.trade);
  answerTrade(game, "p2", true);
  assert.ok(game.trade, "người thứ ba không trả lời thay được");
  answerTrade(game, "p1", true);
  assert.equal(game.props[1].owner, "p1");
  assert.equal(game.props[39].owner, "p0");
  assert.equal(player(game, 0).cash, START_CASH - 100);
  assert.equal(player(game, 1).cash, START_CASH + 100);

  give(game, "p0", 1);
  game.props[1].houses = 1;
  proposeTrade(game, "p0", { to: "p1", give: [1], take: [], giveCash: 0, takeCash: 10 });
  assert.equal(game.trade, null, "São Paulo đang có nhà");
  proposeTrade(game, "p0", { to: "p1", give: [], take: [], giveCash: 0, takeCash: 0 });
  assert.equal(game.trade, null, "không đổi gì");
  proposeTrade(game, "p0", { to: "p1", give: [39], take: [], giveCash: 0, takeCash: 99_999 });
  assert.equal(game.trade, null, "người kia không đủ tiền");
  proposeTrade(game, "p0", { to: "p1", give: [39], take: [], giveCash: 0, takeCash: 50 });
  withdrawTrade(game, "p1");
  assert.ok(game.trade, "chỉ người đề nghị rút lại được");
  withdrawTrade(game, "p0");
  assert.equal(game.trade, null);
  proposeTrade(game, "p0", { to: "p1", give: [39], take: [], giveCash: 0, takeCash: 50 });
  answerTrade(game, "p1", false);
  assert.equal(game.props[39].owner, "p0");
  assert.equal(cashSum(game), game.minted);
});

test("cờ tỷ phú: hết giờ thì chơi nốt vòng rồi xếp hạng theo tài sản", () => {
  const game = started(3, 30);
  assert.equal(game.endsAt, T0 + 30 * 60_000);
  give(game, "p2", 39);
  assert.equal(checkTime(game, T0 + 29 * 60_000), false);
  const an = rollAs(game, 1, 2);
  skipBuying(game, an.id);
  endTurn(game, an.id);
  assert.equal(checkTime(game, T0 + 30 * 60_000), true);
  for (const id of ["p1", "p2"]) {
    rollAs(game, 2, 3);
    if (game.stage === "buy") skipBuying(game, id);
    endTurn(game, id);
  }
  assert.equal(game.phase, "ended");
  assert.equal(game.result!.reason, "time");
  assert.equal(game.result!.ranking[0], "p2", "Monaco làm Chi giàu nhất");
  assert.equal(netWorth(game, "p2"), player(game, 2).cash + 400);
});

test("cờ tỷ phú: người vắng quá lâu bị loại, về phòng chờ thì mọi người chơi lại từ đầu", () => {
  const game = started(3);
  give(game, "p0", 1);
  removeAbsent(game, "p0");
  assert.equal(player(game, 0).bankrupt, true);
  assert.equal(game.props[1], undefined);
  assert.equal(currentPlayer(game)!.id, "p1");
  returnToLobby(game);
  assert.equal(game.phase, "lobby");
  assert.equal(player(game, 0).bankrupt, false);
  assert.deepEqual(game.props, {});
});

test("cờ tỷ phú: không có chồng thẻ nào, máy người chơi không thấy khóa của người khác", () => {
  const game = started(2);
  assert.equal("decks" in game, false);
  const text = JSON.stringify(viewFor(game, "p0", { code: "ABCD", online: new Set(["p0"]), now: T0 }));
  assert.ok(!text.includes("decks"));
  assert.ok(!text.includes('"secret":"s1"'), "không lộ khóa của người khác");
});

/** Bot đơn giản: mua khi đủ tiền, xây khi được, nợ thì bán và cầm cố, không trả nổi thì phá sản, thỉnh thoảng đổi đất. */
function playOneStep(game: Game, random: () => number, rng: Rng): void {
  const me = currentPlayer(game)!;
  if (game.trade && random() < 0.5) answerTrade(game, game.trade.to, random() < 0.5);
  if (game.stage === "debt") {
    const owed = game.debt!.reduce((sum, payee) => sum + payee.amount, 0);
    for (const index of Object.keys(game.props).map(Number)) {
      while (me.cash < owed && canSell(game, me.id, index)) sellHouse(game, me.id, index);
    }
    for (const index of Object.keys(game.props).map(Number)) if (me.cash < owed && canMortgage(game, me.id, index)) mortgage(game, me.id, index);
    if (me.cash >= owed) payDebt(game, me.id, rng);
    else declareBankruptcy(game, me.id);
    return;
  }
  if (game.stage === "roll") {
    if (me.jail !== null && me.freeCards.length > 0 && random() < 0.5) useFreeCard(game, me.id);
    else if (me.jail !== null && random() < 0.3) payBail(game, me.id);
    roll(game, me.id, [1 + Math.floor(random() * 6), 1 + Math.floor(random() * 6)], rng);
    return;
  }
  if (game.stage === "buy") {
    const square = SQUARES[me.position];
    if (isOwnable(square) && me.cash >= square.price && random() < 0.9) buy(game, me.id);
    else skipBuying(game, me.id);
    return;
  }
  for (const index of Object.keys(game.props).map(Number)) {
    if (random() < 0.7) build(game, me.id, index);
    if (game.props[index]?.mortgaged && random() < 0.2) redeem(game, me.id, index);
  }
  if (!game.trade && random() < 0.05) {
    const others = activePlayers(game).filter((p) => p.id !== me.id);
    const to = others[Math.floor(random() * others.length)];
    const mine = Object.keys(game.props).map(Number).filter((i) => game.props[i].owner === me.id);
    const theirs = Object.keys(game.props).map(Number).filter((i) => game.props[i].owner === to.id);
    proposeTrade(game, me.id, {
      to: to.id,
      give: mine.filter(() => random() < 0.3),
      take: theirs.filter(() => random() < 0.3),
      giveCash: Math.floor(random() * Math.min(me.cash, 200)),
      takeCash: 0,
    });
  }
  if (game.again) roll(game, me.id, [1 + Math.floor(random() * 6), 1 + Math.floor(random() * 6)], rng);
  else endTurn(game, me.id);
}

function assertLegal(game: Game): void {
  assert.equal(cashSum(game), game.minted, "tiền không tự sinh ra hay mất đi");
  for (const p of game.players) {
    assert.ok(p.cash >= 0, `${p.name} âm tiền`);
    assert.ok(p.position >= 0 && p.position < 40);
    if (p.bankrupt) assert.equal(p.cash, 0);
  }
  for (const [index, owned] of Object.entries(game.props)) {
    const square = SQUARES[Number(index)];
    assert.ok(isOwnable(square));
    assert.ok(!game.players.find((p) => p.id === owned.owner)!.bankrupt, "người phá sản không còn đất");
    if (owned.houses > 0) {
      assert.equal(square.kind, "city", "nhà chỉ có trên đất thành phố");
      assert.ok(!owned.mortgaged && owned.houses <= 5, "đất có nhà thì không cầm cố, tối đa khách sạn");
    }
  }
  for (const p of game.players) assert.ok(p.freeCards.every((deck) => deck === "chance" || deck === "chest"));
  if (game.card) assert.ok(CARDS[game.card.deck][game.card.index], "thẻ đang hiện có thật");
  assert.ok(Number.isInteger(game.round) && game.round >= 0);
}

// Dừng lại ở đất mình là xây thêm được nhà nên tiền thuê lên dần, ván máy tự chơi xong sau vài trăm tới vài nghìn bước.
// Ván hẹn giờ cho đồng hồ chạy 10 giây mỗi bước, để có cả ván hết giờ trước khi chỉ còn một người.
test("cờ tỷ phú: máy tự chơi ngẫu nhiên 60 ván, ván hẹn giờ luôn kết thúc và mọi bước đều đúng luật", () => {
  let seed = 7;
  const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
  const rng: Rng = { die: () => 1 + Math.floor(random() * 6), below: (n) => Math.floor(random() * n) };
  const reasons = new Set<string>();
  let unfinished = 0;
  for (let round = 0; round < 60; round++) {
    const count = 2 + (round % 5);
    const timed = round % 4 === 0;
    let game = started(count, timed ? 30 : 0);
    let now = T0;
    for (let steps = 0; game.phase === "playing" && steps < 20_000; steps++) {
      playOneStep(game, random, rng);
      now += timed ? 10_000 : 2000;
      checkTime(game, now);
      if (random() < 0.002) game = JSON.parse(JSON.stringify(game)) as Game;
      assertLegal(game);
    }
    if (game.phase === "playing") {
      assert.equal(timed, false, "ván hẹn giờ phải kết thúc");
      unfinished += 1;
      continue;
    }
    reasons.add(game.result!.reason);
    assert.equal(game.result!.ranking.length, count);
    if (game.result!.reason === "last") assert.equal(activePlayers(game).length, 1);
  }
  assert.equal(unfinished, 0, `${unfinished} ván không hẹn giờ chưa xong sau 20.000 bước`);
  assert.deepEqual([...reasons].sort(), ["last", "time"]);
});

// The contract with the Rust engine (docs/ENGINE-RULES.md).

test("cờ tỷ phú: Fisher–Yates is `for i = len-1 down to 1: j = below(i+1); swap(i, j)`", () => {
  const items = ["a", "b", "c", "d", "e"];
  const rng = new RecordingRng(scriptedRng(calls(["below", 5, 1], ["below", 4, 3], ["below", 3, 0], ["below", 2, 0])));
  assert.deepEqual(shuffleWith(items, rng), ["e", "c", "a", "d", "b"]);
  assert.deepEqual(rng.take(), calls(["below", 5, 1], ["below", 4, 3], ["below", 3, 0], ["below", 2, 0]));
  assert.deepEqual(items, ["a", "b", "c", "d", "e"], "the input is not changed");
  // Always picking 0 rotates the list left by one.
  assert.deepEqual(shuffleWith(items, { die: never.die, below: () => 0 }), ["b", "c", "d", "e", "a"]);
  assert.deepEqual(shuffleWith(["x"], never), ["x"], "one item: no call");
  assert.deepEqual(shuffleWith([], never), []);
});

test("cờ tỷ phú: start shuffles the seats in seating order, then Blitz shuffles the 28 ownables; nothing else draws", () => {
  const game = lobby(4);
  const rng = new RecordingRng(scriptedRng(calls(["below", 4, 2], ["below", 3, 0], ["below", 2, 1])));
  startGame(game, everyone(game), T0, rng);
  assert.deepEqual(rng.take(), calls(["below", 4, 2], ["below", 3, 0], ["below", 2, 1]));
  assert.deepEqual(game.order, ["p3", "p1", "p0", "p2"]);
  assert.equal(game.round, 0);
  assert.deepEqual(game.builtThisTurn, []);

  const blitz = lobby(3, { blitz: true, cash: 2000 });
  const recorded = new RecordingRng({ die: never.die, below: () => 0 });
  startGame(blitz, everyone(blitz), T0, recorded);
  const sizes = recorded.take().map((call) => (call.kind === "below" ? call.n : 0));
  assert.deepEqual(sizes, [3, 2, ...Array.from({ length: 27 }, (_, i) => 28 - i)]);
  assert.equal(OWNABLE_SQUARES.length, 28);
});

test("cờ tỷ phú: a roll draws the first die, the second, then each card of the move; refused actions draw nothing", () => {
  const game = started(2);
  const rng = scriptedRng(calls(["die", 3], ["die", 4], ["below", 14, 9]));
  roll(game, "p0", undefined, rng);
  assert.equal(rng.left(), 0);
  assert.deepEqual(game.dice, [3, 4]);
  assert.equal(player(game, 0).position, 7);
  assert.deepEqual(game.card, { deck: "chance", index: 9 });
  assert.equal(player(game, 0).cash, START_CASH + 150);

  roll(game, "p0", undefined, never);
  roll(game, "p1", undefined, never);
  assert.equal(game.rolls, 1, "refused rolls change nothing and draw nothing");
  Object.assign(game, { stage: "debt", debt: [{ id: null, amount: 99_999 }] });
  assert.equal(autoAct(game, never), false, "auto does nothing in debt");
  Object.assign(game, { stage: "end", debt: null });
  assert.equal(autoAct(game, never), true, "auto ending the turn draws nothing");

  // Back 3 squares from Travel Alert onto Souvenir: two cards in one roll.
  player(game, 1).position = 31;
  const chain = scriptedRng(calls(["die", 2], ["die", 3], ["below", 14, 6], ["below", 14, 4]));
  autoAct(game, chain);
  assert.equal(chain.left(), 0);
  assert.equal(player(game, 1).position, 33);
  assert.deepEqual(game.card, { deck: "chest", index: 4 });
  assert.equal(player(game, 1).cash, START_CASH + 10);
});

test("cờ tỷ phú: the move after a third failed jail roll waits for the fine, and paying it may draw a card", () => {
  const game = started(2);
  const an = player(game, 0);
  Object.assign(an, { position: JAIL, jail: 2, cash: 30 });
  game.minted = cashSum(game);
  give(game, "p0", 1);
  roll(game, "p0", undefined, scriptedRng(calls(["die", 3], ["die", 4])));
  assert.equal(game.stage, "debt");
  assert.deepEqual(game.debt, [{ id: null, amount: 50 }]);
  assert.equal(game.pendingMove, 7);
  assert.equal(an.position, JAIL);
  assert.equal(an.jail, null);
  mortgage(game, "p0", 1);
  const rng = scriptedRng(calls(["below", 14, 0]));
  payDebt(game, "p0", rng);
  assert.equal(rng.left(), 0);
  assert.equal(an.position, 17);
  assert.deepEqual(game.card, { deck: "chest", index: 0 });
  assert.equal(an.cash, 30 + 30 - 50 + 200);
  assert.equal(game.pendingMove, null);
  assert.equal(game.stage, "end");
  assert.equal(cashSum(game), game.minted);
});

test("cờ tỷ phú: cards are drawn with replacement, so anyone can draw the same free card again", () => {
  const game = started(2);
  const [an, binh] = [player(game, 0), player(game, 1)];
  rollAs(game, 1, 1, draws(["chest", /Good lawyer/]));
  rollAs(game, 2, 3, draws(["chance", /Diplomatic pass/]));
  assert.deepEqual(an.freeCards, ["chest", "chance"]);
  endTurn(game, an.id);
  rollAs(game, 1, 1, draws(["chest", /Good lawyer/]));
  assert.deepEqual(binh.freeCards, ["chest"], "the same card again");
  assert.deepEqual(game.card, { deck: "chest", index: 12 });
});

test("cờ tỷ phú: round goes up when the turn wraps; reaching maxRounds ends the game with reason time, turn unchanged", () => {
  const game = started(3, 0, { maxRounds: 2 });
  const turn = (game: Game) => {
    const me = currentPlayer(game)!;
    me.position = 0;
    rollAs(game, 1, 2);
    skipBuying(game, me.id);
    endTurn(game, me.id);
  };
  for (let i = 0; i < 3; i++) turn(game);
  assert.equal(game.round, 1);
  assert.equal(game.phase, "playing");
  assert.equal(game.turn, 0);
  for (let i = 0; i < 2; i++) turn(game);
  assert.equal(game.round, 1);
  turn(game);
  assert.equal(game.phase, "ended");
  assert.equal(game.round, 2, "the last round is counted");
  assert.equal(game.result!.reason, "time");
  assert.equal(game.result!.ranking.length, 3);
  assert.equal(game.turn, 2, "the turn does not advance");
  assert.equal(game.stage, "end");

  const endless = started(2);
  for (let i = 0; i < 10; i++) turn(endless);
  assert.equal(endless.round, 5);
  assert.equal(endless.phase, "playing", "maxRounds 0 means no limit");
});

test("cờ tỷ phú: Blitz deal: the k-th player in turn order buys shuffled ownables [5k, 5k+5) at full price", () => {
  const game = lobby(4, { blitz: true, cash: 2000 });
  // Always picking 0: the order and the ownables are rotated left by one.
  startGame(game, everyone(game), T0, { die: never.die, below: () => 0 });
  assert.deepEqual(game.order, ["p1", "p2", "p3", "p0"]);
  const deal: Record<string, number[]> = { p1: [3, 5, 6, 8, 9], p2: [11, 12, 13, 14, 15], p3: [16, 18, 19, 21, 23], p0: [24, 25, 26, 27, 28] };
  for (const [id, squares] of Object.entries(deal)) {
    assert.deepEqual(
      Object.keys(game.props)
        .map(Number)
        .filter((i) => game.props[i].owner === id),
      squares,
    );
    const paid = squares.reduce((sum, i) => sum + (SQUARES[i] as { price: number }).price, 0);
    assert.equal(game.players.find((p) => p.id === id)!.cash, 2000 - paid);
  }
  assert.deepEqual(
    game.players.map((p) => p.cash),
    [890, 1420, 1210, 1000],
  );
  assert.ok(Object.values(game.props).every((o) => o.houses === 0 && !o.mortgaged));
  assert.equal(game.minted, cashSum(game));
  assert.equal(game.minted, 8000 - 3480);

  for (const count of [2, 3, 4]) {
    const random = mulberry32(count);
    const other = lobby(count, { blitz: true, cash: 2000 });
    startGame(other, everyone(other), T0, { die: never.die, below: (n) => Math.floor(random() * n) });
    const owners = Object.values(other.props).map((o) => o.owner);
    assert.equal(owners.length, 5 * count);
    for (const id of other.order) assert.equal(owners.filter((o) => o === id).length, 5);
    assert.equal(other.minted, cashSum(other));
    assert.ok(other.players.every((p) => p.cash >= 0));
  }
});

test("cờ tỷ phú: Blitz building: any own city in your turn, once per city per turn, not in debt; build clears buildAt", () => {
  const game = lobby(2, { blitz: true, cash: 2000 });
  startGame(game, everyone(game), T0, { die: never.die, below: () => 0 });
  const [p0, p1] = [player(game, 0), player(game, 1)];
  assert.equal(currentPlayer(game)!.id, "p1");
  // p1 holds 3, 5, 6, 8, 9; p0 holds 11 to 15.
  assert.equal(canBuild(game, "p1", 3), true, "before rolling, far from the square");
  assert.equal(canBuild(game, "p1", 5), false, "a station");
  assert.equal(canBuild(game, "p1", 11), false, "not mine");
  assert.equal(canBuild(game, "p0", 11), false, "not my turn");
  build(game, "p1", 3);
  build(game, "p1", 3);
  assert.equal(game.props[3].houses, 1, "once per city per turn");
  build(game, "p1", 6);
  assert.deepEqual(game.builtThisTurn, [3, 6]);
  assert.equal(p1.cash, 1420 - houseCost(3) - houseCost(6));
  mortgage(game, "p1", 8);
  assert.equal(canBuild(game, "p1", 8), false, "mortgaged");
  Object.assign(game, { stage: "debt", debt: [{ id: null, amount: 99_999 }] });
  assert.equal(canBuild(game, "p1", 9), false, "in debt");
  Object.assign(game, { stage: "roll", debt: null });

  p1.position = 0;
  rollAs(game, 1, 2);
  assert.equal(game.buildAt, 3, "stopping on an own city still sets buildAt");
  assert.equal(canBuild(game, "p1", 3), false, "already built there this turn");
  build(game, "p1", 9);
  assert.equal(game.buildAt, null, "building clears buildAt");
  assert.deepEqual(game.builtThisTurn, [3, 6, 9]);
  endTurn(game, "p1");
  assert.deepEqual(game.builtThisTurn, [], "a new turn starts empty");
  build(game, "p0", 11);
  assert.deepEqual(game.builtThisTurn, [11]);
  p0.position = 0;
  rollAs(game, 1, 2);
  endTurn(game, "p0");
  assert.equal(canBuild(game, "p1", 3), true, "next turn again");
  game.props[3].houses = 5;
  assert.equal(canBuild(game, "p1", 3), false, "a hotel is the most");
  assert.equal(cashSum(game), game.minted);
});

test("cờ tỷ phú: Blitz net worth counts houses at floor(3/4 of their cost)", () => {
  const classic = started(2);
  const blitz = started(2);
  blitz.settings.blitz = true;
  for (const game of [classic, blitz]) {
    give(game, "p0", 3, 11, 21, 39, 5);
    Object.assign(game.props[3], { houses: 1 });
    Object.assign(game.props[11], { houses: 2 });
    Object.assign(game.props[21], { houses: 1 });
    Object.assign(game.props[39], { houses: 5 });
    game.props[5].mortgaged = true;
  }
  const land = 60 + 140 + 220 + 400 + 100;
  assert.equal(netWorth(classic, "p0"), START_CASH + land + 50 + 2 * 100 + 150 + 5 * 200);
  assert.equal(netWorth(blitz, "p0"), START_CASH + land + 37 + 2 * 75 + 112 + 5 * 150);
});

test("cờ tỷ phú: cityRents is integer-only and equals rounding price × x to the nearest 5, for every price on the board", () => {
  const prices = [...new Set(SQUARES.flatMap((square) => (square.kind === "city" ? [square.price] : [])))].sort((a, b) => a - b);
  assert.deepEqual(prices, [60, 100, 120, 140, 160, 180, 200, 220, 240, 260, 280, 300, 320, 350, 400]);
  const table: Record<number, number[]> = {
    60: [5, 30, 90, 180, 240, 300],
    100: [10, 50, 150, 300, 400, 500],
    120: [10, 60, 180, 360, 480, 600],
    140: [15, 70, 210, 420, 560, 700],
    160: [15, 80, 240, 480, 640, 800],
    180: [20, 90, 270, 540, 720, 900],
    200: [20, 100, 300, 600, 800, 1000],
    220: [20, 110, 330, 660, 880, 1100],
    240: [25, 120, 360, 720, 960, 1200],
    260: [25, 130, 390, 780, 1040, 1300],
    280: [30, 140, 420, 840, 1120, 1400],
    300: [30, 150, 450, 900, 1200, 1500],
    320: [30, 160, 480, 960, 1280, 1600],
    350: [35, 175, 525, 1050, 1400, 1750],
    400: [40, 200, 600, 1200, 1600, 2000],
  };
  for (const price of prices) {
    const rents = cityRents(price);
    assert.deepEqual(rents, table[price], `price ${price}`);
    assert.deepEqual(rents, [0.1, 0.5, 1.5, 3, 4, 5].map((x) => Math.round((price * x) / 5) * 5), `price ${price}: float formula`);
    assert.ok(rents.every((rent) => Number.isInteger(rent) && rent % 5 === 0));
  }
});

test("cờ tỷ phú: the snapshot has exactly the fields of ENGINE-RULES §8 and is a copy", () => {
  const game = started(2);
  give(game, "p1", 6);
  const state = snapshot(game);
  assert.deepEqual(Object.keys(state).sort(), [
    "again", "buildAt", "builtThisTurn", "card", "debt", "dice", "doubles", "minted", "order", "pendingMove",
    "phase", "players", "props", "result", "rolls", "round", "stage", "turn",
  ]);
  assert.deepEqual(Object.keys(state.players[0]).sort(), ["bankrupt", "cash", "freeCards", "id", "jail", "outAt", "position"]);
  assert.deepEqual(state.props, { "6": { owner: "p1", houses: 0, mortgaged: false } });
  assert.deepEqual(
    state.players.map((p) => p.id),
    ["p0", "p1"],
  );
  game.props[6].houses = 3;
  player(game, 0).freeCards.push("chest");
  assert.equal(state.props["6"].houses, 0);
  assert.deepEqual(state.players[0].freeCards, []);
  assert.equal(JSON.stringify(snapshot(lobby(2))).includes("undefined"), false);
});

test("cờ tỷ phú: generated traces replay exactly on a fresh TS game from their recorded Rng calls", () => {
  const { die, below } = defaultRng;
  defaultRng.die = never.die;
  defaultRng.below = never.below;
  try {
    const ops = new Set<string>();
    for (let g = 0; g < 40; g++) {
      const trace = generateGame(gameSeed(99, g));
      assert.deepEqual(Object.keys(trace).sort(), ["players", "rules", "seed", "steps", "version"]);
      assert.deepEqual(Object.keys(trace.rules).sort(), ["blitz", "cash", "maxRounds", "salary"]);
      if (trace.rules.blitz) assert.ok(trace.rules.cash >= 1670);
      const game = newTraceGame(trace.players, trace.rules);
      assert.ok(trace.steps.length <= 600);
      for (const step of trace.steps) {
        assert.deepEqual(Object.keys(step).sort(), ["index", "ok", "op", "player", "rng", "state"]);
        assert.ok((OPS as readonly string[]).includes(step.op));
        if (["build", "sell", "mortgage", "redeem"].includes(step.op)) assert.ok(Number.isInteger(step.index) && step.index! >= 0 && step.index! <= 255);
        else assert.equal(step.index, null);
        if (step.op !== "start" && step.op !== "auto") assert.equal(typeof step.player, "string");
        const before = JSON.stringify(snapshot(game));
        const rng = scriptedRng(step.rng);
        applyOp(game, step.op, step.player, step.index, rng);
        assert.equal(rng.left(), 0, "every recorded call is used");
        assert.deepEqual(snapshot(game), step.state);
        assert.equal(JSON.stringify(snapshot(game)) !== before, step.ok);
        if (!step.ok) assert.deepEqual(step.rng, [], "a refused action draws nothing");
        ops.add(`${step.op}:${step.ok}`);
      }
      const last = trace.steps.at(-1)!;
      assert.ok(last.state.phase === "ended" || trace.steps.length === 600);
    }
    for (const op of OPS) assert.ok(ops.has(`${op}:true`) && ops.has(`${op}:false`), `${op} both ok and refused`);
  } finally {
    Object.assign(defaultRng, { die, below });
  }
});
