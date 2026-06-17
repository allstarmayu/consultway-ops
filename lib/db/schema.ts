/**
 * Drizzle schema - single source of truth for the database.
 *
 * Every table is exported from this file. drizzle-kit reads this file
 * to diff against the current DB state and generate migrations.
 *
 * Cloudflare D1 is SQLite - so we use `drizzle-orm/sqlite-core`, not
 * `pg-core` or `mysql-core`. SQLite gotchas to keep in mind:
 *   - No native enums -> use text() with `$type<Union>()` + app-layer validation
 *   - No native booleans -> integer(..., { mode: 'boolean' })
 *   - No native timestamps -> text() with ISO-8601 strings
 *   - No JSONB -> text(..., { mode: 'json' }) + manual validation
 *
 * @module lib/db/schema
 */
import { sql } from "drizzle-orm";
import { index, sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";
import { newId } from "./ids";

// -- Shared types -----------------------------------------------------------
/**
 * User roles. Order of precedence: admin > staff > company.
 * Enforced at app layer via Zod + TypeScript union - SQLite has no native enums.
 */
export type UserRole = "admin" | "staff" | "company";

// -- users ------------------------------------------------------------------
/**
 * Platform users. Three kinds:
 *   - `admin`   - Consultway superuser. Can do everything.
 *   - `staff`   - Consultway employee. Can manage tenders, projects, companies.
 *   - `company` - Employee of a registered client company. Linked via `companyId`.
 *
 * For `admin` / `staff`, `companyId` is NULL. For `company`, it points to
 * `companies.id` with an `ON DELETE SET NULL` foreign key - see the
 * `companyId` column below for full rationale.
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

    /**
     * FK to `companies.id`. NULL for admin/staff (who don't belong to any
     * company). `ON DELETE SET NULL` semantics: if a company row is deleted,
     * its linked users survive as orphaned rows for admin review rather
     * than getting cascade-deleted - losing user history because a company
     * record was cleaned up would be bad.
     *
     * The FK uses a forward-reference function `() => companies.id` because
     * the `companies` table is defined later in this file. Drizzle resolves
     * the reference lazily at query-build time, so the textual ordering of
     * declarations doesn't matter - only that everything is exported from
     * the same module.
     *
     * Note: SQLite enforces FKs only when `PRAGMA foreign_keys = ON`. We
     * set that pragma in `lib/db/index.ts` for the dev driver, and D1
     * enforces FKs by default in production.
     */
    companyId: text("company_id").references(() => companies.id, {
      onDelete: "set null",
      onUpdate: "no action",
    }),

    /** Display name. */
    name: text("name").notNull(),

    /**
     * Optional contact phone for the user. Stored as free text — no
     * format normalisation at the DB level, since users in India write
     * phone numbers in many shapes (+91 prefix, 10-digit raw, with
     * spaces / hyphens). The action layer trims and length-bounds via
     * `updateProfileSchema` but doesn't impose E.164 — phone is not an
     * authentication factor today, so the column carries no
     * verification state. NULL = "not provided" (the default for every
     * user pre-Day-28 — the field was deferred from Day-27 #1).
     */
    phone: text("phone"),

    /**
     * Optional job title for display purposes (e.g. "Project Manager",
     * "Civil Engineer"). Free text, length-bounded at the action layer.
     * No downstream feature reads this today — purely cosmetic on the
     * Profile section — but persisting it closes the "type into the
     * field, refresh, value gone" papercut from Day-26.
     */
    jobTitle: text("job_title"),

    /**
     * Optional R2 object key for the user's profile photo. NULL when
     * the user has never uploaded an avatar (the Avatar component
     * falls back to initials). Format follows the same shape as
     * `documents.fileKey`: `avatars/{userId}/{sanitizedFilename}`, see
     * `lib/r2/keys.ts::buildAvatarKey`.
     *
     * Why a key and not a URL: matches the `documents` pattern — we
     * mint presigned GETs on demand via
     * `lib/avatars/server.ts::getAvatarDisplayUrl` rather than storing
     * a URL that would either expire or require a public R2 bucket.
     * Lets us keep the bucket fully private and lets us migrate to a
     * different bucket / region without rewriting any rows.
     *
     * Added Day 29.
     */
    avatarKey: text("avatar_key"),

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

/** Inferred insert type - use for Zod parsing / insert validation. */
export type NewUser = typeof users.$inferInsert;

/** Inferred select type - what a row looks like when read from the DB. */
export type User = typeof users.$inferSelect;

// -- Shared types -----------------------------------------------------------
/**
 * Compliance status for a company's document / registration state.
 *   - `pending`        - new registration, not yet reviewed by Consultway staff.
 *   - `compliant`      - all required documents verified and current.
 *   - `non_compliant`  - admin-flagged issue (missing docs, failed verification).
 *   - `expired`        - at least one required document past its expiry date.
 *                        Set automatically by the nightly cron sweep.
 *   - `suspended`      - admin-paused for backstory reasons (legal hold,
 *                        commercial dispute, internal review). Reversible
 *                        back to `compliant` — a suspension does not
 *                        terminate the relationship, it just freezes it.
 *   - `rejected`       - terminal. Initial registration was denied, or a
 *                        re-review concluded the company is not eligible
 *                        to operate on the platform. State machine refuses
 *                        any transition OUT of `rejected`; re-applying
 *                        creates a new company row. Populated alongside
 *                        `rejectionReason` so audit reviewers know why.
 *
 * Validated app-side via Zod + TypeScript union - SQLite has no native enums.
 */
export type ComplianceStatus =
  | "pending"
  | "compliant"
  | "non_compliant"
  | "expired"
  | "suspended"
  | "rejected";

// -- companies --------------------------------------------------------------
/**
 * Master record for every organisation registered on the Consultway Ops
 * platform, including joint ventures (JVs).
 *
 * A JV is represented as a normal company row with `isJv = true` and
 * `parentCompanyIds` populated with a JSON array of the partner company
 * UUIDs. This denormalised approach is intentional for Phase 1 where the
 * JV -> partners lookup is only a single query on the detail page. If we
 * later need efficient reverse lookups ("show all JVs this company is
 * part of"), we'll add a `company_jv_partners` join table then.
 *
 * FK note: `users.companyId` will reference this table. The FK is added
 * in a follow-up migration (see Chunk 1b) since SQLite doesn't allow
 * ALTER TABLE ADD CONSTRAINT - requires a table rebuild.
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
     * unique constraints, so multiple rows may have NULL - but any
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
     * JSON.stringify/parse transparently - at the app layer you just
     * work with `string[] | null`.
     */
    parentCompanyIds: text("parent_company_ids", { mode: "json" })
      .$type<string[] | null>(),

    /**
     * Stated annual turnover in INR (whole rupees, no paise). Same
     * integer-not-REAL choice and same scale (~9.2 quintillion ceiling)
     * as `tenders.minAnnualTurnoverInr` - the two columns are compared
     * directly by the turnover-eligibility gate in
     * `lib/tenders/actions.ts::applyToTender`, so they have to be the
     * same shape.
     *
     * NULL means "not stated by the company." On the tender side NULL
     * means "no minimum required" - the asymmetry is deliberate: a
     * company that hasn't stated a turnover is treated as ineligible
     * for tenders that DO require a minimum (we can't verify they
     * qualify), but the unstated-figure default doesn't bar them from
     * unrestricted tenders. Same column shape, role-dependent semantics.
     *
     * The column is nullable with no default on purpose - the seed
     * doesn't backfill turnover figures, and a company self-registering
     * via the eventual public flow may not know their turnover at
     * registration time. They can update later via the company edit
     * form. The apply-to-tender gate enforces "stated" at the moment
     * eligibility actually matters.
     */
    annualTurnover: integer("annual_turnover"),

    /** Contact email - distinct from any linked user's email. */
    contactEmail: text("contact_email"),
    /** Contact phone (E.164 recommended but not enforced at DB level). */
    contactPhone: text("contact_phone"),
    /** Primary contact person's display name. */
    contactPersonName: text("contact_person_name"),

    /** Street address line (single field - we don't model line 1 / line 2). */
    addressLine: text("address_line"),
    /** City / town. */
    city: text("city"),
    /** Indian state / UT. Free-form for now; can be tightened to enum later. */
    state: text("state"),
    /** 6-digit Indian postal code. Stored as TEXT to preserve leading zeros. */
    pincode: text("pincode"),

    /**
     * Admin/staff-only notes. Never returned on a company-role user's
     * own detail view - filtered at the action layer.
     */
    internalNotes: text("internal_notes"),

    /**
     * Free-text reason populated alongside `complianceStatus = 'rejected'`.
     * NULL for every other status. Audit reviewers and admins read this
     * to understand WHY a company was rejected (failed background check,
     * commercial dispute, regulatory blocker, etc.) without having to
     * dig into the audit log. Admin/staff-only on read, same scoping as
     * `internalNotes` — company-role users never see it.
     *
     * No CHECK constraint that ties this to status — SQLite can't easily
     * express conditional NOT NULL — but the action / seed layer asserts
     * "rejected ⇒ non-null reason" on every write.
     */
    rejectionReason: text("rejection_reason"),

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

/** Inferred insert type - use for Zod parsing / insert validation. */
export type NewCompany = typeof companies.$inferInsert;

/** Inferred select type - what a row looks like when read from the DB. */
export type Company = typeof companies.$inferSelect;

// -- Shared types: tenders --------------------------------------------------
/**
 * Lifecycle state of a tender. Strict left-to-right progression in
 * normal use, but no DB-level guard against jumping states - the
 * action layer (`publishTender`, `closeTender`, `markAwarded`) is the
 * source of truth for legal transitions.
 *
 *   - `draft`     - created but not yet visible to companies. Publisher /
 *                   admin / staff only. Free to edit any field.
 *   - `published` - visible on the public roster; companies may apply.
 *                   Eligibility filters are now binding.
 *   - `closed`    - the closing date has passed (or staff manually closed
 *                   the window). New applications rejected; existing ones
 *                   survive. Used while staff evaluate submissions.
 *   - `awarded`   - terminal state. A winning company has been selected;
 *                   the tender is archived for reference. No further
 *                   applications, no edits except internal notes.
 *
 * Validated app-side via Zod + TypeScript union - SQLite has no native enums.
 */
export type TenderStatus = "draft" | "published" | "closed" | "awarded";

/**
 * Per-application lifecycle. One row per (tenderId, companyId) pair -
 * a company applies once. Status transitions are managed by staff on
 * the tender detail page.
 *
 *   - `submitted`   - initial state when a company applies.
 *   - `withdrawn`   - company-initiated withdrawal before staff review.
 *   - `shortlisted` - staff flagged this application for award consideration.
 *   - `rejected`    - staff rejected this application (missing eligibility,
 *                     bad fit, etc.). Distinct from `withdrawn` so we can
 *                     audit who closed the door.
 *
 * Note: no `awarded` value here - the winning company is recorded on the
 * tender row itself (via the tender's `awarded` status + a future
 * `awardedCompanyId` column when Phase 2 lands). Today, "awarded" is a
 * tender-level state, not an application-level state.
 */
export type TenderApplicationStatus =
  | "submitted"
  | "withdrawn"
  | "shortlisted"
  | "rejected";

// -- tenders ----------------------------------------------------------------
/**
 * Tenders published on the Consultway Ops platform. A tender represents
 * an opportunity that companies on the platform can apply to.
 *
 * Two issuer shapes are supported via a single `publisherCompanyId` FK:
 *   - **Consultway-internal tenders** - `publisherCompanyId` points to
 *     the sentinel "Consultway Infotech" company row, seeded once and
 *     idempotent. Staff manage these on behalf of Consultway itself.
 *   - **Subcontract tenders** - `publisherCompanyId` points to a real
 *     registered company that is sub-contracting work out to other
 *     platform members. Useful when a winning bidder needs partners.
 *
 * The FK uses `ON DELETE RESTRICT`: a company that has published tenders
 * cannot be deleted out from under them. Admins must close/award and then
 * clean up tenders before they can delete the publishing company. This
 * is intentional - losing the provenance of a published tender would
 * break audit trails. (Compare to `users.companyId` which uses SET NULL -
 * users orphan gracefully; tenders don't.)
 *
 * Eligibility filters (`eligibleSector`, `eligibleGeography`,
 * `minAnnualTurnoverInr`, `msmeOnly`) are stored alongside the tender so
 * applying companies can be filtered server-side without joining to a
 * separate criteria table. Each filter is nullable - NULL means "no
 * restriction on this dimension."
 *
 * Turnover-eligibility enforcement is live as of Day 8 - the gate in
 * `lib/tenders/actions.ts::applyToTender` compares this column against
 * `companies.annualTurnover` and rejects applicants who either don't
 * meet the minimum or haven't stated their turnover at all.
 */
export const tenders = sqliteTable(
  "tenders",
  {
    /** UUID v7. Generated app-side via `newId()`. */
    id: text("id").primaryKey().$defaultFn(newId),

    /** Short title - appears in lists and tabs. Indexed for search. */
    title: text("title").notNull(),

    /**
     * Long-form description / scope of work. Plain text or simple
     * markdown - we don't sanitise HTML, the UI renders it as text.
     * NULL is allowed but discouraged; the form makes it required.
     */
    description: text("description"),

    /**
     * Reference number (e.g. "CW-2026-INFRA-014"). Optional and unique
     * when present. Nullable for early drafts that haven't received a
     * formal number yet. Same NULL-distinct semantics as GST/PAN above.
     */
    referenceNumber: text("reference_number").unique(),

    /** See `TenderStatus`. Validated app-side with Zod. Default "draft". */
    status: text("status")
      .notNull()
      .$type<TenderStatus>()
      .default("draft"),

    /**
     * Publishing organisation. FK to `companies.id` with ON DELETE RESTRICT
     * (see table-level docstring). For Consultway-internal tenders this
     * points at the seeded "Consultway Infotech" sentinel company.
     */
    publisherCompanyId: text("publisher_company_id")
      .notNull()
      .references(() => companies.id, {
        onDelete: "restrict",
        onUpdate: "no action",
      }),

    /**
     * Sector this tender is in (e.g. "Roads & Highways", "Solar EPC").
     * Doubles as an eligibility filter - applying companies whose own
     * sector doesn't match get gated out (when the field is non-null).
     */
    sector: text("sector").notNull(),

    /**
     * Geography this tender covers. Same dual purpose as sector - both
     * filter and metadata.
     */
    geography: text("geography").notNull(),

    // -- Eligibility filters ---------------------------------------------
    /**
     * If set, applicants must operate in this sector. Stored as a single
     * string for Phase 1 - matches the company's `sector` field. Null
     * means "no sector restriction." Most tenders set this to the same
     * value as `sector` above, but they're stored separately so we can
     * decouple the two (e.g. a Roads tender that also accepts general
     * Civil Works companies).
     */
    eligibleSector: text("eligible_sector"),

    /** If set, applicants must operate in this geography. Null = open. */
    eligibleGeography: text("eligible_geography"),

    /**
     * Minimum annual turnover in INR (whole rupees, no paise). Stored as
     * INTEGER not REAL: SQLite's REAL is IEEE-754 double and loses
     * precision on large amounts; an integer holds exact rupees up to
     * ~9.2 quintillion, well above any realistic turnover. NULL means
     * "no minimum turnover required."
     *
     * Enforced server-side in `applyToTender` against the applying
     * company's own `annualTurnover` (Day 8). Companies with NULL
     * `annualTurnover` cannot apply to tenders that set a minimum -
     * the gate refuses unstated figures because they can't be verified.
     */
    minAnnualTurnoverInr: integer("min_annual_turnover_inr"),

    /**
     * When true, only companies with `isMsme = true` may apply. When
     * false (the default), MSME and non-MSME companies both eligible.
     */
    msmeOnly: integer("msme_only", { mode: "boolean" })
      .notNull()
      .default(false),

    // -- Dates -----------------------------------------------------------
    /**
     * ISO-8601 date (YYYY-MM-DD) when applications open. NULL = "open
     * immediately on publish." Stored as TEXT because SQLite has no
     * native DATE; we use date-only strings (no time component) so the
     * tender doesn't feel timezone-sensitive to users.
     */
    openingDate: text("opening_date"),

    /**
     * ISO-8601 date when applications close. After this date the
     * `closeTender` action transitions the row to `closed`. NULL is
     * allowed (open-ended tenders) but uncommon.
     */
    closingDate: text("closing_date"),

    // -- Staff-only fields -----------------------------------------------
    /**
     * Staff-only working notes. Never shown to company-role users - the
     * action layer strips this field on company-scoped reads. Same
     * pattern as `companies.internalNotes`.
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

    /**
     * ISO-8601 UTC. Stamped by `publishTender` on the draft->published
     * transition. Useful for "tenders published this week" reports.
     * NULL while the tender is still a draft.
     */
    publishedAt: text("published_at"),

    /**
     * The winning company once the tender lands in `awarded` status.
     * NULL for tenders not yet awarded. Stamped by `markAwarded` and
     * cleared by `retractAward` (the Day-5 reversal — keeping the column
     * symmetric with the status flip avoids stale "winner" data on a
     * retracted tender).
     *
     * FK uses ON DELETE RESTRICT — once a company has won a tender, it
     * cannot be deleted out from under that record. Same rationale as
     * `publisherCompanyId` above: losing the identity of the awardee
     * would break the audit trail (the audit log preserves the historical
     * fact of the award, but the foreign key keeps the live tender row
     * consistent). Admins must move the tender away from awarded — or
     * delete the tender itself, which is illegal at this status anyway —
     * before they can delete the winning company.
     *
     * Phase 3 (project tracking) uses this column as the bridge: a
     * project record is created from a tender by reading
     * `awardedCompanyId` to know who the project belongs to.
     */
    awardedCompanyId: text("awarded_company_id").references(
      () => companies.id,
      {
        onDelete: "restrict",
        onUpdate: "no action",
      },
    ),
  },
  (table) => [
    // Free-text search by title (LIKE) and ordering.
    index("tenders_title_idx").on(table.title),
    // Most common filter - admin list, company list, all gate on status.
    index("tenders_status_idx").on(table.status),
    // "What did Acme publish?" - used on company detail page (Phase 2 link).
    index("tenders_publisher_company_id_idx").on(table.publisherCompanyId),
    // Sector filter on the list page.
    index("tenders_sector_idx").on(table.sector),
    // Sort + "closing soon" widgets.
    index("tenders_closing_date_idx").on(table.closingDate),
    // "What did Acme win?" reverse lookup. Used by Phase 3's
    // tender → project creation flow and by the company detail page's
    // "won tenders" panel when it lands.
    index("tenders_awarded_company_id_idx").on(table.awardedCompanyId),
  ],
);

/** Inferred insert type - use for Zod parsing / insert validation. */
export type NewTender = typeof tenders.$inferInsert;

/** Inferred select type - what a row looks like when read from the DB. */
export type Tender = typeof tenders.$inferSelect;

// -- tender_applications ----------------------------------------------------
/**
 * Junction table tracking which companies have applied to which tenders.
 *
 * Modelled as a first-class table (not a JSON column on `tenders`) because:
 *   - Per-application state (status, timestamps, cover note) lives here,
 *     not on the tender. JSON would force every status change to rewrite
 *     the whole array.
 *   - Indexed reverse lookups: "show me all tenders Acme applied to"
 *     becomes a single indexed query, vs scanning every tender's JSON.
 *   - Composite unique on (tenderId, companyId) cleanly prevents double-
 *     applications at the DB level - no race-condition window.
 *
 * Cascade semantics:
 *   - Tender deleted -> applications deleted (`ON DELETE CASCADE`). Only
 *     drafts can be deleted anyway (action layer enforces), so this is
 *     safe - published tenders that received applications can be closed
 *     but not removed.
 *   - Company deleted -> applications deleted (`ON DELETE CASCADE`). The
 *     company-level audit log captures the deletion; preserving orphan
 *     application rows pointing at a non-existent company would just be
 *     dead data.
 */
export const tenderApplications = sqliteTable(
  "tender_applications",
  {
    /** UUID v7. Generated app-side via `newId()`. */
    id: text("id").primaryKey().$defaultFn(newId),

    /** FK to the tender being applied to. Cascades on tender delete. */
    tenderId: text("tender_id")
      .notNull()
      .references(() => tenders.id, {
        onDelete: "cascade",
        onUpdate: "no action",
      }),

    /** FK to the applying company. Cascades on company delete. */
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id, {
        onDelete: "cascade",
        onUpdate: "no action",
      }),

    /** See `TenderApplicationStatus`. Default "submitted". */
    status: text("status")
      .notNull()
      .$type<TenderApplicationStatus>()
      .default("submitted"),

    /**
     * Optional cover note from the applying company. Plain text, capped
     * at ~5000 chars by Zod at the action layer (no DB limit).
     */
    coverNote: text("cover_note"),

    /**
     * Staff-only notes on this specific application (e.g. "called for
     * site visit, follow up Tuesday"). Stripped on company-role reads,
     * same pattern as elsewhere.
     */
    internalNotes: text("internal_notes"),

    /** ISO-8601 UTC. Set by SQLite default on insert (i.e. apply time). */
    submittedAt: text("submitted_at")
      .notNull()
      .default(sql`(datetime('now'))`),

    /**
     * ISO-8601 UTC. Stamped when status changes to `withdrawn` /
     * `shortlisted` / `rejected`. NULL while still `submitted`.
     */
    decidedAt: text("decided_at"),

    /** ISO-8601 UTC. Updated app-side via Drizzle $onUpdate hook. */
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`)
      .$onUpdate(() => new Date().toISOString()),
  },
  (table) => [
    // Composite unique - one application per (tender, company) pair.
    // SQLite's UNIQUE index enforces this at write time, eliminating
    // the application-layer race window between "check if applied"
    // and "insert application."
    uniqueIndex("tender_applications_tender_company_unique_idx").on(
      table.tenderId,
      table.companyId,
    ),
    // "Show all applications for this tender" - detail page.
    index("tender_applications_tender_id_idx").on(table.tenderId),
    // "Show all my applications" - company-role users' my-applications page.
    index("tender_applications_company_id_idx").on(table.companyId),
    // Filter by status in either direction.
    index("tender_applications_status_idx").on(table.status),
  ],
);

/** Inferred insert type - use for Zod parsing / insert validation. */
export type NewTenderApplication = typeof tenderApplications.$inferInsert;

/** Inferred select type - what a row looks like when read from the DB. */
export type TenderApplication = typeof tenderApplications.$inferSelect;

// -- audit_log --------------------------------------------------------------
/**
 * Append-only ledger of every mutation that flows through the action layer.
 *
 * Written via `recordAuditEvent` in `lib/audit/log.ts` after each successful
 * Server Action write. Reads happen via `listAuditEvents` (Chunk 2 - Day 6).
 * The UI does not write directly to this table.
 *
 * Design choices, called out for future-readers:
 *
 *   - **No foreign keys.** `actorId` and `targetId` are denormalised text
 *     columns with no FK constraint to `users.id` or any domain table.
 *     An audit trail that vanishes when its referent is deleted is not an
 *     audit trail. The cost is occasional dangling pointers for forensic
 *     queries to handle; the benefit is the row survives. We capture
 *     `actorRole` denormalised in the row for the same reason - "what did
 *     admins do last week" must answer even after the admin user is gone.
 *
 *   - **JSON columns for `before` / `after` / `metadata`.** Snapshots are
 *     typed `Record<string, unknown>` in app code. Drizzle's `mode: "json"`
 *     parses on read and stringifies on write transparently. SQLite stores
 *     them as TEXT - no JSONB, no schema validation at the DB layer. We
 *     rely on the typed `AuditEvent` shape at the action layer.
 *
 *   - **Indexes.** Three patterns dominate the read API:
 *       (a) "history of one entity"      -> (target_type, target_id)
 *       (b) "what did this user do?"     -> actor_id
 *       (c) "recent activity feed"       -> created_at DESC
 *     A separate index on `action` lets us answer "all reversals last month"
 *     without a scan. The (target_type, target_id) composite is the most
 *     load-bearing and is declared first.
 *
 *   - **Append-only.** No update or delete actions exist in the action layer.
 *     Compliance audit trails must be tamper-evident; the only acceptable
 *     mutation is inserting a new event that supersedes a wrong one. If we
 *     ever need to purge for GDPR or retention, that lands as a deliberate
 *     `lib/audit/retention.ts` module with its own role gate.
 *
 *   - **No `updated_at`.** Rows never change after insert, so the column
 *     would be dead weight. `created_at` doubles as "when this happened",
 *     which is the only timestamp anyone queries on this table.
 */
export const auditLog = sqliteTable(
  "audit_log",
  {
    /** UUID v7. Generated app-side via `newId()`. */
    id: text("id").primaryKey().$defaultFn(newId),

    /**
     * The user who performed the action. Denormalised text column - no FK -
     * so the audit row survives even if the user is later deleted. See
     * top-of-table commentary for rationale.
     */
    actorId: text("actor_id").notNull(),

    /**
     * Role at the time of the action. Validated app-side via the `AuditEvent`
     * type union. SQLite has no enums, so this is a plain text column - the
     * app layer is the source of truth.
     */
    actorRole: text("actor_role").notNull(),

    /**
     * The verb. Stored as plain text; validated app-side against the
     * `AuditAction` union in `lib/audit/log.ts`. Same enum-less-SQLite
     * convention as `actorRole`.
     */
    action: text("action").notNull(),

    /**
     * The kind of entity acted on. One of the `AuditTargetType` union
     * values. Indexed together with `targetId` so "history of this thing"
     * queries are a single index seek.
     */
    targetType: text("target_type").notNull(),

    /** The id of the entity acted on. UUID v7. */
    targetId: text("target_id").notNull(),

    /**
     * Snapshot of the row state BEFORE the action. NULL for `created`
     * events (there is no "before"). JSON-encoded on write, parsed on
     * read via Drizzle's `mode: "json"`.
     */
    before: text("before", { mode: "json" }).$type<Record<string, unknown>>(),

    /**
     * Snapshot of the row state AFTER the action. NULL for `deleted`
     * events (there is no "after"). JSON-encoded same as `before`.
     */
    after: text("after", { mode: "json" }).$type<Record<string, unknown>>(),

    /**
     * Free-form action-specific extra context. Examples:
     *   - reversal reason ("awarded company withdrew offer")
     *   - days since withdrawal on a recall
     *   - the tenderId when the target is a tender_application
     *   - field list on a partial update
     * JSON-encoded; not indexed - reads filter by `target_type` + `target_id`
     * first and walk metadata after.
     */
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),

    /**
     * ISO-8601 UTC. Stamped by SQLite on insert. There is no `updatedAt` -
     * audit rows are append-only by design (see table commentary).
     */
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    // (a) "history of one entity" - the most load-bearing access pattern.
    // Day 7's per-entity history tabs hit this index for every read.
    index("audit_log_target_idx").on(table.targetType, table.targetId),

    // (b) "what did this user do" - admin investigation queries.
    index("audit_log_actor_id_idx").on(table.actorId),

    // (c) "all events of this kind" - filtering the activity feed by verb
    // (e.g. "show me all reversals last month") needs an indexed action.
    index("audit_log_action_idx").on(table.action),

    // (d) Recent-first ordering on the activity feed widget. The composite
    // (target_type, target_id) above doesn't cover this; a dedicated
    // created_at index is cheaper than re-sorting in the app layer for
    // unbounded feeds.
    index("audit_log_created_at_idx").on(table.createdAt),
  ],
);

/** Inferred insert type. Used by `recordAuditEvent` when staging the row. */
export type NewAuditLogEntry = typeof auditLog.$inferInsert;

/** Inferred select type. Used by `listAuditEvents` (Chunk 2) for return rows. */
export type AuditLogEntry = typeof auditLog.$inferSelect;

// -- Shared types: documents ------------------------------------------------
/**
 * Categorical kind of a document. Drives downstream rules:
 *   - which docs are mandatory for a company to reach `compliant` status
 *   - which docs feed tender eligibility checks (Phase 2 / Phase 3)
 *   - which docs the expiry-reminder cron emails on (Day 10+)
 *
 * Closed union. SQLite has no native enums; validated app-side via Zod
 * (`lib/documents/schemas.ts`) and via the type at the action layer.
 *
 * The seven values match `docs/05-database-schema.md`. Easy to widen via
 * a follow-up migration if the brief's MSME cert / balance sheet / bank
 * statement need to land - flag for Day 9 follow-up.
 */
export type DocumentType =
  | "gst_certificate"
  | "pan_card"
  | "incorporation_cert"
  | "board_resolution"
  | "cancelled_cheque"
  | "trade_license"
  | "other";

/**
 * Lifecycle state of a document row.
 *
 *   - `pending`        - row inserted at upload-initiation time. The
 *                        presigned PUT URL has been minted but the
 *                        client has not yet confirmed the upload
 *                        completed. Orphaned `pending` rows older than
 *                        ~1 hour are sweep-eligible by a future cron.
 *   - `pending_review` - upload confirmed; the file is in R2 and the
 *                        row carries valid `fileKey` / `sizeBytes`.
 *                        Awaiting admin/staff verification. THIS is the
 *                        state `docs/05-database-schema.md` documents
 *                        as the initial state - we added `pending` ahead
 *                        of it for the two-step direct-to-R2 upload.
 *   - `verified`       - admin/staff approved the document.
 *   - `rejected`       - admin/staff rejected the document with notes.
 *                        Company user can re-upload (creates a new row).
 *   - `expired`        - past `expiresAt`. Set automatically by the
 *                        nightly cron sweep (Day 10+).
 *
 * Closed union, app-validated. Same convention as `ComplianceStatus`.
 */
export type DocumentStatus =
  | "pending"
  | "pending_review"
  | "verified"
  | "rejected"
  | "expired";

// -- documents --------------------------------------------------------------
/**
 * Per-company document storage metadata. The file bytes live in
 * Cloudflare R2; this table stores the metadata (filename, size, MIME,
 * issuer-side dates, review state) and the R2 object key (`fileKey`)
 * that lets us mint a presigned GET URL on download.
 *
 * Upload flow (two-step, see Day 9 prompt):
 *   1. Client calls `initiateDocumentUpload` (Chunk 3). Server validates,
 *      RBAC-checks, inserts a row with `status = 'pending'`, returns the
 *      row id + a short-lived presigned PUT URL.
 *   2. Client streams bytes directly to R2 with the presigned URL.
 *      Worker is not involved - saves egress + CPU + sidesteps Workers'
 *      100 MB request limit on large PDFs.
 *   3. Client calls `confirmDocumentUpload` (Chunk 3). Server flips the
 *      row to `status = 'pending_review'` and writes the `document_uploaded`
 *      audit event. This is the moment that "counts" - a row that never
 *      reaches `pending_review` is treated as never having existed by
 *      the rest of the system.
 *
 * Cascade semantics:
 *   - Company deleted -> documents deleted (`ON DELETE CASCADE`). When a
 *     company row is removed, the metadata follows. **The R2 objects are
 *     NOT automatically deleted by this cascade** - we leak them.
 *     Cleaning up R2 alongside a company delete is an action-layer
 *     responsibility, not a DB constraint. Tracked as a follow-up.
 *
 * Verifier FK:
 *   - `reviewedBy` references `users.id` with `ON DELETE SET NULL`. If
 *     the verifying staff member is later deactivated and deleted, the
 *     document row survives with `reviewedBy = NULL`; the `reviewedAt`
 *     timestamp preserves "when this was verified", which is the
 *     load-bearing fact for compliance.
 *
 * Uploader FK:
 *   - `uploadedBy` references `users.id` with `ON DELETE RESTRICT`.
 *     Tighter than `reviewedBy` because every document has an uploader
 *     (mandatory), and we want the admin to consciously reassign or
 *     delete documents before removing the uploading user. Same shape
 *     as how `tenders.publisherCompanyId` uses RESTRICT.
 */
export const documents = sqliteTable(
  "documents",
  {
    /** UUID v7. Generated app-side via `newId()`. */
    id: text("id").primaryKey().$defaultFn(newId),

    /**
     * Owning company. Cascade-deletes the metadata row when a company
     * is removed. See table-level docstring re: R2 object cleanup
     * being an action-layer responsibility, not a DB cascade.
     */
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id, {
        onDelete: "cascade",
        onUpdate: "no action",
      }),

    /** See `DocumentType`. Validated app-side with Zod. */
    documentType: text("document_type").notNull().$type<DocumentType>(),

    /**
     * R2 object key. Format:
     *   `companies/{companyId}/{documentId}/{sanitizedFilename}`
     *
     * Chosen for:
     *   - Per-top-level-prefix lifecycle rules in R2 (companies/* can
     *     get a retention policy distinct from any other top-level
     *     prefix we add later).
     *   - Per-company scoping for offboarding bulk-delete.
     *   - `{documentId}` is the row's UUID, guaranteeing the key is
     *     unique even if two uploads share a filename.
     *
     * Generated by `lib/r2/keys.ts::buildDocumentKey` (Chunk 2).
     * NOT NULL because a row should always carry a key - the key is
     * minted at insert time, even for `pending` rows that don't yet
     * have bytes behind it (the key reserves the target slot in R2).
     */
    fileKey: text("file_key").notNull(),

    /**
     * Original filename as supplied by the client at upload time.
     * Kept verbatim (capped to 255 chars by Zod) for display and for
     * the `Content-Disposition` header on download. The sanitised
     * form lives inside `fileKey`; this column is the human-readable
     * one we show in the UI.
     */
    fileName: text("file_name").notNull(),

    /**
     * MIME type, as supplied by the client and validated against an
     * allow-list (`application/pdf`, `image/png`, `image/jpeg`,
     * `image/webp`) in `lib/documents/schemas.ts`. Stored verbatim so
     * presigned GET URLs can serve the right `Content-Type`.
     */
    mimeType: text("mime_type").notNull(),

    /**
     * File size in bytes. Validated <= 10 MB at the action layer.
     * INTEGER not REAL - exact bytes, not approximate.
     */
    sizeBytes: integer("size_bytes").notNull(),

    /**
     * See `DocumentStatus`. Default `pending` - new rows start in the
     * pre-confirm state. The `confirmDocumentUpload` action moves them
     * to `pending_review` once the R2 PUT completes.
     */
    status: text("status")
      .notNull()
      .$type<DocumentStatus>()
      .default("pending"),

    /**
     * Reviewer's notes when rejecting (or, optionally, when verifying).
     * NULL while no review has happened. Plain text, capped at ~2000
     * chars by Zod at the action layer.
     */
    reviewNotes: text("review_notes"),

    /**
     * The admin/staff user who verified or rejected the document.
     * `ON DELETE SET NULL` - if the reviewer is later removed, the
     * row keeps `reviewedAt` but loses the actor identity, which is
     * acceptable for compliance (the audit log preserves the full
     * trail; this column is a convenience for the detail page).
     */
    reviewedBy: text("reviewed_by").references(() => users.id, {
      onDelete: "set null",
      onUpdate: "no action",
    }),

    /** ISO-8601 UTC. Stamped when status transitions to verified/rejected. */
    reviewedAt: text("reviewed_at"),

    /**
     * ISO-8601 date (YYYY-MM-DD) when the document was issued by its
     * issuing authority (e.g. the GST registration date). NULL when
     * unknown or not applicable.
     */
    issuedOn: text("issued_on"),

    /**
     * ISO-8601 date when the document expires. NULL means "never
     * expires" - applies to documents like PAN cards that don't have
     * a renewal cycle. Indexed for the expiry-sweep cron (Day 10+).
     */
    expiresAt: text("expires_at"),

    /**
     * The user who initiated the upload. RESTRICT semantics - see
     * table-level docstring. Mandatory column.
     */
    uploadedBy: text("uploaded_by")
      .notNull()
      .references(() => users.id, {
        onDelete: "restrict",
        onUpdate: "no action",
      }),

    /**
     * ISO-8601 UTC. Stamped by SQLite on insert (i.e. at upload-
     * initiation time). For audit purposes this is "when the row was
     * created"; the moment bytes actually landed in R2 is implicit in
     * the status transition from `pending` to `pending_review`.
     */
    uploadedAt: text("uploaded_at")
      .notNull()
      .default(sql`(datetime('now'))`),

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
    // "Show me all documents for this company" - the company detail
    // page's Documents tab (Day 10) hits this on every render.
    index("documents_company_id_idx").on(table.companyId),

    // Filter the global documents list by review state, and used by
    // the cron to find `pending` rows older than the sweep horizon.
    index("documents_status_idx").on(table.status),

    // The expiry-sweep cron query: "find all documents expiring in N
    // days that we haven't yet reminded about." Date comparisons on
    // ISO-8601 strings are lexicographic-equals-chronological, so a
    // plain B-tree index works without any custom collation.
    index("documents_expires_at_idx").on(table.expiresAt),

    // "Does this company have a verified GST certificate?" - the
    // compliance-status calculation walks (company, type) combinations.
    // Composite index puts company first because that's how reads
    // narrow before sub-filtering by type.
    index("documents_company_type_idx").on(
      table.companyId,
      table.documentType,
    ),
  ],
);

/** Inferred insert type - use for Zod parsing / insert validation. */
export type NewDocument = typeof documents.$inferInsert;

/** Inferred select type - what a row looks like when read from the DB. */
export type Document = typeof documents.$inferSelect;

// -- Shared types: reminders_sent ------------------------------------------
/**
 * One of the four reminder slots a verified-with-expiry document can
 * land in as it approaches `expires_at`. The expiry-sweep cron buckets
 * each in-window row into exactly one of these:
 *
 *   - `T-30` — 15..30 days until expiry (the outer "heads up" reminder)
 *   - `T-14` — 8..14 days  ("you should renew now")
 *   - `T-7`  — 2..7 days   ("this is getting urgent")
 *   - `T-1`  — 0..1 days   ("last call")
 *
 * Strict closed union. The expiry-sweep cron writes exactly one row per
 * (document, kind) pair via the `(document_id, reminder_kind)` unique
 * index — once a kind has been sent, subsequent same-day or same-week
 * runs skip it. When a document crosses a slot boundary (e.g. day 8
 * tomorrow becomes day 7), the new kind is freshly eligible because
 * its `(document_id, reminder_kind)` tuple has never been seen.
 */
export type ReminderKind = "T-30" | "T-14" | "T-7" | "T-1";

// -- reminders_sent --------------------------------------------------------
/**
 * Dedup ledger for document expiry-reminder emails.
 *
 * Before Day 12 the expiry-sweep cron would re-send the same reminder
 * email every day a row sat inside the 30-day window, so a 30-days-out
 * document generated 30 emails to the same contact. This table is the
 * dedup substrate: one row per (document, reminder-slot) pair, written
 * by the cron after a successful send. A subsequent same-day run finds
 * the existing row and skips.
 *
 * Cascade: ON DELETE CASCADE on `document_id` — if the underlying
 * document is removed (or its company is deleted, which cascades to
 * documents which cascades here), the dedup history goes with it. The
 * dedup history has no value outside the lifetime of its referent.
 *
 * No `updated_at`: rows are append-only. The cron never updates these;
 * a missed send simply doesn't insert a row, leaving the slot eligible
 * for the next run to retry.
 *
 * Schema reference: docs/05-database-schema.md (the doc lists this
 * column as `reminder_type`; the code calls it `reminder_kind` — the
 * Day 12 schema doc update aligns the spec to the code per the
 * "code wins when docs disagree" convention).
 */
export const remindersSent = sqliteTable(
  "reminders_sent",
  {
    /** UUID v7. Generated app-side via `newId()`. */
    id: text("id").primaryKey().$defaultFn(newId),

    /**
     * The document this reminder was sent for. Cascade-delete when the
     * document row is removed (no point keeping dedup history for a
     * row that no longer exists).
     */
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, {
        onDelete: "cascade",
        onUpdate: "no action",
      }),

    /**
     * Which slot this reminder filled. See `ReminderKind`. SQLite has
     * no native enums; the `$type<>` narrows the TypeScript surface and
     * the cron is the only writer, so a CHECK constraint would be
     * belt-and-braces. Same convention as `DocumentStatus` etc.
     */
    reminderKind: text("reminder_kind").notNull().$type<ReminderKind>(),

    /** ISO-8601 UTC timestamp of when the email actually went out. */
    sentAt: text("sent_at").notNull(),

    /** ISO-8601 UTC. Set by SQLite default on insert. */
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    // The dedup primitive: at most one row per (document, kind). The
    // cron uses this index both for the "already sent?" lookup and as
    // the conflict target — a duplicate insert (e.g. from two cron
    // workers racing on the same minute) surfaces as a UNIQUE failure
    // that the handler treats as "fine, somebody else got there first".
    uniqueIndex("reminders_sent_document_kind_unique_idx").on(
      table.documentId,
      table.reminderKind,
    ),
    // "Show me everything sent for this document" — used during
    // debugging and on the eventual per-document audit panel.
    index("reminders_sent_document_id_idx").on(table.documentId),
  ],
);

/** Inferred insert type - use for Zod parsing / insert validation. */
export type NewReminderSent = typeof remindersSent.$inferInsert;

/** Inferred select type - what a row looks like when read from the DB. */
export type ReminderSent = typeof remindersSent.$inferSelect;

// -- email_verification_tokens (Day 15) ------------------------------------
/**
 * Single-use tokens for the post-registration "verify your email" flow.
 *
 * The raw token (32 bytes, hex-encoded — see lib/auth/tokens.ts) is sent
 * in the verification email link. The DB stores only its SHA-256 hash,
 * so a database leak does not expose still-valid verification links.
 * The hash IS the lookup key — `consumeEmailVerificationToken` re-hashes
 * the URL-supplied raw token and looks it up by hash.
 *
 * Lifecycle:
 *   - `mintEmailVerificationToken(userId)` inserts a row with `usedAt =
 *     NULL` and `expiresAt = now + 24h`. Returns the raw token to the
 *     caller — the only time the raw value exists outside the user's
 *     inbox.
 *   - `consumeEmailVerificationToken(rawToken)` looks up by hash, checks
 *     not-yet-used + not-yet-expired, sets `usedAt`, and flips the user's
 *     `emailVerifiedAt`. Both writes happen in one statement chain.
 *
 * Cascade: ON DELETE CASCADE on `userId`. A deleted user's pending
 * tokens go with them — no value in keeping orphaned tokens.
 */
export const emailVerificationTokens = sqliteTable(
  "email_verification_tokens",
  {
    /** UUID v7. Generated app-side via `newId()`. */
    id: text("id").primaryKey().$defaultFn(newId),

    /**
     * The user this token verifies. Cascade-delete when the user is
     * removed — no value in keeping orphaned tokens.
     */
    userId: text("user_id")
      .notNull()
      .references(() => users.id, {
        onDelete: "cascade",
        onUpdate: "no action",
      }),

    /**
     * SHA-256 hex of the raw token. NEVER store the raw token. The hash
     * IS the lookup key — `consumeEmailVerificationToken` re-hashes the
     * URL-supplied raw token and looks it up here.
     */
    tokenHash: text("token_hash").notNull(),

    /** ISO-8601 UTC expiry (24h after mint by convention). */
    expiresAt: text("expires_at").notNull(),

    /** ISO-8601 UTC. Set by SQLite default on insert. */
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),

    /**
     * ISO-8601 UTC. Stamped by `consumeEmailVerificationToken` when the
     * token is exchanged for the `emailVerifiedAt` flip. NULL while the
     * token is still spendable.
     */
    usedAt: text("used_at"),
  },
  (table) => [
    // Lookup key — every consume query hits this index.
    uniqueIndex("email_verification_tokens_token_hash_unique_idx").on(
      table.tokenHash,
    ),
    // "Show me this user's outstanding tokens" — used by the resend flow
    // and by housekeeping that purges used/expired rows.
    index("email_verification_tokens_user_id_idx").on(table.userId),
  ],
);

/** Inferred insert type. */
export type NewEmailVerificationToken =
  typeof emailVerificationTokens.$inferInsert;
/** Inferred select type. */
export type EmailVerificationToken =
  typeof emailVerificationTokens.$inferSelect;

// -- password_reset_tokens (Day 15) -----------------------------------------
/**
 * Single-use tokens for the "forgot password" flow.
 *
 * Same shape as `email_verification_tokens` (column-for-column) but with
 * a much shorter default expiry (1 hour) — a stolen password-reset link
 * is a higher-stakes outcome than a stolen verification link. Lives in
 * its own table rather than sharing one with `email_verification_tokens`
 * because the two flows differ in expiry, downstream effect, and audit
 * categorisation; a shared table with a `kind` discriminator would
 * obscure that.
 *
 * Lifecycle:
 *   - `mintPasswordResetToken(userId)` inserts a row, returns the raw
 *     URL-safe token for embedding in the email link.
 *   - `consumePasswordResetToken(rawToken, newHash)` looks up by hash,
 *     validates not-used + not-expired, writes the new password hash on
 *     `users`, stamps `used_at`, AND invalidates every other unused
 *     reset token for the same user (defence in depth — limits blast
 *     radius if a user requested two resets and the first link was
 *     intercepted).
 *
 * Cascade: ON DELETE CASCADE on `userId`, same as email_verification.
 */
export const passwordResetTokens = sqliteTable(
  "password_reset_tokens",
  {
    /** UUID v7. Generated app-side via `newId()`. */
    id: text("id").primaryKey().$defaultFn(newId),

    /** Cascade-delete with the user. */
    userId: text("user_id")
      .notNull()
      .references(() => users.id, {
        onDelete: "cascade",
        onUpdate: "no action",
      }),

    /** SHA-256 hex of the raw token. NEVER store raw. */
    tokenHash: text("token_hash").notNull(),

    /** ISO-8601 UTC expiry. 1 hour after mint by convention. */
    expiresAt: text("expires_at").notNull(),

    /** ISO-8601 UTC. Set by SQLite default on insert. */
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),

    /**
     * ISO-8601 UTC. Stamped at consume time. Sibling invalidation also
     * writes this column — see consume helper docstring.
     */
    usedAt: text("used_at"),
  },
  (table) => [
    uniqueIndex("password_reset_tokens_token_hash_unique_idx").on(
      table.tokenHash,
    ),
    index("password_reset_tokens_user_id_idx").on(table.userId),
  ],
);

/** Inferred insert type. */
export type NewPasswordResetToken = typeof passwordResetTokens.$inferInsert;
/** Inferred select type. */
export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;

// -- Shared types: projects -------------------------------------------------
/**
 * Lifecycle state of a project. The five values cover the operational
 * arc Consultway tracks for the projects they consult on:
 *
 *   - `planning`  — project record exists, work hasn't started.
 *                   Initial state on create. Fields are still being
 *                   negotiated; budgets / dates may move.
 *   - `active`    — execution is underway. The day-to-day state.
 *   - `on_hold`   — paused for external reasons (client decision,
 *                   funding delay, regulatory hold). Reversible to
 *                   active.
 *   - `completed` — wrapped successfully. Terminal — no further
 *                   transitions from here.
 *   - `cancelled` — terminated before completion (client withdrawal,
 *                   force majeure, etc.). Terminal.
 *
 * Validated app-side via Zod + TypeScript union — SQLite has no native
 * enums. Transitions are gated by `lib/projects/state-machine.ts`
 * (Chunk 3).
 */
export type ProjectStatus =
  | "planning"
  | "active"
  | "on_hold"
  | "completed"
  | "cancelled";

// -- projects ---------------------------------------------------------------
/**
 * Projects the Consultway team is consulting on for a registered
 * company. A project may be (a) created from scratch via
 * `createProject`, or (b) born out of a tender that was awarded to a
 * company via `createProjectFromTender` — in which case `tenderId`
 * carries the link back to the originating tender row.
 *
 * Cascade semantics:
 *
 *   - `tenderId` → `tenders.id` ON DELETE SET NULL. Losing the tender
 *     doesn't lose the project; the project survives as "orphaned from
 *     tender". The originating tender is helpful context but the
 *     project's value is its own audit + financial trail, which
 *     continues to exist independently of whether the source tender
 *     row is still around. (In practice tenders aren't deletable past
 *     `draft`, but the SET NULL is the right default semantically.)
 *
 *   - `companyId` → `companies.id` ON DELETE RESTRICT. Same precedent
 *     as `tenders.publisherCompanyId`: losing the owning company would
 *     break the audit trail. Admins must clean up projects before
 *     deleting their owning company.
 *
 * Internal notes:
 *
 *   - `internalNotes` is staff-only. The action layer strips this
 *     field on company-role reads, same convention as
 *     `companies.internalNotes` and `tenders.internalNotes`.
 *
 * Why `budgetInr` (and not `budgetAmount`):
 *
 *   - Mirrors `tenders.minAnnualTurnoverInr` exactly — same INTEGER
 *     paise-less whole-rupees shape. Currency is fixed at INR for
 *     Phase 2; multi-currency, when it lands, will be a Phase-3
 *     follow-up that adds a `currency` column on the same table
 *     rather than retrofitting the name.
 */
export const projects = sqliteTable(
  "projects",
  {
    /** UUID v7. Generated app-side via `newId()`. */
    id: text("id").primaryKey().$defaultFn(newId),

    /** Display name. Indexed for search. */
    name: text("name").notNull(),

    /** Long-form description. Plain text. */
    description: text("description"),

    /**
     * The tender this project was created from, when applicable. NULL
     * for projects created directly via `createProject`. SET NULL on
     * tender delete — the project's identity is its own; the tender is
     * historical context.
     */
    tenderId: text("tender_id").references(() => tenders.id, {
      onDelete: "set null",
      onUpdate: "no action",
    }),

    /**
     * Owning company. RESTRICT on delete so a company that owns
     * projects can't be removed out from under them. Same shape as
     * `tenders.publisherCompanyId`.
     */
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id, {
        onDelete: "restrict",
        onUpdate: "no action",
      }),

    /**
     * See `ProjectStatus`. Validated app-side with Zod. Default
     * "planning" — every new project starts here regardless of what
     * the caller sends (the action forces this).
     */
    status: text("status")
      .notNull()
      .$type<ProjectStatus>()
      .default("planning"),

    /**
     * ISO-8601 date (YYYY-MM-DD) when the project starts. NULL means
     * "not yet scheduled". Stored as TEXT — date-only, no time
     * component (same convention as `tenders.openingDate`).
     */
    startDate: text("start_date"),

    /**
     * ISO-8601 date when the project is expected to end. NULL means
     * "open-ended". Cross-validated against `startDate` at the action
     * layer — startDate ≤ endDate when both present.
     */
    endDate: text("end_date"),

    /**
     * Budget in INR (whole rupees, no paise). Same INTEGER-not-REAL
     * choice as `tenders.minAnnualTurnoverInr` — exact rupees up to
     * ~9.2 quintillion, well above any realistic figure. NULL means
     * "budget not set".
     */
    budgetInr: integer("budget_inr"),

    /**
     * Staff-only working notes. Never shown to company-role users —
     * the action layer strips this field on company-scoped reads.
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
    // "All projects for this company" — the company detail page and
    // the company-role list page both hit this index.
    index("projects_company_id_idx").on(table.companyId),
    // Status filter on the list page.
    index("projects_status_idx").on(table.status),
    // "Was this tender already turned into a project?" — the Chunk-3
    // tender-detail bridge button consults this to decide between
    // "Create project from this tender" and "View linked project".
    index("projects_tender_id_idx").on(table.tenderId),
    // Composite for the "active projects for this company" panels —
    // company narrows first, status sub-filters.
    index("projects_company_status_idx").on(table.companyId, table.status),
  ],
);

/** Inferred insert type — use for Zod parsing / insert validation. */
export type NewProject = typeof projects.$inferInsert;

/** Inferred select type — what a row looks like when read from the DB. */
export type Project = typeof projects.$inferSelect;

// -- Shared types: transactions ---------------------------------------------
/**
 * Kind of a financial transaction tracked against a company (and
 * optionally a project). Closed union; SQLite has no native enums so the
 * gate lives at the action / Zod layer.
 *
 *   - `invoice`  — money the company owes us (or owes the project's
 *                  counterparty). Recorded when an invoice is issued.
 *   - `payment`  — money received against an invoice.
 *   - `expense`  — money out: vendor bills, costs incurred on the
 *                  project, office overheads at the company level.
 *   - `advance`  — money out, against work yet to be performed
 *                  (advance to a contractor, retainer payment, etc.).
 *   - `refund`   — money out, against work already paid for and now
 *                  being reversed.
 *
 * Day 19 brief lists five values; staying tight on the closed set keeps
 * the audit log and rollup queries deterministic. New types are
 * deliberate schema-and-doc changes, not free-form strings.
 */
export type TransactionType =
  | "invoice"
  | "payment"
  | "expense"
  | "advance"
  | "refund";

// -- transactions -----------------------------------------------------------
/**
 * Admin-only financial ledger. Each row records a single recorded
 * monetary event against a company (always) and a project (sometimes —
 * company-level overheads like office rent don't belong to any project).
 *
 * **Admin-only forever.** Staff and company-role users cannot read or
 * write this table — enforced at the action layer (`requireAdmin`) and
 * at the page/route-handler layer (page-level redirect / 403). See
 * `docs/08-rbac-matrix.md § Transactions`.
 *
 * Money column shape:
 *
 *   - `amountPaise` is an **INTEGER** count of **paise** (1 INR = 100
 *     paise). NEVER use REAL/FLOAT for money — IEEE-754 loses precision
 *     on rupees-and-paise arithmetic. INTEGER paise gives exact arithmetic
 *     up to ~9.2 quintillion paise = ~92 trillion crore, which is well
 *     above any realistic figure.
 *   - `currency` is fixed at `'INR'` for Phase 1 / Phase 2 (the action
 *     layer Zod-refuses anything else). The column exists for forward-
 *     compat with multi-currency in Phase 3+ — schema landing now means
 *     no migration churn when that feature lands.
 *
 * Distinct from `projects.budgetInr`:
 *
 *   - Projects store BUDGETS in **whole rupees** (planning figures —
 *     50 paise is noise on a multi-crore budget).
 *   - Transactions store ACTUALS in **paise** (where 50 paise matters
 *     for reconciliation against invoices).
 *
 * Two precision regimes intentionally. The formatter in `lib/format/inr.ts`
 * is the boundary between the two.
 *
 * Cascade semantics:
 *
 *   - `companyId` → `companies.id` ON DELETE RESTRICT. Losing the
 *     counterparty out from under outstanding transactions would break
 *     the ledger. Same shape as `tenders.publisherCompanyId`.
 *   - `projectId` → `projects.id` ON DELETE RESTRICT. Asymmetric with
 *     `users.companyId` (SET NULL) — a transaction exists because of the
 *     project; losing the project out from under it would orphan a
 *     row whose semantics depend on the project context. Forces a
 *     deliberate cleanup before project deletion. (Combined with Day-16's
 *     deferred `deleteProject`, the cascade is academic for now but
 *     gets the invariant right at insert time.)
 *
 * Cross-FK invariant (enforced at the action layer, not the DB):
 *
 *   - If `projectId` is set, the referenced project's `companyId` MUST
 *     equal this row's `companyId`. A transaction "on" project X for
 *     company Y must have Y own X. The DB can't express the join-key
 *     equality as a constraint; the action checks it on every
 *     create/update.
 *
 * `referenceNumber` semantics:
 *
 *   - Optional invoice number / payment reference / cheque number etc.
 *   - UNIQUE when present (SQLite NULL-distinct semantics; multiple NULLs
 *     coexist, any non-null value must be unique across the table).
 *     Same shape as `tenders.referenceNumber` and `companies.gstNumber`.
 *
 * `occurredOn` vs `createdAt`:
 *
 *   - `occurredOn` is the business date the transaction is dated to
 *     (invoice date, payment date, etc.). ISO-8601 date-only, no time
 *     component — transactions don't have a clock-time of day.
 *   - `createdAt` is when the row was inserted into the platform. Could
 *     be days or weeks after `occurredOn` for back-dated entries.
 *
 * `internalNotes`:
 *
 *   - Staff-only on every other table, but since the whole transactions
 *     module is admin-only the field is moot. Kept for symmetry with
 *     the rest of the codebase and to ease a hypothetical future widening
 *     of read access.
 */
export const transactions = sqliteTable(
  "transactions",
  {
    /** UUID v7. Generated app-side via `newId()`. */
    id: text("id").primaryKey().$defaultFn(newId),

    /**
     * See `TransactionType`. Validated app-side with Zod against the
     * closed union. SQLite has no native enums; the `$type<>` narrows
     * the TypeScript surface.
     */
    type: text("type").notNull().$type<TransactionType>(),

    /**
     * Amount in **paise** (1 INR = 100 paise). INTEGER, never REAL —
     * see table-level docstring re: money precision. Always positive at
     * the action layer; a refund or expense is encoded by `type`, not by
     * a negative sign. Zod-refuses `amountPaise <= 0`.
     */
    amountPaise: integer("amount_paise").notNull(),

    /**
     * Currency code. Default `'INR'`. The column exists for Phase-3
     * multi-currency; today the action-layer Zod refines to literal
     * `'INR'` only.
     */
    currency: text("currency").notNull().default("INR"),

    /**
     * Counterparty company. RESTRICT on delete so a company that's
     * party to outstanding transactions can't be removed out from
     * under them.
     */
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id, {
        onDelete: "restrict",
        onUpdate: "no action",
      }),

    /**
     * Optional project link. NULLABLE because company-level overheads
     * (office rent, GST filing fee) aren't tied to any project. RESTRICT
     * on project delete — see table-level commentary for the asymmetry
     * with `users.companyId`.
     *
     * Cross-FK invariant enforced at the action layer: when set, the
     * project's `companyId` must equal this row's `companyId`.
     */
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "restrict",
      onUpdate: "no action",
    }),

    /**
     * ISO-8601 date (YYYY-MM-DD) the transaction is dated to (invoice
     * date / payment date / etc.). NOT NULL — every transaction has a
     * business date even if it's the day it was recorded.
     */
    occurredOn: text("occurred_on").notNull(),

    /**
     * Optional reference number — invoice number, payment reference,
     * cheque number, etc. NULL-distinct UNIQUE semantics (multiple
     * NULLs allowed; any non-null must be unique).
     */
    referenceNumber: text("reference_number").unique(),

    /** Free-form notes. Visible to admin viewers on the detail page. */
    notes: text("notes"),

    /**
     * Staff-only field by convention; the whole module is admin-only so
     * the distinction is moot today. Kept for symmetry with the rest of
     * the codebase.
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
    // Per-company rollups + the company filter on the list page.
    index("transactions_company_id_idx").on(table.companyId),
    // Per-project rollups + the project filter on the list page.
    index("transactions_project_id_idx").on(table.projectId),
    // Type filter on the list page.
    index("transactions_type_idx").on(table.type),
    // Sort + range filter on `occurredOn` (default list sort is newest
    // first; the date-range filter scans this).
    index("transactions_occurred_on_idx").on(table.occurredOn),
    // Composite for the per-company-by-type rollup query.
    index("transactions_company_type_idx").on(table.companyId, table.type),
    // Composite for the per-project-by-type rollup query.
    index("transactions_project_type_idx").on(table.projectId, table.type),
  ],
);

/** Inferred insert type — use for Zod parsing / insert validation. */
export type NewTransaction = typeof transactions.$inferInsert;

/** Inferred select type — what a row looks like when read from the DB. */
export type Transaction = typeof transactions.$inferSelect;

// -- user_preferences (Day 25) ----------------------------------------------
/**
 * Per-user UI + notification preferences for the Settings page.
 *
 * One row per user, keyed by `userId` (also the primary key). Created on
 * demand the first time the user saves something on /dashboard/settings —
 * lazy creation keeps the table light during a Day-1 user surge and
 * means missing rows are never an error case (the action layer just
 * upserts).
 *
 * Why a dedicated table rather than columns on `users`?
 *   - These knobs are display-layer only — adding 8+ TEXT/INTEGER columns
 *     to `users` would bloat every read of a row whose primary purpose is
 *     auth / RBAC.
 *   - Future preferences (locale, default landing page, table density
 *     per module) can land here without another schema migration on the
 *     hot path.
 *
 * Theme id is stored as TEXT and validated app-side against the catalog
 * in `lib/themes.ts` — SQLite has no enums, and the catalog can grow
 * without a column constraint change.
 *
 * Cascade: ON DELETE CASCADE on `userId`. When a user is removed, their
 * preferences are noise — keep them around and we'd leak rows forever.
 */
export const userPreferences = sqliteTable(
  "user_preferences",
  {
    /**
     * FK + primary key. One preferences row per user, by construction.
     * Avoids an extra surrogate id and gives us upsert-by-user-id for free.
     */
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, {
        onDelete: "cascade",
        onUpdate: "no action",
      }),

    // ── Appearance ────────────────────────────────────────────────────
    /**
     * Selected palette. One of the ids in `lib/themes.ts::THEME_IDS`.
     * Default mirrors `DEFAULT_THEME` ("warm-ambient"). Validated app-side
     * — SQLite has no enums, and we don't want a CHECK constraint
     * fighting every palette addition.
     */
    themeId: text("theme_id").notNull().default("warm-ambient"),

    /** UI density — "comfortable" or "compact". */
    density: text("density")
      .notNull()
      .default("comfortable")
      .$type<"comfortable" | "compact">(),

    /** Reduced-motion override. Independent of the OS-level setting. */
    reducedMotion: integer("reduced_motion", { mode: "boolean" })
      .notNull()
      .default(false),

    // ── Notifications — email digests ─────────────────────────────────
    /** Weekly Monday digest. Default on. */
    weeklyDigest: integer("weekly_digest", { mode: "boolean" })
      .notNull()
      .default(true),

    /** First-of-month report. Default off (opt-in). */
    monthlyReport: integer("monthly_report", { mode: "boolean" })
      .notNull()
      .default(false),

    // ── Notifications — real-time alerts ──────────────────────────────
    /** 30/14/7-day document-expiry heads-up. Default on. */
    documentExpiry: integer("document_expiry", { mode: "boolean" })
      .notNull()
      .default(true),

    /** New-tender alerts matching the user's eligibility. Default on. */
    tenderAlerts: integer("tender_alerts", { mode: "boolean" })
      .notNull()
      .default(true),

    /** Assigned-to-X notifications. Default on. */
    assignmentAlerts: integer("assignment_alerts", { mode: "boolean" })
      .notNull()
      .default(true),

    /** Critical incidents (failed payments, compliance flags). Default on. */
    incidentAlerts: integer("incident_alerts", { mode: "boolean" })
      .notNull()
      .default(true),

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
  // No secondary indexes — userId is the PK, every read hits it.
);

/** Inferred insert type — use for Zod parsing / insert validation. */
export type NewUserPreferences = typeof userPreferences.$inferInsert;

/** Inferred select type — what a row looks like when read from the DB. */
export type UserPreferences = typeof userPreferences.$inferSelect;

// -- Notifications ----------------------------------------------------------
/**
 * Per-user in-app notification feed. One row per notification delivered to
 * one user — the user-facing bell feed ("things you should see").
 *
 * Distinct from its two siblings:
 *   - `user_preferences` governs *email-channel* opt-ins, not this feed.
 *   - `audit_log` is an admin-facing activity trail keyed by actor; this is
 *     recipient-keyed and user-facing.
 *
 * Created programmatically by domain actions (never a user-facing mutation)
 * via `lib/notifications/notify.ts::createNotification`, co-located with the
 * email/audit side effects at each event site. Reads/writes are scoped to the
 * owning user only (RBAC matrix § Notifications).
 *
 * `read_at` NULL == unread; stamping it marks the row read. Read rows are
 * kept (no delete-on-read) so the feed + history survive — pruning old read
 * rows is a future retention concern, not a v1 one.
 */
export const notifications = sqliteTable(
  "notifications",
  {
    /** UUID v7. Generated app-side via `newId()`. */
    id: text("id").primaryKey().$defaultFn(newId),

    /**
     * The recipient. FK → users.id, cascade-deleted with the user (a
     * notification is meaningless once its owner is gone). Mirrors the
     * `user_preferences` FK idiom.
     */
    userId: text("user_id")
      .notNull()
      .references(() => users.id, {
        onDelete: "cascade",
        onUpdate: "no action",
      }),

    /**
     * The notification kind. Plain text; validated app-side against the
     * `NotificationType` union in `lib/notifications/types.ts` (enum-less
     * SQLite convention, same as `audit_log.action`). Drives the feed icon.
     */
    type: text("type").notNull(),

    /** Short headline, e.g. "Company verified". Rendered prominent in the feed. */
    title: text("title").notNull(),

    /** Optional one-line detail under the title. */
    body: text("body"),

    /**
     * Optional in-app deep link (relative path, e.g.
     * "/dashboard/companies/<id>"). Clicking the notification routes here.
     * NULL == no target.
     */
    link: text("link"),

    /**
     * ISO-8601 UTC when the user marked it read. NULL == unread. Indexed
     * with `user_id` so the unread-count badge is a single index seek.
     */
    readAt: text("read_at"),

    /** ISO-8601 UTC. Stamped by SQLite on insert. The feed orders by this desc. */
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    // Unread-count badge + "my unread" filter — (user_id, read_at).
    index("notifications_user_read_idx").on(table.userId, table.readAt),
    // Feed ordering — newest-first per user.
    index("notifications_user_created_idx").on(table.userId, table.createdAt),
  ],
);

/** Inferred insert type — used by `createNotification` when staging a row. */
export type NewNotification = typeof notifications.$inferInsert;

/**
 * Inferred select type — what `listNotifications` returns. Named `*Row`
 * (not `Notification`) to avoid shadowing the DOM `Notification` global in
 * any module that imports it.
 */
export type NotificationRow = typeof notifications.$inferSelect;
