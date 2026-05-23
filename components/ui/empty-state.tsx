/**
 * EmptyState — generic empty-state pane used across the dashboard.
 *
 * Same visual language as `<ActivityFeedEmpty>`: an icon disc on top,
 * a title, an optional description, and an optional action button.
 * Lifts the repeating "table empty / list empty / card empty" pattern
 * into one place so future surfaces can reach for a single primitive.
 *
 * **Intentionally not refactoring existing call sites this session.**
 * Companies, tenders, projects, transactions, and the audit feed all
 * have their own bespoke empty states. Sweeping them onto this primitive
 * is its own cleanup pass — touching five table-empty + one feed-empty
 * in one chunk would inflate the diff and bury the rest of the work.
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
