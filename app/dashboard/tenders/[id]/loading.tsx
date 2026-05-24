/**
 * Tender detail loading skeleton.
 *
 * Matches the final layout of `page.tsx`:
 *   - Header strip (title + status badge + action buttons)
 *   - Two-column grid: Identity / Categorisation+Eligibility / Dates / Notes
 *   - Applications table section below
 *
 * Uses the Day-26 `.skeleton` shimmer utility for theme-aware loading.
 *
 * @module app/dashboard/tenders/[id]/loading
 */
import { Card } from "@/components/ui/card";

export default function TenderDetailLoading() {
  return (
    <>
      {/* Header placeholder */}
      <header className="mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="skeleton h-8 w-72" />
          <div className="flex items-center gap-2">
            <div className="skeleton h-5 w-20 rounded-full" />
            <div className="skeleton h-4 w-32 opacity-60" />
          </div>
        </div>
        <div className="flex gap-2">
          <div className="skeleton h-10 w-24" />
          <div className="skeleton h-10 w-24" />
        </div>
      </header>

      {/* Body — four cards in a 2-column grid */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="space-y-4 p-6">
            <div className="space-y-1.5">
              <div className="skeleton h-5 w-32" />
              <div className="skeleton h-3 w-48 opacity-60" />
            </div>
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((__, j) => (
                <div key={j} className="space-y-1">
                  <div className="skeleton h-3 w-24 opacity-60" />
                  <div className="skeleton h-4 w-full" />
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>

      {/* Applications section placeholder */}
      <Card className="mt-4 overflow-hidden p-0">
        <div className="border-b border-border bg-card p-4">
          <div className="skeleton h-5 w-40" />
        </div>
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="grid grid-cols-[1fr_8rem_8rem_8rem] items-center gap-4 border-b border-border px-4 py-3 last:border-b-0"
          >
            <div className="skeleton h-4 w-48" />
            <div className="skeleton h-6 w-24 rounded-full" />
            <div className="skeleton h-4 w-24 opacity-60" />
            <div className="skeleton h-4 w-24 opacity-60" />
          </div>
        ))}
      </Card>
    </>
  );
}
