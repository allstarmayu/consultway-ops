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
 * Day 6 Chunk 2: `listAuditEvents` read API added below. Role-aware
 * visibility:
 *   - admin / staff -> sees all rows.
 *   - company       -> sees rows where they were the actor, plus rows
 *                      where the target is one of their own applications.
 *                      Tender-level events on tenders they applied to,
 *                      and cross-company events on tenders they publish,
 *                      are deferred to a later session.
 *   - unauthenticated -> error.
 *
 * Failure semantics: `recordAuditEvent` NEVER throws. A failed audit must
 * not break a successful user action - the user already got their work
 * done, and a degraded audit trail beats a failed action. On insert
 * failure we log an error via the structured logger and return normally.
 * The structured-log line is emitted BEFORE the insert attempt, so even
 * on a total D1 outage we still have a grep-able trail in the Workers
 * log stream.
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
import { and, count, desc, eq, or, type SQL } from "drizzle-orm";
import {
  db,
  auditLog,
  tenderApplications,
  type AuditLogEntry,
} from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { readSession } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import { listAuditEventsQuerySchema } from "./schemas";

const log = logger.child({ module: "audit" });

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * The kinds of entities we audit. Keep this union closed - adding a new
 * entity is a deliberate change, not something callers should pass as a
 * free-form string. Each addition should be accompanied by a clear
 * articulation of which actions target it (see Day 6 commentary above for
 * the `tender_application` rationale).
 *
 * IMPORTANT: keep in lockstep with `auditTargetTypeSchema` in
 * `./schemas.ts`. The two encode the same set - one for compile-time, one
 * for runtime validation.
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
 *
 * IMPORTANT: keep in lockstep with `auditActionSchema` in `./schemas.ts`.
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

/**
 * Result type for `listAuditEvents`. Mirrors the `ActionResult` shape
 * used across the rest of the codebase but lives here locally because
 * `recordAuditEvent` has historically been a thin module with no
 * result-type dependency. Pulling in `ActionResult` from one of the
 * domain modules (companies/tenders) would create an upward dependency;
 * defining it here keeps `lib/audit` a leaf.
 */
export type AuditReadResult =
  | { ok: true; rows: AuditLogEntry[]; total: number }
  | { ok: false; error: string };

// ── Public API: write ────────────────────────────────────────────────────────

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

// ── Public API: read ────────────────────────────────────────────────────────

/**
 * List audit events with role-aware visibility, filtering, and pagination.
 *
 * Returns newest-first. No sort options are exposed - an audit feed
 * ordered any other way is essentially never what the caller wants, and
 * locking the sort keeps the indexes load-bearing on a single access
 * pattern.
 *
 * Visibility rules (Phase 1):
 *
 *   - **admin / staff** see every row. No scope filter applied.
 *
 *   - **company-role users** see rows where any of the following holds:
 *       (a) `actor_id` matches the caller (their own actions).
 *       (b) `target_type = 'tender_application'` AND the row's
 *           `target_id` resolves to an application belonging to their
 *           company (via a join on `tender_applications.company_id`).
 *     Cross-company visibility on tenders they applied to or publish is
 *     deliberately out of scope for Phase 1 - it would require resolving
 *     "tenders the caller has applied to" and "tenders the caller is
 *     publishing" as separate sub-queries, and the only consumer (Day
 *     7's activity feed widget) doesn't need that depth yet. When it
 *     does, we extend this function rather than adding a parallel one.
 *
 *   - **unauthenticated callers** get `{ ok: false, error }`. The audit
 *     trail is never anonymous - "no caller" is "no rows".
 *
 * Filtering:
 *   - `targetType` / `targetId` for per-entity history queries (Day 7's
 *     per-tender / per-application history tabs use this combination).
 *   - `actorId` for admin investigation ("what did this user do?").
 *   - `action` for verb-specific feeds ("all reversals last month").
 *
 * Pagination uses `limit` / `offset` rather than cursor pagination.
 * Offset-based is fine for an append-only log at Phase 1 scale (single-
 * digit thousands of rows expected); when we cross into "scroll past
 * row 10,000" territory, cursoring by `created_at` becomes worthwhile.
 *
 * @param rawQuery The query input. Coerced + validated via Zod.
 * @returns Either an `ok: true` payload with rows + total, or `ok: false`
 *          with a user-facing error message.
 */
export async function listAuditEvents(
  rawQuery: unknown,
): Promise<AuditReadResult> {
  // 1. AuthZ. Unauthenticated callers get nothing - the audit trail is
  //    not a public artefact.
  const session = await readSession();
  if (!session) {
    return { ok: false, error: "You must be signed in" };
  }

  // 2. Validate query input. Default pagination kicks in for empty input,
  //    so callers can pass `{}` or `undefined` and get a sensible "most
  //    recent 50 events" response.
  const parsed = listAuditEventsQuerySchema.safeParse(rawQuery ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid query",
    };
  }
  const query = parsed.data;

  // 3. Build the filter list additively. Each user-supplied filter
  //    appends one equality clause; all clauses compose with AND.
  const filters: SQL[] = [];

  if (query.targetType) {
    filters.push(eq(auditLog.targetType, query.targetType));
  }
  if (query.targetId) {
    filters.push(eq(auditLog.targetId, query.targetId));
  }
  if (query.actorId) {
    filters.push(eq(auditLog.actorId, query.actorId));
  }
  if (query.action) {
    filters.push(eq(auditLog.action, query.action));
  }

  // 4. Role-aware visibility scope. Admin/staff see everything; company
  //    users see only own actions + own-application targets.
  //
  //    The company-scope branch uses a single OR clause inside the WHERE:
  //      audit_log.actor_id = :userId
  //        OR
  //      (audit_log.target_type = 'tender_application'
  //         AND target_id IN (SELECT id FROM tender_applications WHERE company_id = :companyId))
  //
  //    Drizzle expresses the IN-subselect via the `inArray` operator. We
  //    fetch the application id list first (one indexed query on
  //    tender_applications.company_id) so the main query stays simple
  //    and the result can be paginated with a plain WHERE. The alternative
  //    (correlated subquery) is harder to read and has the same plan in
  //    SQLite for small id lists.
  if (session.role === "company") {
    // Edge case: company-role user without a linked company. Should not
    // happen given the login flow, but fail-closed is the right default.
    if (!session.companyId) {
      log.warn("listAuditEvents: company-role caller has no company", {
        userId: session.userId,
      });
      return { ok: true, rows: [], total: 0 };
    }

    // Resolve the caller's application ids - the set of rows the scope
    // filter needs to allow via the target_id branch. Empty list is
    // fine; the OR collapses to just the actor_id clause in that case.
    const ownApplications = await db
      .select({ id: tenderApplications.id })
      .from(tenderApplications)
      .where(eq(tenderApplications.companyId, session.companyId));

    const ownApplicationIds = ownApplications.map((r) => r.id);

    // Build the OR. The actor_id branch is always present; the
    // target-id branch is only added when the caller has at least one
    // application (otherwise we'd be ORing with an empty IN, which
    // Drizzle's `inArray` can't express cleanly).
    const scopeClauses: SQL[] = [eq(auditLog.actorId, session.userId)];

    if (ownApplicationIds.length > 0) {
      // Two-part clause: target type must be tender_application AND
      // target_id must be one of ours. Both must match - guards against
      // the (rare) future case of an unrelated entity sharing the same
      // UUID as one of our applications.
      //
      // Drizzle's `or` collapses an array of conditions; we wrap the
      // two-part clause in `and` so the precedence is unambiguous.
      const ownAppTargetClause = and(
        eq(auditLog.targetType, "tender_application"),
        // Inline OR over the application ids. For Phase 1 scale (a
        // single company will have <100 applications) this is fine;
        // when it grows, swap to `inArray` against a subselect.
        or(...ownApplicationIds.map((id) => eq(auditLog.targetId, id))),
      );
      if (ownAppTargetClause) {
        scopeClauses.push(ownAppTargetClause);
      }
    }

    const scopeFilter = or(...scopeClauses);
    if (scopeFilter) {
      filters.push(scopeFilter);
    }
  }
  // admin / staff fall through with no scope filter - they see all rows.

  const whereClause = filters.length > 0 ? and(...filters) : undefined;

  // 5. Two queries: the page of rows, and the total count for paging UI.
  //    Same shape as listCompanies / listTenders. Both share the same
  //    WHERE clause so the count reflects the filtered + scoped set,
  //    not the raw table size.
  const [rows, totalRow] = await Promise.all([
    db
      .select()
      .from(auditLog)
      .where(whereClause)
      .orderBy(desc(auditLog.createdAt))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ value: count() })
      .from(auditLog)
      .where(whereClause)
      .then((r) => r[0]),
  ]);

  return {
    ok: true,
    rows,
    total: totalRow?.value ?? 0,
  };
}
