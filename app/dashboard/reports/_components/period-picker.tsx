/**
 * PeriodPicker — date-range input strip for /dashboard/reports.
 *
 * Client Component. Two date inputs (`from`, `to`) plus four preset chips
 * ("This month", "Last month", "This quarter", "Year to date"). Submitting
 * either input or clicking a preset pushes the new range into the URL via
 * `router.replace`; the parent Server Component re-renders with the new
 * `?from=…&to=…` searchParams.
 *
 * URL-shape state. The inputs read their initial value from props (which
 * the page resolves from `searchParams`), but there is no client-side
 * mirror of the URL — every interaction round-trips through the router.
 * That keeps the picker compatible with browser back/forward navigation
 * and lets the report's deep-links carry the active range.
 *
 * The presets compute their own bounds in UTC, mirroring
 * `lib/dashboard/aggregates.ts::currentMonthBoundsUtc`. No client-side
 * data fetching here; the picker's only job is to rewrite the URL.
 *
 * @module app/dashboard/reports/_components/period-picker
 */
"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useId, useMemo, type ChangeEvent } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface PeriodPickerProps {
  /** Current `from` value, ISO date-only (YYYY-MM-DD). */
  from: string;
  /** Current `to` value, ISO date-only (YYYY-MM-DD). */
  to: string;
}

interface Preset {
  label: string;
  /** Compute the (from, to) pair for "now". */
  range: (now: Date) => { from: string; to: string };
}

// Presets are pure functions of the runtime clock. The button click
// rewrites the URL with the computed range; the parent re-renders.
const PRESETS: Preset[] = [
  {
    label: "This month",
    range: (now) => monthBoundsUtc(now.getUTCFullYear(), now.getUTCMonth()),
  },
  {
    label: "Last month",
    range: (now) => monthBoundsUtc(now.getUTCFullYear(), now.getUTCMonth() - 1),
  },
  {
    label: "This quarter",
    range: (now) => quarterBoundsUtc(now),
  },
  {
    label: "Year to date",
    range: (now) => yearToDateBoundsUtc(now),
  },
];

export function PeriodPicker({ from, to }: PeriodPickerProps) {
  const router = useRouter();
  const params = useSearchParams();
  const fromId = useId();
  const toId = useId();

  const currentPresetLabel = useMemo(
    () => detectPreset(from, to),
    [from, to],
  );

  function pushRange(next: { from: string; to: string }): void {
    const query = new URLSearchParams(params?.toString() ?? "");
    query.set("from", next.from);
    query.set("to", next.to);
    router.replace(`/dashboard/reports?${query.toString()}`, { scroll: false });
  }

  function handleFromChange(event: ChangeEvent<HTMLInputElement>): void {
    const next = event.target.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) return;
    pushRange({ from: next, to });
  }

  function handleToChange(event: ChangeEvent<HTMLInputElement>): void {
    const next = event.target.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) return;
    pushRange({ from, to: next });
  }

  function handlePreset(preset: Preset): void {
    pushRange(preset.range(new Date()));
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label
            htmlFor={fromId}
            className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            From
          </label>
          <input
            id={fromId}
            type="date"
            value={from}
            max={to}
            onChange={handleFromChange}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label
            htmlFor={toId}
            className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            To
          </label>
          <input
            id={toId}
            type="date"
            value={to}
            min={from}
            onChange={handleToChange}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {PRESETS.map((preset) => {
          const isActive = currentPresetLabel === preset.label;
          return (
            <Button
              key={preset.label}
              type="button"
              size="sm"
              variant={isActive ? "default" : "outline"}
              onClick={() => handlePreset(preset)}
              className={cn(isActive && "pointer-events-none")}
            >
              {preset.label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

// ── Date math (UTC, mirrors lib/dashboard/aggregates.ts) ─────────────────

/**
 * First and last day of the given (year, month) pair, both inclusive.
 * `month` is 0-indexed (JS convention). Handles month underflow
 * (`month = -1` → December of previous year) so the "Last month"
 * preset works in January without a special case.
 */
function monthBoundsUtc(year: number, month: number): {
  from: string;
  to: string;
} {
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 0));
  return { from: isoDate(start), to: isoDate(end) };
}

/** Start of the current calendar quarter through today (UTC). */
function quarterBoundsUtc(now: Date): { from: string; to: string } {
  const year = now.getUTCFullYear();
  const quarterStartMonth = Math.floor(now.getUTCMonth() / 3) * 3;
  const start = new Date(Date.UTC(year, quarterStartMonth, 1));
  return { from: isoDate(start), to: isoDate(now) };
}

/** January 1 through today (UTC). */
function yearToDateBoundsUtc(now: Date): { from: string; to: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  return { from: isoDate(start), to: isoDate(now) };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Match the current (from, to) pair against a preset's computed range.
 * Used to highlight the active chip. Anchored on today's clock — a
 * preset that matched yesterday's "This month" won't match today's
 * (the boundary moved), which is the right behaviour.
 */
function detectPreset(from: string, to: string): string | null {
  const now = new Date();
  for (const preset of PRESETS) {
    const r = preset.range(now);
    if (r.from === from && r.to === to) return preset.label;
  }
  return null;
}
