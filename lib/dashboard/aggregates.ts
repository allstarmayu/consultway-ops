/**
 * Dashboard aggregates — pure-read helpers for the role-aware widgets
 * on `/dashboard` and the period-bounded variants for `/dashboard/reports`.
 *
 * Seven helpers, in two families:
 *
 * **Snapshot family — what's true right now:**
 *
 *   - `getProjectsByStatus(scope)` — `Record<ProjectStatus, number>` for
 *     the "Projects by status" KPI card. Admin/staff call with no
 *     `companyId`; company-role users pass their own. Single `groupBy`
 *     aggregate; zero-fills all 5 status keys.
 *
 *   - `getTendersByStatus(scope)` — `Record<TenderStatus, number>` for
 *     the "Tenders by status" KPI card. `companyId` is interpreted as
 *     `publisherCompanyId`; company-role users don't render this card
 *     today (companies don't publish tenders).
 *
 *   - `getRecentActivityForViewer(limit)` — thin wrapper around
 *     `listAuditEvents` for the dashboard's activity card. Role-scoped
 *     visibility is enforced inside `listAuditEvents` (admin/staff see
 *     everything; company-role users see their own actions + their
 *     applications' events). The wrapper exists for the limit default
 *     and the explicit naming.
 *
 *   - `getTransactionsSummaryThisMonth()` — admin-only per-type
 *     breakdown of every transaction recorded in the current calendar
 *     month (UTC). Returns count + paise total per type plus a grand
 *     total. As of Day 19 this is a thin wrapper over
 *     `getTransactionsSummaryForPeriod` with the current-month bounds,
 *     preserved so the Day-18 dashboard widget keeps working unchanged.
 *
 * **Period family — what happened in `[start, end]`:**
 *
 *   - `getProjectsByStatusForPeriod(scope)` — like
 *     `getProjectsByStatus` but additionally filters on
 *     `projects.createdAt` falling inside `[start, end]`. Date bounds
 *     are ISO date-only strings (`YYYY-MM-DD`), inclusive on both
 *     ends — `createdAt` is an ISO-8601 timestamp; the helper anchors
 *     the upper bound to end-of-day UTC so a row created late on the
 *     `end` day still counts.
 *
 *   - `getTendersByStatusForPeriod(scope)` — period variant for
 *     tenders, filtering on `tenders.publishedAt` rather than
 *     `createdAt`. The report-relevant question is "what tenders went
 *     to market in this window"; a draft created in January but
 *     published in March belongs to March's report. Drafts that never
 *     publish (`publishedAt IS NULL`) never appear in any period.
 *
 *   - `getTransactionsSummaryForPeriod(scope)` — admin-only
 *     generalisation of `getTransactionsSummaryThisMonth`. Takes
 *     `{ start, end, companyId? }`. The company narrowing supports the
 *     "single-company financials over period X" report.
 *
 * Each helper returns an `ActionResult`-shaped payload so the calling
 * Server Component can branch on `result.ok` consistently. The reads
 * are single indexed aggregates — cheap enough to run in parallel
 * inside the dashboard's render pass.
 *
 * **Authorization model.** The projects / tenders breakdowns trust the
 * caller's `scope` arg (the dashboard / reports page decides whether
 * the viewer sees everything or just their own slice).
 * `getRecentActivityForViewer` delegates to `listAuditEvents`'s built-in
 * role scoping. Both transactions helpers (`*ThisMonth` and
 * `*ForPeriod`) are admin-only at the function level — the transactions
 * module is admin-only forever.
 *
 * @module lib/dashboard/aggregates
 */
"use server";

import { and, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  companies,
  projects,
  tenders,
  transactions,
  type ProjectStatus,
  type TenderStatus,
  type TransactionType,
} from "@/lib/db/schema";
import { readSession } from "@/lib/auth/session";
import { listAuditEvents } from "@/lib/audit/log";
import { logger } from "@/lib/logger";
import type { ActionResult } from "@/lib/types/action-result";

const log = logger.child({ module: "dashboard-aggregates" });

// ── Zod input schemas ──────────────────────────────────────────────────────

/**
 * Scope for the projects-by-status / tenders-by-status helpers. `companyId`
 * narrows by ownership (for projects) or by publisher (for tenders). When
 * absent, the helper returns counts across every row.
 */
const scopeSchema = z.object({
  companyId: z.string().uuid("Invalid companyId").optional(),
});

const limitSchema = z.coerce.number().int().min(1).max(200).default(10);

/**
 * ISO date-only (`YYYY-MM-DD`) check. We accept the date as a string
 * (the URL is the source of truth for the report's date range, and ISO
 * date-only strings flow through unchanged from
 * `?from=YYYY-MM-DD&to=YYYY-MM-DD` searchParams). Date object
 * construction for the SQL clauses lives inside the helper.
 */
const isoDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

/**
 * Period scope for the projects / tenders period-bounded helpers.
 * `start` and `end` are inclusive ISO date-only strings. `companyId` is
 * optional and behaves identically to the snapshot family's scope.
 *
 * The action layer is responsible for ensuring `start <= end` — the
 * helper does not enforce ordering, but an inverted range returns zero
 * rows by construction.
 */
const periodScopeSchema = z.object({
  start: isoDateString,
  end: isoDateString,
  companyId: z.string().uuid("Invalid companyId").optional(),
});

// ── Closed-set keys for zero-fill ──────────────────────────────────────────

const PROJECT_STATUS_KEYS: ProjectStatus[] = [
  "planning",
  "active",
  "on_hold",
  "completed",
  "cancelled",
];

const TENDER_STATUS_KEYS: TenderStatus[] = [
  "draft",
  "published",
  "closed",
  "awarded",
];

const TRANSACTION_TYPE_KEYS: TransactionType[] = [
  "invoice",
  "payment",
  "expense",
  "advance",
  "refund",
];

// ── Authorization helper ──────────────────────────────────────────────────

type AdminCheck = { ok: true } | { ok: false; error: string };

async function requireAdmin(): Promise<AdminCheck> {
  const session = await readSession();
  if (!session) return { ok: false, error: "You must be signed in" };
  if (session.role !== "admin") {
    log.warn("non-admin attempted dashboard aggregate", {
      userId: session.userId,
      role: session.role,
    });
    return { ok: false, error: "Only an administrator can do that" };
  }
  return { ok: true };
}

// ── Zero-fill helpers ──────────────────────────────────────────────────────

function emptyProjectsByStatus(): Record<ProjectStatus, number> {
  const out: Partial<Record<ProjectStatus, number>> = {};
  for (const k of PROJECT_STATUS_KEYS) out[k] = 0;
  return out as Record<ProjectStatus, number>;
}

function emptyTendersByStatus(): Record<TenderStatus, number> {
  const out: Partial<Record<TenderStatus, number>> = {};
  for (const k of TENDER_STATUS_KEYS) out[k] = 0;
  return out as Record<TenderStatus, number>;
}

function emptyByTypeNumber(): Record<TransactionType, number> {
  const out: Partial<Record<TransactionType, number>> = {};
  for (const k of TRANSACTION_TYPE_KEYS) out[k] = 0;
  return out as Record<TransactionType, number>;
}

// ── Month boundary helper ──────────────────────────────────────────────────

/**
 * First and last day of the current calendar month, in UTC, as ISO date-only
 * strings (`YYYY-MM-DD`). Both bounds are inclusive — the transactions
 * `occurredOn` column is date-only with no time component, so equality on
 * the month-end is what we want.
 *
 * UTC is deliberate: the `occurredOn` column is date-only and timezone-
 * agnostic in storage, but the month-start string is derived from the
 * runtime clock — using UTC keeps the boundary deterministic across
 * deployments regardless of host timezone.
 */
function currentMonthBoundsUtc(now = new Date()): {
  start: string;
  end: string;
} {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1));
  // Day 0 of the next month = last day of this month.
  const end = new Date(Date.UTC(year, month + 1, 0));
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

/**
 * Upper bound of a period-bounded `createdAt` / `publishedAt` filter,
 * pushed to end-of-day UTC. The `createdAt` and `publishedAt` columns
 * are ISO-8601 timestamps (e.g. `2026-05-23 14:30:00`), not date-only
 * strings — comparing them to `YYYY-MM-DD` strings lexicographically
 * works for the lower bound (`'2026-05-01' <= '2026-05-01 00:00:00'`)
 * but fails on the upper bound: `'2026-05-31' < '2026-05-31 14:30:00'`,
 * so a row created at 2pm on May 31 would NOT be included with a naive
 * `<= '2026-05-31'`. We bump the upper bound to `'2026-05-31 23:59:59'`
 * to keep the inclusive-on-both-ends contract.
 */
function endOfDayTimestamp(isoDate: string): string {
  return `${isoDate} 23:59:59`;
}

// ── getProjectsByStatus ───────────────────────────────────────────────────

/**
 * Count of projects bucketed by status. The caller chooses the scope —
 * admin/staff pass `{}` for an all-companies aggregate; company-role
 * users pass `{ companyId: <ownId> }` for their slice.
 */
export async function getProjectsByStatus(
  rawScope: unknown = {},
): Promise<ActionResult<{ byStatus: Record<ProjectStatus, number> }>> {
  const parsed = scopeSchema.safeParse(rawScope);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid scope",
      field: first?.path.join(".") || undefined,
    };
  }
  const scope = parsed.data;

  const whereClause = scope.companyId
    ? eq(projects.companyId, scope.companyId)
    : undefined;

  const rows = await db
    .select({
      status: projects.status,
      count: sql<number>`count(*)`,
    })
    .from(projects)
    .where(whereClause)
    .groupBy(projects.status);

  const byStatus = emptyProjectsByStatus();
  for (const row of rows) {
    const status = row.status as ProjectStatus;
    byStatus[status] = Number(row.count) || 0;
  }

  return { ok: true, byStatus };
}

// ── getTendersByStatus ────────────────────────────────────────────────────

/**
 * Count of tenders bucketed by status. `scope.companyId` is interpreted
 * as the `publisherCompanyId` filter — for the rare company-role
 * publisher path. Admin/staff pass `{}` to see the cross-platform set.
 */
export async function getTendersByStatus(
  rawScope: unknown = {},
): Promise<ActionResult<{ byStatus: Record<TenderStatus, number> }>> {
  const parsed = scopeSchema.safeParse(rawScope);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid scope",
      field: first?.path.join(".") || undefined,
    };
  }
  const scope = parsed.data;

  const whereClause = scope.companyId
    ? eq(tenders.publisherCompanyId, scope.companyId)
    : undefined;

  const rows = await db
    .select({
      status: tenders.status,
      count: sql<number>`count(*)`,
    })
    .from(tenders)
    .where(whereClause)
    .groupBy(tenders.status);

  const byStatus = emptyTendersByStatus();
  for (const row of rows) {
    const status = row.status as TenderStatus;
    byStatus[status] = Number(row.count) || 0;
  }

  return { ok: true, byStatus };
}

// ── getRecentActivityForViewer ────────────────────────────────────────────

/**
 * Thin wrapper around `listAuditEvents` for the dashboard's activity
 * card. Role-scoped visibility (admin/staff see everything; company-role
 * users see their own actions + their applications' events) is enforced
 * inside `listAuditEvents` — this wrapper just sets the dashboard's
 * limit default and gives the call site an explicit name.
 *
 * Returns the underlying `listAuditEvents` payload verbatim — the
 * activity card consumes the same `{ rows, total }` shape.
 */
export async function getRecentActivityForViewer(
  rawLimit: unknown = 10,
): Promise<Awaited<ReturnType<typeof listAuditEvents>>> {
  const parsed = limitSchema.safeParse(rawLimit);
  if (!parsed.success) {
    return { ok: false, error: "Invalid limit" };
  }
  return listAuditEvents({ limit: parsed.data });
}

// ── getTransactionsSummaryForPeriod ───────────────────────────────────────

/**
 * Per-type rollup of transactions whose `occurredOn` falls inside the
 * supplied `[start, end]` inclusive window. Admin-only — the transactions
 * module is admin-only forever. `companyId`, when set, narrows to a
 * single company's slice (used by the per-company financials report).
 *
 * Returns the per-type count + paise total maps plus a grand total
 * paise figure plus the echo of the period bounds (so callers can
 * render them without re-deriving).
 */
export async function getTransactionsSummaryForPeriod(
  rawScope: unknown,
): Promise<
  ActionResult<{
    countByType: Record<TransactionType, number>;
    totalPaiseByType: Record<TransactionType, number>;
    totalPaise: number;
    totalCount: number;
    start: string;
    end: string;
  }>
> {
  const auth = await requireAdmin();
  if (!auth.ok) return auth;

  const parsed = periodScopeSchema.safeParse(rawScope);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid period",
      field: first?.path.join(".") || undefined,
    };
  }
  const { start, end, companyId } = parsed.data;

  const filters: SQL[] = [
    gte(transactions.occurredOn, start),
    lte(transactions.occurredOn, end),
  ];
  if (companyId) filters.push(eq(transactions.companyId, companyId));

  const rows = await db
    .select({
      type: transactions.type,
      count: sql<number>`count(*)`,
      total: sql<number>`coalesce(sum(${transactions.amountPaise}), 0)`,
    })
    .from(transactions)
    .where(and(...filters))
    .groupBy(transactions.type);

  const countByType = emptyByTypeNumber();
  const totalPaiseByType = emptyByTypeNumber();
  let totalPaise = 0;
  let totalCount = 0;
  for (const row of rows) {
    const type = row.type as TransactionType;
    const c = Number(row.count) || 0;
    const t = Number(row.total) || 0;
    countByType[type] = c;
    totalPaiseByType[type] = t;
    totalPaise += t;
    totalCount += c;
  }

  return {
    ok: true,
    countByType,
    totalPaiseByType,
    totalPaise,
    totalCount,
    start,
    end,
  };
}

// ── getTransactionsSummaryThisMonth ───────────────────────────────────────

/**
 * Per-type rollup of transactions whose `occurredOn` falls inside the
 * current calendar month (UTC). Admin-only — the transactions module
 * is admin-only forever.
 *
 * As of Day 19 this is a thin wrapper over
 * `getTransactionsSummaryForPeriod` with the current-month bounds —
 * preserved so the Day-18 dashboard widget keeps working unchanged
 * (return shape stays identical: the `monthStart` / `monthEnd` keys are
 * mapped from the underlying `start` / `end`). `now` is overridable for
 * tests (so the fixture can pin a known month boundary).
 */
export async function getTransactionsSummaryThisMonth(
  now: Date = new Date(),
): Promise<
  ActionResult<{
    countByType: Record<TransactionType, number>;
    totalPaiseByType: Record<TransactionType, number>;
    totalPaise: number;
    totalCount: number;
    monthStart: string;
    monthEnd: string;
  }>
> {
  const { start, end } = currentMonthBoundsUtc(now);
  const inner = await getTransactionsSummaryForPeriod({ start, end });
  if (!inner.ok) return inner;
  return {
    ok: true,
    countByType: inner.countByType,
    totalPaiseByType: inner.totalPaiseByType,
    totalPaise: inner.totalPaise,
    totalCount: inner.totalCount,
    monthStart: inner.start,
    monthEnd: inner.end,
  };
}

// ── getMonthlyTransactionsTrend (Day 24) ──────────────────────────────────

/**
 * Schema for the rolling-trend helper. Caller picks the window size in
 * whole months and (optionally) narrows to a single transaction type.
 *
 * `transactionType: "all"` is treated identically to "absent" — both
 * yield the cross-type rolling total. Any other value narrows the
 * aggregate to that single type, which drives the
 * "Monthly Invoice Trend" Figma variant when the URL carries
 * `?trendType=invoice`.
 */
const monthlyTrendInputSchema = z.object({
  months: z.coerce.number().int().min(1).max(36).default(12),
  transactionType: z
    .enum(["all", "invoice", "payment", "expense", "advance", "refund"])
    .optional()
    .default("all"),
});

/**
 * Rolling N-month transactions trend. Admin-only — same gate as the
 * other transactions helpers. Returns one bucket per calendar month in
 * the trailing window `[(now - (N-1) months), now]` (UTC), sorted
 * oldest-first, with `totalPaise` zero-filled for months that had no
 * transactions so the chart keeps its X-axis spacing constant.
 *
 * Drives the dashboard's `<TransactionsTrendCard />`. The seed's
 * 13-month spread (current month + trailing 12) means a default
 * `months: 12` window always renders against non-trivial data.
 *
 * SQL: one `groupBy(substr(occurred_on, 1, 7))` aggregate — `occurred_on`
 * is stored as a `YYYY-MM-DD` ISO date string, so the first 7 chars
 * is the year-month key. Cheap and indexable on the date prefix.
 */
export async function getMonthlyTransactionsTrend(
  rawInput: unknown = {},
): Promise<
  ActionResult<{
    months: Array<{ month: string; totalPaise: number; count: number }>;
    /** Echoed UTC year-month strings ("YYYY-MM") for the window's first + last buckets. */
    start: string;
    end: string;
    /** Echoed transaction-type filter — "all" when unfiltered. */
    transactionType: "all" | TransactionType;
  }>
> {
  const auth = await requireAdmin();
  if (!auth.ok) return auth;

  const parsed = monthlyTrendInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid input",
      field: first?.path.join(".") || undefined,
    };
  }
  const { months, transactionType } = parsed.data;

  // Compute the window: `months` calendar months ending with the current
  // one (UTC). Returned buckets are oldest-first.
  const now = new Date();
  const windowMonths = buildMonthWindow(now, months);
  const startMonth = windowMonths[0];
  const endMonth = windowMonths[windowMonths.length - 1];

  // Date bounds for the SQL filter: first day of the start month and
  // last day of the end month. The `occurred_on` column is a `YYYY-MM-DD`
  // string so lexicographic comparison is correct.
  const startDate = `${startMonth}-01`;
  const endDate = lastDayOfMonth(endMonth);

  // Optional type narrow — "all" stays unfiltered (same shape as before).
  const filters: SQL[] = [
    gte(transactions.occurredOn, startDate),
    lte(transactions.occurredOn, endDate),
  ];
  if (transactionType !== "all") {
    filters.push(eq(transactions.type, transactionType));
  }

  const rows = await db
    .select({
      month: sql<string>`substr(${transactions.occurredOn}, 1, 7)`,
      total: sql<number>`coalesce(sum(${transactions.amountPaise}), 0)`,
      count: sql<number>`count(*)`,
    })
    .from(transactions)
    .where(and(...filters))
    .groupBy(sql`substr(${transactions.occurredOn}, 1, 7)`);

  // Zero-fill: build a map of every month in the window, then overlay
  // whatever the query returned. The map keeps the oldest-first ordering.
  const bucketMap = new Map<string, { totalPaise: number; count: number }>();
  for (const m of windowMonths) {
    bucketMap.set(m, { totalPaise: 0, count: 0 });
  }
  for (const row of rows) {
    const existing = bucketMap.get(row.month);
    if (existing) {
      existing.totalPaise = Number(row.total) || 0;
      existing.count = Number(row.count) || 0;
    }
  }

  const monthsOut = windowMonths.map((m) => ({
    month: m,
    totalPaise: bucketMap.get(m)?.totalPaise ?? 0,
    count: bucketMap.get(m)?.count ?? 0,
  }));

  return {
    ok: true,
    months: monthsOut,
    start: startMonth,
    end: endMonth,
    transactionType,
  };
}

// ── getMonthlyTransactionsBreakdownForPeriod (Day 24) ─────────────────────

/**
 * Period-bounded variant of the monthly trend. Same shape as
 * `getMonthlyTransactionsTrend` but instead of a trailing-N-month
 * window, the caller supplies `{ start, end }` ISO date strings (and an
 * optional `companyId` to narrow to a single company's slice).
 *
 * Drives the per-month bar chart inside the reports
 * `<TransactionsSummaryCard />`. Months are zero-filled across the full
 * `[start, end]` window so the chart axis stays consistent across
 * different period sizes.
 */
export async function getMonthlyTransactionsBreakdownForPeriod(
  rawScope: unknown,
): Promise<
  ActionResult<{
    months: Array<{ month: string; totalPaise: number; count: number }>;
    start: string;
    end: string;
  }>
> {
  const auth = await requireAdmin();
  if (!auth.ok) return auth;

  const parsed = periodScopeSchema.safeParse(rawScope);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid period",
      field: first?.path.join(".") || undefined,
    };
  }
  const { start, end, companyId } = parsed.data;

  const filters: SQL[] = [
    gte(transactions.occurredOn, start),
    lte(transactions.occurredOn, end),
  ];
  if (companyId) filters.push(eq(transactions.companyId, companyId));

  const rows = await db
    .select({
      month: sql<string>`substr(${transactions.occurredOn}, 1, 7)`,
      total: sql<number>`coalesce(sum(${transactions.amountPaise}), 0)`,
      count: sql<number>`count(*)`,
    })
    .from(transactions)
    .where(and(...filters))
    .groupBy(sql`substr(${transactions.occurredOn}, 1, 7)`);

  // Window for zero-fill: every YYYY-MM between start's month and end's
  // month inclusive.
  const startMonth = start.slice(0, 7);
  const endMonth = end.slice(0, 7);
  const windowMonths = buildMonthRange(startMonth, endMonth);

  const bucketMap = new Map<string, { totalPaise: number; count: number }>();
  for (const m of windowMonths) {
    bucketMap.set(m, { totalPaise: 0, count: 0 });
  }
  for (const row of rows) {
    const existing = bucketMap.get(row.month);
    if (existing) {
      existing.totalPaise = Number(row.total) || 0;
      existing.count = Number(row.count) || 0;
    }
  }

  const monthsOut = windowMonths.map((m) => ({
    month: m,
    totalPaise: bucketMap.get(m)?.totalPaise ?? 0,
    count: bucketMap.get(m)?.count ?? 0,
  }));

  return {
    ok: true,
    months: monthsOut,
    start,
    end,
  };
}

// ── Month-window helpers ─────────────────────────────────────────────────

/**
 * Build the trailing-N-month window ending on `now`'s calendar month
 * (UTC), oldest-first. Each entry is a `YYYY-MM` string.
 *
 *   buildMonthWindow(new Date("2026-05-23"), 3)
 *     → ["2026-03", "2026-04", "2026-05"]
 */
function buildMonthWindow(now: Date, months: number): string[] {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-11
  const out: string[] = [];
  for (let offset = months - 1; offset >= 0; offset--) {
    const d = new Date(Date.UTC(year, month - offset, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

/**
 * Build the inclusive list of `YYYY-MM` strings from `startMonth` to
 * `endMonth`. Returns `[startMonth]` when start === end; returns `[]`
 * when end is before start (the caller's input was inverted).
 */
function buildMonthRange(startMonth: string, endMonth: string): string[] {
  const [sy, sm] = startMonth.split("-").map(Number);
  const [ey, em] = endMonth.split("-").map(Number);
  const out: string[] = [];
  let y = sy;
  let m = sm; // 1-12
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/**
 * Last calendar day of a `YYYY-MM` month, as `YYYY-MM-DD`. Used to
 * close the upper bound of the trend window's SQL filter.
 */
function lastDayOfMonth(yearMonth: string): string {
  const [y, m] = yearMonth.split("-").map(Number);
  // Day 0 of next month = last day of this month.
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}

// ── getProjectsByStatusForPeriod ──────────────────────────────────────────

/**
 * Period-bounded variant of `getProjectsByStatus`. Filters by
 * `projects.createdAt` falling inside `[start, end]` (inclusive on both
 * ends — the upper bound is end-of-day UTC so a row created at 2pm on
 * the `end` day still counts).
 *
 * Scope-agnostic: the caller's `scope.companyId`, when set, narrows by
 * ownership. The reports page passes the report's selected companyId
 * (or omits it for cross-company aggregates) just like the snapshot
 * helper.
 */
export async function getProjectsByStatusForPeriod(
  rawScope: unknown,
): Promise<
  ActionResult<{
    byStatus: Record<ProjectStatus, number>;
    start: string;
    end: string;
  }>
> {
  const parsed = periodScopeSchema.safeParse(rawScope);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid period",
      field: first?.path.join(".") || undefined,
    };
  }
  const { start, end, companyId } = parsed.data;
  const endTs = endOfDayTimestamp(end);

  const filters: SQL[] = [
    gte(projects.createdAt, start),
    lte(projects.createdAt, endTs),
  ];
  if (companyId) filters.push(eq(projects.companyId, companyId));

  const rows = await db
    .select({
      status: projects.status,
      count: sql<number>`count(*)`,
    })
    .from(projects)
    .where(and(...filters))
    .groupBy(projects.status);

  const byStatus = emptyProjectsByStatus();
  for (const row of rows) {
    const status = row.status as ProjectStatus;
    byStatus[status] = Number(row.count) || 0;
  }

  return { ok: true, byStatus, start, end };
}

// ── getTendersByStatusForPeriod ───────────────────────────────────────────

/**
 * Period-bounded variant of `getTendersByStatus`. Filters by
 * `tenders.publishedAt` falling inside `[start, end]` (NOT `createdAt`).
 *
 * Why `publishedAt`: the report-relevant question is "what tenders went
 * to market in this window". A draft created in January but published
 * in March belongs to March's report. Drafts that never publish
 * (`publishedAt IS NULL`) never appear in any period — they're internal
 * working state, not market activity.
 *
 * Same scope semantics as `getProjectsByStatusForPeriod` — `companyId`
 * (when set) narrows by `publisherCompanyId`.
 */
export async function getTendersByStatusForPeriod(
  rawScope: unknown,
): Promise<
  ActionResult<{
    byStatus: Record<TenderStatus, number>;
    start: string;
    end: string;
  }>
> {
  const parsed = periodScopeSchema.safeParse(rawScope);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid period",
      field: first?.path.join(".") || undefined,
    };
  }
  const { start, end, companyId } = parsed.data;
  const endTs = endOfDayTimestamp(end);

  // `publishedAt IS NOT NULL` is implicit in the `gte` / `lte` clauses —
  // a NULL timestamp doesn't satisfy either comparison in SQLite, so
  // drafts (publishedAt NULL) are filtered out without an extra clause.
  const filters: SQL[] = [
    gte(tenders.publishedAt, start),
    lte(tenders.publishedAt, endTs),
  ];
  if (companyId) filters.push(eq(tenders.publisherCompanyId, companyId));

  const rows = await db
    .select({
      status: tenders.status,
      count: sql<number>`count(*)`,
    })
    .from(tenders)
    .where(and(...filters))
    .groupBy(tenders.status);

  const byStatus = emptyTendersByStatus();
  for (const row of rows) {
    const status = row.status as TenderStatus;
    byStatus[status] = Number(row.count) || 0;
  }

  return { ok: true, byStatus, start, end };
}

// ── getCompanyCount (Day 25) ──────────────────────────────────────────────

/**
 * Total number of companies on the platform, plus a delta showing how
 * many were added in the trailing window (default 30 days). Drives the
 * "Total Companies" KPI card on the admin dashboard — the delta lets
 * the card show the same "+13%" / "+12 this month" copy the Figma
 * mockup signals.
 *
 * No row-level scoping today — the helper is used only by the admin/
 * staff dashboard KPI strip, where the answer is always cross-company.
 * A future surface needing a company-role variant would add `scope` to
 * the signature.
 */
const companyCountInputSchema = z.object({
  /**
   * Window size in days for the delta. Defaults to 30. The delta is
   * "companies created in the last N days" — useful for "this month"
   * narratives without needing calendar-month maths.
   */
  withDeltaDays: z.coerce.number().int().min(1).max(365).default(30),
});

export async function getCompanyCount(
  rawInput: unknown = {},
): Promise<
  ActionResult<{
    total: number;
    recentlyAdded: number;
    windowDays: number;
  }>
> {
  const parsed = companyCountInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid input",
      field: first?.path.join(".") || undefined,
    };
  }
  const { withDeltaDays } = parsed.data;

  // Window cutoff: ISO timestamp `windowDays` ago. The createdAt column
  // is an ISO-8601 string; lexicographic comparison is correct because
  // ISO timestamps are sortable as strings.
  const cutoffMs = Date.now() - withDeltaDays * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  const [totalRow, recentRow] = await Promise.all([
    db
      .select({ value: sql<number>`count(*)` })
      .from(companies)
      .then((r) => r[0]),
    db
      .select({ value: sql<number>`count(*)` })
      .from(companies)
      .where(gte(companies.createdAt, cutoffIso))
      .then((r) => r[0]),
  ]);

  return {
    ok: true,
    total: Number(totalRow?.value) || 0,
    recentlyAdded: Number(recentRow?.value) || 0,
    windowDays: withDeltaDays,
  };
}

// ── getTotalProjectValue (Day 25) ─────────────────────────────────────────

/**
 * Sum of `projects.budgetInr` across every project (or scoped to a
 * single company). The budget column is stored as whole rupees per the
 * Day-12 Phase-2 schema decision; this helper just sums.
 *
 * Admin-only — surface is a financial KPI and goes alongside the
 * Amount Paid / Due card. Projects without a stated budget are
 * silently excluded by the SQL `sum()` (NULL skipped).
 */
const projectValueScopeSchema = z.object({
  companyId: z.string().uuid("Invalid companyId").optional(),
});

export async function getTotalProjectValue(
  rawScope: unknown = {},
): Promise<
  ActionResult<{
    totalRupees: number;
    /** How many projects contributed a non-null budget figure. */
    projectsWithBudget: number;
  }>
> {
  const auth = await requireAdmin();
  if (!auth.ok) return auth;

  const parsed = projectValueScopeSchema.safeParse(rawScope);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid scope",
      field: first?.path.join(".") || undefined,
    };
  }
  const { companyId } = parsed.data;

  const whereClause = companyId ? eq(projects.companyId, companyId) : undefined;

  const row = await db
    .select({
      total: sql<number>`coalesce(sum(${projects.budgetInr}), 0)`,
      withBudget: sql<number>`sum(case when ${projects.budgetInr} is not null then 1 else 0 end)`,
    })
    .from(projects)
    .where(whereClause)
    .then((r) => r[0]);

  return {
    ok: true,
    totalRupees: Number(row?.total) || 0,
    projectsWithBudget: Number(row?.withBudget) || 0,
  };
}

// ── getPaidAndDueTotals (Day 25) ──────────────────────────────────────────

/**
 * Paid vs Invoiced rollup across every transaction (or scoped to a
 * single company). Admin-only — the transactions module is admin-only
 * forever.
 *
 *   - `invoicedPaise` = `sum(amountPaise) WHERE type='invoice'`
 *   - `paidPaise`     = `sum(amountPaise) WHERE type='payment'`
 *   - `duePaise`      = `max(0, invoicedPaise - paidPaise)`
 *
 * Negative "due" is clamped to zero — overpayment isn't a meaningful
 * KPI display state. Callers wanting the raw signed figure can compute
 * it from invoiced/paid directly.
 */
export async function getPaidAndDueTotals(
  rawScope: unknown = {},
): Promise<
  ActionResult<{
    paidPaise: number;
    invoicedPaise: number;
    duePaise: number;
  }>
> {
  const auth = await requireAdmin();
  if (!auth.ok) return auth;

  const parsed = projectValueScopeSchema.safeParse(rawScope);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid scope",
      field: first?.path.join(".") || undefined,
    };
  }
  const { companyId } = parsed.data;

  // One groupBy(type) aggregate — both totals come from the same scan.
  const filters: SQL[] = [];
  if (companyId) filters.push(eq(transactions.companyId, companyId));
  const whereClause = filters.length > 0 ? and(...filters) : undefined;

  const rows = await db
    .select({
      type: transactions.type,
      total: sql<number>`coalesce(sum(${transactions.amountPaise}), 0)`,
    })
    .from(transactions)
    .where(whereClause)
    .groupBy(transactions.type);

  let invoicedPaise = 0;
  let paidPaise = 0;
  for (const row of rows) {
    const t = row.type as TransactionType;
    const amount = Number(row.total) || 0;
    if (t === "invoice") invoicedPaise = amount;
    else if (t === "payment") paidPaise = amount;
  }

  const duePaise = Math.max(0, invoicedPaise - paidPaise);

  return {
    ok: true,
    paidPaise,
    invoicedPaise,
    duePaise,
  };
}
