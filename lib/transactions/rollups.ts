/**
 * Transactions rollups — per-company and per-project aggregate queries.
 *
 * Both functions return per-type counts + paise totals plus a grand
 * total. Used by:
 *
 *   - the project detail page's `<ProjectRollupCard>` (admin-only)
 *   - the (future) company detail page's transactions panel
 *
 * Aggregation runs entirely in SQL via Drizzle's `groupBy(type)` so the
 * result is cheap (one indexed query per rollup, using the
 * `transactions_company_type_idx` / `transactions_project_type_idx`
 * composites added in migration 0012).
 *
 * Admin-only: both functions gate on `requireAdmin` defence-in-depth.
 * The page-level gates are the user-facing ones; these gates exist so
 * a misconfigured caller doesn't leak rollups via an unrelated surface.
 *
 * @module lib/transactions/rollups
 */
"use server";

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  transactions,
  type TransactionType,
} from "@/lib/db/schema";
import { readSession } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import type { ActionResult } from "@/lib/types/action-result";

const log = logger.child({ module: "transactions-rollups" });

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Per-type aggregate. `count` is the number of transactions of that
 * type; `totalPaise` is the sum of their `amountPaise`. Zero-row types
 * are filled in with `{ count: 0, totalPaise: 0 }` so callers always
 * see the full set of keys.
 */
export interface TypeBreakdown {
  count: number;
  totalPaise: number;
}

export interface Rollup {
  /** Per-type breakdown — keyed by all 5 TransactionType values. */
  byType: Record<TransactionType, TypeBreakdown>;
  /** Grand total of all amountPaise across every type. */
  totalPaise: number;
  /** Total number of rows aggregated. */
  totalCount: number;
}

/**
 * All five transaction-type keys, in display order. Kept here as a
 * constant so the zero-fill for empty types matches the schema's
 * union without depending on the badges module (which lives in
 * `app/dashboard/transactions/_components`).
 */
const ALL_TYPES: TransactionType[] = [
  "invoice",
  "payment",
  "expense",
  "advance",
  "refund",
];

// ── Authorization helper ───────────────────────────────────────────────────

type AdminCheck = { ok: true } | { ok: false; error: string };

async function requireAdmin(): Promise<AdminCheck> {
  const session = await readSession();
  if (!session) return { ok: false, error: "You must be signed in" };
  if (session.role !== "admin") {
    log.warn("non-admin attempted transactions rollup", {
      userId: session.userId,
      role: session.role,
    });
    return { ok: false, error: "Only an administrator can do that" };
  }
  return { ok: true };
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Zero-filled byType skeleton. Used as the starting point that the
 * groupBy result rows mutate into.
 */
function emptyByType(): Record<TransactionType, TypeBreakdown> {
  const out: Partial<Record<TransactionType, TypeBreakdown>> = {};
  for (const t of ALL_TYPES) {
    out[t] = { count: 0, totalPaise: 0 };
  }
  return out as Record<TransactionType, TypeBreakdown>;
}

// ── getCompanyRollup ───────────────────────────────────────────────────────

/**
 * Per-company rollup of every transaction the company is party to.
 * Includes both project-tagged AND company-level (project NULL) rows.
 *
 * Returns the rollup payload on success.
 */
export async function getCompanyRollup(
  companyId: string,
): Promise<ActionResult<{ rollup: Rollup }>> {
  const auth = await requireAdmin();
  if (!auth.ok) return auth;

  const rows = await db
    .select({
      type: transactions.type,
      count: sql<number>`count(*)`,
      total: sql<number>`coalesce(sum(${transactions.amountPaise}), 0)`,
    })
    .from(transactions)
    .where(eq(transactions.companyId, companyId))
    .groupBy(transactions.type);

  const byType = emptyByType();
  let totalPaise = 0;
  let totalCount = 0;
  for (const row of rows) {
    const t = row.type as TransactionType;
    const count = Number(row.count) || 0;
    const total = Number(row.total) || 0;
    byType[t] = { count, totalPaise: total };
    totalPaise += total;
    totalCount += count;
  }

  return {
    ok: true,
    rollup: { byType, totalPaise, totalCount },
  };
}

// ── getProjectRollup ───────────────────────────────────────────────────────

/**
 * Per-project rollup. Scoped to a single project — excludes the
 * company's company-level (project NULL) rows by construction.
 */
export async function getProjectRollup(
  projectId: string,
): Promise<ActionResult<{ rollup: Rollup }>> {
  const auth = await requireAdmin();
  if (!auth.ok) return auth;

  const rows = await db
    .select({
      type: transactions.type,
      count: sql<number>`count(*)`,
      total: sql<number>`coalesce(sum(${transactions.amountPaise}), 0)`,
    })
    .from(transactions)
    .where(eq(transactions.projectId, projectId))
    .groupBy(transactions.type);

  const byType = emptyByType();
  let totalPaise = 0;
  let totalCount = 0;
  for (const row of rows) {
    const t = row.type as TransactionType;
    const count = Number(row.count) || 0;
    const total = Number(row.total) || 0;
    byType[t] = { count, totalPaise: total };
    totalPaise += total;
    totalCount += count;
  }

  return {
    ok: true,
    rollup: { byType, totalPaise, totalCount },
  };
}

// ── getProjectRecentTransactions ───────────────────────────────────────────

/**
 * Latest N transactions for a project, ordered occurredOn DESC. Used by
 * the per-project rollup card's "Recent transactions" mini-list.
 */
export async function getProjectRecentTransactions(
  projectId: string,
  limit = 5,
): Promise<
  ActionResult<{
    rows: Array<{
      id: string;
      type: TransactionType;
      amountPaise: number;
      occurredOn: string;
      referenceNumber: string | null;
    }>;
  }>
> {
  const auth = await requireAdmin();
  if (!auth.ok) return auth;

  const rows = await db
    .select({
      id: transactions.id,
      type: transactions.type,
      amountPaise: transactions.amountPaise,
      occurredOn: transactions.occurredOn,
      referenceNumber: transactions.referenceNumber,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.projectId, projectId),
        // Defensive — projectId equality already excludes NULLs, but
        // mirror the intent so the query plan stays obvious.
        sql`${transactions.projectId} is not null`,
      ),
    )
    .orderBy(sql`${transactions.occurredOn} desc`)
    .limit(limit);

  return {
    ok: true,
    rows: rows.map((r) => ({ ...r, type: r.type as TransactionType })),
  };
}

// ── getCompanyRecentTransactions ───────────────────────────────────────────

/**
 * Latest N transactions for a company, ordered occurredOn DESC. Used by
 * the per-company financial panel's "Recent transactions" mini-list.
 *
 * Mirrors `getProjectRecentTransactions` exactly but scoped to a company
 * — and so INCLUDES both project-tagged and no-project rows, matching
 * the per-company rollup's own semantics ("everything the company is
 * party to, regardless of project").
 */
export async function getCompanyRecentTransactions(
  companyId: string,
  limit = 5,
): Promise<
  ActionResult<{
    rows: Array<{
      id: string;
      type: TransactionType;
      amountPaise: number;
      occurredOn: string;
      referenceNumber: string | null;
      projectId: string | null;
    }>;
  }>
> {
  const auth = await requireAdmin();
  if (!auth.ok) return auth;

  const rows = await db
    .select({
      id: transactions.id,
      type: transactions.type,
      amountPaise: transactions.amountPaise,
      occurredOn: transactions.occurredOn,
      referenceNumber: transactions.referenceNumber,
      projectId: transactions.projectId,
    })
    .from(transactions)
    .where(eq(transactions.companyId, companyId))
    .orderBy(sql`${transactions.occurredOn} desc`)
    .limit(limit);

  return {
    ok: true,
    rows: rows.map((r) => ({ ...r, type: r.type as TransactionType })),
  };
}
