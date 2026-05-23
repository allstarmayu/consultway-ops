/**
 * Dashboard aggregates — pure-read helpers for the role-aware widgets
 * on `/dashboard`.
 *
 * Four helpers:
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
 *     total.
 *
 * Each helper returns an `ActionResult`-shaped payload so the calling
 * Server Component can branch on `result.ok` consistently. The reads
 * are single indexed aggregates — cheap enough to run in parallel
 * inside the dashboard's render pass.
 *
 * **Authorization model.** The projects / tenders breakdowns trust the
 * caller's `scope` arg (the dashboard page decides whether the viewer
 * sees everything or just their own slice). `getRecentActivityForViewer`
 * delegates to `listAuditEvents`'s built-in role scoping.
 * `getTransactionsSummaryThisMonth` is admin-only at the function
 * level — the transactions module is admin-only forever.
 *
 * @module lib/dashboard/aggregates
 */
"use server";

import { and, count, eq, gte, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import {
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

// ── getTransactionsSummaryThisMonth ───────────────────────────────────────

/**
 * Per-type rollup of transactions whose `occurredOn` falls inside the
 * current calendar month (UTC). Admin-only — the transactions module
 * is admin-only forever.
 *
 * `now` is overridable for tests (so the fixture can pin a known month
 * boundary). Defaults to the runtime clock.
 *
 * Returns the per-type count + paise total maps plus a grand total
 * paise figure for the headline.
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
  const auth = await requireAdmin();
  if (!auth.ok) return auth;

  const { start, end } = currentMonthBoundsUtc(now);

  const rows = await db
    .select({
      type: transactions.type,
      count: sql<number>`count(*)`,
      total: sql<number>`coalesce(sum(${transactions.amountPaise}), 0)`,
    })
    .from(transactions)
    .where(
      and(
        gte(transactions.occurredOn, start),
        lte(transactions.occurredOn, end),
      ),
    )
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
    monthStart: start,
    monthEnd: end,
  };
}
