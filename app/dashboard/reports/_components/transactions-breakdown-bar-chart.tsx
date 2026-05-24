/**
 * Client-side bar chart for the report's per-month transactions
 * breakdown over the selected period.
 *
 * Pure presentation — receives pre-shaped `{ month, totalPaise, count }[]`
 * from its Server Component parent and renders a recharts `<BarChart>`
 * with rupee-formatted Y-axis ticks and tooltip. Same styling vocabulary
 * as the dashboard's `<TransactionsTrendChart />` so the two read as
 * siblings.
 *
 * @module app/dashboard/reports/_components/transactions-breakdown-bar-chart
 */
"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatRupeesFromPaise } from "@/lib/format/inr";

// ── Props ─────────────────────────────────────────────────────────────────

export interface TransactionsBreakdownBarChartProps {
  data: ReadonlyArray<{
    month: string;
    totalPaise: number;
    count: number;
  }>;
}

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
    <ResponsiveContainer width="100%" height={220}>
      <BarChart
        data={points}
        margin={{ top: 8, right: 12, left: 12, bottom: 0 }}
      >
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
          cursor={{ fill: "var(--color-muted)", opacity: 0.3 }}
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
        <Bar
          dataKey="totalPaise"
          fill="var(--color-primary)"
          radius={[4, 4, 0, 0]}
          isAnimationActive={false}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
