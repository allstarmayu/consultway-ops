/**
 * consultway-ops-pdf — dedicated PDF rendering Worker.
 *
 * Why this worker exists:
 *   `@react-pdf/renderer` is ~5-7 MiB minified. Bundling it into the main
 *   OpenNext worker (`consultway-ops`) pushed that worker over Cloudflare's
 *   10 MiB Workers Paid ceiling during Layer A's first deploys (Day 30).
 *   The fix is single-responsibility: this sibling worker owns the renderer
 *   in its own bundle, and the main worker reaches it over a Cloudflare
 *   service binding (`env.PDF_WORKER`) — see `lib/reports/pdf.tsx`.
 *
 * Surface:
 *   - `POST /render`  — body is a JSON `ReportPdfInput`; returns the PDF
 *                       bytes with `Content-Type: application/pdf`.
 *   - `GET  /health`  — liveness probe; returns `{ status: "ok" }`.
 *   - anything else   — 404.
 *
 * Reachability: this worker runs with `workers_dev: false` (see
 * `workers/pdf/wrangler.jsonc`), so it has NO public URL. It is reachable
 * only via the service binding from the main worker, which keeps the
 * renderer off the public internet — there's no auth on `/render` because
 * nothing outside Cloudflare's network can call it.
 *
 * Decoupling note: this worker does NOT import `@/lib/logger`. That logger
 * pulls in `lib/env.ts`, whose zod schema describes the *main app's* env
 * (R2 keys, JWT secret, Resend) and emits placeholder-secret warnings on
 * boot — all irrelevant here. A tiny inline JSON logger keeps this worker
 * minimal and independent. (Deviation from the "always use lib/logger"
 * standard, justified by the cross-worker boundary.)
 *
 * @module workers/pdf/src/index
 */
import {
  renderReportPdf,
  type ReportPdfInput,
} from "../../../lib/reports/pdf-renderer";

/** Minimal structured log line — JSON to stdout/stderr (Cloudflare wires
 *  console.* into observability automatically). Mirrors the shape of
 *  lib/logger.ts without dragging its env dependency into this worker. */
function logJson(
  level: "info" | "warn" | "error",
  msg: string,
  ctx: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    worker: "consultway-ops-pdf",
    msg,
    ...ctx,
  });
  // eslint-disable-next-line no-console -- see module docstring (decoupled worker)
  (level === "info" ? console.log : console.error)(line);
}

/**
 * Over the wire, `JSON.stringify` turns the optional `generatedAt: Date`
 * into an ISO string. The renderer calls `.toISOString()` on it, which
 * would throw on a raw string — so rehydrate to a `Date` here. When the
 * caller omits it (the common case — the route handler does), the renderer
 * defaults to `new Date()` on the PDF worker's clock.
 */
function rehydrateInput(raw: unknown): ReportPdfInput {
  const input = raw as ReportPdfInput & { generatedAt?: unknown };
  if (typeof input.generatedAt === "string") {
    input.generatedAt = new Date(input.generatedAt);
  }
  return input;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Liveness probe — usable over the service binding for a smoke check.
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok", worker: "consultway-ops-pdf" });
    }

    if (request.method !== "POST" || url.pathname !== "/render") {
      return new Response("Not found", { status: 404 });
    }

    let input: ReportPdfInput;
    try {
      input = rehydrateInput(await request.json());
    } catch (err) {
      logJson("warn", "invalid JSON body on /render", {
        error: err instanceof Error ? err.message : String(err),
      });
      return new Response("Invalid JSON body", { status: 400 });
    }

    try {
      const bytes = await renderReportPdf(input);
      return new Response(bytes, {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Cache-Control": "no-store",
        },
      });
    } catch (err) {
      logJson("error", "renderReportPdf threw", {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return new Response("Failed to render PDF", { status: 500 });
    }
  },
};
