// A cheap guard on how often the agent's desk may call a paid model service, so a public deployment cannot be made to
// run up the owner's bill by one visitor hammering it or by ordinary traffic adding up past a safe ceiling. This is
// not a security boundary: counters live in process memory, are per server instance, and reset on a redeploy or a
// restart. It exists to bound cost on an unattended demo, not to withstand a determined attacker (nothing here stops
// an attacker from calling the model service directly with their own key).
//
// Two kinds of limit, both fixed-window counters: a per-caller one (keyed by IP, best-effort) stops one visitor from
// spending the budget alone, and a global one caps every model call this process makes in the window, whoever asked.

type Window = { count: number; startedAt: number };

export type Limiter = {
  /** True and counted toward the window, or false and not counted: the caller should not proceed. */
  allow: (key: string) => boolean;
};

/**
 * `limit` calls per `windowMs`, per distinct `key` passed to `allow`. `limit <= 0` disables the limit (always allows),
 * for local development or a deployment that trusts its traffic.
 */
export function rateLimiter(limit: number, windowMs: number): Limiter {
  if (!(limit > 0) || !(windowMs > 0)) return { allow: () => true };
  const windows = new Map<string, Window>();
  return {
    allow(key: string): boolean {
      const now = Date.now();
      const current = windows.get(key);
      if (!current || now - current.startedAt >= windowMs) {
        windows.set(key, { count: 1, startedAt: now });
        // Stale windows accumulate one key per distinct caller; sweep them out instead of growing forever.
        if (windows.size > 1000) for (const [k, w] of windows) if (now - w.startedAt >= windowMs) windows.delete(k);
        return true;
      }
      if (current.count >= limit) return false;
      current.count += 1;
      return true;
    },
  };
}

/** An environment variable as a non-negative integer, or `fallback` when it is unset or not a number. */
export function intEnv(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? NaN : Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** The caller's address, best-effort, from the headers a reverse proxy sets; shares one bucket when none are present. */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim() || "unknown";
  return request.headers.get("x-real-ip") ?? "unknown";
}

const ALL = "*";

/** `perIp` first (so one blocked caller never spends the global budget), then the shared `global` window. */
export function underBudget(perIp: Limiter, global: Limiter, ip: string): boolean {
  return perIp.allow(ip) && global.allow(ALL);
}
