/**
 * Reusable donut chart for status distributions.
 *
 * Rewritten on top of the shadcn chart primitives (Day 25). Each
 * slice's colour is supplied by the host via the `color` field on
 * the slice object; the component builds a per-render `ChartConfig`
 * out of that so the tooltip + injected CSS vars stay aligned.
 *
 * Self-explanatory legend chips render below the donut so the
 * chart reads without hovering — a Phase-1 dashboard's most
 * important property is "at a glance".
 *
 * Empty state: when every slice is zero, the chart returns null
 * (the host's row list carries the zero data alone).
 *
 * @module app/dashboard/_components/status-donut-chart
 */
"use client";

import { Cell, Pie, PieChart } from "recharts";

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { cn } from "@/lib/utils";

// ── Props ─────────────────────────────────────────────────────────────────

export interface StatusDonutSlice {
  /** Stable React key — typically the status enum value. */
  key: string;
  /** Human-readable label shown in the tooltip + legend. */
  label: string;
  /** Slice count. Zero-value slices are filtered out before render. */
  count: number;
  /** CSS color (var or hex). Drives the slice fill + the legend chip. */
  color: string;
}

export interface StatusDonutChartProps {
  data: ReadonlyArray<StatusDonutSlice>;
  /**
   * Outer chart height in px. Default 160 — fits the side-by-side
   * card layout next to the rows-of-counts list.
   */
  height?: number;
  /** Hide the chip-row legend below the donut. */
  hideLegend?: boolean;
  className?: string;
}

// ── Component ────────────────────────────────────────────────────────────

export function StatusDonutChart({
  data,
  height = 160,
  hideLegend = false,
  className,
}: StatusDonutChartProps) {
  // Filter zero-value slices so the donut + legend don't carry empty
  // categories.
  const slices = data.filter((s) => s.count > 0);
  if (slices.length === 0) return null;

  const total = slices.reduce((acc, s) => acc + s.count, 0);

  // Build the shadcn ChartConfig from the host's slice array. Each
  // slice becomes one config entry; the chart container injects a
  // CSS variable per entry (var(--color-${key})) that we then
  // reference from each <Cell />.
  const config: ChartConfig = Object.fromEntries(
    slices.map((s) => [s.key, { label: s.label, color: s.color }]),
  );

  return (
    <div className={cn("flex flex-col items-center gap-2", className)}>
      <ChartContainer
        config={config}
        className="aspect-square w-full"
        style={{ maxHeight: height }}
      >
        <PieChart>
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                nameKey="key"
                hideIndicator
                formatter={(value, _name, item) => {
                  const count = Number(value) || 0;
                  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
                  const payload = (item?.payload ?? {}) as {
                    key?: string;
                    label?: string;
                  };
                  const label = payload.label ?? "";
                  const color =
                    payload.key !== undefined
                      ? `var(--color-${payload.key})`
                      : undefined;
                  return (
                    <div className="flex w-full items-center justify-between gap-3">
                      <span className="flex items-center gap-2 text-muted-foreground">
                        <span
                          className="size-2.5 shrink-0 rounded-full"
                          style={{ background: color }}
                          aria-hidden
                        />
                        {label}
                      </span>
                      <span className="font-mono font-medium tabular-nums text-foreground">
                        {count}
                        <span className="ml-1 text-muted-foreground">
                          · {pct}%
                        </span>
                      </span>
                    </div>
                  );
                }}
              />
            }
          />
          <Pie
            data={slices as StatusDonutSlice[]}
            dataKey="count"
            nameKey="key"
            cx="50%"
            cy="50%"
            innerRadius="60%"
            outerRadius="92%"
            paddingAngle={2}
            stroke="var(--color-card)"
            strokeWidth={2}
            isAnimationActive={false}
          >
            {slices.map((s) => (
              <Cell key={s.key} fill={`var(--color-${s.key})`} />
            ))}
          </Pie>
        </PieChart>
      </ChartContainer>

      {!hideLegend && (
        <ul className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs">
          {slices.map((s) => {
            const pct = total > 0 ? Math.round((s.count / total) * 100) : 0;
            return (
              <li
                key={s.key}
                className="flex items-center gap-1.5 text-muted-foreground"
              >
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: s.color }}
                  aria-hidden
                />
                <span className="text-foreground">{s.label}</span>
                <span className="font-mono tabular-nums">
                  {s.count}
                  <span className="ml-0.5 text-muted-foreground/70">
                    ({pct}%)
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
