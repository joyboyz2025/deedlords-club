"use client";

import { useEffect, useState } from "react";
import { isMuted, prepareSound, setMuted } from "@/lib/sound";

export function SoundToggle() {
  const [muted, setMutedState] = useState(false);

  useEffect(() => {
    prepareSound();
    setMutedState(isMuted());
  }, []);

  const toggle = () => {
    setMuted(!muted);
    setMutedState(!muted);
  };

  return (
    <button type="button" className="icon-button" onClick={toggle} aria-pressed={!muted} aria-label={muted ? "Turn sound on" : "Turn sound off"}>
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 9.5v5h3.5L12 19V5L7.5 9.5H4Z" fill="currentColor" />
        {muted ? <path d="m16 9.5 5 5m0-5-5 5" /> : <path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11" />}
      </svg>
    </button>
  );
}
