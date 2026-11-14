// `near:<model>` names NEAR AI. It is the player's own key only while that key is in the browser: the server offers
// `near:` models on its own key too, and an agent whose owner has no key must be able to take one of those.

import assert from "node:assert/strict";
import { test } from "node:test";
import { isOwnModel, modelLabel, onOwnKey } from "../lib/agentKey.ts";

test("a near: model runs on the player's key only when a key is in this browser", () => {
  assert.equal(onOwnKey("near:z-ai/glm-5.3-flash", true), true);
  assert.equal(onOwnKey("near:z-ai/glm-5.3-flash", false), false);
  assert.equal(onOwnKey("gpt-4.1-mini", true), false);
  assert.equal(onOwnKey("rules", true), false);
  // No browser here, so no key: the desk is asked.
  assert.equal(onOwnKey("near:z-ai/glm-5.3-flash"), false);
});

test("the prefix alone still tells a NEAR AI name from a plain one", () => {
  assert.equal(isOwnModel("near:Qwen/Qwen3.6-35B-A3B-FP8"), true);
  assert.equal(isOwnModel("gemini-2.5-flash"), false);
});

test("a model is labelled 'your key' only when it runs on it", () => {
  assert.equal(modelLabel("near:Qwen/Qwen3.6-35B-A3B-FP8"), "Qwen3.6-35B-A3B-FP8 · your key");
  assert.equal(modelLabel("near:Qwen/Qwen3.6-35B-A3B-FP8", false), "Qwen3.6-35B-A3B-FP8");
  assert.equal(modelLabel("gpt-4.1-mini"), "gpt-4.1-mini");
});
