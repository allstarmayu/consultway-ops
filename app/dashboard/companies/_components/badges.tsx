/**
 * Tiny presentational badges reused across the companies module.
 *
 *   - <ComplianceBadge status="compliant" /> — colored pill for the
 *     "Compliance" column. Maps each status to a palette-consistent
 *     bg + text combo.
 *   - <JvBadge /> — short "JV" pill that appears under a company name
 *     when `is_jv = true`. No props, always the same look.
 *
 * Pure presentation — no hooks, no state, no event handlers. Server-
 * Component-compatible. Hot-path on the table render, so kept minimal.
 *
 * @module app/dashboard/companies/_components/badges
 */
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ComplianceStatus } from "@/lib/db/schema";

// ── ComplianceBadge ─────────────────────────────────────────────────────────

interface ComplianceBadgeStyle {
  /** Human-readable label shown in the pill. */
  label: string;
  /** Tailwind classes for the pill's bg/text/border. */
  classes: string;
  /** Leading icon. */
  icon: LucideIcon;
}

/**
 * One config object per compliance status. Keeping styles co-located
 * with the status mapping means a new status only needs editing here
 * (plus the Zod schema + DB type, but those are deliberately broader).
 */
const COMPLIANCE_STYLES: Record<ComplianceStatus, ComplianceBadgeStyle> = {
  compliant: {
    label: "Compliant",
    classes: "bg-primary text-primary-foreground border-transparent",
    icon: CheckCircle2,
  },
  pending: {
    label: "Pending",
    classes: "bg-accent/10 text-accent border-accent/20",
    icon: Clock,
  },
  non_compliant: {
    label: "Non-compliant",
    classes: "bg-destructive/10 text-destructive border-destructive/20",
    icon: XCircle,
  },
  expired: {
    label: "Expired",
    classes: "bg-muted text-muted-foreground border-border",
    icon: AlertCircle,
  },
};

export interface ComplianceBadgeProps {
  status: ComplianceStatus;
}

export function ComplianceBadge({ status }: ComplianceBadgeProps) {
  const style = COMPLIANCE_STYLES[status];
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

// ── JvBadge ─────────────────────────────────────────────────────────────────

/**
 * "JV" pill shown next to a JV company's name. Uses Blush tint bg with
 * Terracotta text per the palette PDF's "tag pills" guidance.
 */
export function JvBadge() {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent",
      )}
      aria-label="Joint venture"
      title="Joint venture"
    >
      JV
    </span>
  );
}

// ── BooleanBadge ────────────────────────────────────────────────────────────

/**
 * Generic Yes/No pill used in the MSME column. Yes = Espresso pill,
 * No = muted outline. Kept tiny since it's purely decorative.
 */
export interface BooleanBadgeProps {
  value: boolean;
  yesLabel?: string;
  noLabel?: string;
}

export function BooleanBadge({
  value,
  yesLabel = "Yes",
  noLabel = "No",
}: BooleanBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex min-w-[2.5rem] items-center justify-center rounded-full px-2 py-0.5 text-xs font-medium",
        value
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-muted-foreground",
      )}
    >
      {value ? yesLabel : noLabel}
    </span>
  );
}
