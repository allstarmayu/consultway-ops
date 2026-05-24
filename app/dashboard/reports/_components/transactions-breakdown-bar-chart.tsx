/**
 * Client-side bar chart for the report's per-month transactions
 * breakdown over the selected period.
 *
 * Rewritten on top of the shadcn chart primitives (Day 25) — same
 * shape as the dashboard's `<TransactionsTrendChart />` so the two
 * read as siblings. Single series ("Total"), rounded bars, palette
 * colour pulled from `--chart-1`.
 *
 * @module app/dashboard/reports/_components/transactions-breakdown-bar-chart
 */
"use client";

import {
  Bar,
  BarChart,
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

export interface TransactionsBreakdownBarChartProps {
  data: ReadonlyArray<{
    month: string;
    totalPaise: number;
    count: number;
  }>;
}

// ── Chart config ─────────────────────────────────────────────────────────

const BREAKDOWN_CONFIG = {
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

function formatRupeesAxis(paise: number): string {
  return formatRupeesFromPaise(paise).replace(/\.\d{2}$/, "");
}

// ── Component ────────────────────────────────────────────────────────────

export function TransactionsBreakdownBarChart({
  data,
}: TransactionsBreakdownBarChartProps) {
  const points = data.map((d) => ({
    ...d,
    label: formatMonthLabel(d.month),
  }));

  return (
    <ChartContainer
      config={BREAKDOWN_CONFIG}
      className="aspect-auto h-[220px] w-full"
    >
      <BarChart
        data={points}
        margin={{ top: 8, right: 12, left: 12, bottom: 0 }}
      >
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
          cursor={{ fill: "var(--color-muted)", opacity: 0.4 }}
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

        <Bar
          dataKey="totalPaise"
          fill="var(--color-totalPaise)"
          radius={[6, 6, 0, 0]}
          animationDuration={500}
          animationEasing="ease-out"
        />
      </BarChart>
    </ChartContainer>
  );
}
