/**
 * Audit logging — record who did what, to which entity, with optional
 * before / after snapshots and free-form metadata.
 *
 * Today this writes a structured log line at `info` level. Tomorrow the
 * same call sites will also insert a row into a persistent `audit_log`
 * table — only this module's body changes, callers stay identical. That
 * "callers don't change" promise is why every mutation in the codebase
 * routes through `recordAuditEvent` instead of writing its own log lines.
 *
 * Day 5 note: the `AuditAction` union now includes four reversal verbs
 * (`tender_reopened`, `tender_award_retracted`, `application_reinstated`,
 * `application_recalled`). Reversals get dedicated verbs rather than
 * being folded into `updated` so:
 *   - "show me all reversals last month" is a one-clause grep instead
 *     of "find updated events where metadata.kind === 'reversal'"
 *   - the eventual audit-log UI can render reversals with their own
 *     iconography / colour without sniffing metadata
 *
 * Same precedent as `tender_published` / `tender_applied`: when a status
 * change is interesting enough to filter on, it earns its own verb.
 *
 * @module lib/audit/log
 */
import { logger } from "@/lib/logger";

const log = logger.child({ module: "audit" });

// ── Types ─────────────────────────────────────────────────────────────────

/**
 * The kinds of entities we audit. Keep this union closed — adding a new
 * entity is a deliberate change, not something callers should pass as
 * a free-form string.
 */
export type AuditTargetType =
  | "company"
  | "user"
  | "tender"
  | "project"
  | "transaction"
  | "document";

/**
 * What was done to the target. The triplet `created / updated / deleted`
 * covers most cases; specific status changes (e.g. compliance_status
 * flipped to "expired") get their own action verbs for clearer log
 * filtering.
 *
 * Reversal verbs (Day 5):
 *   - `tender_reopened`           — admin moved a closed tender back to
 *                                   published. Optional reason in
 *                                   `metadata.reason`.
 *   - `tender_award_retracted`    — admin moved an awarded tender back
 *                                   to closed. REQUIRED reason in
 *                                   `metadata.reason`.
 *   - `application_reinstated`    — admin/staff moved a shortlisted /
 *                                   rejected application back to
 *                                   submitted. `decidedAt` is cleared
 *                                   to NULL on the row; the audit event
 *                                   preserves the original decision time
 *                                   under `metadata.previousDecidedAt`.
 *   - `application_recalled`      — company moved their own withdrawn
 *                                   application back to submitted within
 *                                   the recall window (see
 *                                   `state-machine.ts::RECALL_WINDOW_DAYS`).
 *                                   `metadata.daysSinceWithdrawal` is
 *                                   captured for forensic context.
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
  // ── Reversal verbs (Day 5) ─────────────────────────────────────────
  | "tender_reopened"
  | "tender_award_retracted"
  | "application_reinstated"
  | "application_recalled";

/**
 * Single audit event. Stored as one row when the audit table lands.
 *
 *   - `actorId` and `actorRole` identify who performed the action.
 *     `actorRole` is denormalised so we can answer "what did admins
 *     do this week" without a join.
 *   - `before` / `after` snapshots are optional. For `created` only
 *     `after` makes sense; for `deleted` only `before`; for `updated`
 *     both are recorded so we can diff in the UI later. Storing
 *     full row snapshots wastes space — long term we'll switch to
 *     a JSON diff. For Phase 1 / Phase 2 the snapshot is fine.
 *   - `metadata` is free-form for action-specific extra context
 *     (e.g. "uploaded GST certificate, valid until 2027-03-31",
 *     "reversal reason: 'awarded company withdrew offer'").
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

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Record an audit event.
 *
 * Today: emits a structured log line at info level. The structured
 * logger already JSON-formats in production, so these are grep-able
 * even before the DB-backed audit table exists.
 *
 * Tomorrow: also `db.insert(auditLog).values(event)`. Callers don't
 * change.
 *
 * Never throws. Audit failures must NOT break user-facing actions —
 * if an audit write fails (DB down, etc.), we log the failure and
 * continue. The principle: degraded audit beats failed action.
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
  try {
    log.info("audit event", {
      actor_id: event.actorId,
      actor_role: event.actorRole,
      action: event.action,
      target_type: event.targetType,
      target_id: event.targetId,
      // Snapshots and metadata are spread into the log line for easy
      // grepping. Skip if absent so the log object stays tidy.
      ...(event.before ? { before: event.before } : {}),
      ...(event.after ? { after: event.after } : {}),
      ...(event.metadata ? { metadata: event.metadata } : {}),
    });
  } catch (err) {
    // Defensive — should never throw given the simple log.info above,
    // but if it does we don't want the parent action to fail.
    log.error("audit log failed", { err, event_action: event.action });
  }
}
