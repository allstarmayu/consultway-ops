import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
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
