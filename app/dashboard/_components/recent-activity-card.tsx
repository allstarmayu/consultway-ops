/**
 * RecentActivityCard — dashboard's activity feed widget.
 *
 * Server Component. Calls `getRecentActivityForViewer` (the role-aware
 * wrapper around `listAuditEvents`) and renders the result as a card
 * containing a column of `<ActivityFeedRow />` items.
 *
 * Visibility is handled inside `listAuditEvents` — admin/staff see
 * platform-wide events; company-role users see their own actions plus
 * their applications' events. The card title is intentionally generic
 * ("Recent activity") so it reads correctly for either audience.
 *
 * Three render states:
 *   1. Error  — surface the message; the rest of the dashboard keeps
 *               working.
 *   2. Empty  — friendly "No recent activity" pane.
 *   3. Loaded — `<ul>` of resolved rows.
 *
 * @module app/dashboard/_components/recent-activity-card
 */
import { History } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ActivityFeedRow } from "@/components/audit/activity-feed-row";
import { ActivityFeedEmpty } from "@/components/audit/activity-feed-empty";
import { getRecentActivityForViewer } from "@/lib/dashboard/aggregates";
import { resolveReferences } from "@/lib/audit/resolve-targets";

export interface RecentActivityCardProps {
  /**
   * How many rows to render. The wrapper defaults to 10, which suits
   * the dashboard's per-card density better than the 20 the legacy
   * widget used.
   */
  limit?: number;
}

export async function RecentActivityCard({
  limit = 10,
}: RecentActivityCardProps) {
  const result = await getRecentActivityForViewer(limit);

  if (!result.ok) {
    return (
      <FeedCard>
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t load activity</AlertTitle>
          <AlertDescription>{result.error}</AlertDescription>
        </Alert>
      </FeedCard>
    );
  }

  if (result.rows.length === 0) {
    return (
      <FeedCard>
        <ActivityFeedEmpty description="No recent activity to show." />
      </FeedCard>
    );
  }

  const { actors, targets } = await resolveReferences(result.rows);

  return (
    <FeedCard>
      <ul className="divide-y divide-border">
        {result.rows.map((event) => {
          const resolved = targets.get(event.id);
          const actorLabel = actors.get(event.actorId) ?? event.actorId;
          return (
            <ActivityFeedRow
              key={event.id}
              event={event}
              actorLabel={actorLabel}
              targetLabel={resolved?.label ?? null}
              targetHref={resolved?.href ?? null}
            />
          );
        })}
      </ul>
    </FeedCard>
  );
}

// ── Card shell ─────────────────────────────────────────────────────────────

function FeedCard({ children }: { children: React.ReactNode }) {
  return (
    <Card className="overflow-hidden p-0">
      <header className="flex items-center justify-between border-b border-border bg-card p-4">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-muted-foreground" aria-hidden />
          <h2 className="text-base font-semibold text-foreground">
            Recent activity
          </h2>
        </div>
      </header>
      <div className="px-4">{children}</div>
    </Card>
  );
}
