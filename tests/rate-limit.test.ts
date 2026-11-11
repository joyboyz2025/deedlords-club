// games/co-ty-phu/agent/rateLimit: the per-IP and global counters that cap how often the agent's desk may pay a model.

import assert from "node:assert/strict";
import { test } from "node:test";
import { clientKey, intEnv, rateLimiter, underBudget } from "../games/co-ty-phu/agent/rateLimit.ts";

test("a limiter allows up to its count per window, then refuses until the window turns over", () => {
  let now = 1_000_000;
  const limiter = rateLimiter(3, 1_000);
  const allow = () => {
    const real = Date.now;
    Date.now = () => now;
    try {
      return limiter.allow("a");
    } finally {
      Date.now = real;
    }
  };
  assert.equal(allow(), true);
  assert.equal(allow(), true);
  assert.equal(allow(), true);
  assert.equal(allow(), false, "a fourth call in the same window is refused");
  assert.equal(allow(), false);
  now += 1_000;
  assert.equal(allow(), true, "a new window starts fresh");
});

test("a limiter keeps a separate window per key", () => {
  const limiter = rateLimiter(1, 60_000);
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("a"), false, "the same key is over budget");
  assert.equal(limiter.allow("b"), true, "a different key has its own budget");
});

test("limit 0 or a non-positive window disables the limiter", () => {
  const off = rateLimiter(0, 60_000);
  for (let i = 0; i < 50; i++) assert.equal(off.allow("x"), true);
  const noWindow = rateLimiter(5, 0);
  for (let i = 0; i < 50; i++) assert.equal(noWindow.allow("x"), true);
});

test("underBudget checks the per-IP limiter first, so a blocked caller never spends the global budget", () => {
  const perIp = rateLimiter(1, 60_000);
  const global = rateLimiter(10, 60_000);
  assert.equal(underBudget(perIp, global, "a"), true);
  // "a" is now over its own budget; a second call from "a" must not touch the global counter.
  assert.equal(underBudget(perIp, global, "a"), false);
  // Nine more distinct callers can still each take one of the ten global slots.
  for (let i = 0; i < 9; i++) assert.equal(underBudget(perIp, global, `caller-${i}`), true);
  assert.equal(underBudget(perIp, global, "last"), false, "the global budget is spent");
});

test("intEnv reads a non-negative integer or falls back", () => {
  assert.equal(intEnv("20", 5), 20);
  assert.equal(intEnv("0", 5), 0);
  assert.equal(intEnv(undefined, 5), 5);
  assert.equal(intEnv("", 5), 5);
  assert.equal(intEnv("abc", 5), 5);
  assert.equal(intEnv("-3", 5), 5, "negative is rejected, not clamped");
  assert.equal(intEnv("12.9", 5), 12, "parsed as an integer");
});

test("clientKey reads the first forwarded address, or x-real-ip, or a shared fallback", () => {
  const headers = (entries: Record<string, string>) => new Request("http://x", { headers: entries });
  assert.equal(clientKey(headers({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" })), "203.0.113.5");
  assert.equal(clientKey(headers({ "x-real-ip": "203.0.113.9" })), "203.0.113.9");
  assert.equal(clientKey(headers({})), "unknown");
});
