/**
 * Skeleton fallback for the dashboard ActivityFeed.
 *
 * Renders inside the page's `<Suspense>` boundary while the feed's
 * server-side fetch resolves. Matches the populated card's geometry
 * (header strip + row shape) so the viewport doesn't jump when the
 * real content arrives.
 *
 * Five skeleton rows by default - enough to fill the visible area at
 * common viewport heights without being so tall it dwarfs the
 * eventual content.
 *
 * @module app/dashboard/_components/activity-feed-loading
 */
import { History } from "lucide-react";

import { Card } from "@/components/ui/card";

export function ActivityFeedLoading() {
  return (
    <Card className="overflow-hidden p-0">
      {/* Header - real text, since it's static and renders before the
          fetch resolves anyway. Keeps the loading state looking
          purposeful instead of "everything is grey rectangles". */}
      <div className="flex items-center justify-between border-b border-border bg-card p-4">
        <div className="flex items-center gap-2">
          <History
            className="h-4 w-4 text-muted-foreground"
            aria-hidden
          />
          <h2 className="text-base font-semibold text-foreground">
            Recent activity
          </h2>
        </div>
      </div>

      <ul className="divide-y divide-border px-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <li key={i} className="flex items-start gap-3 py-3">
            <div className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-muted" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
              <div className="h-3 w-24 animate-pulse rounded bg-muted" />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
