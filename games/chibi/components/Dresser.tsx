"use client";

import { useEffect, useRef, useState } from "react";
import { LOOK_CHOICES, isItemPart, rarityOf, type Look, type LookChoice, type LookPart } from "../../ma-soi/look";
import type { LookPreview } from "../../ma-soi/scene/preview";
import { NAMES_EN, PART_NAMES_EN, RARITY_EN } from "../names";

// Choosing a look: the character turning on a stage (drag to turn it), and the parts in groups. Used to make a
// character (basic items only) and in the bag (what the account holds).

type Group = { title: string; parts: LookPart[] };

export const GROUPS: Group[] = [
  { title: "Body", parts: ["body", "skin", "hair", "hairColor"] },
  { title: "Outfit", parts: ["outfit", "robe", "neck", "shoes"] },
  { title: "Accessories", parts: ["hat", "face", "held"] },
  { title: "Pet & ride", parts: ["pet", "ride"] },
];

/** The character on a small stage of its own, drawn by the game's 3D code (loaded on demand). No WebGL: no stage. */
export function ChibiStage({ look, label }: { look: Look; label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const preview = useRef<LookPreview | null>(null);
  const latest = useRef(look);
  latest.current = look;
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let built: LookPreview | null = null;
    import("../../ma-soi/scene/preview")
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

  if (broken) return <p className="cb-stage cb-stage--none">This device cannot draw the character in 3D.</p>;
  return <canvas ref={canvas} className="cb-stage" role="img" aria-label={label} />;
}

function Swatch({ choice }: { choice: LookChoice }) {
  const background = choice.accent ? `linear-gradient(135deg, ${choice.color} 62%, ${choice.accent} 62%)` : choice.color;
  return <span className="cb-swatch" style={{ background }} />;
}

export function RarityMark({ part, index }: { part: LookPart; index: number }) {
  const rarity = rarityOf(part, index);
  return <span className="cb-rarity" data-rarity={rarity} title={RARITY_EN[rarity]} aria-hidden="true" />;
}

/**
 * The parts of a look in groups, each a row of choices. `allowed` says which choices to show; `badge` may add a
 * word to a choice (how many the account holds). A group with nothing to choose but its bare default is left out.
 */
export function Dresser({
  look,
  onChange,
  allowed,
  badge,
  onShuffle,
  hint,
}: {
  look: Look;
  onChange: (look: Look) => void;
  allowed: (part: LookPart, index: number) => boolean;
  badge?: (part: LookPart, index: number) => string | null;
  onShuffle?: () => void;
  hint?: string | null;
}) {
  const groups = GROUPS.filter((group) => group.parts.some((part) => LOOK_CHOICES[part].some((_, index) => index > 0 && allowed(part, index))));
  const [tab, setTab] = useState(0);
  const group = groups[Math.min(tab, groups.length - 1)];
  // An outfit with colours of its own needs no outfit colour.
  const parts = group.parts.filter((part) => part !== "robe" || !LOOK_CHOICES.outfit[look.outfit]?.fixed);

  return (
    <div className="cb-dresser">
      <div className="cb-dresser__stage">
        <ChibiStage look={look} label="Your character, drag to turn it" />
        {onShuffle && (
          <button type="button" className="cb-shuffle" onClick={onShuffle}>
            Surprise me
          </button>
        )}
      </div>
      <div className="cb-dresser__panel">
        <div className="cb-tabs" role="tablist" aria-label="Parts">
          {groups.map((g, i) => (
            <button key={g.title} type="button" role="tab" aria-selected={g === group} onClick={() => setTab(i)}>
              {g.title}
            </button>
          ))}
        </div>
        {parts.map((part) => (
          <section key={part} className="cb-part" aria-label={PART_NAMES_EN[part]}>
            <h3>{PART_NAMES_EN[part]}</h3>
            <div className="cb-chips" role="group" aria-label={PART_NAMES_EN[part]}>
              {LOOK_CHOICES[part].map((choice, index) => {
                if (!allowed(part, index)) return null;
                const name = NAMES_EN[part][index];
                const extra = badge?.(part, index) ?? null;
                return (
                  <button
                    key={index}
                    type="button"
                    className="cb-chip"
                    data-color={choice.color ? true : undefined}
                    aria-pressed={look[part] === index}
                    aria-label={choice.color ? name : undefined}
                    title={name}
                    onClick={() => onChange({ ...look, [part]: index })}
                  >
                    {choice.color ? (
                      <Swatch choice={choice} />
                    ) : (
                      <>
                        {index > 0 && isItemPart(part) && <RarityMark part={part} index={index} />}
                        {name}
                        {extra && <small>{extra}</small>}
                      </>
                    )}
                  </button>
                );
              })}
            </div>
          </section>
        ))}
        {hint && <p className="cb-hint">{hint}</p>}
      </div>
    </div>
  );
}
