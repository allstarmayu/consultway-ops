/**
 * StatusBreakdownCard — generic "rows of (status, count, badge)" card.
 *
 * Used by the Projects-by-status and Tenders-by-status widgets on the
 * dashboard. Each item carries a render-prop-shaped `badge` so the host
 * can plug in the existing `ProjectStatusBadge` / `TenderStatusBadge`
 * primitives without this card pulling in any domain-specific styles.
 *
 * Each row links to the corresponding filtered list page so a click
 * carries the dashboard viewer straight into the relevant filter.
 *
 * @module app/dashboard/_components/status-breakdown-card
 */
import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, type LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  StatusDonutChart,
  type StatusDonutSlice,
} from "./status-donut-chart";

export interface StatusBreakdownItem {
  /** Stable React key. Typically the status enum value. */
  key: string;
  /** Pre-rendered badge node (the host owns the visual config). */
  badge: ReactNode;
  /** The row's count figure. */
  count: number;
  /** Where the "drill into this slice" click should land. */
  href: string;
  /**
   * Optional CSS color (var or hex) for the donut slice — used only
   * when the host opted into the donut layout via the `donut` prop.
   * Hosts that don't pass `donut={true}` can omit this field.
   */
  color?: string;
  /**
   * Optional human-readable label for the donut tooltip. Falls back to
   * `key` when omitted. Hosts can pass the same string the badge
   * renders so the tooltip + badge stay aligned.
   */
  donutLabel?: string;
}

export interface StatusBreakdownCardProps {
  title: string;
  /** Lucide icon for the header strip. */
  icon: LucideIcon;
  /** Pre-built items in display order. */
  items: StatusBreakdownItem[];
  /** Optional footer-line label, e.g. "12 total". */
  totalLabel?: string;
  /** Optional class extension on the outer card. */
  className?: string;
  /**
   * When true, render a donut chart on the left and the rows-of-counts
   * list on the right (stacks vertically on small screens). Requires
   * every item to carry `color` so each slice has a fill — items
   * missing `color` fall back to the muted token, which is fine for a
   * single-slice donut but loses meaning at scale.
   */
  donut?: boolean;
}

export function StatusBreakdownCard({
  title,
  icon: Icon,
  items,
  totalLabel,
  className,
  donut = false,
}: StatusBreakdownCardProps) {
  const slices: StatusDonutSlice[] = donut
    ? items.map((item) => ({
        key: item.key,
        label: item.donutLabel ?? item.key,
        count: item.count,
        color: item.color ?? "var(--color-muted)",
      }))
    : [];

  return (
    <Card className={cn("overflow-hidden p-0", className)}>
      <header className="flex items-center justify-between border-b border-border bg-card p-4">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
        </div>
        {totalLabel && (
          <span className="text-xs text-muted-foreground">{totalLabel}</span>
        )}
      </header>

      <div
        className={cn(
          // Donut layout: chart on the left, list on the right at sm+.
          // Stacks vertically on small screens.
          donut
            ? "grid grid-cols-1 gap-2 p-4 sm:grid-cols-[180px_minmax(0,1fr)] sm:items-center sm:gap-4"
            : "",
        )}
      >
        {donut && (
          <div className="flex items-center justify-center">
            <StatusDonutChart data={slices} />
          </div>
        )}

        <ul className={cn("divide-y divide-border", donut && "border-t border-border sm:border-t-0")}>
          {items.map((item) => (
            <li key={item.key}>
              <Link
                href={item.href}
                className={cn(
                  "flex items-center justify-between gap-3 text-sm hover:bg-muted/40",
                  donut ? "px-2 py-2" : "px-4 py-2.5",
                )}
              >
                <span className="shrink-0">{item.badge}</span>
                <span className="flex items-center gap-2">
                  <span className="font-mono text-base tabular-nums text-foreground">
                    {item.count}
                  </span>
                  <ArrowRight
                    className="h-3.5 w-3.5 text-muted-foreground"
                    aria-hidden
                  />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
