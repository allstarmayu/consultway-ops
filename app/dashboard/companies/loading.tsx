/**
 * Loading state for the companies list.
 *
 * Next.js renders this automatically during the server-render of
 * `page.tsx`. Replaces the page subtree until the data resolves. We
 * mimic the final layout's shape (header strip, filter strip, table
 * skeleton) so the page doesn't jump when content arrives.
 *
 * Pure visual placeholder — no client logic, no animations beyond
 * Tailwind's `animate-pulse` on muted rectangles.
 *
 * @module app/dashboard/companies/loading
 */
import { Card } from "@/components/ui/card";

export default function CompaniesLoading() {
  return (
    <>
      {/* Header skeleton */}
      <div className="mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <div className="h-8 w-40 animate-pulse rounded-md bg-muted" />
          <div className="h-4 w-72 animate-pulse rounded-md bg-muted" />
        </div>
        <div className="flex gap-2">
          <div className="h-9 w-48 animate-pulse rounded-md bg-muted" />
          <div className="h-9 w-32 animate-pulse rounded-md bg-muted" />
        </div>
      </div>

      <Card className="overflow-hidden p-0">
        {/* Filters skeleton — search + 3 selects */}
        <div className="flex flex-wrap items-center gap-3 border-b border-border bg-card p-4">
          <div className="h-9 w-64 animate-pulse rounded-md bg-muted" />
          <div className="h-9 w-44 animate-pulse rounded-md bg-muted" />
          <div className="h-9 w-44 animate-pulse rounded-md bg-muted" />
          <div className="h-9 w-44 animate-pulse rounded-md bg-muted" />
        </div>

        {/* Table skeleton — 6 placeholder rows */}
        <div className="divide-y divide-border">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-4 px-4 py-4"
            >
              <div className="h-4 w-1/4 animate-pulse rounded bg-muted" />
              <div className="h-4 w-1/6 animate-pulse rounded bg-muted" />
              <div className="h-4 w-1/6 animate-pulse rounded bg-muted" />
              <div className="h-4 w-1/6 animate-pulse rounded bg-muted" />
              <div className="ml-auto h-4 w-24 animate-pulse rounded bg-muted" />
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
