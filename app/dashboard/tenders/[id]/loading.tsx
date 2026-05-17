/**
 * Tender detail loading skeleton.
 *
 * Matches the final layout of `page.tsx`:
 *   - Header strip (title + status badge + action buttons)
 *   - Two-column grid: Identity / Categorisation+Eligibility / Dates / Notes
 *   - Applications table section below
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
          <div className="h-8 w-72 animate-pulse rounded-md bg-muted" />
          <div className="flex items-center gap-2">
            <div className="h-5 w-20 animate-pulse rounded-full bg-muted" />
            <div className="h-4 w-32 animate-pulse rounded bg-muted/60" />
          </div>
        </div>
        <div className="flex gap-2">
          <div className="h-10 w-24 animate-pulse rounded-md bg-muted" />
          <div className="h-10 w-24 animate-pulse rounded-md bg-muted" />
        </div>
      </header>

      {/* Body — four cards in a 2-column grid */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="space-y-4 p-6">
            <div className="space-y-1.5">
              <div className="h-5 w-32 animate-pulse rounded bg-muted" />
              <div className="h-3 w-48 animate-pulse rounded bg-muted/60" />
            </div>
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((__, j) => (
                <div key={j} className="space-y-1">
                  <div className="h-3 w-24 animate-pulse rounded bg-muted/60" />
                  <div className="h-4 w-full animate-pulse rounded bg-muted" />
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>

      {/* Applications section placeholder */}
      <Card className="mt-4 overflow-hidden p-0">
        <div className="border-b border-border bg-card p-4">
          <div className="h-5 w-40 animate-pulse rounded bg-muted" />
        </div>
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="grid grid-cols-[1fr_8rem_8rem_8rem] items-center gap-4 border-b border-border px-4 py-3 last:border-b-0"
          >
            <div className="h-4 w-48 animate-pulse rounded bg-muted" />
            <div className="h-6 w-24 animate-pulse rounded-full bg-muted" />
            <div className="h-4 w-24 animate-pulse rounded bg-muted/60" />
            <div className="h-4 w-24 animate-pulse rounded bg-muted/60" />
          </div>
        ))}
      </Card>
    </>
  );
}
