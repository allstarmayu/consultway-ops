/**
 * Drizzle Kit configuration.
 *
 * Used by the `drizzle-kit` CLI for:
 *   - `drizzle-kit generate` — diff schema, write SQL migration files
 *   - `drizzle-kit migrate`  — apply pending migrations to the DB
 *   - `drizzle-kit push`     — push schema directly without migration files (dev only)
 *   - `drizzle-kit studio`   — open a local web UI to browse tables
 *
 * This config is Node-only — it runs via tsx/esbuild, never in a browser
 * or Worker. It uses `dotenv` to load `.env.local` because Next.js env
 * loading doesn't apply to standalone CLI invocations.
 *
 * @see https://orm.drizzle.team/docs/drizzle-config-file
 */
import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// Use DATABASE_URL if set, else default to the same local path as lib/env.ts.
// We can't import from lib/env here because this file runs before Next.js
// boots and the path alias @/ isn't resolved.
const dbPath =
  process.env.DATABASE_URL ?? "./.wrangler/consultway-local.sqlite";

export default defineConfig({
  dialect: "sqlite",
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: dbPath,
  },
  // Prompts for schema changes in interactive mode. Safer than 'push'
  // for anything we care about.
  verbose: true,
  strict: true,
});
