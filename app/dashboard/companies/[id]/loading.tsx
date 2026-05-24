/**
 * Loading state for the company detail page.
 *
 * Renders a skeleton that approximates the final layout (header strip
 * with title + action buttons, a card with several stacked sections of
 * label-value pairs) so the page doesn't jump when content arrives.
 *
 * Uses the Day-26 `.skeleton` shimmer utility for theme-aware loading.
 *
 * @module app/dashboard/companies/[id]/loading
 */
import { Card } from "@/components/ui/card";

export default function CompanyDetailLoading() {
  return (
    <>
      {/* Header skeleton — title, subtitle/badge, and action buttons */}
      <div className="mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <div className="skeleton h-8 w-72" />
          <div className="flex items-center gap-2">
            <div className="skeleton h-5 w-24 rounded-full" />
            <div className="skeleton h-5 w-16 rounded-full" />
          </div>
        </div>
        <div className="flex gap-2">
          <div className="skeleton h-9 w-36" />
          <div className="skeleton h-9 w-24" />
          <div className="skeleton h-9 w-24" />
        </div>
      </div>

      {/* Content card skeleton — 6 sections, 2-col label/value rows */}
      <Card className="overflow-hidden p-0">
        <div className="divide-y divide-border">
          {Array.from({ length: 6 }).map((_, section) => (
            <div key={section} className="px-6 py-5 sm:px-8">
              <div className="skeleton mb-4 h-5 w-32" />
              <div className="grid grid-cols-1 gap-x-6 gap-y-3 md:grid-cols-2">
                {Array.from({ length: 3 }).map((_, field) => (
                  <div key={field} className="flex items-start gap-4">
                    <div className="skeleton h-4 w-24 shrink-0" />
                    <div className="skeleton h-4 flex-1" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
