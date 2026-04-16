/**
 * Drizzle schema — single source of truth for the database.
 *
 * Every table is exported from this file. drizzle-kit reads this file
 * to diff against the current DB state and generate migrations.
 *
 * Cloudflare D1 is SQLite — so we use `drizzle-orm/sqlite-core`, not
 * `pg-core` or `mysql-core`. SQLite gotchas to keep in mind:
 *   - No native enums → use text() with CHECK constraints
 *   - No native booleans → integer(..., { mode: 'boolean' })
 *   - No native timestamps → text() with ISO-8601 strings (or integer Unix ms)
 *   - No JSONB → text(..., { mode: 'json' }) + manual validation
 *
 * @module lib/db/schema
 */

// Schema tables are added in Chunk 3.
// Keeping this file as a barrel so drizzle-kit has something to point at.
export {};
