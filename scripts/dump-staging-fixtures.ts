/**
 * Dump staging fixtures — reads a SCRATCH SQLite database (seeded at
 * `SEED_SCALE=medium` by `scripts/seed.ts`) and emits an idempotent SQL
 * file of `INSERT … ON CONFLICT DO NOTHING` statements for the entity
 * tables, so the comprehensive dataset can be shipped to the remote
 * staging D1 via:
 *
 *   wrangler d1 execute consultway-staging --remote --env staging \
 *     --file scripts/seed-staging-fixtures.sql
 *
 * Why a scratch DB, not the dev DB:
 *   The source is `.wrangler/seed-dump-source.sqlite` — a throwaway DB we
 *   provision specifically for this dump (empty file → `drizzle-kit
 *   migrate` → `seed.ts`). The dev DB (`.wrangler/consultway-local.sqlite`)
 *   is NEVER read or touched; `assertNotDevDb` below refuses to run
 *   against it.
 *
 * Why `ON CONFLICT DO NOTHING` (target-less):
 *   Re-applying the same file to staging conflicts on the primary key
 *   (`id`) of every already-present row and skips it — safe re-runs. A
 *   target-less `DO NOTHING` also catches natural-key collisions (email,
 *   reference_number, the `(tender_id, company_id)` unique) if the file is
 *   ever regenerated with fresh UUIDs and re-applied over existing data.
 *
 * Emit order is FK-dependency order (parents before children) so the file
 * applies cleanly whether or not the target enforces foreign keys. This
 * intentionally differs from call-site / alphabetical order — see `TABLES`.
 *
 * The only non-trivial logic here is SQL value escaping + statement
 * assembly (`sqlLiteral` / `quoteIdent` / `buildInsertStatement`), which is
 * exported and unit-tested in
 * `scripts/__tests__/dump-staging-fixtures.test.ts`. The rest is a thin
 * better-sqlite3 reader. `main()` is guarded by `!process.env.VITEST` so
 * importing this module in a test does not open a database.
 *
 * @module scripts/dump-staging-fixtures
 */
import Database from "better-sqlite3";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { logger } from "@/lib/logger";

const log = logger.child({ module: "dump-staging-fixtures" });

/** Default scratch source — provisioned just for the dump, NOT the dev DB. */
const DEFAULT_SOURCE = path.join(".wrangler", "seed-dump-source.sqlite");

/** Default output SQL file (a tracked, generated artifact). */
const DEFAULT_OUT = path.join("scripts", "seed-staging-fixtures.sql");

/** The dev DB filename we must never dump from. */
const DEV_DB_BASENAME = "consultway-local.sqlite";

/**
 * Entity tables to dump, in **FK-dependency order** (parents first):
 *
 *   companies → users → tenders → documents → tender_applications →
 *   projects → transactions → reminders_sent
 *
 * Rationale per edge:
 *   - users.company_id            → companies
 *   - tenders.publisher/awarded   → companies
 *   - documents.company_id        → companies; uploaded_by/reviewed_by → users
 *   - tender_applications.*       → tenders, companies
 *   - projects.company_id/tender_id → companies, tenders
 *   - transactions.company_id/project_id → companies, projects
 *   - reminders_sent.document_id  → documents
 *
 * Deliberately excluded: `audit_log`, `user_preferences`, the token tables
 * (not needed for UI population; prefs for the staging admin are handled by
 * `scripts/seed-staging-mayuresh-metadata.sql`).
 */
const TABLES = [
  "companies",
  "users",
  "tenders",
  "documents",
  "tender_applications",
  "projects",
  "transactions",
  "reminders_sent",
] as const;

/**
 * Render a single JS value (as returned by better-sqlite3) as a SQLite
 * literal:
 *
 *   - null / undefined     → `NULL`
 *   - finite number        → decimal literal
 *   - bigint               → decimal literal
 *   - boolean              → `1` / `0` (defensive; raw reads return 0/1 ints)
 *   - Buffer / Uint8Array  → `X'<hex>'` blob literal
 *   - string               → `'…'` with embedded `'` doubled
 *
 * Anything else (objects, arrays, NaN, Infinity) throws — we never want to
 * emit a silently-coerced `"[object Object]"` or `"NaN"` into shipped SQL.
 *
 * @param value - the cell value read from the source DB
 * @returns the SQLite literal text
 */
export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";

  if (typeof value === "bigint") return value.toString();

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot emit non-finite number as SQL literal: ${value}`);
    }
    return String(value);
  }

  if (typeof value === "boolean") return value ? "1" : "0";

  // Node Buffer extends Uint8Array, so this catches both.
  if (value instanceof Uint8Array) {
    return `X'${Buffer.from(value).toString("hex")}'`;
  }

  if (typeof value === "string") {
    return `'${value.replace(/'/g, "''")}'`;
  }

  throw new Error(
    `Unsupported value type for SQL literal: ${Object.prototype.toString.call(value)}`,
  );
}

/**
 * Quote a SQL identifier (table / column name), doubling any embedded `"`.
 *
 * @param name - the raw identifier
 * @returns the double-quoted identifier
 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Build a single idempotent INSERT statement for one row.
 *
 * @param table   - table name (unquoted)
 * @param columns - ordered column names (unquoted)
 * @param row     - row object keyed by column name
 * @returns e.g. `INSERT INTO "x" ("a", "b") VALUES ('1', NULL) ON CONFLICT DO NOTHING;`
 */
export function buildInsertStatement(
  table: string,
  columns: readonly string[],
  row: Record<string, unknown>,
): string {
  const cols = columns.map(quoteIdent).join(", ");
  const vals = columns.map((c) => sqlLiteral(row[c])).join(", ");
  return `INSERT INTO ${quoteIdent(table)} (${cols}) VALUES (${vals}) ON CONFLICT DO NOTHING;`;
}

/** A table's discovered column list plus all of its rows. */
interface TableDump {
  table: string;
  columns: string[];
  rows: Record<string, unknown>[];
}

/**
 * Read a table's column list (via `PRAGMA table_info`, definition order)
 * and all rows ordered by `id` for deterministic output. Throws if the
 * table is absent from the source DB.
 */
function readTable(db: Database.Database, table: string): TableDump {
  const columns = (
    db.pragma(`table_info(${quoteIdent(table)})`) as Array<{ name: string }>
  ).map((c) => c.name);

  if (columns.length === 0) {
    throw new Error(
      `Table "${table}" not found in source DB (no columns). ` +
        `Did migrations run against the scratch DB?`,
    );
  }

  const select = `SELECT ${columns.map(quoteIdent).join(", ")} FROM ${quoteIdent(
    table,
  )} ORDER BY "id"`;
  const rows = db.prepare(select).all() as Record<string, unknown>[];

  return { table, columns, rows };
}

/** Build the explanatory file header (counts + caveats). */
function buildHeader(dumps: TableDump[], source: string): string {
  const counts = dumps
    .map((d) => `--   ${d.table.padEnd(21)}${d.rows.length}`)
    .join("\n");

  return `${[
    "-- Consultway staging fixtures — GENERATED FILE, do not edit by hand.",
    `-- Generated by scripts/dump-staging-fixtures.ts from ${source}`,
    "-- Source seeded at SEED_SCALE=medium by scripts/seed.ts.",
    "--",
    "-- Apply to remote staging D1 (idempotent — ON CONFLICT DO NOTHING):",
    "--   wrangler d1 execute consultway-staging --remote --env staging \\",
    "--     --file scripts/seed-staging-fixtures.sql",
    "--",
    "-- Emit order is FK-dependency order (parents before children) so the",
    "-- file applies cleanly under foreign-key enforcement.",
    "--",
    "-- Row counts:",
    counts,
    "--",
    "-- Caveats baked into this dataset (accepted — see day-32 report):",
    "--   * documents.file_key references R2 objects not yet uploaded →",
    "--     listings/filters work; downloads 404 until the R2 fixture step.",
    "--   * Seeded users' password_hash is hashed against the LOCAL pepper →",
    "--     they cannot sign in on staging. Rows exist for FK + UI only.",
  ].join("\n")}\n\n`;
}

/** Read the scratch DB and write the staging-fixtures SQL file. */
function main(): void {
  const { source, out } = parseArgs(process.argv.slice(2));
  assertNotDevDb(source);

  log.info("opening scratch source DB (readonly)", { source });
  const db = new Database(source, { readonly: true, fileMustExist: true });

  try {
    const dumps = TABLES.map((t) => readTable(db, t));
    const totalRows = dumps.reduce((n, d) => n + d.rows.length, 0);

    const sections = dumps.map((d) => {
      const body =
        d.rows.length === 0
          ? "-- (no rows)"
          : d.rows
              .map((row) => buildInsertStatement(d.table, d.columns, row))
              .join("\n");
      return `-- ${d.table} (${d.rows.length} rows)\n${body}`;
    });

    const sql = `${buildHeader(dumps, source)}${sections.join("\n\n")}\n`;
    writeFileSync(out, sql, "utf8");

    log.info("dump complete", {
      out,
      tables: dumps.length,
      totalRows,
      perTable: Object.fromEntries(dumps.map((d) => [d.table, d.rows.length])),
    });
  } finally {
    db.close();
  }
}

/** Parse `--source=` / `--out=` flags, falling back to defaults / env. */
function parseArgs(argv: string[]): { source: string; out: string } {
  let source = process.env.DUMP_SOURCE ?? DEFAULT_SOURCE;
  let out = DEFAULT_OUT;
  for (const arg of argv) {
    if (arg.startsWith("--source=")) source = arg.slice("--source=".length);
    else if (arg.startsWith("--out=")) out = arg.slice("--out=".length);
  }
  return { source, out };
}

/** Hard guard: never dump from the dev DB. */
function assertNotDevDb(source: string): void {
  if (path.basename(source) === DEV_DB_BASENAME) {
    throw new Error(
      `Refusing to dump from the dev DB (${DEV_DB_BASENAME}). Point ` +
        `--source at the scratch DB (${DEFAULT_SOURCE}).`,
    );
  }
}

// Guard `main()` the same way `scripts/seed.ts` does, so importing this
// module in a vitest test exercises the pure exports without opening a DB.
if (!process.env.VITEST) {
  try {
    main();
  } catch (err) {
    log.error("dump failed", { err });
    process.exitCode = 1;
  }
}
