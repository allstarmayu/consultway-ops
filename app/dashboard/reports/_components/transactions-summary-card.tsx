/**
 * TransactionsSummaryCard — admin-only per-type breakdown of every
 * transaction whose `occurredOn` falls inside the report's selected
 * period.
 *
 * Server Component. Cosmetic descendant of Day-18's
 * `MonthTransactionsSummaryCard` — same chrome, same grid, but takes
 * arbitrary period bounds rather than computing the current month.
 * Lives alongside the dashboard card rather than refactoring it into
 * one — the dashboard widget stays current-month-only, this one is
 * period-bounded.
 *
 * Empty period: when no transactions occurred in the window, the card
 * renders a friendly "No transactions in this period." in place of the
 * grid.
 *
 * @module app/dashboard/reports/_components/transactions-summary-card
 */
import { Wallet } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  getMonthlyTransactionsBreakdownForPeriod,
  getTransactionsSummaryForPeriod,
} from "@/lib/dashboard/aggregates";
import { formatRupeesFromPaise } from "@/lib/format/inr";
import { TransactionTypeBadge } from "@/app/dashboard/transactions/_components/badges";
import type { TransactionType } from "@/lib/db/schema";

import { TransactionsBreakdownBarChart } from "./transactions-breakdown-bar-chart";

export interface TransactionsSummaryCardProps {
  start: string;
  end: string;
  companyId?: string;
}

export async function TransactionsSummaryCard({
  start,
  end,
  companyId,
}: TransactionsSummaryCardProps) {
  // Fetch the per-type rollup and the per-month breakdown in parallel.
  // Both are admin-only at the helper level; the reports page already
  // role-gates this entire card.
  const [result, monthlyResult] = await Promise.all([
    getTransactionsSummaryForPeriod({
      start,
      end,
      ...(companyId ? { companyId } : {}),
    }),
    getMonthlyTransactionsBreakdownForPeriod({
      start,
      end,
      ...(companyId ? { companyId } : {}),
    }),
  ]);

  if (!result.ok) {
    return (
      <Card className="p-4">
        <Alert variant="destructive">
          <AlertDescription>{result.error}</AlertDescription>
        </Alert>
      </Card>
    );
  }

  const types = Object.keys(result.countByType) as TransactionType[];
  // The monthly chart is only useful when the window spans 2+ buckets;
  // a single-month window's bar is redundant with the per-type grid
  // below. Also skip if the monthly query itself errored — the per-type
  // grid still carries the period's info.
  const monthlyBuckets = monthlyResult.ok ? monthlyResult.months : [];
  const showMonthlyChart =
    monthlyBuckets.length >= 2 && result.totalCount > 0;

  return (
    <Card className="interactive-card overflow-hidden p-0">
      <header className="flex items-center justify-between border-b border-border bg-card p-4">
        <div className="flex items-center gap-2">
          <Wallet className="h-4 w-4 text-muted-foreground" aria-hidden />
          <h2 className="text-base font-semibold text-foreground">
            Transactions
          </h2>
        </div>
        <span className="text-xs text-muted-foreground">
          {result.start} → {result.end}
        </span>
      </header>

      <div className="space-y-6 p-6">
        {result.totalCount === 0 ? (
          <p className="text-sm italic text-muted-foreground">
            No transactions in this period.
          </p>
        ) : (
          <>
            {/* Day 24: per-month bar chart at the top — only when the
                window has 2+ months. The chart reads the same
                period bounds as the per-type grid below; the two are
                two views of the same dataset. */}
            {showMonthlyChart && (
              <TransactionsBreakdownBarChart data={monthlyBuckets} />
            )}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {types.map((t) => (
                <div
                  key={t}
                  className="space-y-1.5 rounded-md border border-border bg-card p-3"
                >
                  <TransactionTypeBadge type={t} iconless />
                  <p className="font-mono text-sm tabular-nums text-foreground">
                    {formatRupeesFromPaise(result.totalPaiseByType[t])}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {result.countByType[t]}{" "}
                    {result.countByType[t] === 1 ? "entry" : "entries"}
                  </p>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between border-t border-border pt-3 text-sm">
              <span className="text-muted-foreground">
                {result.totalCount}{" "}
                {result.totalCount === 1 ? "entry" : "entries"} in period
              </span>
              <span className="font-mono text-base tabular-nums text-foreground">
                {formatRupeesFromPaise(result.totalPaise)}
              </span>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
