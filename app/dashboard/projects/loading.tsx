/**
 * Projects list loading skeleton.
 *
 * Mirrors `app/dashboard/tenders/loading.tsx` adapted to the projects
 * table's 7-column shape. Three zones:
 *   - Page header strip (title + subtitle + action button placeholder)
 *   - Filters bar (search + selects)
 *   - Table rows
 *
 * Uses the Day-26 `.skeleton` shimmer utility (defined in
 * `app/globals.css`) rather than the older `animate-pulse bg-muted`
 * pattern — gives the loading state a more modern aesthetic and stays
 * theme-aware across all 6 palettes.
 *
 * Server Component. No hooks, no client JS, no extra deps.
 *
 * @module app/dashboard/projects/loading
 */
import { Card } from "@/components/ui/card";

export default function ProjectsLoading() {
  return (
    <>
      <header className="mb-6 flex items-start justify-between gap-4 sm:mb-8">
        <div className="space-y-2">
          <div className="skeleton h-8 w-40" />
          <div className="skeleton h-4 w-72" />
        </div>
        <div className="skeleton h-10 w-32" />
      </header>

      <Card className="overflow-hidden p-0">
        {/* Filters bar placeholder — search + status + company selects */}
        <div className="flex flex-wrap items-center gap-3 border-b border-border bg-card p-4">
          <div className="skeleton h-10 w-64" />
          <div className="skeleton h-10 w-48" />
          <div className="skeleton h-10 w-48" />
        </div>

        {/* Table header — 7 columns matching projects-table.tsx */}
        <div className="grid grid-cols-[1fr_10rem_8rem_7rem_7rem_8rem_4rem] gap-4 border-b border-border bg-muted/50 px-4 py-3 text-xs">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="skeleton h-3 w-24" />
          ))}
        </div>

        {/* Six placeholder rows */}
        <div className="divide-y divide-border">
          {Array.from({ length: 6 }).map((_, rowIdx) => (
            <div
              key={rowIdx}
              className="grid grid-cols-[1fr_10rem_8rem_7rem_7rem_8rem_4rem] items-start gap-4 px-4 py-4"
            >
              {/* Project cell — icon + name + sub */}
              <div className="flex items-start gap-2">
                <div className="skeleton h-8 w-8 shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <div className="skeleton h-4 w-3/4" />
                  <div className="skeleton h-3 w-1/3 opacity-60" />
                </div>
              </div>

              <div className="skeleton h-4 w-28" />
              <div className="skeleton h-6 w-24 rounded-full" />
              <div className="skeleton h-4 w-20" />
              <div className="skeleton h-4 w-20" />
              <div className="skeleton h-4 w-24" />
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
