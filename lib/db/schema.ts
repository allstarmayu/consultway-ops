/**
 * Drizzle schema — single source of truth for the database.
 *
 * Every table is exported from this file. drizzle-kit reads this file
 * to diff against the current DB state and generate migrations.
 *
 * Cloudflare D1 is SQLite — so we use `drizzle-orm/sqlite-core`, not
 * `pg-core` or `mysql-core`. SQLite gotchas to keep in mind:
 *   - No native enums → use text() with `$type<Union>()` + app-layer validation
 *   - No native booleans → integer(..., { mode: 'boolean' })
 *   - No native timestamps → text() with ISO-8601 strings
 *   - No JSONB → text(..., { mode: 'json' }) + manual validation
 *
 * @module lib/db/schema
 */
import { sql } from "drizzle-orm";
import { index, sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { newId } from "./ids";

// ── Shared types ────────────────────────────────────────────────────────
/**
 * User roles. Order of precedence: admin > staff > company.
 * Enforced at app layer via Zod + TypeScript union — SQLite has no native enums.
 */
export type UserRole = "admin" | "staff" | "company";

// ── users ───────────────────────────────────────────────────────────────
/**
 * Platform users. Three kinds:
 *   - `admin`   — Consultway superuser. Can do everything.
 *   - `staff`   — Consultway employee. Can manage tenders, projects, companies.
 *   - `company` — Employee of a registered client company. Linked via `companyId`.
 *
 * For `admin` / `staff`, `companyId` is NULL. For `company`, it points to
 * the `companies` table (which doesn't exist yet — added in a later chunk).
 * The FK constraint will be retrofitted then. For now the column is just
 * a nullable TEXT with an index for lookup performance.
 */
export const users = sqliteTable(
  "users",
  {
    /** UUID v7. Generated app-side via `newId()`. */
    id: text("id").primaryKey().$defaultFn(newId),

    /** Unique, case-insensitive (lowercased before insert at app layer). */
    email: text("email").notNull().unique(),

    /** bcryptjs hash. Never plaintext, never logged. */
    passwordHash: text("password_hash").notNull(),

    /** See `UserRole`. Validated app-side with Zod. */
    role: text("role").notNull().$type<UserRole>(),

    /** FK to companies.id — nullable for admin/staff. Constraint added later. */
    companyId: text("company_id"),

    /** Display name. */
    name: text("name").notNull(),

    /** Soft-disable without deletion. Default true. */
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),

    /** ISO-8601 UTC. Null until user clicks verification link. */
    emailVerifiedAt: text("email_verified_at"),

    /** ISO-8601 UTC. Stamped on each successful login. */
    lastLoginAt: text("last_login_at"),

    /** ISO-8601 UTC. Set by SQLite default on insert. */
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),

    /** ISO-8601 UTC. Updated app-side via Drizzle $onUpdate hook. */
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`)
      .$onUpdate(() => new Date().toISOString()),
  },
  (table) => [
    // Fast "all users at company X" queries.
    index("users_company_id_idx").on(table.companyId),
    // Fast "all admins" / "all staff" filters on the admin dashboard.
    index("users_role_idx").on(table.role),
  ],
);

/** Inferred insert type — use for Zod parsing / insert validation. */
export type NewUser = typeof users.$inferInsert;

/** Inferred select type — what a row looks like when read from the DB. */
export type User = typeof users.$inferSelect;

// ── Shared types ────────────────────────────────────────────────────────────
/**
 * Compliance status for a company's document / registration state.
 *   - `pending`        — new registration, not yet reviewed by Consultway staff.
 *   - `compliant`      — all required documents verified and current.
 *   - `non_compliant`  — admin-flagged issue (missing docs, failed verification).
 *   - `expired`        — at least one required document past its expiry date.
 *                        Set automatically by the nightly cron sweep.
 *
 * Validated app-side via Zod + TypeScript union — SQLite has no native enums.
 */
export type ComplianceStatus =
  | "pending"
  | "compliant"
  | "non_compliant"
  | "expired";

// ── companies ───────────────────────────────────────────────────────────────
/**
 * Master record for every organisation registered on the Consultway Ops
 * platform, including joint ventures (JVs).
 *
 * A JV is represented as a normal company row with `isJv = true` and
 * `parentCompanyIds` populated with a JSON array of the partner company
 * UUIDs. This denormalised approach is intentional for Phase 1 where the
 * JV → partners lookup is only a single query on the detail page. If we
 * later need efficient reverse lookups ("show all JVs this company is
 * part of"), we'll add a `company_jv_partners` join table then.
 *
 * FK note: `users.companyId` will reference this table. The FK is added
 * in a follow-up migration (see Chunk 1b) since SQLite doesn't allow
 * ALTER TABLE ADD CONSTRAINT — requires a table rebuild.
 */
export const companies = sqliteTable(
  "companies",
  {
    /** UUID v7. Generated app-side via `newId()`. */
    id: text("id").primaryKey().$defaultFn(newId),

    /** Legal / display name of the company. Indexed for search. */
    name: text("name").notNull(),

    /** Free-form sector label (e.g. "Infrastructure", "Solar EPC", "Civil Works"). */
    sector: text("sector").notNull(),

    /** Free-form geography label (e.g. "Pan India", "Maharashtra", "Delhi NCR"). */
    geography: text("geography").notNull(),

    /**
     * GST number (15 chars). Nullable during onboarding before the
     * company receives theirs. SQLite treats NULLs as distinct in
     * unique constraints, so multiple rows may have NULL — but any
     * non-null value must be unique across the table.
     */
    gstNumber: text("gst_number").unique(),

    /** PAN number (10 chars). Same nullable + unique semantics as GST. */
    panNumber: text("pan_number").unique(),

    /** MSME registration flag. Default false. */
    isMsme: integer("is_msme", { mode: "boolean" }).notNull().default(false),

    /** True when this row represents a joint venture (see `parentCompanyIds`). */
    isJv: integer("is_jv", { mode: "boolean" }).notNull().default(false),

    /** See `ComplianceStatus`. Validated app-side with Zod. Default "pending". */
    complianceStatus: text("compliance_status")
      .notNull()
      .$type<ComplianceStatus>()
      .default("pending"),

    /**
     * JSON-encoded array of partner company UUIDs when `isJv = true`.
     * NULL for non-JV companies. Drizzle's `mode: 'json'` handles the
     * JSON.stringify/parse transparently — at the app layer you just
     * work with `string[] | null`.
     */
    parentCompanyIds: text("parent_company_ids", { mode: "json" })
      .$type<string[] | null>(),

    /** Contact email — distinct from any linked user's email. */
    contactEmail: text("contact_email"),
    /** Contact phone (E.164 recommended but not enforced at DB level). */
    contactPhone: text("contact_phone"),
    /** Primary contact person's display name. */
    contactPersonName: text("contact_person_name"),

    /** Street address line (single field — we don't model line 1 / line 2). */
    addressLine: text("address_line"),
    /** City / town. */
    city: text("city"),
    /** Indian state / UT. Free-form for now; can be tightened to enum later. */
    state: text("state"),
    /** 6-digit Indian postal code. Stored as TEXT to preserve leading zeros. */
    pincode: text("pincode"),

    /**
     * Admin/staff-only notes. Never returned on a company-role user's
     * own detail view — filtered at the action layer.
     */
    internalNotes: text("internal_notes"),

    /** ISO-8601 UTC. Set by SQLite default on insert. */
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),

    /** ISO-8601 UTC. Updated app-side via Drizzle $onUpdate hook. */
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`)
      .$onUpdate(() => new Date().toISOString()),
  },
  (table) => [
    // Search / sort by name on the companies list page.
    index("companies_name_idx").on(table.name),
    // Filter by sector on the roster.
    index("companies_sector_idx").on(table.sector),
    // Filter by geography on the roster.
    index("companies_geography_idx").on(table.geography),
    // Filter by compliance status (most common dashboard filter).
    index("companies_compliance_status_idx").on(table.complianceStatus),
    // Separate JVs from non-JVs quickly on the JV management screen.
    index("companies_is_jv_idx").on(table.isJv),
  ],
);

/** Inferred insert type — use for Zod parsing / insert validation. */
export type NewCompany = typeof companies.$inferInsert;

/** Inferred select type — what a row looks like when read from the DB. */
export type Company = typeof companies.$inferSelect;