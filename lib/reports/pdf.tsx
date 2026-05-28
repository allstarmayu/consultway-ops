/**
 * Reports PDF — dispatcher to the dedicated PDF rendering Worker.
 *
 * The actual `@react-pdf/renderer` work lives in `lib/reports/pdf-renderer.tsx`,
 * which is bundled ONLY into the sibling `consultway-ops-pdf` worker
 * (`workers/pdf/`). This module is the seam the rest of the app talks to:
 * it forwards the resolved `ReportPdfInput` to that worker over a
 * Cloudflare service binding (`env.PDF_WORKER`) and returns the PDF bytes.
 *
 * Why no inline renderer (not even a lazy import):
 *   `@react-pdf/renderer` is ~5-7 MiB minified. On Day 30 it pushed the
 *   main OpenNext worker over Cloudflare's 10 MiB Workers Paid ceiling and
 *   broke the deploy. To GUARANTEE it never re-enters the main bundle, this
 *   module contains no static OR dynamic import of the renderer — a
 *   bundler-ignored dynamic import would be a gamble across the
 *   webpack → OpenNext → esbuild re-bundling chain, and a failed bundle is
 *   a failed `dev`-push deploy. The renderer is reachable only across the
 *   service-binding network boundary.
 *
 * Runtime behaviour:
 *   - In the deployed worker (and in `pnpm dev` / `pnpm preview` when the
 *     binding is wired): resolves `env.PDF_WORKER` and POSTs the payload to
 *     its `/render` route.
 *   - When the binding is absent (e.g. plain local `next dev` without the
 *     PDF worker running): throws a descriptive error. The route handler
 *     catches it and degrades to a 503 pointing at the HTML report — same
 *     graceful behaviour as the Day-30 stub, no regression.
 *
 * Testing: the renderer's own output is unit-tested directly against
 * `lib/reports/pdf-renderer.tsx` (`lib/reports/__tests__/pdf.test.ts`).
 * This dispatcher is a thin network seam exercised end-to-end on staging.
 *
 * @module lib/reports/pdf
 */
import { getCloudflareContext } from "@opennextjs/cloudflare";

// Re-export the input contract from the renderer so existing consumers
// keep importing the type from `@/lib/reports/pdf` unchanged.
export type { ReportPdfInput } from "./pdf-renderer";
import type { ReportPdfInput } from "./pdf-renderer";

// ── Cloudflare env type augmentation ───────────────────────────────────────

// Declaration-merges with the augmentation in `lib/db/index.ts`. The
// service binding exposes a `fetch` method (a `Fetcher`); we type it
// structurally to avoid pulling in `@cloudflare/workers-types` just for
// this one shape — same convention as the DB/R2/KV bindings.
declare global {
  interface CloudflareEnv {
    PDF_WORKER?: { fetch: (request: Request) => Promise<Response> };
  }
}

/**
 * Internal URL used for the service-binding fetch. The host is irrelevant
 * for service bindings (Cloudflare routes the call to the bound worker by
 * the binding, not by DNS) — only the path (`/render`) matters, which the
 * PDF worker switches on.
 */
const PDF_RENDER_URL = "https://pdf-worker.internal/render";

/**
 * Render the report payload to a PDF byte buffer by delegating to the
 * `consultway-ops-pdf` worker over the `PDF_WORKER` service binding.
 *
 * @param input - Resolved report payload (period, role, aggregates).
 * @returns The PDF file bytes, ready to hand to `NextResponse`.
 * @throws If the service binding is unavailable, or the PDF worker returns
 *         a non-2xx response. The route handler maps these to 503 / 500.
 */
export async function renderReportPdf(
  input: ReportPdfInput,
): Promise<Uint8Array<ArrayBuffer>> {
  const { env } = getCloudflareContext({ async: false }) as {
    env: CloudflareEnv;
  };

  const pdfWorker = env.PDF_WORKER;
  if (!pdfWorker) {
    throw new Error(
      "PDF_WORKER service binding not configured. The dedicated PDF " +
        "worker (consultway-ops-pdf) must be deployed and bound in " +
        "wrangler.jsonc for the active environment. See " +
        "docs/DEPLOY_PDF_WORKER.md.",
    );
  }

  const response = await pdfWorker.fetch(
    new Request(PDF_RENDER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `PDF worker returned ${response.status} ${response.statusText}` +
        (detail ? `: ${detail}` : ""),
    );
  }

  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}
