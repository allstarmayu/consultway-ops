/**
 * Health-check endpoint.
 *
 * GET /api/health — returns 200 with a minimal status payload. The
 * post-deploy smoke check in `docs/09-deployment.md` and any future
 * uptime monitor (Cloudflare Health Checks, BetterUptime, etc.) hit
 * this route to confirm the worker is responding.
 *
 * The handler is intentionally trivial: no DB call, no R2 call, no
 * dependency on any session or env-var that could fail and cascade
 * into a false 5xx. If this route returns non-200, the worker itself
 * is broken (deploy issue, missing binding, JS error in middleware) —
 * which is exactly the signal a health check should give.
 *
 * If we ever want a deeper "liveness vs. readiness" split, add a
 * separate `/api/health/deep` that does pulse a DB + R2 call. Keep
 * THIS route trivial so it stays a reliable signal.
 *
 * @module app/api/health/route
 */

export const dynamic = "force-dynamic";

/**
 * Minimal health response. The shape is stable so external monitors
 * can pattern-match on it: `status === "ok"` is the success contract;
 * `version` and `timestamp` are diagnostic context for debugging
 * a flaky probe.
 */
export function GET(): Response {
  const payload = {
    status: "ok" as const,
    version: process.env.NEXT_PUBLIC_APP_NAME ?? "consultway-ops",
    timestamp: new Date().toISOString(),
  };
  return Response.json(payload, {
    status: 200,
    headers: {
      // Don't cache health responses — a stale-from-cache 200 while
      // the worker is actually down defeats the purpose.
      "cache-control": "no-store, max-age=0",
    },
  });
}
