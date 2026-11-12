"use client";

import { useEffect, useRef, useState } from "react";
import type { Look } from "@/games/ma-soi/look";

// Five characters as the tables draw them: the code that draws a seat's figure in a waiting room draws these, from
// looks anybody can put together in the dresser. Three.js is fetched, and the figures drawn, only once the row is
// close to the screen; a machine that cannot draw keeps the empty pads.

const CAST: { name: string; look: Look }[] = [
  { name: "Captain Rin", look: { body: 0, skin: 1, hair: 9, hairColor: 1, outfit: 12, robe: 1, neck: 0, hat: 15, face: 3, held: 6, shoes: 0, pet: 0, ride: 0 } },
  { name: "Mai", look: { body: 1, skin: 0, hair: 12, hairColor: 5, outfit: 20, robe: 5, neck: 9, hat: 5, face: 0, held: 7, shoes: 0, pet: 1, ride: 0 } },
  { name: "Bolt", look: { body: 0, skin: 3, hair: 2, hairColor: 0, outfit: 15, robe: 3, neck: 4, hat: 0, face: 9, held: 11, shoes: 3, pet: 0, ride: 2 } },
  { name: "Hazel", look: { body: 1, skin: 2, hair: 8, hairColor: 4, outfit: 14, robe: 7, neck: 0, hat: 16, face: 1, held: 12, shoes: 0, pet: 6, ride: 0 } },
  { name: "Old Khan", look: { body: 0, skin: 1, hair: 6, hairColor: 0, outfit: 5, robe: 0, neck: 0, hat: 10, face: 5, held: 1, shoes: 0, pet: 0, ride: 0 } },
];
const PX = 420;

export function Cast() {
  const row = useRef<HTMLUListElement>(null);
  const [figures, setFigures] = useState<(string | null)[]>([]);

  useEffect(() => {
    const node = row.current;
    if (!node) return;
    let stale = false;
    const watch = new IntersectionObserver(
      (seen) => {
        if (!seen.some((entry) => entry.isIntersecting)) return;
        watch.disconnect();
        import("@/games/town/chibi-draw")
          .then(({ drawFigure }) => Promise.all(CAST.map((one) => drawFigure(one.look, PX).catch(() => null))))
          .then((drawn) => !stale && setFigures(drawn))
          .catch(() => undefined);
      },
      { rootMargin: "600px 0px" },
    );
    watch.observe(node);
    return () => {
      stale = true;
      watch.disconnect();
    };
  }, []);

  return (
    <ul className="lp-cast__row" ref={row} aria-label="Five characters, drawn as the tables draw them">
      {CAST.map((one, index) => (
        <li key={one.name} style={{ "--i": index } as React.CSSProperties}>
          <span className="lp-cast__figure">{figures[index] && <img src={figures[index]!} alt="" width={PX} height={PX} />}</span>
          <b>{one.name}</b>
        </li>
      ))}
    </ul>
  );
}
