/**
 * OpenNext configuration for the Cloudflare deploy target.
 *
 * OpenNext compiles a Next.js app into a single Cloudflare Worker
 * (`.open-next/worker.js`) plus a static-assets directory
 * (`.open-next/assets/`). The Worker handles dynamic routes; static
 * assets are served via the ASSETS binding declared in
 * `wrangler.jsonc`.
 *
 * Why this file exists at all (vs. zero-config):
 *   1. Re-exporting `scheduled` lets Cloudflare's cron triggers reach
 *      our `lib/crons/scheduled-handler.ts` dispatcher. Without this
 *      hook, the cron trigger fires the worker but no handler picks
 *      it up — the invocation silently 404s.
 *   2. The default OpenNext config uses the in-memory queue + cache.
 *      That's fine for Phase 1 — D1 + R2 cover persistence; we don't
 *      use Next's ISR cache. Future phases may want the Cloudflare KV
 *      queue/cache adapters for cross-invocation persistence; the
 *      changeover is a single import here.
 *
 * @module open-next.config
 */
import type { OpenNextConfig } from "@opennextjs/cloudflare";

// Re-export the cron dispatcher so the OpenNext-generated worker
// entrypoint includes a `scheduled()` export. The Cloudflare runtime
// invokes that named export once per matching `triggers.crons` entry
// in `wrangler.jsonc`. Our handler in `lib/crons/scheduled-handler.ts`
// dispatches on the cron pattern to the right cleanup routine.
export { scheduled } from "@/lib/crons/scheduled-handler";

const config: OpenNextConfig = {
  default: {
    override: {
      // Default OpenNext build pipeline — no overrides yet. Listed
      // explicitly so future additions (e.g. a Cloudflare KV-backed
      // queue/cache) drop in next to this comment rather than
      // sprouting at the top level.
      wrapper: "cloudflare-node",
      converter: "edge",
      proxyExternalRequest: "fetch",
      incrementalCache: "dummy",
      tagCache: "dummy",
      queue: "dummy",
    },
  },
};

export default config;
