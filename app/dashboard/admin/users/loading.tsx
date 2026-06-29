/**
 * Loading state for the users list. Mirrors the final layout's shape
 * (header strip, filter strip, table skeleton) so the page doesn't jump
 * when content arrives. Uses the `.skeleton` shimmer utility.
 *
 * @module app/dashboard/admin/users/loading
 */
import { Card } from "@/components/ui/card";

export default function UsersLoading() {
  return (
    <>
      <div className="mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <div className="skeleton h-8 w-32" />
          <div className="skeleton h-4 w-80" />
        </div>
        <div className="flex gap-2">
          <div className="skeleton h-9 w-32" />
        </div>
      </div>

      <Card className="overflow-hidden p-0">
        <div className="flex flex-wrap items-center gap-3 border-b border-border bg-card p-4">
          <div className="skeleton h-9 w-64" />
          <div className="skeleton h-9 w-44" />
          <div className="skeleton h-9 w-44" />
        </div>

        {/* Desktop table skeleton — 6 placeholder rows. Hidden below
            `lg`, where the table is replaced by the mobile card list. */}
        <div className="hidden divide-y divide-border lg:block">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-4">
              <div className="skeleton h-4 w-1/4" />
              <div className="skeleton h-4 w-1/6" />
              <div className="skeleton h-4 w-1/6" />
              <div className="skeleton h-4 w-1/6" />
              <div className="skeleton ml-auto h-4 w-20" />
            </div>
          ))}
        </div>

        {/* Mobile card skeleton (below `lg`) — mirrors the user card:
            icon + name/meta, a view action, and the role/status badge row. */}
        <ul className="divide-y divide-border lg:hidden">
          {Array.from({ length: 6 }).map((_, i) => (
            <li key={i} className="px-4 py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2">
                  <div className="skeleton h-8 w-8 shrink-0" />
                  <div className="space-y-1.5">
                    <div className="skeleton h-4 w-36" />
                    <div className="skeleton h-3 w-44" />
                  </div>
                </div>
                <div className="skeleton h-8 w-8 shrink-0" />
              </div>
              <div className="mt-3 flex gap-2">
                <div className="skeleton h-6 w-20 rounded-full" />
                <div className="skeleton h-6 w-16 rounded-full" />
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
