/**
 * StickyActionBar — bottom-of-viewport submit/cancel strip that follows
 * scroll on long forms.
 *
 * The companies form has 6 sections and ~15 fields. On smaller viewports
 * the user has to scroll meaningfully to reach the submit button at the
 * bottom. A sticky bar keeps Save and Cancel within reach regardless of
 * scroll position, which is especially valuable for fast power-users
 * who want to submit the moment they've filled in the required fields
 * without scrolling all the way down.
 *
 * Layout:
 *   - Fixed to the bottom of the viewport with a top border + shadow
 *   - White background (matches card surfaces in Warm Ambient)
 *   - Content slides under it — pages that use this should add bottom
 *     padding to their main scroll area so nothing's hidden behind
 *
 * Server-Component-compatible (no hooks). All interactivity lives in
 * the `children` (typically a couple of Buttons).
 *
 * Usage:
 *
 *   <StickyActionBar>
 *     <Button variant="outline" type="button" onClick={onCancel}>
 *       Cancel
 *     </Button>
 *     <Button type="submit" disabled={isSubmitting}>
 *       Save company
 *     </Button>
 *   </StickyActionBar>
 *
 * @module components/forms/sticky-action-bar
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// ── Props ───────────────────────────────────────────────────────────────────

export interface StickyActionBarProps {
  /**
   * Optional helper / status text on the left side of the bar.
   * Common uses: "* required field", "Last saved 2 min ago", "Unsaved
   * changes" hint.
   */
  helper?: ReactNode;

  /**
   * Right-aligned action buttons. Typically Cancel + Submit.
   */
  children: ReactNode;

  /** Extra classes for the inner content row. */
  className?: string;
}

// ── Component ───────────────────────────────────────────────────────────────

export function StickyActionBar({
  helper,
  children,
  className,
}: StickyActionBarProps) {
  return (
    <div
      className={cn(
        // Fixed to viewport bottom. `inset-x-0` makes it span the full
        // viewport width, ignoring the sidebar — that's intentional so
        // the bar feels grounded to the screen, not the content area.
        // The sidebar's own z-index keeps it on top of the bar so they
        // don't visually fight.
        "sticky bottom-0 left-0 right-0 z-30 -mx-6 mt-8 lg:-mx-10",
        // Surface treatment — white bg, top border, subtle shadow rising
        // upward from the bar so the form content above visibly tucks
        // behind it on scroll.
        "border-t border-border bg-card",
        "shadow-[0_-4px_6px_-4px_rgba(0,0,0,0.05)]",
      )}
    >
      <div
        className={cn(
          "flex flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center sm:justify-between lg:px-10",
          className,
        )}
      >
        {/* Left side — helper / status. Hidden on mobile so the actions
            get the whole row, prevents wrapping that crams the buttons. */}
        <div className="hidden text-sm text-muted-foreground sm:block">
          {helper}
        </div>

        {/* Right side — buttons. `flex-wrap` keeps narrow viewports
            graceful; `gap-2` matches the rest of the design system. */}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {children}
        </div>
      </div>
    </div>
  );
}
