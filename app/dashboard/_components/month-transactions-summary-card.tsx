/**
 * MonthTransactionsSummaryCard — admin-only dashboard widget that shows
 * the per-type breakdown of transactions recorded in the current
 * calendar month (UTC).
 *
 * Server Component. Calls `getTransactionsSummaryThisMonth`, which is
 * admin-only at the function level. Staff and company-role viewers
 * never reach this card — the dashboard page renders it conditionally
 * on the admin layout slot.
 *
 * Empty-month case: when no transactions have been recorded in the
 * current month, the card renders a friendly "No transactions recorded
 * this month yet." line in place of the type grid.
 *
 * @module app/dashboard/_components/month-transactions-summary-card
 */
import { Wallet } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { getTransactionsSummaryThisMonth } from "@/lib/dashboard/aggregates";
import { formatRupeesFromPaise } from "@/lib/format/inr";
import { TransactionTypeBadge } from "@/app/dashboard/transactions/_components/badges";
import type { TransactionType } from "@/lib/db/schema";

export async function MonthTransactionsSummaryCard() {
  const result = await getTransactionsSummaryThisMonth();

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
            Transactions this month
          </h2>
        </div>
        <span className="text-xs text-muted-foreground">
          {result.monthStart} → {result.monthEnd}
        </span>
      </header>

      <div className="space-y-6 p-6">
        {result.totalCount === 0 ? (
          <p className="text-sm italic text-muted-foreground">
            No transactions recorded this month yet.
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
                {result.totalCount === 1 ? "entry" : "entries"} this month
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
