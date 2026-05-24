/**
 * Loading state for the companies list.
 *
 * Next.js renders this automatically during the server-render of
 * `page.tsx`. Replaces the page subtree until the data resolves. We
 * mimic the final layout's shape (header strip, filter strip, table
 * skeleton) so the page doesn't jump when content arrives.
 *
 * Uses the Day-26 `.skeleton` shimmer utility for a theme-aware
 * loading aesthetic across all 6 palettes.
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
          <div className="skeleton h-8 w-40" />
          <div className="skeleton h-4 w-72" />
        </div>
        <div className="flex gap-2">
          <div className="skeleton h-9 w-48" />
          <div className="skeleton h-9 w-32" />
        </div>
      </div>

      <Card className="overflow-hidden p-0">
        {/* Filters skeleton — search + 3 selects */}
        <div className="flex flex-wrap items-center gap-3 border-b border-border bg-card p-4">
          <div className="skeleton h-9 w-64" />
          <div className="skeleton h-9 w-44" />
          <div className="skeleton h-9 w-44" />
          <div className="skeleton h-9 w-44" />
        </div>

        {/* Table skeleton — 6 placeholder rows */}
        <div className="divide-y divide-border">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-4 px-4 py-4"
            >
              <div className="skeleton h-4 w-1/4" />
              <div className="skeleton h-4 w-1/6" />
              <div className="skeleton h-4 w-1/6" />
              <div className="skeleton h-4 w-1/6" />
              <div className="skeleton ml-auto h-4 w-24" />
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
