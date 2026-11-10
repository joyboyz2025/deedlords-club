"use client";

import type { CSSProperties, ReactNode } from "react";
import { GROUPS, SALARY, SQUARES, TOKEN_COLORS, cityRents, houseCost, isOwnable } from "../board";
import type { View } from "../view";

/**
 * Ô thứ `index` nằm ở cột, hàng nào của khung `cols` × `rows` (đếm từ 1). Xuất phát ở góc dưới bên phải,
 * đi sang trái, lên trên, sang phải rồi xuống, như bàn cờ thật. Khung có đúng 40 ô quanh viền.
 */
export function cellOf(index: number, cols: number, rows: number): { col: number; row: number } {
  const bottom = cols - 1;
  const left = bottom + rows - 1;
  const top = left + cols - 1;
  if (index <= bottom) return { col: cols - index, row: rows };
  if (index <= left) return { col: 1, row: rows - (index - bottom) };
  if (index <= top) return { col: 1 + (index - left), row: 1 };
  return { col: cols, row: 1 + (index - top) };
}

/** Tên ngắn hai dòng: chữ đầu một dòng, phần còn lại một dòng. */
function nameLines(short: string): [string, string] {
  const space = short.indexOf(" ");
  return space < 0 ? [short, ""] : [short.slice(0, space), short.slice(space + 1)];
}

export const money = (amount: number) => amount.toLocaleString("vi-VN");

type Props = {
  view: View;
  cols: number;
  rows: number;
  /** Vị trí quân đang vẽ, có thể đang đi dở từng bước. */
  positions: Record<string, number>;
  selected: number | null;
  onSelect: (index: number) => void;
  children: ReactNode;
};

export function Board({ view, cols, rows, positions, selected, onSelect, children }: Props) {
  const colorOf = (id: string) => TOKEN_COLORS[view.players.find((p) => p.id === id)?.color ?? 0];
  const tokens = view.order.filter((id) => !view.players.find((p) => p.id === id)?.bankrupt);

  return (
    <div className="tp-board" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)`, aspectRatio: `${cols} / ${rows}` }}>
      {SQUARES.map((square, index) => {
        const { col, row } = cellOf(index, cols, rows);
        const owned = view.props[index];
        const here = tokens.filter((id) => positions[id] === index);
        const [first, second] = nameLines(square.short);
        const style = {
          gridColumn: col,
          gridRow: row,
          "--band": square.kind === "city" ? GROUPS[square.group].color : undefined,
          "--owner": owned ? colorOf(owned.owner) : undefined,
        } as CSSProperties;
        const classes = [
          "tp-cell",
          `tp-cell--${square.kind}`,
          square.kind === "card" && `tp-cell--${square.deck}`,
          owned && "tp-cell--owned",
          owned?.mortgaged && "tp-cell--mortgaged",
          selected === index && "tp-cell--selected",
        ];
        return (
          <button key={index} type="button" className={classes.filter(Boolean).join(" ")} style={style} onClick={() => onSelect(index)} aria-label={cellLabel(view, index)}>
            {square.kind === "city" && (
              <span className="tp-cell__band">
                {owned && owned.houses > 0 && (owned.houses === 5 ? <b className="tp-cell__hotel">KS</b> : <b className="tp-cell__houses">{"■".repeat(owned.houses)}</b>)}
              </span>
            )}
            <span className="tp-cell__name">
              {first}
              {second && <br />}
              {second}
            </span>
            {here.length > 0 && (
              <span className="tp-cell__tokens">
                {here.map((id) => (
                  <i key={id} className={`tp-token${id === view.current ? " tp-token--turn" : ""}`} style={{ background: colorOf(id) }} />
                ))}
              </span>
            )}
          </button>
        );
      })}
      <div className="tp-center" style={{ gridColumn: `2 / ${cols}`, gridRow: `2 / ${rows}` }}>
        {children}
      </div>
    </div>
  );
}

function cellLabel(view: View, index: number): string {
  const square = SQUARES[index];
  const owned = view.props[index];
  const owner = owned && view.players.find((p) => p.id === owned.owner)?.name;
  const parts = [square.name];
  if (isOwnable(square)) parts.push(owner ? `của ${owner}` : `giá ${square.price}`);
  if (owned?.houses) parts.push(owned.houses === 5 ? "có khách sạn" : `${owned.houses} nhà`);
  if (owned?.mortgaged) parts.push("đang cầm cố");
  return parts.join(", ");
}

/** Thông tin một ô: giá, tiền thuê theo số nhà, giá nhà, chủ đất. */
export function SquareDetail({ view, index, onClose }: { view: View; index: number; onClose: () => void }) {
  const square = SQUARES[index];
  const owned = view.props[index];
  const owner = owned && view.players.find((p) => p.id === owned.owner);
  return (
    <div className="tp-detail" role="dialog" aria-label={square.name}>
      <div className="tp-detail__head" style={{ background: square.kind === "city" ? GROUPS[square.group].color : undefined }}>
        <strong>{square.name}</strong>
        <button type="button" className="tp-detail__close" onClick={onClose} aria-label="Đóng">
          ×
        </button>
      </div>
      {square.kind === "city" && (
        <table className="tp-rents">
          <tbody>
            {cityRents(square.price).map((rent, houses) => (
              <tr key={houses} className={owned && owned.houses === houses && !owned.mortgaged ? "tp-rents--now" : undefined}>
                <th>{houses === 0 ? "Đất trống" : houses === 5 ? "Khách sạn" : `${houses} nhà`}</th>
                <td>{money(rent)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {square.kind === "city" && (
        <p>
          Đủ bộ {GROUPS[square.group].name.toLowerCase()} mà chưa có nhà thì tiền thuê gấp đôi. Chủ đất dừng lại ở đây thì xây thêm được một nhà, giá {houseCost(index)}.
        </p>
      )}
      {square.kind === "station" && <p>Tiền vé 25, 50, 100, 200 khi chủ có 1, 2, 3, 4 bến.</p>}
      {square.kind === "utility" && <p>Trả 4 lần số chấm vừa đổ; chủ có cả điện và nước thì 10 lần.</p>}
      {square.kind === "tax" && <p>Đứng vào thì trả ngân hàng {square.amount}.</p>}
      {square.kind === "card" && <p>Đứng vào thì rút một thẻ {square.name}.</p>}
      {square.kind === "start" && <p>Mỗi lần đi qua nhận {money(view.settings.salary ?? SALARY)}.</p>}
      {square.kind === "jail" && <p>Ghé thăm thì không sao. Người bị tạm giữ ra bằng cách đổ đôi, nộp 50 hoặc dùng thẻ.</p>}
      {square.kind === "rest" && <p>Nghỉ chân, không có gì xảy ra.</p>}
      {square.kind === "arrest" && <p>Đứng vào là vào thẳng tạm giữ, không qua Xuất phát.</p>}
      {isOwnable(square) && (
        <p className="tp-detail__owner">
          {owner ? (
            <>
              Của <strong>{owner.name}</strong>
              {owned.mortgaged && ", đang cầm cố"}
            </>
          ) : (
            <>Chưa có chủ. Giá {money(square.price)}, cầm cố được {money(square.price / 2)}.</>
          )}
        </p>
      )}
    </div>
  );
}
