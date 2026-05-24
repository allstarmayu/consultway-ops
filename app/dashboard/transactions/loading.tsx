/**
 * Transactions list loading skeleton (admin-only).
 *
 * Mirrors `app/dashboard/tenders/loading.tsx` adapted to the transactions
 * table's 7-column shape. Three zones:
 *   - Page header strip
 *   - Filters bar
 *   - Table rows
 *
 * Uses the Day-26 `.skeleton` shimmer utility for a more modern
 * loading aesthetic that's theme-aware across all 6 palettes.
 *
 * Server Component. No hooks, no client JS, no extra deps.
 *
 * @module app/dashboard/transactions/loading
 */
import { Card } from "@/components/ui/card";

export default function TransactionsLoading() {
  return (
    <>
      <header className="mb-6 flex items-start justify-between gap-4 sm:mb-8">
        <div className="space-y-2">
          <div className="skeleton h-8 w-48" />
          <div className="skeleton h-4 w-72" />
        </div>
        <div className="flex items-center gap-2">
          <div className="skeleton h-10 w-32" />
          <div className="skeleton h-10 w-32" />
        </div>
      </header>

      <Card className="overflow-hidden p-0">
        {/* Filters bar placeholder — search + type + company + project */}
        <div className="flex flex-wrap items-center gap-3 border-b border-border bg-card p-4">
          <div className="skeleton h-10 w-64" />
          <div className="skeleton h-10 w-40" />
          <div className="skeleton h-10 w-48" />
          <div className="skeleton h-10 w-48" />
        </div>

        {/* Table header — 7 columns matching transactions-table.tsx */}
        <div className="grid grid-cols-[7rem_7rem_8rem_1fr_1fr_10rem_6rem] gap-4 border-b border-border bg-muted/50 px-4 py-3 text-xs">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="skeleton h-3 w-20" />
          ))}
        </div>

        {/* Six placeholder rows */}
        <div className="divide-y divide-border">
          {Array.from({ length: 6 }).map((_, rowIdx) => (
            <div
              key={rowIdx}
              className="grid grid-cols-[7rem_7rem_8rem_1fr_1fr_10rem_6rem] items-center gap-4 px-4 py-4"
            >
              <div className="skeleton h-4 w-20" />
              <div className="skeleton h-6 w-20 rounded-full" />
              <div className="skeleton ml-auto h-4 w-24" />
              <div className="skeleton h-4 w-3/4" />
              <div className="skeleton h-4 w-3/4" />
              <div className="skeleton h-4 w-28" />
              <div className="ml-auto flex gap-1">
                <div className="skeleton h-8 w-8" />
              </div>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
