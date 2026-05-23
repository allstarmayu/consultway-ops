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
import { getTransactionsSummaryForPeriod } from "@/lib/dashboard/aggregates";
import { formatRupeesFromPaise } from "@/lib/format/inr";
import { TransactionTypeBadge } from "@/app/dashboard/transactions/_components/badges";
import type { TransactionType } from "@/lib/db/schema";

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
  const result = await getTransactionsSummaryForPeriod({
    start,
    end,
    ...(companyId ? { companyId } : {}),
  });

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

  return (
    <Card className="overflow-hidden p-0">
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
