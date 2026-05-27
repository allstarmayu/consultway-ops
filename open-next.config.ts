/**
 * OpenNext configuration for the Cloudflare deploy target.
 *
 * OpenNext compiles a Next.js app into a single Cloudflare Worker
 * (`.open-next/worker.js`) plus a static-assets directory
 * (`.open-next/assets/`). The Worker handles dynamic routes; static
 * assets are served via the ASSETS binding declared in
 * `wrangler.jsonc`.
 *
 * Config shape:
 *   - `default.override` — overrides for the main worker (everything
 *     except middleware). `cloudflare-node` wrapper runs on the
 *     standard Workers Node-compat runtime. `dummy` for cache + queue
 *     for now; we don't use Next's ISR cache and R2/D1 handle the
 *     real persistence.
 *   - `middleware.override` — overrides for Next middleware, which
 *     OpenNext compiles into a SEPARATE worker. Runs on the edge
 *     runtime so the wrapper is `cloudflare-edge` (no Node compat).
 *     `external: true` keeps it as a distinct worker entry rather
 *     than inlining.
 *   - `edgeExternals: ["node:crypto"]` — `proxy.ts` (our middleware)
 *     uses `crypto.randomUUID()` for session id generation; marking
 *     `node:crypto` as an external lets OpenNext pass it through to
 *     the Cloudflare runtime's built-in instead of bundling.
 *
 * Cron handling status — **deferred**:
 *
 *   The original draft of this file re-exported `scheduled` from
 *   `@/lib/crons/scheduled-handler` so Cloudflare's cron triggers
 *   could reach the dispatcher. THAT BROKE THE BUILD (Deploy
 *   Staging #3..#5) because OpenNext bundles whatever this file
 *   imports/re-exports into a temporary `.mjs` config and dynamic-
 *   imports it. Pulling `scheduled-handler` in dragged the whole
 *   `lib/db` + `better-sqlite3` transitive graph into that bundle.
 *   `better-sqlite3` is a Node-native CommonJS module; esbuild's
 *   CJS→ESM conversion emits `__filename` references that explode
 *   under ESM.
 *
 *   The right place for `scheduled()` is the OpenNext-generated
 *   worker entry — wired via an `entry` override (TODO follow-up
 *   before Layer B / first prod deploy).
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
      wrapper: "cloudflare-node",
      converter: "edge",
      proxyExternalRequest: "fetch",
      incrementalCache: "dummy",
      tagCache: "dummy",
      queue: "dummy",
    },
  },
  middleware: {
    external: true,
    override: {
      wrapper: "cloudflare-edge",
      converter: "edge",
      proxyExternalRequest: "fetch",
      incrementalCache: "dummy",
      tagCache: "dummy",
      queue: "dummy",
    },
  },
  edgeExternals: ["node:crypto"],
};

export default config;
