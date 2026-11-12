"use client";

// The player's own NEAR AI key, on the Agents page (lib/agentKey.ts): pasted once, checked with NEAR AI, kept in this
// browser. With it, each agent may run on any chat model NEAR AI serves, paid from the player's own NEAR AI credit.

import { useEffect, useId, useState } from "react";
import { checkNearAiKey, nearAiModels, readNearAiKey, writeNearAiKey, type NearAiModel } from "@/lib/agentKey";

export type NearAi = {
  /** The key is set in this browser (its value is never shown again). */
  hasKey: boolean;
  /** NEAR AI's chat models, cheapest first; `null` while read. Public: listed with or without a key. */
  models: NearAiModel[] | null;
  setKey: (key: string | null) => void;
};

export function useNearAi(): NearAi {
  const [hasKey, setHasKey] = useState(false);
  const [models, setModels] = useState<NearAiModel[] | null>(null);
  useEffect(() => {
    setHasKey(readNearAiKey() !== null);
    let stopped = false;
    nearAiModels().then(
      (list) => !stopped && setModels(list),
      () => !stopped && setModels([]),
    );
    return () => {
      stopped = true;
    };
  }, []);
  return {
    hasKey,
    models,
    setKey: (key) => {
      writeNearAiKey(key);
      setHasKey(Boolean(key?.trim()));
    },
  };
}

/** Pasting, checking and removing the key. */
export function NearAiKeyPanel({ nearAi }: { nearAi: NearAi }) {
  const id = useId();
  const [typed, setTyped] = useState("");
  const [checking, setChecking] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async () => {
    const key = typed.trim();
    if (!key) return;
    setChecking(true);
    setSaid(null);
    const problem = await checkNearAiKey(key);
    setChecking(false);
    if (problem && !problem.startsWith("The key works")) return setSaid({ ok: false, text: problem });
    nearAi.setKey(key);
    setTyped("");
    setSaid({ ok: true, text: problem ?? "NEAR AI answered: the key works." });
  };

  return (
    <div className="fd-nearai">
      <p className="fd-small">
        <b>Your NEAR AI key</b> (optional). With it, each of your agents can run on any of NEAR AI&rsquo;s {nearAi.models?.length || "60-odd"} chat models (Claude, GPT, Gemini,
        DeepSeek, Qwen, GLM&hellip;), paid from your own{" "}
        <a href="https://cloud.near.ai" target="_blank" rel="noreferrer noopener">
          NEAR AI credit
        </a>
        . The key stays in this browser: your tab asks NEAR AI directly, and this site&rsquo;s server never sees it.
      </p>
      {nearAi.hasKey ? (
        <div className="fd-acts">
          <span className="fd-chip">Key saved in this browser</span>
          <button
            type="button"
            className="fd-pill fd-pill--quiet"
            onClick={() => {
              nearAi.setKey(null);
              setSaid(null);
            }}
          >
            Remove the key
          </button>
        </div>
      ) : (
        <div className="fd-nearai__row">
          <label className="fd-field" htmlFor={id}>
            <span>API key</span>
            <input id={id} type="password" value={typed} onChange={(event) => setTyped(event.target.value)} placeholder="sk-…" autoComplete="off" spellCheck={false} />
          </label>
          <button type="button" className="fd-pill fd-pill--ink" disabled={!typed.trim() || checking} onClick={save}>
            {checking ? "Asking NEAR AI…" : "Check and save"}
          </button>
        </div>
      )}
      {said && (
        <p className={said.ok ? "fd-fine" : "fd-problem"} role={said.ok ? "status" : "alert"}>
          {said.text}
        </p>
      )}
    </div>
  );
}
