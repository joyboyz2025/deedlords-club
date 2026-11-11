"use client";

import { useEffect, useState } from "react";
import { lookFromSeat } from "../../ma-soi/look";

// The faces at the seats of a match's gate.

const PORTRAIT_PX = 160;
const drawn = new Map<number, Promise<string>>();

/**
 * The face of the character that will stand for each seat, drawn by the same code as the 3D table (loaded on demand,
 * with Three.js). A machine that cannot draw it gets none, and the seat shows its number instead.
 */
export function useSeatPortraits(seats: number): (string | null)[] {
  const [faces, setFaces] = useState<(string | null)[]>([]);
  useEffect(() => {
    let stale = false;
    import("../../town/chibi-draw")
      .then(({ drawPortrait }) =>
        Promise.all(
          Array.from({ length: seats }, (_, seat) => {
            let job = drawn.get(seat);
            if (!job) {
              job = drawPortrait(lookFromSeat(seat), PORTRAIT_PX);
              drawn.set(seat, job);
            }
            return job.catch(() => null);
          }),
        ),
      )
      .then((urls) => !stale && setFaces(urls))
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [seats]);
  return faces;
}
