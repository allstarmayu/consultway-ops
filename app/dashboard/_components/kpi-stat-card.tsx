/**
 * KpiStatCard — single-figure card used in the dashboard's KPI strip.
 *
 * Server-Component-compatible. Pure presentation: takes a label, a value
 * (already formatted by the caller), and an icon. Optional `hint` for a
 * one-line subline under the value (e.g. "as of today") and `accent`
 * for a one-off tone bump when the figure benefits from emphasis.
 *
 * Why a thin primitive instead of inlining the markup in `page.tsx`:
 * four-plus KPI tiles share identical geometry, and the values are
 * pre-formatted (rupees vs counts vs dates) so the primitive doesn't
 * own formatting either. Lifting the chrome keeps `page.tsx` legible.
 *
 * @module app/dashboard/_components/kpi-stat-card
 */
import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface KpiStatCardProps {
  /** Short noun phrase shown above the figure. */
  label: string;
  /**
   * The figure itself. Pre-formatted by the caller — counts as plain
   * integers, rupees via `formatRupeesFromPaise`, etc.
   */
  value: string;
  /** Optional second line under the figure (e.g. month-window context). */
  hint?: string;
  /** Lucide icon shown in the top-right corner. */
  icon: LucideIcon;
  /**
   * Optional accent tone for the icon disc. Defaults to muted; "primary"
   * pulls the warm-ambient terracotta when the figure is the headline.
   */
  accent?: "muted" | "primary" | "accent";
}

const ACCENT_CLASSES: Record<NonNullable<KpiStatCardProps["accent"]>, string> = {
  muted: "bg-muted text-muted-foreground",
  primary: "bg-primary/10 text-primary",
  accent: "bg-accent/15 text-accent",
};

export function KpiStatCard({
  label,
  value,
  hint,
  icon: Icon,
  accent = "muted",
}: KpiStatCardProps) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </p>
          <p className="font-mono text-2xl font-semibold tabular-nums text-foreground">
            {value}
          </p>
          {hint && (
            <p className="truncate text-xs text-muted-foreground">{hint}</p>
          )}
        </div>
        <div
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
            ACCENT_CLASSES[accent],
          )}
          aria-hidden
        >
          <Icon className="h-4 w-4" />
        </div>
      </div>
    </Card>
  );
}
