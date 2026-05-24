/**
 * Client-side chart for the 12-month transactions trend.
 *
 * Pure presentation — receives the pre-computed `{ month, totalPaise,
 * count }[]` payload from its Server Component parent and renders a
 * recharts `<AreaChart>` with rupee-formatted Y-axis ticks and tooltip.
 *
 * Lives in its own file (not inline in the card) because recharts
 * requires the DOM, which means the wrapping component has to carry
 * the `"use client"` directive. Splitting keeps the Server Component
 * card free of that constraint.
 *
 * The chart is intentionally minimal — no legend (single series), no
 * brush, no zoom. Phase-1 dashboards favour at-a-glance over
 * interactive deep-dives; the reports page is where the latter live.
 *
 * @module app/dashboard/_components/transactions-trend-chart
 */
"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatRupeesFromPaise } from "@/lib/format/inr";

// ── Props ─────────────────────────────────────────────────────────────────

export interface TransactionsTrendChartProps {
  /**
   * Oldest-first month buckets. `month` is the `YYYY-MM` key from the
   * aggregate; `totalPaise` is the sum of every transaction in that
   * month (zero-filled when none).
   */
  data: ReadonlyArray<{
    month: string;
    totalPaise: number;
    count: number;
  }>;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Format a YYYY-MM key as a compact "MMM YY" label for the X-axis
 * (e.g. "May 26"). Locale-fixed to en-GB so the abbreviation is
 * consistent across hosts; deliberately not Indian-locale because the
 * Indian months in en-IN match en-GB anyway and en-GB is more widely
 * present in the Intl polyfills.
 */
function formatMonthLabel(yearMonth: string): string {
  const [y, m] = yearMonth.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  return d.toLocaleString("en-GB", {
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  });
}

/**
 * Compact rupee formatter for Y-axis ticks. Reuses the en-IN grouping
 * via the existing `formatRupeesFromPaise` helper but strips the
 * fractional paise — at axis-tick density "₹ 1,00,00,000" reads
 * better than "₹ 1,00,00,000.00" and the precision isn't useful at
 * this zoom level.
 */
function formatRupeesAxis(paise: number): string {
  // formatRupeesFromPaise returns "₹ 1,00,00,000.00" — drop the trailing
  // ".00" / ".XY" for the axis ticks. The tooltip keeps the full value.
  return formatRupeesFromPaise(paise).replace(/\.\d{2}$/, "");
}

// ── Component ────────────────────────────────────────────────────────────

export function TransactionsTrendChart({ data }: TransactionsTrendChartProps) {
  // Pre-shape: recharts wants a writable array. Also pre-compute the
  // display label so the tooltip and the X-axis share one source.
  const points = data.map((d) => ({
    ...d,
    label: formatMonthLabel(d.month),
  }));

  return (
    <ResponsiveContainer width="100%" height={240}>
      <AreaChart
        data={points}
        margin={{ top: 8, right: 12, left: 12, bottom: 0 }}
      >
        <defs>
          {/* Use the warm-ambient primary token as the fill, fading
              to transparent at the bottom. The gradient id is local
              to this component instance — collisions are theoretically
              possible if recharts ever renders two of these on one
              page, but at Phase-1 scale there's only ever one. */}
          <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="0%"
              stopColor="var(--color-primary)"
              stopOpacity={0.35}
            />
            <stop
              offset="100%"
              stopColor="var(--color-primary)"
              stopOpacity={0}
            />
          </linearGradient>
        </defs>

        <CartesianGrid
          strokeDasharray="3 3"
          stroke="var(--color-border)"
          vertical={false}
        />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
          tickLine={false}
          axisLine={{ stroke: "var(--color-border)" }}
          minTickGap={16}
        />
        <YAxis
          dataKey="totalPaise"
          tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
          tickLine={false}
          axisLine={{ stroke: "var(--color-border)" }}
          tickFormatter={formatRupeesAxis}
          width={80}
        />
        <Tooltip
          cursor={{ stroke: "var(--color-border)", strokeWidth: 1 }}
          contentStyle={{
            background: "var(--color-card)",
            border: "1px solid var(--color-border)",
            borderRadius: "6px",
            fontSize: "12px",
          }}
          labelStyle={{ color: "var(--color-foreground)", fontWeight: 600 }}
          formatter={(value, _name, item) => {
            const paise = Number(value) || 0;
            const point = (item?.payload ?? {}) as {
              count?: number;
              totalPaise?: number;
            };
            const count = point.count ?? 0;
            return [
              `${formatRupeesFromPaise(paise)} · ${count} ${
                count === 1 ? "entry" : "entries"
              }`,
              "Total",
            ];
          }}
        />
        <Area
          type="monotone"
          dataKey="totalPaise"
          stroke="var(--color-primary)"
          strokeWidth={2}
          fill="url(#trendFill)"
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
