/**
 * Audit logging - record who did what, to which entity, with optional
 * before / after snapshots and free-form metadata.
 *
 * Day 6: the body now persists to the `audit_log` table in D1 in addition
 * to emitting the structured log line. Callers do NOT change - every
 * existing `recordAuditEvent` call site across companies, tenders, and
 * tender_applications continues to work without edit. The "callers don't
 * change" promise that justified routing every mutation through this
 * helper since Day 2 is preserved.
 *
 * Day 6 target-type addition: `tender_application` joined the
 * `AuditTargetType` union. Application-state-change events (withdraw,
 * decide, reinstate, recall) now log against the application id directly
 * instead of the parent tender id, with `tenderId` moved into
 * `metadata.tenderId`. This is what lets Day 7's per-application history
 * tab be a single indexed lookup. The `tender_applied` event (a company
 * submitting an application) intentionally stays scoped to the tender -
 * it's a "this tender received a submission" event from the audit-trail
 * reader's perspective, not a per-application one.
 *
 * Failure semantics: this function NEVER throws. A failed audit must not
 * break a successful user action - the user already got their work done,
 * and a degraded audit trail beats a failed action. On insert failure we
 * log an error via the structured logger and return normally. The
 * structured-log line is emitted BEFORE the insert attempt, so even on a
 * total D1 outage we still have a grep-able trail in the Workers log
 * stream.
 *
 * Reversal verbs (Day 5):
 *   - `tender_reopened`           - admin moved a closed tender back to
 *                                   published. Optional reason in
 *                                   `metadata.reason`.
 *   - `tender_award_retracted`    - admin moved an awarded tender back
 *                                   to closed. REQUIRED reason in
 *                                   `metadata.reason`.
 *   - `application_reinstated`    - admin/staff moved a shortlisted /
 *                                   rejected application back to
 *                                   submitted. `decidedAt` is cleared
 *                                   to NULL on the row; the audit event
 *                                   preserves the original decision time
 *                                   under `metadata.previousDecidedAt`.
 *   - `application_recalled`      - company moved their own withdrawn
 *                                   application back to submitted within
 *                                   the recall window. `daysSinceWithdrawal`
 *                                   captured in metadata.
 *
 * @module lib/audit/log
 */
import { db, auditLog } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { logger } from "@/lib/logger";

const log = logger.child({ module: "audit" });

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * The kinds of entities we audit. Keep this union closed - adding a new
 * entity is a deliberate change, not something callers should pass as a
 * free-form string. Each addition should be accompanied by a clear
 * articulation of which actions target it (see Day 6 commentary above for
 * the `tender_application` rationale).
 */
export type AuditTargetType =
  | "company"
  | "user"
  | "tender"
  | "tender_application"
  | "project"
  | "transaction"
  | "document";

/**
 * What was done to the target. The triplet `created / updated / deleted`
 * covers most cases; specific status changes that are interesting enough
 * to filter on get their own verbs.
 *
 * Verb choice rule of thumb: if "show me all X events last week" is a
 * query the audit UI will eventually need to answer, X earns a verb.
 * Otherwise it folds into `updated` with detail in `metadata`.
 */
export type AuditAction =
  | "created"
  | "updated"
  | "deleted"
  | "compliance_status_changed"
  | "document_uploaded"
  | "document_expired"
  | "tender_published"
  | "tender_applied"
  // ── Reversal verbs (Day 5) ─────────────────────────────────────────────
  | "tender_reopened"
  | "tender_award_retracted"
  | "application_reinstated"
  | "application_recalled";

/**
 * Single audit event. Maps 1:1 to a row in the `audit_log` table.
 *
 *   - `actorId` and `actorRole` identify who performed the action.
 *     `actorRole` is denormalised so we can answer "what did admins do
 *     this week" without a join. The actor's company affiliation, if any,
 *     is recovered via a join on `users.id` when needed - we deliberately
 *     do NOT carry `actorCompanyId` on every row.
 *
 *   - `before` / `after` snapshots are optional. For `created` only
 *     `after` makes sense; for `deleted` only `before`; for `updated`
 *     both. Snapshots are partial - they include only the fields the
 *     action touched, not the entire row.
 *
 *   - `metadata` is free-form for action-specific extra context. For
 *     application-state events on `targetType: "tender_application"`,
 *     `metadata.tenderId` is the conventional way to surface the parent
 *     tender so reverse queries can find applications by tender without
 *     a join.
 */
export interface AuditEvent {
  actorId: string;
  actorRole: "admin" | "staff" | "company";
  action: AuditAction;
  targetType: AuditTargetType;
  targetId: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Record an audit event.
 *
 * Pipeline:
 *   1. Emit the structured log line (fires before the DB write so a DB
 *      outage doesn't lose the event entirely).
 *   2. Insert a row into `audit_log`. JSON columns auto-encode via Drizzle.
 *   3. On any failure, log the error and return normally - never throw.
 *
 * @example
 *   await recordAuditEvent({
 *     actorId: session.userId,
 *     actorRole: session.role,
 *     action: "created",
 *     targetType: "company",
 *     targetId: newCompany.id,
 *     after: { name: newCompany.name, sector: newCompany.sector },
 *   });
 */
export async function recordAuditEvent(event: AuditEvent): Promise<void> {
  // Step 1: structured log line - fires regardless of DB outcome. This is
  // the durable trail in the Workers log stream; the DB row is the
  // queryable trail in the dashboard UI. Both serve different audiences.
  try {
    log.info("audit event", {
      actor_id: event.actorId,
      actor_role: event.actorRole,
      action: event.action,
      target_type: event.targetType,
      target_id: event.targetId,
      // Spread snapshots and metadata into the log line for easy grepping.
      // Skip if absent so the log object stays tidy.
      ...(event.before ? { before: event.before } : {}),
      ...(event.after ? { after: event.after } : {}),
      ...(event.metadata ? { metadata: event.metadata } : {}),
    });
  } catch (err) {
    // Defensive only - log.info shouldn't throw. Logged separately from the
    // DB-write failure path so future ops can distinguish "logger failed"
    // from "DB failed" in the post-incident timeline.
    log.error("audit log line failed", { err, event_action: event.action });
  }

  // Step 2: persist to D1. Generate the row id app-side (consistent with
  // every other table in the schema) and stage the insert. The
  // `createdAt` column defaults to `datetime('now')` at the DB layer so
  // we don't pass it explicitly.
  try {
    await db.insert(auditLog).values({
      id: newId(),
      actorId: event.actorId,
      actorRole: event.actorRole,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      before: event.before,
      after: event.after,
      metadata: event.metadata,
    });
  } catch (err) {
    // The audit table is down or schema-drifted. We've already emitted the
    // log line above, so the event isn't lost - it just doesn't reach the
    // queryable trail. Parent Server Action proceeds normally; the user's
    // operation already succeeded.
    log.error("audit log persist failed", {
      err,
      event_action: event.action,
      target_type: event.targetType,
      target_id: event.targetId,
    });
  }
}
