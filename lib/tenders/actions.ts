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

import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  like,
  lte,
  ne,
  or,
  type SQL,
} from "drizzle-orm";
import { db } from "@/lib/db";
import {
  companies,
  tenders,
  tenderApplications,
  users,
  type Company,
  type Tender,
  type TenderApplication,
  type TenderStatus,
} from "@/lib/db/schema";
import { newId } from "@/lib/db/ids";
import { readSession } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import { recordAuditEvent, type AuditAction } from "@/lib/audit/log";
import type { ActionResult } from "@/lib/types/action-result";
import { env } from "@/lib/env";
import { sendEmail, type SendEmailFn } from "@/lib/email/client";
import { renderApplicationShortlistedEmail } from "@/lib/email/templates/application-shortlisted";
import { renderApplicationRejectedEmail } from "@/lib/email/templates/application-rejected";
import { createNotificationsForUsers } from "@/lib/notifications/notify";
import type { NotificationType } from "@/lib/notifications/types";
import {
  createTenderSchema,
  updateTenderSchema,
  listTendersQuerySchema,
  listTendersForExportQuerySchema,
  tenderIdSchema,
  applyToTenderSchema,
  updateApplicationStatusSchema,
  withdrawApplicationSchema,
  // -- Day 5: reversal schemas ---------------------------------------------
  reopenTenderSchema,
  retractAwardSchema,
  reinstateApplicationSchema,
  recallApplicationSchema,
  // -- Day 14: markAwarded gains a required winner ------------------------
  markAwardedSchema,
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

// -- Helper: INR formatter for error messages -----------------------------

/**
 * Format a whole-rupee integer as an Indian-locale grouped string with
 * the rupee prefix. Used in user-facing error messages from the turnover
 * gate so the figure reads cleanly in the alert banner ("at least
 * Rs.5,00,00,000" rather than "at least 50000000").
 *
 * Kept inline rather than imported from the shared formatter (Chunk 3)
 * because this lives in a "use server" file and we want zero coupling
 * to client-facing helpers. The shared `formatInr` will replace this
 * once the lift happens; until then they produce visually equivalent
 * output. Using "Rs." prefix (ASCII) rather than the rupee glyph since
 * the error message is consumed by a JSON string passed to the client.
 */
function formatInrForError(rupees: number): string {
  return `Rs.${new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: 0,
  }).format(rupees)}`;
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
 * extra side-effects (publishedAt, application count guard,
 * awardedCompanyId for award/retract), writes the update, and records
 * the audit event.
 *
 * `auditMetadata` is optional and merged into the audit event's
 * `metadata` field - used by the reversal actions to capture a `reason`
 * provided by the actor.
 *
 * `patchOverrides` (Day 14) is folded into the DB patch alongside the
 * status flip. Used by `markAwarded` to write the winning company id
 * and by `retractAward` to null it back out. Status itself can't be
 * overridden through this hook - that's controlled by `nextStatus`.
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
  patchOverrides?: Partial<typeof tenders.$inferInsert>,
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

  // Day 14: caller-supplied patch overrides for award / retract
  // (writes/clears the awardedCompanyId column). Merged AFTER the
  // status-and-publishedAt computation so callers can't accidentally
  // override the status flip itself - the explicit `nextStatus` always
  // wins.
  if (patchOverrides) {
    Object.assign(patch, patchOverrides, { status: nextStatus });
  }

  // Capture before-snapshot fields that the patch touches, for the
  // audit log. status is always touched; awardedCompanyId is touched
  // when the override sets it.
  const beforeSnapshot: Record<string, unknown> = { status: existing.status };
  if (patch.awardedCompanyId !== undefined) {
    beforeSnapshot.awardedCompanyId = existing.awardedCompanyId;
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
  const afterSnapshot: Record<string, unknown> = { status: nextStatus };
  if (patch.publishedAt) afterSnapshot.publishedAt = patch.publishedAt;
  if (patch.awardedCompanyId !== undefined) {
    afterSnapshot.awardedCompanyId = patch.awardedCompanyId;
  }
  await recordAuditEvent({
    actorId: session.userId,
    actorRole: session.role,
    action: auditAction,
    targetType: "tender",
    targetId: existing.id,
    before: beforeSnapshot,
    after: afterSnapshot,
    ...(auditMetadata ? { metadata: auditMetadata } : {}),
  });

  // In-app notification to eligible companies' users on a genuine
  // draft -> published publish. Fail-soft (createNotificationsForUsers
  // never throws; no-ops on an empty set). Gated on the audit verb + the
  // exact status pair so the OTHER published-target transitions through
  // this shared helper (reopen via closed -> published, unpublish, close,
  // award) don't re-blast every eligible company. Eligibility mirrors
  // `applyToTender`'s gates exactly (sector / geography / MSME / turnover),
  // restricted to compliant companies and excluding the publisher's own.
  if (
    auditAction === "tender_published" &&
    existing.status === "draft" &&
    nextStatus === "published"
  ) {
    const companyFilters: SQL[] = [
      eq(companies.complianceStatus, "compliant"),
      ne(companies.id, existing.publisherCompanyId),
    ];
    if (existing.eligibleSector) {
      companyFilters.push(eq(companies.sector, existing.eligibleSector));
    }
    if (existing.eligibleGeography) {
      companyFilters.push(eq(companies.geography, existing.eligibleGeography));
    }
    if (existing.msmeOnly) {
      companyFilters.push(eq(companies.isMsme, true));
    }
    if (existing.minAnnualTurnoverInr !== null) {
      // gte drops NULL-turnover rows in SQLite — matching applyToTender,
      // which refuses applicants who haven't stated a turnover.
      companyFilters.push(
        gte(companies.annualTurnover, existing.minAnnualTurnoverInr),
      );
    }
    const recipients = await db
      .select({ id: users.id })
      .from(users)
      .innerJoin(companies, eq(users.companyId, companies.id))
      .where(and(...companyFilters));
    await createNotificationsForUsers(
      recipients.map((r) => r.id),
      {
        type: "tender_published",
        title: "New tender you may be eligible for",
        body: existing.title,
        link: `/dashboard/tenders/${existing.id}`,
      },
    );
  }

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
 * Day 14: input shape changed from a bare tender id to
 * `{ tenderId, awardedCompanyId }`. Old call sites that passed a string
 * will now fail Zod validation - that's deliberate; recording the
 * winner is no longer optional.
 *
 * Gate order:
 *   1. AuthZ (admin/staff)
 *   2. Schema (both ids well-formed)
 *   3. Tender exists + is in `closed` status
 *   4. There IS an application from the named company on this tender
 *      AND it is in `shortlisted` status. Submitted-not-yet-decided,
 *      rejected, and withdrawn applicants cannot be awarded - staff
 *      have to reinstate / shortlist first if the decision lands on a
 *      previously-rejected bid.
 *   5. Status flip to awarded + write `awardedCompanyId` in one patch.
 *
 * As of Day 5, `awarded` is no longer a strictly-terminal state -
 * `retractAward` can move it back to `closed` and clears the column.
 */
export async function markAwarded(rawInput: unknown): Promise<ActionResult> {
  const auth = await requireAdminOrStaff();
  if (!auth.ok) return auth;

  const parsed = markAwardedSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid input",
      field: first?.path.join(".") || undefined,
    };
  }
  const input = parsed.data;

  // Confirm the tender exists + is in `closed` status before touching
  // the application. transitionTenderStatus will check again, but the
  // explicit check here gives a cleaner error and lets us bail before
  // the eligibility query.
  const tenderRow = await db
    .select({ id: tenders.id, status: tenders.status })
    .from(tenders)
    .where(eq(tenders.id, input.tenderId))
    .limit(1)
    .then((rows) => rows[0]);
  if (!tenderRow) {
    return { ok: false, error: "Tender not found" };
  }
  if (tenderRow.status !== "closed") {
    return {
      ok: false,
      error: `Cannot award - tender is ${tenderRow.status}, not closed`,
    };
  }

  // Application gate. Use the composite (tenderId, companyId) index for
  // a single-row lookup.
  const application = await db
    .select({
      id: tenderApplications.id,
      status: tenderApplications.status,
    })
    .from(tenderApplications)
    .where(
      and(
        eq(tenderApplications.tenderId, input.tenderId),
        eq(tenderApplications.companyId, input.awardedCompanyId),
      ),
    )
    .limit(1)
    .then((rows) => rows[0]);

  if (!application) {
    return {
      ok: false,
      field: "awardedCompanyId",
      error:
        "Cannot award - the named company has no application on this tender",
    };
  }
  if (application.status !== "shortlisted") {
    return {
      ok: false,
      field: "awardedCompanyId",
      error: `Cannot award - applicant must be shortlisted first (current status: ${application.status})`,
    };
  }

  const result = await transitionTenderStatus(
    input.tenderId,
    "awarded",
    auth.session,
    "updated",
    {
      awardedCompanyId: input.awardedCompanyId,
      applicationId: application.id,
    },
    { awardedCompanyId: input.awardedCompanyId },
  );
  if (!result.ok) return result;

  // In-app notification to the awarded company's users. Raised here rather
  // than in transitionTenderStatus because only this site knows which
  // company won (the shared helper is recipient-agnostic). Fail-soft, after
  // the status flip + audit event have succeeded. Mirrors
  // updateApplicationStatusInternal's fan-out.
  const recipients = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.companyId, input.awardedCompanyId));
  await createNotificationsForUsers(
    recipients.map((r) => r.id),
    {
      type: "application_awarded",
      title: "Tender awarded to your company",
      body: "Congratulations — your application has been selected as the winning bid.",
      link: `/dashboard/tenders/${input.tenderId}`,
    },
  );

  return result;
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
  return runListTendersForCaller(parsed.data, scope);
}

/**
 * Export-only sibling of `listTenders`. Same shape, same visibility
 * scope, but parses with `listTendersForExportQuerySchema` so the route
 * handler's `perPage=1000` request gets through. The table-facing
 * `listTenders` keeps the 100 cap intact for the list page.
 */
export async function listTendersForExport(
  rawQuery: unknown,
): Promise<ActionResult<ListTendersPayload>> {
  const scope = await resolveReadScope();
  if (!scope.ok) return scope;

  const parsed = listTendersForExportQuerySchema.safeParse(rawQuery ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid query",
      field: first?.path.join(".") || undefined,
    };
  }
  return runListTendersForCaller(parsed.data, scope);
}

/**
 * Inner helper — actual listing logic, applied AFTER auth + scope + parse.
 * Both `listTenders` (strict 100 cap) and `listTendersForExport`
 * (1000 cap) call this once their respective Zod parse succeeds. The
 * `query` type is the strict variant; the export schema extends it with
 * a wider `perPage` ceiling but produces a structurally identical
 * typed shape.
 */
async function runListTendersForCaller(
  query: ListTendersQuery,
  scope: Extract<Awaited<ReturnType<typeof resolveReadScope>>, { ok: true }>,
): Promise<ActionResult<ListTendersPayload>> {
  // Build WHERE clauses additively.
  const filters: SQL[] = [];

  // Row-level scope: company-role users get a status whitelist OR their
  // own drafts. Day 14: encoded directly in SQL via Drizzle's `or(...)`
  // rather than a JS post-filter — the previous approach (filter in JS
  // after fetching the page) made the `total` count an approximation
  // because other-publisher drafts that fell on the current page would
  // be subtracted but other pages couldn't be inspected. The SQL
  // version returns an accurate count without any extra query.
  //
  // Branch table (company-role):
  //   status filter        WHERE clause
  //   ──────────────       ────────────
  //   none                 (status != 'draft') OR (publisher = own)
  //   'draft'              status = 'draft' AND publisher = own
  //   other status         status = <other>
  //
  // The third branch needs no special handling - admin/staff would
  // produce the same WHERE, but the company-role caller still gets the
  // visibility-respecting result because only non-draft statuses can
  // reach this branch (Zod schema permits all four, but draft is
  // handled above and the others don't expose anything restricted).
  if (scope.scopeCompanyId) {
    if (query.status === "draft") {
      filters.push(eq(tenders.status, "draft"));
      filters.push(eq(tenders.publisherCompanyId, scope.scopeCompanyId));
    } else if (query.status) {
      filters.push(eq(tenders.status, query.status));
    } else {
      // No status filter: visibility = non-drafts ∪ own-publisher drafts.
      // The `or(...)` result is typed as `SQL | undefined` because both
      // inputs are `SQL`, but neither can be null at this point - the
      // bang asserts the contract.
      filters.push(
        or(
          ne(tenders.status, "draft"),
          eq(tenders.publisherCompanyId, scope.scopeCompanyId),
        )!,
      );
    }
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
  // Same shape as the companies list. As of Day 14 the visibility-scope
  // clause is baked into `whereClause`, so the count is accurate without
  // a JS-side adjustment.
  const [rows, totalRow] = await Promise.all([
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

  const total = totalRow?.value ?? 0;

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
 *   4. Turnover gate (Day 8): when the tender sets a minimum, the
 *      applying company must have a STATED turnover that meets it.
 *      Unstated turnover (`NULL`) is a hard refusal - we can't verify
 *      eligibility without the figure. Stated-but-too-low surfaces a
 *      different error so the company knows the bar is real and isn't
 *      just a data-entry oversight.
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

  // 6b. Turnover gate (Day 8). Two distinct branches:
  //
  //     - Tender requires a minimum AND company has not stated their
  //       turnover -> refuse. We cannot verify eligibility without the
  //       figure, and silently allowing the application would let
  //       under-qualifying companies slip through by leaving the field
  //       blank. The error surfaces the actionable next step (set the
  //       turnover on the company profile) and carries a field hint
  //       pointing to the gap on the company record itself.
  //
  //     - Tender requires a minimum AND company's stated turnover is
  //       below it -> refuse with the figure the tender requires, so
  //       the company knows the gap rather than just "ineligible." No
  //       field hint here - the user can't unilaterally fix this by
  //       editing their own row (raising turnover to apply would be
  //       fraud), so a field-targeted error would be misleading.
  //
  //     NULL on the tender side (`minAnnualTurnoverInr === null`) means
  //     "no minimum required," and the gate is skipped entirely - both
  //     stated-zero and unstated-NULL companies pass through unmolested.
  //
  //     The audit trail captures successful applications via the
  //     `tender_applied` event below; gate-rejected attempts deliberately
  //     do NOT create audit rows (existing convention - only successful
  //     state changes audit). If we ever want forensic visibility on
  //     repeat-rejection patterns, that's a separate `tender_application_
  //     rejected_eligibility` verb worth its own design pass.
  if (tender.minAnnualTurnoverInr !== null) {
    if (company.annualTurnover === null) {
      return {
        ok: false,
        field: "annualTurnover",
        error:
          "This tender requires a minimum annual turnover. Update your company's annual turnover on the company profile before applying.",
      };
    }
    if (company.annualTurnover < tender.minAnnualTurnoverInr) {
      return {
        ok: false,
        error: `Your stated annual turnover (${formatInrForError(company.annualTurnover)}) does not meet this tender's minimum of ${formatInrForError(tender.minAnnualTurnoverInr)}.`,
      };
    }
  }

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
 *
 * Day 14: on a successful shortlist/reject transition, fires an email
 * notification to the applying company's `contactEmail`. Fail-soft -
 * a failed email is logged at warn level but the action still returns
 * ok. The status flip is the real decision; we never reverse a status
 * write because the network blipped on the way to Resend. Same
 * convention the cron uses.
 */
export async function updateApplicationStatus(
  rawInput: unknown,
): Promise<ActionResult> {
  return updateApplicationStatusInternal(rawInput, { sendEmail });
}

/**
 * Injection point exposed for tests. The public Server Action above
 * passes the production `sendEmail`; tests import this directly and
 * pass a vi.fn so they can assert payloads without touching Resend.
 *
 * The pattern mirrors how `runExpirySweep` takes its deps explicitly -
 * keeps `vi.mock` scoped to the auth boundary only, leaves the email
 * boundary as an honest parameter.
 *
 * Exported so tests can call it with custom deps. Not part of the
 * public action surface - production callers should keep using
 * `updateApplicationStatus` above.
 */
export interface UpdateApplicationStatusDeps {
  sendEmail: SendEmailFn;
}

/**
 * In-app notification copy per application decision. Award is raised by
 * `markAwarded` (it alone knows the winning company); reinstate / other
 * transitions raise nothing.
 */
const APPLICATION_STATUS_NOTIFICATIONS: Record<
  string,
  { type: NotificationType; title: string; body: string }
> = {
  shortlisted: {
    type: "application_shortlisted",
    title: "Application shortlisted",
    body: "Your tender application has been shortlisted.",
  },
  rejected: {
    type: "application_rejected",
    title: "Application decision",
    body: "A decision has been made on your tender application.",
  },
};

export async function updateApplicationStatusInternal(
  rawInput: unknown,
  deps: UpdateApplicationStatusDeps,
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

  // In-app notification to the applicant company's users, mirroring the
  // email below. Fail-soft. Only the decision verbs raise one.
  const appNotif = APPLICATION_STATUS_NOTIFICATIONS[input.status];
  if (appNotif) {
    const recipients = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.companyId, existing.companyId));
    await createNotificationsForUsers(
      recipients.map((r) => r.id),
      {
        type: appNotif.type,
        title: appNotif.title,
        body: appNotif.body,
        link: `/dashboard/tenders/${existing.tenderId}`,
      },
    );
  }

  // Day 14: notify the applicant. Fail-soft - the status flip already
  // succeeded and is the load-bearing fact; a missed email surfaces in
  // the log and the next-day cron / staff follow-up can recover. We
  // deliberately do NOT propagate email failures to the staff caller -
  // they made the right decision; the side-channel notification is
  // belt-and-braces.
  await notifyApplicantOfStatusChange({
    sendEmail: deps.sendEmail,
    application: { id: existing.id, submittedAt: existing.submittedAt },
    tenderId: existing.tenderId,
    companyId: existing.companyId,
    newStatus: input.status,
  });

  return { ok: true };
}

/**
 * Resolve the tender + company, render the right template, and send.
 * Pulled out of the main action so the happy path stays readable; the
 * resolve/render/send dance lives in one place that fails closed when
 * any prerequisite is missing.
 *
 * Why both lookups here rather than as JOINs on the main query:
 *   updateApplicationStatus's primary job is the status flip; the
 *   notification is a follow-up that doesn't need to block or share
 *   data with the flip. Two small queries at this point are cheaper
 *   than reshaping the main read.
 *
 * Failure handling: missing tender, missing company, missing email,
 * and failed send each log + return. None throws. None affects the
 * caller's `ok: true` return.
 */
async function notifyApplicantOfStatusChange(args: {
  sendEmail: SendEmailFn;
  application: { id: string; submittedAt: string };
  tenderId: string;
  companyId: string;
  newStatus: "shortlisted" | "rejected";
}): Promise<void> {
  try {
    // Both queries can fan out in parallel - independent reads.
    const [tender, company] = await Promise.all([
      db
        .select({
          id: tenders.id,
          title: tenders.title,
          referenceNumber: tenders.referenceNumber,
          closingDate: tenders.closingDate,
        })
        .from(tenders)
        .where(eq(tenders.id, args.tenderId))
        .limit(1)
        .then((rows) => rows[0]),
      db
        .select({
          id: companies.id,
          name: companies.name,
          contactEmail: companies.contactEmail,
        })
        .from(companies)
        .where(eq(companies.id, args.companyId))
        .limit(1)
        .then((rows) => rows[0]),
    ]);

    if (!tender) {
      log.warn("application notification skipped: tender missing", {
        applicationId: args.application.id,
        tenderId: args.tenderId,
      });
      return;
    }
    if (!company) {
      log.warn("application notification skipped: company missing", {
        applicationId: args.application.id,
        companyId: args.companyId,
      });
      return;
    }
    if (!company.contactEmail) {
      log.warn("application notification skipped: company has no contactEmail", {
        applicationId: args.application.id,
        companyId: company.id,
        companyName: company.name,
        newStatus: args.newStatus,
      });
      return;
    }

    const rendered =
      args.newStatus === "shortlisted"
        ? renderApplicationShortlistedEmail({
            application: args.application,
            tender: {
              id: tender.id,
              title: tender.title,
              referenceNumber: tender.referenceNumber,
              closingDate: tender.closingDate,
            },
            company: { id: company.id, name: company.name },
            appUrl: env.NEXT_PUBLIC_APP_URL,
          })
        : renderApplicationRejectedEmail({
            application: args.application,
            tender: {
              id: tender.id,
              title: tender.title,
              referenceNumber: tender.referenceNumber,
            },
            company: { id: company.id, name: company.name },
            appUrl: env.NEXT_PUBLIC_APP_URL,
          });

    const result = await args.sendEmail({
      to: company.contactEmail,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });

    if (!result.ok) {
      log.warn("application notification send failed", {
        applicationId: args.application.id,
        companyId: company.id,
        newStatus: args.newStatus,
        error: result.error,
      });
      return;
    }

    log.info("application notification sent", {
      applicationId: args.application.id,
      companyId: company.id,
      newStatus: args.newStatus,
      messageId: result.id,
    });
  } catch (err) {
    // Defence in depth: any unexpected throw during the notification
    // path must not surface to the caller. Log and swallow.
    log.error("application notification threw", {
      err,
      applicationId: args.application.id,
      newStatus: args.newStatus,
    });
  }
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
  //    verb and required reason metadata. Day 14: also null the
  //    awardedCompanyId so the column stays symmetric with the status
  //    flip - a retracted tender genuinely has no winner anymore.
  return transitionTenderStatus(
    input.tenderId,
    "closed",
    auth.session,
    "tender_award_retracted",
    { reason: input.reason },
    { awardedCompanyId: null },
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
