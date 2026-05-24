/**
 * Reusable donut chart for status distributions.
 *
 * Pure presentation — receives a pre-shaped `data` array of
 * `{ key, label, count, color }` slices and renders a recharts
 * `<PieChart>` with a centre-hole donut. The host owns the colour +
 * label mapping so the chart stays domain-agnostic (projects, tenders,
 * companies, documents — same component, different slice palette).
 *
 * Empty state: when every slice is zero, the chart returns null and
 * the host should render its rows-of-counts list alongside as the
 * fallback (the chart can't communicate "0 of nothing" usefully).
 *
 * @module app/dashboard/_components/status-donut-chart
 */
"use client";

import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";

// ── Props ─────────────────────────────────────────────────────────────────

export interface StatusDonutSlice {
  /** Stable React key — typically the status enum value. */
  key: string;
  /** Human-readable label shown in the tooltip. */
  label: string;
  /** Slice count. Zero-value slices are filtered out before render. */
  count: number;
  /** CSS color (var or hex). Pulled from the host's palette mapping. */
  color: string;
}

export interface StatusDonutChartProps {
  data: ReadonlyArray<StatusDonutSlice>;
  /** Outer chart height in px. Default 180 — fits the side-by-side card layout. */
  height?: number;
}

// ── Component ────────────────────────────────────────────────────────────

export function StatusDonutChart({
  data,
  height = 180,
}: StatusDonutChartProps) {
  // Filter zero-value slices so they don't pollute the legend / tooltip.
  // Slice angle is proportional to count; a zero-value slice would draw
  // as a 0° wedge anyway, but pre-filtering keeps the data tidy.
  const slices = data.filter((s) => s.count > 0);
  if (slices.length === 0) return null;

  const total = slices.reduce((acc, s) => acc + s.count, 0);

  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie
          data={slices as StatusDonutSlice[]}
          dataKey="count"
          nameKey="label"
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
            <Cell key={s.key} fill={s.color} />
          ))}
        </Pie>
        <Tooltip
          cursor={false}
          contentStyle={{
            background: "var(--color-card)",
            border: "1px solid var(--color-border)",
            borderRadius: "6px",
            fontSize: "12px",
          }}
          labelStyle={{
            color: "var(--color-foreground)",
            fontWeight: 600,
          }}
          formatter={(value, name) => {
            const count = Number(value) || 0;
            const pct = total > 0 ? Math.round((count / total) * 100) : 0;
            return [`${count} (${pct}%)`, String(name ?? "")];
          }}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}
