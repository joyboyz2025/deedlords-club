"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { RARITY_NAMES, statLine } from "@/games/town/items";
import { loadTownMe } from "@/games/town/me";
import { readStored, writeStored } from "@/lib/storage";
import { LOOK_CHOICES, NO_ITEMS, TOWN_ONLY, canWear, cleanLook, fitLook, isItemPart, randomLook, rarityOf, roomLook, starterLook, type Look, type LookChoice, type LookPart } from "../look";
import type { LookPreview } from "../scene/preview";
import { sound } from "../sound";
import { PART_TITLES, ROOM_TABS, TOWN_TAB } from "../wardrobe-tabs";

export { PART_TITLES };

const LOOK_KEY = "masoi:look";

/** Món Hiếm, Quý mặc được trên máy này: túi đồ thị trấn chép trong máy (town:me). Khách không có tài khoản thì không có món nào. */
export function ownedHere(): ReadonlySet<string> {
  const items = loadTownMe()?.items;
  return items?.length ? new Set(items) : NO_ITEMS;
}

/**
 * Nhân vật đã chọn lần trước trên máy này, đưa về những món được mặc: phòng mới không phải chọn lại.
 * Thị trấn cũng lưu vào đây khi thay đồ, nên bỏ thú cưng, xe ra: phòng game không có hai món này.
 */
export function savedLook(): Look {
  return roomLook(fitLook(cleanLook(readStored(LOOK_KEY)) ?? starterLook(), ownedHere()));
}

export function saveLook(look: Look): void {
  writeStored(LOOK_KEY, look);
}

/** Khung vẽ nhân vật. Three.js chỉ tải khi mở tủ đồ; máy không có WebGL thì ẩn khung, vẫn chọn được. */
export function LookStage({ look }: { look: Look }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const preview = useRef<LookPreview | null>(null);
  const latest = useRef(look);
  latest.current = look;
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let built: LookPreview | null = null;
    import("../scene/preview")
      .then(({ LookPreview }) => {
        if (cancelled || !canvas.current) return;
        built = new LookPreview(canvas.current, latest.current);
        preview.current = built;
      })
      .catch(() => setBroken(true));
    return () => {
      cancelled = true;
      preview.current = null;
      built?.dispose();
    };
  }, []);

  useEffect(() => {
    preview.current?.setLook(look);
  }, [look]);

  if (broken) return null;
  return <canvas ref={canvas} className="ms-dress__canvas" aria-hidden="true" />;
}

function Swatch({ choice }: { choice: LookChoice }) {
  const background = choice.accent ? `linear-gradient(135deg, ${choice.color} 62%, ${choice.accent} 62%)` : choice.color;
  return <span className="ms-chip__swatch" style={{ background }} />;
}

/** Chấm cấp đồ: xám Cơ bản, xanh Hiếm, vàng Quý. */
export function RarityDot({ part, index }: { part: LookPart; index: number }) {
  return <span className={`ms-rarity ms-rarity--${rarityOf(part, index)}`} aria-hidden="true" />;
}

type Extra = { title: string; dot?: boolean; content: ReactNode };

/** Phần chọn nhân vật, dùng chung cho lúc mới vào phòng, lúc đổi trong phòng chờ và Túi đồ của thị trấn. */
export function Wardrobe({
  look,
  onChange,
  owned = NO_ITEMS,
  stats = false,
  hint = null,
  extra = null,
  town = false,
}: {
  look: Look;
  onChange: (look: Look) => void;
  /** Món Hiếm, Quý mặc được; đồ Cơ bản lúc nào cũng có. */
  owned?: ReadonlySet<string>;
  /** Hiện dòng chỉ số của món đang mặc: chỉ trong thị trấn, nơi chỉ số có tác dụng. */
  stats?: boolean;
  /** Dòng nhắc cuối tủ đồ, như lời mời khách vào thị trấn. */
  hint?: string | null;
  /** Một nhóm riêng sau các nhóm đồ, như mục Rương của Túi đồ. */
  extra?: Extra | null;
  /** Thị trấn: có thêm thẻ Thú cưng & xe, nút Ngẫu nhiên bốc cả thú cưng, xe. Phòng game không truyền. */
  town?: boolean;
}) {
  const [tab, setTab] = useState(0);
  const tabs = town ? [...ROOM_TABS, TOWN_TAB] : ROOM_TABS;

  const choose = (part: LookPart, index: number) => {
    sound.tap();
    onChange({ ...look, [part]: index });
  };
  const shuffle = () => {
    sound.tap();
    // Giữ nguyên giới tính người chơi đã chọn, chỉ đổi phần còn lại, trong những món mặc được.
    onChange(randomLook(look.body, Math.random, owned, town));
  };
  const onExtra = extra !== null && tab === tabs.length;
  // Bộ đồ có màu riêng thì không cần chọn màu áo.
  const parts = onExtra ? [] : tabs[tab].parts.filter((part) => part !== "robe" || !LOOK_CHOICES.outfit[look.outfit].fixed);
  // Thẻ Thú cưng & xe khi chưa có con nào, xe nào: nhắc chỗ có.
  const noTownItems = !onExtra && tabs[tab] === TOWN_TAB && !TOWN_ONLY.some((part) => LOOK_CHOICES[part].some((_, index) => index > 0 && canWear(part, index, owned)));

  return (
    <div className="ms-dress">
      <div className="ms-dress__stage">
        <LookStage look={look} />
        <button type="button" className="ms-btn ms-dress__shuffle" onClick={shuffle}>
          Ngẫu nhiên
        </button>
      </div>
      <div className="ms-dress__panel">
        <div className={`ms-segments${tabs.length + (extra ? 1 : 0) > 4 ? " ms-segments--many" : ""}`} role="group" aria-label="Nhóm lựa chọn">
          {tabs.map(({ title }, index) => (
            <button key={title} type="button" aria-pressed={tab === index} onClick={() => setTab(index)}>
              {title}
            </button>
          ))}
          {extra && (
            <button type="button" aria-pressed={onExtra} onClick={() => setTab(tabs.length)}>
              {extra.title}
              {extra.dot && <span className="ms-dot" aria-hidden="true" />}
            </button>
          )}
        </div>
        {onExtra && extra.content}
        {parts.map((part) => {
          const line = stats ? statLine(part, look[part]) : null;
          return (
            <section key={part} className="ms-dress__part">
              <h3 className="ms-dress__title">{PART_TITLES[part]}</h3>
              <div className="ms-chips" role="group" aria-label={PART_TITLES[part]}>
                {LOOK_CHOICES[part].map((choice, index) => {
                  if (!canWear(part, index, owned)) return null;
                  const rarity = rarityOf(part, index);
                  return (
                    <button
                      key={choice.name}
                      type="button"
                      className={`ms-chip${choice.color ? " ms-chip--color" : ""}`}
                      aria-pressed={look[part] === index}
                      aria-label={rarity > 0 ? `${choice.name}, đồ ${RARITY_NAMES[rarity]}` : choice.name}
                      title={choice.name}
                      onClick={() => choose(part, index)}
                    >
                      {choice.color ? (
                        <Swatch choice={choice} />
                      ) : (
                        <>
                          {isItemPart(part) && <RarityDot part={part} index={index} />}
                          {choice.name}
                        </>
                      )}
                    </button>
                  );
                })}
              </div>
              {line && <p className="ms-dress__stat">{line}</p>}
            </section>
          );
        })}
        {noTownItems && <p className="ms-dress__hint">Thú cưng và xe chỉ có trong rương kho báu. Mỗi bài học xong ở Trường học được một rương.</p>}
        {hint && !onExtra && <p className="ms-dress__hint">{hint}</p>}
      </div>
    </div>
  );
}
