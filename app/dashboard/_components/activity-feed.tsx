/**
 * Dashboard activity feed widget.
 *
 * First UI consumer of the `listAuditEvents` read API (shipped Day 6).
 * Shows the most recent 20 audit events with iconography per verb,
 * role-scoped visibility (admin/staff see everything; company users
 * see their own actions + their applications' events - scope handled
 * inside `listAuditEvents`).
 *
 * Server Component - fetches inline. Reads land on the `lib/audit`
 * read API and on the `lib/audit/resolve-targets` helper which
 * batches id-to-name lookups.
 *
 * Three render states:
 *   1. Error  - `listAuditEvents` returned `{ ok: false }`. Surface
 *               the message in an Alert; the rest of the dashboard
 *               keeps working.
 *   2. Empty  - the query succeeded but returned zero rows. Common on
 *               fresh installs. Render the shared empty state.
 *   3. Loaded - render a `<ul>` of `<ActivityFeedRow />`.
 *
 * Pagination is intentionally not exposed on this widget. The
 * dashboard surfaces "recent" activity; deeper investigation belongs
 * on the per-entity history sections (Chunk 3) or on a future
 * `/dashboard/audit` page.
 *
 * @module app/dashboard/_components/activity-feed
 */
import { History } from "lucide-react";

import { listAuditEvents } from "@/lib/audit/log";
import { resolveReferences } from "@/lib/audit/resolve-targets";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ActivityFeedRow } from "@/components/audit/activity-feed-row";
import { ActivityFeedEmpty } from "@/components/audit/activity-feed-empty";

/**
 * Number of events shown on the dashboard widget.
 *
 * 20 fits "the last screen of activity" - large enough to see the day's
 * meaningful changes without overwhelming the dashboard. Per the Day-7
 * scope, no "show older" affordance ships in this chunk. Capacity is
 * trivial to lift later.
 */
const FEED_LIMIT = 20;

export async function ActivityFeed() {
  // 1. Fetch the most-recent N events. `listAuditEvents` handles its
  //    own auth check + role-scoped visibility - we don't pre-filter.
  const result = await listAuditEvents({ limit: FEED_LIMIT });

  // 2. Hard-failure path. Most common cause is "user signed out
  //    between proxy gate and Server Component render" - rare in
  //    practice, but we don't want the whole dashboard to crash on it.
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

  // 3. Empty path. Fresh install, brand-new company user with no own
  //    activity yet, or just no events in the visibility scope.
  if (result.rows.length === 0) {
    return (
      <FeedCard>
        <ActivityFeedEmpty description="As mutations are made across the platform, they'll appear here." />
      </FeedCard>
    );
  }

  // 4. Resolve actor ids -> emails and target ids -> display names.
  //    One batched query per entity type, regardless of feed size.
  const { actors, targets } = await resolveReferences(result.rows);

  // 5. Populated render. divide-y on the list gives subtle separation
  //    between rows without adding noise to the card.
  return (
    <FeedCard>
      <ul className="divide-y divide-border">
        {result.rows.map((event) => {
          const resolved = targets.get(event.id);
          // `actors` is populated for every distinct actor id in the
          // input set (see resolveReferences) so the ?? fallback is
          // defensive - shouldn't trigger in normal use.
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

// ── Card shell ──────────────────────────────────────────────────────────────

/**
 * Shared card chrome around any of the three render states. Extracted
 * so the header strip and padding stay consistent regardless of which
 * branch the component takes.
 *
 * Header copy is intentionally generic - "Recent activity" covers both
 * platform-wide (admin/staff) and own-slice (company) variants without
 * needing role-aware wording. The role-scope decision happens inside
 * `listAuditEvents`, not at the presentation layer.
 */
function FeedCard({ children }: { children: React.ReactNode }) {
  return (
    <Card className="overflow-hidden p-0">
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
        {/* Right-side slot reserved for a future "View all" link to a
            /dashboard/audit page - deferred per Day-7 scope. Leaving
            the flex container in place so adding the link later is a
            single-line change with no layout reflow. */}
      </div>

      <div className="px-4">{children}</div>
    </Card>
  );
}
