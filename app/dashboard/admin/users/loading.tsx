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

        <div className="divide-y divide-border">
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
      </Card>
    </>
  );
}
