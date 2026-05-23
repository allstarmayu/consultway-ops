/**
 * Daily pending-row cleanup cron handler.
 *
 * Sweeps abandoned upload-initiations. A `pending` row is created at
 * the moment a presigned upload URL is minted (`initiateDocumentUpload`).
 * If the client never calls `confirmDocumentUpload` - they hit the X
 * mid-upload, their browser crashed, they ran out of network - the row
 * sits in `pending` forever with no corresponding bytes in R2 (the PUT
 * never landed).
 *
 * This sweep deletes those orphans after a grace period (default 1 h)
 * so the documents list isn't littered with phantom rows.
 *
 * Why no R2 cleanup:
 *   By design, `pending` rows have no R2 object behind them. The PUT
 *   that would put bytes there is what triggers the confirm step, and
 *   we never deleted the row before that. If a slow client confirms
 *   AFTER the sweep runs (race condition), the confirm fails - the
 *   row's gone. That's acceptable behaviour because the bytes never
 *   landed either; both sides are consistently empty.
 *
 * Why no per-row audit:
 *   Pending rows are not "real" documents from the user's perspective -
 *   they were never confirmed, never visible in the list (the list
 *   shows them but with a `pending` badge that mostly just exists as
 *   debugging surface). Auditing each sweep would be noise. One
 *   summary log line per run is enough; if forensics ever needs detail,
 *   we extend.
 *
 * @module lib/documents/crons/pending-cleanup
 */
import { and, eq, sql, type SQL } from "drizzle-orm";
import { db, documents } from "@/lib/db";
import type { Logger } from "@/lib/logger";

/**
 * Default age cutoff. Rows in `pending` for longer than this without a
 * confirm get swept.
 *
 * One hour is generous - even a 100 MB upload over a slow mobile
 * connection completes inside this window. We've never seen a
 * legitimate `pending → confirm` round-trip take more than ~5 minutes,
 * so 1 h leaves margin for browser tab-switches, network blips, and
 * the user double-checking they're uploading the right file.
 */
const DEFAULT_AGE_CUTOFF_MINUTES = 60;

/**
 * Drizzle client type. Same pattern as `./expiry-sweep.ts`.
 */
type Database = typeof db;

// ── Dependencies ──────────────────────────────────────────────────────────

export interface PendingCleanupDeps {
  db: Database;
  logger: Pick<Logger, "info" | "warn" | "error">;
  /**
   * "Now" as an ISO-8601 UTC timestamp. Injected so tests drive a
   * specific now and production passes `new Date().toISOString()`.
   */
  now: string;
  /**
   * Override the default 60-minute age cutoff. Tests pass a small value
   * (e.g. 0) to assert behaviour without manipulating fixture timestamps.
   */
  ageCutoffMinutes?: number;
}

// ── Result ────────────────────────────────────────────────────────────────

export interface PendingCleanupResult {
  /** Rows deleted in this sweep. */
  deletedCount: number;
}

// ── Helper ────────────────────────────────────────────────────────────────

/**
 * Subtract N minutes from an ISO-8601 UTC timestamp.
 *
 * Important: the comparison in the WHERE clause uses SQLite's
 * `datetime()` function on BOTH sides so the storage format doesn't
 * affect correctness. The schema default is `datetime('now')` which
 * emits `YYYY-MM-DD HH:MM:SS` (space separator); explicit inserts
 * may emit `YYYY-MM-DDTHH:MM:SS.sssZ` (ISO format). A naive `<` over
 * raw strings would mis-compare across the two formats because
 * ASCII space (0x20) sorts before 'T' (0x54). Routing both through
 * `datetime()` normalises them to the parsed-time form before the
 * comparison.
 */
function isoMinutesAgo(now: string, minutes: number): string {
  const ms = Date.parse(now);
  if (Number.isNaN(ms)) {
    throw new Error(`pending-cleanup: invalid 'now' timestamp: ${now}`);
  }
  return new Date(ms - minutes * 60 * 1000).toISOString();
}

// ── Handler ───────────────────────────────────────────────────────────────

/**
 * Run the daily pending-row cleanup.
 *
 * Pipeline:
 *   1. Compute the cutoff timestamp (`now - ageCutoffMinutes`).
 *   2. DELETE FROM documents WHERE status='pending' AND created_at < cutoff.
 *   3. Log + return count.
 *
 * The DELETE is a single statement - much cheaper than the
 * select-then-delete pattern the expiry-sweep uses (which earned the
 * extra round-trip by needing per-row audit metadata). Here there's
 * nothing to audit, so a single bulk DELETE is fine.
 *
 * Idempotency: a second run with the same `now` deletes nothing because
 * the first run already swept the rows. New `pending` rows accumulate
 * between runs; tomorrow's run picks them up.
 */
export async function runPendingCleanup(
  deps: PendingCleanupDeps,
): Promise<PendingCleanupResult> {
  const cutoffMinutes = deps.ageCutoffMinutes ?? DEFAULT_AGE_CUTOFF_MINUTES;
  const cutoff = isoMinutesAgo(deps.now, cutoffMinutes);

  // SELECT FIRST so we can log the count and (in future) emit a
  // structured audit summary. The two-statement pattern is one extra
  // round-trip but the count is useful for ops dashboards.
  //
  // Better-sqlite3 .run() would return changes but the better-sqlite3
  // driver Drizzle uses doesn't surface that on the .delete() promise
  // in a portable way (D1 drizzle has a different shape). Doing a
  // select-then-delete keeps the return shape stable across drivers.
  // Normalise both sides through SQLite's `datetime()` so the
  // string-format mismatch between schema-default (`YYYY-MM-DD HH:MM:SS`)
  // and explicit ISO inserts (`YYYY-MM-DDTHH:MM:SS.sssZ`) can't cause
  // false matches via lexical ordering. See the helper comment above.
  const olderThanCutoff = sql`datetime(${documents.createdAt}) < datetime(${cutoff})`;

  const candidates = await deps.db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.status, "pending"),
        olderThanCutoff,
      ) as SQL,
    );

  if (candidates.length === 0) {
    deps.logger.info("pending-cleanup: nothing to sweep", {
      cutoff,
      cutoffMinutes,
    });
    return { deletedCount: 0 };
  }

  await deps.db
    .delete(documents)
    .where(
      and(
        eq(documents.status, "pending"),
        olderThanCutoff,
      ) as SQL,
    );

  deps.logger.info("pending-cleanup: rows swept", {
    deletedCount: candidates.length,
    cutoff,
    cutoffMinutes,
    // Sample of ids for forensic spot-checks. Cap at 10 so the log line
    // stays scannable when the sweep is unusually large.
    sampleIds: candidates.slice(0, 10).map((c) => c.id),
  });

  return { deletedCount: candidates.length };
}
