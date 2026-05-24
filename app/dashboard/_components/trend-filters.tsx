/**
 * Filter strip for the dashboard's TransactionsTrendCard.
 *
 * Two controls, both URL-driven so the page stays a Server Component:
 *
 *   - Window size pills: 6 mo / 12 mo / 24 mo. Mutually exclusive.
 *   - Transaction-type select: All / Invoice / Payment / Expense /
 *     Advance / Refund. The "Monthly Invoice Trend" view from the
 *     Figma reference is simply the "Invoice" pick on this select.
 *
 * URL params:
 *   - `?trendMonths=6|12|24` — defaults to 12 when absent / bogus.
 *   - `?trendType=all|invoice|payment|expense|advance|refund` —
 *     defaults to "all".
 *
 * Changes use `router.replace` with `scroll: false` so the page
 * re-renders against the new server-side aggregate but the user's
 * scroll position stays put. `useTransition` keeps the filter UI
 * disabled while the page re-resolves.
 *
 * @module app/dashboard/_components/trend-filters
 */
"use client";

import { useTransition } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

// ── Shape constants ──────────────────────────────────────────────────────

/**
 * Months presets surfaced as pills. Keep in sync with the
 * `monthlyTrendInputSchema.months` validator on the server — anything
 * outside 1..36 gets rejected, so we stick to a small curated set.
 */
const MONTH_OPTIONS = [6, 12, 24] as const;
type MonthOption = (typeof MONTH_OPTIONS)[number];

/**
 * Transaction-type select options. Mirrors the `transactionType` enum
 * on the server-side schema. "all" is the default / unfiltered view.
 */
const TYPE_OPTIONS: Array<{ value: TrendType; label: string }> = [
  { value: "all", label: "All types" },
  { value: "invoice", label: "Invoices only" },
  { value: "payment", label: "Payments only" },
  { value: "expense", label: "Expenses only" },
  { value: "advance", label: "Advances only" },
  { value: "refund", label: "Refunds only" },
];

export type TrendType =
  | "all"
  | "invoice"
  | "payment"
  | "expense"
  | "advance"
  | "refund";

// ── Props ────────────────────────────────────────────────────────────────

export interface TrendFiltersProps {
  /** Currently-applied month window (echoed from the server-resolved value). */
  months: MonthOption;
  /** Currently-applied transaction-type filter. */
  type: TrendType;
}

// ── Component ────────────────────────────────────────────────────────────

export function TrendFilters({ months, type }: TrendFiltersProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  function updateParam(key: string, value: string | null): void {
    const next = new URLSearchParams(searchParams.toString());
    if (value === null) {
      next.delete(key);
    } else {
      next.set(key, value);
    }
    const query = next.toString();
    const href = query ? `${pathname}?${query}` : pathname;
    startTransition(() => {
      router.replace(href, { scroll: false });
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* Pill toggle group for window size. */}
      <div
        role="group"
        aria-label="Trend window"
        className="inline-flex rounded-md border border-border bg-card p-0.5"
      >
        {MONTH_OPTIONS.map((m) => {
          const active = m === months;
          return (
            <Button
              key={m}
              type="button"
              size="sm"
              variant="ghost"
              disabled={isPending}
              className={cn(
                "h-7 rounded-sm px-2.5 text-xs font-medium",
                active && "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground",
              )}
              onClick={() =>
                updateParam(
                  "trendMonths",
                  // Drop the param entirely when picking the default (12)
                  // so the URL stays clean.
                  m === 12 ? null : String(m),
                )
              }
              aria-pressed={active}
            >
              {m} mo
            </Button>
          );
        })}
      </div>

      {/* Transaction-type dropdown. Width is set wide enough to fit
          "Refunds only" without clipping. */}
      <Select
        value={type}
        disabled={isPending}
        onValueChange={(value) =>
          updateParam("trendType", value === "all" ? null : value)
        }
      >
        <SelectTrigger className="h-8 w-[160px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {TYPE_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// ── URL-param resolvers (consumed by the page) ────────────────────────────

/**
 * Pick a valid month preset out of a raw URL value. Defaults to 12 on
 * absent / bogus input. Exposed so the dashboard page can resolve the
 * value once and pass the result to both the aggregate and the filter
 * strip — keeps the source of truth tight.
 */
export function resolveTrendMonths(raw: string | null | undefined): MonthOption {
  const n = Number(raw);
  if (n === 6 || n === 12 || n === 24) return n;
  return 12;
}

/**
 * Pick a valid type filter out of a raw URL value. Defaults to "all"
 * on absent / bogus input. Same single-resolution rationale as
 * `resolveTrendMonths`.
 */
export function resolveTrendType(raw: string | null | undefined): TrendType {
  if (
    raw === "invoice" ||
    raw === "payment" ||
    raw === "expense" ||
    raw === "advance" ||
    raw === "refund"
  ) {
    return raw;
  }
  return "all";
}
