"use client";

import { useRef, useState } from "react";
import { Play } from "./icons";

/**
 * A film behind its poster: nothing is fetched until the visitor presses play, then the browser's own controls take
 * over. `label` names the film for the play button.
 */
export function Trailer({ src, poster, label, length }: { src: string; poster: string; label: string; length: string }) {
  const film = useRef<HTMLVideoElement>(null);
  const [started, setStarted] = useState(false);

  const start = () => {
    setStarted(true);
    void film.current?.play().catch(() => undefined);
  };

  return (
    <div className="at-screen" data-started={started || undefined}>
      <video ref={film} src={src} poster={poster} preload="none" controls={started} playsInline muted aria-label={label} />
      {!started && (
        <button type="button" className="at-play" onClick={start}>
          <span aria-hidden="true">
            <Play size={34} />
          </span>
          <b>Play the trailer</b>
          <small>{length} · no sound</small>
        </button>
      )}
    </div>
  );
}
