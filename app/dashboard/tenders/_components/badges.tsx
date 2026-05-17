/**
 * Tiny presentational badges reused across the tenders module.
 *
 *   - <TenderStatusBadge status="published" />     — colored pill for the
 *     "Status" column / detail-page header. One bg+text style per
 *     `TenderStatus` value, palette-consistent with the Warm Ambient
 *     theme.
 *   - <EligibilityChip label="..." />              — small monochrome
 *     chip for "MSME only", "Sector: Roads", etc. Used on the table
 *     row's secondary line and on the detail page's eligibility strip.
 *   - <ApplicationStatusBadge status="..." />      — same shape as
 *     TenderStatusBadge but for `TenderApplicationStatus`. Lives here
 *     to keep all tender-related visuals co-located.
 *
 * Pure presentation — no hooks, no state, no event handlers. Server-
 * Component-compatible. Hot-path on the table render, so kept minimal.
 *
 * @module app/dashboard/tenders/_components/badges
 */
import {
  CheckCircle2,
  Clock,
  FileText,
  Lock,
  Trophy,
  XCircle,
  UserCheck,
  UserX,
  PauseCircle,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  TenderStatus,
  TenderApplicationStatus,
} from "@/lib/db/schema";

// ── TenderStatusBadge ─────────────────────────────────────────────────────

interface TenderStatusStyle {
  /** Human-readable label shown in the pill. */
  label: string;
  /** Tailwind classes for the pill's bg/text/border. */
  classes: string;
  /** Leading icon. */
  icon: LucideIcon;
}

/**
 * One config object per tender status. Visual language mirrors the
 * compliance-status badges in the companies module — same shape, same
 * sizing — so the dashboard feels uniform across modules.
 *
 *   - draft     — muted (Sand-ish), document icon → "not yet visible"
 *   - published — primary terracotta, check-circle → "live"
 *   - closed    — accent muted, lock → "window shut"
 *   - awarded   — primary darker tone with trophy → "done"
 */
const TENDER_STATUS_STYLES: Record<TenderStatus, TenderStatusStyle> = {
  draft: {
    label: "Draft",
    classes: "bg-muted text-muted-foreground border-border",
    icon: FileText,
  },
  published: {
    label: "Published",
    classes: "bg-primary text-primary-foreground border-transparent",
    icon: CheckCircle2,
  },
  closed: {
    label: "Closed",
    classes: "bg-accent/10 text-accent border-accent/20",
    icon: Lock,
  },
  awarded: {
    // Slightly different tone from "published" so they're distinguishable
    // at a glance in a mixed list. Uses the foreground color directly.
    label: "Awarded",
    classes: "bg-foreground text-background border-transparent",
    icon: Trophy,
  },
};

export interface TenderStatusBadgeProps {
  status: TenderStatus;
  /** Hide the icon for very compact contexts. Default: show. */
  iconless?: boolean;
}

export function TenderStatusBadge({
  status,
  iconless = false,
}: TenderStatusBadgeProps) {
  const style = TENDER_STATUS_STYLES[status];
  const Icon = style.icon;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        style.classes,
      )}
    >
      {!iconless && <Icon className="h-3 w-3" aria-hidden />}
      {style.label}
    </span>
  );
}

// ── EligibilityChip ───────────────────────────────────────────────────────

export interface EligibilityChipProps {
  /** Free-form chip text — e.g. "MSME only", "Sector: Roads & Highways". */
  label: string;
  /**
   * Optional emphasis. `strong` uses primary tones for the most important
   * filter (MSME); `muted` is the default for sector/geography/etc.
   */
  emphasis?: "muted" | "strong";
}

/**
 * Small monochrome chip used to summarise a single eligibility rule.
 * The detail page strips a row's eligibility filters into a list of these.
 * The list page uses them sparingly on the secondary row to surface MSME
 * restrictions without overflowing the column.
 */
export function EligibilityChip({
  label,
  emphasis = "muted",
}: EligibilityChipProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
        emphasis === "strong"
          ? "border-primary/20 bg-primary/10 text-primary"
          : "border-border bg-muted text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}

// ── ApplicationStatusBadge ────────────────────────────────────────────────

interface ApplicationStatusStyle {
  label: string;
  classes: string;
  icon: LucideIcon;
}

/**
 * Per-application status styles. Used on the detail page's applications
 * list and on the company's "my applications" view (a later chunk).
 *
 *   - submitted   — accent-tinted clock, "in progress"
 *   - withdrawn   — muted with pause icon, company-initiated retreat
 *   - shortlisted — primary check-mark, staff approval
 *   - rejected    — destructive tones, staff rejection
 */
const APPLICATION_STATUS_STYLES: Record<
  TenderApplicationStatus,
  ApplicationStatusStyle
> = {
  submitted: {
    label: "Submitted",
    classes: "bg-accent/10 text-accent border-accent/20",
    icon: Clock,
  },
  withdrawn: {
    label: "Withdrawn",
    classes: "bg-muted text-muted-foreground border-border",
    icon: PauseCircle,
  },
  shortlisted: {
    label: "Shortlisted",
    classes: "bg-primary text-primary-foreground border-transparent",
    icon: UserCheck,
  },
  rejected: {
    label: "Rejected",
    classes: "bg-destructive/10 text-destructive border-destructive/20",
    icon: UserX,
  },
};

export interface ApplicationStatusBadgeProps {
  status: TenderApplicationStatus;
}

export function ApplicationStatusBadge({
  status,
}: ApplicationStatusBadgeProps) {
  const style = APPLICATION_STATUS_STYLES[status];
  const Icon = style.icon;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        style.classes,
      )}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {style.label}
    </span>
  );
}

// Re-export the icon set so callers don't have to import lucide directly
// when they want to render a status icon outside a pill (e.g. the empty
// state). Specifically the XCircle reused on the not-found page.
export { XCircle };
