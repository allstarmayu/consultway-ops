/**
 * EmptyState — generic empty-state pane used across the dashboard.
 *
 * Same visual language as the original `<ActivityFeedEmpty>`: an icon
 * disc on top, a title, an optional description, and an optional action
 * button. The single primitive that the table-empty pane on every list
 * page (companies / tenders / projects / transactions) and the audit
 * feed reach for — landed in Day 18, swept onto the existing call
 * sites in Day 19.
 *
 * Server-Component-compatible. No hooks, no state.
 *
 * @module components/ui/empty-state
 */
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  /** Lucide icon shown in the top disc. */
  icon: LucideIcon;
  /** Short headline ("No matching projects"). */
  title: string;
  /** Optional sub-line giving the user a next step or context. */
  description?: string;
  /**
   * Optional action node — typically a `<Button>` wrapped in a `<Link>`.
   * Rendered below the description so the call-to-action sits at the
   * natural read-flow end.
   */
  action?: ReactNode;
  /** Extra wrapper classes for the host card. */
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 py-10 text-center",
        className,
      )}
    >
      <div
        className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground"
        aria-hidden
      >
        <Icon className="h-5 w-5" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description && (
          <p className="max-w-xs text-xs text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
