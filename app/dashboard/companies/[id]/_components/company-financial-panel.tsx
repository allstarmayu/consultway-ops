/**
 * Per-company financial panel.
 *
 * Server Component. Admin-only — the company detail page gates this
 * panel on the same `session.role === "admin"` check that gates the
 * per-project rollup card on the project detail page. Staff and
 * company-role viewers don't see it (transactions are admin-only
 * forever, even when they touch a company that staff can otherwise
 * read).
 *
 * Mirrors `app/dashboard/projects/[id]/_components/project-rollup-card.tsx`
 * line-for-line — same layout, same primitives. The per-company variant
 * shows BOTH project-tagged and company-level (no-project) rows in the
 * rollup, matching `getCompanyRollup`'s own semantics.
 *
 * Layout:
 *   - Per-type breakdown grid (5 type cells)
 *   - Grand-total line
 *   - "Recent transactions" mini-list (latest 5, each linked to detail)
 *   - "View all" link → `/dashboard/transactions?companyId=<id>`
 *
 * @module app/dashboard/companies/[id]/_components/company-financial-panel
 */
import Link from "next/link";
import { ArrowRight, Wallet } from "lucide-react";

import {
  getCompanyRollup,
  getCompanyRecentTransactions,
} from "@/lib/transactions/rollups";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatRupeesFromPaise } from "@/lib/format/inr";
import { TransactionTypeBadge } from "@/app/dashboard/transactions/_components/badges";
import type { TransactionType } from "@/lib/db/schema";

export interface CompanyFinancialPanelProps {
  companyId: string;
}

export async function CompanyFinancialPanel({
  companyId,
}: CompanyFinancialPanelProps) {
  // Both calls gate on `requireAdmin` defensively. The page-level gate
  // is the user-facing one; these are the no-bypass ones.
  const [rollupResult, recentResult] = await Promise.all([
    getCompanyRollup(companyId),
    getCompanyRecentTransactions(companyId, 5),
  ]);

  if (!rollupResult.ok) {
    return (
      <Card className="mt-4 p-6">
        <Alert variant="destructive">
          <AlertDescription>{rollupResult.error}</AlertDescription>
        </Alert>
      </Card>
    );
  }

  const rollup = rollupResult.rollup;
  const recent = recentResult.ok ? recentResult.rows : [];

  return (
    <Card className="mt-4 overflow-hidden p-0">
      <header className="flex items-center justify-between border-b border-border bg-card p-4">
        <div className="flex items-center gap-2">
          <Wallet className="h-4 w-4 text-muted-foreground" aria-hidden />
          <h2 className="text-base font-semibold text-foreground">
            Financial activity
          </h2>
        </div>
        <Button asChild variant="ghost" size="sm">
          <Link
            href={`/dashboard/transactions?companyId=${companyId}`}
            className="text-muted-foreground"
          >
            View all
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </Button>
      </header>

      <div className="space-y-6 p-6">
        {/* ── Per-type breakdown grid ──────────────────────────────── */}
        <section>
          <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            By type
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {(Object.keys(rollup.byType) as TransactionType[]).map((t) => (
              <TypeCell
                key={t}
                type={t}
                count={rollup.byType[t].count}
                totalPaise={rollup.byType[t].totalPaise}
              />
            ))}
          </div>

          <div className="mt-4 flex items-center justify-between border-t border-border pt-3 text-sm">
            <span className="text-muted-foreground">
              {rollup.totalCount}{" "}
              {rollup.totalCount === 1 ? "entry" : "entries"} all-time
            </span>
            <span className="font-mono text-base tabular-nums text-foreground">
              {formatRupeesFromPaise(rollup.totalPaise)}
            </span>
          </div>
        </section>

        {/* ── Recent transactions mini-list ────────────────────────── */}
        <section>
          <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Recent transactions
          </p>
          {recent.length === 0 ? (
            <p className="text-sm italic text-muted-foreground">
              No transactions recorded for this company yet.
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {recent.map((tx) => (
                <li key={tx.id}>
                  <Link
                    href={`/dashboard/transactions/${tx.id}`}
                    className="flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-muted/40"
                  >
                    <span className="w-[6rem] shrink-0 text-muted-foreground">
                      {tx.occurredOn}
                    </span>
                    <span className="shrink-0">
                      <TransactionTypeBadge type={tx.type} iconless />
                    </span>
                    <span className="flex-1 truncate font-mono text-xs text-muted-foreground">
                      {tx.referenceNumber ?? ""}
                    </span>
                    <span className="font-mono tabular-nums text-foreground">
                      {formatRupeesFromPaise(tx.amountPaise)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Card>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

interface TypeCellProps {
  type: TransactionType;
  count: number;
  totalPaise: number;
}

function TypeCell({ type, count, totalPaise }: TypeCellProps) {
  return (
    <div className="space-y-1.5 rounded-md border border-border bg-card p-3">
      <TransactionTypeBadge type={type} iconless />
      <p className="font-mono text-sm tabular-nums text-foreground">
        {formatRupeesFromPaise(totalPaise)}
      </p>
      <p className="text-xs text-muted-foreground">
        {count} {count === 1 ? "entry" : "entries"}
      </p>
    </div>
  );
}
