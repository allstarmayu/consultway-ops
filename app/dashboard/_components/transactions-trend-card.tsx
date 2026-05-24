/**
 * TransactionsTrendCard — admin-only dashboard widget showing a rolling
 * 12-month area chart of transaction totals.
 *
 * Server Component. Calls `getMonthlyTransactionsTrend`, then hands the
 * pre-shaped buckets to the client-side `<TransactionsTrendChart />`
 * for rendering. Splitting the fetch / render boundary keeps the
 * RSC tree happy: recharts requires the DOM, the aggregate call
 * doesn't.
 *
 * Empty state: when every bucket is zero (no transactions in the last
 * 12 months — typically only on a fresh dev DB), the card renders a
 * friendly line instead of an empty axis.
 *
 * @module app/dashboard/_components/transactions-trend-card
 */
import { TrendingUp } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { getMonthlyTransactionsTrend } from "@/lib/dashboard/aggregates";
import { formatRupeesFromPaise } from "@/lib/format/inr";

import { TransactionsTrendChart } from "./transactions-trend-chart";
import { TrendFilters, type TrendType } from "./trend-filters";

interface TransactionsTrendCardProps {
  /**
   * Window size in months. Defaults to 12 — same as the helper's
   * default. The dashboard page resolves this from the `?trendMonths`
   * URL param (via `resolveTrendMonths`).
   */
  months?: 6 | 12 | 24;
  /**
   * Transaction-type narrow. Defaults to "all". The dashboard page
   * resolves this from the `?trendType` URL param (via
   * `resolveTrendType`).
   */
  type?: TrendType;
}

/**
 * Human-readable title fragment for the active filter. "All
 * transactions" for the unfiltered view; "Invoice transactions" when
 * `type === "invoice"`; etc.
 */
function describeType(type: TrendType): string {
  if (type === "all") return "all transactions";
  return `${type[0].toUpperCase()}${type.slice(1)} transactions`;
}

export async function TransactionsTrendCard({
  months = 12,
  type = "all",
}: TransactionsTrendCardProps = {}) {
  const result = await getMonthlyTransactionsTrend({
    months,
    transactionType: type,
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

  const grandTotalPaise = result.months.reduce(
    (acc, m) => acc + m.totalPaise,
    0,
  );
  const grandTotalCount = result.months.reduce((acc, m) => acc + m.count, 0);
  const isEmpty = grandTotalCount === 0;

  return (
    <Card className="overflow-hidden p-0">
      <header className="flex flex-col gap-3 border-b border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <TrendingUp
            className="h-4 w-4 text-muted-foreground"
            aria-hidden
          />
          <h2 className="text-base font-semibold text-foreground">
            Trend — {describeType(type)}
          </h2>
          <span className="text-xs text-muted-foreground">
            ({result.start} → {result.end})
          </span>
        </div>
        <TrendFilters months={months} type={type} />
      </header>

      <div className="p-4">
        {isEmpty ? (
          <p className="px-2 py-12 text-center text-sm italic text-muted-foreground">
            No {type === "all" ? "" : `${type} `}transactions recorded in the
            last {months} months.
          </p>
        ) : (
          <>
            <TransactionsTrendChart data={result.months} />
            <div className="mt-3 flex items-center justify-between border-t border-border pt-3 text-sm">
              <span className="text-muted-foreground">
                {grandTotalCount}{" "}
                {grandTotalCount === 1 ? "entry" : "entries"} across the window
              </span>
              <span className="font-mono text-base tabular-nums text-foreground">
                {formatRupeesFromPaise(grandTotalPaise)}
              </span>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
