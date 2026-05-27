import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep `@react-pdf/renderer` out of the server bundle. The library is
  // ~5-7 MiB minified — bundling it pushed the Cloudflare Worker over
  // the 10 MiB ceiling on Workers Paid. Excluding it from the main
  // bundle gets us comfortably under the limit.
  //
  // Trade-off: the `/dashboard/reports/pdf` route loads the lib via a
  // dynamic import wrapped in try/catch. On local dev (node_modules
  // present) the import resolves and PDF generation works as before.
  // On Cloudflare staging/prod the dynamic import fails (Workers don't
  // have npm resolution at runtime), the route catches the failure and
  // returns a friendly 503 explaining PDFs are deferred to a dedicated
  // worker.
  //
  // Future work: ship `@react-pdf/renderer` to a sibling worker
  // (e.g. consultway-ops-pdf) with `--compatibility-flags=nodejs_compat`
  // and POST report payloads to it from the main worker. Out of scope
  // for Layer A; revisit when PDF reports become user-facing.
  serverExternalPackages: ["@react-pdf/renderer"],
};

export default nextConfig;

// ── OpenNext + Cloudflare dev binding hook ─────────────────────────────────
// Wires Cloudflare's local bindings (D1 / R2 / KV) into `pnpm dev` so
// `process.env` / the `db` client work the same way against the
// `.wrangler/consultway-local.sqlite` fixture during dev as they will
// against the real D1 in production.
//
// The hook is a no-op in `pnpm build` — it only runs during
// `next dev`. Wrapped in a try/catch on import so a missing OpenNext
// install doesn't break the Next config (e.g. on a fresh clone where
// `pnpm install` hasn't run yet).
//
// See `open-next.config.ts` for the production worker config.
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();
