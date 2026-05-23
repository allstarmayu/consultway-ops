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
 * Day-19 sweep: chrome (icon disc + spacing + text hierarchy) now lives
 * inside `<EmptyState>`. This component keeps its own callers + the
 * default copy + the Clock icon, so existing call sites in the audit
 * module don't have to change. The dashboard activity feed picks up
 * the consolidated visual automatically.
 *
 * Server-Component-compatible. No hooks, no state.
 *
 * @module components/audit/activity-feed-empty
 */
import { Clock } from "lucide-react";

import { EmptyState } from "@/components/ui/empty-state";

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
    <EmptyState
      icon={Clock}
      title="No activity yet"
      description={description}
      className={className}
    />
  );
}
