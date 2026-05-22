/**
 * Empty state for activity feeds.
 *
 * Shared across the dashboard widget (Chunk 2) and the per-entity
 * History sections (Chunk 3), so the visual language is consistent
 * regardless of where the feed appears.
 *
 * Two contexts where this renders:
 *   1. Dashboard - "no platform activity yet" (rare, only on a fresh
 *      install)
 *   2. Per-entity history - "no activity yet on this entity"
 *      (common for freshly-created entities)
 *
 * The `description` prop lets each call site tailor the copy without
 * needing a parallel component. Falls back to a generic phrase when
 * not supplied.
 *
 * Server-Component-compatible. No hooks, no state.
 *
 * @module components/audit/activity-feed-empty
 */
import { Clock } from "lucide-react";

import { cn } from "@/lib/utils";

export interface ActivityFeedEmptyProps {
  /**
   * Optional context-specific subline. Defaults to a generic phrase
   * suitable for any feed.
   */
  description?: string;
  /** Extra wrapper classes if the host card needs custom spacing. */
  className?: string;
}

export function ActivityFeedEmpty({
  description = "Activity will appear here as changes are made.",
  className,
}: ActivityFeedEmptyProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 py-10 text-center",
        className,
      )}
    >
      {/* Match the icon-disc geometry of feed rows so empty and populated
          states feel like the same component family. Muted tone here -
          there's nothing to draw the eye toward. */}
      <div
        className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground"
        aria-hidden
      >
        <Clock className="h-5 w-5" />
      </div>

      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">No activity yet</p>
        <p className="max-w-xs text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}
