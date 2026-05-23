/**
 * Daily document expiry-sweep cron handler.
 *
 * Single pass over the documents table that does two things:
 *
 *   1. **Past-expiry flip.** Rows with `status = 'verified'` whose
 *      `expires_at <= today` get flipped to `status = 'expired'` and
 *      an audit `document_expired` event is recorded.
 *
 *   2. **Upcoming-expiry reminders.** Rows with `status = 'verified'`
 *      whose `expires_at` is within the next 30 days (today < expires_at
 *      <= today + 30) trigger a reminder email to the owning company's
 *      `contactEmail`. Rows where contactEmail is null are logged and
 *      skipped.
 *
 * Why one handler:
 *   Both queries hit `documents_expires_at_idx`; folding them keeps the
 *   nightly cron to a single function with a single test surface.
 *
 * No dedup table:
 *   Day 11 follow-up. Right now, a row that's 14 days out gets reminded
 *   on day 14, day 13, day 12, ..., day 1. That's noisy but bounded.
 *   The original phase doc planned T-30/T-14/T-7/T-1 with a
 *   `reminders_sent` dedup table; we'll add it when the noise becomes
 *   a real complaint. See `lib/documents/crons/README.md` (not yet
 *   written - tracked) for the planned dedup design.
 *
 * Pure dependency injection:
 *   Every external dep is passed in. Production callers (the Cloudflare
 *   scheduled handler when wiring lands, the `pnpm cron:expiry-sweep`
 *   local script) build the deps explicitly. Tests inject mocks.
 *
 * @module lib/documents/crons/expiry-sweep
 */
import { and, eq, gt, inArray, isNotNull, lte, type SQL } from "drizzle-orm";
import { db, documents, companies } from "@/lib/db";
import type { Document } from "@/lib/db/schema";
import {
  recordAuditEvent,
  SYSTEM_ACTOR_ID,
  type AuditEvent,
} from "@/lib/audit/log";
import type { Logger } from "@/lib/logger";
import { renderExpiryReminderEmail } from "@/lib/email/templates/document-expiry-reminder";
import type { SendEmailArgs, SendEmailResult } from "@/lib/email/client";

/**
 * Drizzle client type. We re-derive it from the exported `db` rather
 * than naming the underlying `BetterSQLite3Database<typeof schema>` so
 * a future migration to D1 (which has a different concrete db type)
 * only needs to change the export in `lib/db/index.ts`, not every
 * caller's signature.
 */
type Database = typeof db;

// ── Dependencies ──────────────────────────────────────────────────────────

/**
 * Everything the handler reads from or writes to that lives outside of
 * itself. Injected so tests can drive the handler without monkey-patching
 * modules.
 *
 * The narrow type aliases (`db`, `logger`) match what production callers
 * naturally have. `sendEmail` matches `lib/email/client.ts::sendEmail`.
 * `recordAuditEvent` is optional - omit to skip audit writes (tests that
 * focus on the email path use this).
 */
export interface ExpirySweepDeps {
  db: Database;
  logger: Pick<Logger, "info" | "warn" | "error">;
  sendEmail: (args: SendEmailArgs) => Promise<SendEmailResult>;
  /** App URL for the deep-link in the reminder email. */
  appUrl: string;
  /**
   * Today's date as `YYYY-MM-DD`. Injected so tests can drive a specific
   * "today" and so production callers control the timezone semantics
   * (we use UTC throughout - same as the schema's date-string convention).
   */
  today: string;
  /**
   * Audit writer. Defaults to the production `recordAuditEvent` when the
   * caller passes no override; tests inject a spy.
   */
  recordAudit?: (event: AuditEvent) => Promise<void>;
}

// ── Result ────────────────────────────────────────────────────────────────

/**
 * Outcome of one sweep run. Surfaced for tests + the local script's
 * "what just happened" output. The counts are simple integers - per-row
 * detail goes to the structured logger.
 */
export interface ExpirySweepResult {
  /** Rows flipped from `verified` to `expired`. */
  expiredCount: number;
  /** Rows in the 30-day window for which we attempted a reminder send. */
  remindersAttempted: number;
  /** Reminders that successfully landed (or stub-logged). */
  remindersSucceeded: number;
  /**
   * Reminders skipped because the owning company has no contactEmail
   * on file. Logged at warn level - somebody should follow up.
   */
  remindersSkippedNoEmail: number;
  /** Reminders attempted that returned ok:false. */
  remindersFailed: number;
}

// ── Constants ─────────────────────────────────────────────────────────────

/**
 * How far ahead we look for upcoming-expiry reminders. 30 days matches
 * the briefing and is comfortably long for the user to act on (renewing
 * a GST certificate takes ~1-2 weeks in practice).
 */
const REMINDER_WINDOW_DAYS = 30;

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Add N days to a YYYY-MM-DD string, returning a YYYY-MM-DD string.
 * Uses UTC midnight throughout so the result is timezone-stable.
 *
 * Implementation note: `Date.parse(YYYY-MM-DD)` is locale-stable when
 * the format has no time component (it's parsed as UTC midnight per
 * ES spec). Output via `toISOString().slice(0, 10)` re-extracts the
 * date portion of the resulting UTC instant.
 */
function addDays(isoDate: string, days: number): string {
  const ms = Date.parse(`${isoDate}T00:00:00.000Z`);
  const out = new Date(ms + days * 24 * 60 * 60 * 1000);
  return out.toISOString().slice(0, 10);
}

/**
 * Days between two YYYY-MM-DD dates (`to - from`, both treated as UTC
 * midnight). Positive when `to` is after `from`.
 */
function daysBetween(from: string, to: string): number {
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((toMs - fromMs) / (1000 * 60 * 60 * 24));
}

// ── Handler ───────────────────────────────────────────────────────────────

/**
 * Run the daily expiry sweep.
 *
 * Pipeline:
 *
 *   PAST-EXPIRY FLIP
 *     1. Find rows: status='verified' AND expires_at IS NOT NULL AND
 *        expires_at <= today. Hits documents_expires_at_idx, then
 *        filters in-app on status (the index covers the date column).
 *     2. For each, update to status='expired' and write the audit event.
 *        Updates happen one-by-one so the audit before/after snapshots
 *        capture exactly the row that changed.
 *
 *   UPCOMING-EXPIRY REMINDERS
 *     3. Find rows: status='verified' AND today < expires_at <= horizon.
 *     4. Collect unique companyIds; batch-fetch contactEmail + name.
 *     5. For each row: render template, sendEmail, increment counter
 *        based on the outcome.
 *
 *   RETURN
 *     6. Summary `ExpirySweepResult`. Per-row detail is in the log lines.
 *
 * Idempotency:
 *   Re-running the same handler with the same `today` is a no-op for
 *   the past-expiry sweep (the first run flipped the rows to `expired`,
 *   so the second run's WHERE matches nothing). The reminder sweep
 *   re-sends - that's the deliberate no-dedup behaviour flagged above.
 */
export async function runExpirySweep(
  deps: ExpirySweepDeps,
): Promise<ExpirySweepResult> {
  const audit = deps.recordAudit ?? recordAuditEvent;
  const horizon = addDays(deps.today, REMINDER_WINDOW_DAYS);

  // ── PAST-EXPIRY FLIP ────────────────────────────────────────────────────

  const pastExpiry: Document[] = await deps.db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.status, "verified"),
        isNotNull(documents.expiresAt),
        // SQLite-safe: lexicographic compare on YYYY-MM-DD == chronological.
        // The isNotNull above keeps the comparison from accidentally
        // matching null rows under SQLite's three-valued logic.
        lte(documents.expiresAt, deps.today),
      ) as SQL,
    );

  let expiredCount = 0;
  for (const row of pastExpiry) {
    try {
      await deps.db
        .update(documents)
        .set({ status: "expired" })
        .where(eq(documents.id, row.id));

      await audit({
        actorId: SYSTEM_ACTOR_ID,
        actorRole: "system",
        action: "document_expired",
        targetType: "document",
        targetId: row.id,
        before: { status: row.status, expiresAt: row.expiresAt },
        after: { status: "expired" },
        metadata: {
          companyId: row.companyId,
          documentType: row.documentType,
          fileName: row.fileName,
          ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
        },
      });

      expiredCount += 1;
      deps.logger.info("document marked expired", {
        documentId: row.id,
        companyId: row.companyId,
        expiresAt: row.expiresAt,
      });
    } catch (err) {
      // One row failing shouldn't poison the rest of the sweep. Log
      // and continue. The next run will pick the row up again.
      deps.logger.error("expiry flip failed for row", {
        err,
        documentId: row.id,
      });
    }
  }

  // ── UPCOMING-EXPIRY REMINDERS ───────────────────────────────────────────

  // Window: today < expires_at <= today + REMINDER_WINDOW_DAYS.
  // Strictly greater-than on the lower bound so rows already-past-expiry
  // (handled above) don't get an email.
  const upcoming: Document[] = await deps.db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.status, "verified"),
        isNotNull(documents.expiresAt),
        gt(documents.expiresAt, deps.today),
        lte(documents.expiresAt, horizon),
      ) as SQL,
    );

  let remindersAttempted = 0;
  let remindersSucceeded = 0;
  let remindersSkippedNoEmail = 0;
  let remindersFailed = 0;

  if (upcoming.length > 0) {
    // Batch-resolve company contactEmail + name in one query, so we
    // don't N+1 the companies table. Build a map keyed by company id.
    const uniqueCompanyIds = Array.from(
      new Set(upcoming.map((r) => r.companyId)),
    );

    // Drizzle `inArray` on a small list. SQLite plans this as an OR
    // chain for short lists, which is exactly what we want at Phase 1
    // scale (a sweep will touch a few dozen companies at most).
    const companyRows = await deps.db
      .select({
        id: companies.id,
        name: companies.name,
        contactEmail: companies.contactEmail,
      })
      .from(companies)
      .where(inArray(companies.id, uniqueCompanyIds));

    const companyById = new Map(companyRows.map((c) => [c.id, c]));

    for (const row of upcoming) {
      const company = companyById.get(row.companyId);
      if (!company) {
        // The cascade FK should prevent this (documents are CASCADE-
        // deleted when their company is removed) but handling it
        // cleanly costs nothing.
        deps.logger.warn(
          "expiry reminder skipped: company missing for document",
          { documentId: row.id, companyId: row.companyId },
        );
        continue;
      }

      if (!company.contactEmail) {
        remindersSkippedNoEmail += 1;
        deps.logger.warn(
          "expiry reminder skipped: company has no contactEmail",
          {
            documentId: row.id,
            companyId: row.companyId,
            companyName: company.name,
          },
        );
        continue;
      }

      // expiresAt is guaranteed non-null here by the WHERE clause above,
      // but TypeScript can't see through the SQL filter.
      const expiresAt = row.expiresAt!;
      const daysToExpiry = daysBetween(deps.today, expiresAt);

      const rendered = renderExpiryReminderEmail({
        document: {
          id: row.id,
          fileName: row.fileName,
          documentType: row.documentType,
          expiresAt,
        },
        company: { id: company.id, name: company.name },
        daysToExpiry,
        appUrl: deps.appUrl,
      });

      remindersAttempted += 1;
      const sendResult = await deps.sendEmail({
        to: company.contactEmail,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });

      if (sendResult.ok) {
        remindersSucceeded += 1;
        deps.logger.info("expiry reminder sent", {
          documentId: row.id,
          companyId: row.companyId,
          daysToExpiry,
          messageId: sendResult.id,
        });
      } else {
        remindersFailed += 1;
        deps.logger.error("expiry reminder send failed", {
          documentId: row.id,
          companyId: row.companyId,
          error: sendResult.error,
        });
      }
    }
  }

  deps.logger.info("expiry sweep complete", {
    today: deps.today,
    horizon,
    expiredCount,
    remindersAttempted,
    remindersSucceeded,
    remindersSkippedNoEmail,
    remindersFailed,
  });

  return {
    expiredCount,
    remindersAttempted,
    remindersSucceeded,
    remindersSkippedNoEmail,
    remindersFailed,
  };
}

