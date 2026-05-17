/**
 * Tenders list loading skeleton.
 *
 * Matches the final layout of `page.tsx` so the viewport doesn't jump
 * when content streams in. Three zones:
 *   - Page header strip (title + subtitle placeholder)
 *   - Filters bar (search + four select-shaped boxes)
 *   - Table rows (6 placeholder rows — matches a typical first-page count)
 *
 * Server Component (no hooks, no client JS). All the "shimmer" effect
 * is pure Tailwind `animate-pulse` on muted backgrounds — no extra deps.
 *
 * @module app/dashboard/tenders/loading
 */
import { Card } from "@/components/ui/card";

export default function TendersLoading() {
  return (
    <>
      {/* Page header placeholder. The real header is taller than this
          because of the action button — close enough that the layout
          shift is imperceptible. */}
      <header className="mb-6 flex items-start justify-between gap-4 sm:mb-8">
        <div className="space-y-2">
          <div className="h-8 w-40 animate-pulse rounded-md bg-muted" />
          <div className="h-4 w-72 animate-pulse rounded-md bg-muted" />
        </div>
        <div className="h-10 w-32 animate-pulse rounded-md bg-muted" />
      </header>

      <Card className="overflow-hidden p-0">
        {/* Filters bar placeholder — search box + four selects */}
        <div className="flex flex-wrap items-center gap-3 border-b border-border bg-card p-4">
          <div className="h-10 w-64 animate-pulse rounded-md bg-muted" />
          <div className="h-10 w-48 animate-pulse rounded-md bg-muted" />
          <div className="h-10 w-48 animate-pulse rounded-md bg-muted" />
          <div className="h-10 w-48 animate-pulse rounded-md bg-muted" />
          <div className="h-10 w-48 animate-pulse rounded-md bg-muted" />
        </div>

        {/* Table header placeholder */}
        <div className="grid grid-cols-[1fr_8rem_8rem_8rem_10rem_8rem] gap-4 border-b border-border bg-muted/50 px-4 py-3 text-xs">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-3 w-24 animate-pulse rounded bg-muted-foreground/20"
            />
          ))}
        </div>

        {/* Six placeholder rows */}
        <div className="divide-y divide-border">
          {Array.from({ length: 6 }).map((_, rowIdx) => (
            <div
              key={rowIdx}
              className="grid grid-cols-[1fr_8rem_8rem_8rem_10rem_8rem] items-start gap-4 px-4 py-4"
            >
              {/* Title cell — icon + title + sub */}
              <div className="flex items-start gap-2">
                <div className="h-8 w-8 shrink-0 animate-pulse rounded-md bg-muted" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-1/3 animate-pulse rounded bg-muted/60" />
                </div>
              </div>

              <div className="h-6 w-24 animate-pulse rounded-full bg-muted" />
              <div className="h-4 w-20 animate-pulse rounded bg-muted" />
              <div className="h-4 w-20 animate-pulse rounded bg-muted" />
              <div className="space-y-1">
                <div className="h-4 w-24 animate-pulse rounded bg-muted" />
                <div className="h-3 w-20 animate-pulse rounded bg-muted/60" />
              </div>
              <div className="ml-auto flex gap-1">
                <div className="h-8 w-8 animate-pulse rounded bg-muted" />
                <div className="h-8 w-8 animate-pulse rounded bg-muted" />
              </div>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
