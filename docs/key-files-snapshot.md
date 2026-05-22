# Key Files Snapshot

> **_AUTO-GENERATED — DO NOT EDIT._** Regenerate via `pnpm snapshot`.

_Last generated: 2026-05-22_

This file is the **planning reference** for Claude. It contains the full verbatim contents of the highest-leverage files in the codebase — schema, env, auth, logger, and one canonical example of each pattern (Server Action module, domain form, list page, detail page, form primitives, dialog).

Rules for using this file:

- Use it to plan changes that touch any of the patterns above.
- **Do not edit a file by trusting this snapshot alone if the file is not listed here.** Ask for the current contents.
- When this snapshot disagrees with the actual file on disk, **the file wins**. Regenerate with `pnpm snapshot`.
- The curated list lives in `scripts/snapshot-config.ts`. Edit there when patterns change.

---

## Contents

1. [Core Foundations](#core-foundations)
2. [Authentication](#authentication)
3. [Audit Log](#audit-log)
4. [Server Action Pattern — Reference Implementation](#server-action-pattern-reference-implementation)
5. [Form Primitives](#form-primitives)
6. [Domain Form — Reference Implementation](#domain-form-reference-implementation)
7. [Dialogs and Confirmation UI](#dialogs-and-confirmation-ui)
8. [Table + Pagination Primitives](#table-pagination-primitives)
9. [Dashboard Shell](#dashboard-shell)
10. [List + Detail Page Pattern — Reference Implementation](#list-detail-page-pattern-reference-implementation)
11. [Auth Pages](#auth-pages)
12. [Config](#config)

---

## Core Foundations

These are the files imported by almost every feature. Touch with care — a change here ripples across the codebase.

### `.env.example`

```env
# ───────────────────────────────────────────────────────────────────
# Consultway Ops — environment variables
#
# Copy to .env.local for development. Never commit .env.local.
# Production/staging secrets live in Cloudflare (see docs/09-deployment.md).
#
# Every var listed here is read by lib/env.ts via a Zod schema. If you
# add a new one:
#   1. Add it below with a placeholder
#   2. Add it to the schema in lib/env.ts
#   3. Set it in Cloudflare secrets before deploying
# ───────────────────────────────────────────────────────────────────

# ── Core ──────────────────────────────────────────────────────────
NODE_ENV=development
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_APP_NAME="Consultway Ops"

# ── Secrets ───────────────────────────────────────────────────────
# Generate each with: openssl rand -base64 32
# Dev has safe defaults in lib/env.ts — these overrides are optional
# locally but REQUIRED in staging/prod.

# Signs session JWTs. Rotating invalidates all active sessions.
JWT_SECRET=replace-me-generate-with-openssl

# Added to every password before bcrypt hashing. Rotating INVALIDATES
# ALL PASSWORDS IN THE DATABASE — treat this as a stable secret.
PASSWORD_PEPPER=replace-me-generate-with-openssl

# ── Database ──────────────────────────────────────────────────────
# Local dev path to the SQLite file. In production, the D1 binding
# comes from wrangler.jsonc — this var is unused in Workers runtime.
DATABASE_URL=./.wrangler/consultway-local.sqlite

# ── Observability ─────────────────────────────────────────────────
# Accepted: debug | info | warn | error
LOG_LEVEL=info

# ── Email (Resend) — added in a later chunk ───────────────────────
# Uncomment and fill when we wire up transactional email.
# RESEND_API_KEY=re_test_replace_me
# EMAIL_FROM="Consultway <noreply@consultway.local>"
# EMAIL_REPLY_TO=support@consultway.local

# ── Rate limiting — added in a later chunk ────────────────────────
# RATE_LIMIT_PUBLIC_RPM=20
# RATE_LIMIT_AUTH_RPM=120

# ── Cron — added in a later chunk ─────────────────────────────────
# CRON_SECRET=replace-me-generate-with-openssl

# ── Dev conveniences ──────────────────────────────────────────────
# Set to "1" to bypass email verification locally.
DEV_SKIP_EMAIL_VERIFY=0
```

### `lib/env.ts`

```typescript
/**
 * Environment variable validation.
 *
 * All env-var access in the app goes through this module. Import `env`
 * (not `process.env`) from anywhere else — it's pre-validated and typed.
 *
 * Validation runs at module load time (first import). Missing or
 * malformed vars cause an immediate process crash with a clear error,
 * which is what we want — better to fail at boot than 10 layers deep
 * in a request handler.
 *
 * @module lib/env
 */
import { z } from "zod";

/**
 * Schema for all environment variables the app reads.
 *
 * Keep in sync with `.env.example`. When adding a new var:
 *   1. Add it to `.env.example` with a placeholder
 *   2. Add it here with the right Zod validator
 *   3. Add it to the Cloudflare dashboard (staging + prod) before deploying
 */
const envSchema = z.object({
  // ── Core ────────────────────────────────────────────────────────────
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  NEXT_PUBLIC_APP_NAME: z.string().default("Consultway Ops"),

  // ── Secrets (32+ chars, generated via `openssl rand -base64 32`) ────
  JWT_SECRET: z
    .string()
    .min(32, "JWT_SECRET must be at least 32 characters")
    .default(
      // Dev-only fallback so `pnpm dev` works out-of-the-box after clone.
      // Production MUST set a real value via Cloudflare secrets.
      "dev-only-jwt-secret-please-replace-in-production-environments",
    ),
  PASSWORD_PEPPER: z
    .string()
    .min(16, "PASSWORD_PEPPER must be at least 16 characters")
    .default("dev-only-pepper-replace-in-prod"),

  // ── Database ────────────────────────────────────────────────────────
  // Only used by drizzle-kit (CLI) and local dev. In Workers runtime,
  // the DB binding comes from env.DB (wrangler.jsonc), not this path.
  DATABASE_URL: z.string().default("./.wrangler/consultway-local.sqlite"),

  // ── Observability ───────────────────────────────────────────────────
  LOG_LEVEL: z
    .enum(["debug", "info", "warn", "error"])
    .default("info"),
});

/**
 * Parsed + validated env.
 *
 * Throws at module load if any required var is missing. Error message
 * includes the field path so it's easy to trace.
 */
function parseEnv(): z.infer<typeof envSchema> {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");

    // eslint-disable-next-line no-console
    console.error(`\n❌ Invalid environment variables:\n${issues}\n`);
    throw new Error("Environment validation failed. See errors above.");
  }

  return result.data;
}

/** Validated environment. Prefer this over `process.env` everywhere. */
export const env = parseEnv();

/** Convenience boolean flags derived from NODE_ENV. */
export const isDev = env.NODE_ENV === "development";
export const isProd = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";
```

### `lib/logger.ts`

```typescript
/**
 * Structured logger that works in both Node and Edge runtimes.
 *
 * Why not Pino? Pino uses Node worker threads internally, which aren't
 * available in Cloudflare Workers / Next.js Edge runtime (where our
 * middleware and some route handlers will run). This logger is runtime-
 * agnostic: pretty-printed in dev, JSON lines in prod, no dependencies.
 *
 * Usage:
 *   import { logger } from '@/lib/logger';
 *   logger.info('user logged in', { userId: 'abc123' });
 *   logger.error('db query failed', { err, query: 'select ...' });
 *
 * Create a child logger with bound context:
 *   const log = logger.child({ module: 'auth' });
 *   log.info('starting sign-in');  // includes { module: 'auth' }
 *
 * @module lib/logger
 */
import { env, isProd } from "./env";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

// ANSI color codes for pretty dev output. Ignored in prod (JSON lines).
const COLORS = {
  debug: "\x1b[90m", // grey
  info: "\x1b[36m", // cyan
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
  reset: "\x1b[0m",
  dim: "\x1b[2m",
} as const;

type LogContext = Record<string, unknown>;

/**
 * Single log entry as written to stdout/stderr.
 * In prod, this is JSON-serialized. In dev, it's formatted as text.
 */
interface LogEntry {
  level: LogLevel;
  time: string;
  msg: string;
  [key: string]: unknown;
}

/** Serialize an Error instance into a plain loggable object. */
function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      ...(err.cause !== undefined && { cause: err.cause }),
    };
  }
  return { value: err };
}

/** Replace any `Error` values in context with their serialized form. */
function normalizeContext(ctx: LogContext): LogContext {
  const out: LogContext = {};
  for (const [key, value] of Object.entries(ctx)) {
    out[key] = value instanceof Error ? serializeError(value) : value;
  }
  return out;
}

function formatDev(entry: LogEntry): string {
  const { level, time, msg, ...rest } = entry;
  const color = COLORS[level];
  const timestamp = `${COLORS.dim}${time}${COLORS.reset}`;
  const levelTag = `${color}${level.toUpperCase().padEnd(5)}${COLORS.reset}`;
  const context =
    Object.keys(rest).length > 0
      ? ` ${COLORS.dim}${JSON.stringify(rest)}${COLORS.reset}`
      : "";
  return `${timestamp} ${levelTag} ${msg}${context}`;
}

/**
 * Core write function. Respects LOG_LEVEL from env.
 * Writes to stderr for warn/error, stdout for debug/info.
 */
function write(level: LogLevel, msg: string, ctx: LogContext = {}): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[env.LOG_LEVEL as LogLevel]) {
    return;
  }

  const entry: LogEntry = {
    level,
    time: new Date().toISOString(),
    msg,
    ...normalizeContext(ctx),
  };

  const line = isProd ? JSON.stringify(entry) : formatDev(entry);
  const stream = level === "warn" || level === "error" ? "stderr" : "stdout";

  // Use console to stay runtime-agnostic. In Workers, console.log/error
  // get wired to Cloudflare's observability system automatically.
  // eslint-disable-next-line no-console
  (stream === "stderr" ? console.error : console.log)(line);
}

export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  /** Create a child logger with bound context merged into every call. */
  child(bindings: LogContext): Logger;
}

/** Build a logger instance, optionally with bound context. */
function createLogger(bindings: LogContext = {}): Logger {
  const merge = (ctx: LogContext = {}): LogContext => ({ ...bindings, ...ctx });

  return {
    debug: (msg, ctx) => write("debug", msg, merge(ctx)),
    info: (msg, ctx) => write("info", msg, merge(ctx)),
    warn: (msg, ctx) => write("warn", msg, merge(ctx)),
    error: (msg, ctx) => write("error", msg, merge(ctx)),
    child: (newBindings) => createLogger({ ...bindings, ...newBindings }),
  };
}

/** Default app-wide logger. Use `logger.child({ module: '...' })` in submodules. */
export const logger = createLogger();
```

### `lib/utils.ts`

```typescript
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

### `lib/db/index.ts`

```typescript
/**
 * Shared Drizzle database client.
 *
 * In local dev / scripts, this wraps a `better-sqlite3` connection to
 * a file on disk. In production on Cloudflare Workers, a separate
 * factory will wrap the D1 binding — that split lands when we wire
 * up OpenNext. For now, this is the Node-only client.
 *
 * Import `db` from here; don't instantiate Drizzle elsewhere.
 *
 * @module lib/db
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import * as schema from "./schema";

const log = logger.child({ module: "db" });

/**
 * Singleton SQLite connection.
 *
 * Using a module-level variable means the connection is reused across
 * hot-module-reloads in `next dev`. Without this, HMR would open a new
 * DB handle on every change and eventually exhaust file descriptors.
 */
declare global {
  // eslint-disable-next-line no-var
  var __sqlite: Database.Database | undefined;
}

function getSqliteConnection(): Database.Database {
  if (globalThis.__sqlite) return globalThis.__sqlite;

  log.info("opening sqlite connection", { path: env.DATABASE_URL });
  const sqlite = new Database(env.DATABASE_URL);

  // Pragmas for correctness + performance. Safe defaults for our use case:
  //   - WAL gives us concurrent readers + one writer; better than default rollback journal
  //   - foreign_keys must be ON (SQLite leaves it OFF by default — footgun)
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  globalThis.__sqlite = sqlite;
  return sqlite;
}

/** Shared Drizzle instance. Use this everywhere; don't construct your own. */
export const db = drizzle(getSqliteConnection(), { schema });

/** Re-export schema for convenient `import { db, users } from '@/lib/db'` later. */
export * from "./schema";
```

### `lib/db/ids.ts`

```typescript
/**
 * UUID primary-key helpers.
 *
 * Every table uses UUID v7 primary keys (not v4). UUID v7 embeds a
 * millisecond timestamp in the first 48 bits, so new rows sort
 * chronologically in the B-tree index — far friendlier to SQLite's
 * index pages than v4's pure randomness. Same 128-bit format, same
 * string length, drop-in replacement.
 *
 * Always call `newId()` — never `crypto.randomUUID()` (which is v4)
 * or `uuidv7()` directly. Keeping a single entry point means if we
 * ever want to swap to ULID or change the ID strategy, there's one
 * file to edit.
 *
 * @module lib/db/ids
 */
import { v7 as uuidv7 } from "uuid";

/**
 * Generate a new UUID v7. Use this for all new primary keys.
 *
 * @example
 *   const id = newId();
 *   await db.insert(users).values({ id, email, ... });
 */
export function newId(): string {
  return uuidv7();
}
```

### `lib/db/schema.ts`

```typescript
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
```

## Authentication

JWT session helpers, the login/logout Server Actions, password hashing, and the Zod schemas that validate credentials. RBAC is enforced inside session helpers — see `requireRole`.

### `lib/auth/session.ts`

```typescript
/**
 * Session management - sign, verify, and manage the session cookie.
 *
 * Uses `jose` (not `jsonwebtoken`) because middleware runs in the Edge
 * runtime which has no Node modules. `jose` works in both Node and Edge.
 *
 * Day 6 note: `proxy.ts` (Next 16's rename of `middleware.ts`) imports
 * `verifySession` and `SESSION_COOKIE` from this file directly. That
 * works because Next 16 runs `proxy.ts` on the Node runtime by default,
 * so the `next/headers` import below doesn't break the proxy bundle.
 * If we ever flip the proxy back to Edge (Next provides no opt-in for
 * that today on `proxy.ts`), we'd need to extract the cookie name,
 * signing key, and `verifySession` into a sibling `./edge.ts` so they
 * can be imported without dragging `next/headers` in.
 *
 * Design:
 *   - Session state lives in a signed JWT inside an httpOnly cookie
 *   - Cookie is scoped to the whole app, SameSite=Lax, Secure in prod
 *   - Payload holds only non-secret identifiers (userId, email, role, companyId)
 *   - 7-day expiry; user must re-authenticate after that
 *
 * Callers:
 *   - lib/auth/actions.ts          - createSession() on successful login
 *   - proxy.ts                     - verifySession() to guard routes
 *   - app/dashboard/page.tsx       - readSession() to personalize UI
 *   - logout Server Action         - destroySession() on sign-out
 *
 * @module lib/auth/session
 */
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { cookies } from "next/headers";
import { env, isProd } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { UserRole } from "@/lib/db/schema";

const log = logger.child({ module: "session" });

// -- Constants ---------------------------------------------------------------
/** Cookie name. Scoped to this project to avoid collisions on shared domains. */
const SESSION_COOKIE = "cw_session";

/** JWT signing algorithm. HS256 = HMAC-SHA256, symmetric key from env. */
const JWT_ALG = "HS256";

/** Session lifetime. Balance between user friction and stolen-cookie blast radius. */
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

/**
 * JWT signing key, derived once from env.JWT_SECRET.
 * `jose` needs a `Uint8Array`, not a string.
 */
const signingKey = new TextEncoder().encode(env.JWT_SECRET);

// -- Types -------------------------------------------------------------------
/**
 * What we store in the JWT payload. Keep this minimal - JWTs aren't
 * encrypted, only signed. Anything here is readable by whoever has
 * the cookie. Never put sensitive values in this shape.
 */
export interface SessionPayload extends JWTPayload {
  /** User's UUID v7 primary key. Matches users.id in the DB. */
  userId: string;
  /** Lowercased email. Useful for display without a DB lookup. */
  email: string;
  /** Role for quick permission checks without a DB roundtrip. */
  role: UserRole;
  /**
   * Linked company UUID for `company`-role users. NULL for `admin` /
   * `staff`. Cached in the JWT so row-scoped reads (e.g. "my company")
   * don't need a users-table lookup on every request. If the user's
   * company link changes server-side, they'll keep their old scope
   * until the next login - acceptable for our threat model.
   */
  companyId: string | null;
}

// -- Public API --------------------------------------------------------------

/**
 * Sign a session payload into a JWT string. Does NOT set the cookie.
 * Useful when you want the raw token (e.g. tests, API responses).
 */
export async function signSession(payload: SessionPayload): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: JWT_ALG })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(signingKey);
}

/**
 * Verify a JWT string and return the payload, or null if invalid/expired.
 * Never throws - callers can treat it as a pure boolean-ish check.
 */
export async function verifySession(
  token: string | undefined,
): Promise<SessionPayload | null> {
  if (!token) return null;

  try {
    const { payload } = await jwtVerify<SessionPayload>(token, signingKey, {
      algorithms: [JWT_ALG],
    });
    return payload;
  } catch (err) {
    // Expired, malformed, or signed with a different secret. All "not logged in."
    log.debug("session verification failed", { err });
    return null;
  }
}

/**
 * Create a session for the given user and write the httpOnly cookie.
 * Call this from Server Actions after a successful password check.
 *
 * Must run inside a Server Action or Route Handler (needs cookie write
 * access). Won't work from a Server Component - those can only read.
 */
export async function createSession(payload: SessionPayload): Promise<void> {
  const token = await signSession(payload);
  const cookieStore = await cookies();

  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });

  log.info("session created", { userId: payload.userId, role: payload.role });
}

/**
 * Read and verify the current request's session cookie.
 * Returns null if no cookie, invalid signature, or expired.
 *
 * Safe to call from Server Components, Route Handlers, and Server Actions.
 * NOT safe for callers that don't have cookie-store access (e.g. an Edge-
 * runtime worker would need `verifySession()` directly against a raw
 * token). `proxy.ts` runs on Node so it can use either; today it uses
 * `verifySession` directly after reading the cookie via `req.cookies`.
 */
export async function readSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  return verifySession(token);
}

/**
 * Destroy the current session by deleting the cookie.
 * Call from a logout Server Action.
 *
 * Note: this is client-side logout only - since we use stateless JWTs,
 * a stolen token remains valid until its natural expiry. Full revocation
 * requires a DB-backed blocklist (deferred to a later phase).
 */
export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
  log.info("session destroyed");
}

// -- Exports for proxy.ts ---------------------------------------------------
/**
 * Cookie name - re-exported so proxy.ts can read the raw cookie from
 * the request without re-declaring the constant.
 */
export { SESSION_COOKIE };
```

### `lib/auth/actions.ts`

```typescript
/**
 * Authentication Server Actions.
 *
 * These are the only place where login/logout logic lives. The login
 * page posts here; the dashboard logout button posts here. They return
 * `{ ok: true } | { ok: false, error: string }` for the client to
 * handle - no throws for expected failures (invalid credentials, etc).
 *
 * Server Actions run on the server only. They're type-safe across the
 * client/server boundary and work without JavaScript (progressive
 * enhancement), though we use react-hook-form on top for UX.
 *
 * Schemas live in ./schemas.ts (not here) because client code can't
 * import non-action values from a "use server" file - Next.js turns
 * those values into remote-call stubs on the client.
 *
 * Day 6: the `login` action now honours an optional `from` field for
 * post-login redirection. `proxy.ts` already sets `?from=<path>` on
 * the redirect URL when bouncing unauthenticated users; this chunk
 * wires the value through the form and back into the post-login
 * redirect. The destination is validated via `safeFromPath()` to defeat
 * open-redirect attacks - anything not recognisably "a path on this
 * site" falls back to `/dashboard`.
 *
 * @module lib/auth/actions
 */
"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { verifyPassword, hashPassword } from "./password";
import { createSession, destroySession } from "./session";
import { loginSchema } from "./schemas";
import { logger } from "@/lib/logger";

const log = logger.child({ module: "auth-actions" });

// -- Result types -----------------------------------------------------------
/**
 * Server Action result. The UI pattern is:
 *   const result = await login(input);
 *   if (!result.ok) setError(result.error);
 * Successful logins don't return - they redirect() mid-function.
 */
export type ActionResult =
  | { ok: true }
  | { ok: false; error: string; field?: "email" | "password" | "form" };

// -- Private: post-login destination validator -----------------------------
/**
 * Coerce a user-supplied `from` value into a safe redirect path.
 *
 * The threat model: a malicious site embeds `/login?from=https://evil.example/phish`
 * in a phishing link. A naive `redirect(from ?? "/dashboard")` would
 * happily bounce the now-authenticated user off-site, where the attacker's
 * page can render content that looks like ours and trick them into
 * disclosing more credentials.
 *
 * The safe rule: only honour paths that look like "a route on this
 * application". Specifically:
 *   - Must start with exactly ONE forward slash. `//evil.example/x` is
 *     a protocol-relative URL that browsers interpret as absolute.
 *   - Must not contain a backslash (Windows path separator that some
 *     parsers normalise to forward slash, defeating prefix checks).
 *   - Must not start with `/api/` - those are RPC endpoints, not pages
 *     a user can land on. A redirect there would 404 or worse.
 *   - Must be reasonably short. A 4 KB `from=` is almost certainly an
 *     attack or a bug.
 *
 * Anything that fails any rule is replaced with `/dashboard`. We do NOT
 * log the rejection as a security event because legitimate users hit
 * this path occasionally (bookmarked URLs from a different deploy, etc.)
 * and we don't want to noise up the security signal.
 */
const MAX_FROM_LENGTH = 512;

function safeFromPath(raw: string | undefined): string {
  const fallback = "/dashboard";
  if (!raw) return fallback;
  if (raw.length > MAX_FROM_LENGTH) return fallback;
  if (!raw.startsWith("/")) return fallback;
  if (raw.startsWith("//")) return fallback;
  if (raw.includes("\\")) return fallback;
  if (raw.startsWith("/api/")) return fallback;
  return raw;
}

// -- Private: timing-safe dummy hash ---------------------------------------
/**
 * Lazy-computed dummy bcrypt hash. We compare against this when the
 * email doesn't exist in the DB, so the response time matches the
 * "email exists but wrong password" path. Defeats user enumeration
 * via timing analysis.
 *
 * Computed once per server instance - bcrypt at cost 10 is ~100ms,
 * not something we want on every failed-email login.
 */
let dummyHashCache: string | null = null;
async function getDummyHash(): Promise<string> {
  if (dummyHashCache) return dummyHashCache;
  dummyHashCache = await hashPassword("dummy-password-for-timing-safety");
  return dummyHashCache;
}

// -- Public: login ----------------------------------------------------------
/**
 * Verify credentials, create a session, redirect to the post-login
 * destination (or `/dashboard` if none / unsafe).
 *
 * Never reveals whether the failure was "email not found" or "wrong
 * password" - both return the same generic error with the same
 * response time.
 */
export async function login(rawInput: unknown): Promise<ActionResult> {
  // 1. Validate input shape.
  const parsed = loginSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
      field: "form",
    };
  }

  const { email, password, from } = parsed.data;

  // 2. Resolve the safe redirect destination BEFORE password checks.
  //    Doing it up front means a failing login response time isn't
  //    affected by whether `from` parsing is slow (it isn't, but
  //    keeping the security-sensitive work outside the credential-
  //    check timing window is a habit worth keeping).
  const destination = safeFromPath(from);

  // 3. Look up user by email (already lowercased by the schema).
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  // 4. If not found, run a dummy hash comparison to match timing.
  //    Same error message regardless - no user enumeration.
  if (!user) {
    await verifyPassword(password, await getDummyHash());
    log.info("login failed: unknown email", { email });
    return { ok: false, error: "Invalid email or password", field: "form" };
  }

  // 5. Check the password.
  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    log.info("login failed: wrong password", { email, userId: user.id });
    return { ok: false, error: "Invalid email or password", field: "form" };
  }

  // 6. Refuse deactivated accounts.
  if (!user.isActive) {
    log.info("login failed: account deactivated", { email, userId: user.id });
    return {
      ok: false,
      error: "This account is disabled. Contact support.",
      field: "form",
    };
  }

  // 7. Issue the session cookie. `companyId` is carried into the JWT
  //    so row-scoped reads (companies, documents, tenders) can authorise
  //    without an extra users-table lookup on every request.
  await createSession({
    userId: user.id,
    email: user.email,
    role: user.role,
    companyId: user.companyId,
  });

  // 8. Stamp last_login_at. Non-critical - failure doesn't break login.
  try {
    await db
      .update(users)
      .set({ lastLoginAt: new Date().toISOString() })
      .where(eq(users.id, user.id));
  } catch (err) {
    log.warn("failed to update last_login_at", { userId: user.id, err });
  }

  log.info("login succeeded", {
    userId: user.id,
    role: user.role,
    // Log whether we honoured a custom destination or fell back. Helps
    // spot a sudden spike in malicious-looking from= values during
    // incident triage.
    destination,
  });

  // 9. Redirect. MUST be outside any try/catch - Next.js signals
  //    redirects via a thrown special value that we don't want caught.
  redirect(destination);
}

// -- Public: logout ---------------------------------------------------------
/**
 * Clear the session cookie and redirect to /login.
 *
 * Client-side logout only - since we use stateless JWTs, a stolen
 * token stays valid until its natural expiry. Full revocation needs
 * a DB-backed blocklist (deferred).
 */
export async function logout(): Promise<never> {
  await destroySession();
  redirect("/login");
}
```

### `lib/auth/password.ts`

```typescript
/**
 * Password hashing and verification.
 *
 * Uses bcryptjs (pure JS) instead of bcrypt (native C++) so the same
 * code runs in Node, Cloudflare Workers, and test runners. Slower than
 * native bcrypt (~2x), but at cost factor 10 it's still ~100ms per
 * hash — safe under Workers' CPU limits.
 *
 * Every password is combined with a server-side "pepper" (from env)
 * before hashing. The pepper is NOT stored in the database, so even
 * if the DB leaks, an attacker also needs the pepper to brute-force
 * hashes offline. Rotating the pepper invalidates every password in
 * the database, so treat it like a secret and keep it stable.
 *
 * @module lib/auth/password
 */
import bcrypt from "bcryptjs";
import { env } from "@/lib/env";

/**
 * bcrypt cost factor. 10 is the industry default — ~100ms per hash on
 * modern hardware. Bumping this slows down both legitimate logins and
 * brute-force attempts proportionally. Safe to raise to 11 or 12 later
 * if we want more headroom; verify() handles mixed-cost hashes.
 */
const BCRYPT_COST = 10;

/**
 * Maximum plaintext length before hashing. bcrypt silently truncates
 * inputs longer than 72 bytes, which creates a subtle security bug
 * where `verylongpassword_A` and `verylongpassword_B` could hash to
 * the same value. We reject early to fail loudly instead.
 */
const MAX_PASSWORD_BYTES = 72;

/**
 * Hash a plaintext password with the server pepper.
 *
 * @param plaintext The user's password, already validated for strength
 *                  by Zod at the API layer (don't rely on this function
 *                  for strength enforcement).
 * @returns The bcrypt hash, safe to store in the database.
 * @throws If plaintext exceeds 72 bytes.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  const peppered = plaintext + env.PASSWORD_PEPPER;
  const byteLength = Buffer.byteLength(peppered, "utf8");

  if (byteLength > MAX_PASSWORD_BYTES) {
    throw new Error(
      `Password too long: ${byteLength} bytes exceeds bcrypt's 72-byte limit`,
    );
  }

  return bcrypt.hash(peppered, BCRYPT_COST);
}

/**
 * Verify a plaintext password against a stored hash.
 *
 * Uses bcrypt's built-in timing-safe comparison. Returns false for any
 * failure mode (wrong password, malformed hash, etc.) — never throws,
 * so callers can treat it as a pure boolean check.
 *
 * @param plaintext The password the user just typed.
 * @param hash      The bcrypt hash stored in users.password_hash.
 * @returns true if the password matches, false otherwise.
 */
export async function verifyPassword(
  plaintext: string,
  hash: string,
): Promise<boolean> {
  try {
    const peppered = plaintext + env.PASSWORD_PEPPER;
    return await bcrypt.compare(peppered, hash);
  } catch {
    // Malformed hash, invalid format, etc. Treat as "wrong password"
    // rather than leaking internals to the caller.
    return false;
  }
}
```

### `lib/auth/schemas.ts`

```typescript
/**
 * Auth Zod schemas.
 *
 * Must live in a non-"use server" file so client components can import
 * them at runtime. Server Actions files are transformed - exported
 * values become remote-call stubs, not the original objects. A schema
 * imported from a "use server" file won't have its methods available.
 *
 * @module lib/auth/schemas
 */
import { z } from "zod";

/**
 * Login input shape. Used by both the client form (via an inline
 * resolver in app/login/page.tsx) and the server-side login action
 * (for re-validation). Single source of truth - never validate the
 * same data twice with different rules.
 *
 * Day 6 addition: optional `from` field carrying the path the user was
 * trying to reach when proxy.ts bounced them to /login. Set as a
 * hidden form field, sourced from the URL query string (?from=...).
 * Named `from` to match the proxy's existing convention - the proxy
 * sets `?from=` on the redirect URL, and we round-trip the same name
 * back through the form.
 *
 * Open-redirect safety: the schema accepts ANY string here (we can't
 * easily express "path-only URL" in Zod's primitives), but the action
 * layer runs an explicit `safeFromPath()` validator before honouring
 * the value. Validation here would either be too loose (regex
 * approximations of URL grammar) or too strict (rejecting valid paths
 * with weird-but-legal characters). Cleaner to do the security-
 * critical check once, in the action, where the redirect call lives.
 */
export const loginSchema = z.object({
  email: z.string().email("Enter a valid email address").toLowerCase(),
  password: z.string().min(1, "Password is required"),
  /** Post-login destination. Optional; defaults to /dashboard. */
  from: z.string().optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;
```

## Audit Log

Every privileged mutation should record an entry here. See how `lib/companies/actions.ts` calls into this module from each Server Action. The `audit_log` table was persisted to D1 in day 5 — `listAuditEvents` is the read API.

### `lib/audit/log.ts`

```typescript
/**
 * Audit logging - record who did what, to which entity, with optional
 * before / after snapshots and free-form metadata.
 *
 * Day 6: the body now persists to the `audit_log` table in D1 in addition
 * to emitting the structured log line. Callers do NOT change - every
 * existing `recordAuditEvent` call site across companies, tenders, and
 * tender_applications continues to work without edit. The "callers don't
 * change" promise that justified routing every mutation through this
 * helper since Day 2 is preserved.
 *
 * Day 6 target-type addition: `tender_application` joined the
 * `AuditTargetType` union. Application-state-change events (withdraw,
 * decide, reinstate, recall) now log against the application id directly
 * instead of the parent tender id, with `tenderId` moved into
 * `metadata.tenderId`. This is what lets Day 7's per-application history
 * tab be a single indexed lookup. The `tender_applied` event (a company
 * submitting an application) intentionally stays scoped to the tender -
 * it's a "this tender received a submission" event from the audit-trail
 * reader's perspective, not a per-application one.
 *
 * Day 6 Chunk 2: `listAuditEvents` read API added below. Role-aware
 * visibility:
 *   - admin / staff -> sees all rows.
 *   - company       -> sees rows where they were the actor, plus rows
 *                      where the target is one of their own applications.
 *                      Tender-level events on tenders they applied to,
 *                      and cross-company events on tenders they publish,
 *                      are deferred to a later session.
 *   - unauthenticated -> error.
 *
 * Failure semantics: `recordAuditEvent` NEVER throws. A failed audit must
 * not break a successful user action - the user already got their work
 * done, and a degraded audit trail beats a failed action. On insert
 * failure we log an error via the structured logger and return normally.
 * The structured-log line is emitted BEFORE the insert attempt, so even
 * on a total D1 outage we still have a grep-able trail in the Workers
 * log stream.
 *
 * Reversal verbs (Day 5):
 *   - `tender_reopened`           - admin moved a closed tender back to
 *                                   published. Optional reason in
 *                                   `metadata.reason`.
 *   - `tender_award_retracted`    - admin moved an awarded tender back
 *                                   to closed. REQUIRED reason in
 *                                   `metadata.reason`.
 *   - `application_reinstated`    - admin/staff moved a shortlisted /
 *                                   rejected application back to
 *                                   submitted. `decidedAt` is cleared
 *                                   to NULL on the row; the audit event
 *                                   preserves the original decision time
 *                                   under `metadata.previousDecidedAt`.
 *   - `application_recalled`      - company moved their own withdrawn
 *                                   application back to submitted within
 *                                   the recall window. `daysSinceWithdrawal`
 *                                   captured in metadata.
 *
 * @module lib/audit/log
 */
import { and, count, desc, eq, or, type SQL } from "drizzle-orm";
import {
  db,
  auditLog,
  tenderApplications,
  type AuditLogEntry,
} from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { readSession } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import { listAuditEventsQuerySchema } from "./schemas";

const log = logger.child({ module: "audit" });

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * The kinds of entities we audit. Keep this union closed - adding a new
 * entity is a deliberate change, not something callers should pass as a
 * free-form string. Each addition should be accompanied by a clear
 * articulation of which actions target it (see Day 6 commentary above for
 * the `tender_application` rationale).
 *
 * IMPORTANT: keep in lockstep with `auditTargetTypeSchema` in
 * `./schemas.ts`. The two encode the same set - one for compile-time, one
 * for runtime validation.
 */
export type AuditTargetType =
  | "company"
  | "user"
  | "tender"
  | "tender_application"
  | "project"
  | "transaction"
  | "document";

/**
 * What was done to the target. The triplet `created / updated / deleted`
 * covers most cases; specific status changes that are interesting enough
 * to filter on get their own verbs.
 *
 * Verb choice rule of thumb: if "show me all X events last week" is a
 * query the audit UI will eventually need to answer, X earns a verb.
 * Otherwise it folds into `updated` with detail in `metadata`.
 *
 * IMPORTANT: keep in lockstep with `auditActionSchema` in `./schemas.ts`.
 */
export type AuditAction =
  | "created"
  | "updated"
  | "deleted"
  | "compliance_status_changed"
  | "document_uploaded"
  | "document_expired"
  | "tender_published"
  | "tender_applied"
  // ── Reversal verbs (Day 5) ─────────────────────────────────────────────
  | "tender_reopened"
  | "tender_award_retracted"
  | "application_reinstated"
  | "application_recalled";

/**
 * Single audit event. Maps 1:1 to a row in the `audit_log` table.
 *
 *   - `actorId` and `actorRole` identify who performed the action.
 *     `actorRole` is denormalised so we can answer "what did admins do
 *     this week" without a join. The actor's company affiliation, if any,
 *     is recovered via a join on `users.id` when needed - we deliberately
 *     do NOT carry `actorCompanyId` on every row.
 *
 *   - `before` / `after` snapshots are optional. For `created` only
 *     `after` makes sense; for `deleted` only `before`; for `updated`
 *     both. Snapshots are partial - they include only the fields the
 *     action touched, not the entire row.
 *
 *   - `metadata` is free-form for action-specific extra context. For
 *     application-state events on `targetType: "tender_application"`,
 *     `metadata.tenderId` is the conventional way to surface the parent
 *     tender so reverse queries can find applications by tender without
 *     a join.
 */
export interface AuditEvent {
  actorId: string;
  actorRole: "admin" | "staff" | "company";
  action: AuditAction;
  targetType: AuditTargetType;
  targetId: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Result type for `listAuditEvents`. Mirrors the `ActionResult` shape
 * used across the rest of the codebase but lives here locally because
 * `recordAuditEvent` has historically been a thin module with no
 * result-type dependency. Pulling in `ActionResult` from one of the
 * domain modules (companies/tenders) would create an upward dependency;
 * defining it here keeps `lib/audit` a leaf.
 */
export type AuditReadResult =
  | { ok: true; rows: AuditLogEntry[]; total: number }
  | { ok: false; error: string };

// ── Public API: write ────────────────────────────────────────────────────────

/**
 * Record an audit event.
 *
 * Pipeline:
 *   1. Emit the structured log line (fires before the DB write so a DB
 *      outage doesn't lose the event entirely).
 *   2. Insert a row into `audit_log`. JSON columns auto-encode via Drizzle.
 *   3. On any failure, log the error and return normally - never throw.
 *
 * @example
 *   await recordAuditEvent({
 *     actorId: session.userId,
 *     actorRole: session.role,
 *     action: "created",
 *     targetType: "company",
 *     targetId: newCompany.id,
 *     after: { name: newCompany.name, sector: newCompany.sector },
 *   });
 */
export async function recordAuditEvent(event: AuditEvent): Promise<void> {
  // Step 1: structured log line - fires regardless of DB outcome. This is
  // the durable trail in the Workers log stream; the DB row is the
  // queryable trail in the dashboard UI. Both serve different audiences.
  try {
    log.info("audit event", {
      actor_id: event.actorId,
      actor_role: event.actorRole,
      action: event.action,
      target_type: event.targetType,
      target_id: event.targetId,
      // Spread snapshots and metadata into the log line for easy grepping.
      // Skip if absent so the log object stays tidy.
      ...(event.before ? { before: event.before } : {}),
      ...(event.after ? { after: event.after } : {}),
      ...(event.metadata ? { metadata: event.metadata } : {}),
    });
  } catch (err) {
    // Defensive only - log.info shouldn't throw. Logged separately from the
    // DB-write failure path so future ops can distinguish "logger failed"
    // from "DB failed" in the post-incident timeline.
    log.error("audit log line failed", { err, event_action: event.action });
  }

  // Step 2: persist to D1. Generate the row id app-side (consistent with
  // every other table in the schema) and stage the insert. The
  // `createdAt` column defaults to `datetime('now')` at the DB layer so
  // we don't pass it explicitly.
  try {
    await db.insert(auditLog).values({
      id: newId(),
      actorId: event.actorId,
      actorRole: event.actorRole,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      before: event.before,
      after: event.after,
      metadata: event.metadata,
    });
  } catch (err) {
    // The audit table is down or schema-drifted. We've already emitted the
    // log line above, so the event isn't lost - it just doesn't reach the
    // queryable trail. Parent Server Action proceeds normally; the user's
    // operation already succeeded.
    log.error("audit log persist failed", {
      err,
      event_action: event.action,
      target_type: event.targetType,
      target_id: event.targetId,
    });
  }
}

// ── Public API: read ────────────────────────────────────────────────────────

/**
 * List audit events with role-aware visibility, filtering, and pagination.
 *
 * Returns newest-first. No sort options are exposed - an audit feed
 * ordered any other way is essentially never what the caller wants, and
 * locking the sort keeps the indexes load-bearing on a single access
 * pattern.
 *
 * Visibility rules (Phase 1):
 *
 *   - **admin / staff** see every row. No scope filter applied.
 *
 *   - **company-role users** see rows where any of the following holds:
 *       (a) `actor_id` matches the caller (their own actions).
 *       (b) `target_type = 'tender_application'` AND the row's
 *           `target_id` resolves to an application belonging to their
 *           company (via a join on `tender_applications.company_id`).
 *     Cross-company visibility on tenders they applied to or publish is
 *     deliberately out of scope for Phase 1 - it would require resolving
 *     "tenders the caller has applied to" and "tenders the caller is
 *     publishing" as separate sub-queries, and the only consumer (Day
 *     7's activity feed widget) doesn't need that depth yet. When it
 *     does, we extend this function rather than adding a parallel one.
 *
 *   - **unauthenticated callers** get `{ ok: false, error }`. The audit
 *     trail is never anonymous - "no caller" is "no rows".
 *
 * Filtering:
 *   - `targetType` / `targetId` for per-entity history queries (Day 7's
 *     per-tender / per-application history tabs use this combination).
 *   - `actorId` for admin investigation ("what did this user do?").
 *   - `action` for verb-specific feeds ("all reversals last month").
 *
 * Pagination uses `limit` / `offset` rather than cursor pagination.
 * Offset-based is fine for an append-only log at Phase 1 scale (single-
 * digit thousands of rows expected); when we cross into "scroll past
 * row 10,000" territory, cursoring by `created_at` becomes worthwhile.
 *
 * @param rawQuery The query input. Coerced + validated via Zod.
 * @returns Either an `ok: true` payload with rows + total, or `ok: false`
 *          with a user-facing error message.
 */
export async function listAuditEvents(
  rawQuery: unknown,
): Promise<AuditReadResult> {
  // 1. AuthZ. Unauthenticated callers get nothing - the audit trail is
  //    not a public artefact.
  const session = await readSession();
  if (!session) {
    return { ok: false, error: "You must be signed in" };
  }

  // 2. Validate query input. Default pagination kicks in for empty input,
  //    so callers can pass `{}` or `undefined` and get a sensible "most
  //    recent 50 events" response.
  const parsed = listAuditEventsQuerySchema.safeParse(rawQuery ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid query",
    };
  }
  const query = parsed.data;

  // 3. Build the filter list additively. Each user-supplied filter
  //    appends one equality clause; all clauses compose with AND.
  const filters: SQL[] = [];

  if (query.targetType) {
    filters.push(eq(auditLog.targetType, query.targetType));
  }
  if (query.targetId) {
    filters.push(eq(auditLog.targetId, query.targetId));
  }
  if (query.actorId) {
    filters.push(eq(auditLog.actorId, query.actorId));
  }
  if (query.action) {
    filters.push(eq(auditLog.action, query.action));
  }

  // 4. Role-aware visibility scope. Admin/staff see everything; company
  //    users see only own actions + own-application targets.
  //
  //    The company-scope branch uses a single OR clause inside the WHERE:
  //      audit_log.actor_id = :userId
  //        OR
  //      (audit_log.target_type = 'tender_application'
  //         AND target_id IN (SELECT id FROM tender_applications WHERE company_id = :companyId))
  //
  //    Drizzle expresses the IN-subselect via the `inArray` operator. We
  //    fetch the application id list first (one indexed query on
  //    tender_applications.company_id) so the main query stays simple
  //    and the result can be paginated with a plain WHERE. The alternative
  //    (correlated subquery) is harder to read and has the same plan in
  //    SQLite for small id lists.
  if (session.role === "company") {
    // Edge case: company-role user without a linked company. Should not
    // happen given the login flow, but fail-closed is the right default.
    if (!session.companyId) {
      log.warn("listAuditEvents: company-role caller has no company", {
        userId: session.userId,
      });
      return { ok: true, rows: [], total: 0 };
    }

    // Resolve the caller's application ids - the set of rows the scope
    // filter needs to allow via the target_id branch. Empty list is
    // fine; the OR collapses to just the actor_id clause in that case.
    const ownApplications = await db
      .select({ id: tenderApplications.id })
      .from(tenderApplications)
      .where(eq(tenderApplications.companyId, session.companyId));

    const ownApplicationIds = ownApplications.map((r) => r.id);

    // Build the OR. The actor_id branch is always present; the
    // target-id branch is only added when the caller has at least one
    // application (otherwise we'd be ORing with an empty IN, which
    // Drizzle's `inArray` can't express cleanly).
    const scopeClauses: SQL[] = [eq(auditLog.actorId, session.userId)];

    if (ownApplicationIds.length > 0) {
      // Two-part clause: target type must be tender_application AND
      // target_id must be one of ours. Both must match - guards against
      // the (rare) future case of an unrelated entity sharing the same
      // UUID as one of our applications.
      //
      // Drizzle's `or` collapses an array of conditions; we wrap the
      // two-part clause in `and` so the precedence is unambiguous.
      const ownAppTargetClause = and(
        eq(auditLog.targetType, "tender_application"),
        // Inline OR over the application ids. For Phase 1 scale (a
        // single company will have <100 applications) this is fine;
        // when it grows, swap to `inArray` against a subselect.
        or(...ownApplicationIds.map((id) => eq(auditLog.targetId, id))),
      );
      if (ownAppTargetClause) {
        scopeClauses.push(ownAppTargetClause);
      }
    }

    const scopeFilter = or(...scopeClauses);
    if (scopeFilter) {
      filters.push(scopeFilter);
    }
  }
  // admin / staff fall through with no scope filter - they see all rows.

  const whereClause = filters.length > 0 ? and(...filters) : undefined;

  // 5. Two queries: the page of rows, and the total count for paging UI.
  //    Same shape as listCompanies / listTenders. Both share the same
  //    WHERE clause so the count reflects the filtered + scoped set,
  //    not the raw table size.
  const [rows, totalRow] = await Promise.all([
    db
      .select()
      .from(auditLog)
      .where(whereClause)
      .orderBy(desc(auditLog.createdAt))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ value: count() })
      .from(auditLog)
      .where(whereClause)
      .then((r) => r[0]),
  ]);

  return {
    ok: true,
    rows,
    total: totalRow?.value ?? 0,
  };
}
```

### `lib/audit/schemas.ts`

```typescript
/**
 * Audit module - Zod schemas.
 *
 * Co-located with the action layer in `./log.ts` rather than living
 * next to the table definition, matching the convention established by
 * `lib/companies/schemas.ts` and `lib/tenders/schemas.ts`. The action
 * code imports from here at runtime; client code that needs the input
 * shape (none today) would also import from here.
 *
 * Why schemas live in their own file: action files have the
 * `"use server"` pragma, and Next.js turns every export from a
 * "use server" file into a remote-call stub. Non-action values
 * (Zod schemas, types) exported from a "use server" file would
 * silently break at runtime when imported from a Client Component.
 * Keeping schemas in a sibling file avoids this trap entirely.
 *
 * @module lib/audit/schemas
 */
import { z } from "zod";

// -- Shared building blocks -------------------------------------------------

/**
 * UUID validator. Same shape as the companies / tenders modules; we
 * re-declare per-module instead of sharing one source so each module
 * can tune the error message later without coupling.
 */
const uuidSchema = z.string().uuid("Invalid identifier");

/**
 * Closed enum of audit target types. Mirrors the `AuditTargetType`
 * union in `./log.ts`. We re-declare here as a Zod enum (not a
 * generic string) so client-side query construction (e.g. a future
 * "filter the activity feed by entity type" dropdown) gets typed
 * autocomplete and runtime validation in one place.
 *
 * Keep these two in lockstep: adding a target type means editing both
 * `AuditTargetType` in `./log.ts` AND this enum. There is no clever
 * way around the duplication - Zod enums can't be derived from
 * TypeScript unions, and we don't want to invert the relationship
 * (deriving the union from the enum would force every action call
 * site to import a Zod object just to get a type).
 */
export const auditTargetTypeSchema = z.enum([
  "company",
  "user",
  "tender",
  "tender_application",
  "project",
  "transaction",
  "document",
]);

/**
 * Closed enum of audit actions. Same lockstep contract as
 * `auditTargetTypeSchema` - mirrors `AuditAction` in `./log.ts`.
 *
 * Useful for filtering the activity feed by verb (e.g. "show me all
 * reversals last week"). Day 7's dashboard widget will lean on this.
 */
export const auditActionSchema = z.enum([
  "created",
  "updated",
  "deleted",
  "compliance_status_changed",
  "document_uploaded",
  "document_expired",
  "tender_published",
  "tender_applied",
  "tender_reopened",
  "tender_award_retracted",
  "application_reinstated",
  "application_recalled",
]);

// -- listAuditEvents query --------------------------------------------------

/**
 * Query schema for `listAuditEvents`.
 *
 * All filters are optional and compose with AND. The defaults skew
 * toward "give me the recent activity feed":
 *   - `limit` defaults to 50 (one screen of events on the future widget)
 *   - capped at 200 to keep query cost bounded
 *   - `offset` defaults to 0
 *
 * Coerces numeric inputs because URL search params arrive as strings -
 * lets this schema double as a `searchParams` parser if we ever expose
 * the audit log via a route handler.
 *
 * No sort options. Audit events are always returned newest-first
 * (`created_at DESC`) - audit feeds without that default are useless,
 * and exposing the sort would let a caller order by `actor_id` which
 * isn't a query pattern we want to encourage.
 */
export const listAuditEventsQuerySchema = z.object({
  /** Filter to events on one entity type (e.g. just `tender_application`). */
  targetType: auditTargetTypeSchema.optional(),

  /**
   * Filter to events on a specific entity. When combined with
   * `targetType` this hits the `audit_log_target_idx` composite cleanly.
   * Without `targetType` it still works via the same index (target_type
   * is the lead column, so SQLite can use the index for target_id alone
   * if we add an explicit equality - but in practice we always pair
   * the two on the read side).
   */
  targetId: uuidSchema.optional(),

  /**
   * Filter to events performed by one user. Hits the
   * `audit_log_actor_id_idx`. Useful for admin investigation queries.
   */
  actorId: uuidSchema.optional(),

  /** Filter by audit verb (e.g. "all `tender_award_retracted` events"). */
  action: auditActionSchema.optional(),

  // Pagination.
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ListAuditEventsQuery = z.infer<typeof listAuditEventsQuerySchema>;
```

## Server Action Pattern — Reference Implementation

The canonical example of how a domain module is structured: a `schemas.ts` with Zod validators, an `actions.ts` with Server Actions that follow the `validate → RBAC check → DB write → audit log → revalidate → return typed result` sequence. Mirror this layout for new modules. `lib/tenders/actions.ts` follows the same pattern but is ~1,900 lines and is omitted here to keep this snapshot focused — read it directly when needed.

### `lib/companies/schemas.ts`

```typescript
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
```

### `lib/companies/actions.ts`

```typescript
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
 * Audit logging: every mutation (create / update / delete) calls
 * `recordAuditEvent` after the DB write succeeds. The audit logger is
 * a stub today (logs to the structured logger); it'll persist to an
 * `audit_log` table once that lands in a follow-up chunk. Read actions
 * (getCompany, listCompanies) are intentionally NOT audited — would
 * be too noisy and not legally useful.
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
import { recordAuditEvent } from "@/lib/audit/log";
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

  // 4. Audit. Captures the identity-ish fields that matter for auditing
  //    later — full row contents would be noise on the audit-log table.
  await recordAuditEvent({
    actorId: auth.session.userId,
    actorRole: auth.session.role,
    action: "created",
    targetType: "company",
    targetId: id,
    after: {
      name: input.name,
      sector: input.sector,
      geography: input.geography,
      isJv: input.isJv,
      complianceStatus: "pending",
    },
  });

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

  // 8. Audit. We capture before/after of only the fields the patch
  //    touched, derived by walking the patch keys. Storing the full row
  //    diff would inflate the audit log without much benefit — "what
  //    changed" beats "what the row looked like" for forensic queries.
  const touchedKeys = Object.keys(patch);
  const beforeSnapshot = buildPatchSnapshot(existing, touchedKeys);
  const afterSnapshot = buildPatchSnapshot(
    { ...existing, ...patch } as Company,
    touchedKeys,
  );
  await recordAuditEvent({
    actorId: session.userId,
    actorRole: session.role,
    action: "updated",
    targetType: "company",
    targetId: input.id,
    before: beforeSnapshot,
    after: afterSnapshot,
  });

  log.info("company updated", {
    id: input.id,
    actorId: session.userId,
    fields: touchedKeys,
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

  // Use .returning() to get the deleted row back. That row IS the audit
  // snapshot — once it's gone, we can't reconstruct it from anywhere
  // else, so we capture the whole thing.
  const result = await db
    .delete(companies)
    .where(eq(companies.id, parsed.data.id))
    .returning();

  if (result.length === 0) {
    return { ok: false, error: "Company not found" };
  }

  const deletedRow = result[0];

  // Audit with the full pre-deletion row. Deletion is the one case
  // where storing everything is justified — there's no canonical copy
  // left to reference later.
  await recordAuditEvent({
    actorId: auth.session.userId,
    actorRole: auth.session.role,
    action: "deleted",
    targetType: "company",
    targetId: parsed.data.id,
    before: {
      name: deletedRow.name,
      sector: deletedRow.sector,
      geography: deletedRow.geography,
      gstNumber: deletedRow.gstNumber,
      panNumber: deletedRow.panNumber,
      isJv: deletedRow.isJv,
      complianceStatus: deletedRow.complianceStatus,
      parentCompanyIds: deletedRow.parentCompanyIds,
      contactEmail: deletedRow.contactEmail,
      contactPhone: deletedRow.contactPhone,
      contactPersonName: deletedRow.contactPersonName,
      addressLine: deletedRow.addressLine,
      city: deletedRow.city,
      state: deletedRow.state,
      pincode: deletedRow.pincode,
      internalNotes: deletedRow.internalNotes,
      createdAt: deletedRow.createdAt,
    },
  });

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

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a partial snapshot of a company row, restricted to the named
 * keys. Used to produce before/after audit payloads of only the fields
 * that the patch actually touched.
 *
 * Accepts `string[]` (typically `Object.keys(patch)`) for ergonomics
 * at the call site; the cast inside is safe because patch keys are
 * derived from a typed `Partial<Insert>`.
 */
function buildPatchSnapshot(
  row: Company,
  keys: string[],
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) {
    snapshot[key] = (row as unknown as Record<string, unknown>)[key];
  }
  return snapshot;
}
```

### `lib/tenders/schemas.ts`

```typescript
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
 *   - withdrawApplicationSchema      — company withdrawing own application
 *
 * ── Day 5: reversal schemas ─────────────────────────────────────────────
 *   - reopenTenderSchema             — admin reopens a closed tender;
 *                                      optional reason
 *   - retractAwardSchema             — admin retracts an awarded tender;
 *                                      REQUIRED reason
 *   - reinstateApplicationSchema     — admin/staff reverts a
 *                                      shortlisted/rejected app to
 *                                      submitted; optional reason
 *   - recallApplicationSchema        — company recalls own withdrawn
 *                                      application; optional reason
 *
 * Reasons are captured at the schema layer (not just as free-form
 * metadata in the action) so:
 *   - Zod surfaces validation errors with the right `field` hint
 *   - the form layer can wire `result.field === "reason"` straight to
 *     the textarea
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
 *     The dedicated `reinstateApplication` action (Day 5) handles
 *     `shortlisted → submitted` and `rejected → submitted` reversals
 *     with the correct semantics (clears decidedAt, dedicated audit verb).
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

// ─────────────────────────────────────────────────────────────────────────
// Day 5: reversal schemas
// ─────────────────────────────────────────────────────────────────────────

/**
 * Shared `reason` field used by the reversal schemas. Two variants:
 *   - optional: a free-form rationale (1–500 chars when present)
 *   - required: same shape, but rejects empty / missing input
 *
 * Length cap of 500 keeps the audit metadata reasonable — reasons are
 * a one-line explanation, not an essay. Anything richer belongs in
 * `internalNotes`.
 */
const optionalReasonSchema = z
  .string()
  .trim()
  .min(1, "Reason cannot be empty if provided")
  .max(500, "Reason must be 500 characters or fewer")
  .optional()
  .nullable();

const requiredReasonSchema = z
  .string()
  .trim()
  .min(5, "Please give a brief reason (at least 5 characters)")
  .max(500, "Reason must be 500 characters or fewer");

// ── Reopen tender (admin) ─────────────────────────────────────────────────

/**
 * Input schema for `reopenTender` — admin moves a `closed` tender back
 * to `published`. Reason is optional; when provided it's captured under
 * `metadata.reason` on the `tender_reopened` audit event.
 *
 * The action enforces the legal-transition gate via the state machine
 * (`isLegalTransition(closed, published)` is `true` in the Day-5
 * relaxed model). The action also enforces the admin role check —
 * staff cannot reopen.
 */
export const reopenTenderSchema = z.object({
  tenderId: uuidSchema,
  reason: optionalReasonSchema,
});

export type ReopenTenderInput = z.infer<typeof reopenTenderSchema>;

// ── Retract award (admin) ─────────────────────────────────────────────────

/**
 * Input schema for `retractAward` — admin moves an `awarded` tender
 * back to `closed`. Reason is REQUIRED here (highest-stakes reversal in
 * the app) and surfaces on the audit log under `metadata.reason`.
 *
 * The UI gates this behind a stronger ConfirmDialog with a textarea;
 * the `field: "reason"` hint on validation failures lets the form
 * highlight the textarea on submit.
 */
export const retractAwardSchema = z.object({
  tenderId: uuidSchema,
  reason: requiredReasonSchema,
});

export type RetractAwardInput = z.infer<typeof retractAwardSchema>;

// ── Reinstate application (admin/staff) ───────────────────────────────────

/**
 * Input schema for `reinstateApplication` — admin/staff flip a
 * `shortlisted` or `rejected` application back to `submitted`. The
 * action clears `decidedAt` to NULL (the application is back to
 * "waiting on staff") and preserves the original decision time under
 * `metadata.previousDecidedAt` on the audit event.
 *
 * Reason is optional. Most reinstatements are operational corrections
 * ("clicked reject by mistake"); when a real reason exists it's worth
 * capturing.
 */
export const reinstateApplicationSchema = z.object({
  applicationId: uuidSchema,
  reason: optionalReasonSchema,
});

export type ReinstateApplicationInput = z.infer<
  typeof reinstateApplicationSchema
>;

// ── Recall application (company on own) ───────────────────────────────────

/**
 * Input schema for `recallApplication` — a company-role user flips
 * their own `withdrawn` application back to `submitted`. The action
 * enforces:
 *   - ownership (the application's `companyId` matches the session's
 *     linked company)
 *   - current status is `withdrawn`
 *   - the recall window (see `state-machine.ts::RECALL_WINDOW_DAYS`)
 *     has not yet expired
 *
 * Reason is optional — most recalls are simple changes of mind.
 */
export const recallApplicationSchema = z.object({
  applicationId: uuidSchema,
  reason: optionalReasonSchema,
});

export type RecallApplicationInput = z.infer<typeof recallApplicationSchema>;
```

### `lib/tenders/state-machine.ts`

```typescript
/**
 * Tender + application status state machine.
 *
 * Centralises the legal transitions between `TenderStatus` and
 * `TenderApplicationStatus` values so every status-changing Server
 * Action shares one source of truth. Without this, each action would
 * re-implement its own "is this transition valid?" branch and the
 * rules would inevitably drift apart.
 *
 * ── Tender lifecycle ──────────────────────────────────────────────────
 *
 * Legal transitions (Day 5 relaxed model — reversal capability):
 *
 *     draft     ──────▶ published     (publishTender)
 *     published ──────▶ draft         (unpublishTender — guarded: no applications)
 *     published ──────▶ closed        (closeTender)
 *     closed    ──────▶ awarded       (markAwarded)
 *
 *     ── Reversals (Day 5, admin-initiated) ────────────────────────────
 *     closed    ──────▶ published     (reopenTender — admin only;
 *                                       UI warns about applicant
 *                                       confusion)
 *     awarded   ──────▶ closed        (retractAward — admin only;
 *                                       requires a reason captured in
 *                                       the audit log)
 *
 * Notable rejections:
 *   - `draft → closed / awarded`: drafts haven't been visible to anyone,
 *     so "closing" or "awarding" them is meaningless — delete instead.
 *   - `awarded → published / draft`: forcing the path through `closed`
 *     keeps every state visit auditable. Reopening an awarded tender
 *     directly to published would skip a checkpoint.
 *   - Anything from `draft` other than `published`.
 *
 * ── Application lifecycle ─────────────────────────────────────────────
 *
 *     submitted   ──────▶ shortlisted   (updateApplicationStatus, staff)
 *     submitted   ──────▶ rejected      (updateApplicationStatus, staff)
 *     submitted   ──────▶ withdrawn     (withdrawApplication, company)
 *
 *     ── Reversals (Day 5) ─────────────────────────────────────────────
 *     shortlisted ──────▶ submitted     (reinstateApplication, admin/staff)
 *     rejected    ──────▶ submitted     (reinstateApplication, admin/staff)
 *     withdrawn   ──────▶ submitted     (recallApplication, company on own,
 *                                         within RECALL_WINDOW_DAYS of
 *                                         `decidedAt`)
 *
 * Editability rules are also encoded here so `updateTender` consults
 * one place to decide what fields a row in a given status can mutate.
 * See `getEditableFieldsForStatus` below.
 *
 * @module lib/tenders/state-machine
 */
import type { TenderStatus, TenderApplicationStatus } from "@/lib/db/schema";

// ── Tender transition table ───────────────────────────────────────────────

/**
 * Map of `from → set of legal `to` values`. Reading
 * `LEGAL_TRANSITIONS[current].has(next)` is the single source of truth.
 *
 * Stored as `Record<TenderStatus, ReadonlySet<TenderStatus>>` so TypeScript
 * verifies every status has an entry (exhaustiveness) and we don't ship
 * a transition table missing a state.
 *
 * Day 5: `closed` gained `published` (reopen), `awarded` gained `closed`
 * (retract award). All other entries unchanged.
 */
const LEGAL_TRANSITIONS: Record<TenderStatus, ReadonlySet<TenderStatus>> = {
  draft: new Set<TenderStatus>(["published"]),
  published: new Set<TenderStatus>(["draft", "closed"]),
  closed: new Set<TenderStatus>(["awarded", "published"]),
  awarded: new Set<TenderStatus>(["closed"]),
};

/**
 * Is the transition `from → to` legal?
 *
 * Returns `true` only for explicit transitions in the table. A "no-op"
 * transition where `from === to` is NOT legal here — the caller should
 * short-circuit before consulting this function (an idempotent re-publish
 * is a different code path than a transition).
 */
export function isLegalTransition(
  from: TenderStatus,
  to: TenderStatus,
): boolean {
  return LEGAL_TRANSITIONS[from].has(to);
}

/**
 * Human-friendly error string for an illegal transition. Used directly
 * as the `error` field in `ActionResult` returns so the UI can surface
 * a useful message instead of "invalid".
 */
export function illegalTransitionMessage(
  from: TenderStatus,
  to: TenderStatus,
): string {
  if (from === to) {
    return `Tender is already ${from}`;
  }
  // Hand-tuned messages for the common cases — clearer than a generic
  // "can't transition" string. Falls back to a generic message for any
  // illegal pair not in the explicit list.
  if (from === "awarded" && to !== "closed") {
    // Day 5: awarded → closed IS legal now (retractAward). Other
    // forward-from-awarded transitions remain illegal — force the
    // through-closed checkpoint so every state visit is auditable.
    return "Awarded tenders can only be reverted one step (to closed); further changes go through closed first";
  }
  if (from === "draft" && (to === "closed" || to === "awarded")) {
    return `A draft tender must be published before it can be ${to}`;
  }
  return `Cannot transition tender from ${from} to ${to}`;
}

// ── Editability per status ────────────────────────────────────────────────

/**
 * Fields on a tender row that may be edited via `updateTender`. The set
 * depends on the row's current status:
 *
 *   - `draft`     — everything editable. The tender hasn't been visible
 *                   to companies yet, so any change is safe.
 *   - `published` — most fields editable, EXCEPT the four eligibility
 *                   filters (`eligibleSector`, `eligibleGeography`,
 *                   `minAnnualTurnoverInr`, `msmeOnly`). Changing those
 *                   after publish would silently invalidate existing
 *                   applications — companies who applied under one
 *                   eligibility set would suddenly be looking at a
 *                   different one. Cleaner: lock them, force a draft
 *                   revision via `unpublishTender` (only if no apps yet)
 *                   or a fresh draft.
 *   - `closed`    — only `internalNotes` editable. Staff still need to
 *                   record evaluation notes while reviewing applications.
 *   - `awarded`   — only `internalNotes` editable. Once-terminal-now-
 *                   reversible state; the notes channel stays open for
 *                   retrospective context (debriefs, lessons-learned).
 *
 * Day 5: editability rules are unchanged. A tender that's been
 * `closed → published` reopened goes back to the `published` field set
 * naturally because the rule is keyed on current status, not history.
 *
 * The arrays here are field names matching the keys in `tenders.$inferInsert`.
 * `updateTender` consults this list and silently drops any field outside
 * it when applying a patch — same "drop on write" pattern the companies
 * module uses for staff-only fields on company-role updates.
 */
export type TenderEditableField =
  | "title"
  | "description"
  | "referenceNumber"
  | "sector"
  | "geography"
  | "eligibleSector"
  | "eligibleGeography"
  | "minAnnualTurnoverInr"
  | "msmeOnly"
  | "openingDate"
  | "closingDate"
  | "internalNotes";

/**
 * Every editable field across all statuses. Used by `draft` (all of
 * them) and as the master list `updateTender` iterates over.
 */
const ALL_EDITABLE_FIELDS: readonly TenderEditableField[] = [
  "title",
  "description",
  "referenceNumber",
  "sector",
  "geography",
  "eligibleSector",
  "eligibleGeography",
  "minAnnualTurnoverInr",
  "msmeOnly",
  "openingDate",
  "closingDate",
  "internalNotes",
] as const;

/**
 * Eligibility fields locked once a tender is published. Used to compute
 * the `published`-status editable set.
 */
const ELIGIBILITY_FIELDS: ReadonlySet<TenderEditableField> = new Set<TenderEditableField>([
  "eligibleSector",
  "eligibleGeography",
  "minAnnualTurnoverInr",
  "msmeOnly",
]);

/**
 * Returns the set of fields that may be edited on a row in the given
 * status. Always returns a Set so the caller can do
 * `editable.has(fieldName)` in a tight loop without allocating.
 */
export function getEditableFieldsForStatus(
  status: TenderStatus,
): ReadonlySet<TenderEditableField> {
  switch (status) {
    case "draft":
      return new Set(ALL_EDITABLE_FIELDS);

    case "published":
      // Everything except the four locked eligibility fields.
      return new Set(
        ALL_EDITABLE_FIELDS.filter((f) => !ELIGIBILITY_FIELDS.has(f)),
      );

    case "closed":
    case "awarded":
      // Only internal notes — staff still need to track evaluations and
      // post-award context.
      return new Set<TenderEditableField>(["internalNotes"]);
  }
}

/**
 * True when the tender row at this status accepts at least one editable
 * field. Used by the UI to decide whether to show the "Edit" button at
 * all. (`awarded` and `closed` return `true` because internalNotes is
 * still editable — the edit form will just present a single field.)
 */
export function isAnyFieldEditable(status: TenderStatus): boolean {
  return getEditableFieldsForStatus(status).size > 0;
}

// ── Apply gate ────────────────────────────────────────────────────────────

/**
 * Whether applications are currently being accepted on a tender. Only
 * `published` tenders accept applications — `draft` is invisible, and
 * `closed` / `awarded` are past the window.
 *
 * Date checks (closingDate) live separately in `applyToTender` because
 * they need the row's actual date values; this function only handles
 * the status-level gate.
 */
export function acceptsApplications(status: TenderStatus): boolean {
  return status === "published";
}

// ── Application transition table (Day 5) ──────────────────────────────────

/**
 * Application status transitions, structured the same way as the tender
 * transitions above. Centralising here means `updateApplicationStatus`,
 * `withdrawApplication`, `reinstateApplication`, and `recallApplication`
 * all consult the same source of truth.
 *
 * Forward path:
 *     submitted ──▶ shortlisted (staff)
 *     submitted ──▶ rejected    (staff)
 *     submitted ──▶ withdrawn   (company on own)
 *
 * Reversals (Day 5):
 *     shortlisted ──▶ submitted (admin/staff; clears decidedAt)
 *     rejected    ──▶ submitted (admin/staff; clears decidedAt)
 *     withdrawn   ──▶ submitted (company on own; within recall window)
 *
 * Terminal forms: there are none. Even withdrawn is reversible inside
 * the recall window, and shortlisted / rejected can be reinstated any
 * time before delete.
 */
const LEGAL_APPLICATION_TRANSITIONS: Record<
  TenderApplicationStatus,
  ReadonlySet<TenderApplicationStatus>
> = {
  submitted: new Set<TenderApplicationStatus>([
    "shortlisted",
    "rejected",
    "withdrawn",
  ]),
  shortlisted: new Set<TenderApplicationStatus>(["submitted"]),
  rejected: new Set<TenderApplicationStatus>(["submitted"]),
  withdrawn: new Set<TenderApplicationStatus>(["submitted"]),
};

/**
 * Is the application transition `from → to` legal?
 *
 * Same semantics as `isLegalTransition` for tenders — `from === to` is
 * NOT legal here; callers short-circuit on no-op transitions before
 * consulting this function.
 */
export function isLegalApplicationTransition(
  from: TenderApplicationStatus,
  to: TenderApplicationStatus,
): boolean {
  return LEGAL_APPLICATION_TRANSITIONS[from].has(to);
}

/**
 * Human-friendly error string for an illegal application transition.
 * Mirrors `illegalTransitionMessage` for the tender side.
 */
export function illegalApplicationTransitionMessage(
  from: TenderApplicationStatus,
  to: TenderApplicationStatus,
): string {
  if (from === to) {
    return `Application is already ${from}`;
  }
  // Common cases get hand-tuned copy; everything else falls through to
  // the generic message.
  if (from === "withdrawn" && to !== "submitted") {
    return "Withdrawn applications can only be recalled (submitted again), not moved directly to another status";
  }
  if ((from === "shortlisted" || from === "rejected") && to === "withdrawn") {
    return "Staff cannot withdraw an application on a company's behalf";
  }
  return `Cannot transition application from ${from} to ${to}`;
}

// ── Recall window (Day 5) ─────────────────────────────────────────────────

/**
 * Number of days a company has, after withdrawing their own application,
 * to recall it back to submitted. After this window the withdrawal is
 * effectively permanent (the row remains for audit; the UI hides the
 * recall affordance).
 *
 * 7 days matches a typical business week — long enough for a Monday-
 * morning regret to be actioned, short enough that stale withdrawals
 * don't reappear weeks later and surprise staff.
 *
 * Hard-coded on purpose. If we later need per-tender configurability
 * (some procurements run on tighter cycles), lifting this to a column
 * on `tenders` is a small change — the call site becomes
 * `isWithinRecallWindow(decidedAt, tender.recallWindowDays ?? RECALL_WINDOW_DAYS)`.
 */
export const RECALL_WINDOW_DAYS = 7;

/**
 * Returns `true` when the elapsed time since `decidedAt` is within the
 * recall window.
 *
 * Accepts both ISO formats currently in the DB:
 *   - SQLite `datetime('now')` style:  "2026-05-16 22:14:33"
 *   - JS `toISOString()` style:        "2026-05-16T22:14:33.000Z"
 * (See Day-3 tech debt note about timestamp format inconsistency.)
 *
 * Returns `false` when `decidedAt` is null/empty — a record with no
 * decision time can't be inside any window. Also returns `false` if the
 * timestamp parses to NaN (malformed), failing closed.
 *
 * @example
 *   if (!isWithinRecallWindow(application.decidedAt)) {
 *     return { ok: false, error: "Recall window has passed" };
 *   }
 */
export function isWithinRecallWindow(decidedAt: string | null): boolean {
  if (!decidedAt) return false;

  // Normalise to a parseable ISO string. SQLite's space-separated form
  // is rejected by some date parsers; swap the space for T.
  const normalised = decidedAt.includes("T")
    ? decidedAt
    : decidedAt.replace(" ", "T") + "Z"; // assume UTC for the space form

  const decidedMs = Date.parse(normalised);
  if (Number.isNaN(decidedMs)) {
    // Defensive: malformed timestamps fail closed. The caller will
    // surface a friendly error; the audit log captures the bad value.
    return false;
  }

  const elapsedMs = Date.now() - decidedMs;
  const windowMs = RECALL_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return elapsedMs >= 0 && elapsedMs <= windowMs;
}

/**
 * Number of whole days elapsed since `decidedAt`, used by the UI to
 * show "Withdrawn 3 days ago — can recall for 4 more days" and by the
 * audit metadata on `application_recalled` events.
 *
 * Returns `null` for null / malformed input. Negative values (future
 * timestamps) are clamped to 0 — they shouldn't happen but if they do
 * we'd rather not surface "withdrawn -1 days ago" in the UI.
 */
export function daysSince(decidedAt: string | null): number | null {
  if (!decidedAt) return null;
  const normalised = decidedAt.includes("T")
    ? decidedAt
    : decidedAt.replace(" ", "T") + "Z";
  const ms = Date.parse(normalised);
  if (Number.isNaN(ms)) return null;
  const elapsedDays = Math.floor((Date.now() - ms) / (1000 * 60 * 60 * 24));
  return Math.max(0, elapsedDays);
}
```

## Form Primitives

All domain forms compose these. Never reinvent — extend if a new primitive is needed and add it under `components/forms/`.

### `components/forms/form-field.tsx`

```tsx
/**
 * FormField — reusable wrapper around a single labelled form input.
 *
 * Replaces the inline `<Label>` + `<Input>` + `<p role="alert">` triplet
 * that the login page currently does manually. Every form in the app
 * should use this so spacing, error display, label-input association,
 * and screen-reader hooks are consistent everywhere.
 *
 * Usage:
 *
 *   <FormField
 *     name="email"
 *     label="Email"
 *     required
 *     description="We'll use this for compliance reminders."
 *     error={errors.email?.message}
 *   >
 *     <Input type="email" {...register("email")} />
 *   </FormField>
 *
 * The `name` prop drives:
 *   - `htmlFor` on the label
 *   - `id` on the input (via React.cloneElement, see implementation)
 *   - `aria-describedby` linkage to description + error
 *
 * @module components/forms/form-field
 */
import * as React from "react";
import { AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";

// ── Props ───────────────────────────────────────────────────────────────────

export interface FormFieldProps {
  /**
   * Field identifier. Used for `htmlFor`, child `id`, and aria linkages.
   * Should match the field name in your form schema for consistency.
   */
  name: string;

  /** Visible label text. */
  label: string;

  /** Mark with a subtle asterisk if true. Required-ness is enforced by
   *  the Zod schema, not this prop — the asterisk is purely visual. */
  required?: boolean;

  /** Optional hint shown below the label, above the input. */
  description?: string;

  /** Optional error message — typically `errors.fieldName?.message`
   *  from react-hook-form. Renders below the input in destructive style. */
  error?: string;

  /** The actual input element (Input, Select, Textarea, Switch, etc.). */
  children: React.ReactNode;

  /** Extra classes for the outer wrapper. */
  className?: string;
}

// ── Component ───────────────────────────────────────────────────────────────

export function FormField({
  name,
  label,
  required,
  description,
  error,
  children,
  className,
}: FormFieldProps) {
  const descriptionId = description ? `${name}-description` : undefined;
  const errorId = error ? `${name}-error` : undefined;

  // ARIA: link the input to its description and error via space-joined IDs.
  // React.cloneElement injects id + aria-* props onto whatever the caller
  // passed as `children`. This means callers don't have to repeat the id
  // or aria attrs every time — they just pass the component.
  const enhancedChild = React.isValidElement<{
    id?: string;
    "aria-describedby"?: string;
    "aria-invalid"?: boolean;
  }>(children)
    ? React.cloneElement(children, {
        id: children.props.id ?? name,
        "aria-describedby":
          [descriptionId, errorId].filter(Boolean).join(" ") || undefined,
        "aria-invalid": error ? true : undefined,
      })
    : children;

  return (
    <div className={cn("space-y-1.5", className)}>
      <Label
        htmlFor={name}
        className="flex items-center gap-1 text-sm font-medium text-foreground"
      >
        {label}
        {required && (
          <span
            aria-hidden
            className="text-destructive"
            title="Required field"
          >
            *
          </span>
        )}
      </Label>

      {description && !error && (
        <p
          id={descriptionId}
          className="text-xs text-muted-foreground"
        >
          {description}
        </p>
      )}

      {enhancedChild}

      {error && (
        <p
          id={errorId}
          role="alert"
          className="flex items-start gap-1.5 text-xs text-destructive"
        >
          <AlertCircle
            className="mt-0.5 h-3 w-3 shrink-0"
            aria-hidden
          />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
```

### `components/forms/form-section.tsx`

```tsx
/**
 * FormSection — visual grouping for a related batch of form fields.
 *
 * Every form in the app divides its fields into sections (Identity,
 * Compliance, Contact, etc.). This component keeps the section header
 * styling, spacing, and divider treatment consistent across the whole
 * app.
 *
 * Usage:
 *
 *   <FormSection
 *     title="Identity"
 *     description="Basic information about the company."
 *   >
 *     <FormField name="name" label="Company name" required>...</FormField>
 *     <FormField name="sector" label="Sector" required>...</FormField>
 *   </FormSection>
 *
 * Sections render as: title (h2) + optional one-line description, then
 * a responsive grid of children. Single-column on mobile, 2-column from
 * `md:` up.
 *
 * @module components/forms/form-section
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// ── Props ───────────────────────────────────────────────────────────────────

export interface FormSectionProps {
  /** Section heading shown above the fields. */
  title: string;

  /** Optional one-line description shown muted below the title. */
  description?: string;

  /** The fields inside this section. Typically several `<FormField>`s. */
  children: ReactNode;

  /**
   * Layout for the children grid:
   *   - "grid" (default) — 1 column mobile, 2 columns md+
   *   - "stack" — always 1 column (use for full-width fields like
   *     textarea, address line, internal notes)
   */
  layout?: "grid" | "stack";

  /** Extra classes for the section wrapper. */
  className?: string;
}

// ── Component ───────────────────────────────────────────────────────────────

export function FormSection({
  title,
  description,
  children,
  layout = "grid",
  className,
}: FormSectionProps) {
  return (
    <section
      className={cn(
        // Each section gets a top border for visual separation, except
        // the first one — `first:border-t-0` neutralises it when this
        // is the first section in a form.
        "border-t border-border pt-6 first:border-t-0 first:pt-0",
        className,
      )}
    >
      <header className="mb-4">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </header>

      <div
        className={cn(
          "gap-4",
          layout === "grid"
            ? "grid grid-cols-1 md:grid-cols-2"
            : "flex flex-col",
        )}
      >
        {children}
      </div>
    </section>
  );
}
```

### `components/forms/sticky-action-bar.tsx`

```tsx
/**
 * StickyActionBar — bottom-of-viewport submit/cancel strip that follows
 * scroll on long forms.
 *
 * The companies form has 6 sections and ~15 fields. On smaller viewports
 * the user has to scroll meaningfully to reach the submit button at the
 * bottom. A sticky bar keeps Save and Cancel within reach regardless of
 * scroll position, which is especially valuable for fast power-users
 * who want to submit the moment they've filled in the required fields
 * without scrolling all the way down.
 *
 * Layout:
 *   - Fixed to the bottom of the viewport with a top border + shadow
 *   - White background (matches card surfaces in Warm Ambient)
 *   - Content slides under it — pages that use this should add bottom
 *     padding to their main scroll area so nothing's hidden behind
 *
 * Server-Component-compatible (no hooks). All interactivity lives in
 * the `children` (typically a couple of Buttons).
 *
 * Usage:
 *
 *   <StickyActionBar>
 *     <Button variant="outline" type="button" onClick={onCancel}>
 *       Cancel
 *     </Button>
 *     <Button type="submit" disabled={isSubmitting}>
 *       Save company
 *     </Button>
 *   </StickyActionBar>
 *
 * @module components/forms/sticky-action-bar
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// ── Props ───────────────────────────────────────────────────────────────────

export interface StickyActionBarProps {
  /**
   * Optional helper / status text on the left side of the bar.
   * Common uses: "* required field", "Last saved 2 min ago", "Unsaved
   * changes" hint.
   */
  helper?: ReactNode;

  /**
   * Right-aligned action buttons. Typically Cancel + Submit.
   */
  children: ReactNode;

  /** Extra classes for the inner content row. */
  className?: string;
}

// ── Component ───────────────────────────────────────────────────────────────

export function StickyActionBar({
  helper,
  children,
  className,
}: StickyActionBarProps) {
  return (
    <div
      className={cn(
        // Fixed to viewport bottom. `inset-x-0` makes it span the full
        // viewport width, ignoring the sidebar — that's intentional so
        // the bar feels grounded to the screen, not the content area.
        // The sidebar's own z-index keeps it on top of the bar so they
        // don't visually fight.
        "sticky bottom-0 left-0 right-0 z-30 -mx-6 mt-8 lg:-mx-10",
        // Surface treatment — white bg, top border, subtle shadow rising
        // upward from the bar so the form content above visibly tucks
        // behind it on scroll.
        "border-t border-border bg-card",
        "shadow-[0_-4px_6px_-4px_rgba(0,0,0,0.05)]",
      )}
    >
      <div
        className={cn(
          "flex flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center sm:justify-between lg:px-10",
          className,
        )}
      >
        {/* Left side — helper / status. Hidden on mobile so the actions
            get the whole row, prevents wrapping that crams the buttons. */}
        <div className="hidden text-sm text-muted-foreground sm:block">
          {helper}
        </div>

        {/* Right side — buttons. `flex-wrap` keeps narrow viewports
            graceful; `gap-2` matches the rest of the design system. */}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {children}
        </div>
      </div>
    </div>
  );
}
```

### `components/forms/use-unsaved-changes-guard.ts`

```typescript
/**
 * useUnsavedChangesGuard — block accidental navigation from a dirty form.
 *
 * When a form has unsaved changes, this hook attaches a `beforeunload`
 * listener so closing the tab, refreshing, or hitting back triggers
 * the browser's native "Leave site?" confirmation. We can't customise
 * the message — modern browsers ignore custom strings for security
 * reasons — but the prompt itself fires.
 *
 * What this hook does NOT catch: client-side `router.push()` navigation
 * (e.g. clicking a sidebar link). Next.js App Router doesn't expose a
 * `router events` API the same way Pages Router did, and the workarounds
 * (intercepting Link clicks, patching pushState) are fragile.
 *
 * For Phase 1, the browser-level guard is adequate — it covers the
 * accidental tab-close / refresh case which is the most common way
 * staff would lose work. Client-side nav lost-work is a follow-up
 * improvement that needs a more careful design.
 *
 * Usage inside a Client Component:
 *
 *   const { formState } = useForm({...});
 *   useUnsavedChangesGuard(formState.isDirty && !formState.isSubmitting);
 *
 * @module components/forms/use-unsaved-changes-guard
 */
"use client";

import { useEffect } from "react";

/**
 * @param enabled When true, attach the beforeunload listener. Pass
 *                a derived boolean — typically `formState.isDirty &&
 *                !formState.isSubmitting`. When false, the listener
 *                detaches and navigation works without prompts.
 */
export function useUnsavedChangesGuard(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    /**
     * The handler MUST call preventDefault and set returnValue for the
     * browser to actually show the prompt. Some browsers also want a
     * non-empty `event.returnValue` string. The string itself isn't
     * shown to the user — browsers display a generic localised message.
     */
    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      // Legacy compat — some browsers require this assignment.
      event.returnValue = "";
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [enabled]);
}
```

## Domain Form — Reference Implementation

How a real form ties together: Server Action handling, optimistic UI, unsaved-changes guard, sticky action bar. `components/tenders/tender-form.tsx` follows the same pattern and is omitted here.

### `components/companies/company-form.tsx`

```tsx
/**
 * Company form — shared between Create and Edit.
 *
 * Client Component. Owns form state via react-hook-form. Validation runs
 * both client-side (for UX) and server-side (authoritative) using the
 * same Zod schemas from lib/companies/schemas.ts.
 *
 * Mode is driven by the presence of `initialValues`:
 *
 *   - `initialValues` undefined  → create mode
 *       - calls createCompany() Server Action
 *       - validates against createCompanySchema (all required fields enforced)
 *       - redirects to /dashboard/companies on success
 *       - button reads "Save company"
 *
 *   - `initialValues` defined    → edit mode
 *       - calls updateCompany() Server Action (passing id from initialValues)
 *       - validates against the same schema shape — server uses
 *         updateCompanySchema which accepts partial input
 *       - redirects to /dashboard/companies/{id} on success
 *       - button reads "Save changes"
 *       - form starts pre-populated with the existing row's values
 *
 * Architecture:
 *   - One form, one submit. Six visually-sectioned blocks via
 *     `<FormSection>` so the user can mentally chunk progress without
 *     wizard friction.
 *   - Inline Zod resolver (same pattern as login) — avoids the
 *     @hookform/resolvers + Zod 4 compatibility issues.
 *   - On-blur validation per field — surface errors next to the field
 *     the user just left, not in a wall at submit time.
 *   - Sticky action bar at the bottom so Cancel / Save stay reachable
 *     while scrolling.
 *   - Unsaved-changes guard prompts before tab close / refresh.
 *
 * @module components/companies/company-form
 */
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm, Controller } from "react-hook-form";
import { AlertCircle, Save, X } from "lucide-react";
import { createCompany, updateCompany } from "@/lib/companies/actions";
import {
  createCompanySchema,
  type CreateCompanyInput,
} from "@/lib/companies/schemas";
import type { Company } from "@/lib/db/schema";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { FormSection } from "@/components/forms/form-section";
import { FormField } from "@/components/forms/form-field";
import { StickyActionBar } from "@/components/forms/sticky-action-bar";
import { useUnsavedChangesGuard } from "@/components/forms/use-unsaved-changes-guard";
import { PartnerPicker } from "@/app/dashboard/companies/new/_components/partner-picker";

// ── Props ───────────────────────────────────────────────────────────────────

export interface CompanyFormProps {
  /**
   * Existing companies for the JV partner picker typeahead. id+name
   * only — fetched server-side in the parent page.
   *
   * In edit mode, the current company is filtered out of this list so
   * a company can't list itself as its own JV partner. The parent page
   * handles this filtering before passing the list down.
   */
  existingCompanies: Array<{ id: string; name: string }>;

  /**
   * When present, the form is in EDIT mode and pre-populated with these
   * values. When absent, the form is in CREATE mode.
   *
   * We accept the full Company row (not just the form-shape input)
   * because the parent fetches the row anyway, and reusing the type
   * keeps the call site clean.
   */
  initialValues?: Company;
}

// ── Default values ──────────────────────────────────────────────────────────

/**
 * Defaults for CREATE mode. All optional fields default to empty string
 * (controlled inputs from the start, no controlled-vs-uncontrolled
 * warnings) and get normalised back to null at submit time.
 */
const CREATE_DEFAULTS: CreateCompanyInput = {
  name: "",
  sector: "",
  geography: "",
  gstNumber: null,
  panNumber: null,
  isMsme: false,
  isJv: false,
  parentCompanyIds: null,
  contactEmail: null,
  contactPhone: null,
  contactPersonName: null,
  addressLine: null,
  city: null,
  state: null,
  pincode: null,
  internalNotes: null,
};

/**
 * Build EDIT-mode defaults from a Company row. Strips fields the form
 * doesn't manage (id, complianceStatus, createdAt, updatedAt) and
 * normalises empty strings to null.
 *
 * Note: complianceStatus is intentionally NOT exposed on this form.
 * It's a staff-only field that should be changed deliberately on a
 * separate workflow (not buried in a CRUD edit form). When that
 * workflow ships, it'll have its own dedicated UI.
 */
function buildEditDefaults(company: Company): CreateCompanyInput {
  return {
    name: company.name,
    sector: company.sector,
    geography: company.geography,
    gstNumber: company.gstNumber,
    panNumber: company.panNumber,
    isMsme: company.isMsme,
    isJv: company.isJv,
    parentCompanyIds: company.parentCompanyIds,
    contactEmail: company.contactEmail,
    contactPhone: company.contactPhone,
    contactPersonName: company.contactPersonName,
    addressLine: company.addressLine,
    city: company.city,
    state: company.state,
    pincode: company.pincode,
    internalNotes: company.internalNotes,
  };
}

// ── Component ───────────────────────────────────────────────────────────────

export function CompanyForm({
  existingCompanies,
  initialValues,
}: CompanyFormProps) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const isEditMode = initialValues !== undefined;

  const {
    register,
    handleSubmit,
    control,
    watch,
    setError,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<CreateCompanyInput>({
    /**
     * Inline Zod resolver — `safeParse` on every validate call. Same
     * structure as login: success → values + empty errors; failure →
     * empty values + field-keyed error map.
     *
     * Both modes use `createCompanySchema` for client-side validation.
     * The server uses updateCompanySchema for edit, which accepts
     * partial input — but client-side we want to enforce "the row
     * after edit must still be valid" which means full validation.
     */
    resolver: async (rawValues) => {
      // Normalise blanks: optional text fields where the input was
      // never touched come through as "". Zod expects null for those.
      const values = normaliseFormValues(rawValues);

      const result = createCompanySchema.safeParse(values);
      if (result.success) {
        return { values: result.data, errors: {} };
      }
      const errs: Record<string, { type: string; message: string }> = {};
      for (const issue of result.error.issues) {
        const path = issue.path.join(".");
        if (path && !errs[path]) {
          errs[path] = { type: issue.code, message: issue.message };
        }
      }
      return { values: {}, errors: errs };
    },
    defaultValues: isEditMode
      ? buildEditDefaults(initialValues)
      : CREATE_DEFAULTS,
    mode: "onBlur",
  });

  // Block tab close / refresh when form is dirty (and not currently
  // being submitted — we don't want the prompt during the redirect).
  useUnsavedChangesGuard(isDirty && !isSubmitting && !isPending);

  // Watch isJv to conditionally show the partner picker.
  const isJv = watch("isJv");

  // ── Submit handler ────────────────────────────────────────────────────────
  //
  // Branches on mode. Both branches use startTransition for the action
  // call (drives button disabled state) but fire-and-forget the
  // navigation so the transition can settle without waiting on the
  // destination's RSC payload.

  function onSubmit(data: CreateCompanyInput) {
    setServerError(null);

    startTransition(async () => {
      const result = isEditMode
        ? await updateCompany({ id: initialValues.id, ...data })
        : await createCompany(data);

      if (!result.ok) {
        // Field-targeted error → highlight the offending input.
        if (result.field) {
          setError(result.field as keyof CreateCompanyInput, {
            type: "server",
            message: result.error,
          });
        } else {
          setServerError(result.error);
        }
        return;
      }

      // Success. Destination differs by mode:
      //   - Edit: back to the detail page (just-edited row visible)
      //   - Create: companies list (new row appears at top)
      router.replace(
        isEditMode
          ? `/dashboard/companies/${initialValues.id}`
          : "/dashboard/companies",
      );
    });
  }

  const submitDisabled = isSubmitting || isPending;
  const cancelHref = isEditMode
    ? `/dashboard/companies/${initialValues.id}`
    : "/dashboard/companies";

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-8">
      {/* Top-of-form server error banner. Field errors render inline. */}
      {serverError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>
            {isEditMode ? "Could not save changes" : "Could not save company"}
          </AlertTitle>
          <AlertDescription>{serverError}</AlertDescription>
        </Alert>
      )}

      {/* Section 1: Identity ─────────────────────────────────────── */}
      <FormSection
        title="Identity"
        description="Basic information about the company."
      >
        <FormField
          name="name"
          label="Company name"
          required
          error={errors.name?.message}
          className="md:col-span-2"
        >
          <Input
            type="text"
            placeholder="Acme Construction Pvt Ltd"
            disabled={submitDisabled}
            {...register("name")}
          />
        </FormField>

        <FormField
          name="sector"
          label="Sector"
          required
          description="e.g. Infrastructure, Civil Works, IT Services"
          error={errors.sector?.message}
        >
          <Input
            type="text"
            placeholder="Infrastructure"
            disabled={submitDisabled}
            {...register("sector")}
          />
        </FormField>

        <FormField
          name="geography"
          label="Geography"
          required
          description="e.g. Pan India, Maharashtra, Delhi NCR"
          error={errors.geography?.message}
        >
          <Input
            type="text"
            placeholder="Pan India"
            disabled={submitDisabled}
            {...register("geography")}
          />
        </FormField>
      </FormSection>

      {/* Section 2: Identifiers ──────────────────────────────────── */}
      <FormSection
        title="Identifiers"
        description="GST and PAN can be added later — leave blank if not yet available."
      >
        <FormField
          name="gstNumber"
          label="GSTIN"
          description="15 characters, government-issued"
          error={errors.gstNumber?.message}
        >
          <Input
            type="text"
            placeholder="27ABCDE1234F1Z5"
            autoCapitalize="characters"
            disabled={submitDisabled}
            {...register("gstNumber", {
              setValueAs: (v) => (v === "" ? null : v?.toUpperCase()),
            })}
          />
        </FormField>

        <FormField
          name="panNumber"
          label="PAN"
          description="10 characters"
          error={errors.panNumber?.message}
        >
          <Input
            type="text"
            placeholder="ABCDE1234F"
            autoCapitalize="characters"
            disabled={submitDisabled}
            {...register("panNumber", {
              setValueAs: (v) => (v === "" ? null : v?.toUpperCase()),
            })}
          />
        </FormField>

        <FormField
          name="isMsme"
          label="MSME registered"
          description="Toggle on if the company is registered under the MSME scheme."
          error={errors.isMsme?.message}
        >
          <Controller
            name="isMsme"
            control={control}
            render={({ field }) => (
              <div className="flex items-center gap-2">
                <Switch
                  id="isMsme"
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  disabled={submitDisabled}
                />
                <span className="text-sm text-muted-foreground">
                  {field.value ? "Yes" : "No"}
                </span>
              </div>
            )}
          />
        </FormField>
      </FormSection>

      {/* Section 3: Joint Venture ────────────────────────────────── */}
      <FormSection
        title="Joint venture"
        description="Toggle on if this entry represents a JV between existing companies."
      >
        <FormField
          name="isJv"
          label="Is this a joint venture?"
          error={errors.isJv?.message}
          className="md:col-span-2"
        >
          <Controller
            name="isJv"
            control={control}
            render={({ field }) => (
              <div className="flex items-center gap-2">
                <Switch
                  id="isJv"
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  disabled={submitDisabled}
                />
                <span className="text-sm text-muted-foreground">
                  {field.value ? "Yes" : "No"}
                </span>
              </div>
            )}
          />
        </FormField>

        {/* Partner picker only renders when isJv is on. */}
        {isJv && (
          <FormField
            name="parentCompanyIds"
            label="Partner companies"
            required
            description="Select at least 2 existing companies that form this joint venture."
            error={errors.parentCompanyIds?.message}
            className="md:col-span-2"
          >
            <Controller
              name="parentCompanyIds"
              control={control}
              render={({ field }) => (
                <PartnerPicker
                  options={existingCompanies}
                  value={field.value ?? []}
                  onChange={field.onChange}
                  disabled={submitDisabled}
                />
              )}
            />
          </FormField>
        )}
      </FormSection>

      {/* Section 4: Contact ──────────────────────────────────────── */}
      <FormSection
        title="Contact"
        description="Primary point of contact for this company."
      >
        <FormField
          name="contactPersonName"
          label="Contact person"
          error={errors.contactPersonName?.message}
        >
          <Input
            type="text"
            placeholder="Full name"
            disabled={submitDisabled}
            {...register("contactPersonName", {
              setValueAs: (v) => (v === "" ? null : v),
            })}
          />
        </FormField>

        <FormField
          name="contactEmail"
          label="Email"
          error={errors.contactEmail?.message}
        >
          <Input
            type="email"
            placeholder="contact@example.com"
            disabled={submitDisabled}
            {...register("contactEmail", {
              setValueAs: (v) => (v === "" ? null : v),
            })}
          />
        </FormField>

        <FormField
          name="contactPhone"
          label="Phone"
          description="Include country code (e.g. +91 22 5550 1100)"
          error={errors.contactPhone?.message}
          className="md:col-span-2"
        >
          <Input
            type="tel"
            placeholder="+91 ..."
            disabled={submitDisabled}
            {...register("contactPhone", {
              setValueAs: (v) => (v === "" ? null : v),
            })}
          />
        </FormField>
      </FormSection>

      {/* Section 5: Address ─────────────────────────────────────── */}
      <FormSection
        title="Address"
        description="Registered office or primary location."
      >
        <FormField
          name="addressLine"
          label="Street address"
          error={errors.addressLine?.message}
          className="md:col-span-2"
        >
          <Input
            type="text"
            placeholder="Plot 14, MIDC Industrial Area"
            disabled={submitDisabled}
            {...register("addressLine", {
              setValueAs: (v) => (v === "" ? null : v),
            })}
          />
        </FormField>

        <FormField name="city" label="City" error={errors.city?.message}>
          <Input
            type="text"
            placeholder="Mumbai"
            disabled={submitDisabled}
            {...register("city", {
              setValueAs: (v) => (v === "" ? null : v),
            })}
          />
        </FormField>

        <FormField
          name="state"
          label="State"
          description="Indian state or union territory"
          error={errors.state?.message}
        >
          <Input
            type="text"
            placeholder="Maharashtra"
            disabled={submitDisabled}
            {...register("state", {
              setValueAs: (v) => (v === "" ? null : v),
            })}
          />
        </FormField>

        <FormField
          name="pincode"
          label="Pincode"
          description="6-digit postal code"
          error={errors.pincode?.message}
        >
          <Input
            type="text"
            placeholder="400093"
            inputMode="numeric"
            maxLength={6}
            disabled={submitDisabled}
            {...register("pincode", {
              setValueAs: (v) => (v === "" ? null : v),
            })}
          />
        </FormField>
      </FormSection>

      {/* Section 6: Internal notes — admin/staff-only field */}
      <FormSection
        title="Internal notes"
        description="Only visible to Consultway staff. Not shared with the company."
        layout="stack"
      >
        <FormField
          name="internalNotes"
          label="Notes"
          error={errors.internalNotes?.message}
        >
          <Textarea
            rows={4}
            placeholder="Any context worth recording — relationship history, special arrangements, follow-up reminders."
            disabled={submitDisabled}
            {...register("internalNotes", {
              setValueAs: (v) => (v === "" ? null : v),
            })}
          />
        </FormField>
      </FormSection>

      {/* Sticky bottom action bar */}
      <StickyActionBar
        helper={
          <span>
            <span aria-hidden className="text-destructive">
              *
            </span>{" "}
            indicates a required field
          </span>
        }
      >
        <Button
          type="button"
          variant="outline"
          disabled={submitDisabled}
          onClick={() => router.push(cancelHref)}
        >
          <X className="h-4 w-4" aria-hidden />
          Cancel
        </Button>
        <Button type="submit" disabled={submitDisabled}>
          <Save className="h-4 w-4" aria-hidden />
          {submitDisabled
            ? "Saving..."
            : isEditMode
              ? "Save changes"
              : "Save company"}
        </Button>
      </StickyActionBar>
    </form>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert form values from RHF (where empty inputs are empty strings)
 * to the shape Zod's `createCompanySchema` expects (where optional
 * absent fields are null).
 *
 * `register` with `setValueAs` already does this per-field, but we
 * defensively run it at the form level as well — covers the case where
 * a field is set via Controller (where setValueAs doesn't apply).
 */
function normaliseFormValues(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && value === "") {
      out[key] = null;
    } else {
      out[key] = value;
    }
  }
  return out;
}
```

## Dialogs and Confirmation UI

Reuse these — do not import a new dialog library. `confirm-dialog.tsx` supports reason capture (added in day 5) for actions that need a written rationale.

### `components/ui/confirm-dialog.tsx`

```tsx
/**
 * ConfirmDialog — reusable wrapper around shadcn `<AlertDialog>` for
 * "are you sure?" prompts.
 *
 * Replaces the lazy `window.confirm()` calls that were peppered into
 * Day-4 destructive / terminal actions (Mark awarded, Withdraw
 * application). Uses the Warm Ambient palette via the same CSS
 * variables every other surface does, so it feels in-app rather than
 * like an OS dialog.
 *
 * Basic usage (no reason capture):
 *
 *   <ConfirmDialog
 *     trigger={<Button>Delete</Button>}
 *     title="Delete this record?"
 *     description="This action cannot be undone."
 *     confirmLabel="Delete"
 *     confirmVariant="destructive"
 *     onConfirm={() => deleteRecord(id)}
 *     pending={isPending}
 *   />
 *
 * Reason-capture usage (Day 5 — reversal actions):
 *
 *   <ConfirmDialog
 *     trigger={<Button>Retract award</Button>}
 *     title="Retract this award?"
 *     description="The tender will return to the closed state."
 *     confirmLabel="Retract award"
 *     confirmVariant="destructive"
 *     reasonField="required"
 *     reasonLabel="Why are you retracting this award?"
 *     reasonPlaceholder="Awarded company declined the contract…"
 *     onConfirm={(reason) => retractAward(tenderId, reason!)}
 *     pending={isPending}
 *   />
 *
 * Design notes:
 *   - The `trigger` is wrapped in `<AlertDialogTrigger asChild>` so the
 *     caller can pass any clickable element (typically a `<Button>`).
 *     The dialog opens when the trigger is clicked.
 *   - `onConfirm` is async-friendly. Callers usually wrap their Server
 *     Action call in a `useTransition` and pass `pending` to disable the
 *     Confirm button during the call. The dialog stays open until the
 *     transition settles — the caller is responsible for closing it via
 *     the `open`/`onOpenChange` pair if needed.
 *   - By default the dialog manages its own open/close state. Callers
 *     that need to control it externally (e.g. close after a success
 *     redirect) pass `open` + `onOpenChange` props.
 *   - `confirmVariant` lets the caller pick the visual weight: default
 *     for "irreversible-but-not-dangerous" (markAwarded), destructive
 *     for delete-style actions.
 *
 * ── Day 5: reason capture ──────────────────────────────────────────────
 *
 *   - `reasonField` opt-in adds a textarea between the description and
 *     the buttons. Three modes:
 *       - omitted          → no textarea (existing behaviour)
 *       - "optional"       → textarea shown; empty submission allowed,
 *                            Confirm enabled regardless. `onConfirm`
 *                            receives the trimmed reason or `undefined`
 *                            when empty.
 *       - "required"       → textarea shown; Confirm disabled until the
 *                            input has at least 5 trimmed characters
 *                            (matches `requiredReasonSchema` in
 *                            `lib/tenders/schemas.ts`). `onConfirm`
 *                            receives the trimmed reason.
 *   - The reason input state is reset every time the dialog closes so
 *     stale text doesn't persist between opens.
 *   - `onConfirm` signature widened to `(reason?: string) => void |
 *     Promise<void>`. Existing call sites that declared a no-arg
 *     handler remain compatible — TypeScript permits ignoring
 *     positional args at the call site.
 *
 * @module components/ui/confirm-dialog
 */
"use client";

import * as React from "react";
import { type VariantProps } from "class-variance-authority";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * The variant slot of `<Button>` ("default" | "outline" | "destructive"
 * | ...). Derived from the same `buttonVariants` CVA the Button file
 * exports so we never drift if a new variant lands.
 */
type ButtonVariant = NonNullable<
  VariantProps<typeof buttonVariants>["variant"]
>;

/**
 * Reason-capture mode. Mirrors the two reason-schema variants in
 * `lib/tenders/schemas.ts` (`optionalReasonSchema`, `requiredReasonSchema`).
 * Omit the prop entirely when no reason is needed.
 */
export type ReasonFieldMode = "optional" | "required";

/**
 * Minimum trimmed length when `reasonField === "required"`. Kept in
 * sync with `requiredReasonSchema.min(5, …)` in tenders/schemas.ts so
 * the client-side gate matches the server-side gate. If the schema
 * minimum ever changes, update this constant too.
 */
const REQUIRED_REASON_MIN_LENGTH = 5;

// ── Props ─────────────────────────────────────────────────────────────────

export interface ConfirmDialogProps {
  /**
   * Element that opens the dialog. Typically a `<Button>`. Cloned via
   * `asChild` so its onClick is intercepted by AlertDialogTrigger.
   */
  trigger: React.ReactNode;

  /** Dialog heading. Question form reads best: "Mark X as awarded?" */
  title: string;

  /**
   * Body text explaining the consequence. Plain string or arbitrary
   * ReactNode (for e.g. inline `<strong>`). One short paragraph is the
   * sweet spot; anything longer means the action deserves a dedicated
   * page (cf. the delete-form's type-to-confirm flow).
   */
  description: React.ReactNode;

  /** Confirm button label. Verb form: "Delete", "Mark awarded". */
  confirmLabel: string;

  /** Cancel button label. Default: "Cancel". */
  cancelLabel?: string;

  /**
   * Visual weight of the confirm button. Use `"destructive"` for
   * delete-style actions, `"default"` for irreversible-but-not-dangerous
   * (e.g. marking a tender awarded). Maps to the Button variant.
   */
  confirmVariant?: ButtonVariant;

  /**
   * Called when the user clicks Confirm. Can be sync or async; callers
   * typically wrap their Server Action call in `useTransition` and
   * pass `pending` to disable the button during the call.
   *
   * The `reason` argument is:
   *   - `undefined` when `reasonField` is omitted
   *   - the trimmed reason string, or `undefined` if the user left the
   *     textarea empty and `reasonField === "optional"`
   *   - the trimmed reason string (guaranteed non-empty) when
   *     `reasonField === "required"`
   */
  onConfirm: (reason?: string) => void | Promise<void>;

  /**
   * True while the action is in flight. Disables both buttons and
   * surfaces a "…" suffix on the confirm label.
   */
  pending?: boolean;

  /**
   * Externally controlled open state. Pair with `onOpenChange`.
   * Most callers omit this — uncontrolled mode is the default.
   */
  open?: boolean;

  /** Open-state change handler for controlled usage. */
  onOpenChange?: (open: boolean) => void;

  // ── Day 5: reason capture (all optional) ────────────────────────────

  /**
   * Add a reason textarea to the dialog. Omit entirely for no textarea
   * (default — preserves existing behaviour for every Day-4 call site).
   */
  reasonField?: ReasonFieldMode;

  /** Label above the reason textarea. Default: "Reason". */
  reasonLabel?: string;

  /** Placeholder inside the reason textarea. Default: a generic prompt. */
  reasonPlaceholder?: string;

  /**
   * Hint shown below the textarea when `reasonField === "required"`.
   * Default explains the minimum length. Pass `null` to hide entirely.
   */
  reasonHint?: React.ReactNode | null;
}

// ── Component ─────────────────────────────────────────────────────────────

export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  confirmVariant = "default",
  onConfirm,
  pending = false,
  open: openProp,
  onOpenChange: onOpenChangeProp,
  reasonField,
  reasonLabel = "Reason",
  reasonPlaceholder = "Add a brief explanation…",
  reasonHint,
}: ConfirmDialogProps) {
  // Internal uncontrolled open state. Only used when the caller didn't
  // pass `open` / `onOpenChange`. We track it ourselves so the reason
  // textarea can be reset when the dialog closes — radix's
  // uncontrolled mode doesn't expose state to us otherwise.
  const [internalOpen, setInternalOpen] = React.useState(false);
  const isControlled = openProp !== undefined;
  const isOpen = isControlled ? openProp : internalOpen;

  // Reason textarea state. Reset on close (see effect below) so stale
  // text from a previous open doesn't leak into the next session.
  const [reason, setReason] = React.useState("");

  // Bridge open-state changes: forward to the caller when controlled,
  // update internal state when uncontrolled, and always reset the
  // reason input on close.
  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      if (!next) {
        // Closing — clear the textarea so reopens start blank.
        setReason("");
      }
      if (isControlled) {
        onOpenChangeProp?.(next);
      } else {
        setInternalOpen(next);
      }
    },
    [isControlled, onOpenChangeProp],
  );

  // Computed gating: when `required`, block Confirm until min-length met.
  // When `optional`, never block on the textarea. When undefined, the
  // textarea doesn't render and this flag is always `true`.
  const trimmedReason = reason.trim();
  const reasonSatisfied =
    reasonField === "required"
      ? trimmedReason.length >= REQUIRED_REASON_MIN_LENGTH
      : true;

  const confirmDisabled = pending || !reasonSatisfied;

  // Click handler for the confirm button. Calls onConfirm with the
  // trimmed reason (or undefined for omitted / empty optional).
  // SUPPRESSES the AlertDialog's default close-on-action behaviour
  // when an action is pending OR when the reason gate hasn't been
  // satisfied — otherwise the dialog closes immediately and the user
  // loses sight of the loading state / their incomplete input.
  function handleConfirm(e: React.MouseEvent<HTMLButtonElement>) {
    if (confirmDisabled) {
      e.preventDefault();
      return;
    }

    // Resolve the reason value passed back to the caller.
    let reasonArg: string | undefined;
    if (reasonField === "required") {
      reasonArg = trimmedReason;
    } else if (reasonField === "optional") {
      reasonArg = trimmedReason.length > 0 ? trimmedReason : undefined;
    } else {
      reasonArg = undefined;
    }

    // Fire-and-forget — if onConfirm returns a promise we don't await
    // here because radix has already closed the dialog by the time the
    // promise resolves. Callers that need post-confirm state should
    // observe their own transition state, not this handler.
    void onConfirm(reasonArg);
  }

  // Default hint text for the required mode. Only shown when the
  // caller didn't pass an explicit hint or null.
  const defaultRequiredHint =
    reasonField === "required" ? (
      <p className="text-xs text-muted-foreground">
        Minimum {REQUIRED_REASON_MIN_LENGTH} characters. Captured in the
        audit log.
      </p>
    ) : null;

  // Resolve the effective hint, honoring an explicit `null` to mean
  // "no hint at all".
  const effectiveHint =
    reasonHint === undefined ? defaultRequiredHint : reasonHint;

  return (
    <AlertDialog open={isOpen} onOpenChange={handleOpenChange}>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>

        {/* Reason textarea, when opted in. Re-enable text selection on
            the input itself so the dashboard's no-select policy doesn't
            interfere with typing / pasting. */}
        {reasonField && (
          <div className="space-y-1.5">
            <Label htmlFor="confirm-dialog-reason">
              {reasonLabel}
              {reasonField === "optional" && (
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  (optional)
                </span>
              )}
            </Label>
            <Textarea
              id="confirm-dialog-reason"
              rows={3}
              maxLength={500}
              placeholder={reasonPlaceholder}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={pending}
              className="select-text resize-none"
              autoFocus
            />
            {effectiveHint}
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{cancelLabel}</AlertDialogCancel>

          {/* Wrap the confirm action in our own Button so we get the
              variant system (destructive vs default) and consistent
              styling. AlertDialogAction is a thin wrapper that we'd
              otherwise have to re-style by hand. Note: we use asChild
              so the Button is the rendered element and AlertDialogAction
              passes its click semantics through. */}
          <AlertDialogAction asChild>
            <Button
              variant={confirmVariant}
              disabled={confirmDisabled}
              onClick={handleConfirm}
            >
              {pending ? `${confirmLabel}…` : confirmLabel}
            </Button>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

### `components/ui/alert-dialog.tsx`

```tsx
"use client"

import * as React from "react"
import { AlertDialog as AlertDialogPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

function AlertDialog({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Root>) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />
}

function AlertDialogTrigger({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Trigger>) {
  return (
    <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />
  )
}

function AlertDialogPortal({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Portal>) {
  return (
    <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />
  )
}

function AlertDialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Overlay>) {
  return (
    <AlertDialogPrimitive.Overlay
      data-slot="alert-dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogContent({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content> & {
  size?: "default" | "sm"
}) {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        data-size={size}
        className={cn(
          "group/alert-dialog-content fixed top-1/2 left-1/2 z-50 grid w-full -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none data-[size=default]:max-w-xs data-[size=sm]:max-w-xs data-[size=default]:sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        {...props}
      />
    </AlertDialogPortal>
  )
}

function AlertDialogHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn(
        "grid grid-rows-[auto_1fr] place-items-center gap-1.5 text-center has-data-[slot=alert-dialog-media]:grid-rows-[auto_auto_1fr] has-data-[slot=alert-dialog-media]:gap-x-4 sm:group-data-[size=default]/alert-dialog-content:place-items-start sm:group-data-[size=default]/alert-dialog-content:text-left sm:group-data-[size=default]/alert-dialog-content:has-data-[slot=alert-dialog-media]:grid-rows-[auto_1fr]",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogFooter({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn(
        "-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 group-data-[size=sm]/alert-dialog-content:grid group-data-[size=sm]/alert-dialog-content:grid-cols-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogMedia({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-media"
      className={cn(
        "mb-2 inline-flex size-10 items-center justify-center rounded-md bg-muted sm:group-data-[size=default]/alert-dialog-content:row-span-2 *:[svg:not([class*='size-'])]:size-6",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn(
        "font-heading text-base font-medium sm:group-data-[size=default]/alert-dialog-content:group-has-data-[slot=alert-dialog-media]/alert-dialog-content:col-start-2",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn(
        "text-sm text-balance text-muted-foreground md:text-pretty *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogAction({
  className,
  variant = "default",
  size = "default",
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Action> &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <Button variant={variant} size={size} asChild>
      <AlertDialogPrimitive.Action
        data-slot="alert-dialog-action"
        className={cn(className)}
        {...props}
      />
    </Button>
  )
}

function AlertDialogCancel({
  className,
  variant = "outline",
  size = "default",
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Cancel> &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <Button variant={variant} size={size} asChild>
      <AlertDialogPrimitive.Cancel
        data-slot="alert-dialog-cancel"
        className={cn(className)}
        {...props}
      />
    </Button>
  )
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
}
```

### `components/ui/alert.tsx`

```tsx
import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const alertVariants = cva(
  "group/alert relative grid w-full gap-0.5 rounded-lg border px-2.5 py-2 text-left text-sm has-data-[slot=alert-action]:relative has-data-[slot=alert-action]:pr-18 has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current *:[svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground",
        destructive:
          "bg-card text-destructive *:data-[slot=alert-description]:text-destructive/90 *:[svg]:text-current",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "font-medium group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "text-sm text-balance text-muted-foreground md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4",
        className
      )}
      {...props}
    />
  )
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-action"
      className={cn("absolute top-2 right-2", className)}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription, AlertAction }
```

## Table + Pagination Primitives

List screens follow a fixed shape: page server-component reads filters from `searchParams` → calls a Drizzle query → renders the table + filters-bar + pagination. Use these primitives; see the companies list in the next section for the wiring.

### `components/ui/table.tsx`

```tsx
"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div
      data-slot="table-container"
      className="relative w-full overflow-x-auto"
    >
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b", className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
```

### `components/dashboard/pagination.tsx`

```tsx
/**
 * Pagination control — Client Component.
 *
 * Renders Prev / 1 2 3 ... N / Next. Each page button is a Link that
 * preserves all OTHER search params and only changes `page`. This is
 * why we're a Client Component — we read `useSearchParams()` to merge.
 *
 * A pure server-side pagination would either lose filters or require
 * threading the entire searchParams object through props. Reading
 * useSearchParams() here keeps the calling Server Component clean.
 *
 * Module location: lives in `components/dashboard/` rather than under
 * any single feature's `_components/` folder because every list page
 * (companies, tenders, projects, transactions, …) needs the same
 * widget. Originally lived under the companies module; extracted in
 * the Day 4 tenders work so the second feature didn't have to copy it.
 *
 * Display rules:
 *   - totalPages <= 7: list them all (1 2 3 4 5 6 7)
 *   - Otherwise: 1, current-1, current, current+1, totalPages, with
 *     "…" filling gaps
 *
 * @module components/dashboard/pagination
 */
"use client";

import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { cn } from "@/lib/utils";

// ── Props ─────────────────────────────────────────────────────────────────

export interface PaginationProps {
  /** 1-based current page. */
  page: number;
  /** Total number of pages available. */
  totalPages: number;
}

// ── Component ─────────────────────────────────────────────────────────────

export function Pagination({ page, totalPages }: PaginationProps) {
  const searchParams = useSearchParams();
  const pages = computePageWindow(page, totalPages);

  /**
   * Build href for a target page, preserving every other search param.
   * `page=1` is omitted (it's the default) so URLs stay clean.
   */
  function hrefForPage(target: number): string {
    const params = new URLSearchParams(searchParams.toString());
    if (target === 1) {
      params.delete("page");
    } else {
      params.set("page", String(target));
    }
    const qs = params.toString();
    return qs ? `?${qs}` : "?";
  }

  return (
    <nav className="flex items-center gap-1" aria-label="Pagination">
      <PageLink
        href={hrefForPage(page - 1)}
        disabled={page <= 1}
        label="Previous"
      >
        Previous
      </PageLink>

      {pages.map((p, i) =>
        p === "ellipsis" ? (
          <span
            key={`e-${i}`}
            className="px-2 text-muted-foreground"
            aria-hidden
          >
            …
          </span>
        ) : (
          <PageLink
            key={p}
            href={hrefForPage(p)}
            current={p === page}
            label={`Page ${p}`}
          >
            {p}
          </PageLink>
        ),
      )}

      <PageLink
        href={hrefForPage(page + 1)}
        disabled={page >= totalPages}
        label="Next"
      >
        Next
      </PageLink>
    </nav>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Decide which page numbers to show in the pagination strip.
 *
 *   totalPages ≤ 7 → list every page
 *   otherwise      → first + current±1 + last, gaps filled with "ellipsis"
 */
function computePageWindow(
  page: number,
  totalPages: number,
): Array<number | "ellipsis"> {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const set = new Set<number>([1, totalPages, page, page - 1, page + 1]);
  const sorted = [...set]
    .filter((n) => n >= 1 && n <= totalPages)
    .sort((a, b) => a - b);

  const result: Array<number | "ellipsis"> = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) {
      result.push("ellipsis");
    }
    result.push(sorted[i]);
  }
  return result;
}

/**
 * Single page button. Three visual modes:
 *   - disabled (Prev on page 1, Next on last page) — non-clickable
 *   - current — Primary background, non-clickable
 *   - normal — outlined Link
 */
function PageLink({
  href,
  current,
  disabled,
  label,
  children,
}: {
  href: string;
  current?: boolean;
  disabled?: boolean;
  label: string;
  children: React.ReactNode;
}) {
  const baseClasses =
    "inline-flex h-8 min-w-[2rem] items-center justify-center rounded-md border border-transparent px-2 text-sm transition-colors";

  if (disabled) {
    return (
      <span
        className={cn(baseClasses, "cursor-not-allowed text-muted-foreground/40")}
        aria-disabled
      >
        {children}
      </span>
    );
  }

  if (current) {
    return (
      <span
        className={cn(baseClasses, "bg-primary text-primary-foreground")}
        aria-current="page"
        aria-label={label}
      >
        {children}
      </span>
    );
  }

  return (
    <Link
      href={href}
      scroll={false}
      className={cn(
        baseClasses,
        "border-border text-foreground hover:bg-muted",
      )}
      aria-label={label}
    >
      {children}
    </Link>
  );
}
```

### `components/dashboard/page-header.tsx`

```tsx
/**
 * Page header — reusable title + subtitle + action-buttons strip.
 *
 * Every dashboard page mounts one of these as its first element. The
 * figma layout puts the page title flush against the top of the content
 * area (no separate top bar between sidebar and content), and this
 * component owns that visual.
 *
 * Usage:
 *
 *   <PageHeader
 *     title="Companies"
 *     subtitle="Manage company profiles and compliance"
 *     actions={
 *       <>
 *         <Button variant="outline">Generate Registration Link</Button>
 *         <Button>Add Company</Button>
 *       </>
 *     }
 *   />
 *
 * Server-Component-compatible (no hooks, no event handlers). Pass any
 * `actions` JSX you like — typically a few `<Button>` elements.
 *
 * @module components/dashboard/page-header
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface PageHeaderProps {
  /** Big heading text — appears as an h1 for SEO + accessibility. */
  title: string;
  /** Optional muted subtitle below the heading. */
  subtitle?: string;
  /**
   * Optional right-aligned action buttons. Rendered as-is so the
   * caller controls exact ordering and styling. Typical content:
   * one or two <Button> elements.
   */
  actions?: ReactNode;
  /** Extra wrapper classes if a page needs more vertical room. */
  className?: string;
}

export function PageHeader({
  title,
  subtitle,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <header
      className={cn(
        "mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-start sm:justify-between",
        className,
      )}
    >
      {/* Left: title + subtitle. min-w-0 prevents long titles from
          forcing the actions off-screen on narrow viewports. */}
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
        )}
      </div>

      {/* Right: actions. Wraps on small screens. */}
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      )}
    </header>
  );
}
```

## Dashboard Shell

The shell every authenticated route renders inside. The sidebar handles role-aware navigation; do not duplicate that logic per page.

### `app/layout.tsx`

```tsx
/**
 * Root layout — wraps every page.
 *
 * Responsibilities:
 *   - Register the Geist font families as CSS variables.
 *   - Set app-wide metadata (title template, description).
 *   - Apply base font + antialiased rendering on <html>.
 *
 * Any page-specific metadata is set in that page's `metadata` export
 * and merges into the `%s` slot of the title template below.
 */
import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
  display: 'swap',
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'Consultway Ops',
    template: '%s · Consultway Ops',
  },
  description:
    'Internal operations portal for Consultway Infotech — company onboarding, tenders, projects.',
  icons: {
    icon: '/favicon.ico',
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full bg-background font-sans text-foreground">
        {children}
      </body>
    </html>
  );
}
```

### `app/dashboard/layout.tsx`

```tsx
/**
 * Dashboard layout — wraps every page under /dashboard/*.
 *
 * Renders the persistent Espresso sidebar on the left and a Parchment
 * content area on the right. The session is read once here so the sidebar
 * (Client Component) gets typed props instead of fetching from its own
 * effect — keeps the layout SSR-only and the client bundle smaller.
 *
 * Auth guard: middleware.ts also redirects unauthenticated visitors to
 * /login, but we re-check here as a belt-and-suspenders measure. If the
 * cookie was deleted between middleware and render, we still bounce.
 *
 * Each child page is responsible for its own `<PageHeader>` and content
 * card — the layout intentionally does not add a top bar, because the
 * figma puts the page title flush against the top of the content area
 * (no separate header strip between sidebar and content).
 *
 * The outer wrapper carries `data-dashboard-root` so the global CSS can
 * scope its text-selection policy to the dashboard only (see
 * `app/globals.css` — the dashboard disables user-select by default on
 * read-only display text so clicks on titles / labels don't drop a text
 * caret. The login page and any future public route stay outside this
 * scope and keep their default selectable text.)
 *
 * @module app/dashboard/layout
 */
import { redirect } from "next/navigation";
import { readSession } from "@/lib/auth/session";
import { Sidebar } from "@/components/dashboard/sidebar";

export default async function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await readSession();
  if (!session) redirect("/login");

  return (
    <div
      data-dashboard-root
      className="flex min-h-screen bg-background"
    >
      {/* Sidebar — fixed width, Espresso bg, full-height. Client Component
          for usePathname() active-state. Props are plain serializable
          values passed from the server. */}
      <Sidebar
        userEmail={session.email}
        userRole={session.role}
      />

      {/* Main content area. Scrolls independently of the sidebar.
          Pages render inside an outer max-width wrapper so dense pages
          (companies list, transactions) don't sprawl on ultra-wide
          monitors. */}
      <main className="flex-1 overflow-x-hidden">
        <div className="mx-auto w-full max-w-screen-2xl px-6 py-8 lg:px-10 lg:py-10">
          {children}
        </div>
      </main>
    </div>
  );
}
```

### `components/dashboard/sidebar.tsx`

```tsx
/**
 * Sidebar navigation for the dashboard area.
 *
 * Client Component because it needs `usePathname()` to derive the active
 * nav item. Everything else is static — the nav items array is hard-coded
 * here (no separate config file) because the list is short, rarely
 * changes, and would be premature abstraction.
 *
 * Active state uses prefix match, not exact equality. Why: when the user
 * navigates from /dashboard/companies → /dashboard/companies/abc-123, we
 * still want "Companies" highlighted. Exact match would lose the active
 * state on detail pages.
 *
 * Role-based visibility is intentionally NOT enforced here. Access control
 * is the page's job (each page reads its own session and decides what to
 * render). The sidebar shows everything so the surface is consistent —
 * if a `company`-role user clicks Reports, they get a 403 page when that
 * module is built, not a missing nav item.
 *
 * @module components/dashboard/sidebar
 */
"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import {
  LayoutDashboard,
  Building2,
  FileText,
  Briefcase,
  ArrowLeftRight,
  BarChart3,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { UserRole } from "@/lib/db/schema";
import { UserPill } from "./user-pill";

// ── Nav items ───────────────────────────────────────────────────────────────

/**
 * One nav item. `href` doubles as the prefix-match key for active state.
 */
type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
};

/**
 * All seven dashboard sections, in display order. Order matches the
 * figma. Settings is intentionally last; the visual gap before it isn't
 * needed because the user pill at the bottom of the sidebar provides
 * enough separation.
 */
const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/dashboard/companies", label: "Companies", icon: Building2 },
  { href: "/dashboard/tenders", label: "Tenders", icon: FileText },
  { href: "/dashboard/projects", label: "Projects", icon: Briefcase },
  {
    href: "/dashboard/transactions",
    label: "Transactions",
    icon: ArrowLeftRight,
  },
  { href: "/dashboard/reports", label: "Reports", icon: BarChart3 },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

// ── Props ───────────────────────────────────────────────────────────────────

export interface SidebarProps {
  /** Logged-in user's email — passed straight through to the user pill. */
  userEmail: string;
  /** Logged-in user's role. Used only by the user pill for display. */
  userRole: UserRole;
}

// ── Component ───────────────────────────────────────────────────────────────

export function Sidebar({ userEmail, userRole }: SidebarProps) {
  const pathname = usePathname();

  return (
    <aside
      aria-label="Primary navigation"
      className={cn(
        "sticky top-0 flex h-screen w-64 shrink-0 flex-col",
        "bg-sidebar text-sidebar-foreground",
        "border-r border-sidebar-border",
      )}
    >
      {/* Brand header */}
      <div className="flex items-center gap-3 px-5 py-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-sidebar-primary">
          <Building2
            className="h-5 w-5 text-sidebar-primary-foreground"
            aria-hidden
          />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold leading-tight">
            Consultway Ops
          </p>
          <p className="mt-0.5 text-xs leading-tight text-sidebar-foreground/60">
            Internal portal
          </p>
        </div>
      </div>

      {/* Nav items — scrolls if it ever overflows (it won't at 7 items,
          but defensive). */}
      <nav className="flex-1 overflow-y-auto px-3 py-2">
        <ul className="space-y-1">
          {NAV_ITEMS.map((item) => {
            const isActive = isPathActive(pathname, item.href);
            const Icon = item.icon;

            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "group flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    // Inactive state — quiet, muted text
                    "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground",
                    // Active state — Terracotta accent, full opacity
                    isActive &&
                      "bg-sidebar-primary text-sidebar-primary-foreground hover:bg-sidebar-primary hover:text-sidebar-primary-foreground",
                  )}
                >
                  <Icon
                    className={cn(
                      "h-4 w-4 shrink-0",
                      isActive
                        ? "text-sidebar-primary-foreground"
                        : "text-sidebar-foreground/60 group-hover:text-sidebar-foreground",
                    )}
                    aria-hidden
                  />
                  <span>{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* User pill — bottom of sidebar, includes sign-out */}
      <div className="border-t border-sidebar-border p-3">
        <UserPill email={userEmail} role={userRole} />
      </div>
    </aside>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Determine whether a nav item is active for the current pathname.
 *
 *   /dashboard          matches only /dashboard exactly — otherwise the
 *                       Dashboard item would light up for EVERY subpage,
 *                       since every dashboard URL starts with /dashboard.
 *   /dashboard/<x>      matches /dashboard/x and any deeper path (e.g.
 *                       /dashboard/x/123 or /dashboard/x/123/edit).
 */
function isPathActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") {
    return pathname === "/dashboard";
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}
```

### `components/dashboard/user-pill.tsx`

```tsx
/**
 * User pill — bottom-of-sidebar identity widget.
 *
 * Shows the user's display label (email by default) and role, plus a
 * sign-out button. Sign-out posts to the `logout` Server Action which
 * clears the session cookie and redirects to /login.
 *
 * Client Component so the form's submit handler can be wired up without
 * a page-level form action. The logout action is imported from the
 * "use server" file and called via a form action prop — this is the
 * cleanest pattern for triggering Server Actions from buttons that
 * don't need progressive-enhancement fallbacks.
 *
 * @module components/dashboard/user-pill
 */
"use client";

import { LogOut, UserCircle2 } from "lucide-react";
import { logout } from "@/lib/auth/actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { UserRole } from "@/lib/db/schema";

export interface UserPillProps {
  /** Email shown as the primary identity label. */
  email: string;
  /** Role badge text below the email. */
  role: UserRole;
}

export function UserPill({ email, role }: UserPillProps) {
  return (
    <div className="flex items-center gap-3">
      {/* Avatar circle. No image upload yet; renders a generic icon. */}
      <div
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
          "bg-sidebar-accent text-sidebar-accent-foreground",
        )}
        aria-hidden
      >
        <UserCircle2 className="h-5 w-5" />
      </div>

      {/* Identity labels. `min-w-0` allows the truncate to actually
          take effect — without it, the flex item refuses to shrink. */}
      <div className="min-w-0 flex-1">
        <p
          className="truncate text-sm font-medium text-sidebar-foreground"
          title={email}
        >
          {email}
        </p>
        <p className="mt-0.5 text-xs capitalize text-sidebar-foreground/60">
          {role}
        </p>
      </div>

      {/* Sign-out trigger. Form-action pattern: clicking the button
          submits a tiny form that invokes the `logout` Server Action.
          No JS required for the action itself; the form is the
          progressive-enhancement contract. */}
      <form action={logout}>
        <Button
          type="submit"
          variant="ghost"
          size="icon-sm"
          aria-label="Sign out"
          className={cn(
            "text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground",
          )}
        >
          <LogOut className="h-4 w-4" />
        </Button>
      </form>
    </div>
  );
}
```

## List + Detail Page Pattern — Reference Implementation

The companies module is the cleanest reference for: list page with searchParams-driven filtering, detail page with overview + header, edit/delete sub-routes, and the matching `_components` colocated layout.

### `app/dashboard/companies/page.tsx`

```tsx
/**
 * Companies list page.
 *
 * Server Component — reads `searchParams` for filters/pagination, calls
 * the `listCompanies` action, hands the rows to `<CompaniesTable />`
 * for rendering. Filter inputs (search, sector, geography, compliance)
 * live in a Client `<FiltersBar />` that writes back to the URL, so
 * the next render of this page picks up the new query.
 *
 * Why URL state instead of React state:
 *   - Filters survive page refresh and browser back/forward
 *   - Shareable links ("send me the URL of all non-compliant companies
 *     in Maharashtra")
 *   - Server Component can read them directly with zero client JS
 *   - Plays nicely with browser native form submission as a fallback
 *
 * Access control:
 *   - `admin` and `staff` see every company
 *   - `company` role would see only their own row (the listCompanies
 *     action handles row-level scoping)
 *
 * @module app/dashboard/companies/page
 */
import type { Metadata } from "next";
import Link from "next/link";
import { Plus, Link2 } from "lucide-react";
import { listCompanies } from "@/lib/companies/actions";
import { readSession } from "@/lib/auth/session";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PageHeader } from "@/components/dashboard/page-header";
import { FiltersBar } from "./_components/filters-bar";
import { CompaniesTable } from "./_components/companies-table";

export const metadata: Metadata = {
  title: "Companies",
  description: "Manage company profiles and compliance",
};

/**
 * Next.js App Router types `searchParams` as a Promise in 15+.
 * We `await` it like any other promise.
 */
interface CompaniesPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function CompaniesPage({
  searchParams,
}: CompaniesPageProps) {
  // 1. Resolve search params and session in parallel.
  //    The Zod schema in listCompanies handles coercion + defaults, so
  //    we pass the raw object through unchanged.
  const [params, session] = await Promise.all([searchParams, readSession()]);

  // Session is guaranteed by the dashboard layout's auth guard, but
  // TypeScript can't see that without an assert. Belt + suspenders.
  if (!session) {
    return null;
  }

  // 2. Fetch the page. The action handles validation, scope, sorting,
  //    pagination, and returns a typed `ActionResult`.
  const result = await listCompanies(params);

  // 3. Hard failure mode — bad query, DB hiccup, etc.
  if (!result.ok) {
    return (
      <>
        <PageHeader
          title="Companies"
          subtitle="Manage company profiles and compliance"
        />
        <Alert variant="destructive">
          <AlertTitle>Couldn't load companies</AlertTitle>
          <AlertDescription>{result.error}</AlertDescription>
        </Alert>
      </>
    );
  }

  const { rows, total, page, perPage } = result;

  // 4. Action buttons differ by role. Admin/staff can add companies;
  //    `company` role users only ever see their own row and can't
  //    register others.
  const canCreate = session.role === "admin" || session.role === "staff";

  return (
    <>
      <PageHeader
        title="Companies"
        subtitle="Manage company profiles and compliance"
        actions={
          canCreate ? (
            <>
              {/* Registration-link generation is a Phase-1 sub-feature.
                  Stubbed for now; click does nothing, but the button is
                  here so the surface matches the figma + signals the
                  upcoming capability. */}
              <Button variant="outline" disabled aria-disabled>
                <Link2 className="h-4 w-4" aria-hidden />
                Generate Registration Link
              </Button>
              <Button asChild>
                <Link href="/dashboard/companies/new">
                  <Plus className="h-4 w-4" aria-hidden />
                  Add Company
                </Link>
              </Button>
            </>
          ) : undefined
        }
      />

      {/* Single card wraps filters + table for the figma's "one panel"
          look. Filters separate from table by an internal border so
          they read as a coherent toolbar. */}
      <Card className="overflow-hidden p-0">
        <FiltersBar />
        <CompaniesTable
          rows={rows}
          total={total}
          page={page}
          perPage={perPage}
          canEdit={canCreate}
          canDelete={session.role === "admin"}
        />
      </Card>
    </>
  );
}
```

### `app/dashboard/companies/_components/filters-bar.tsx`

```tsx
/**
 * Filters bar for the companies list.
 *
 * Search input (debounced) + three select dropdowns (sector, geography,
 * compliance). Filter values live in the URL — clicking a select pushes
 * the new state into `?key=value` and Next.js re-renders the page with
 * the updated query. URL state means filters survive refresh, are
 * shareable, and work without React in-memory state.
 *
 * Client Component because:
 *   - Select dropdowns need open/close interaction
 *   - Search input is debounced via setTimeout — needs state and effects
 *   - URL writes happen via useRouter().push()
 *
 * Sector and geography options are hard-coded for now. Once we have
 * real seed data, we can either populate from a distinct query against
 * the DB, or maintain a curated list per docs/05-database-schema.md.
 * Hard-coded for Phase 1 because the seed companies use a small set
 * anyway, and a dynamic SELECT DISTINCT every render is overkill.
 *
 * @module app/dashboard/companies/_components/filters-bar
 */
"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";

// ── Filter option lists ─────────────────────────────────────────────────────

/**
 * Sentinel value for "no filter" inside the Select. shadcn/Radix Select
 * cannot have an empty-string value, so we use `__all__` as a stand-in
 * and treat it specially when writing to the URL.
 */
const ALL_VALUE = "__all__";

/**
 * Sector options. Mirrors the spread used in the figma + the Indian
 * project landscape Consultway works in. Add or remove items here as
 * the real data starts populating.
 */
const SECTOR_OPTIONS = [
  "Infrastructure",
  "Civil Works",
  "IT Services",
  "IT & Software",
  "Roads & Highways",
  "Consulting",
  "Solar EPC",
  "Real Estate",
  "Manufacturing",
];

/**
 * Geography options. India-wide + the most active states/regions for
 * government infrastructure projects. Same maintenance note as sectors.
 */
const GEOGRAPHY_OPTIONS = [
  "Pan India",
  "North India",
  "South India",
  "East India",
  "West India",
  "Maharashtra",
  "Karnataka",
  "Tamil Nadu",
  "Gujarat",
  "Delhi NCR",
  "Telangana",
];

/**
 * Compliance options — keep in sync with `ComplianceStatus` in
 * lib/db/schema.ts. Order is by likely-most-useful for filtering.
 */
const COMPLIANCE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "pending", label: "Pending" },
  { value: "compliant", label: "Compliant" },
  { value: "non_compliant", label: "Non-compliant" },
  { value: "expired", label: "Expired" },
];

// ── Component ───────────────────────────────────────────────────────────────

export function FiltersBar() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  // Local search state — debounced before pushing to URL so we don't
  // hammer the server on every keystroke.
  const initialSearch = searchParams.get("search") ?? "";
  const [search, setSearch] = useState(initialSearch);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // If the URL search changes externally (back/forward, link nav),
  // sync the local input. The string comparison is necessary because
  // every render produces a new `searchParams` object.
  useEffect(() => {
    const fromUrl = searchParams.get("search") ?? "";
    setSearch((prev) => (prev === fromUrl ? prev : fromUrl));
    // We intentionally don't list `search` as a dep — we want the URL
    // to win, not the local state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  /**
   * Write a single key into the URL search params. Passing an empty
   * string or undefined removes the key. Resets `page` to 1 because a
   * filter change invalidates the previous page index.
   */
  function pushParam(key: string, value: string | undefined) {
    const params = new URLSearchParams(searchParams.toString());

    if (!value || value === ALL_VALUE) {
      params.delete(key);
    } else {
      params.set(key, value);
    }
    // Any filter change resets to page 1.
    params.delete("page");

    const queryString = params.toString();
    const target = queryString ? `${pathname}?${queryString}` : pathname;

    startTransition(() => {
      router.push(target, { scroll: false });
    });
  }

  /**
   * Debounced search push. Fires 300ms after the last keystroke.
   */
  function handleSearchChange(next: string) {
    setSearch(next);

    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      pushParam("search", next.trim() || undefined);
    }, 300);
  }

  function clearSearch() {
    setSearch("");
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    pushParam("search", undefined);
  }

  // Clear up the timer on unmount.
  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);

  // Current values for the selects. Falls back to ALL_VALUE because
  // shadcn Select doesn't render any selection for empty string.
  const sectorValue = searchParams.get("sector") ?? ALL_VALUE;
  const geographyValue = searchParams.get("geography") ?? ALL_VALUE;
  const complianceValue = searchParams.get("complianceStatus") ?? ALL_VALUE;

  // Is anything currently filtering? Used to show a "clear all" affordance.
  const hasActiveFilters =
    search !== "" ||
    sectorValue !== ALL_VALUE ||
    geographyValue !== ALL_VALUE ||
    complianceValue !== ALL_VALUE;

  function clearAll() {
    setSearch("");
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    startTransition(() => {
      router.push(pathname, { scroll: false });
    });
  }

  return (
    <div
      className="flex flex-wrap items-center gap-3 border-b border-border bg-card p-4"
      aria-busy={isPending || undefined}
    >
      {/* Search */}
      <div className="relative min-w-[16rem] flex-1 sm:flex-none">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          type="search"
          value={search}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder="Search companies..."
          aria-label="Search companies"
          className="pl-9 pr-9"
        />
        {search && (
          <button
            type="button"
            onClick={clearSearch}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Sector */}
      <Select
        value={sectorValue}
        onValueChange={(v) => pushParam("sector", v === ALL_VALUE ? undefined : v)}
      >
        <SelectTrigger className="w-[12rem]" aria-label="Filter by sector">
          <SelectValue placeholder="All Sectors" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_VALUE}>All Sectors</SelectItem>
          {SECTOR_OPTIONS.map((s) => (
            <SelectItem key={s} value={s}>
              {s}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Geography */}
      <Select
        value={geographyValue}
        onValueChange={(v) =>
          pushParam("geography", v === ALL_VALUE ? undefined : v)
        }
      >
        <SelectTrigger
          className="w-[12rem]"
          aria-label="Filter by geography"
        >
          <SelectValue placeholder="All Geographies" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_VALUE}>All Geographies</SelectItem>
          {GEOGRAPHY_OPTIONS.map((g) => (
            <SelectItem key={g} value={g}>
              {g}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Compliance */}
      <Select
        value={complianceValue}
        onValueChange={(v) =>
          pushParam("complianceStatus", v === ALL_VALUE ? undefined : v)
        }
      >
        <SelectTrigger
          className="w-[12rem]"
          aria-label="Filter by compliance status"
        >
          <SelectValue placeholder="All Compliance" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_VALUE}>All Compliance</SelectItem>
          {COMPLIANCE_OPTIONS.map((c) => (
            <SelectItem key={c.value} value={c.value}>
              {c.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Clear all — only when something is active */}
      {hasActiveFilters && (
        <Button
          variant="ghost"
          size="sm"
          onClick={clearAll}
          className="text-muted-foreground"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
          Clear filters
        </Button>
      )}
    </div>
  );
}
```

### `app/dashboard/companies/_components/companies-table.tsx`

```tsx
/**
 * Companies table — the actual data render.
 *
 * Pure presentation given pre-fetched data. The page Server Component
 * does the data fetching; this component just lays it out.
 *
 * Renders:
 *   - <table> with header + body rows
 *   - JV chip + partner count below the name when isJv=true
 *   - GST + PAN stacked in one cell (matching figma)
 *   - MSME Yes/No badge
 *   - Compliance status pill
 *   - Action icons per row (view / edit / delete — visibility role-gated)
 *
 * Plus:
 *   - Empty state when no rows match
 *   - Pagination footer (prev / 1 2 3 ... / next) when total > perPage
 *
 * Pagination is split into a tiny Client Component child so it can read
 * `useSearchParams()` and preserve filters when changing pages. The
 * table itself stays a Server Component.
 *
 * Pagination component lives in `@/components/dashboard/pagination`
 * since Day 4 (Chunk 3) — moved out of `./pagination` so the tenders
 * module and any future list page can share the same widget without
 * copy-paste.
 *
 * @module app/dashboard/companies/_components/companies-table
 */
import Link from "next/link";
import { Eye, Pencil, Trash2, Building, Inbox } from "lucide-react";
import type { Company } from "@/lib/db/schema";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Pagination } from "@/components/dashboard/pagination";
import { ComplianceBadge, JvBadge, BooleanBadge } from "./badges";

// ── Props ─────────────────────────────────────────────────────────────────

export interface CompaniesTableProps {
  rows: Company[];
  total: number;
  page: number;
  perPage: number;
  /** Show the edit pencil. Admin/staff get it; company-role wouldn't. */
  canEdit: boolean;
  /** Show the delete trash. Admin only. */
  canDelete: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────

export function CompaniesTable({
  rows,
  total,
  page,
  perPage,
  canEdit,
  canDelete,
}: CompaniesTableProps) {
  // Empty state. Single generic message that works whether filters are
  // applied or the database is genuinely empty.
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 px-6 py-16 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Inbox className="h-6 w-6 text-muted-foreground" aria-hidden />
        </div>
        <div className="space-y-1">
          <p className="text-base font-medium text-foreground">
            No companies found
          </p>
          <p className="text-sm text-muted-foreground">
            Try adjusting your filters, or add a new company to get started.
          </p>
        </div>
      </div>
    );
  }

  const startIdx = (page - 1) * perPage + 1;
  const endIdx = Math.min(page * perPage, total);
  const totalPages = Math.max(1, Math.ceil(total / perPage));

  return (
    <>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50 hover:bg-muted/50">
              <TableHead className="min-w-[18rem]">Company Name</TableHead>
              <TableHead>Sector</TableHead>
              <TableHead>Geography</TableHead>
              <TableHead>GST / PAN</TableHead>
              <TableHead>MSME</TableHead>
              <TableHead>Compliance</TableHead>
              <TableHead className="w-[8rem] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                {/* Name column — stacks name + optional JV badge + partner count */}
                <TableCell className="align-top">
                  <div className="flex items-start gap-2">
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
                      <Building
                        className="h-4 w-4 text-muted-foreground"
                        aria-hidden
                      />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/dashboard/companies/${row.id}`}
                          className="font-medium text-foreground hover:underline"
                        >
                          {row.name}
                        </Link>
                        {row.isJv && <JvBadge />}
                      </div>
                      {row.isJv &&
                        Array.isArray(row.parentCompanyIds) &&
                        row.parentCompanyIds.length > 0 && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {row.parentCompanyIds.length}{" "}
                            partner{row.parentCompanyIds.length === 1 ? "" : "s"}
                          </p>
                        )}
                    </div>
                  </div>
                </TableCell>

                <TableCell className="align-top text-sm text-foreground">
                  {row.sector}
                </TableCell>

                <TableCell className="align-top text-sm text-foreground">
                  {row.geography}
                </TableCell>

                {/* GST/PAN stacked, monospace for readability */}
                <TableCell className="align-top">
                  <div className="space-y-0.5 font-mono text-xs">
                    {row.gstNumber ? (
                      <div className="text-foreground">{row.gstNumber}</div>
                    ) : (
                      <div className="italic text-muted-foreground">No GST</div>
                    )}
                    {row.panNumber ? (
                      <div className="text-muted-foreground">
                        {row.panNumber}
                      </div>
                    ) : (
                      <div className="italic text-muted-foreground/60">
                        No PAN
                      </div>
                    )}
                  </div>
                </TableCell>

                <TableCell className="align-top">
                  <BooleanBadge value={row.isMsme} />
                </TableCell>

                <TableCell className="align-top">
                  <ComplianceBadge status={row.complianceStatus} />
                </TableCell>

                {/* Actions — view always, edit + delete role-gated */}
                <TableCell className="align-top">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      asChild
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`View ${row.name}`}
                    >
                      <Link href={`/dashboard/companies/${row.id}`}>
                        <Eye className="h-4 w-4" />
                      </Link>
                    </Button>
                    {canEdit && (
                      <Button
                        asChild
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Edit ${row.name}`}
                      >
                        <Link href={`/dashboard/companies/${row.id}/edit`}>
                          <Pencil className="h-4 w-4" />
                        </Link>
                      </Button>
                    )}
                    {canDelete && (
                      <Button
                        asChild
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete ${row.name}`}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Link href={`/dashboard/companies/${row.id}/delete`}>
                          <Trash2 className="h-4 w-4" />
                        </Link>
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Footer with row count + pagination controls */}
      {total > 0 && (
        <div className="flex flex-col items-center justify-between gap-3 border-t border-border bg-card px-4 py-3 text-sm sm:flex-row">
          <p className="text-muted-foreground">
            Showing <span className="font-medium text-foreground">{startIdx}</span>
            {"–"}
            <span className="font-medium text-foreground">{endIdx}</span> of{" "}
            <span className="font-medium text-foreground">{total}</span>{" "}
            {total === 1 ? "company" : "companies"}
          </p>

          {totalPages > 1 && (
            <Pagination page={page} totalPages={totalPages} />
          )}
        </div>
      )}
    </>
  );
}
```

### `app/dashboard/companies/_components/badges.tsx`

```tsx
/**
 * Tiny presentational badges reused across the companies module.
 *
 *   - <ComplianceBadge status="compliant" /> — colored pill for the
 *     "Compliance" column. Maps each status to a palette-consistent
 *     bg + text combo.
 *   - <JvBadge /> — short "JV" pill that appears under a company name
 *     when `is_jv = true`. No props, always the same look.
 *
 * Pure presentation — no hooks, no state, no event handlers. Server-
 * Component-compatible. Hot-path on the table render, so kept minimal.
 *
 * @module app/dashboard/companies/_components/badges
 */
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ComplianceStatus } from "@/lib/db/schema";

// ── ComplianceBadge ─────────────────────────────────────────────────────────

interface ComplianceBadgeStyle {
  /** Human-readable label shown in the pill. */
  label: string;
  /** Tailwind classes for the pill's bg/text/border. */
  classes: string;
  /** Leading icon. */
  icon: LucideIcon;
}

/**
 * One config object per compliance status. Keeping styles co-located
 * with the status mapping means a new status only needs editing here
 * (plus the Zod schema + DB type, but those are deliberately broader).
 */
const COMPLIANCE_STYLES: Record<ComplianceStatus, ComplianceBadgeStyle> = {
  compliant: {
    label: "Compliant",
    classes: "bg-primary text-primary-foreground border-transparent",
    icon: CheckCircle2,
  },
  pending: {
    label: "Pending",
    classes: "bg-accent/10 text-accent border-accent/20",
    icon: Clock,
  },
  non_compliant: {
    label: "Non-compliant",
    classes: "bg-destructive/10 text-destructive border-destructive/20",
    icon: XCircle,
  },
  expired: {
    label: "Expired",
    classes: "bg-muted text-muted-foreground border-border",
    icon: AlertCircle,
  },
};

export interface ComplianceBadgeProps {
  status: ComplianceStatus;
}

export function ComplianceBadge({ status }: ComplianceBadgeProps) {
  const style = COMPLIANCE_STYLES[status];
  const Icon = style.icon;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        style.classes,
      )}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {style.label}
    </span>
  );
}

// ── JvBadge ─────────────────────────────────────────────────────────────────

/**
 * "JV" pill shown next to a JV company's name. Uses Blush tint bg with
 * Terracotta text per the palette PDF's "tag pills" guidance.
 */
export function JvBadge() {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent",
      )}
      aria-label="Joint venture"
      title="Joint venture"
    >
      JV
    </span>
  );
}

// ── BooleanBadge ────────────────────────────────────────────────────────────

/**
 * Generic Yes/No pill used in the MSME column. Yes = Espresso pill,
 * No = muted outline. Kept tiny since it's purely decorative.
 */
export interface BooleanBadgeProps {
  value: boolean;
  yesLabel?: string;
  noLabel?: string;
}

export function BooleanBadge({
  value,
  yesLabel = "Yes",
  noLabel = "No",
}: BooleanBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex min-w-[2.5rem] items-center justify-center rounded-full px-2 py-0.5 text-xs font-medium",
        value
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-muted-foreground",
      )}
    >
      {value ? yesLabel : noLabel}
    </span>
  );
}
```

### `app/dashboard/companies/[id]/page.tsx`

```tsx
/**
 * Company detail page.
 *
 * Server Component shell. Responsibilities:
 *
 *   1. Auth: layout already guards /dashboard/* against signed-out
 *      users; here we additionally check that company-role users
 *      can only ever land on their own row.
 *
 *   2. Fetch the row via getCompany() — which performs the row-scope
 *      check itself and strips internalNotes for company-role users.
 *      Returns a typed ActionResult.
 *
 *   3. If row not found OR access denied: render `notFound()` so
 *      Next.js shows our not-found.tsx instead of an empty page.
 *
 *   4. If JV: also fetch the partner companies' names so we can
 *      display "Partners: Acme + BuildRight" instead of a row of UUIDs.
 *      Done with a single batched IN-query to avoid an N+1 pattern.
 *
 *   5. Render <CompanyHeader> + <CompanyOverview>, splitting the
 *      page into a header strip (title + actions) and a content card
 *      (the fact sheet).
 *
 * @module app/dashboard/companies/[id]/page
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { inArray } from "drizzle-orm";
import { readSession } from "@/lib/auth/session";
import { getCompany } from "@/lib/companies/actions";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { Card } from "@/components/ui/card";
import { CompanyHeader } from "./_components/company-header";
import { CompanyOverview } from "./_components/company-overview";

/**
 * Next.js App Router types `params` as a Promise in 15+.
 */
interface CompanyDetailPageProps {
  params: Promise<{ id: string }>;
}

// ── Metadata ────────────────────────────────────────────────────────────────

/**
 * Dynamic page title. We fetch the company name server-side and inject
 * it into the document title — saves users tab-bar-scanning when they
 * have multiple companies open. Failures fall back to a generic title.
 */
export async function generateMetadata(
  { params }: CompanyDetailPageProps,
): Promise<Metadata> {
  const { id } = await params;
  const result = await getCompany(id);
  if (!result.ok) {
    return { title: "Company" };
  }
  return {
    title: result.company.name,
    description: `Company profile — ${result.company.name}`,
  };
}

// ── Page ────────────────────────────────────────────────────────────────────

export default async function CompanyDetailPage({
  params,
}: CompanyDetailPageProps) {
  const { id } = await params;

  // Session needed for role-gating the Edit / Delete buttons.
  // Layout guarantees a session exists (redirects otherwise), but
  // TypeScript can't see that, so we narrow defensively.
  const session = await readSession();
  if (!session) notFound();

  // Fetch the company. getCompany() handles row-scope (company-role
  // users only see their own row) and field-strip (no internalNotes
  // for company role).
  const result = await getCompany(id);
  if (!result.ok) {
    notFound();
  }
  const company = result.company;

  // Fetch partner names if this is a JV. Single IN-query, not N+1.
  // We pass labels (not full rows) to the overview because that's all
  // the UI needs — keeps the partner-pill render lean.
  let partnerLabels: Array<{ id: string; name: string }> = [];
  if (
    company.isJv &&
    Array.isArray(company.parentCompanyIds) &&
    company.parentCompanyIds.length > 0
  ) {
    partnerLabels = await db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(inArray(companies.id, company.parentCompanyIds));
  }

  const canEdit = session.role === "admin" || session.role === "staff";
  const canDelete = session.role === "admin";

  return (
    <>
      <CompanyHeader
        company={company}
        canEdit={canEdit}
        canDelete={canDelete}
      />

      <Card className="overflow-hidden p-0">
        <CompanyOverview
          company={company}
          partnerLabels={partnerLabels}
          viewerRole={session.role}
        />
      </Card>
    </>
  );
}
```

### `app/dashboard/companies/[id]/_components/company-header.tsx`

```tsx
/**
 * Company detail page header.
 *
 * Title strip with company name + compliance badge + JV chip + action
 * buttons (Back, Edit, Delete). Role-gates the destructive actions:
 *
 *   - Back: visible to everyone
 *   - Edit: admin and staff (also `company` role on their own row,
 *           but the column gating is what enforces that — the button
 *           shows regardless because we trust the upstream caller's
 *           `canEdit` prop)
 *   - Delete: admin only — destructive style, links to dedicated
 *             confirmation page rather than firing a Server Action
 *             directly
 *
 * Server-Component-compatible (pure render, no hooks).
 *
 * @module app/dashboard/companies/[id]/_components/company-header
 */
import Link from "next/link";
import { ArrowLeft, Pencil, Trash2 } from "lucide-react";
import type { Company } from "@/lib/db/schema";
import { Button } from "@/components/ui/button";
import { ComplianceBadge, JvBadge } from "../../_components/badges";

// ── Props ───────────────────────────────────────────────────────────────────

export interface CompanyHeaderProps {
  /** Full company row — used for name, compliance, JV flag. */
  company: Company;

  /** Whether the viewer may edit. Controls Edit button visibility. */
  canEdit: boolean;

  /** Whether the viewer may delete. Controls Delete button visibility. */
  canDelete: boolean;
}

// ── Component ───────────────────────────────────────────────────────────────

export function CompanyHeader({
  company,
  canEdit,
  canDelete,
}: CompanyHeaderProps) {
  return (
    <header className="mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-start sm:justify-between">
      {/* Left: title + chips. min-w-0 lets long names truncate. */}
      <div className="min-w-0">
        <h1 className="break-words text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          {company.name}
        </h1>

        {/* Chips row — compliance + optional JV. */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <ComplianceBadge status={company.complianceStatus} />
          {company.isJv && <JvBadge />}
        </div>
      </div>

      {/* Right: action buttons. Back is always shown; Edit and Delete
          are role-gated by the parent page. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Button asChild variant="outline">
          <Link href="/dashboard/companies">
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Back
          </Link>
        </Button>

        {canEdit && (
          <Button asChild variant="outline">
            <Link href={`/dashboard/companies/${company.id}/edit`}>
              <Pencil className="h-4 w-4" aria-hidden />
              Edit
            </Link>
          </Button>
        )}

        {canDelete && (
          <Button
            asChild
            variant="destructive"
          >
            <Link href={`/dashboard/companies/${company.id}/delete`}>
              <Trash2 className="h-4 w-4" aria-hidden />
              Delete
            </Link>
          </Button>
        )}
      </div>
    </header>
  );
}
```

### `app/dashboard/companies/[id]/_components/company-overview.tsx`

```tsx
/**
 * Company overview — the fact-sheet body of the detail page.
 *
 * Renders the row as labelled facts in six sections that mirror the
 * create form structure (Identity / Identifiers / Joint venture /
 * Contact / Address / Internal notes). Each section is a `<dl>` for
 * semantic correctness — these are definition lists, not generic divs.
 *
 * Layout rules:
 *   - Section title (h2) + optional description, then a 2-column grid
 *     of label-value pairs on md+, single column on mobile
 *   - Address section uses a single flow (line 1 / city, state pincode)
 *   - Internal notes is admin/staff-only — section is HIDDEN entirely
 *     when viewerRole === 'company' (we pass viewerRole down from the
 *     page rather than relying on null-check, because internalNotes
 *     could legitimately be null for an admin too)
 *   - JV section shows partner list when isJv; says "Standalone" when not
 *
 * Server-Component-compatible — pure render.
 *
 * @module app/dashboard/companies/[id]/_components/company-overview
 */
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import type { Company, UserRole } from "@/lib/db/schema";
import { BooleanBadge } from "../../_components/badges";
import { cn } from "@/lib/utils";

// ── Props ───────────────────────────────────────────────────────────────────

export interface CompanyOverviewProps {
  company: Company;
  /** id+name pairs for the JV partners (resolved server-side). */
  partnerLabels: Array<{ id: string; name: string }>;
  /** Used to hide the Internal Notes section from company-role users. */
  viewerRole: UserRole;
}

// ── Component ───────────────────────────────────────────────────────────────

export function CompanyOverview({
  company,
  partnerLabels,
  viewerRole,
}: CompanyOverviewProps) {
  const showInternalNotes =
    viewerRole === "admin" || viewerRole === "staff";

  // Format address as a single block. Each line is optional; we render
  // only the lines that have data so a blank address doesn't show as
  // a column of "—" dashes.
  const addressLines = [
    company.addressLine,
    [company.city, company.state, company.pincode]
      .filter((s) => s && s.trim().length > 0)
      .join(", "),
  ].filter((line) => line && line.trim().length > 0);

  return (
    <div className="divide-y divide-border">
      {/* Identity ─────────────────────────────────────────────────── */}
      <Section
        title="Identity"
        description="Basic information about the company."
      >
        <Fact label="Company name" value={company.name} />
        <Fact label="Sector" value={company.sector} />
        <Fact label="Geography" value={company.geography} />
      </Section>

      {/* Identifiers ──────────────────────────────────────────────── */}
      <Section
        title="Identifiers"
        description="Government registration details."
      >
        <Fact
          label="GSTIN"
          value={company.gstNumber}
          mono
          emptyHint="Not on file"
        />
        <Fact
          label="PAN"
          value={company.panNumber}
          mono
          emptyHint="Not on file"
        />
        <Fact
          label="MSME registered"
          valueNode={<BooleanBadge value={company.isMsme} />}
        />
      </Section>

      {/* Joint venture ────────────────────────────────────────────── */}
      <Section
        title="Joint venture"
        description={
          company.isJv
            ? "This company is a joint venture between the partners below."
            : "Not a joint venture."
        }
      >
        {company.isJv ? (
          <Fact
            label="Partners"
            valueNode={
              partnerLabels.length === 0 ? (
                <span className="text-sm italic text-muted-foreground">
                  No partner records found
                </span>
              ) : (
                <ul className="flex flex-wrap gap-2">
                  {partnerLabels.map((p) => (
                    <li key={p.id}>
                      <Link
                        href={`/dashboard/companies/${p.id}`}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent",
                          "hover:bg-accent/20",
                        )}
                      >
                        {p.name}
                        <ExternalLink className="h-3 w-3" aria-hidden />
                      </Link>
                    </li>
                  ))}
                </ul>
              )
            }
            spanFull
          />
        ) : (
          <Fact label="Type" value="Standalone company" />
        )}
      </Section>

      {/* Contact ──────────────────────────────────────────────────── */}
      <Section
        title="Contact"
        description="Primary point of contact for this company."
      >
        <Fact
          label="Contact person"
          value={company.contactPersonName}
          emptyHint="Not on file"
        />
        <Fact
          label="Email"
          valueNode={
            company.contactEmail ? (
              <a
                href={`mailto:${company.contactEmail}`}
                className="text-sm text-foreground hover:underline"
              >
                {company.contactEmail}
              </a>
            ) : undefined
          }
          emptyHint="Not on file"
        />
        <Fact
          label="Phone"
          valueNode={
            company.contactPhone ? (
              <a
                href={`tel:${company.contactPhone.replace(/\s/g, "")}`}
                className="text-sm text-foreground hover:underline"
              >
                {company.contactPhone}
              </a>
            ) : undefined
          }
          emptyHint="Not on file"
          spanFull
        />
      </Section>

      {/* Address ──────────────────────────────────────────────────── */}
      <Section
        title="Address"
        description="Registered office or primary location."
      >
        <Fact
          label="Address"
          spanFull
          valueNode={
            addressLines.length === 0 ? undefined : (
              <div className="text-sm text-foreground">
                {addressLines.map((line, i) => (
                  <div key={i}>{line}</div>
                ))}
              </div>
            )
          }
          emptyHint="No address on file"
        />
      </Section>

      {/* Internal notes — admin/staff only */}
      {showInternalNotes && (
        <Section
          title="Internal notes"
          description="Only visible to Consultway staff."
        >
          <Fact
            label="Notes"
            spanFull
            valueNode={
              company.internalNotes ? (
                <p className="whitespace-pre-wrap text-sm text-foreground">
                  {company.internalNotes}
                </p>
              ) : undefined
            }
            emptyHint="No notes recorded"
          />
        </Section>
      )}
    </div>
  );
}

// ── Section primitive ───────────────────────────────────────────────────────

interface SectionProps {
  title: string;
  description?: string;
  children: React.ReactNode;
}

function Section({ title, description, children }: SectionProps) {
  return (
    <section className="px-6 py-5 sm:px-8 sm:py-6">
      <header className="mb-4">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </header>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2">
        {children}
      </dl>
    </section>
  );
}

// ── Fact primitive — one label/value pair ───────────────────────────────────

interface FactProps {
  /** Left-column label (e.g. "Company name"). */
  label: string;

  /**
   * Plain-string value. Pass either `value` OR `valueNode`, not both.
   * Strings get standard styling; nodes are rendered as-is.
   */
  value?: string | null;

  /** Custom JSX value for cases where plain text isn't enough. */
  valueNode?: React.ReactNode;

  /** When the value is empty, show this muted hint instead of nothing. */
  emptyHint?: string;

  /** Use monospace for the value (GST, PAN, codes). */
  mono?: boolean;

  /** Span both columns of the parent grid (for long content). */
  spanFull?: boolean;
}

function Fact({
  label,
  value,
  valueNode,
  emptyHint,
  mono,
  spanFull,
}: FactProps) {
  const hasValue =
    valueNode !== undefined || (typeof value === "string" && value.length > 0);

  return (
    <div
      className={cn(
        "flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4",
        spanFull && "md:col-span-2",
      )}
    >
      <dt className="shrink-0 text-sm text-muted-foreground sm:w-40">
        {label}
      </dt>
      <dd
        className={cn(
          "min-w-0 flex-1 text-sm text-foreground",
          mono && hasValue && "font-mono text-xs",
        )}
      >
        {hasValue ? (
          valueNode ?? value
        ) : (
          <span className="italic text-muted-foreground">
            {emptyHint ?? "—"}
          </span>
        )}
      </dd>
    </div>
  );
}
```

### `app/dashboard/companies/loading.tsx`

```tsx
/**
 * Loading state for the companies list.
 *
 * Next.js renders this automatically during the server-render of
 * `page.tsx`. Replaces the page subtree until the data resolves. We
 * mimic the final layout's shape (header strip, filter strip, table
 * skeleton) so the page doesn't jump when content arrives.
 *
 * Pure visual placeholder — no client logic, no animations beyond
 * Tailwind's `animate-pulse` on muted rectangles.
 *
 * @module app/dashboard/companies/loading
 */
import { Card } from "@/components/ui/card";

export default function CompaniesLoading() {
  return (
    <>
      {/* Header skeleton */}
      <div className="mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <div className="h-8 w-40 animate-pulse rounded-md bg-muted" />
          <div className="h-4 w-72 animate-pulse rounded-md bg-muted" />
        </div>
        <div className="flex gap-2">
          <div className="h-9 w-48 animate-pulse rounded-md bg-muted" />
          <div className="h-9 w-32 animate-pulse rounded-md bg-muted" />
        </div>
      </div>

      <Card className="overflow-hidden p-0">
        {/* Filters skeleton — search + 3 selects */}
        <div className="flex flex-wrap items-center gap-3 border-b border-border bg-card p-4">
          <div className="h-9 w-64 animate-pulse rounded-md bg-muted" />
          <div className="h-9 w-44 animate-pulse rounded-md bg-muted" />
          <div className="h-9 w-44 animate-pulse rounded-md bg-muted" />
          <div className="h-9 w-44 animate-pulse rounded-md bg-muted" />
        </div>

        {/* Table skeleton — 6 placeholder rows */}
        <div className="divide-y divide-border">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-4 px-4 py-4"
            >
              <div className="h-4 w-1/4 animate-pulse rounded bg-muted" />
              <div className="h-4 w-1/6 animate-pulse rounded bg-muted" />
              <div className="h-4 w-1/6 animate-pulse rounded bg-muted" />
              <div className="h-4 w-1/6 animate-pulse rounded bg-muted" />
              <div className="ml-auto h-4 w-24 animate-pulse rounded bg-muted" />
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
```

### `app/dashboard/companies/error.tsx`

```tsx
/**
 * Error boundary for the companies route.
 *
 * Next.js catches any uncaught error during server render and renders
 * THIS file instead of the page. The `reset()` prop is a re-render
 * trigger — useful when the error was transient (DB blip, etc.).
 *
 * Must be a Client Component — Next.js needs it on the client side
 * so the `reset()` callback can fire from a button click.
 *
 * Expected failures (validation, not-found, unauthorized) are handled
 * inside `page.tsx` and return alerts there. Only truly unexpected
 * errors reach this boundary.
 *
 * @module app/dashboard/companies/error
 */
"use client";

import { useEffect } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/dashboard/page-header";

interface CompaniesErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function CompaniesError({ error, reset }: CompaniesErrorProps) {
  // Forward to the browser console so a developer can dig further.
  // `error.digest` is a server-side hash Next.js attaches to log lines,
  // useful when correlating a user-reported error to server logs.
  useEffect(() => {
    console.error("[companies] page error", error);
  }, [error]);

  return (
    <>
      <PageHeader
        title="Companies"
        subtitle="Manage company profiles and compliance"
      />
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Something went wrong</AlertTitle>
        <AlertDescription>
          The companies list couldn&apos;t be loaded. This is usually a
          transient issue — try again, or refresh the page.
          {error.digest && (
            <div className="mt-2 font-mono text-xs opacity-60">
              Reference: {error.digest}
            </div>
          )}
        </AlertDescription>
      </Alert>

      <div className="mt-4">
        <Button onClick={() => reset()} variant="outline">
          <RefreshCw className="h-4 w-4" aria-hidden />
          Try again
        </Button>
      </div>
    </>
  );
}
```

### `app/dashboard/companies/[id]/not-found.tsx`

```tsx
/**
 * Not-found state for the company detail route.
 *
 * Next.js calls this when the page Server Component invokes `notFound()`,
 * which happens when:
 *   - The requested id doesn't exist in the database
 *   - The current user is `company` role and the id is not their own row
 *     (we treat "forbidden" as "not found" to avoid leaking row existence
 *      via differentiated error messages)
 *
 * Renders inside the dashboard layout, so the sidebar is still visible.
 *
 * @module app/dashboard/companies/[id]/not-found
 */
import Link from "next/link";
import { Building2, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function CompanyNotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-6 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
        <Building2
          className="h-8 w-8 text-muted-foreground"
          aria-hidden
        />
      </div>

      <div className="space-y-2">
        <h1 className="text-2xl font-semibold text-foreground">
          Company not found
        </h1>
        <p className="max-w-md text-sm text-muted-foreground">
          The company you&apos;re looking for doesn&apos;t exist, has been
          removed, or you don&apos;t have permission to view it.
        </p>
      </div>

      <Button asChild variant="outline">
        <Link href="/dashboard/companies">
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to companies
        </Link>
      </Button>
    </div>
  );
}
```

## Auth Pages

The login screen, the root entry point, and the edge proxy that gates dashboard routes. The root page redirects to dashboard or login based on session state.

### `app/page.tsx`

```tsx
/**
 * Root page (/) — redirects based on auth state.
 *
 * Middleware doesn't currently guard "/" because we want the unauthenticated
 * homepage to be reachable (landing page, marketing, etc. land here later).
 * For now, the root just bounces visitors to the right place:
 *   - Logged in  → /dashboard
 *   - Logged out → /login
 *
 * @module app/page
 */
import { redirect } from "next/navigation";
import { readSession } from "@/lib/auth/session";

export default async function HomePage() {
  const session = await readSession();
  redirect(session ? "/dashboard" : "/login");
}
```

### `app/login/page.tsx`

```tsx
/**
 * Login page - the first interactive UI in the portal.
 *
 * Client component because it uses react-hook-form. The form posts to
 * the `login` Server Action in lib/auth/actions.ts, which on success
 * issues a session cookie and redirects to /dashboard (or to a safe
 * `?from=` destination - see below).
 *
 * Day 6 addition: this page now reads the `from` query parameter
 * (set by `proxy.ts` when bouncing unauthenticated requests) and
 * forwards it through the form as the third field on `LoginInput`. The
 * `login` action revalidates the value via `safeFromPath()` before
 * trusting it for the redirect, so we don't have to worry about a
 * malicious URL crafted as `/login?from=https://evil.example` here -
 * the action will coerce that back to `/dashboard`.
 *
 * Naming: we use `from` (not `next`) to match the existing convention
 * in `proxy.ts` - the proxy sets `?from=<original-path>` when bouncing,
 * and this page reads + forwards the same field name. One name, one
 * source of truth.
 *
 * Why an inline resolver instead of @hookform/resolvers?
 *   As of @hookform/resolvers@5.2.2, neither `zodResolver` nor
 *   `standardSchemaResolver` cleanly accept Zod 4.x schemas - the
 *   former has type incompatibilities, the latter fails at runtime
 *   trying to read a `.validate` method Zod doesn't expose by that
 *   name. Rather than pin to an older resolver version or Zod 3,
 *   we run `loginSchema.safeParse()` directly in a ~10-line
 *   resolver function. Zero library coupling, identical behavior.
 *
 * Suspense boundary: `useSearchParams()` requires its caller to be
 * wrapped in a Suspense boundary in Next 14+ to avoid the whole route
 * being bailed out to client-side rendering. We split the page into a
 * thin shell that owns the Suspense and an inner component that does
 * the actual form work.
 *
 * @module app/login
 */
"use client";

import { Suspense, useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { useSearchParams } from "next/navigation";
import { AlertCircle, Building2 } from "lucide-react";
import Link from "next/link";
import { login } from "@/lib/auth/actions";
import { loginSchema, type LoginInput } from "@/lib/auth/schemas";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Outer shell. Owns the Suspense boundary required by
 * `useSearchParams()` inside `<LoginForm />`. The fallback is a thin
 * placeholder matching the card layout so the page doesn't jump when
 * search params resolve.
 */
export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted px-6 py-12">
      <div className="w-full max-w-md">
        {/* Brand header - identical loading and loaded so the layout
            doesn't shift while Suspense resolves. */}
        <Link
          href="/"
          className="mb-8 flex items-center justify-center gap-3"
          aria-label="Consultway Infotech home"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary">
            <Building2
              className="h-5 w-5 text-primary-foreground"
              aria-hidden
            />
          </div>
          <span className="text-lg font-semibold tracking-tight">
            Consultway Ops
          </span>
        </Link>

        <Suspense fallback={<LoginFormSkeleton />}>
          <LoginForm />
        </Suspense>

        {/* Footer note */}
        <p className="mt-6 text-center text-xs text-muted-foreground">
          Internal portal - Not for public use
        </p>
      </div>
    </main>
  );
}

/**
 * Minimal fallback rendered while `useSearchParams()` is suspending.
 * Visually a card-shaped placeholder so the layout doesn't jump.
 * Search-params resolution is typically instant; this is shown for at
 * most a frame in practice.
 */
function LoginFormSkeleton() {
  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl">Sign in</CardTitle>
        <CardDescription>
          Use your Consultway credentials to access the portal.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-60 animate-pulse rounded-md bg-muted/40" />
      </CardContent>
    </Card>
  );
}

/**
 * Inner form. Lives inside the Suspense boundary because
 * `useSearchParams()` triggers Suspense on first call.
 */
function LoginForm() {
  const [serverError, setServerError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Read the post-login destination from the URL. proxy.ts sets this
  // when bouncing unauthenticated requests. The Server Action revalidates
  // before honouring, so we don't sanitise here - we just forward.
  //
  // Default empty string (not null) because react-hook-form's hidden
  // input plays better with stringy defaults than nullish ones.
  const searchParams = useSearchParams();
  const from = searchParams.get("from") ?? "";

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginInput>({
    /**
     * Inline resolver: turn Zod's safeParse result into RHF's expected
     * `{ values, errors }` shape. Avoids the whole @hookform/resolvers
     * compatibility situation with Zod 4.
     */
    resolver: async (values) => {
      const result = loginSchema.safeParse(values);
      if (result.success) {
        return { values: result.data, errors: {} };
      }
      const errors: Record<string, { type: string; message: string }> = {};
      for (const issue of result.error.issues) {
        const path = issue.path.join(".");
        // First error per field wins (standard RHF behavior).
        if (path && !errors[path]) {
          errors[path] = { type: issue.code, message: issue.message };
        }
      }
      return { values: {}, errors };
    },
    defaultValues: { email: "", password: "", from },
  });

  function onSubmit(data: LoginInput) {
    setServerError(null);
    startTransition(async () => {
      const result = await login(data);
      // On success, the action redirects - we never reach this line.
      // On failure, result has `{ ok: false, error }`.
      if (!result.ok) {
        setServerError(result.error);
      }
    });
  }

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl">Sign in</CardTitle>
        <CardDescription>
          Use your Consultway credentials to access the portal.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form
          onSubmit={handleSubmit(onSubmit)}
          className="space-y-4"
          noValidate
        >
          {/* Server-side / credential error */}
          {serverError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Sign-in failed</AlertTitle>
              <AlertDescription>{serverError}</AlertDescription>
            </Alert>
          )}

          {/* Hidden post-login destination. Forwarded through to the
              login action which revalidates and falls back to /dashboard
              if the value isn't a safe same-site path. */}
          <input type="hidden" {...register("from")} />

          {/* Email */}
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="you@consultway.local"
              aria-invalid={!!errors.email}
              aria-describedby={errors.email ? "email-error" : undefined}
              disabled={isPending}
              {...register("email")}
            />
            {errors.email && (
              <p
                id="email-error"
                className="text-sm text-destructive"
                role="alert"
              >
                {errors.email.message}
              </p>
            )}
          </div>

          {/* Password */}
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              aria-invalid={!!errors.password}
              aria-describedby={
                errors.password ? "password-error" : undefined
              }
              disabled={isPending}
              {...register("password")}
            />
            {errors.password && (
              <p
                id="password-error"
                className="text-sm text-destructive"
                role="alert"
              >
                {errors.password.message}
              </p>
            )}
          </div>

          {/* Submit */}
          <Button
            type="submit"
            className="w-full"
            disabled={isPending}
            aria-busy={isPending}
          >
            {isPending ? "Signing in..." : "Sign in"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
```

### `proxy.ts`

```typescript
/**
 * Next.js proxy — runs on every request that matches the `matcher`.
 *
 * Previously named `middleware.ts` in Next.js 15 and earlier. As of
 * Next.js 16 the file convention is `proxy.ts` with an exported `proxy()`
 * function. The rename clarifies that this file sits at the network
 * boundary (not as request-pipeline middleware in the Express sense),
 * and the framework now runs it on the Node.js runtime instead of Edge.
 *
 * Migration notes (in case we ever roll back or want Edge again):
 *   - Function: was `export async function middleware(req)`, now `proxy(req)`
 *   - Runtime: was Edge, now Node.js (not configurable on proxy.ts)
 *   - Behaviour: identical — same redirects, same matcher, same JWT check
 *
 * Responsibilities:
 *   - Protect `/dashboard/*` from unauthenticated users (→ /login)
 *   - Redirect already-logged-in users away from `/login` (→ /dashboard)
 *   - Pass through everything else untouched
 *
 * The Next.js team advises keeping proxy.ts lightweight — the "thin
 * proxy" pattern. Avoid heavy DB lookups here; route them through
 * Server Components and Server Actions instead. Our current usage
 * (cookie read + JWT verify + redirect) already fits the lightweight
 * profile, so no refactor needed.
 *
 * @module proxy
 */
import { NextResponse, type NextRequest } from "next/server";
import { verifySession, SESSION_COOKIE } from "@/lib/auth/session";

// ── Config ──────────────────────────────────────────────────────────────────

/** Paths that require an authenticated session. Prefix match. */
const PROTECTED_PREFIXES = ["/dashboard"];

/** Paths that should bounce authenticated users away (no point being here). */
const AUTH_PAGES = ["/login"];

/** Where to send unauthenticated users hitting a protected route. */
const LOGIN_PATH = "/login";

/** Where to send authenticated users hitting an auth page. */
const DEFAULT_AUTHED_PATH = "/dashboard";

// ── Proxy ───────────────────────────────────────────────────────────────────

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;

  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  const isAuthPage = AUTH_PAGES.includes(pathname);

  // Fast path: nothing to do for public routes.
  if (!isProtected && !isAuthPage) {
    return NextResponse.next();
  }

  // Verify session from the cookie. jose.verify works in both Node and
  // Edge runtimes; we're on Node now (proxy.ts default) but the call
  // itself is runtime-agnostic.
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySession(token);

  // Case 1: hitting a protected route without a valid session → /login
  if (isProtected && !session) {
    const url = request.nextUrl.clone();
    url.pathname = LOGIN_PATH;
    // Preserve where they were headed so we can redirect back after login.
    url.searchParams.set("from", pathname + search);
    return NextResponse.redirect(url);
  }

  // Case 2: hitting an auth page while already logged in → /dashboard
  if (isAuthPage && session) {
    const url = request.nextUrl.clone();
    url.pathname = DEFAULT_AUTHED_PATH;
    url.search = "";
    return NextResponse.redirect(url);
  }

  // Happy path: authenticated visitor on protected route, or
  // unauthenticated visitor on login page. Let it through.
  return NextResponse.next();
}

// ── Matcher ─────────────────────────────────────────────────────────────────

/**
 * Only run this proxy on paths that could possibly need auth logic.
 * Exclude Next internals, static assets, and common public files — there's
 * no reason to verify a JWT for /favicon.ico or /_next/static/*.css.
 *
 * The matcher syntax is identical between middleware.ts and proxy.ts —
 * no migration needed here.
 */
export const config = {
  matcher: [
    /*
     * Match all paths EXCEPT:
     *   - _next/static (static files)
     *   - _next/image  (image optimizer)
     *   - favicon.ico, robots.txt, sitemap.xml
     *   - Anything that has a file extension (.jpg, .svg, .js, .css, ...)
     *     because those are static assets, not app routes
     */
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\..*).*)",
  ],
};
```

## Config

Project-wide config. Read these before changing tooling, deploy targets, or path aliases.

### `package.json`

```json
{
  "name": "consultway",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "snapshot": "tsx scripts/snapshot.ts",
    "build": "next build",
    "start": "next start",
    "lint": "eslint",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:push": "drizzle-kit push",
    "db:studio": "drizzle-kit studio",
    "db:seed": "tsx scripts/seed.ts"
  },
  "dependencies": {
    "@hookform/resolvers": "^5.2.2",
    "bcryptjs": "^3.0.3",
    "better-sqlite3": "^12.9.0",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "drizzle-orm": "^0.45.2",
    "jose": "^6.2.2",
    "lucide-react": "^1.8.0",
    "next": "16.2.4",
    "radix-ui": "^1.4.3",
    "react": "19.2.4",
    "react-dom": "19.2.4",
    "react-hook-form": "^7.72.1",
    "shadcn": "^4.3.0",
    "tailwind-merge": "^3.5.0",
    "tw-animate-css": "^1.4.0",
    "uuid": "^13.0.0",
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4",
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^20",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "dotenv": "^17.4.2",
    "drizzle-kit": "^0.31.10",
    "eslint": "^9",
    "eslint-config-next": "16.2.4",
    "tailwindcss": "^4",
    "tsx": "^4.21.0",
    "typescript": "^5"
  }
}
```

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "incremental": true,
    "plugins": [
      {
        "name": "next"
      }
    ],
    "paths": {
      "@/*": ["./*"]
    }
  },
  "include": [
    "next-env.d.ts",
    "**/*.ts",
    "**/*.tsx",
    ".next/types/**/*.ts",
    ".next/dev/types/**/*.ts",
    "**/*.mts"
  ],
  "exclude": ["node_modules"]
}
```

### `next.config.ts`

```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
};

export default nextConfig;
```

### `wrangler.jsonc`

```jsonc
{
  "$schema": "https://unpkg.com/wrangler/config-schema.json",
  "name": "consultway-ops",
  "main": ".open-next/worker.js",
  "compatibility_date": "2026-04-01",
  "compatibility_flags": ["nodejs_compat"],

  "assets": {
    "directory": ".open-next/assets",
    "binding": "ASSETS"
  },

  "observability": {
    "enabled": true,
    "head_sampling_rate": 1
  },

  "placement": {
    "mode": "smart"
  },

  // ── D1 (SQLite) ─────────────────────────────────────
  // Create with: wrangler d1 create consultway-prod
  // Then replace database_id with the UUID that command prints.
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "consultway-prod",
      "database_id": "REPLACE_WITH_D1_UUID",
      "migrations_dir": "drizzle"
    }
  ],

  // ── R2 (object storage) ─────────────────────────────
  // Create with: wrangler r2 bucket create consultway-docs
  "r2_buckets": [
    {
      "binding": "DOCS",
      "bucket_name": "consultway-docs"
    }
  ],

  // ── KV (sessions, rate limiting) ────────────────────
  // Create with: wrangler kv namespace create SESSIONS
  "kv_namespaces": [
    {
      "binding": "SESSIONS",
      "id": "REPLACE_WITH_KV_UUID"
    },
    {
      "binding": "RATE_LIMITS",
      "id": "REPLACE_WITH_KV_UUID"
    }
  ],

  // ── Scheduled triggers (cron) ───────────────────────
  "triggers": {
    "crons": [
      "0 2 * * *" // 2 AM UTC daily — document expiry sweep
    ]
  },

  // ── Public vars (non-secret) ────────────────────────
  "vars": {
    "NODE_ENV": "production",
    "NEXT_PUBLIC_APP_NAME": "Consultway Ops",
    "LOG_LEVEL": "info",
    "R2_MAX_UPLOAD_BYTES": "20971520",
    "R2_PRESIGN_EXPIRY": "900",
    "RATE_LIMIT_PUBLIC_RPM": "20",
    "RATE_LIMIT_AUTH_RPM": "120"
  },

  // ── Environments ────────────────────────────────────
  // Secrets (PAYLOAD_SECRET, JWT_SECRET, RESEND_API_KEY, etc.) are set via:
  //   wrangler secret put <NAME> --env staging
  //   wrangler secret put <NAME> --env production
  "env": {
    "staging": {
      "name": "consultway-ops-staging",
      "vars": {
        "NEXT_PUBLIC_APP_URL": "https://staging.ops.consultway.info"
      },
      "d1_databases": [
        {
          "binding": "DB",
          "database_name": "consultway-staging",
          "database_id": "REPLACE_WITH_STAGING_D1_UUID",
          "migrations_dir": "drizzle"
        }
      ],
      "r2_buckets": [
        { "binding": "DOCS", "bucket_name": "consultway-docs-staging" }
      ]
    },
    "production": {
      "name": "consultway-ops",
      "route": {
        "pattern": "ops.consultway.info/*",
        "zone_name": "consultway.info"
      },
      "vars": {
        "NEXT_PUBLIC_APP_URL": "https://ops.consultway.info"
      }
    }
  }
}
```

### `drizzle.config.ts`

```typescript
/**
 * Drizzle Kit configuration.
 *
 * Used by the `drizzle-kit` CLI for:
 *   - `drizzle-kit generate` — diff schema, write SQL migration files
 *   - `drizzle-kit migrate`  — apply pending migrations to the DB
 *   - `drizzle-kit push`     — push schema directly without migration files (dev only)
 *   - `drizzle-kit studio`   — open a local web UI to browse tables
 *
 * This config is Node-only — it runs via tsx/esbuild, never in a browser
 * or Worker. It uses `dotenv` to load `.env.local` because Next.js env
 * loading doesn't apply to standalone CLI invocations.
 *
 * @see https://orm.drizzle.team/docs/drizzle-config-file
 */
import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// Use DATABASE_URL if set, else default to the same local path as lib/env.ts.
// We can't import from lib/env here because this file runs before Next.js
// boots and the path alias @/ isn't resolved.
const dbPath =
  process.env.DATABASE_URL ?? "./.wrangler/consultway-local.sqlite";

export default defineConfig({
  dialect: "sqlite",
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: dbPath,
  },
  // Prompts for schema changes in interactive mode. Safer than 'push'
  // for anything we care about.
  verbose: true,
  strict: true,
});
```

### `components.json`

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "radix-nova",
  "rsc": true,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "app/globals.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "iconLibrary": "lucide",
  "rtl": false,
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  },
  "menuColor": "default",
  "menuAccent": "subtle",
  "registries": {}
}
```

---

## Files Deliberately Not Included

These exist in the project tree but are omitted here to keep this document focused on **one canonical example per pattern**. Read them from disk directly when needed.

- **`lib/tenders/actions.ts`** — ~1,900 lines. Same Server Action pattern as `lib/companies/actions.ts` plus state-machine transitions (which are isolated in `lib/tenders/state-machine.ts`, included above).
- **`components/tenders/tender-form.tsx`** — Same pattern as `components/companies/company-form.tsx`.
- **`app/dashboard/tenders/**`** — List/detail/edit/delete pages mirror the companies module structure shown above.
- **`app/dashboard/page.tsx`** — Dashboard home, mostly KPI cards. Ask for contents if editing.
- **`app/globals.css`** — Tailwind layer setup and palette CSS variables. Treated as generated config; consult `docs/07-design-system.md` and `docs/design/palette/` instead.
- **`drizzle/*.sql and drizzle/meta/*.json`** — Auto-generated migrations. `lib/db/schema.ts` (above) is the source of truth.
- **`components/ui/{button,input,label,select,card,checkbox,switch,textarea}.tsx`** — Untouched shadcn primitives. Read `components.json` to see what's installed; consult the file directly only when modifying it.
- **`scripts/seed.ts and scripts/snapshot.ts`** — Tooling, not production code.

### Coverage Drift

These files live in `lib/`, `app/`, or `components/` but are not embedded above and not mentioned in the explicit exclusion list. If any of them have grown into a pattern reference, add them to `scripts/snapshot-config.ts`.

- `app/dashboard/companies/[id]/delete/_components/delete-form.tsx`
- `app/dashboard/companies/[id]/delete/page.tsx`
- `app/dashboard/companies/[id]/edit/page.tsx`
- `app/dashboard/companies/[id]/loading.tsx`
- `app/dashboard/companies/new/_components/partner-picker.tsx`
- `app/dashboard/companies/new/page.tsx`
- `app/favicon.ico`
- `components/ui/button.tsx`
- `components/ui/card.tsx`
- `components/ui/checkbox.tsx`
- `components/ui/input.tsx`
- `components/ui/label.tsx`
- `components/ui/select.tsx`
- `components/ui/switch.tsx`
- `components/ui/textarea.tsx`

---

_Generated by `scripts/snapshot.ts`. To change which files are included, edit `scripts/snapshot-config.ts`._
