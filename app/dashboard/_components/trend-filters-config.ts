/**
 * Shared (non-"use client") config for the dashboard's transactions
 * trend filters.
 *
 * Carries the type definitions + URL-param resolvers that both the
 * Client Component (`trend-filters.tsx`) and the Server Component
 * dashboard page need to import. Next.js disallows calling exports
 * from a "use client" file in a server context, so the resolvers
 * have to live in a sibling module without the directive.
 *
 * @module app/dashboard/_components/trend-filters-config
 */

// ── Shape constants ──────────────────────────────────────────────────────

/**
 * Months presets surfaced as pills. Keep in sync with the
 * `monthlyTrendInputSchema.months` validator on the server — anything
 * outside 1..36 gets rejected, so we stick to a small curated set.
 */
export const MONTH_OPTIONS = [6, 12, 24] as const;
export type MonthOption = (typeof MONTH_OPTIONS)[number];

/**
 * Transaction-type filter values. Mirrors the `transactionType` enum
 * on the server-side schema. "all" is the default / unfiltered view.
 */
export type TrendType =
  | "all"
  | "invoice"
  | "payment"
  | "expense"
  | "advance"
  | "refund";

/**
 * Transaction-type dropdown options. Order is the surface order in the
 * Select. Lives here so both the Client filter component and any
 * future consumer (e.g. server-side default fallback) share one list.
 */
export const TYPE_OPTIONS: Array<{ value: TrendType; label: string }> = [
  { value: "all", label: "All types" },
  { value: "invoice", label: "Invoices only" },
  { value: "payment", label: "Payments only" },
  { value: "expense", label: "Expenses only" },
  { value: "advance", label: "Advances only" },
  { value: "refund", label: "Refunds only" },
];

// ── URL-param resolvers ──────────────────────────────────────────────────

/**
 * Pick a valid month preset out of a raw URL value. Defaults to 12 on
 * absent / bogus input. Called from the dashboard's Server Component
 * page so the value passes to both the aggregate query and the
 * <TrendFilters /> Client Component as a typed prop.
 */
export function resolveTrendMonths(
  raw: string | null | undefined,
): MonthOption {
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
