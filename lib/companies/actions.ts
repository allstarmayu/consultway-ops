/**
 * Companies module — Server Actions.
 *
 * Every mutation (create / update / delete) and every read used by the
 * dashboard goes through one of these. They're the **only** place where
 * the database is touched directly for company rows — UI calls these,
 * never raw SQL.
 *
 * Return shape established in Day 2:
 *     { ok: true, ...data }
 *   | { ok: false, error: string, field?: string }
 *
 * Expected failures (bad input, not-found, unauthorized, unique conflict)
 * return `ok: false`. Unexpected failures (DB driver crash, schema drift)
 * throw — Next.js will turn those into a 500 and we want loud signal in
 * the logs, not silent partial success.
 *
 * Role rules (also documented in docs/08-rbac-matrix.md):
 *   - `admin` and `staff`: full CRUD on any company.
 *   - `company`: read & update **own row only**, never create or delete.
 *
 * `admin` also has the sole right to delete — staff cannot remove
 * companies, only edit them. This matches Consultway's expectation that
 * removing a company from the roster is a high-risk action.
 *
 * Audit logging: every mutation (create / update / delete) calls
 * `recordAuditEvent` after the DB write succeeds. The audit logger is
 * a stub today (logs to the structured logger); it'll persist to an
 * `audit_log` table once that lands in a follow-up chunk. Read actions
 * (getCompany, listCompanies) are intentionally NOT audited — would
 * be too noisy and not legally useful.
 *
 * @module lib/companies/actions
 */
"use server";

import { and, asc, count, desc, eq, like, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, users, type Company } from "@/lib/db/schema";
import { newId } from "@/lib/db/ids";
import { readSession } from "@/lib/auth/session";
import {
  requireAdmin,
  requireAdminOrStaff,
  type Session,
} from "@/lib/auth/guards";
import { logger } from "@/lib/logger";
import { recordAuditEvent } from "@/lib/audit/log";
import { createNotificationsForUsers } from "@/lib/notifications/notify";
import type { NotificationType } from "@/lib/notifications/types";
import type { ActionResult } from "@/lib/types/action-result";
import {
  createCompanySchema,
  updateCompanySchema,
  listCompaniesQuerySchema,
  companyIdSchema,
  transitionComplianceStatusSchema,
  type CreateCompanyInput,
  type UpdateCompanyInput,
  type ListCompaniesQuery,
} from "./schemas";
import {
  assertTransitionCompliance,
  ComplianceTransitionError,
} from "./state-machine";
import { stripAdminOnlyFields } from "./field-strip";

const log = logger.child({ module: "companies-actions" });

// ── Authorization helpers ───────────────────────────────────────────────────
//
// `requireAdmin` / `requireAdminOrStaff` (+ the `Session` type) now live in
// `lib/auth/guards.ts`, shared with the users module — imported above. The
// read-and-scope helper below stays local because its `scopeCompanyId`
// shape is companies-specific (row-level scoping for company-role users).

/**
 * Read-and-scope helper. Any signed-in user may call read actions, but
 * the scope of accessible rows depends on role.
 *
 * Returns:
 *   - session
 *   - `scopeCompanyId`: NULL for admin/staff (sees everything),
 *     or the user's own companyId for `company` role (sees own row only)
 *
 * For a `company` role user with no linked companyId, this returns an
 * error — they shouldn't have hit the page in the first place, but we
 * fail closed.
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

// ── Helper: SQLite unique-constraint translation ────────────────────────────

/**
 * SQLite reports unique constraint failures as:
 *   SQLITE_CONSTRAINT: UNIQUE constraint failed: companies.gst_number
 * We translate the most common ones into form-friendly errors so the UI
 * can highlight the offending field. Any other DB error rethrows.
 */
function translateUniqueConflict(
  err: unknown,
): { error: string; field: string } | null {
  if (!(err instanceof Error)) return null;
  const msg = err.message;

  if (msg.includes("companies.gst_number")) {
    return {
      error: "A company with this GST number is already registered",
      field: "gstNumber",
    };
  }
  if (msg.includes("companies.pan_number")) {
    return {
      error: "A company with this PAN is already registered",
      field: "panNumber",
    };
  }
  return null;
}

// ── createCompany ───────────────────────────────────────────────────────────

/**
 * Create a new company. Admin/staff only. The created row starts with
 * `complianceStatus: "pending"` regardless of what the caller sends —
 * compliance state is something the team grants, not something the
 * creator declares.
 *
 * @param rawInput Unvalidated input from the form. Parsed with Zod here.
 * @returns `{ ok: true, id }` on success, `{ ok: false, error, field? }` otherwise.
 */
export async function createCompany(
  rawInput: unknown,
): Promise<ActionResult<{ id: string }>> {
  // 1. AuthZ
  const auth = await requireAdminOrStaff();
  if (!auth.ok) return auth;

  // 2. Validate
  const parsed = createCompanySchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid input",
      field: first?.path.join(".") || undefined,
    };
  }
  const input: CreateCompanyInput = parsed.data;

  // 3. Insert
  const id = newId();
  try {
    await db.insert(companies).values({
      id,
      name: input.name,
      sector: input.sector,
      geography: input.geography,
      gstNumber: input.gstNumber ?? null,
      panNumber: input.panNumber ?? null,
      isMsme: input.isMsme,
      isJv: input.isJv,
      // Force pending — never trust create-side compliance.
      complianceStatus: "pending",
      parentCompanyIds: input.isJv ? (input.parentCompanyIds ?? null) : null,
      // Day 8: turnover is optional at create time. Companies that don't
      // know their figure (typical for self-registration) can fill it in
      // via the edit form later. NULL = "not stated" and bars them from
      // applying to tenders with a minimum-turnover requirement.
      annualTurnover: input.annualTurnover ?? null,
      contactEmail: input.contactEmail ?? null,
      contactPhone: input.contactPhone ?? null,
      contactPersonName: input.contactPersonName ?? null,
      addressLine: input.addressLine ?? null,
      city: input.city ?? null,
      state: input.state ?? null,
      pincode: input.pincode ?? null,
      internalNotes: input.internalNotes ?? null,
    });
  } catch (err) {
    const conflict = translateUniqueConflict(err);
    if (conflict) {
      log.info("createCompany unique conflict", {
        field: conflict.field,
        actorId: auth.session.userId,
      });
      return { ok: false, ...conflict };
    }
    log.error("createCompany failed", { err, actorId: auth.session.userId });
    throw err;
  }

  // 4. Audit. Captures the identity-ish fields that matter for auditing
  //    later — full row contents would be noise on the audit-log table.
  await recordAuditEvent({
    actorId: auth.session.userId,
    actorRole: auth.session.role,
    action: "created",
    targetType: "company",
    targetId: id,
    after: {
      name: input.name,
      sector: input.sector,
      geography: input.geography,
      isJv: input.isJv,
      complianceStatus: "pending",
    },
  });

  log.info("company created", {
    id,
    name: input.name,
    actorId: auth.session.userId,
  });
  return { ok: true, id };
}

// ── updateCompany ───────────────────────────────────────────────────────────

/**
 * Partial update. Admin/staff may patch any company; a `company` role
 * user may patch only their own linked row, and even then we strip
 * `internalNotes` and `complianceStatus` from the payload — those are
 * staff-owned fields.
 *
 * The JV invariant is re-checked here against the merged (current+patch)
 * row state, because Zod can only see the patch alone.
 */
export async function updateCompany(
  rawInput: unknown,
): Promise<ActionResult> {
  // 1. AuthZ (any signed-in user; row-level check happens below)
  const session = await readSession();
  if (!session) return { ok: false, error: "You must be signed in" };

  // 2. Validate
  const parsed = updateCompanySchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid input",
      field: first?.path.join(".") || undefined,
    };
  }
  const input: UpdateCompanyInput = parsed.data;

  // 3. Load existing row
  const existing = await db
    .select()
    .from(companies)
    .where(eq(companies.id, input.id))
    .limit(1)
    .then((rows) => rows[0]);

  if (!existing) {
    return { ok: false, error: "Company not found" };
  }

  // 4. Row-level access check
  const isStaffOrAdmin = session.role === "admin" || session.role === "staff";
  const isOwnRow = session.companyId === existing.id;
  if (!isStaffOrAdmin && !isOwnRow) {
    log.warn("updateCompany forbidden", {
      userId: session.userId,
      role: session.role,
      attemptedId: input.id,
    });
    return { ok: false, error: "You don't have permission to do that" };
  }

  // 5. Build the patch object, stripping fields the caller can't touch.
  //    `undefined` values are skipped — Drizzle's set() ignores them.
  //    `null` values are explicit clears.
  const patch: Partial<typeof companies.$inferInsert> = {};

  if (input.name !== undefined) patch.name = input.name;
  if (input.sector !== undefined) patch.sector = input.sector;
  if (input.geography !== undefined) patch.geography = input.geography;
  if (input.gstNumber !== undefined) patch.gstNumber = input.gstNumber;
  if (input.panNumber !== undefined) patch.panNumber = input.panNumber;
  if (input.isMsme !== undefined) patch.isMsme = input.isMsme;
  if (input.isJv !== undefined) patch.isJv = input.isJv;
  if (input.parentCompanyIds !== undefined)
    patch.parentCompanyIds = input.parentCompanyIds;
  // Day 8: turnover is a fact about the company that the company itself
  // is the authority on. Always-applied (NOT inside the isStaffOrAdmin
  // block below) - a company-role user updating their own row can set
  // or clear their stated turnover. Audit captures the before/after via
  // the standard buildPatchSnapshot walk.
  if (input.annualTurnover !== undefined)
    patch.annualTurnover = input.annualTurnover;
  if (input.contactEmail !== undefined) patch.contactEmail = input.contactEmail;
  if (input.contactPhone !== undefined) patch.contactPhone = input.contactPhone;
  if (input.contactPersonName !== undefined)
    patch.contactPersonName = input.contactPersonName;
  if (input.addressLine !== undefined) patch.addressLine = input.addressLine;
  if (input.city !== undefined) patch.city = input.city;
  if (input.state !== undefined) patch.state = input.state;
  if (input.pincode !== undefined) patch.pincode = input.pincode;

  // Staff-only fields — silently dropped for `company` role, even if the
  // client sent them. Defence in depth: the Zod schema accepted them,
  // and the UI shouldn't show them, but we enforce here too.
  //
  // Day 23: complianceStatus moves are gated by the state machine in
  // lib/companies/state-machine.ts. We assert BEFORE staging the patch
  // so an illegal transition surfaces as a typed ActionResult error
  // rather than a thrown 500. Same-state "transitions" don't move the
  // row — assertTransitionCompliance treats them as legal no-ops, and
  // the equality check on `complianceStatus` below keeps us from
  // emitting a noisy `compliance_status_changed` audit for a no-op.
  let complianceMoved = false;
  if (isStaffOrAdmin) {
    if (input.complianceStatus !== undefined) {
      if (input.complianceStatus !== existing.complianceStatus) {
        try {
          assertTransitionCompliance(
            existing.complianceStatus,
            input.complianceStatus,
          );
        } catch (err) {
          if (err instanceof ComplianceTransitionError) {
            log.info("updateCompany illegal compliance transition", {
              id: input.id,
              actorId: session.userId,
              from: err.from,
              to: err.to,
            });
            return {
              ok: false,
              field: "complianceStatus",
              error: err.message,
            };
          }
          throw err;
        }
        complianceMoved = true;
      }
      patch.complianceStatus = input.complianceStatus;
    }
    if (input.internalNotes !== undefined)
      patch.internalNotes = input.internalNotes;
    if (input.rejectionReason !== undefined)
      patch.rejectionReason = input.rejectionReason;
  }

  // 6. Cross-field invariants against the merged row state.
  //    The Zod schema checked the patch in isolation; here we check what
  //    the row will *look like* after the patch lands.
  const mergedIsJv = patch.isJv ?? existing.isJv;
  const mergedPartners = (
    patch.parentCompanyIds !== undefined
      ? patch.parentCompanyIds
      : existing.parentCompanyIds
  ) as string[] | null;

  if (mergedIsJv && (!mergedPartners || mergedPartners.length < 2)) {
    return {
      ok: false,
      field: "parentCompanyIds",
      error: "A joint venture must have at least 2 partner companies",
    };
  }
  if (!mergedIsJv && mergedPartners && mergedPartners.length > 0) {
    return {
      ok: false,
      field: "parentCompanyIds",
      error: "Non-JV companies cannot have partner companies",
    };
  }

  // Day 24: rejected ⇒ rejectionReason non-null on the merged row.
  //
  // The schema's superRefine catches the half where a patch flips status
  // INTO rejected without a reason. This guard catches the inverse
  // back-door: a patch that clears `rejectionReason` to null / empty
  // while the row is (or stays) rejected. Without it, a client could
  // POST `{ rejectionReason: null }` against a rejected row without
  // including `complianceStatus` — the superRefine wouldn't fire, the
  // seed-invariant verifier would later flag the divergence.
  //
  // Same approach as the JV check above: compute the merged row state
  // and validate the invariant against it. Only meaningful when the
  // patch actually touches rejectionReason (otherwise nothing changes).
  if (patch.rejectionReason !== undefined) {
    const mergedStatus = patch.complianceStatus ?? existing.complianceStatus;
    const mergedReason = patch.rejectionReason;
    const reasonIsEmpty =
      mergedReason === null ||
      (typeof mergedReason === "string" && mergedReason.trim().length === 0);
    if (mergedStatus === "rejected" && reasonIsEmpty) {
      return {
        ok: false,
        field: "rejectionReason",
        error:
          "A rejection reason is required while the company is in rejected status",
      };
    }
  }

  // 7. Apply
  if (Object.keys(patch).length === 0) {
    return { ok: true }; // nothing to update — treat as success, idempotent
  }

  try {
    await db.update(companies).set(patch).where(eq(companies.id, input.id));
  } catch (err) {
    const conflict = translateUniqueConflict(err);
    if (conflict) {
      log.info("updateCompany unique conflict", {
        field: conflict.field,
        actorId: session.userId,
      });
      return { ok: false, ...conflict };
    }
    log.error("updateCompany failed", { err, actorId: session.userId });
    throw err;
  }

  // 8. Audit. We capture before/after of only the fields the patch
  //    touched, derived by walking the patch keys. Storing the full row
  //    diff would inflate the audit log without much benefit — "what
  //    changed" beats "what the row looked like" for forensic queries.
  //
  // Day 23: when the patch moves compliance_status, the audit verb
  // becomes `compliance_status_changed` instead of plain `updated` so
  // the activity feed can highlight state moves separately from routine
  // field edits. The before/after snapshots are the same — they include
  // every touched field, which on a status move covers complianceStatus
  // (and rejectionReason when the move is into `rejected`).
  const touchedKeys = Object.keys(patch);
  const beforeSnapshot = buildPatchSnapshot(existing, touchedKeys);
  const afterSnapshot = buildPatchSnapshot(
    { ...existing, ...patch } as Company,
    touchedKeys,
  );
  await recordAuditEvent({
    actorId: session.userId,
    actorRole: session.role,
    action: complianceMoved ? "compliance_status_changed" : "updated",
    targetType: "company",
    targetId: input.id,
    before: beforeSnapshot,
    after: afterSnapshot,
  });

  log.info("company updated", {
    id: input.id,
    actorId: session.userId,
    fields: touchedKeys,
  });
  return { ok: true };
}

// ── deleteCompany ───────────────────────────────────────────────────────────

/**
 * Delete a company. **Admin only.** The FK on `users.company_id` is
 * `ON DELETE SET NULL`, so any linked users become orphaned (companyId
 * NULL) — they remain in the system for audit, but lose their company
 * association. Admins should review those rows separately.
 */
export async function deleteCompany(rawId: unknown): Promise<ActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return auth;

  const parsed = companyIdSchema.safeParse({ id: rawId });
  if (!parsed.success) {
    return { ok: false, error: "Invalid company id" };
  }

  // Use .returning() to get the deleted row back. That row IS the audit
  // snapshot — once it's gone, we can't reconstruct it from anywhere
  // else, so we capture the whole thing.
  const result = await db
    .delete(companies)
    .where(eq(companies.id, parsed.data.id))
    .returning();

  if (result.length === 0) {
    return { ok: false, error: "Company not found" };
  }

  const deletedRow = result[0];

  // Audit with the full pre-deletion row. Deletion is the one case
  // where storing everything is justified — there's no canonical copy
  // left to reference later.
  await recordAuditEvent({
    actorId: auth.session.userId,
    actorRole: auth.session.role,
    action: "deleted",
    targetType: "company",
    targetId: parsed.data.id,
    before: {
      name: deletedRow.name,
      sector: deletedRow.sector,
      geography: deletedRow.geography,
      gstNumber: deletedRow.gstNumber,
      panNumber: deletedRow.panNumber,
      isJv: deletedRow.isJv,
      complianceStatus: deletedRow.complianceStatus,
      parentCompanyIds: deletedRow.parentCompanyIds,
      // Day 8: include in the deletion snapshot so forensic queries can
      // see what turnover the company had on record when removed. Cheap
      // and useful - a vanishing turnover figure on a deleted JV partner
      // is exactly the kind of thing an auditor would want to reconstruct.
      annualTurnover: deletedRow.annualTurnover,
      contactEmail: deletedRow.contactEmail,
      contactPhone: deletedRow.contactPhone,
      contactPersonName: deletedRow.contactPersonName,
      addressLine: deletedRow.addressLine,
      city: deletedRow.city,
      state: deletedRow.state,
      pincode: deletedRow.pincode,
      internalNotes: deletedRow.internalNotes,
      createdAt: deletedRow.createdAt,
    },
  });

  log.info("company deleted", {
    id: parsed.data.id,
    actorId: auth.session.userId,
  });
  return { ok: true };
}

// ── transitionComplianceStatus (Day 24) ─────────────────────────────────────

/**
 * Dedicated action for moving a company's compliance status, used by
 * the per-status transition panel on the detail page. Same write path
 * as `updateCompany` for a status-only patch, but with a smaller
 * surface (id + toStatus + optional reason) and a clearer audit
 * payload that always carries `before` / `after` plus the
 * `statusChange` metadata block.
 *
 * Mirrors `transitionProjectStatus` in `lib/projects/actions.ts`.
 *
 * Pipeline:
 *   1. AuthZ — admin/staff only.
 *   2. Validate input via Zod (schema enforces "rejected ⇒ reason").
 *   3. Load existing row.
 *   4. No-op short-circuit if target === current.
 *   5. State-machine assert (throws via `assertTransitionCompliance`;
 *      caught and converted into a typed ActionResult failure).
 *   6. Apply the update — `complianceStatus` always; `rejectionReason`
 *      only on a transition INTO rejected (the reason field on this
 *      schema is dedicated to that case).
 *   7. Audit with the `compliance_status_changed` verb, before/after
 *      snapshots, and `metadata.statusChange + reason`.
 *
 * @returns `{ ok: true }` on success, `{ ok: false, error, field? }`
 *          on RBAC failure / validation failure / illegal transition.
 */
/**
 * In-app notification copy per compliance target status. Only the three
 * user-meaningful outcomes are mapped; a move back to `pending` is internal
 * churn and raises nothing.
 */
const COMPANY_STATUS_NOTIFICATIONS: Record<
  string,
  { type: NotificationType; title: string; body: string }
> = {
  compliant: {
    type: "company_verified",
    title: "Your company has been verified",
    body: "Your company profile is now compliant and active on Consultway.",
  },
  rejected: {
    type: "company_rejected",
    title: "Your company registration was rejected",
    body: "Your company registration was not approved.",
  },
  suspended: {
    type: "company_suspended",
    title: "Your company has been suspended",
    body: "Your company's access has been suspended. Contact Consultway for details.",
  },
};

export async function transitionComplianceStatus(
  rawInput: unknown,
): Promise<ActionResult> {
  // 1. AuthZ
  const auth = await requireAdminOrStaff();
  if (!auth.ok) return auth;

  // 2. Validate
  const parsed = transitionComplianceStatusSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid input",
      field: first?.path.join(".") || undefined,
    };
  }
  const input = parsed.data;

  // 3. Load existing row.
  const existing = await db
    .select()
    .from(companies)
    .where(eq(companies.id, input.id))
    .limit(1)
    .then((rows) => rows[0]);

  if (!existing) {
    return { ok: false, error: "Company not found" };
  }

  // 4. No-op short-circuit. Same convention as `transitionProjectStatus`
  //    — a same-state transition is treated as idempotent success, no
  //    audit row written.
  if (existing.complianceStatus === input.toStatus) {
    return { ok: true };
  }

  // 5. State-machine gate. The schema-layer "rejected ⇒ reason" check
  //    already ran in step 2; here we enforce the legal-transitions
  //    table itself.
  try {
    assertTransitionCompliance(existing.complianceStatus, input.toStatus);
  } catch (err) {
    if (err instanceof ComplianceTransitionError) {
      log.info("transitionComplianceStatus illegal transition", {
        id: input.id,
        actorId: auth.session.userId,
        from: err.from,
        to: err.to,
      });
      return {
        ok: false,
        field: "toStatus",
        error: err.message,
      };
    }
    throw err;
  }

  // 6. Apply. On a transition INTO rejected, populate the
  //    rejectionReason column from the input — that's exactly what the
  //    schema guaranteed is non-empty for this target. For every other
  //    target, leave rejectionReason untouched (a transition OUT of
  //    rejected keeps the historical reason intact for audit context).
  const patch: Partial<typeof companies.$inferInsert> = {
    complianceStatus: input.toStatus,
  };
  if (input.toStatus === "rejected") {
    patch.rejectionReason = input.reason?.trim() ?? null;
  }

  try {
    await db.update(companies).set(patch).where(eq(companies.id, input.id));
  } catch (err) {
    log.error("transitionComplianceStatus failed", {
      err,
      from: existing.complianceStatus,
      to: input.toStatus,
      actorId: auth.session.userId,
    });
    throw err;
  }

  // 7. Audit. Always the `compliance_status_changed` verb on this
  //    action — every successful path is, by definition, a real state
  //    move (the same-state short-circuit returned earlier). The
  //    before/after snapshots carry both compliance_status and the
  //    rejection_reason when relevant.
  const trimmedReason = input.reason?.trim() ?? null;
  await recordAuditEvent({
    actorId: auth.session.userId,
    actorRole: auth.session.role,
    action: "compliance_status_changed",
    targetType: "company",
    targetId: existing.id,
    before: {
      complianceStatus: existing.complianceStatus,
      rejectionReason: existing.rejectionReason,
    },
    after: {
      complianceStatus: input.toStatus,
      // After-snapshot reflects what the row will look like: on a
      // transition INTO rejected the new reason; on any other target
      // the existing reason carries through (we didn't write it).
      rejectionReason:
        input.toStatus === "rejected"
          ? trimmedReason
          : existing.rejectionReason,
    },
    metadata: {
      statusChange: {
        from: existing.complianceStatus,
        to: input.toStatus,
      },
      ...(trimmedReason ? { reason: trimmedReason } : {}),
    },
  });

  log.info("company compliance status transitioned", {
    id: existing.id,
    from: existing.complianceStatus,
    to: input.toStatus,
    actorId: auth.session.userId,
    ...(trimmedReason ? { reason: trimmedReason } : {}),
  });

  // In-app notification to the company's own users. Fail-soft
  // (createNotificationsForUsers never throws); a move back to `pending`
  // maps to nothing. On a rejection, surface the reason as the body.
  const statusNotif = COMPANY_STATUS_NOTIFICATIONS[input.toStatus];
  if (statusNotif) {
    const recipients = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.companyId, existing.id));
    await createNotificationsForUsers(
      recipients.map((r) => r.id),
      {
        type: statusNotif.type,
        title: statusNotif.title,
        body:
          input.toStatus === "rejected" && trimmedReason
            ? trimmedReason
            : statusNotif.body,
        link: `/dashboard/companies/${existing.id}`,
      },
    );
  }

  return { ok: true };
}

// ── getCompany ──────────────────────────────────────────────────────────────

/**
 * Single-row fetch for the detail page. Strips `internalNotes` when the
 * caller is a `company` role user.
 */
export async function getCompany(
  rawId: unknown,
): Promise<ActionResult<{ company: Company }>> {
  const scope = await resolveReadScope();
  if (!scope.ok) return scope;

  const parsed = companyIdSchema.safeParse({ id: rawId });
  if (!parsed.success) {
    return { ok: false, error: "Invalid company id" };
  }

  const row = await db
    .select()
    .from(companies)
    .where(eq(companies.id, parsed.data.id))
    .limit(1)
    .then((rows) => rows[0]);

  if (!row) return { ok: false, error: "Company not found" };

  // Row-level scope: company-role users can only see their own row.
  if (scope.scopeCompanyId && row.id !== scope.scopeCompanyId) {
    return { ok: false, error: "Company not found" };
  }

  // Strip admin-only fields for company-role callers.
  const sanitized = stripAdminOnlyFields(row, scope.session.role);

  return { ok: true, company: sanitized };
}

// ── listCompanies ───────────────────────────────────────────────────────────

/**
 * Result payload type for `listCompanies`. Extracted so the function
 * signature stays readable.
 */
type ListCompaniesPayload = {
  rows: Company[];
  total: number;
  page: number;
  perPage: number;
};

/**
 * Paginated, filtered, sorted list. Admin/staff see all companies;
 * `company` role users see exactly one row (their own).
 *
 * Filters compose with AND. Search is a `LIKE` against `name` only —
 * SQLite has no FTS5 by default and at Phase 1's scale a sequential
 * LIKE is fast enough. We'll revisit if "search GST/PAN/email" lands
 * as a real requirement.
 */
export async function listCompanies(
  rawQuery: unknown,
): Promise<ActionResult<ListCompaniesPayload>> {
  const scope = await resolveReadScope();
  if (!scope.ok) return scope;

  const parsed = listCompaniesQuerySchema.safeParse(rawQuery ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid query",
      field: first?.path.join(".") || undefined,
    };
  }
  const query: ListCompaniesQuery = parsed.data;

  // Build WHERE clauses additively. Each filter is optional — we only
  // push a condition into the array when the caller actually supplied
  // a value. `and(...filters)` returns `undefined` when the array is
  // empty, which Drizzle treats as "no WHERE clause."
  const filters: SQL[] = [];

  // Row-level scope (company role sees own row only) is the strongest
  // filter — pushed first.
  if (scope.scopeCompanyId) {
    filters.push(eq(companies.id, scope.scopeCompanyId));
  }

  if (query.sector) filters.push(eq(companies.sector, query.sector));
  if (query.geography) filters.push(eq(companies.geography, query.geography));
  if (query.complianceStatus)
    filters.push(eq(companies.complianceStatus, query.complianceStatus));
  if (query.isJv !== undefined) filters.push(eq(companies.isJv, query.isJv));
  if (query.isMsme !== undefined)
    filters.push(eq(companies.isMsme, query.isMsme));
  if (query.search) {
    // Wrap in % for substring match. Bound parameter — no injection risk.
    filters.push(like(companies.name, `%${query.search}%`));
  }

  const whereClause = filters.length > 0 ? and(...filters) : undefined;

  // Sort column lookup. We enforce this at the type level via the Zod
  // enum, so an unexpected value can't reach here.
  const sortColumn = {
    name: companies.name,
    sector: companies.sector,
    geography: companies.geography,
    complianceStatus: companies.complianceStatus,
    createdAt: companies.createdAt,
    updatedAt: companies.updatedAt,
  }[query.sortBy];
  const orderBy = query.sortDir === "asc" ? asc(sortColumn) : desc(sortColumn);

  const offset = (query.page - 1) * query.perPage;

  // Two queries: one for the page of rows, one for the total count.
  // Could be one with a window function, but SQLite's COUNT(*) OVER() is
  // a recent addition and we'd rather stay portable. The total-row count
  // is cheap because all the filters are indexed.
  const [rows, totalRow] = await Promise.all([
    db
      .select()
      .from(companies)
      .where(whereClause)
      .orderBy(orderBy)
      .limit(query.perPage)
      .offset(offset),
    db
      .select({ value: count() })
      .from(companies)
      .where(whereClause)
      .then((r) => r[0]),
  ]);

  // Strip admin-only fields for company-role callers.
  const sanitized: Company[] = rows.map((r) =>
    stripAdminOnlyFields(r, scope.session.role),
  );

  return {
    ok: true,
    rows: sanitized,
    total: totalRow?.value ?? 0,
    page: query.page,
    perPage: query.perPage,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a partial snapshot of a company row, restricted to the named
 * keys. Used to produce before/after audit payloads of only the fields
 * that the patch actually touched.
 *
 * Accepts `string[]` (typically `Object.keys(patch)`) for ergonomics
 * at the call site; the cast inside is safe because patch keys are
 * derived from a typed `Partial<Insert>`.
 */
function buildPatchSnapshot(
  row: Company,
  keys: string[],
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) {
    snapshot[key] = (row as unknown as Record<string, unknown>)[key];
  }
  return snapshot;
}

