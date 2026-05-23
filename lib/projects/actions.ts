/**
 * Projects module — Server Actions.
 *
 * Every mutation (create / update / status transition) and every read
 * used by the dashboard goes through one of these. They're the **only**
 * place where the database is touched directly for project rows — UI
 * calls these, never raw SQL.
 *
 * Return shape (same as the rest of the codebase):
 *     { ok: true, ...data }
 *   | { ok: false, error: string, field?: string }
 *
 * Role rules (also documented in docs/08-rbac-matrix.md):
 *
 *   Action                       admin   staff   company
 *   createProject                Y       Y       N
 *   createProjectFromTender      Y       Y       N
 *   updateProject                Y       Y       Y (description only)
 *   transitionProjectStatus      Y       Y       N    (Chunk 3)
 *   getProject                   Y       Y       Y (own projects only)
 *   listProjects                 Y       Y       Y (own projects only)
 *
 * **Project deletion is intentionally not implemented in this session.**
 * The schema's `tenderId → SET NULL` and `companyId → RESTRICT` cascade
 * rules cover the implicit cases; an explicit delete action lands in a
 * later session with its own confirm flow.
 *
 * Audit logging: every mutation calls `recordAuditEvent` after the DB
 * write succeeds. Read actions are NOT audited (same convention as
 * companies / tenders).
 *
 * `internalNotes` is stripped on company-role reads, same convention
 * as the companies and tenders modules.
 *
 * @module lib/projects/actions
 */
"use server";

import { and, asc, count, desc, eq, like, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  companies,
  projects,
  tenders,
  type Project,
} from "@/lib/db/schema";
import { newId } from "@/lib/db/ids";
import { readSession } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import { recordAuditEvent } from "@/lib/audit/log";
import type { ActionResult } from "@/lib/types/action-result";
import {
  createProjectSchema,
  updateProjectSchema,
  createProjectFromTenderSchema,
  listProjectsQuerySchema,
  projectIdSchema,
  type CreateProjectInput,
  type UpdateProjectInput,
  type ListProjectsQuery,
} from "./schemas";

const log = logger.child({ module: "projects-actions" });

// ── Authorization helpers ───────────────────────────────────────────────────

/**
 * The session shape, unwrapped from `readSession()`'s nullable return.
 * Same alias as the tenders module.
 */
type Session = NonNullable<Awaited<ReturnType<typeof readSession>>>;

type AuthCheck =
  | { ok: true; session: Session }
  | { ok: false; error: string };

/**
 * Resolve the current session and confirm the caller is admin or staff.
 * Used by createProject, createProjectFromTender, and (in Chunk 3)
 * transitionProjectStatus.
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
 * Read-and-scope helper for project reads. Mirrors the companies module:
 *   - admin / staff → see every project (`scopeCompanyId: null`)
 *   - company       → see own projects only (`scopeCompanyId: <ownId>`)
 *
 * Projects don't have a public/draft distinction the way tenders do, so
 * the company-role rule is a single companyId equality (no `or` clause).
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

// ── Helper: snapshot builder ────────────────────────────────────────────────

/**
 * Build a partial snapshot of a project row, restricted to the named
 * keys. Used to produce before/after audit payloads of only the fields
 * that the patch actually touched. Same shape as the companies /
 * tenders modules.
 */
function buildPatchSnapshot(
  row: Project,
  keys: string[],
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) {
    snapshot[key] = (row as unknown as Record<string, unknown>)[key];
  }
  return snapshot;
}

// ── createProject ───────────────────────────────────────────────────────────

/**
 * Create a new project. Admin/staff only. The created row starts with
 * `status: "planning"` regardless of caller input — status is something
 * the team transitions, not something the creator declares.
 *
 * Pipeline:
 *   1. AuthZ (admin/staff)
 *   2. Schema validation (Zod)
 *   3. Soft existence check on `companyId` so the error is friendly
 *      ("company not found") rather than an opaque FK violation
 *   4. Insert with status forced to `planning`
 *   5. Audit `created` event on `targetType: "project"`
 */
export async function createProject(
  rawInput: unknown,
): Promise<ActionResult<{ id: string }>> {
  // 1. AuthZ
  const auth = await requireAdminOrStaff();
  if (!auth.ok) return auth;

  // 2. Validate
  const parsed = createProjectSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid input",
      field: first?.path.join(".") || undefined,
    };
  }
  const input: CreateProjectInput = parsed.data;

  // 3. Soft existence check on companyId. The FK will catch it too,
  //    but a friendly "Company not found" beats a raw FK error string.
  const companyRow = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .limit(1)
    .then((rows) => rows[0]);

  if (!companyRow) {
    return {
      ok: false,
      field: "companyId",
      error: "Company not found",
    };
  }

  // 4. Insert
  const id = newId();
  try {
    await db.insert(projects).values({
      id,
      name: input.name,
      description: input.description ?? null,
      tenderId: input.tenderId ?? null,
      companyId: input.companyId,
      // Force planning — never trust create-side status.
      status: "planning",
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      budgetInr: input.budgetInr ?? null,
      internalNotes: input.internalNotes ?? null,
    });
  } catch (err) {
    log.error("createProject failed", { err, actorId: auth.session.userId });
    throw err;
  }

  // 5. Audit. Captures identity-ish fields plus the tender link when
  //    present — forensic queries can answer "which projects came from
  //    tenders?" via metadata.fromTenderId on `createProjectFromTender`,
  //    and via this `after.tenderId` for direct creates with a manual
  //    tender link.
  await recordAuditEvent({
    actorId: auth.session.userId,
    actorRole: auth.session.role,
    action: "created",
    targetType: "project",
    targetId: id,
    after: {
      name: input.name,
      status: "planning",
      companyId: input.companyId,
      tenderId: input.tenderId ?? null,
    },
  });

  log.info("project created", {
    id,
    name: input.name,
    companyId: input.companyId,
    actorId: auth.session.userId,
  });
  return { ok: true, id };
}

// ── createProjectFromTender ─────────────────────────────────────────────────

/**
 * Promote an awarded tender into a brand-new project. Admin/staff
 * only. Composes the create call from the tender row's fields:
 *
 *   - name        = tender.title
 *   - description = tender.description
 *   - companyId   = tender.awardedCompanyId
 *   - tenderId    = tender.id
 *
 * Gates (in order):
 *   1. AuthZ (admin/staff)
 *   2. Schema (tenderId well-formed)
 *   3. Tender exists
 *   4. Tender status is `awarded`
 *   5. Tender's `awardedCompanyId` is non-null (defensive — `markAwarded`
 *      already requires a winner, but this is the bridge's last check
 *      before writing a project tied to NULL)
 *
 * Audit captures `metadata.fromTenderId` so the bridge is queryable —
 * "show me every project that came from a tender" is one filter on the
 * audit log.
 *
 * Returns the new project id on success. The caller (usually the
 * tender detail page's "Create project from this tender" button)
 * redirects to `/dashboard/projects/<projectId>`.
 */
export async function createProjectFromTender(
  rawInput: unknown,
): Promise<ActionResult<{ projectId: string }>> {
  // 1. AuthZ
  const auth = await requireAdminOrStaff();
  if (!auth.ok) return auth;

  // 2. Validate
  const parsed = createProjectFromTenderSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid input",
      field: first?.path.join(".") || undefined,
    };
  }
  const { tenderId } = parsed.data;

  // 3. Load the tender — need title, description, status, and
  //    awardedCompanyId.
  const tender = await db
    .select({
      id: tenders.id,
      title: tenders.title,
      description: tenders.description,
      status: tenders.status,
      awardedCompanyId: tenders.awardedCompanyId,
    })
    .from(tenders)
    .where(eq(tenders.id, tenderId))
    .limit(1)
    .then((rows) => rows[0]);

  if (!tender) {
    return { ok: false, error: "Tender not found" };
  }

  // 4. Status gate.
  if (tender.status !== "awarded") {
    return {
      ok: false,
      error: `Cannot create project — tender is ${tender.status}, not awarded`,
    };
  }

  // 5. Defensive: awarded tenders must have a winner. `markAwarded`
  //    requires this since Day 14, but the bridge double-checks rather
  //    than trusting the status flip alone — a hand-edit could leave a
  //    tender awarded with NULL awardedCompanyId, and we'd rather
  //    surface a clear error than write a project with no owner.
  if (!tender.awardedCompanyId) {
    log.error("createProjectFromTender: awarded tender has no awardedCompanyId", {
      tenderId: tender.id,
      actorId: auth.session.userId,
    });
    return {
      ok: false,
      error: "Cannot create project — tender has no awarded company recorded",
    };
  }

  // 6. Insert the project row directly (rather than calling createProject
  //    in a sub-action) so we can write a single audit event with the
  //    `metadata.fromTenderId` discriminator. Composing the create call
  //    would produce a plain `created` audit event indistinguishable
  //    from a direct create.
  const projectId = newId();
  try {
    await db.insert(projects).values({
      id: projectId,
      name: tender.title,
      description: tender.description ?? null,
      tenderId: tender.id,
      companyId: tender.awardedCompanyId,
      status: "planning",
      startDate: null,
      endDate: null,
      budgetInr: null,
      internalNotes: null,
    });
  } catch (err) {
    log.error("createProjectFromTender failed", {
      err,
      tenderId: tender.id,
      actorId: auth.session.userId,
    });
    throw err;
  }

  // 7. Audit. Same `created` verb as direct creates, but
  //    `metadata.fromTenderId` makes the bridge queryable.
  await recordAuditEvent({
    actorId: auth.session.userId,
    actorRole: auth.session.role,
    action: "created",
    targetType: "project",
    targetId: projectId,
    after: {
      name: tender.title,
      status: "planning",
      companyId: tender.awardedCompanyId,
      tenderId: tender.id,
    },
    metadata: {
      fromTenderId: tender.id,
    },
  });

  log.info("project created from tender", {
    projectId,
    tenderId: tender.id,
    companyId: tender.awardedCompanyId,
    actorId: auth.session.userId,
  });
  return { ok: true, projectId };
}

// ── updateProject ───────────────────────────────────────────────────────────

/**
 * Partial update. Two paths depending on caller role:
 *
 *   - admin / staff — patch any field except `id`, `companyId`,
 *                     `tenderId`, and `status` (status is owned by
 *                     `transitionProjectStatus` — Chunk 3).
 *
 *   - company role  — patch own project's `description` only. All
 *                     other fields are staff-managed; sending them is
 *                     silently dropped (defence in depth — the UI
 *                     shouldn't offer them, but we enforce here too).
 *                     `internalNotes` is staff-only; company-role
 *                     callers never see it on read either.
 *
 * Cross-field check on dates runs against the merged (current+patch)
 * row state — the Zod schema only sees the patch in isolation.
 */
export async function updateProject(
  rawInput: unknown,
): Promise<ActionResult> {
  // 1. AuthZ — any signed-in user; row-level + field-level checks below.
  const session = await readSession();
  if (!session) return { ok: false, error: "You must be signed in" };

  // 2. Validate
  const parsed = updateProjectSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid input",
      field: first?.path.join(".") || undefined,
    };
  }
  const input: UpdateProjectInput = parsed.data;

  // 3. Load existing row
  const existing = await db
    .select()
    .from(projects)
    .where(eq(projects.id, input.id))
    .limit(1)
    .then((rows) => rows[0]);

  if (!existing) {
    return { ok: false, error: "Project not found" };
  }

  // 4. Row-level + field-level access check.
  const isStaffOrAdmin = session.role === "admin" || session.role === "staff";
  const isOwnProject =
    session.role === "company" && session.companyId === existing.companyId;

  if (!isStaffOrAdmin && !isOwnProject) {
    log.warn("updateProject forbidden", {
      userId: session.userId,
      role: session.role,
      attemptedId: input.id,
    });
    // Don't leak the existence of a project the caller can't see.
    return { ok: false, error: "Project not found" };
  }

  // 5. Build the patch object. For company-role callers, drop everything
  //    except `description` — they're authoritative on the work-summary
  //    field but everything else is Consultway-managed.
  const patch: Partial<typeof projects.$inferInsert> = {};

  if (isStaffOrAdmin) {
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;
    if (input.startDate !== undefined) patch.startDate = input.startDate;
    if (input.endDate !== undefined) patch.endDate = input.endDate;
    if (input.budgetInr !== undefined) patch.budgetInr = input.budgetInr;
    if (input.internalNotes !== undefined) {
      patch.internalNotes = input.internalNotes;
    }
  } else {
    // Company role — only description is editable. Everything else
    // silently dropped, even if the client sent it. Don't log noisily;
    // the UI shouldn't be offering those fields, so reaching this branch
    // either means a deliberate hand-rolled call or a UI bug worth
    // surfacing via the normal logger.
    if (input.description !== undefined) {
      patch.description = input.description;
    }
    const droppedFields = (
      [
        "name",
        "startDate",
        "endDate",
        "budgetInr",
        "internalNotes",
      ] as const
    ).filter((f) => input[f] !== undefined);
    if (droppedFields.length > 0) {
      log.warn("updateProject dropped staff-only fields from company-role patch", {
        userId: session.userId,
        projectId: input.id,
        dropped: droppedFields,
      });
    }
  }

  // 6. Cross-field check against the merged row state.
  const mergedStart = patch.startDate ?? existing.startDate;
  const mergedEnd = patch.endDate ?? existing.endDate;
  if (mergedStart && mergedEnd && mergedStart > mergedEnd) {
    return {
      ok: false,
      field: "endDate",
      error: "End date must be on or after the start date",
    };
  }

  // 7. No-op short-circuit. Treat as idempotent success.
  if (Object.keys(patch).length === 0) {
    return { ok: true };
  }

  // 8. Apply
  try {
    await db.update(projects).set(patch).where(eq(projects.id, input.id));
  } catch (err) {
    log.error("updateProject failed", { err, actorId: session.userId });
    throw err;
  }

  // 9. Audit. Before/after of only the fields the patch touched.
  const touchedKeys = Object.keys(patch);
  const beforeSnapshot = buildPatchSnapshot(existing, touchedKeys);
  const afterSnapshot = buildPatchSnapshot(
    { ...existing, ...patch } as Project,
    touchedKeys,
  );
  await recordAuditEvent({
    actorId: session.userId,
    actorRole: session.role,
    action: "updated",
    targetType: "project",
    targetId: input.id,
    before: beforeSnapshot,
    after: afterSnapshot,
  });

  log.info("project updated", {
    id: input.id,
    actorId: session.userId,
    fields: touchedKeys,
  });
  return { ok: true };
}

// ── listProjects ────────────────────────────────────────────────────────────

/**
 * Result payload type for `listProjects`. Extracted so the function
 * signature stays readable.
 */
type ListProjectsPayload = {
  rows: Project[];
  total: number;
  page: number;
  perPage: number;
};

/**
 * Paginated, filtered, sorted list of projects.
 *
 * Visibility (encoded in SQL, no JS post-filter):
 *   - admin / staff → every project
 *   - company       → own projects only (companyId = scope)
 *
 * Filters compose with AND. `companyId` is silently dropped from
 * company-role queries (a company-role user is already scoped to their
 * own projects). Search is a `LIKE` against `name` only.
 *
 * `internalNotes` is stripped on company-role reads.
 */
export async function listProjects(
  rawQuery: unknown,
): Promise<ActionResult<ListProjectsPayload>> {
  const scope = await resolveReadScope();
  if (!scope.ok) return scope;

  const parsed = listProjectsQuerySchema.safeParse(rawQuery ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid query",
      field: first?.path.join(".") || undefined,
    };
  }
  const query: ListProjectsQuery = parsed.data;

  const filters: SQL[] = [];

  // Row-level scope. Encoded directly as a WHERE clause so the count
  // reflects the scoped set without a JS-side adjustment — same lesson
  // the Day-14 tenders refactor pinned.
  if (scope.scopeCompanyId) {
    filters.push(eq(projects.companyId, scope.scopeCompanyId));
  } else if (query.companyId) {
    // Admin/staff can additionally narrow to a specific company.
    // Company-role callers can't — their `companyId` filter is
    // silently dropped (the scope filter above already enforces it).
    filters.push(eq(projects.companyId, query.companyId));
  }

  if (query.status) {
    filters.push(eq(projects.status, query.status));
  }

  if (query.search) {
    filters.push(like(projects.name, `%${query.search}%`));
  }

  const whereClause = filters.length > 0 ? and(...filters) : undefined;

  const sortColumn = {
    name: projects.name,
    status: projects.status,
    startDate: projects.startDate,
    endDate: projects.endDate,
    createdAt: projects.createdAt,
    updatedAt: projects.updatedAt,
  }[query.sortBy];
  const orderBy = query.sortDir === "asc" ? asc(sortColumn) : desc(sortColumn);

  const offset = (query.page - 1) * query.perPage;

  const [rows, totalRow] = await Promise.all([
    db
      .select()
      .from(projects)
      .where(whereClause)
      .orderBy(orderBy)
      .limit(query.perPage)
      .offset(offset),
    db
      .select({ value: count() })
      .from(projects)
      .where(whereClause)
      .then((r) => r[0]),
  ]);

  const total = totalRow?.value ?? 0;

  // Strip internal notes for company-role callers.
  const sanitized: Project[] =
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

// ── getProject ──────────────────────────────────────────────────────────────

/**
 * Single-row fetch for the detail page. Returns "not found" for
 * out-of-scope reads — don't leak the existence of someone else's
 * project to a company-role caller.
 *
 * Strips `internalNotes` on company-role reads.
 */
export async function getProject(
  rawId: unknown,
): Promise<ActionResult<{ project: Project }>> {
  const scope = await resolveReadScope();
  if (!scope.ok) return scope;

  const parsed = projectIdSchema.safeParse({ id: rawId });
  if (!parsed.success) {
    return { ok: false, error: "Invalid project id" };
  }

  const row = await db
    .select()
    .from(projects)
    .where(eq(projects.id, parsed.data.id))
    .limit(1)
    .then((rows) => rows[0]);

  if (!row) return { ok: false, error: "Project not found" };

  // Row-level scope: company-role users can only see their own projects.
  if (scope.scopeCompanyId && row.companyId !== scope.scopeCompanyId) {
    return { ok: false, error: "Project not found" };
  }

  // Strip admin-only fields for company-role callers.
  const sanitized: Project =
    scope.session.role === "company" ? { ...row, internalNotes: null } : row;

  return { ok: true, project: sanitized };
}
