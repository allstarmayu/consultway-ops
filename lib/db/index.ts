/**
 * Shared Drizzle database client.
 *
 * In local dev / scripts, this wraps a `better-sqlite3` connection to
 * a file on disk. In production on Cloudflare Workers, a separate
 * factory will wrap the D1 binding — that split lands when we wire
 * up OpenNext. For now, this is the Node-only client.
 *
 * Import `db` from here; don't instantiate Drizzle elsewhere.
 *
 * @module lib/db
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import * as schema from "./schema";

const log = logger.child({ module: "db" });

/**
 * Singleton SQLite connection.
 *
 * Using a module-level variable means the connection is reused across
 * hot-module-reloads in `next dev`. Without this, HMR would open a new
 * DB handle on every change and eventually exhaust file descriptors.
 */
declare global {
  // eslint-disable-next-line no-var
  var __sqlite: Database.Database | undefined;
}

function getSqliteConnection(): Database.Database {
  if (globalThis.__sqlite) return globalThis.__sqlite;

  log.info("opening sqlite connection", { path: env.DATABASE_URL });
  const sqlite = new Database(env.DATABASE_URL);

  // Pragmas for correctness + performance. Safe defaults for our use case:
  //   - WAL gives us concurrent readers + one writer; better than default rollback journal
  //   - foreign_keys must be ON (SQLite leaves it OFF by default — footgun)
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  globalThis.__sqlite = sqlite;
  return sqlite;
}

/** Shared Drizzle instance. Use this everywhere; don't construct your own. */
export const db = drizzle(getSqliteConnection(), { schema });

/** Re-export schema for convenient `import { db, users } from '@/lib/db'` later. */
export * from "./schema";
