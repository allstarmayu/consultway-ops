/**
 * OpenNext configuration for the Cloudflare deploy target.
 *
 * OpenNext compiles a Next.js app into a single Cloudflare Worker
 * (`.open-next/worker.js`) plus a static-assets directory
 * (`.open-next/assets/`). The Worker handles dynamic routes; static
 * assets are served via the ASSETS binding declared in
 * `wrangler.jsonc`.
 *
 * Cron handling status — **deferred**:
 *
 *   The original draft of this file re-exported `scheduled` from
 *   `@/lib/crons/scheduled-handler` so Cloudflare's cron triggers
 *   could reach the dispatcher. THAT BROKE THE BUILD.
 *
 *   Why: OpenNext bundles whatever this file imports/re-exports into
 *   a temporary `.mjs` config it then dynamically imports. Pulling
 *   `scheduled-handler` in dragged the whole `lib/db` + `better-sqlite3`
 *   transitive graph into that bundle. `better-sqlite3` is a Node-
 *   native CommonJS module; esbuild's CJS→ESM conversion emits
 *   `__filename` references that explode under ESM (`ReferenceError:
 *   __filename is not defined in ES module scope`).
 *
 *   The OpenNext config file is metadata + worker overrides; it's NOT
 *   the place for runtime exports. The right place for `scheduled()`
 *   is the OpenNext-generated worker entry — wired via an `entry`
 *   override (TODO follow-up before Layer B / first prod deploy).
 *
 *   Impact today: cron triggers in `wrangler.jsonc` (the three daily
 *   sweeps) fire against the deployed worker, find no `scheduled()`
 *   export, and silently no-op. For Layer A staging that's fine —
 *   nothing on the demo critical path relies on the once-daily
 *   cleanup jobs.
 *
 * @module open-next.config
 */
import type { OpenNextConfig } from "@opennextjs/cloudflare";

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
