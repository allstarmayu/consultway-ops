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
 * Slot-based dedup (Day 12):
 *   Each in-window document is bucketed into exactly one of four
 *   reminder slots — `T-30` (15..30 days out), `T-14` (8..14),
 *   `T-7` (2..7), or `T-1` (0..1). Before sending, the cron checks
 *   `reminders_sent` for a row keyed on (document_id, reminder_kind).
 *   If one exists, the send is skipped; if the send succeeds, a new
 *   row is inserted. A row crossing slot boundaries (e.g. yesterday's
 *   day-8 row becomes today's day-7 row) is freshly eligible because
 *   the new kind has never been seen for it.
 *
 *   Failed sends do NOT insert a dedup row, so the next run retries.
 *
 * Pure dependency injection:
 *   Every external dep is passed in. Production callers (the Cloudflare
 *   scheduled handler when wiring lands, the `pnpm cron:expiry-sweep`
 *   local script) build the deps explicitly. Tests inject mocks.
 *
 * @module lib/documents/crons/expiry-sweep
 */
import { and, eq, gt, inArray, isNotNull, lte, type SQL } from "drizzle-orm";
import { db, documents, companies, remindersSent } from "@/lib/db";
import type { Document, ReminderKind } from "@/lib/db/schema";
import { newId } from "@/lib/db/ids";
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
  /**
   * Reminders skipped because a `reminders_sent` row already exists
   * for the same (document, kind) pair. This is the common case once
   * a daily cron is running — the slot's reminder is sent once and
   * subsequent passes for that slot are no-ops.
   */
  remindersSkippedDeduped: number;
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

/**
 * Map a positive days-to-expiry value to its reminder slot. The four
 * slots tile the 30-day reminder window without overlap:
 *
 *   - 0..1  → `T-1`  (last call)
 *   - 2..7  → `T-7`  (urgent)
 *   - 8..14 → `T-14` (renew now)
 *   - 15..30 → `T-30` (heads up)
 *
 * Returns `null` for values outside [0, 30] — the caller's WHERE clause
 * already excludes those, this is belt-and-braces. Past-expiry rows
 * (negative values) get handled by the past-expiry flip pass and never
 * reach this function.
 */
function reminderSlotForDays(daysToExpiry: number): ReminderKind | null {
  if (daysToExpiry < 0 || daysToExpiry > 30) return null;
  if (daysToExpiry <= 1) return "T-1";
  if (daysToExpiry <= 7) return "T-7";
  if (daysToExpiry <= 14) return "T-14";
  return "T-30";
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
  let remindersSkippedDeduped = 0;

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

    // Pre-fetch every existing dedup row for the documents in scope, in
    // one query. Avoids an extra round-trip per document just to ask
    // "have we sent this kind yet?". The set is keyed by the same
    // (documentId, kind) tuple the unique index protects.
    const upcomingIds = upcoming.map((r) => r.id);
    const sentRows = await deps.db
      .select({
        documentId: remindersSent.documentId,
        reminderKind: remindersSent.reminderKind,
      })
      .from(remindersSent)
      .where(inArray(remindersSent.documentId, upcomingIds));
    const alreadySent = new Set(
      sentRows.map((r) => `${r.documentId}|${r.reminderKind}`),
    );

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

      // expiresAt is guaranteed non-null here by the WHERE clause above,
      // but TypeScript can't see through the SQL filter.
      const expiresAt = row.expiresAt!;
      const daysToExpiry = daysBetween(deps.today, expiresAt);
      const slot = reminderSlotForDays(daysToExpiry);

      // The WHERE clause already bounded daysToExpiry to (today, today+30],
      // so `slot` is always non-null here. Defensive null-check anyway —
      // if the WHERE drifts, we'd rather skip than crash.
      if (!slot) {
        deps.logger.warn("expiry reminder skipped: no slot for days", {
          documentId: row.id,
          daysToExpiry,
        });
        continue;
      }

      // Dedup gate. Once a (document, slot) pair has been sent, the
      // unique index in `reminders_sent` makes the slot a one-shot for
      // its window. Crossing into the next slot (e.g. day 8 → 7) is a
      // new tuple and therefore freshly eligible.
      if (alreadySent.has(`${row.id}|${slot}`)) {
        remindersSkippedDeduped += 1;
        deps.logger.info("expiry reminder skipped: already sent for slot", {
          documentId: row.id,
          companyId: row.companyId,
          reminderKind: slot,
          daysToExpiry,
        });
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
          reminderKind: slot,
          daysToExpiry,
          messageId: sendResult.id,
        });

        // Record the dedup row on success. On failure we deliberately
        // skip the insert so the next run retries this (document, slot)
        // pair. A unique-constraint violation here (two cron workers
        // racing on the same minute) is treated as "fine, somebody else
        // got there first" — we log and move on rather than throw.
        try {
          await deps.db.insert(remindersSent).values({
            id: newId(),
            documentId: row.id,
            reminderKind: slot,
            sentAt: new Date().toISOString(),
          });
          alreadySent.add(`${row.id}|${slot}`);
        } catch (err) {
          deps.logger.warn(
            "reminders_sent insert failed (likely race)",
            { err, documentId: row.id, reminderKind: slot },
          );
        }
      } else {
        remindersFailed += 1;
        deps.logger.error("expiry reminder send failed", {
          documentId: row.id,
          companyId: row.companyId,
          reminderKind: slot,
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
    remindersSkippedDeduped,
  });

  return {
    expiredCount,
    remindersAttempted,
    remindersSucceeded,
    remindersSkippedNoEmail,
    remindersFailed,
    remindersSkippedDeduped,
  };
}

