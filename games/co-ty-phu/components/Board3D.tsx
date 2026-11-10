"use client";

import { useEffect, useRef } from "react";
import type { CameraMode, TycoonScene } from "../scene/tycoon";
import { sound } from "../sound";
import type { View } from "../view";

type Props = {
  view: View;
  /** Tiền đang hiện của từng người (quân chưa tới nơi thì vẫn là số cũ): đổi thì số cộng trừ nổi trên đầu người đó. */
  cash: Record<string, number>;
  selected: number | null;
  mode: CameraMode;
  /** Nhìn cả bàn thì chừa chừng này điểm ảnh ở hai bên (`x`) và ở trên, dưới (`y`) cho thẻ người chơi và các nút. */
  insets: { x: number; y: number };
  /** Đang bán nhà, cầm cố: chỉ sáng những ô này kèm số tiền nhận, các ô khác tối đi. `null` thì bàn như thường. */
  focus: Map<number, number> | null;
  onTile: (index: number) => void;
  /** Xúc xắc đã dừng và quân người vừa đổ đã tới nơi. */
  onArrive: (rolls: number) => void;
  /** Máy không vẽ được 3D: dùng bàn cờ 2D thay cho cảnh. */
  onBroken: () => void;
};

/** Khung vẽ bàn cờ 3D. Three.js chỉ tải khi vào ván, dùng chung bản đã tải với Ma Sói và thị trấn. */
export function Board3D({ view, cash, selected, mode, insets, focus, onTile, onArrive, onBroken }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<TycoonScene | null>(null);
  const latest = useRef({ view, selected, mode, insets, focus, onTile, onArrive, onBroken });
  latest.current = { view, selected, mode, insets, focus, onTile, onArrive, onBroken };

  useEffect(() => {
    let cancelled = false;
    let built: TycoonScene | null = null;
    import("../scene/tycoon")
      .then(({ TycoonScene }) => {
        if (cancelled || !canvas.current) return;
        built = new TycoonScene(canvas.current, {
          onTile: (index) => latest.current.onTile(index),
          onStep: () => sound.step(),
          onHit: (strength) => sound.hit(strength),
          onBuild: () => sound.build(),
          onArrive: (rolls) => latest.current.onArrive(rolls),
        });
        scene.current = built;
        built.setInsets(latest.current.insets);
        built.setMode(latest.current.mode);
        built.update(latest.current.view);
        built.select(latest.current.selected);
        built.setFocus(latest.current.focus);
      })
      .catch(() => latest.current.onBroken());
    return () => {
      cancelled = true;
      scene.current = null;
      built?.dispose();
    };
  }, []);

  useEffect(() => {
    scene.current?.update(view);
  }, [view]);

  useEffect(() => {
    scene.current?.select(selected);
  }, [selected]);

  // Tiền ai đổi thì số cộng trừ nổi trên đầu người đó, kèm một tiếng tiền cho cả lượt đổi.
  const shownCash = useRef<Record<string, number> | null>(null);
  const cashKey = JSON.stringify(cash);
  useEffect(() => {
    const before = shownCash.current;
    shownCash.current = cash;
    if (!before) return;
    let gained = false;
    let lost = false;
    for (const [id, amount] of Object.entries(cash)) {
      const change = amount - (before[id] ?? amount);
      if (change === 0) continue;
      scene.current?.floatMoney(id, change);
      if (change > 0) gained = true;
      else lost = true;
    }
    if (lost) sound.pay();
    else if (gained) sound.coin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cashKey]);

  useEffect(() => {
    scene.current?.setMode(mode);
  }, [mode]);

  useEffect(() => {
    scene.current?.setInsets(insets);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insets.x, insets.y]);

  // Danh sách ô sáng tạo mới mỗi lần vẽ, nên so theo nội dung.
  const focusKey = focus ? JSON.stringify([...focus]) : null;
  useEffect(() => {
    scene.current?.setFocus(focus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);

  return <canvas ref={canvas} className="tp-scene" aria-hidden="true" />;
}
