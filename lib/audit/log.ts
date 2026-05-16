/**
 * Audit log — stub implementation.
 *
 * Records "who did what to which entity, when" for every state-changing
 * action in the app. The real production implementation persists each
 * event to an `audit_log` table (added in a later chunk). This stub
 * just emits a structured log line — the call signature is final, only
 * the body changes when the table arrives.
 *
 * Why this exists as a stub now: retrofitting audit calls into every
 * Server Action across the codebase later is painful — easy to miss
 * spots, easy to introduce inconsistency. Establishing the call sites
 * now means the audit table chunk is just a body swap, not a migration
 * of every action.
 *
 * Call sites should appear in every mutation: createCompany,
 * updateCompany, deleteCompany, and (later) the tender/project/document
 * counterparts. Read actions don't audit — would be far too noisy and
 * not legally useful.
 *
 * Designed for the question "what changed and who did it?" — most
 * useful in dispute resolution, staff hand-offs, compliance audits.
 *
 * @module lib/audit/log
 */
import { logger } from "@/lib/logger";

const log = logger.child({ module: "audit" });

// ── Types ───────────────────────────────────────────────────────────────────

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
 */
export type AuditAction =
  | "created"
  | "updated"
  | "deleted"
  | "compliance_status_changed"
  | "document_uploaded"
  | "document_expired"
  | "tender_published"
  | "tender_applied";

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
 *     (e.g. "uploaded GST certificate, valid until 2027-03-31").
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
