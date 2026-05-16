/**
 * Page header — reusable title + subtitle + action-buttons strip.
 *
 * Every dashboard page mounts one of these as its first element. The
 * figma layout puts the page title flush against the top of the content
 * area (no separate top bar between sidebar and content), and this
 * component owns that visual.
 *
 * Usage:
 *
 *   <PageHeader
 *     title="Companies"
 *     subtitle="Manage company profiles and compliance"
 *     actions={
 *       <>
 *         <Button variant="outline">Generate Registration Link</Button>
 *         <Button>Add Company</Button>
 *       </>
 *     }
 *   />
 *
 * Server-Component-compatible (no hooks, no event handlers). Pass any
 * `actions` JSX you like — typically a few `<Button>` elements.
 *
 * @module components/dashboard/page-header
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface PageHeaderProps {
  /** Big heading text — appears as an h1 for SEO + accessibility. */
  title: string;
  /** Optional muted subtitle below the heading. */
  subtitle?: string;
  /**
   * Optional right-aligned action buttons. Rendered as-is so the
   * caller controls exact ordering and styling. Typical content:
   * one or two <Button> elements.
   */
  actions?: ReactNode;
  /** Extra wrapper classes if a page needs more vertical room. */
  className?: string;
}

export function PageHeader({
  title,
  subtitle,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <header
      className={cn(
        "mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-start sm:justify-between",
        className,
      )}
    >
      {/* Left: title + subtitle. min-w-0 prevents long titles from
          forcing the actions off-screen on narrow viewports. */}
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
        )}
      </div>

      {/* Right: actions. Wraps on small screens. */}
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      )}
    </header>
  );
}
