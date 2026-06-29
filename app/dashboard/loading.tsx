/**
 * Loading state for the dashboard home.
 *
 * The home aggregates several cross-platform rollups (company count,
 * project/tender status breakdowns, financial totals, monthly
 * transactions) before it can render. Without this route-level
 * skeleton, navigating to `/dashboard` would block on those queries
 * with no visual feedback — the slow-feeling gap that the list pages
 * already avoid via their own `loading.tsx`. We mimic the home's shape
 * (KPI strip + status-breakdown cards + the wide transaction cards) so
 * the page doesn't jump when data resolves.
 *
 * Uses the Day-26 `.skeleton` shimmer utility for a theme-aware loading
 * aesthetic across all 6 palettes.
 *
 * @module app/dashboard/loading
 */
import { Card } from "@/components/ui/card";

export default function DashboardLoading() {
  return (
    <>
      {/* Header */}
      <div className="mb-6 space-y-2 sm:mb-8">
        <div className="skeleton h-8 w-40" />
        <div className="skeleton h-4 w-72" />
      </div>

      {/* KPI strip — up to 4 stat cards (label + figure + hint + icon) */}
      <section className="mb-6 grid grid-cols-2 gap-4 sm:mb-8 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="space-y-3 p-5">
            <div className="flex items-start justify-between">
              <div className="skeleton h-3 w-24" />
              <div className="skeleton h-8 w-8 rounded-md" />
            </div>
            <div className="skeleton h-8 w-20" />
            <div className="skeleton h-3 w-28" />
          </Card>
        ))}
      </section>

      {/* Status breakdowns — two cards, each a donut + a 5-row legend */}
      <section className="mb-6 grid gap-4 sm:mb-8 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Card key={i} className="space-y-4 p-6">
            <div className="flex items-center justify-between">
              <div className="skeleton h-5 w-40" />
              <div className="skeleton h-4 w-16" />
            </div>
            <div className="flex items-center gap-6">
              <div className="skeleton h-32 w-32 shrink-0 rounded-full" />
              <div className="flex-1 space-y-2.5">
                {Array.from({ length: 5 }).map((_, j) => (
                  <div
                    key={j}
                    className="flex items-center justify-between gap-3"
                  >
                    <div className="skeleton h-4 w-28" />
                    <div className="skeleton h-4 w-8" />
                  </div>
                ))}
              </div>
            </div>
          </Card>
        ))}
      </section>

      {/* Wide transaction cards — trend chart + this-month summary grid */}
      <section className="space-y-4">
        <Card className="space-y-4 p-6">
          <div className="skeleton h-5 w-48" />
          <div className="skeleton h-48 w-full" />
        </Card>
        <Card className="space-y-4 p-6">
          <div className="skeleton h-5 w-48" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="skeleton h-20 w-full" />
            ))}
          </div>
        </Card>
      </section>
    </>
  );
}
