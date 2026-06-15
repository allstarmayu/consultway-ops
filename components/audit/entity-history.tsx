/**
 * Per-entity history section.
 *
 * Renders an audit-log card for a single entity (tender or company),
 * using the same row primitives as the dashboard ActivityFeed widget
 * so the visual language stays consistent across the app.
 *
 * Two variants:
 *
 *   1. Single-entity (company detail page)
 *      Pass `targetType` + `targetId`. Issues ONE `listAuditEvents`
 *      call filtered to that pair, sorted newest-first, capped at 50.
 *
 *   2. Tender + applications (tender detail page)
 *      Pass `targetType: "tender"`, `targetId: <tenderId>`, and
 *      additionally `includeTenderApplications: true`. Issues TWO
 *      calls:
 *        - One for tender-level events (targetType: tender, targetId)
 *        - One for ALL recent tender_application events, post-filtered
 *          to applications belonging to this tender via
 *          `metadata.tenderId`
 *      The two result sets are merged and sorted by `createdAt`
 *      descending in JS, then truncated to the display limit.
 *
 * Trade-off in the tender+applications path:
 *   `listAuditEvents` filters with AND on `targetType` + `targetId` -
 *   there is no `metadata.tenderId =` filter exposed. To fetch only
 *   "applications belonging to THIS tender" cleanly we would need
 *   either (a) a dedicated helper in `lib/audit/log.ts` or (b) a
 *   pre-query for the application ids followed by N filtered calls.
 *   For Phase 1 we take a simpler path: ask for the 200-row cap of
 *   tender_application events and filter in JS. With single-digit-
 *   thousand events expected, this is fine. When audit_log grows
 *   past ~10k rows, swap to a dedicated helper. Comment in the
 *   code marks the spot.
 *
 * Visibility:
 *   - Admin / staff see every event in scope (no filtering applied
 *     beyond targetType/targetId).
 *   - Company-role users get the role-scope inside `listAuditEvents`
 *     automatically. They see tender-level events on tenders they're
 *     viewing (which they have to be authorised to view to reach
 *     this page in the first place), and their own application
 *     events on application-typed rows.
 *
 * @module components/audit/entity-history
 */
import { History } from "lucide-react";

import { listAuditEvents } from "@/lib/audit/log";
import { resolveReferences } from "@/lib/audit/resolve-targets";
import type { AuditLogEntry } from "@/lib/db/schema";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ActivityFeedRow } from "@/components/audit/activity-feed-row";
import { ActivityFeedEmpty } from "@/components/audit/activity-feed-empty";

/** Maximum rows the per-entity history shows. */
const HISTORY_LIMIT = 50;

/**
 * Upper bound on tender_application events fetched for the
 * tender+applications variant. See the trade-off comment in the
 * module header for the rationale.
 *
 * 200 is the hard cap on `listAuditEvents.limit`; at this size the
 * pull-and-filter path is bounded and cheap.
 */
const APPLICATION_EVENT_FETCH_CAP = 200;

// ── Props ───────────────────────────────────────────────────────────────────

export interface EntityHistoryProps {
  /**
   * Which entity type this history is about. Closed union — keep in
   * lockstep with the upstream `AuditTargetType` from `lib/audit/log.ts`
   * for the kinds of entities that have a detail page surface.
   */
  targetType: "company" | "tender" | "project" | "transaction" | "user";

  /** The specific entity id. */
  targetId: string;

  /**
   * When set on a tender history, additionally fetches events for
   * tender_application rows whose `metadata.tenderId === targetId`
   * and merges them into the feed.
   *
   * Ignored for company history.
   */
  includeTenderApplications?: boolean;

  /**
   * Optional subline shown in the empty state. Pass something like
   * "No activity yet on this tender." for stronger context than the
   * generic default.
   */
  emptyDescription?: string;
}

// ── Component ───────────────────────────────────────────────────────────────

export async function EntityHistory({
  targetType,
  targetId,
  includeTenderApplications = false,
  emptyDescription,
}: EntityHistoryProps) {
  // 1. Always fetch direct events on the target entity. This covers
  //    company-only history fully, and the "tender itself" half of
  //    the tender+applications variant.
  const directResult = await listAuditEvents({
    targetType,
    targetId,
    limit: HISTORY_LIMIT,
  });

  if (!directResult.ok) {
    return (
      <HistoryCard>
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t load history</AlertTitle>
          <AlertDescription>{directResult.error}</AlertDescription>
        </Alert>
      </HistoryCard>
    );
  }

  // 2. Tender+applications variant: also fetch application-level
  //    events and filter to those belonging to this tender. See the
  //    module-header trade-off comment.
  let applicationEvents: AuditLogEntry[] = [];

  if (targetType === "tender" && includeTenderApplications) {
    const applicationResult = await listAuditEvents({
      targetType: "tender_application",
      limit: APPLICATION_EVENT_FETCH_CAP,
    });

    if (applicationResult.ok) {
      applicationEvents = applicationResult.rows.filter((row) => {
        // metadata.tenderId is the convention - see lib/audit/log.ts.
        // Defensive on shape: row.metadata is typed Record<string,
        // unknown> but the JSON-mode column can in theory return
        // anything.
        if (!row.metadata || typeof row.metadata !== "object") return false;
        const metaTenderId = (row.metadata as Record<string, unknown>)
          .tenderId;
        return metaTenderId === targetId;
      });
    }
    // A non-ok result here is non-fatal - we still show the tender
    // direct events. Don't surface an error banner for a partial
    // failure on an auxiliary fetch.
  }

  // 3. Merge + sort newest-first. Cheap at this size.
  const allEvents = [...directResult.rows, ...applicationEvents]
    .sort((a, b) => {
      // String compare on ISO/SQLite-form timestamps works correctly
      // for DESC order - both formats sort lexicographically the same
      // way they sort chronologically (year-first). The only quirk
      // is that the SQLite-form (space-separated) sorts the same as
      // the ISO-T-form for the same instant, so mixing them in one
      // sort is safe.
      return b.createdAt.localeCompare(a.createdAt);
    })
    .slice(0, HISTORY_LIMIT);

  // 4. Empty path.
  if (allEvents.length === 0) {
    return (
      <HistoryCard>
        <ActivityFeedEmpty
          description={
            emptyDescription ?? "Activity on this entity will appear here."
          }
        />
      </HistoryCard>
    );
  }

  // 5. Resolve actor + target names. One batched query per entity type
  //    spotted in the merged set.
  const { actors, targets } = await resolveReferences(allEvents);

  return (
    <HistoryCard>
      <ul className="divide-y divide-border">
        {allEvents.map((event) => {
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
    </HistoryCard>
  );
}

// ── Card shell ──────────────────────────────────────────────────────────────

/**
 * Card chrome around the three render states (loaded / empty / error).
 *
 * Matches the dashboard `<FeedCard>` shell visually but lives in its
 * own component so the two surfaces can diverge later (e.g. if we
 * add a "Show older" link to the per-entity variant first).
 */
function HistoryCard({ children }: { children: React.ReactNode }) {
  return (
    <Card className="mt-4 overflow-hidden p-0">
      <div className="flex items-center justify-between border-b border-border bg-card p-4">
        <div className="flex items-center gap-2">
          <History
            className="h-4 w-4 text-muted-foreground"
            aria-hidden
          />
          <h2 className="text-base font-semibold text-foreground">History</h2>
        </div>
      </div>

      <div className="px-4">{children}</div>
    </Card>
  );
}
