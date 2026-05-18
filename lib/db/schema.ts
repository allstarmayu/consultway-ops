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
 *
 * Validated app-side via Zod + TypeScript union - SQLite has no native enums.
 */
export type ComplianceStatus =
  | "pending"
  | "compliant"
  | "non_compliant"
  | "expired";

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
 * Important deferred item: server-side enforcement of `minAnnualTurnoverInr`
 * is **not** wired in this chunk. The `companies` table doesn't carry an
 * `annualTurnover` field yet (Day-3 schema omitted it). The column ships
 * here and is shown in the UI; the eligibility gate enforces it once the
 * companies field lands. See `lib/tenders/actions.ts::applyToTender` for
 * the TODO marker.
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
     * NOTE: server-side enforcement of this gate is deferred. The
     * `companies` table doesn't have an `annualTurnover` column yet -
     * shipped in a follow-up chunk.
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
