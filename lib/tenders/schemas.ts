/**
 * Zod schemas for the tenders module.
 *
 * Lives in a non-"use server" file so both client and server can import
 * these and call `.parse()` / `.safeParse()`. Server Actions in
 * `./actions.ts` re-validate every input with these same schemas — never
 * trust client validation alone.
 *
 * Schemas exported here:
 *   - tenderStatusSchema             — enum mirror of `TenderStatus`
 *   - tenderApplicationStatusSchema  — enum mirror of `TenderApplicationStatus`
 *   - createTenderSchema             — admin/staff create flow
 *   - updateTenderSchema             — patch-style update; field-level
 *                                      gating by current row status
 *                                      happens in the action, not here
 *   - listTendersQuerySchema         — filters, search, pagination, sorting
 *   - tenderIdSchema                 — single-id route param validation
 *   - applyToTenderSchema            — company-role users applying
 *   - updateApplicationStatusSchema  — staff transitioning application status
 *
 * @module lib/tenders/schemas
 */
import { z } from "zod";

// ── Reusable primitive schemas ────────────────────────────────────────────

/** UUID v7 looks just like v4 to a regex — both are 8-4-4-4-12 hex. */
const uuidSchema = z.string().uuid("Invalid identifier");

/**
 * ISO-8601 date string in YYYY-MM-DD form (no time component). We use
 * date-only because the UI treats tender dates as calendar days, not
 * timestamps — "applications close on 2026-06-30" is a date, not
 * "2026-06-30T23:59:59Z" which lands at a different wall-clock time in
 * different zones. The DB column is plain TEXT so format is enforced
 * here.
 */
const isoDateSchema = z
  .string()
  .regex(
    /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/,
    "Enter a valid date (YYYY-MM-DD)",
  );

/**
 * Trim + minimum-2 chars title-ish strings. Same shape used in the
 * companies schemas for `name` — kept locally to avoid a shared
 * cross-module import which would couple the two modules unnecessarily.
 */
const trimmedTitleSchema = z
  .string()
  .trim()
  .min(2, "Must be at least 2 characters")
  .max(200, "Must be 200 characters or fewer");

// ── Status enums (mirror lib/db/schema.ts unions) ─────────────────────────

/**
 * Mirrors the `TenderStatus` union from the DB schema. Kept in sync
 * manually — if a new value is added to the type in lib/db/schema.ts,
 * add it here too. (Same pattern as `complianceStatusSchema` in the
 * companies module.)
 */
export const tenderStatusSchema = z.enum([
  "draft",
  "published",
  "closed",
  "awarded",
]);

/** Mirrors `TenderApplicationStatus`. Same sync rule as above. */
export const tenderApplicationStatusSchema = z.enum([
  "submitted",
  "withdrawn",
  "shortlisted",
  "rejected",
]);

// ── Create tender ─────────────────────────────────────────────────────────

/**
 * Input schema for `createTender`.
 *
 * Design notes:
 *   - `status` is intentionally omitted — every created tender starts
 *     as `draft`. The action sets this server-side.
 *   - `publisherCompanyId` is optional; when missing, the action defaults
 *     it to the Consultway sentinel company (resolved by name at action
 *     time so we don't have to hard-code a UUID in client code).
 *   - `referenceNumber` is optional during early drafts. Unique at the
 *     DB level when present — the action translates unique-conflict
 *     errors into form-friendly field errors.
 *   - `openingDate <= closingDate` cross-validation runs in `superRefine`.
 *   - `minAnnualTurnoverInr` is non-negative when present. NULL = no
 *     minimum.
 *   - `eligibleSector` / `eligibleGeography` are optional. When set on a
 *     draft, they bind once published — the action layer locks them at
 *     publish time per `state-machine.ts::getEditableFieldsForStatus`.
 */
export const createTenderSchema = z
  .object({
    title: trimmedTitleSchema,

    description: z
      .string()
      .trim()
      .min(10, "Provide at least a brief description")
      .max(10000, "Description is too long")
      .optional()
      .nullable(),

    referenceNumber: z
      .string()
      .trim()
      .min(2, "Reference must be at least 2 characters")
      .max(50, "Reference must be 50 characters or fewer")
      .optional()
      .nullable(),

    /**
     * Defaulted to the Consultway sentinel company in the action when
     * omitted. Validated as a UUID when supplied. Existence-check
     * (does this company actually exist?) happens at insert time via
     * the FK constraint — no preflight needed.
     */
    publisherCompanyId: uuidSchema.optional(),

    sector: z
      .string()
      .trim()
      .min(2, "Sector is required")
      .max(100, "Sector must be 100 characters or fewer"),

    geography: z
      .string()
      .trim()
      .min(2, "Geography is required")
      .max(100, "Geography must be 100 characters or fewer"),

    // ── Eligibility filters ────────────────────────────────────────────
    eligibleSector: z
      .string()
      .trim()
      .min(2)
      .max(100)
      .optional()
      .nullable(),

    eligibleGeography: z
      .string()
      .trim()
      .min(2)
      .max(100)
      .optional()
      .nullable(),

    /**
     * Whole INR rupees. We coerce because the form input is a string;
     * `.int()` rejects fractional rupees (a regulator-recommended INR
     * field is whole-rupees-only); `.nonnegative()` rejects negative
     * minimums (which are nonsense).
     */
    minAnnualTurnoverInr: z.coerce
      .number()
      .int("Turnover must be a whole rupee amount")
      .nonnegative("Turnover cannot be negative")
      .max(
        // Cap at ~92 quadrillion — well above any realistic figure, well
        // under SQLite's INTEGER max — defensive belt against typo'd
        // monster numbers landing in the DB.
        Number.MAX_SAFE_INTEGER,
        "Turnover figure is unrealistically large",
      )
      .optional()
      .nullable(),

    msmeOnly: z.boolean().default(false),

    // ── Dates ──────────────────────────────────────────────────────────
    openingDate: isoDateSchema.optional().nullable(),
    closingDate: isoDateSchema.optional().nullable(),

    /** Staff-only field. Even when sent from a `company` role client,
     *  the action drops it. */
    internalNotes: z.string().trim().max(5000).optional().nullable(),
  })
  .superRefine((data, ctx) => {
    // Opening must not be after closing when both present. Equal is
    // allowed — same-day open-and-close is a real (if compressed)
    // scenario for emergency procurements.
    if (data.openingDate && data.closingDate) {
      if (data.openingDate > data.closingDate) {
        ctx.addIssue({
          code: "custom",
          path: ["closingDate"],
          message: "Closing date must be on or after the opening date",
        });
      }
    }
  });

export type CreateTenderInput = z.infer<typeof createTenderSchema>;

// ── Update tender ─────────────────────────────────────────────────────────

/**
 * Input schema for `updateTender`.
 *
 * Built field-by-field rather than via `.partial()` on the create schema
 * because Zod's `.superRefine()` on the base produces an effects schema
 * that doesn't have `.partial()`. Listing fields explicitly here also
 * makes the update surface explicit.
 *
 * Adds `id` (required). Excludes `status` and `publishedAt` — those are
 * transitioned via the dedicated status actions (publishTender etc.),
 * not generic update. Excludes `publisherCompanyId` — the publisher is
 * set on create and never changes (changing it mid-flight would break
 * audit assumptions and the FK constraint anyway).
 *
 * Status-aware field gating (e.g. "only internalNotes editable when
 * closed") is enforced at the action layer using the state-machine
 * helper — this schema accepts any combination of optional fields and
 * leaves the policy decision to the action.
 *
 * The same opening-date/closing-date guard from create applies here,
 * but ONLY when both fields are present in the patch. Cross-checks
 * against the existing row state happen in the action.
 */
export const updateTenderSchema = z
  .object({
    id: uuidSchema,

    title: trimmedTitleSchema.optional(),
    description: z
      .string()
      .trim()
      .min(10)
      .max(10000)
      .optional()
      .nullable(),
    referenceNumber: z
      .string()
      .trim()
      .min(2)
      .max(50)
      .optional()
      .nullable(),
    sector: z.string().trim().min(2).max(100).optional(),
    geography: z.string().trim().min(2).max(100).optional(),
    eligibleSector: z
      .string()
      .trim()
      .min(2)
      .max(100)
      .optional()
      .nullable(),
    eligibleGeography: z
      .string()
      .trim()
      .min(2)
      .max(100)
      .optional()
      .nullable(),
    minAnnualTurnoverInr: z.coerce
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .nullable(),
    msmeOnly: z.boolean().optional(),
    openingDate: isoDateSchema.optional().nullable(),
    closingDate: isoDateSchema.optional().nullable(),
    internalNotes: z.string().trim().max(5000).optional().nullable(),
  })
  .superRefine((data, ctx) => {
    if (data.openingDate && data.closingDate) {
      if (data.openingDate > data.closingDate) {
        ctx.addIssue({
          code: "custom",
          path: ["closingDate"],
          message: "Closing date must be on or after the opening date",
        });
      }
    }
  });

export type UpdateTenderInput = z.infer<typeof updateTenderSchema>;

// ── List query ────────────────────────────────────────────────────────────

/**
 * Sort columns exposed to the UI. Restricted set — lets us index for
 * these and reject unexpected values without trying to parse arbitrary
 * SQL identifiers from user input. Mirrors `companySortColumnSchema`.
 */
export const tenderSortColumnSchema = z.enum([
  "title",
  "status",
  "sector",
  "geography",
  "closingDate",
  "createdAt",
  "publishedAt",
]);

/**
 * Query schema for `listTenders`.
 *
 * Coerces strings to numbers for page/perPage because URL search params
 * arrive as strings, and we want this schema to work as a `searchParams`
 * parser in the App Router. `default()` runs after coercion, so a missing
 * param yields `1` / `20`, not `NaN`. Caps `perPage` at 100 — paginating
 * beyond that is almost always a bug.
 *
 * Closing-date range filter accepts `closingDateFrom` and `closingDateTo`
 * as ISO date strings. Both inclusive. NULLs in DB rows are excluded by
 * the comparison — that's correct (open-ended tenders shouldn't surface
 * when filtering for a date range).
 */
export const listTendersQuerySchema = z.object({
  // Filters — all optional, AND-composed in the query.
  status: tenderStatusSchema.optional(),
  sector: z.string().trim().min(1).optional(),
  geography: z.string().trim().min(1).optional(),
  msmeOnly: z.coerce.boolean().optional(),
  publisherCompanyId: uuidSchema.optional(),

  closingDateFrom: isoDateSchema.optional(),
  closingDateTo: isoDateSchema.optional(),

  /** Free-text search. Matches against `title` only via LIKE. */
  search: z.string().trim().min(1).max(200).optional(),

  // Pagination.
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),

  // Sorting. Default is most recently created first — same as companies.
  sortBy: tenderSortColumnSchema.default("createdAt"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
});

export type ListTendersQuery = z.infer<typeof listTendersQuerySchema>;

// ── ID param ──────────────────────────────────────────────────────────────

/**
 * Single-id schema for routes like `/dashboard/tenders/[id]`.
 * Tiny but reused everywhere — better than re-inlining the uuid regex.
 */
export const tenderIdSchema = z.object({ id: uuidSchema });

// ── Apply to tender ───────────────────────────────────────────────────────

/**
 * Input schema for `applyToTender`. Company-role users apply on their
 * own behalf — the action reads `companyId` from the session, NOT from
 * client input, so it's omitted here. (Trusting client-supplied
 * companyId would let any user apply as any company.)
 *
 * `coverNote` is optional — many tenders won't require one, but when
 * provided we cap at 5000 chars so a runaway paste doesn't bloat the
 * row.
 */
export const applyToTenderSchema = z.object({
  tenderId: uuidSchema,
  coverNote: z
    .string()
    .trim()
    .min(1, "Cover note cannot be empty if provided")
    .max(5000, "Cover note must be 5000 characters or fewer")
    .optional()
    .nullable(),
});

export type ApplyToTenderInput = z.infer<typeof applyToTenderSchema>;

// ── Update application status (staff) ─────────────────────────────────────

/**
 * Input schema for `updateApplicationStatus` — admin/staff transitioning
 * a `submitted` application to `shortlisted` or `rejected`. Excludes
 * `submitted` and `withdrawn` from the allowed target statuses because:
 *   - `submitted` is the initial state; setting it again is meaningless.
 *   - `withdrawn` is company-driven; staff can't withdraw on a company's
 *     behalf. The separate `withdrawApplication` action is the only
 *     legal path to `withdrawn`.
 */
export const updateApplicationStatusSchema = z.object({
  applicationId: uuidSchema,
  status: z.enum(["shortlisted", "rejected"]),
  /** Optional staff note recorded against this application. */
  internalNotes: z.string().trim().max(5000).optional().nullable(),
});

export type UpdateApplicationStatusInput = z.infer<
  typeof updateApplicationStatusSchema
>;

// ── Withdraw application (company on own application) ─────────────────────

/**
 * Input schema for `withdrawApplication`. Company-role users can
 * withdraw their own applications while the application is still
 * `submitted` — the action enforces both ownership and current status.
 *
 * Schema only needs the application id; the rest is derived from session.
 */
export const withdrawApplicationSchema = z.object({
  applicationId: uuidSchema,
});

export type WithdrawApplicationInput = z.infer<typeof withdrawApplicationSchema>;
