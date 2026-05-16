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
 * @module lib/companies/actions
 */
"use server";

import { and, asc, count, desc, eq, like, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, type Company } from "@/lib/db/schema";
import { newId } from "@/lib/db/ids";
import { readSession } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import {
  createCompanySchema,
  updateCompanySchema,
  listCompaniesQuerySchema,
  companyIdSchema,
  type CreateCompanyInput,
  type UpdateCompanyInput,
  type ListCompaniesQuery,
} from "./schemas";

const log = logger.child({ module: "companies-actions" });

// ── Result types ────────────────────────────────────────────────────────────

/**
 * Generic action result. Reused across actions so the calling UI can
 * branch on `result.ok` consistently. The `field` hint lets the form
 * highlight a specific input (e.g. focus the GST field on a unique
 * conflict instead of showing a generic banner).
 */
export type ActionResult<T = unknown> =
  | ({ ok: true } & T)
  | { ok: false; error: string; field?: string };

// ── Authorization helpers ───────────────────────────────────────────────────

/**
 * The session shape, unwrapped from `readSession()`'s nullable return.
 * Pulled out so the helpers below can refer to it without re-deriving.
 */
type Session = NonNullable<Awaited<ReturnType<typeof readSession>>>;

/**
 * Result type for the role-gate helpers. The two-shape return lets the
 * caller short-circuit on failure with a single line:
 *   const r = await requireAdminOrStaff();
 *   if (!r.ok) return r;
 */
type AuthCheck =
  | { ok: true; session: Session }
  | { ok: false; error: string };

/**
 * Resolve the current session and confirm the caller is admin or staff.
 * Returns the session on success, or an `ok: false` result that the
 * action returns immediately.
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

/**
 * Admin-only gate. Used for delete.
 */
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
  if (isStaffOrAdmin) {
    if (input.complianceStatus !== undefined)
      patch.complianceStatus = input.complianceStatus;
    if (input.internalNotes !== undefined)
      patch.internalNotes = input.internalNotes;
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

  log.info("company updated", {
    id: input.id,
    actorId: session.userId,
    fields: Object.keys(patch),
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

  const result = await db
    .delete(companies)
    .where(eq(companies.id, parsed.data.id))
    .returning({ id: companies.id });

  if (result.length === 0) {
    return { ok: false, error: "Company not found" };
  }

  log.info("company deleted", {
    id: parsed.data.id,
    actorId: auth.session.userId,
  });
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
  const sanitized: Company =
    scope.session.role === "company" ? { ...row, internalNotes: null } : row;

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

  // Strip internal notes for company-role callers.
  const sanitized: Company[] =
    scope.session.role === "company"
      ? rows.map((r) => ({ ...r, internalNotes: null }))
      : rows;

  return {
    ok: true,
    rows: sanitized,
    total: totalRow?.value ?? 0,
    page: query.page,
    perPage: query.perPage,
  };
}
