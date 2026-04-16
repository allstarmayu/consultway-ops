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
