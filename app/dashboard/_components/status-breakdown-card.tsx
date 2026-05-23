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

export interface StatusBreakdownItem {
  /** Stable React key. Typically the status enum value. */
  key: string;
  /** Pre-rendered badge node (the host owns the visual config). */
  badge: ReactNode;
  /** The row's count figure. */
  count: number;
  /** Where the "drill into this slice" click should land. */
  href: string;
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
}

export function StatusBreakdownCard({
  title,
  icon: Icon,
  items,
  totalLabel,
  className,
}: StatusBreakdownCardProps) {
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

      <ul className="divide-y divide-border">
        {items.map((item) => (
          <li key={item.key}>
            <Link
              href={item.href}
              className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm hover:bg-muted/40"
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
    </Card>
  );
}
