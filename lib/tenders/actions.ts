/**
 * Tenders module - Server Actions.
 *
 * Every mutation (create / update / status transition / delete / apply)
 * and every read used by the dashboard goes through one of these. They're
 * the **only** place where the database is touched directly for tender
 * and tender_application rows - UI calls these, never raw SQL.
 *
 * Return shape established in Day 2 and used identically in the companies
 * module:
 *     { ok: true, ...data }
 *   | { ok: false, error: string, field?: string }
 *
 * Expected failures (bad input, not-found, unauthorized, unique conflict,
 * illegal status transition) return `ok: false`. Unexpected failures
 * (DB driver crash, schema drift) throw - Next.js will turn those into
 * a 500 and we want loud signal in the logs, not silent partial success.
 *
 * Role rules (also documented in docs/08-rbac-matrix.md):
 *
 *   Action                       admin   staff   company
 *   createTender                 Y       Y       N
 *   updateTender                 Y       Y       N (subject to status gates)
 *   publishTender                Y       Y       N
 *   unpublishTender              Y       Y       N (only when 0 applications)
 *   closeTender                  Y       Y       N
 *   markAwarded                  Y       Y       N
 *   reopenTender                 Y       N       N (Day 5 - admin recovery)
 *   retractAward                 Y       N       N (Day 5 - required reason)
 *   deleteTender                 Y       N       N (admin only, drafts only)
 *   getTender                    Y       Y       Y (drafts hidden from company role)
 *   listTenders                  Y       Y       Y (drafts hidden from company role)
 *   applyToTender                N       N       Y (on own behalf only)
 *   withdrawApplication          N       N       Y (on own application only)
 *   updateApplicationStatus      Y       Y       N
 *   reinstateApplication         Y       Y       N (Day 5 - clears decidedAt)
 *   recallApplication            N       N       Y (Day 5 - within recall window)
 *   listMyApplications           N       N       Y (own company only)
 *
 * Audit logging: every mutation calls `recordAuditEvent` after the DB
 * write succeeds. Read actions are NOT audited (same convention as
 * companies). Status transitions use the more specific action verbs
 * where the audit log supports them (`tender_published`,
 * `tender_reopened`, `tender_award_retracted`, `application_reinstated`,
 * `application_recalled`); other transitions fall back to `updated`.
 *
 * Day 6: application-state-change events (withdraw, decide, reinstate,
 * recall) target the APPLICATION row directly via
 * `targetType: "tender_application"`, with the parent tenderId moved to
 * `metadata.tenderId`. This lets the Day-7 per-application history widget
 * be a single indexed lookup. The `tender_applied` event (a company
 * submitting an application) intentionally stays scoped to the tender -
 * the event reads as "this tender received a submission" from the
 * audit-trail reader's perspective.
 *
 * Status transitions consult `state-machine.ts` - single source of truth
 * for what transitions are legal and which fields are editable in each
 * status. Action code never hard-codes "if status === 'draft'" logic.
 *
 * @module lib/tenders/actions
 */
"use server";

import { and, asc, count, desc, eq, gte, like, lte, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  companies,
  tenders,
  tenderApplications,
  type Company,
  type Tender,
  type TenderApplication,
  type TenderStatus,
} from "@/lib/db/schema";
import { newId } from "@/lib/db/ids";
import { readSession } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import { recordAuditEvent, type AuditAction } from "@/lib/audit/log";
import {
  createTenderSchema,
  updateTenderSchema,
  listTendersQuerySchema,
  tenderIdSchema,
  applyToTenderSchema,
  updateApplicationStatusSchema,
  withdrawApplicationSchema,
  // -- Day 5: reversal schemas ---------------------------------------------
  reopenTenderSchema,
  retractAwardSchema,
  reinstateApplicationSchema,
  recallApplicationSchema,
  type CreateTenderInput,
  type UpdateTenderInput,
  type ListTendersQuery,
} from "./schemas";
import {
  getEditableFieldsForStatus,
  illegalTransitionMessage,
  isLegalTransition,
  acceptsApplications,
  // -- Day 5: application state machine + recall window --------------------
  isLegalApplicationTransition,
  illegalApplicationTransitionMessage,
  isWithinRecallWindow,
  daysSince,
  RECALL_WINDOW_DAYS,
} from "./state-machine";

const log = logger.child({ module: "tenders-actions" });

// -- Constants --------------------------------------------------------------

/**
 * Name of the Consultway sentinel publisher company. Kept in sync with
 * `CONSULTWAY_PUBLISHER_NAME` in scripts/seed.ts. When the tenders module
 * grows a shared-constants module, this should move there.
 */
const CONSULTWAY_PUBLISHER_NAME = "Consultway Infotech";

// -- Result types -----------------------------------------------------------

/**
 * Generic action result. Reused across actions so the calling UI can
 * branch on `result.ok` consistently. The `field` hint lets the form
 * highlight a specific input on validation conflicts.
 */
export type ActionResult<T = unknown> =
  | ({ ok: true } & T)
  | { ok: false; error: string; field?: string };

// -- Authorization helpers --------------------------------------------------

/**
 * The session shape, unwrapped from `readSession()`'s nullable return.
 * Same alias as the companies module - different file because Server
 * Actions can't share types across module boundaries when one is
 * "use server" and the other isn't, but the shape is identical.
 */
type Session = NonNullable<Awaited<ReturnType<typeof readSession>>>;

/** Result type for the role-gate helpers. */
type AuthCheck =
  | { ok: true; session: Session }
  | { ok: false; error: string };

/**
 * Resolve the current session and confirm the caller is admin or staff.
 * Used by all tender mutations except `applyToTender` /
 * `withdrawApplication` (which are company-role-only) and
 * `deleteTender` / `reopenTender` / `retractAward` (which are admin-only).
 */
async function requireAdminOrStaff(): Promise<AuthCheck> {
  const session = await readSession();
  if (!session) {
    return { ok: false, error: "You must be signed in" };
  }
  if (session.role !== "admin" && session.role !== "staff") {
    log.warn("forbidden access attempt", {
      userId: session.userId,
      role: session.role,
    });
    return { ok: false, error: "You don't have permission to do that" };
  }
  return { ok: true, session };
}

/** Admin-only gate. Used for deleteTender, reopenTender, retractAward. */
async function requireAdmin(): Promise<AuthCheck> {
  const session = await readSession();
  if (!session) return { ok: false, error: "You must be signed in" };
  if (session.role !== "admin") {
    log.warn("non-admin attempted admin-only action", {
      userId: session.userId,
      role: session.role,
    });
    return { ok: false, error: "Only an administrator can do that" };
  }
  return { ok: true, session };
}

/**
 * Company-role-only gate. Returns the linked company id alongside the
 * session for convenience - most company actions need both. A
 * `company`-role user with no linked companyId is a misconfigured
 * account; we fail closed with a clear error.
 */
type CompanyAuth =
  | { ok: true; session: Session; companyId: string }
  | { ok: false; error: string };

async function requireCompanyRole(): Promise<CompanyAuth> {
  const session = await readSession();
  if (!session) return { ok: false, error: "You must be signed in" };
  if (session.role !== "company") {
    return {
      ok: false,
      error: "Only company users can perform this action",
    };
  }
  if (!session.companyId) {
    log.error("company-role user has no linked company", {
      userId: session.userId,
    });
    return { ok: false, error: "Your account is not linked to a company" };
  }
  return { ok: true, session, companyId: session.companyId };
}

/**
 * Read-and-scope helper for tender reads. Any signed-in user may read
 * tenders, but visibility depends on role:
 *   - admin / staff           -> all tenders, including drafts
 *   - company                 -> published / closed / awarded only;
 *                                drafts are invisible UNLESS the company
 *                                is the publisher (subcontract scenario)
 *
 * Returns:
 *   - session
 *   - `scopeCompanyId`: NULL for admin/staff (no row-scope), or the
 *     company id for company-role (used to allow seeing own drafts as
 *     publisher).
 */
type ReadScope =
  | { ok: true; session: Session; scopeCompanyId: string | null }
  | { ok: false; error: string };

async function resolveReadScope(): Promise<ReadScope> {
  const session = await readSession();
  if (!session) return { ok: false, error: "You must be signed in" };

  if (session.role === "admin" || session.role === "staff") {
    return { ok: true, session, scopeCompanyId: null };
  }

  // role === "company"
  if (!session.companyId) {
    log.error("company-role user has no linked company", {
      userId: session.userId,
    });
    return { ok: false, error: "Your account is not linked to a company" };
  }
  return { ok: true, session, scopeCompanyId: session.companyId };
}

// -- Helper: SQLite unique-constraint translation --------------------------

/**
 * Same pattern as the companies module. SQLite reports unique constraint
 * failures as a structured error string; we translate the ones we expect
 * into form-friendly errors so the UI can highlight the offending field.
 */
function translateUniqueConflict(
  err: unknown,
): { error: string; field: string } | null {
  if (!(err instanceof Error)) return null;
  const msg = err.message;

  if (msg.includes("tenders.reference_number")) {
    return {
      error: "A tender with this reference number already exists",
      field: "referenceNumber",
    };
  }
  // Composite-unique on (tender_id, company_id) - the index name appears
  // in the error message verbatim.
  if (msg.includes("tender_applications_tender_company_unique_idx")) {
    return {
      error: "Your company has already applied to this tender",
      field: "tenderId",
    };
  }
  return null;
}

// -- Helper: Consultway publisher resolution -------------------------------

/**
 * Resolve the UUID of the Consultway sentinel publisher company. Cached
 * for the lifetime of the module instance to avoid repeating the lookup
 * on every createTender call.
 *
 * In production this runs on a server process with a persistent lifetime,
 * so the cache hits after the first call. In dev with HMR / file watching,
 * the cache may reset more often - acceptable.
 *
 * Returns NULL if the row doesn't exist; the caller surfaces a clear
 * error rather than crashing on the FK constraint. (In practice the seed
 * always creates the row, so this is defensive.)
 */
let cachedConsultwayPublisherId: string | null = null;

async function resolveConsultwayPublisherId(): Promise<string | null> {
  if (cachedConsultwayPublisherId) return cachedConsultwayPublisherId;

  const row = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.name, CONSULTWAY_PUBLISHER_NAME))
    .limit(1)
    .then((rows) => rows[0]);

  if (!row) {
    log.error("Consultway sentinel publisher company is missing", {
      expectedName: CONSULTWAY_PUBLISHER_NAME,
    });
    return null;
  }

  cachedConsultwayPublisherId = row.id;
  return row.id;
}

// -- Helper: snapshot builder ---------------------------------------------

/**
 * Build a partial snapshot of a tender row, restricted to the named
 * keys. Used to produce before/after audit payloads of only the fields
 * that the patch actually touched. Same shape as the companies module's
 * `buildPatchSnapshot`.
 */
function buildPatchSnapshot(
  row: Tender,
  keys: string[],
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) {
    snapshot[key] = (row as unknown as Record<string, unknown>)[key];
  }
  return snapshot;
}

// -- createTender ----------------------------------------------------------

/**
 * Create a new tender. Admin/staff only. The created row starts with
 * `status: "draft"` regardless of what the caller sends - status is
 * something the team transitions, not something the creator declares.
 *
 * If `publisherCompanyId` is omitted, defaults to the Consultway sentinel
 * company (resolved by name). This lets the UI's "Add tender" flow stay
 * simple - the common case (Consultway-internal tender) needs no
 * publisher picker.
 */
export async function createTender(
  rawInput: unknown,
): Promise<ActionResult<{ id: string }>> {
  // 1. AuthZ
  const auth = await requireAdminOrStaff();
  if (!auth.ok) return auth;

  // 2. Validate
  const parsed = createTenderSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid input",
      field: first?.path.join(".") || undefined,
    };
  }
  const input: CreateTenderInput = parsed.data;

  // 3. Resolve publisher - explicit if provided, sentinel if not.
  let publisherCompanyId = input.publisherCompanyId;
  if (!publisherCompanyId) {
    const sentinelId = await resolveConsultwayPublisherId();
    if (!sentinelId) {
      return {
        ok: false,
        error:
          "Default publisher company is missing. Run `pnpm db:seed` and try again.",
      };
    }
    publisherCompanyId = sentinelId;
  }

  // 4. Insert
  const id = newId();
  try {
    await db.insert(tenders).values({
      id,
      title: input.title,
      description: input.description ?? null,
      referenceNumber: input.referenceNumber ?? null,
      // Force draft - never trust create-side status.
      status: "draft",
      publisherCompanyId,
      sector: input.sector,
      geography: input.geography,
      eligibleSector: input.eligibleSector ?? null,
      eligibleGeography: input.eligibleGeography ?? null,
      minAnnualTurnoverInr: input.minAnnualTurnoverInr ?? null,
      msmeOnly: input.msmeOnly ?? false,
      openingDate: input.openingDate ?? null,
      closingDate: input.closingDate ?? null,
      internalNotes: input.internalNotes ?? null,
    });
  } catch (err) {
    const conflict = translateUniqueConflict(err);
    if (conflict) {
      log.info("createTender unique conflict", {
        field: conflict.field,
        actorId: auth.session.userId,
      });
      return { ok: false, ...conflict };
    }
    log.error("createTender failed", { err, actorId: auth.session.userId });
    throw err;
  }

  // 5. Audit. Captures the identity-ish fields for later forensic
  //    queries - full row contents would be noise.
  await recordAuditEvent({
    actorId: auth.session.userId,
    actorRole: auth.session.role,
    action: "created",
    targetType: "tender",
    targetId: id,
    after: {
      title: input.title,
      status: "draft",
      sector: input.sector,
      geography: input.geography,
      publisherCompanyId,
    },
  });

  log.info("tender created", {
    id,
    title: input.title,
    actorId: auth.session.userId,
  });
  return { ok: true, id };
}

// -- updateTender ----------------------------------------------------------

/**
 * Partial update. Admin/staff only. Field-level editability depends on
 * the row's current status - `getEditableFieldsForStatus` is the single
 * source of truth. Fields outside the editable set are silently dropped
 * (defence in depth - the UI shouldn't offer them, but we enforce too).
 *
 * Status itself is NOT mutable via this action; use the dedicated
 * transition actions (`publishTender`, `closeTender`, etc.).
 */
export async function updateTender(
  rawInput: unknown,
): Promise<ActionResult> {
  // 1. AuthZ
  const auth = await requireAdminOrStaff();
  if (!auth.ok) return auth;

  // 2. Validate
  const parsed = updateTenderSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid input",
      field: first?.path.join(".") || undefined,
    };
  }
  const input: UpdateTenderInput = parsed.data;

  // 3. Load existing row
  const existing = await db
    .select()
    .from(tenders)
    .where(eq(tenders.id, input.id))
    .limit(1)
    .then((rows) => rows[0]);

  if (!existing) {
    return { ok: false, error: "Tender not found" };
  }

  // 4. Build the patch, dropping fields not editable in current status.
  const editable = getEditableFieldsForStatus(existing.status);
  const patch: Partial<typeof tenders.$inferInsert> = {};
  const droppedFields: string[] = [];

  // Helper to assign a field if it's editable in this status and the
  // caller actually sent it. Logs dropped fields for forensic debug -
  // a UI that's offering a field it shouldn't is a bug worth surfacing.
  function applyIfEditable<K extends keyof typeof tenders.$inferInsert>(
    field: K,
    value: (typeof tenders.$inferInsert)[K] | undefined,
  ): void {
    if (value === undefined) return;
    if (editable.has(field as never)) {
      patch[field] = value;
    } else {
      droppedFields.push(String(field));
    }
  }

  applyIfEditable("title", input.title);
  applyIfEditable("description", input.description);
  applyIfEditable("referenceNumber", input.referenceNumber);
  applyIfEditable("sector", input.sector);
  applyIfEditable("geography", input.geography);
  applyIfEditable("eligibleSector", input.eligibleSector);
  applyIfEditable("eligibleGeography", input.eligibleGeography);
  applyIfEditable("minAnnualTurnoverInr", input.minAnnualTurnoverInr);
  applyIfEditable("msmeOnly", input.msmeOnly);
  applyIfEditable("openingDate", input.openingDate);
  applyIfEditable("closingDate", input.closingDate);
  applyIfEditable("internalNotes", input.internalNotes);

  if (droppedFields.length > 0) {
    log.warn("updateTender dropped fields not editable in current status", {
      tenderId: input.id,
      status: existing.status,
      dropped: droppedFields,
      actorId: auth.session.userId,
    });
  }

  // 5. Cross-field check against the merged row state. The schema's
  //    superRefine only saw the patch in isolation - here we check what
  //    the row will look like after the patch lands.
  const mergedOpening = patch.openingDate ?? existing.openingDate;
  const mergedClosing = patch.closingDate ?? existing.closingDate;
  if (mergedOpening && mergedClosing && mergedOpening > mergedClosing) {
    return {
      ok: false,
      field: "closingDate",
      error: "Closing date must be on or after the opening date",
    };
  }

  // 6. No-op short-circuit. Treat as idempotent success.
  if (Object.keys(patch).length === 0) {
    return { ok: true };
  }

  // 7. Apply
  try {
    await db.update(tenders).set(patch).where(eq(tenders.id, input.id));
  } catch (err) {
    const conflict = translateUniqueConflict(err);
    if (conflict) {
      log.info("updateTender unique conflict", {
        field: conflict.field,
        actorId: auth.session.userId,
      });
      return { ok: false, ...conflict };
    }
    log.error("updateTender failed", { err, actorId: auth.session.userId });
    throw err;
  }

  // 8. Audit. Before/after of only the fields the patch touched.
  const touchedKeys = Object.keys(patch);
  const beforeSnapshot = buildPatchSnapshot(existing, touchedKeys);
  const afterSnapshot = buildPatchSnapshot(
    { ...existing, ...patch } as Tender,
    touchedKeys,
  );
  await recordAuditEvent({
    actorId: auth.session.userId,
    actorRole: auth.session.role,
    action: "updated",
    targetType: "tender",
    targetId: input.id,
    before: beforeSnapshot,
    after: afterSnapshot,
  });

  log.info("tender updated", {
    id: input.id,
    actorId: auth.session.userId,
    fields: touchedKeys,
  });
  return { ok: true };
}

// -- Status transitions ----------------------------------------------------

/**
 * Audit action verbs accepted by `transitionTenderStatus`. The union is
 * a subset of `AuditAction` from the audit module - listed here
 * explicitly (rather than imported as the full union) so callers can't
 * pass a wildly inappropriate verb like `compliance_status_changed` to
 * a tender transition.
 *
 * Day 5: extended with `tender_reopened` and `tender_award_retracted`
 * for the new reversal flows.
 */
type TenderTransitionAuditAction = Extract<
  AuditAction,
  | "tender_published"
  | "tender_reopened"
  | "tender_award_retracted"
  | "updated"
>;

/**
 * Internal helper used by all status-transition actions. Loads the
 * row, checks the transition is legal via the state machine, applies any
 * extra side-effects (publishedAt, application count guard), writes the
 * update, and records the audit event.
 *
 * `auditMetadata` is optional and merged into the audit event's
 * `metadata` field - used by the reversal actions to capture a `reason`
 * provided by the actor.
 *
 * Not exported - callers should use the named wrappers below so the
 * intent is explicit in the UI code.
 */
async function transitionTenderStatus(
  tenderId: string,
  nextStatus: TenderStatus,
  session: Session,
  auditAction: TenderTransitionAuditAction,
  auditMetadata?: Record<string, unknown>,
): Promise<ActionResult> {
  // Validate id
  const parsed = tenderIdSchema.safeParse({ id: tenderId });
  if (!parsed.success) {
    return { ok: false, error: "Invalid tender id" };
  }

  // Load row
  const existing = await db
    .select()
    .from(tenders)
    .where(eq(tenders.id, parsed.data.id))
    .limit(1)
    .then((rows) => rows[0]);

  if (!existing) {
    return { ok: false, error: "Tender not found" };
  }

  // No-op short-circuit. Distinct from "illegal" - same value is fine.
  if (existing.status === nextStatus) {
    return { ok: true };
  }

  // State-machine check
  if (!isLegalTransition(existing.status, nextStatus)) {
    return {
      ok: false,
      error: illegalTransitionMessage(existing.status, nextStatus),
    };
  }

  // Guard: unpublish only allowed when no applications exist. Pulling
  // a tender back to draft after companies applied would silently
  // delete their work (or worse, leave orphan applications pointing at
  // a row marked draft).
  if (existing.status === "published" && nextStatus === "draft") {
    const appCount = await db
      .select({ value: count() })
      .from(tenderApplications)
      .where(eq(tenderApplications.tenderId, existing.id))
      .then((r) => r[0]?.value ?? 0);
    if (appCount > 0) {
      return {
        ok: false,
        error: `Cannot unpublish - ${appCount} ${
          appCount === 1 ? "company has" : "companies have"
        } already applied. Close the tender instead.`,
      };
    }
  }

  // Build patch
  const patch: Partial<typeof tenders.$inferInsert> = {
    status: nextStatus,
  };

  // Stamp publishedAt only on the draft -> published transition. Other
  // transitions leave the original publishedAt in place - even a tender
  // that's been unpublished and re-published keeps the original time
  // for now (we don't track a re-publish history; if needed, that's a
  // separate audit-trail concern).
  //
  // Day 5 note: `closed -> published` (reopen) is also a published-
  // target transition, but the row already has a publishedAt from its
  // original publish, so the conditional below is a no-op for reopens.
  // The audit log captures the reopen event with its own verb.
  if (nextStatus === "published" && !existing.publishedAt) {
    patch.publishedAt = new Date().toISOString();
  }

  // Apply
  try {
    await db.update(tenders).set(patch).where(eq(tenders.id, existing.id));
  } catch (err) {
    log.error("transitionTenderStatus failed", {
      err,
      from: existing.status,
      to: nextStatus,
      actorId: session.userId,
    });
    throw err;
  }

  // Audit. Status transitions are important events - record from/to
  // explicitly in the snapshot, plus any caller-supplied metadata
  // (e.g. reversal reason).
  await recordAuditEvent({
    actorId: session.userId,
    actorRole: session.role,
    action: auditAction,
    targetType: "tender",
    targetId: existing.id,
    before: { status: existing.status },
    after: {
      status: nextStatus,
      ...(patch.publishedAt ? { publishedAt: patch.publishedAt } : {}),
    },
    ...(auditMetadata ? { metadata: auditMetadata } : {}),
  });

  log.info("tender status transitioned", {
    id: existing.id,
    from: existing.status,
    to: nextStatus,
    actorId: session.userId,
    ...(auditMetadata ? { metadata: auditMetadata } : {}),
  });
  return { ok: true };
}

/** Transition a draft tender to published. Admin/staff only. */
export async function publishTender(rawId: unknown): Promise<ActionResult> {
  const auth = await requireAdminOrStaff();
  if (!auth.ok) return auth;
  if (typeof rawId !== "string") {
    return { ok: false, error: "Invalid tender id" };
  }
  return transitionTenderStatus(
    rawId,
    "published",
    auth.session,
    "tender_published",
  );
}

/**
 * Transition a published tender back to draft. Admin/staff only. Only
 * permitted while no applications exist on the tender - the state-machine
 * helper's call site enforces this.
 */
export async function unpublishTender(rawId: unknown): Promise<ActionResult> {
  const auth = await requireAdminOrStaff();
  if (!auth.ok) return auth;
  if (typeof rawId !== "string") {
    return { ok: false, error: "Invalid tender id" };
  }
  return transitionTenderStatus(rawId, "draft", auth.session, "updated");
}

/** Transition a published tender to closed. Admin/staff only. */
export async function closeTender(rawId: unknown): Promise<ActionResult> {
  const auth = await requireAdminOrStaff();
  if (!auth.ok) return auth;
  if (typeof rawId !== "string") {
    return { ok: false, error: "Invalid tender id" };
  }
  return transitionTenderStatus(rawId, "closed", auth.session, "updated");
}

/**
 * Mark a closed tender as awarded. Admin/staff only.
 *
 * As of Day 5, `awarded` is no longer a strictly-terminal state -
 * `retractAward` can move it back to `closed`. But `markAwarded` still
 * represents the procurement decision; retraction is the explicit
 * recovery path for accidental clicks.
 *
 * NOTE: this action does not yet record the winning company. The
 * `awardedCompanyId` column will land when Phase 2 (project tracking)
 * starts and we need the link for tender -> project conversion. For now,
 * staff record the winner in `internalNotes`.
 */
export async function markAwarded(rawId: unknown): Promise<ActionResult> {
  const auth = await requireAdminOrStaff();
  if (!auth.ok) return auth;
  if (typeof rawId !== "string") {
    return { ok: false, error: "Invalid tender id" };
  }
  return transitionTenderStatus(rawId, "awarded", auth.session, "updated");
}

// -- deleteTender ----------------------------------------------------------

/**
 * Delete a tender. **Admin only.** Only `draft` tenders may be deleted -
 * once a tender has been published, even briefly, we preserve it for
 * audit purposes. Admins can `closeTender` and `markAwarded` to retire
 * a published tender; deletion is reserved for cleanup of unused drafts.
 *
 * Cascades: `tender_applications.tender_id` has ON DELETE CASCADE, so
 * any applications attached to this draft go with it. Drafts shouldn't
 * have applications (they're invisible to companies), but the cascade
 * is defence in depth.
 */
export async function deleteTender(rawId: unknown): Promise<ActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return auth;

  const parsed = tenderIdSchema.safeParse({ id: rawId });
  if (!parsed.success) {
    return { ok: false, error: "Invalid tender id" };
  }

  // Load existing - we need both the status check AND the snapshot for
  // audit. One query covers both.
  const existing = await db
    .select()
    .from(tenders)
    .where(eq(tenders.id, parsed.data.id))
    .limit(1)
    .then((rows) => rows[0]);

  if (!existing) {
    return { ok: false, error: "Tender not found" };
  }

  if (existing.status !== "draft") {
    return {
      ok: false,
      error:
        "Only draft tenders can be deleted. Close or mark awarded instead.",
    };
  }

  // Delete with returning() so the cascaded application count is
  // technically discoverable, but SQLite's RETURNING doesn't reach
  // through cascades - we'd need a separate count beforehand if we
  // wanted that metric. Skipping for now; drafts shouldn't have apps.
  await db.delete(tenders).where(eq(tenders.id, parsed.data.id));

  // Audit with the full pre-deletion row. Same justification as the
  // companies module's delete: once it's gone, this is the only record.
  await recordAuditEvent({
    actorId: auth.session.userId,
    actorRole: auth.session.role,
    action: "deleted",
    targetType: "tender",
    targetId: parsed.data.id,
    before: {
      title: existing.title,
      status: existing.status,
      publisherCompanyId: existing.publisherCompanyId,
      sector: existing.sector,
      geography: existing.geography,
      referenceNumber: existing.referenceNumber,
      eligibleSector: existing.eligibleSector,
      eligibleGeography: existing.eligibleGeography,
      minAnnualTurnoverInr: existing.minAnnualTurnoverInr,
      msmeOnly: existing.msmeOnly,
      openingDate: existing.openingDate,
      closingDate: existing.closingDate,
      createdAt: existing.createdAt,
    },
  });

  log.info("tender deleted", {
    id: parsed.data.id,
    actorId: auth.session.userId,
  });
  return { ok: true };
}

// -- getTender -------------------------------------------------------------

/**
 * Single-row fetch for the detail page. Includes role-aware row scoping:
 *
 *   - admin / staff      -> see every tender, every field
 *   - company (publisher) -> see own drafts (subcontract scenario) +
 *                            all published/closed/awarded
 *   - company (other)    -> see published / closed / awarded only
 *
 * Strips `internalNotes` for company-role callers regardless of which
 * tender - that field is staff-only.
 */
export async function getTender(
  rawId: unknown,
): Promise<ActionResult<{ tender: Tender }>> {
  const scope = await resolveReadScope();
  if (!scope.ok) return scope;

  const parsed = tenderIdSchema.safeParse({ id: rawId });
  if (!parsed.success) {
    return { ok: false, error: "Invalid tender id" };
  }

  const row = await db
    .select()
    .from(tenders)
    .where(eq(tenders.id, parsed.data.id))
    .limit(1)
    .then((rows) => rows[0]);

  if (!row) return { ok: false, error: "Tender not found" };

  // Row-level scope: company-role users cannot see drafts unless they
  // are the publisher (subcontract case).
  if (scope.scopeCompanyId) {
    const isPublisher = row.publisherCompanyId === scope.scopeCompanyId;
    if (row.status === "draft" && !isPublisher) {
      // Return "not found" rather than "forbidden" - don't leak the
      // existence of a draft tender to a non-privileged caller.
      return { ok: false, error: "Tender not found" };
    }
  }

  // Strip admin-only fields for company-role callers.
  const sanitized: Tender =
    scope.session.role === "company" ? { ...row, internalNotes: null } : row;

  return { ok: true, tender: sanitized };
}

// -- listTenders -----------------------------------------------------------

/**
 * Result payload type for `listTenders`. Extracted so the function
 * signature stays readable.
 */
type ListTendersPayload = {
  rows: Tender[];
  total: number;
  page: number;
  perPage: number;
};

/**
 * Paginated, filtered, sorted list of tenders.
 *
 * Visibility:
 *   - admin/staff: every tender
 *   - company: published / closed / awarded - plus own drafts as publisher
 *
 * Filters compose with AND. Search is a `LIKE` against `title` only -
 * SQLite has no FTS5 by default and at Phase 1's scale a sequential LIKE
 * is fast enough.
 */
export async function listTenders(
  rawQuery: unknown,
): Promise<ActionResult<ListTendersPayload>> {
  const scope = await resolveReadScope();
  if (!scope.ok) return scope;

  const parsed = listTendersQuerySchema.safeParse(rawQuery ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid query",
      field: first?.path.join(".") || undefined,
    };
  }
  const query: ListTendersQuery = parsed.data;

  // Build WHERE clauses additively.
  const filters: SQL[] = [];

  // Row-level scope: company-role users get a status whitelist OR their
  // own drafts. Drizzle expresses this as a Drizzle-typed SQL clause.
  // For Phase 1 we keep it simple: if the caller is company-role and
  // they explicitly asked for `status=draft`, only allow it if they're
  // also asking for their own publisher. Otherwise, drop draft filter
  // and force the whitelist.
  if (scope.scopeCompanyId) {
    // Company role - show non-drafts always, plus own drafts.
    //   (status != 'draft') OR (publisher_company_id = own)
    // Pragmatic compromise for Phase 1: if no status filter is set,
    // include both "non-draft" tenders AND own-publisher drafts via a
    // post-filter in JS. This is fine at Phase 1 scale (<100 tenders);
    // if it ever becomes a perf issue we'll move to a proper OR clause.
    //
    // If a specific status is requested:
    //   - status='draft' -> show only own drafts (publisher = scope)
    //   - other status   -> standard filter, no special handling
    if (query.status === "draft") {
      filters.push(eq(tenders.status, "draft"));
      filters.push(eq(tenders.publisherCompanyId, scope.scopeCompanyId));
    } else if (query.status) {
      filters.push(eq(tenders.status, query.status));
    }
    // If no status filter: handled below by skipping draft-exclusion
    // and post-filtering in JS.
  } else {
    // admin/staff - straightforward status filter if provided.
    if (query.status) {
      filters.push(eq(tenders.status, query.status));
    }
  }

  if (query.sector) filters.push(eq(tenders.sector, query.sector));
  if (query.geography) filters.push(eq(tenders.geography, query.geography));
  if (query.msmeOnly !== undefined) {
    filters.push(eq(tenders.msmeOnly, query.msmeOnly));
  }
  if (query.publisherCompanyId) {
    filters.push(eq(tenders.publisherCompanyId, query.publisherCompanyId));
  }
  if (query.closingDateFrom) {
    filters.push(gte(tenders.closingDate, query.closingDateFrom));
  }
  if (query.closingDateTo) {
    filters.push(lte(tenders.closingDate, query.closingDateTo));
  }
  if (query.search) {
    filters.push(like(tenders.title, `%${query.search}%`));
  }

  const whereClause = filters.length > 0 ? and(...filters) : undefined;

  // Sort column lookup. We enforce the column at the type level via the
  // Zod enum, so an unexpected value can't reach here.
  const sortColumn = {
    title: tenders.title,
    status: tenders.status,
    sector: tenders.sector,
    geography: tenders.geography,
    closingDate: tenders.closingDate,
    createdAt: tenders.createdAt,
    publishedAt: tenders.publishedAt,
  }[query.sortBy];
  const orderBy = query.sortDir === "asc" ? asc(sortColumn) : desc(sortColumn);

  const offset = (query.page - 1) * query.perPage;

  // Two queries: one for the page of rows, one for the total count.
  // Same shape as the companies list.
  const [rowsRaw, totalRow] = await Promise.all([
    db
      .select()
      .from(tenders)
      .where(whereClause)
      .orderBy(orderBy)
      .limit(query.perPage)
      .offset(offset),
    db
      .select({ value: count() })
      .from(tenders)
      .where(whereClause)
      .then((r) => r[0]),
  ]);

  // Post-filter for company-role users with no explicit status filter:
  // hide drafts that aren't their own. See the OR-clause note above for
  // why this is post-filtered rather than encoded in the WHERE.
  let rows: Tender[] = rowsRaw;
  let total = totalRow?.value ?? 0;
  if (scope.scopeCompanyId && !query.status) {
    const before = rows.length;
    rows = rows.filter(
      (r) =>
        r.status !== "draft" || r.publisherCompanyId === scope.scopeCompanyId,
    );
    // Adjust total to reflect the JS-side hide. Approximation only -
    // the total may be off by the number of "other-publisher drafts"
    // that fell on this page, but pagination remains usable. Long-term
    // fix is a proper SQL OR clause; tracked as tech debt.
    const removed = before - rows.length;
    total = Math.max(0, total - removed);
  }

  // Strip internal notes for company-role callers.
  const sanitized: Tender[] =
    scope.session.role === "company"
      ? rows.map((r) => ({ ...r, internalNotes: null }))
      : rows;

  return {
    ok: true,
    rows: sanitized,
    total,
    page: query.page,
    perPage: query.perPage,
  };
}

// -- applyToTender ---------------------------------------------------------

/**
 * Company-role users apply to a published tender on their own behalf.
 *
 * Eligibility gates (in order):
 *   1. Tender exists and accepts applications (status === 'published')
 *   2. Closing date hasn't passed (if set)
 *   3. Eligibility filters: sector / geography / MSME match company's
 *      own row state
 *   4. Turnover gate - DEFERRED. The `companies` table doesn't have an
 *      `annualTurnover` column yet (Day-3 schema omits it). When that
 *      ships, enable enforcement here.
 *   5. Composite-unique on (tender_id, company_id) catches duplicate
 *      applications at the DB level - we soft-check first for a friendly
 *      error message.
 *
 * Returns the new application id on success.
 */
export async function applyToTender(
  rawInput: unknown,
): Promise<ActionResult<{ applicationId: string }>> {
  // 1. AuthZ - company role only
  const auth = await requireCompanyRole();
  if (!auth.ok) return auth;

  // 2. Validate
  const parsed = applyToTenderSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid input",
      field: first?.path.join(".") || undefined,
    };
  }
  const input = parsed.data;

  // 3. Load tender + company in parallel - we need both to gate on
  //    eligibility.
  const [tender, company] = await Promise.all([
    db
      .select()
      .from(tenders)
      .where(eq(tenders.id, input.tenderId))
      .limit(1)
      .then((rows) => rows[0]),
    db
      .select()
      .from(companies)
      .where(eq(companies.id, auth.companyId))
      .limit(1)
      .then((rows) => rows[0]),
  ]);

  if (!tender) return { ok: false, error: "Tender not found" };
  if (!company) {
    // Session claims a companyId that doesn't exist - bad state.
    log.error("applyToTender: session companyId not found in DB", {
      userId: auth.session.userId,
      companyId: auth.companyId,
    });
    return { ok: false, error: "Your company record is missing" };
  }

  // 4. Status gate
  if (!acceptsApplications(tender.status)) {
    return {
      ok: false,
      error: `This tender is not accepting applications (status: ${tender.status})`,
    };
  }

  // 5. Closing-date gate. Comparing ISO date strings as strings is
  //    correct (YYYY-MM-DD sorts lexically the same as chronologically).
  //    "Today" uses the server's view of UTC - fine for India ops where
  //    the date boundary is +5:30 from UTC; a user submitting at 4 AM
  //    IST won't hit edge cases here.
  if (tender.closingDate) {
    const todayIso = new Date().toISOString().slice(0, 10);
    if (todayIso > tender.closingDate) {
      return {
        ok: false,
        error: "Applications for this tender have closed",
      };
    }
  }

  // 6. Eligibility filters
  if (tender.eligibleSector && company.sector !== tender.eligibleSector) {
    return {
      ok: false,
      error: `This tender requires sector "${tender.eligibleSector}" - your company is in "${company.sector}"`,
    };
  }
  if (
    tender.eligibleGeography &&
    company.geography !== tender.eligibleGeography
  ) {
    return {
      ok: false,
      error: `This tender requires geography "${tender.eligibleGeography}" - your company is in "${company.geography}"`,
    };
  }
  if (tender.msmeOnly && !company.isMsme) {
    return {
      ok: false,
      error: "This tender is restricted to MSME-registered companies",
    };
  }

  // TODO: Turnover gate. Re-enable once `companies.annualTurnover` ships.
  //
  // if (tender.minAnnualTurnoverInr !== null) {
  //   const turnover = company.annualTurnover ?? 0;
  //   if (turnover < tender.minAnnualTurnoverInr) {
  //     return {
  //       ok: false,
  //       error: `This tender requires an annual turnover of at least Rs.${tender.minAnnualTurnoverInr.toLocaleString("en-IN")}`,
  //     };
  //   }
  // }

  // 7. Soft duplicate check for a friendlier error message. The DB
  //    composite unique is the hard guard; this avoids the user seeing
  //    "uniqueness violated".
  const existingApplication = await db
    .select({ id: tenderApplications.id })
    .from(tenderApplications)
    .where(
      and(
        eq(tenderApplications.tenderId, tender.id),
        eq(tenderApplications.companyId, company.id),
      ),
    )
    .limit(1)
    .then((rows) => rows[0]);

  if (existingApplication) {
    return {
      ok: false,
      error: "Your company has already applied to this tender",
    };
  }

  // 8. Insert
  const applicationId = newId();
  try {
    await db.insert(tenderApplications).values({
      id: applicationId,
      tenderId: tender.id,
      companyId: company.id,
      status: "submitted",
      coverNote: input.coverNote ?? null,
      internalNotes: null,
    });
  } catch (err) {
    // Composite-unique race - another tab applied between the soft
    // check and the insert. Translate to a friendly message.
    const conflict = translateUniqueConflict(err);
    if (conflict) {
      log.info("applyToTender unique conflict (race)", {
        companyId: company.id,
        tenderId: tender.id,
      });
      return { ok: false, ...conflict };
    }
    log.error("applyToTender failed", {
      err,
      companyId: company.id,
      tenderId: tender.id,
    });
    throw err;
  }

  // 9. Audit. `tender_applied` is the dedicated audit action for this
  //    event - clearer log-grepping than a generic 'created'. This event
  //    intentionally targets the TENDER, not the application - the
  //    audit-trail read for "this tender received a submission" wants
  //    the tender as its primary key. The applicationId rides in
  //    metadata for cross-reference.
  await recordAuditEvent({
    actorId: auth.session.userId,
    actorRole: auth.session.role,
    action: "tender_applied",
    targetType: "tender",
    targetId: tender.id,
    metadata: {
      applicationId,
      companyId: company.id,
      companyName: company.name,
      tenderTitle: tender.title,
    },
  });

  log.info("tender application submitted", {
    applicationId,
    tenderId: tender.id,
    companyId: company.id,
    actorId: auth.session.userId,
  });
  return { ok: true, applicationId };
}

// -- withdrawApplication ---------------------------------------------------

/**
 * Company-role users withdraw their own application. Only allowed while
 * the application is still `submitted` - once staff have shortlisted or
 * rejected, the company can't unilaterally rescind (audit trail).
 *
 * Day 5: a withdrawn application can be recalled (flipped back to
 * submitted) by the same company within `RECALL_WINDOW_DAYS` of the
 * withdrawal. See `recallApplication` below.
 */
export async function withdrawApplication(
  rawInput: unknown,
): Promise<ActionResult> {
  const auth = await requireCompanyRole();
  if (!auth.ok) return auth;

  const parsed = withdrawApplicationSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: "Invalid application id" };
  }

  const existing = await db
    .select()
    .from(tenderApplications)
    .where(eq(tenderApplications.id, parsed.data.applicationId))
    .limit(1)
    .then((rows) => rows[0]);

  if (!existing) {
    return { ok: false, error: "Application not found" };
  }

  // Ownership check - caller's companyId must match the application's.
  if (existing.companyId !== auth.companyId) {
    log.warn("withdrawApplication forbidden", {
      userId: auth.session.userId,
      companyId: auth.companyId,
      applicationId: existing.id,
      ownerCompanyId: existing.companyId,
    });
    // Don't leak the existence of someone else's application.
    return { ok: false, error: "Application not found" };
  }

  if (existing.status !== "submitted") {
    return {
      ok: false,
      error: `Cannot withdraw - application is already ${existing.status}`,
    };
  }

  const decidedAtIso = new Date().toISOString();

  await db
    .update(tenderApplications)
    .set({
      status: "withdrawn",
      decidedAt: decidedAtIso,
    })
    .where(eq(tenderApplications.id, existing.id));

  // Day 6: target the APPLICATION row directly. The parent tenderId
  // moves to metadata so per-tender history queries can still surface
  // the event via a metadata.tenderId filter on the audit reader.
  await recordAuditEvent({
    actorId: auth.session.userId,
    actorRole: auth.session.role,
    action: "updated",
    targetType: "tender_application",
    targetId: existing.id,
    before: { status: "submitted", decidedAt: null },
    after: { status: "withdrawn", decidedAt: decidedAtIso },
    metadata: {
      tenderId: existing.tenderId,
      companyId: existing.companyId,
      statusChange: { from: "submitted", to: "withdrawn" },
    },
  });

  log.info("tender application withdrawn", {
    applicationId: existing.id,
    actorId: auth.session.userId,
  });
  return { ok: true };
}

// -- updateApplicationStatus -----------------------------------------------

/**
 * Admin/staff transition an application's status (e.g.
 * submitted -> shortlisted, submitted -> rejected). The schema restricts
 * the legal targets to `shortlisted` and `rejected` - `submitted` is
 * the initial state and `withdrawn` is company-driven only.
 *
 * Day 5: reversals (shortlisted/rejected back to submitted) now go
 * through the dedicated `reinstateApplication` action below, which
 * clears `decidedAt` to NULL and uses the `application_reinstated`
 * audit verb. This action no longer handles those reversals - its
 * schema only accepts `shortlisted` / `rejected` as targets.
 *
 * Allowed sources: `submitted` only - once an application has been
 * decided either way, this action is a no-op (idempotent same-status
 * write returns ok). Reversing a decision goes via `reinstateApplication`.
 */
export async function updateApplicationStatus(
  rawInput: unknown,
): Promise<ActionResult> {
  const auth = await requireAdminOrStaff();
  if (!auth.ok) return auth;

  const parsed = updateApplicationStatusSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid input",
      field: first?.path.join(".") || undefined,
    };
  }
  const input = parsed.data;

  const existing = await db
    .select()
    .from(tenderApplications)
    .where(eq(tenderApplications.id, input.applicationId))
    .limit(1)
    .then((rows) => rows[0]);

  if (!existing) {
    return { ok: false, error: "Application not found" };
  }

  if (existing.status === "withdrawn") {
    return {
      ok: false,
      error:
        "Cannot change status - the applicant has already withdrawn this application",
    };
  }

  if (existing.status === input.status) {
    return { ok: true }; // idempotent no-op
  }

  // Build patch. Stamp decidedAt every time staff record a decision.
  const decidedAtIso = new Date().toISOString();
  const patch: Partial<typeof tenderApplications.$inferInsert> = {
    status: input.status,
    decidedAt: decidedAtIso,
  };
  if (input.internalNotes !== undefined) {
    patch.internalNotes = input.internalNotes;
  }

  await db
    .update(tenderApplications)
    .set(patch)
    .where(eq(tenderApplications.id, existing.id));

  // Day 6: target the APPLICATION row directly (see withdrawApplication
  // commentary above). The before/after snapshot is now explicit on the
  // event itself rather than buried in metadata.statusChange (which
  // stays for backwards-compat with anything that grepped the old log
  // lines).
  await recordAuditEvent({
    actorId: auth.session.userId,
    actorRole: auth.session.role,
    action: "updated",
    targetType: "tender_application",
    targetId: existing.id,
    before: { status: existing.status, decidedAt: existing.decidedAt },
    after: { status: input.status, decidedAt: decidedAtIso },
    metadata: {
      tenderId: existing.tenderId,
      companyId: existing.companyId,
      statusChange: { from: existing.status, to: input.status },
      ...(input.internalNotes !== undefined
        ? { notesUpdated: true }
        : {}),
    },
  });

  log.info("application status updated", {
    applicationId: existing.id,
    from: existing.status,
    to: input.status,
    actorId: auth.session.userId,
  });
  return { ok: true };
}

// -- listApplicationsForTender ---------------------------------------------

/**
 * Result payload for the tender detail page's applications list. Each
 * row carries the application plus enough of the applying company's
 * data to render a useful row without an extra fetch.
 */
export type TenderApplicationRow = TenderApplication & {
  company: Pick<
    Company,
    "id" | "name" | "sector" | "geography" | "isMsme" | "complianceStatus"
  >;
};

/**
 * List all applications for a tender, joined with applying-company
 * basics. Used on the tender detail page.
 *
 * Visibility:
 *   - admin/staff   -> all applications, all fields
 *   - company       -> if they're the publisher, all applications; if
 *                      they're an applicant, only their own row
 *
 * The list is ordered submittedAt ASC by default (oldest applications
 * first) so the timeline reads naturally on the detail page.
 */
export async function listApplicationsForTender(
  rawTenderId: unknown,
): Promise<ActionResult<{ rows: TenderApplicationRow[] }>> {
  const scope = await resolveReadScope();
  if (!scope.ok) return scope;

  const parsed = tenderIdSchema.safeParse({ id: rawTenderId });
  if (!parsed.success) {
    return { ok: false, error: "Invalid tender id" };
  }

  // Need the tender row to know who the publisher is for the visibility
  // gate. Single query, indexed.
  const tender = await db
    .select({
      id: tenders.id,
      publisherCompanyId: tenders.publisherCompanyId,
      status: tenders.status,
    })
    .from(tenders)
    .where(eq(tenders.id, parsed.data.id))
    .limit(1)
    .then((rows) => rows[0]);

  if (!tender) return { ok: false, error: "Tender not found" };

  // Visibility: company-role can only see this list if they're the
  // publisher OR they're an applicant (in which case we filter to
  // their own row below).
  const isCompanyRole = scope.session.role === "company";
  const isPublisher =
    !!scope.scopeCompanyId && tender.publisherCompanyId === scope.scopeCompanyId;

  if (isCompanyRole && !isPublisher && tender.status === "draft") {
    // Drafts hidden from non-publisher company roles.
    return { ok: false, error: "Tender not found" };
  }

  // Build query with optional company-scope filter.
  const filters: SQL[] = [eq(tenderApplications.tenderId, tender.id)];
  if (isCompanyRole && !isPublisher && scope.scopeCompanyId) {
    filters.push(eq(tenderApplications.companyId, scope.scopeCompanyId));
  }

  // INNER JOIN to companies - every application has a company by FK
  // contract, so the inner join is correct (no orphan applications
  // possible without violating the cascade).
  const rows = await db
    .select({
      id: tenderApplications.id,
      tenderId: tenderApplications.tenderId,
      companyId: tenderApplications.companyId,
      status: tenderApplications.status,
      coverNote: tenderApplications.coverNote,
      internalNotes: tenderApplications.internalNotes,
      submittedAt: tenderApplications.submittedAt,
      decidedAt: tenderApplications.decidedAt,
      updatedAt: tenderApplications.updatedAt,
      company: {
        id: companies.id,
        name: companies.name,
        sector: companies.sector,
        geography: companies.geography,
        isMsme: companies.isMsme,
        complianceStatus: companies.complianceStatus,
      },
    })
    .from(tenderApplications)
    .innerJoin(companies, eq(tenderApplications.companyId, companies.id))
    .where(and(...filters))
    .orderBy(asc(tenderApplications.submittedAt));

  // Strip internal notes from each row for company-role callers.
  const sanitized: TenderApplicationRow[] = isCompanyRole
    ? rows.map((r) => ({ ...r, internalNotes: null }))
    : rows;

  return { ok: true, rows: sanitized };
}

// -- listMyApplications ----------------------------------------------------

/**
 * Company-role users see all their company's applications - used for the
 * "My applications" page (lands in a later UI chunk).
 *
 * Returns each application joined with a slim tender summary so the UI
 * can render a list without an N+1 fetch.
 */
export type MyApplicationRow = TenderApplication & {
  tender: Pick<Tender, "id" | "title" | "status" | "closingDate" | "sector">;
};

export async function listMyApplications(): Promise<
  ActionResult<{ rows: MyApplicationRow[] }>
> {
  const auth = await requireCompanyRole();
  if (!auth.ok) return auth;

  const rows = await db
    .select({
      id: tenderApplications.id,
      tenderId: tenderApplications.tenderId,
      companyId: tenderApplications.companyId,
      status: tenderApplications.status,
      coverNote: tenderApplications.coverNote,
      // Company-role caller - strip internal notes by always returning null.
      internalNotes: tenderApplications.internalNotes,
      submittedAt: tenderApplications.submittedAt,
      decidedAt: tenderApplications.decidedAt,
      updatedAt: tenderApplications.updatedAt,
      tender: {
        id: tenders.id,
        title: tenders.title,
        status: tenders.status,
        closingDate: tenders.closingDate,
        sector: tenders.sector,
      },
    })
    .from(tenderApplications)
    .innerJoin(tenders, eq(tenderApplications.tenderId, tenders.id))
    .where(eq(tenderApplications.companyId, auth.companyId))
    .orderBy(desc(tenderApplications.submittedAt));

  // Strip internal notes - company role.
  const sanitized: MyApplicationRow[] = rows.map((r) => ({
    ...r,
    internalNotes: null,
  }));

  return { ok: true, rows: sanitized };
}

// ===========================================================================
//
//                      Day 5 - Reversal capability
//
//   Four actions for admin-led (and company-side, for recall) recovery
//   from accidental status changes. Built on the relaxed state machine
//   (see `state-machine.ts` - Day-5 edits legalised closed->published,
//   awarded->closed, and the three application-side reversals).
//
//   Delete is intentionally NOT reversed here - the type-to-confirm
//   friction plus the draft-only restriction are the safety net; soft
//   delete is a larger surface area that warrants its own design pass.
//
// ===========================================================================

// -- reopenTender ----------------------------------------------------------

/**
 * Reopen a closed tender. **Admin only.** Moves the tender from
 * `closed` back to `published`. Reason is optional but captured in the
 * audit log when supplied.
 *
 * Why this exists: staff occasionally close a tender too early (clicked
 * the wrong button, misread the closing date, etc.). Before Day 5 the
 * only recovery was "create a fresh draft", which lost the audit trail
 * and forced applicants to re-apply. Reopen preserves the original
 * record + its applications.
 *
 * Caveats the UI should surface (via the ConfirmDialog warning copy):
 *   - Companies who already saw the tender as "closed" will be confused
 *     when it flips back to published.
 *   - The original publishedAt timestamp is preserved (we don't reset
 *     it on reopen) - auditors looking at "when was this published?"
 *     get the first-publish time, with the reopen captured separately
 *     in the audit log.
 *
 * Restricted to admin (not staff) to keep the blast radius small -
 * staff who needs a reopen escalates to an admin.
 */
export async function reopenTender(
  rawInput: unknown,
): Promise<ActionResult> {
  // 1. AuthZ - admin only
  const auth = await requireAdmin();
  if (!auth.ok) return auth;

  // 2. Validate
  const parsed = reopenTenderSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid input",
      field: first?.path.join(".") || undefined,
    };
  }
  const input = parsed.data;

  // 3. Defence in depth - assert the row is actually `closed` before
  //    asking the state machine. transitionTenderStatus will also check,
  //    but this gives a clearer error for the rare "this tender isn't
  //    closed" case (e.g. status flipped from under us in a different
  //    tab).
  const existing = await db
    .select({ status: tenders.status })
    .from(tenders)
    .where(eq(tenders.id, input.tenderId))
    .limit(1)
    .then((rows) => rows[0]);

  if (!existing) {
    return { ok: false, error: "Tender not found" };
  }
  if (existing.status !== "closed") {
    return {
      ok: false,
      error: `Cannot reopen - tender is ${existing.status}, not closed`,
    };
  }

  // 4. Delegate to the shared transition helper with the reversal audit
  //    verb and reason metadata.
  return transitionTenderStatus(
    input.tenderId,
    "published",
    auth.session,
    "tender_reopened",
    input.reason ? { reason: input.reason } : undefined,
  );
}

// -- retractAward ----------------------------------------------------------

/**
 * Retract a tender award. **Admin only.** Moves the tender from
 * `awarded` back to `closed`. **Reason is REQUIRED** (highest-stakes
 * reversal in the app - captured prominently in the audit log).
 *
 * Why this exists: occasionally an award decision gets reversed for
 * legitimate reasons (the awarded company withdraws their offer, a
 * compliance check fails post-award, etc.). The procurement decision
 * itself is significant enough that we want a written rationale on
 * record alongside the structured audit event.
 *
 * Restricted to admin (not staff) by design - retracting an award is
 * a higher-stakes action than the original `markAwarded` because of
 * the contractual implications of the original decision.
 */
export async function retractAward(
  rawInput: unknown,
): Promise<ActionResult> {
  // 1. AuthZ - admin only
  const auth = await requireAdmin();
  if (!auth.ok) return auth;

  // 2. Validate. Schema enforces reason is present (min 5 chars).
  const parsed = retractAwardSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid input",
      field: first?.path.join(".") || undefined,
    };
  }
  const input = parsed.data;

  // 3. Defence-in-depth status check.
  const existing = await db
    .select({ status: tenders.status })
    .from(tenders)
    .where(eq(tenders.id, input.tenderId))
    .limit(1)
    .then((rows) => rows[0]);

  if (!existing) {
    return { ok: false, error: "Tender not found" };
  }
  if (existing.status !== "awarded") {
    return {
      ok: false,
      error: `Cannot retract award - tender is ${existing.status}, not awarded`,
    };
  }

  // 4. Delegate to the shared transition helper with the reversal audit
  //    verb and required reason metadata.
  return transitionTenderStatus(
    input.tenderId,
    "closed",
    auth.session,
    "tender_award_retracted",
    { reason: input.reason },
  );
}

// -- reinstateApplication --------------------------------------------------

/**
 * Reinstate a shortlisted or rejected application. **Admin/staff only.**
 * Flips the application's status back to `submitted` and clears
 * `decidedAt` to NULL so the row genuinely returns to "waiting on staff"
 * state.
 *
 * Why this exists: staff occasionally click the wrong icon button in
 * the applications table (shortlist when they meant to reject, or vice
 * versa). Reinstate puts the application back in the queue without
 * losing the audit trail of the original decision.
 *
 * Why we clear `decidedAt`: a non-null decidedAt on a `submitted`
 * application would be a data anomaly - any future query for "when
 * was this decided?" would get a misleading timestamp for a decision
 * that's been undone. The previous decidedAt is preserved in the audit
 * event's `metadata.previousDecidedAt` for forensic reference.
 *
 * Reason is optional. Most reinstatements are simple corrections; when
 * a real reason exists ("re-reviewed eligibility documents and the
 * application qualifies after all") it's worth capturing.
 */
export async function reinstateApplication(
  rawInput: unknown,
): Promise<ActionResult> {
  // 1. AuthZ - admin/staff
  const auth = await requireAdminOrStaff();
  if (!auth.ok) return auth;

  // 2. Validate
  const parsed = reinstateApplicationSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid input",
      field: first?.path.join(".") || undefined,
    };
  }
  const input = parsed.data;

  // 3. Load existing application - need the snapshot for audit and the
  //    current status for the transition gate.
  const existing = await db
    .select()
    .from(tenderApplications)
    .where(eq(tenderApplications.id, input.applicationId))
    .limit(1)
    .then((rows) => rows[0]);

  if (!existing) {
    return { ok: false, error: "Application not found" };
  }

  // 4. Reinstate is specifically for staff-decision reversals, not for
  //    company-driven withdrawals. Recall is the separate company action
  //    for withdrawn -> submitted; refuse here even though the state
  //    machine would technically allow it (defence in depth - keeps the
  //    two actions' surfaces distinct).
  if (existing.status === "withdrawn") {
    return {
      ok: false,
      error:
        "Withdrawn applications must be recalled by the applicant, not reinstated by staff",
    };
  }

  // 5. Status gate. Only shortlisted/rejected can be reinstated. The
  //    state machine codifies this; we ask it directly.
  if (!isLegalApplicationTransition(existing.status, "submitted")) {
    return {
      ok: false,
      error: illegalApplicationTransitionMessage(existing.status, "submitted"),
    };
  }

  // 6. Apply patch - status flips back to submitted, decidedAt cleared.
  const previousStatus = existing.status;
  const previousDecidedAt = existing.decidedAt;
  try {
    await db
      .update(tenderApplications)
      .set({
        status: "submitted",
        decidedAt: null,
      })
      .where(eq(tenderApplications.id, existing.id));
  } catch (err) {
    log.error("reinstateApplication failed", {
      err,
      applicationId: existing.id,
      actorId: auth.session.userId,
    });
    throw err;
  }

  // 7. Audit with the dedicated reversal verb. Day 6: targets the
  //    APPLICATION directly; tenderId rides in metadata. Preserves the
  //    previous decision time so forensic queries can answer "when was
  //    the original decision made?" even after the row state is reset.
  await recordAuditEvent({
    actorId: auth.session.userId,
    actorRole: auth.session.role,
    action: "application_reinstated",
    targetType: "tender_application",
    targetId: existing.id,
    before: { status: previousStatus, decidedAt: previousDecidedAt },
    after: { status: "submitted", decidedAt: null },
    metadata: {
      tenderId: existing.tenderId,
      companyId: existing.companyId,
      previousDecidedAt,
      ...(input.reason ? { reason: input.reason } : {}),
    },
  });

  log.info("application reinstated", {
    applicationId: existing.id,
    from: previousStatus,
    actorId: auth.session.userId,
  });
  return { ok: true };
}

// -- recallApplication -----------------------------------------------------

/**
 * Recall a withdrawn application. **Company-role only, on own
 * application, within the recall window.**
 *
 * Flips a `withdrawn` application back to `submitted` and clears
 * `decidedAt`. Mirrors `reinstateApplication` from the company side but
 * adds a hard time-window guard: a withdrawal more than
 * `RECALL_WINDOW_DAYS` (currently 7) old is permanent.
 *
 * Why this exists: companies sometimes withdraw applications in haste
 * (changed their mind about pursuing the contract, miscommunication
 * inside the organisation) and want to re-engage shortly after. The
 * 7-day window matches a business week - long enough for a Monday-
 * morning regret to be actioned, short enough that stale withdrawals
 * don't reappear weeks later and surprise staff.
 *
 * Additional guard: if the tender itself has moved on (closed/awarded
 * since the withdrawal), the recall is blocked - putting an application
 * back to `submitted` on a non-published tender would create a row
 * state the rest of the system can't reason about cleanly.
 *
 * Captures `daysSinceWithdrawal` in the audit metadata for forensic
 * context - useful for spotting patterns of repeat-recall behaviour
 * if that becomes a concern.
 */
export async function recallApplication(
  rawInput: unknown,
): Promise<ActionResult> {
  // 1. AuthZ - company role only
  const auth = await requireCompanyRole();
  if (!auth.ok) return auth;

  // 2. Validate
  const parsed = recallApplicationSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid input",
      field: first?.path.join(".") || undefined,
    };
  }
  const input = parsed.data;

  // 3. Load existing application
  const existing = await db
    .select()
    .from(tenderApplications)
    .where(eq(tenderApplications.id, input.applicationId))
    .limit(1)
    .then((rows) => rows[0]);

  if (!existing) {
    return { ok: false, error: "Application not found" };
  }

  // 4. Ownership check - caller's companyId must match the application's.
  //    Don't leak the existence of someone else's application; return
  //    the same "not found" error a missing-row would.
  if (existing.companyId !== auth.companyId) {
    log.warn("recallApplication forbidden", {
      userId: auth.session.userId,
      companyId: auth.companyId,
      applicationId: existing.id,
      ownerCompanyId: existing.companyId,
    });
    return { ok: false, error: "Application not found" };
  }

  // 5. Current-status gate. Only withdrawn applications can be recalled.
  if (existing.status !== "withdrawn") {
    return {
      ok: false,
      error: `Cannot recall - application is ${existing.status}, not withdrawn`,
    };
  }

  // 6. Recall window gate. State machine helper takes both ISO formats
  //    (SQLite datetime('now') and JS toISOString) thanks to the
  //    normalising parse inside isWithinRecallWindow.
  if (!isWithinRecallWindow(existing.decidedAt)) {
    return {
      ok: false,
      error: `Recall window has passed (applications can only be recalled within ${RECALL_WINDOW_DAYS} days of withdrawal)`,
    };
  }

  // 7. Tender status sanity check. If the tender has moved on (closed /
  //    awarded) since the withdrawal, recall would put the application
  //    back into a submitted state on a tender that's no longer accepting
  //    applications. Block this - the company should reapply manually
  //    if the tender is ever reopened.
  const tenderRow = await db
    .select({ status: tenders.status })
    .from(tenders)
    .where(eq(tenders.id, existing.tenderId))
    .limit(1)
    .then((rows) => rows[0]);

  if (!tenderRow) {
    // Shouldn't happen given FK constraints, but defensive.
    log.error("recallApplication: tender missing for application", {
      applicationId: existing.id,
      tenderId: existing.tenderId,
    });
    return { ok: false, error: "Tender not found" };
  }

  if (!acceptsApplications(tenderRow.status)) {
    return {
      ok: false,
      error: `Cannot recall - tender is no longer accepting applications (status: ${tenderRow.status})`,
    };
  }

  // 8. Defence-in-depth: confirm the state machine still considers this
  //    a legal application transition (it does, but if anyone ever
  //    tightens the machine this surfaces it cleanly).
  if (!isLegalApplicationTransition(existing.status, "submitted")) {
    return {
      ok: false,
      error: illegalApplicationTransitionMessage(existing.status, "submitted"),
    };
  }

  // 9. Capture forensic metadata BEFORE the write - daysSince reads the
  //    pre-recall decidedAt.
  const elapsedDays = daysSince(existing.decidedAt);
  const previousDecidedAt = existing.decidedAt;

  // 10. Apply patch. Same shape as reinstate - status back to submitted,
  //     decidedAt cleared.
  try {
    await db
      .update(tenderApplications)
      .set({
        status: "submitted",
        decidedAt: null,
      })
      .where(eq(tenderApplications.id, existing.id));
  } catch (err) {
    log.error("recallApplication failed", {
      err,
      applicationId: existing.id,
      actorId: auth.session.userId,
    });
    throw err;
  }

  // 11. Audit with the company-side reversal verb. Day 6: targets the
  //     APPLICATION directly; tenderId rides in metadata alongside the
  //     forensic-context fields.
  await recordAuditEvent({
    actorId: auth.session.userId,
    actorRole: auth.session.role,
    action: "application_recalled",
    targetType: "tender_application",
    targetId: existing.id,
    before: { status: "withdrawn", decidedAt: previousDecidedAt },
    after: { status: "submitted", decidedAt: null },
    metadata: {
      tenderId: existing.tenderId,
      companyId: existing.companyId,
      previousDecidedAt,
      daysSinceWithdrawal: elapsedDays,
      recallWindowDays: RECALL_WINDOW_DAYS,
      ...(input.reason ? { reason: input.reason } : {}),
    },
  });

  log.info("application recalled", {
    applicationId: existing.id,
    daysSinceWithdrawal: elapsedDays,
    actorId: auth.session.userId,
  });
  return { ok: true };
}
