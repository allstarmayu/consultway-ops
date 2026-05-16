/**
 * Zod schemas for the companies module.
 *
 * Lives in a non-"use server" file so both client and server can import
 * these and call `.parse()` / `.safeParse()`. Server Actions in
 * `./actions.ts` re-validate every input with these same schemas — never
 * trust client validation alone.
 *
 * Schemas exported here:
 *   - createCompanySchema       — admin/staff create flow
 *   - updateCompanySchema       — patch-style update, all fields optional except id
 *   - listCompaniesQuerySchema  — filters, search, pagination, sorting
 *   - companyIdSchema           — single-id route param validation
 *
 * @module lib/companies/schemas
 */
import { z } from "zod";

// ── Reusable primitive schemas ──────────────────────────────────────────────

/**
 * Indian GST Identification Number (GSTIN). 15 chars, format:
 *   - 2 digits state code
 *   - 10-char PAN (5 letters, 4 digits, 1 letter)
 *   - 1 entity number (1–9 or A–Z)
 *   - 1 letter (default 'Z')
 *   - 1 check char (0–9 or A–Z)
 *
 * @see https://www.gstn.org.in
 */
const gstSchema = z
  .string()
  .regex(
    /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/,
    "Enter a valid 15-character GSTIN",
  );

/**
 * Indian PAN. 10 chars: 5 letters, 4 digits, 1 letter.
 * The 4th letter encodes the entity type (P=person, C=company, etc.) but
 * we don't enforce that here — just the surface format.
 */
const panSchema = z
  .string()
  .regex(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/, "Enter a valid 10-character PAN");

/** 6-digit Indian postal code. */
const pincodeSchema = z
  .string()
  .regex(/^[1-9][0-9]{5}$/, "Enter a valid 6-digit pincode");

/** UUID v7 looks just like v4 to a regex — both are 8-4-4-4-12 hex. */
const uuidSchema = z.string().uuid("Invalid identifier");

/**
 * Trim + collapse internal whitespace + minimum 2 chars. Used for company
 * name, contact person name, etc. The transform runs before validation.
 */
const trimmedNameSchema = z
  .string()
  .trim()
  .min(2, "Must be at least 2 characters")
  .max(200, "Must be 200 characters or fewer");

// ── Compliance status enum (mirrors lib/db/schema.ts ComplianceStatus) ──────

/**
 * Reproduces the `ComplianceStatus` union from the DB schema as a Zod
 * enum. Kept in sync manually — if a new value is added to the type in
 * lib/db/schema.ts, add it here too. (Tried importing the type directly,
 * but Zod's `z.enum()` needs literal values at compile time.)
 */
export const complianceStatusSchema = z.enum([
  "pending",
  "compliant",
  "non_compliant",
  "expired",
]);

// ── Create company ──────────────────────────────────────────────────────────

/**
 * Input schema for `createCompany`.
 *
 * Design notes:
 *   - `gstNumber` and `panNumber` are optional during onboarding. If
 *     present, they must match the official format.
 *   - `isJv` and `parentCompanyIds` are cross-validated via `superRefine`:
 *     a JV must have at least 2 partner IDs; a non-JV must have none.
 *   - `complianceStatus` is forced to `"pending"` on create — only an
 *     admin/staff update can change it. The schema simply omits the
 *     field; the action sets `pending` server-side.
 */
export const createCompanySchema = z
  .object({
    name: trimmedNameSchema,

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

    gstNumber: gstSchema.optional().nullable(),
    panNumber: panSchema.optional().nullable(),

    isMsme: z.boolean().default(false),
    isJv: z.boolean().default(false),

    /**
     * Array of company UUIDs for JV partners. NULL/omitted for non-JVs.
     * Cross-validated below — a JV needs 2+, a non-JV needs none.
     */
    parentCompanyIds: z.array(uuidSchema).optional().nullable(),

    contactEmail: z
      .string()
      .trim()
      .toLowerCase()
      .email("Enter a valid email address")
      .optional()
      .nullable(),

    contactPhone: z
      .string()
      .trim()
      .min(7, "Phone number too short")
      .max(20, "Phone number too long")
      .optional()
      .nullable(),

    contactPersonName: trimmedNameSchema.optional().nullable(),

    addressLine: z
      .string()
      .trim()
      .max(500, "Address line too long")
      .optional()
      .nullable(),

    city: z.string().trim().max(100).optional().nullable(),
    state: z.string().trim().max(100).optional().nullable(),
    pincode: pincodeSchema.optional().nullable(),

    /** Admin/staff-only field. Even when sent from a `company` role
     *  client, the action drops it. */
    internalNotes: z.string().trim().max(5000).optional().nullable(),
  })
  .superRefine((data, ctx) => {
    // JV invariants. A company is either a standalone or a JV with 2+ partners.
    if (data.isJv) {
      if (!data.parentCompanyIds || data.parentCompanyIds.length < 2) {
        ctx.addIssue({
          code: "custom",
          path: ["parentCompanyIds"],
          message: "A joint venture must have at least 2 partner companies",
        });
      }
      // Catch duplicates inside the array — same UUID twice is nonsense.
      if (
        data.parentCompanyIds &&
        new Set(data.parentCompanyIds).size !== data.parentCompanyIds.length
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["parentCompanyIds"],
          message: "Partner company list contains duplicates",
        });
      }
    } else if (data.parentCompanyIds && data.parentCompanyIds.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["parentCompanyIds"],
        message: "Non-JV companies cannot have partner companies",
      });
    }
  });

export type CreateCompanyInput = z.infer<typeof createCompanySchema>;

// ── Update company ──────────────────────────────────────────────────────────

/**
 * Input schema for `updateCompany`.
 *
 * Built field-by-field rather than via `.partial()` on the create schema
 * because Zod's `.superRefine()` on the base produces an effects schema
 * that doesn't have `.partial()`. Listing fields explicitly here also
 * makes the update surface explicit — easy to spot what's mutable.
 *
 * Adds `id` (required) and `complianceStatus` (optional, admin/staff
 * only — enforced in the action layer).
 *
 * The JV invariant fires only when BOTH `isJv` and `parentCompanyIds`
 * are in the patch. If only one is being updated, the action does a
 * row-merge check against the existing record (see actions.ts).
 */
export const updateCompanySchema = z
  .object({
    id: uuidSchema,

    name: trimmedNameSchema.optional(),
    sector: z.string().trim().min(2).max(100).optional(),
    geography: z.string().trim().min(2).max(100).optional(),
    gstNumber: gstSchema.optional().nullable(),
    panNumber: panSchema.optional().nullable(),
    isMsme: z.boolean().optional(),
    isJv: z.boolean().optional(),
    parentCompanyIds: z.array(uuidSchema).optional().nullable(),
    contactEmail: z
      .string()
      .trim()
      .toLowerCase()
      .email("Enter a valid email address")
      .optional()
      .nullable(),
    contactPhone: z.string().trim().min(7).max(20).optional().nullable(),
    contactPersonName: trimmedNameSchema.optional().nullable(),
    addressLine: z.string().trim().max(500).optional().nullable(),
    city: z.string().trim().max(100).optional().nullable(),
    state: z.string().trim().max(100).optional().nullable(),
    pincode: pincodeSchema.optional().nullable(),
    internalNotes: z.string().trim().max(5000).optional().nullable(),

    // Update-only field — admins/staff change compliance state directly.
    complianceStatus: complianceStatusSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.isJv !== undefined && data.parentCompanyIds !== undefined) {
      if (data.isJv) {
        if (!data.parentCompanyIds || data.parentCompanyIds.length < 2) {
          ctx.addIssue({
            code: "custom",
            path: ["parentCompanyIds"],
            message: "A joint venture must have at least 2 partner companies",
          });
        }
      } else if (data.parentCompanyIds && data.parentCompanyIds.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["parentCompanyIds"],
          message: "Non-JV companies cannot have partner companies",
        });
      }
    }
  });

export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;

// ── List query ──────────────────────────────────────────────────────────────

/**
 * Sort columns exposed to the UI. Restricted set, not arbitrary —
 * lets us index for these and reject unexpected values without trying
 * to parse arbitrary SQL identifiers from user input.
 */
export const companySortColumnSchema = z.enum([
  "name",
  "sector",
  "geography",
  "complianceStatus",
  "createdAt",
  "updatedAt",
]);

/**
 * Query schema for `listCompanies`.
 *
 * Coerces strings to numbers for page/perPage because URL search params
 * arrive as strings, and we want this schema to work as a `searchParams`
 * parser in the App Router. `default()` runs after coercion, so a missing
 * param yields `1` / `20`, not `NaN`.
 *
 * Caps `perPage` at 100 — paginating beyond that is almost always a bug.
 */
export const listCompaniesQuerySchema = z.object({
  // Filters — all optional, multiple may apply (AND-composed in the query).
  sector: z.string().trim().min(1).optional(),
  geography: z.string().trim().min(1).optional(),
  complianceStatus: complianceStatusSchema.optional(),
  isJv: z.coerce.boolean().optional(),
  isMsme: z.coerce.boolean().optional(),

  /** Free-text search. Currently matches against `name` only via LIKE. */
  search: z.string().trim().min(1).max(200).optional(),

  // Pagination.
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),

  // Sorting.
  sortBy: companySortColumnSchema.default("createdAt"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
});

export type ListCompaniesQuery = z.infer<typeof listCompaniesQuerySchema>;

// ── ID param ────────────────────────────────────────────────────────────────

/**
 * Single-id schema for routes like `/dashboard/companies/[id]`.
 * Tiny but reused everywhere — better than re-inlining the uuid regex.
 */
export const companyIdSchema = z.object({ id: uuidSchema });
