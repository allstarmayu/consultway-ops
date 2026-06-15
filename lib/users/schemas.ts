/**
 * Zod schemas for the users module (admin user management, Day 33).
 *
 * Lives in a non-"use server" file so both client forms and server actions
 * can import these and call `.parse()` / `.safeParse()`. The actions in
 * `./actions.ts` re-validate every input with these — never trust client
 * validation alone.
 *
 * Schemas exported here:
 *   - createUserSchema      — admin invite flow (no password; the invitee
 *                             sets their own via the emailed set-password link)
 *   - updateUserSchema      — patch-style profile/role edit, all optional but id
 *   - listUsersQuerySchema  — filters, search, pagination, sorting
 *   - userIdSchema          — single-id route param validation
 *
 * Email changes are deliberately NOT part of `updateUserSchema` — changing
 * a login email needs a re-verification round-trip (tracked as the email-
 * change follow-up), so it stays out of the plain admin edit.
 *
 * @module lib/users/schemas
 */
import { z } from "zod";

// ── Reusable primitives ──────────────────────────────────────────────────────

/** UUID v7 looks just like v4 to a regex — both are 8-4-4-4-12 hex. */
const uuidSchema = z.string().uuid("Invalid identifier");

/** Trim + min 2 + max 200. Used for display names. */
const trimmedNameSchema = z
  .string()
  .trim()
  .min(2, "Name must be at least 2 characters")
  .max(200, "Name must be 200 characters or fewer");

/**
 * Login email. Trim → lowercase → format-check, mirroring the auth
 * schemas (`lib/auth/schemas.ts`). The DB column is unique and stored
 * lowercased, so normalising here keeps the action layer simple.
 */
const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("Enter a valid email address");

/**
 * Optional contact phone. Free-text, length-bounded only — Indian phone
 * numbers come in many shapes (+91, 10-digit raw, spaced/hyphenated), and
 * phone is not an auth factor, so no E.164 enforcement. Mirrors the
 * `companies.contactPhone` rule. Empty string → null.
 */
const phoneSchema = z
  .string()
  .trim()
  .min(7, "Phone number too short")
  .max(20, "Phone number too long")
  .optional()
  .nullable();

/** Optional, purely cosmetic job title (e.g. "Project Manager"). */
const jobTitleSchema = z
  .string()
  .trim()
  .max(120, "Job title must be 120 characters or fewer")
  .optional()
  .nullable();

// ── Role enum (mirrors lib/db/schema.ts UserRole) ────────────────────────────

/**
 * Reproduces the `UserRole` union from the DB schema as a Zod enum. Kept
 * in sync manually — `z.enum()` needs literal values at compile time, so
 * it can't be derived from the TS type. If a role is added to
 * `lib/db/schema.ts::UserRole`, add it here too.
 */
export const userRoleSchema = z.enum(["admin", "staff", "company"]);

export type UserRoleInput = z.infer<typeof userRoleSchema>;

// ── Create user (invite) ─────────────────────────────────────────────────────

/**
 * Input schema for `createUser` (the admin invite flow).
 *
 * No password field: the invitee receives an emailed "set your password"
 * link and chooses their own credential (`acceptInvite`). The action mints
 * an unusable random hash at insert time so the row is never login-able
 * until the invite is accepted.
 *
 * Role ↔ company invariant (cross-validated below + re-checked in the
 * action against merged state on update):
 *   - `company` role  → must carry a `companyId`
 *   - `admin`/`staff` → must NOT carry a `companyId` (internal users
 *     belong to no client company)
 */
export const createUserSchema = z
  .object({
    email: emailSchema,
    name: trimmedNameSchema,
    role: userRoleSchema,
    /** Required for `company` role; forbidden for admin/staff. */
    companyId: uuidSchema.optional().nullable(),
    phone: phoneSchema,
    jobTitle: jobTitleSchema,
  })
  .superRefine((data, ctx) => {
    if (data.role === "company") {
      if (!data.companyId) {
        ctx.addIssue({
          code: "custom",
          path: ["companyId"],
          message: "A company is required for a company-role user",
        });
      }
    } else if (data.companyId) {
      ctx.addIssue({
        code: "custom",
        path: ["companyId"],
        message: "Admin and staff users cannot be linked to a company",
      });
    }
  });

export type CreateUserInput = z.infer<typeof createUserSchema>;

// ── Update user ──────────────────────────────────────────────────────────────

/**
 * Input schema for `updateUser`. Patch-style: every field optional except
 * `id`. `email` and `isActive` are intentionally absent — email changes
 * need re-verification (separate flow) and active-state is toggled by the
 * dedicated `deactivateUser` / `reactivateUser` actions so the audit verb
 * is unambiguous.
 *
 * The role ↔ company invariant fires here only when BOTH `role` and
 * `companyId` are in the patch; when only one moves, the action re-checks
 * the invariant against the merged (existing + patch) row — same pattern
 * as the companies JV invariant.
 */
export const updateUserSchema = z
  .object({
    id: uuidSchema,
    name: trimmedNameSchema.optional(),
    role: userRoleSchema.optional(),
    companyId: uuidSchema.optional().nullable(),
    phone: phoneSchema,
    jobTitle: jobTitleSchema,
  })
  .superRefine((data, ctx) => {
    if (data.role !== undefined && data.companyId !== undefined) {
      if (data.role === "company" && !data.companyId) {
        ctx.addIssue({
          code: "custom",
          path: ["companyId"],
          message: "A company is required for a company-role user",
        });
      } else if (data.role !== "company" && data.companyId) {
        ctx.addIssue({
          code: "custom",
          path: ["companyId"],
          message: "Admin and staff users cannot be linked to a company",
        });
      }
    }
  });

export type UpdateUserInput = z.infer<typeof updateUserSchema>;

// ── List query ───────────────────────────────────────────────────────────────

/**
 * Sort columns exposed to the UI. Restricted set (not arbitrary) so we
 * can index for these and reject unexpected identifiers from user input.
 */
export const userSortColumnSchema = z.enum([
  "name",
  "email",
  "role",
  "createdAt",
  "lastLoginAt",
  "updatedAt",
]);

/**
 * Query schema for `listUsers`. Coerces strings → numbers/booleans because
 * URL search params arrive as strings — lets this double as a `searchParams`
 * parser in the App Router. `default()` runs after coercion, so a missing
 * page yields `1`, not `NaN`. `perPage` capped at 100.
 */
export const listUsersQuerySchema = z.object({
  // Filters — all optional, AND-composed in the query.
  role: userRoleSchema.optional(),

  /**
   * Active-state filter. A string enum rather than a coerced boolean
   * because `z.coerce.boolean("false")` is `true` (any non-empty string
   * is truthy) — passing `?status=inactive` through a coerced boolean
   * would silently mean "active". The action maps this to `isActive`.
   */
  status: z.enum(["active", "inactive"]).optional(),

  companyId: uuidSchema.optional(),

  /** Free-text search across name + email via LIKE. */
  search: z.string().trim().min(1).max(200).optional(),

  // Pagination.
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),

  // Sorting.
  sortBy: userSortColumnSchema.default("createdAt"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
});

export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

// ── ID param ─────────────────────────────────────────────────────────────────

/** Single-id schema for routes like `/dashboard/admin/users/[id]`. */
export const userIdSchema = z.object({ id: uuidSchema });
