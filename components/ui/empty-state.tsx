/**
 * EmptyState — generic empty-state pane used across the dashboard.
 *
 * Day 26 polish: the icon disc grew (h-12 → h-14), picked up an accent-
 * tinted background + ring (theme-aware via `color-mix`), and the
 * primitive now animates in via the existing `.animate-fade-up`
 * utility so an empty table doesn't pop into existence as a static
 * block. Typography tightened too — title bumps from text-sm to
 * text-base for a more deliberate "nothing here yet" feel, and the
 * description widens slightly so longer next-step copy doesn't crowd.
 *
 * Same visual language as the original — an icon disc on top, a title,
 * an optional description, and an optional action button. The single
 * primitive every list page (companies / tenders / projects /
 * transactions) and the audit feed reach for.
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
        "animate-fade-up flex flex-col items-center justify-center gap-4 py-14 text-center",
        className,
      )}
    >
      {/* Icon disc: tinted accent background + soft accent ring give the
          empty state a branded feel that tracks the active theme
          (terracotta on Warm Ambient, cyan on Ocean Depth, etc.) rather
          than the flat neutral grey it had before. The ring uses
          `color-mix` so the tint stays subtle — strong enough to read
          as "this is the brand", soft enough to not compete with the
          title. */}
      <div
        className="flex h-14 w-14 items-center justify-center rounded-full"
        style={{
          backgroundColor: "color-mix(in oklab, var(--accent) 10%, transparent)",
          boxShadow: "inset 0 0 0 1px color-mix(in oklab, var(--accent) 18%, transparent)",
          color: "var(--accent)",
        }}
        aria-hidden
      >
        <Icon className="h-6 w-6" />
      </div>
      <div className="space-y-1.5">
        <p className="text-base font-semibold text-foreground">{title}</p>
        {description && (
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
