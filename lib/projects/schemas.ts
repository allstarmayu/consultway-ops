/**
 * Zod schemas for the projects module.
 *
 * Same conventions as `lib/companies/schemas.ts` and
 * `lib/tenders/schemas.ts` — schemas live in a non-"use server" file
 * so both client and server code can import and validate against them.
 * Server Actions in `./actions.ts` re-validate every input — never
 * trust client validation alone.
 *
 * Schemas exported here:
 *   - projectStatusSchema           — enum mirror of `ProjectStatus`
 *   - createProjectSchema           — admin/staff create flow
 *   - updateProjectSchema           — patch-style update (RBAC-gated
 *                                     field set is enforced in the action,
 *                                     not the schema)
 *   - createProjectFromTenderSchema — admin/staff "promote awarded tender"
 *   - transitionProjectStatusSchema — admin/staff status transition
 *   - listProjectsQuerySchema       — filters, search, pagination, sorting
 *   - projectIdSchema               — single-id route param validation
 *
 * @module lib/projects/schemas
 */
import { z } from "zod";

// ── Reusable primitive schemas ────────────────────────────────────────────

/** UUID v7 looks just like v4 to a regex — both are 8-4-4-4-12 hex. */
const uuidSchema = z.string().uuid("Invalid identifier");

/**
 * ISO-8601 date string (YYYY-MM-DD). Same shape as
 * `tenders.schemas.ts::isoDateSchema` — duplicated rather than shared
 * to keep the projects module a leaf without a sideways import.
 */
const isoDateSchema = z
  .string()
  .regex(
    /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/,
    "Enter a valid date (YYYY-MM-DD)",
  );

/** Trim + minimum-2 chars title-ish strings. Same shape as the tenders module. */
const trimmedNameSchema = z
  .string()
  .trim()
  .min(2, "Must be at least 2 characters")
  .max(200, "Must be 200 characters or fewer");

/**
 * Budget in INR — whole rupees only. Mirrors
 * `tenders.minAnnualTurnoverInr` schema field for consistency:
 *
 *   - `z.coerce.number()` — form inputs arrive as strings
 *   - `.int()` — whole rupees; fractional rupees are paise, a
 *     separate unit
 *   - `.nonnegative()` — zero budget is legal (informational projects);
 *     negative is nonsense
 *   - `.max(MAX_SAFE_INTEGER)` — typo guard
 *   - `.optional().nullable()` — both absent and explicit null accepted
 */
const budgetInrSchema = z.coerce
  .number()
  .int("Budget must be a whole rupee amount")
  .nonnegative("Budget cannot be negative")
  .max(Number.MAX_SAFE_INTEGER, "Budget figure is unrealistically large")
  .optional()
  .nullable();

// ── Status enum (mirrors lib/db/schema.ts ProjectStatus) ──────────────────

/**
 * Mirrors the `ProjectStatus` union from the DB schema. Kept in sync
 * manually — if a new value is added to the type in lib/db/schema.ts,
 * add it here too. (Same pattern as `tenderStatusSchema`.)
 */
export const projectStatusSchema = z.enum([
  "planning",
  "active",
  "on_hold",
  "completed",
  "cancelled",
]);

// ── Create project ────────────────────────────────────────────────────────

/**
 * Input schema for `createProject`.
 *
 * Design notes:
 *   - `status` is intentionally omitted — every created project starts
 *     as `planning`. The action sets this server-side.
 *   - `companyId` is required. The action also validates that the id
 *     points to a real company row.
 *   - `tenderId` is optional — only set when the project was promoted
 *     from a tender via `createProjectFromTender`.
 *   - `startDate <= endDate` cross-validation runs in `superRefine`.
 *   - `internalNotes` is staff-only at the action layer. Accepted in
 *     the schema for ergonomics on the staff create form; the action
 *     drops it for non-staff callers (defence in depth — the create
 *     surface is staff-only to begin with).
 */
export const createProjectSchema = z
  .object({
    companyId: uuidSchema,

    name: trimmedNameSchema,

    description: z
      .string()
      .trim()
      .min(1, "Description cannot be empty if provided")
      .max(10000, "Description is too long")
      .optional()
      .nullable(),

    /**
     * Optional link back to the originating tender. Populated by
     * `createProjectFromTender`; usually NULL for direct creates.
     */
    tenderId: uuidSchema.optional().nullable(),

    startDate: isoDateSchema.optional().nullable(),
    endDate: isoDateSchema.optional().nullable(),

    budgetInr: budgetInrSchema,

    /** Staff-only field. The action drops it for non-staff callers. */
    internalNotes: z.string().trim().max(5000).optional().nullable(),
  })
  .superRefine((data, ctx) => {
    if (data.startDate && data.endDate) {
      if (data.startDate > data.endDate) {
        ctx.addIssue({
          code: "custom",
          path: ["endDate"],
          message: "End date must be on or after the start date",
        });
      }
    }
  });

export type CreateProjectInput = z.infer<typeof createProjectSchema>;

// ── Update project ────────────────────────────────────────────────────────

/**
 * Input schema for `updateProject`.
 *
 * Built field-by-field (same pattern as `updateCompanySchema` and
 * `updateTenderSchema`) rather than via `.partial()` because the
 * `superRefine` on the create schema produces an effects schema
 * without `.partial()`.
 *
 * Excludes `companyId` (the owning company is set on create and never
 * changes — changing it mid-flight would break the audit trail).
 * Excludes `tenderId` (set once at create time by
 * `createProjectFromTender`; nullable thereafter only via the
 * tender-delete cascade).
 * Excludes `status` — status transitions go through the dedicated
 * `transitionProjectStatus` action (Chunk 3).
 *
 * Field-level role gating happens at the action layer:
 *   - admin / staff — every field below is patchable
 *   - company role  — only `description` is patchable (everything else
 *                     is staff-managed)
 *
 * Cross-field date-ordering check runs against the patch alone here;
 * the action layer additionally checks against the merged row state
 * (same pattern as `updateTender`).
 */
export const updateProjectSchema = z
  .object({
    id: uuidSchema,

    name: trimmedNameSchema.optional(),

    description: z
      .string()
      .trim()
      .min(1)
      .max(10000)
      .optional()
      .nullable(),

    startDate: isoDateSchema.optional().nullable(),
    endDate: isoDateSchema.optional().nullable(),

    budgetInr: budgetInrSchema,

    internalNotes: z.string().trim().max(5000).optional().nullable(),
  })
  .superRefine((data, ctx) => {
    if (data.startDate && data.endDate) {
      if (data.startDate > data.endDate) {
        ctx.addIssue({
          code: "custom",
          path: ["endDate"],
          message: "End date must be on or after the start date",
        });
      }
    }
  });

export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

// ── Create project from tender ────────────────────────────────────────────

/**
 * Input schema for `createProjectFromTender` — admin/staff promote an
 * awarded tender into a project. The action enforces beyond what this
 * schema can:
 *
 *   - tender must be in `awarded` status
 *   - tender must have a non-null `awardedCompanyId` (this is the
 *     defensive half — `markAwarded` already requires a winner, but
 *     the bridge action double-checks the column rather than trusting
 *     the status flip alone)
 *
 * Composed name / description / companyId come from the tender row,
 * not from the caller — keeps the bridge unambiguous.
 */
export const createProjectFromTenderSchema = z.object({
  tenderId: uuidSchema,
});

export type CreateProjectFromTenderInput = z.infer<
  typeof createProjectFromTenderSchema
>;

// ── Transition project status (Chunk 3) ───────────────────────────────────

/**
 * Input schema for `transitionProjectStatus` — admin/staff move a
 * project between lifecycle states. The action enforces legal
 * transitions via the projects state machine (Chunk 3).
 *
 * `reason` is optional. Most transitions are operational events; when
 * staff want to record context (especially for cancellation) they can.
 * Captured under `metadata.reason` on the audit row.
 */
export const transitionProjectStatusSchema = z.object({
  projectId: uuidSchema,
  toStatus: projectStatusSchema,
  reason: z
    .string()
    .trim()
    .min(1, "Reason cannot be empty if provided")
    .max(500, "Reason must be 500 characters or fewer")
    .optional()
    .nullable(),
});

export type TransitionProjectStatusInput = z.infer<
  typeof transitionProjectStatusSchema
>;

// ── List query ────────────────────────────────────────────────────────────

/**
 * Sort columns exposed to the UI. Restricted set — same convention
 * as the tenders module.
 */
export const projectSortColumnSchema = z.enum([
  "name",
  "status",
  "startDate",
  "endDate",
  "createdAt",
  "updatedAt",
]);

/**
 * Query schema for `listProjects`.
 *
 * Coerces strings to numbers for page/perPage because URL search
 * params arrive as strings. Caps `perPage` at 100 to bound query cost.
 *
 * `companyId` is admin/staff-only at the action layer — silently
 * dropped from company-role queries (a company-role user is already
 * scoped to their own projects). Accepted in the schema for clean URL
 * sharing across roles.
 */
export const listProjectsQuerySchema = z.object({
  // Filters — all optional, AND-composed in the query.
  companyId: uuidSchema.optional(),
  status: projectStatusSchema.optional(),

  /** Free-text search. Matches against `name` only via LIKE. */
  search: z.string().trim().min(1).max(200).optional(),

  // Pagination.
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),

  // Sorting. Default is most recently created first — same as tenders.
  sortBy: projectSortColumnSchema.default("createdAt"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
});

export type ListProjectsQuery = z.infer<typeof listProjectsQuerySchema>;

// ── List query (export variant) ───────────────────────────────────────────

/**
 * Export-only sibling of `listProjectsQuerySchema`. The CSV exporter
 * passes `perPage=1000` (the hard cap defined on the route handler), but
 * the standard list schema caps `perPage` at 100 to bound query cost on
 * the dashboard table. Widening the cap here keeps the export route
 * working while preserving the list page's 100 ceiling.
 *
 * Same filters, same sort, same defaults — only the `perPage` ceiling
 * changes.
 */
export const listProjectsForExportQuerySchema = listProjectsQuerySchema.extend({
  perPage: z.coerce.number().int().min(1).max(1000).default(20),
});

export type ListProjectsForExportQuery = z.infer<
  typeof listProjectsForExportQuerySchema
>;

// ── ID param ──────────────────────────────────────────────────────────────

/**
 * Single-id schema for routes like `/dashboard/projects/[id]`.
 */
export const projectIdSchema = z.object({ id: uuidSchema });
