/**
 * Client-side chart for the 12-month transactions trend.
 *
 * Rewritten on top of the shadcn chart primitives (Day 25). The
 * `<ChartContainer>` wrapper handles theming + the responsive
 * envelope; `<ChartTooltipContent>` ships the card-shaped tooltip
 * that ties back to the chart config's labels and colours via a
 * dot indicator. Net effect: smaller component file, palette-cohesive
 * tooltip, and a chart that picks up the warm-ambient theme tokens
 * automatically.
 *
 * Single data series ("Total") drawn as a smooth area with a soft
 * gradient fill below the curve.
 *
 * @module app/dashboard/_components/transactions-trend-chart
 */
"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from "recharts";

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
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

// ── Chart config ─────────────────────────────────────────────────────────

/**
 * One entry per data series. The key (`totalPaise`) MUST match the
 * `dataKey` on the chart's `<Area />` element — the chart container
 * uses the key to inject CSS variables (var(--color-totalPaise)) that
 * the chart elements then reference. Colour pulls from the warm-
 * ambient palette's `--chart-1` token so the trend reads as the
 * "primary metric" in the same vocabulary as the donut.
 */
const TREND_CONFIG = {
  totalPaise: {
    label: "Total",
    color: "var(--chart-1)",
  },
} satisfies ChartConfig;

// ── Helpers ──────────────────────────────────────────────────────────────

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
 * Compact rupee formatter for Y-axis ticks. Drops the fractional paise
 * — at axis-tick density "₹ 1,00,00,000" reads better than
 * "₹ 1,00,00,000.00" and the precision isn't useful at this zoom level.
 */
function formatRupeesAxis(paise: number): string {
  return formatRupeesFromPaise(paise).replace(/\.\d{2}$/, "");
}

// ── Component ────────────────────────────────────────────────────────────

export function TransactionsTrendChart({ data }: TransactionsTrendChartProps) {
  const points = data.map((d) => ({
    ...d,
    label: formatMonthLabel(d.month),
  }));

  return (
    <ChartContainer
      config={TREND_CONFIG}
      className="aspect-auto h-[240px] w-full"
    >
      <AreaChart
        data={points}
        margin={{ top: 8, right: 12, left: 12, bottom: 0 }}
      >
        <defs>
          {/* Soft gradient fill below the curve. Both stops use the
              chart-config CSS var so a future palette tweak only needs
              to touch TREND_CONFIG. */}
          <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="0%"
              stopColor="var(--color-totalPaise)"
              stopOpacity={0.4}
            />
            <stop
              offset="100%"
              stopColor="var(--color-totalPaise)"
              stopOpacity={0.02}
            />
          </linearGradient>
        </defs>

        <CartesianGrid strokeDasharray="3 3" vertical={false} />

        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={16}
        />
        <YAxis
          dataKey="totalPaise"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          tickFormatter={formatRupeesAxis}
          width={80}
        />

        <ChartTooltip
          cursor={{ strokeWidth: 1 }}
          content={
            <ChartTooltipContent
              labelKey="label"
              formatter={(value, _name, item) => {
                const paise = Number(value) || 0;
                const point = (item?.payload ?? {}) as {
                  count?: number;
                };
                const count = point.count ?? 0;
                return (
                  <div className="flex w-full items-center justify-between gap-3">
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <span
                        className="size-2.5 shrink-0 rounded-[2px]"
                        style={{ background: "var(--color-totalPaise)" }}
                        aria-hidden
                      />
                      Total
                    </span>
                    <span className="font-mono font-medium tabular-nums text-foreground">
                      {formatRupeesFromPaise(paise)}
                      <span className="ml-1 text-muted-foreground">
                        · {count} {count === 1 ? "entry" : "entries"}
                      </span>
                    </span>
                  </div>
                );
              }}
            />
          }
        />

        <Area
          type="monotone"
          dataKey="totalPaise"
          stroke="var(--color-totalPaise)"
          strokeWidth={2.5}
          fill="url(#trendFill)"
          activeDot={{
            r: 5,
            strokeWidth: 2,
            stroke: "var(--color-card)",
          }}
          animationDuration={500}
          animationEasing="ease-out"
        />
      </AreaChart>
    </ChartContainer>
  );
}
