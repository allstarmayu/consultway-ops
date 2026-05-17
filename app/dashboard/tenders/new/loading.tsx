/**
 * New-tender page loading skeleton.
 *
 * Matches the final layout of `page.tsx` so the viewport doesn't jump
 * when the form streams in: page header strip + card with six
 * section-shaped blocks (matching the form sections) and a sticky
 * action bar.
 *
 * Server Component (no hooks, no client JS).
 *
 * @module app/dashboard/tenders/new/loading
 */
import { Card } from "@/components/ui/card";

export default function NewTenderLoading() {
  return (
    <>
      {/* Page header placeholder */}
      <header className="mb-6 flex items-start justify-between gap-4 sm:mb-8">
        <div className="space-y-2">
          <div className="h-8 w-40 animate-pulse rounded-md bg-muted" />
          <div className="h-4 w-72 animate-pulse rounded-md bg-muted" />
        </div>
        <div className="h-10 w-40 animate-pulse rounded-md bg-muted" />
      </header>

      <Card className="overflow-visible p-6 sm:p-8">
        <div className="space-y-8">
          {/* Six section placeholders matching the form's six sections.
              Each section: title bar + 2-column grid of input
              placeholders. */}
          {Array.from({ length: 6 }).map((_, sectionIdx) => (
            <section
              key={sectionIdx}
              className="border-t border-border pt-6 first:border-t-0 first:pt-0"
            >
              <div className="mb-4 space-y-2">
                <div className="h-5 w-32 animate-pulse rounded bg-muted" />
                <div className="h-3 w-64 animate-pulse rounded bg-muted/60" />
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {Array.from({ length: 2 }).map((__, inputIdx) => (
                  <div key={inputIdx} className="space-y-1.5">
                    <div className="h-4 w-24 animate-pulse rounded bg-muted" />
                    <div className="h-10 w-full animate-pulse rounded-md bg-muted" />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </Card>

      {/* Sticky action bar placeholder pinned to viewport bottom */}
      <div className="sticky bottom-0 left-0 right-0 z-30 -mx-6 mt-8 border-t border-border bg-card lg:-mx-10">
        <div className="flex items-center justify-end gap-2 px-6 py-4 lg:px-10">
          <div className="h-10 w-24 animate-pulse rounded-md bg-muted" />
          <div className="h-10 w-32 animate-pulse rounded-md bg-muted" />
        </div>
      </div>
    </>
  );
}
