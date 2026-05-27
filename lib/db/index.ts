/**
 * Shared Drizzle database client — runtime-aware.
 *
 * Two adapters, one import path:
 *   - **Cloudflare Workers (production):** uses the D1 binding
 *     (`env.DB`) via Drizzle's `drizzle-orm/d1` adapter. Per-request
 *     resolution via OpenNext's `getCloudflareContext()`.
 *   - **Local dev / scripts / tests (Node):** uses `better-sqlite3`
 *     opening the `.wrangler/consultway-local.sqlite` file. Cached
 *     on `globalThis.__sqlite` so HMR doesn't exhaust file
 *     descriptors.
 *
 * Why a Proxy and not a function:
 *
 *   80+ files across the codebase import `{ db } from "@/lib/db"`
 *   and use it as a module-level constant (`db.select().from(...)`).
 *   Refactoring every caller to `const db = getDb()` would touch
 *   ~80 files and risk subtle bugs. A Proxy preserves the existing
 *   API exactly: each property access on `db` resolves through the
 *   trap, which returns the right adapter for the current runtime.
 *
 *   Drizzle's better-sqlite3 (sync) and D1 (async) adapters expose
 *   the same chainable query-builder surface (`.select`, `.insert`,
 *   `.update`, `.delete`, `.transaction`, `.with`, etc.) and both
 *   return thenable objects — so call sites that already use
 *   `await db.select()...` work uniformly across both runtimes.
 *
 * Detection:
 *
 *   We check `navigator.userAgent === "Cloudflare-Workers"`, which
 *   is the documented Cloudflare runtime sentinel. The check is
 *   cheap and synchronous. If we're in a Worker, we resolve the D1
 *   binding via `getCloudflareContext({ async: false })` — this
 *   requires the `nodejs_als` compatibility flag in wrangler.jsonc,
 *   which is already on as of commit 30b400b.
 *
 * Layer A landing context: this module's original implementation
 * unconditionally opened a local SQLite file via `better-sqlite3`,
 * which crashed in the deployed Worker (no filesystem) with
 * "Could not find module root given file: worker.js". This file
 * is the fix for that failure mode.
 *
 * @module lib/db
 */
import Database from "better-sqlite3";
import { drizzle as drizzleBetter } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import * as schema from "./schema";

const log = logger.child({ module: "db" });

// ── Cloudflare env type augmentation ───────────────────────────────────────

// Tell TypeScript that our Worker env includes the D1 + R2 + KV
// bindings we declared in wrangler.jsonc. OpenNext's stub interface
// (CloudflareEnv) doesn't know about app-specific bindings.
//
// We use `unknown` instead of the real Cloudflare runtime types
// (D1Database, R2Bucket, KVNamespace) because @cloudflare/workers-types
// isn't a project dep and pulling it in just for type augmentation
// adds noise. At the consumer (`resolveDb` below) we cast to the
// drizzle-orm/d1 expected shape, which works structurally with the
// runtime D1Database instance.
declare global {
  interface CloudflareEnv {
    DB?: unknown;
    DOCS?: unknown;
    SESSIONS?: unknown;
    RATE_LIMITS?: unknown;
  }
}

// ── Runtime detection + per-runtime DB resolution ──────────────────────────

/**
 * `true` when we're running inside a Cloudflare Worker. Workerd sets
 * `navigator.userAgent` to this exact string. Checked once at module
 * load — the value doesn't change during a process's lifetime.
 */
const IS_WORKER =
  typeof navigator !== "undefined" &&
  navigator.userAgent === "Cloudflare-Workers";

/** Better-sqlite3 connection singleton (Node mode only). */
declare global {
  // eslint-disable-next-line no-var
  var __sqlite: Database.Database | undefined;
}

function getSqliteConnection(): Database.Database {
  if (globalThis.__sqlite) return globalThis.__sqlite;

  // Tests run against an in-memory SQLite database so each worker process
  // gets a clean schema and doesn't read/write the dev DB file.
  const path = env.NODE_ENV === "test" ? ":memory:" : env.DATABASE_URL;

  log.info("opening sqlite connection (node mode)", { path });
  const sqlite = new Database(path);

  if (env.NODE_ENV !== "test") {
    sqlite.pragma("journal_mode = WAL");
  }
  sqlite.pragma("foreign_keys = ON");

  globalThis.__sqlite = sqlite;
  return sqlite;
}

/**
 * Resolve the right Drizzle instance for the current runtime.
 *
 * In Node: cached after first call (better-sqlite3 connection is
 * a singleton on globalThis).
 *
 * In Worker: re-resolved on each access. The D1 binding lookup via
 * `getCloudflareContext()` is cheap (just AsyncLocalStorage), and
 * Drizzle's D1 wrapper is a thin object — re-wrapping per call has
 * no measurable cost.
 *
 * Throws if called in Worker context without the binding — usually
 * means the wrangler.jsonc didn't declare the binding for the active
 * environment.
 */
function resolveDb(): ReturnType<typeof drizzleBetter<typeof schema>> {
  if (IS_WORKER) {
    // Dynamic require so Node-mode callers (tests, scripts) never even
    // touch the OpenNext module — keeps the Node import graph free
    // of Worker-only deps.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getCloudflareContext } = require("@opennextjs/cloudflare");
    const { env: cfEnv } = getCloudflareContext({ async: false }) as {
      env: CloudflareEnv;
    };
    if (!cfEnv.DB) {
      throw new Error(
        "D1 binding 'DB' not found in Cloudflare env. Check " +
          "wrangler.jsonc's d1_databases for the active environment.",
      );
    }
    // Cast the binding to the D1 shape drizzle-orm/d1 expects. The
    // runtime D1Database instance is structurally compatible; the
    // cast is purely to satisfy TypeScript without importing
    // @cloudflare/workers-types.
    return drizzleD1(
      cfEnv.DB as Parameters<typeof drizzleD1>[0],
      { schema },
    ) as unknown as ReturnType<typeof drizzleBetter<typeof schema>>;
  }
  return drizzleBetter(getSqliteConnection(), { schema });
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Shared Drizzle instance — same import path as before, but now
 * runtime-aware. In a Worker each property access re-resolves through
 * the D1 binding; in Node it falls back to the cached better-sqlite3
 * connection. Existing call sites (`db.select().from(...).where(...)`)
 * work unchanged.
 *
 * The Proxy adds one indirection per property access — negligible
 * for non-hot-path query construction. Hot paths (the inside of a
 * Drizzle query builder) operate on the resolved Drizzle instance
 * directly, with no proxy involvement.
 */
export const db = new Proxy(
  {} as ReturnType<typeof drizzleBetter<typeof schema>>,
  {
    get(_target, prop, receiver) {
      const real = resolveDb();
      const value = Reflect.get(real, prop, receiver);
      // Bind methods so `this` resolves correctly inside Drizzle.
      return typeof value === "function" ? value.bind(real) : value;
    },
  },
);

/** Re-export schema for convenient `import { db, users } from '@/lib/db'`. */
export * from "./schema";
