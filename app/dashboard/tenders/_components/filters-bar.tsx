/**
 * Filters bar for the tenders list.
 *
 * Search input (debounced) + four select dropdowns (status, sector,
 * geography, MSME-only). Filter values live in the URL — clicking a
 * select pushes the new state into `?key=value` and Next.js re-renders
 * the page with the updated query. URL state means filters survive
 * refresh, are shareable, and work without React in-memory state.
 *
 * Mirrors the structure of the companies filters bar (Day 3) — same
 * sentinel-value pattern, same debounce, same clear-all behaviour. Where
 * the two diverge:
 *   - tenders has a "Status" select (companies has "Compliance")
 *   - tenders has an "MSME only" Yes/No filter; companies has "MSME" Yes/No
 *     as a column attribute, not a filter at the moment
 *   - sector and geography options are the same hard-coded lists for
 *     now — once we have richer real data, we'll dedupe and centralise
 *     this list in lib/companies/options.ts or similar
 *
 * Client Component because:
 *   - Select dropdowns need open/close interaction
 *   - Search input is debounced via setTimeout — needs state and effects
 *   - URL writes happen via useRouter().push()
 *
 * @module app/dashboard/tenders/_components/filters-bar
 */
"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";

// ── Filter option lists ───────────────────────────────────────────────────

/**
 * Sentinel value for "no filter" inside the Select. shadcn/Radix Select
 * cannot have an empty-string value, so we use `__all__` as a stand-in
 * and treat it specially when writing to the URL. Same pattern as the
 * companies filters bar.
 */
const ALL_VALUE = "__all__";

/**
 * Tender status options. Order is by likely-most-useful for filtering:
 * published first (the "live opportunities" view), then the others.
 */
const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "published", label: "Published" },
  { value: "draft", label: "Draft" },
  { value: "closed", label: "Closed" },
  { value: "awarded", label: "Awarded" },
];

/**
 * Sector options. Mirrors the list in the companies filters bar — same
 * sectors are relevant on both sides (tender's sector and a company's
 * sector are matched against each other in the eligibility gate).
 */
const SECTOR_OPTIONS = [
  "Infrastructure",
  "Civil Works",
  "IT Services",
  "IT & Software",
  "Roads & Highways",
  "Consulting",
  "Solar EPC",
  "Real Estate",
  "Manufacturing",
];

/**
 * Geography options. Same list as the companies filters bar.
 */
const GEOGRAPHY_OPTIONS = [
  "Pan India",
  "North India",
  "South India",
  "East India",
  "West India",
  "Maharashtra",
  "Karnataka",
  "Tamil Nadu",
  "Gujarat",
  "Delhi NCR",
  "Telangana",
];

/**
 * MSME-only filter. Tristate via the sentinel value:
 *   - All       → no filter, include both MSME-only and open tenders
 *   - Yes       → only MSME-only tenders
 *   - No        → only open tenders
 *
 * Stored in the URL as `?msmeOnly=true|false`. The action's Zod schema
 * coerces these strings via `z.coerce.boolean()`.
 */
const MSME_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "true", label: "MSME only" },
  { value: "false", label: "Open to all" },
];

// ── Component ─────────────────────────────────────────────────────────────

export function FiltersBar() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  // Local search state — debounced before pushing to URL so we don't
  // hammer the server on every keystroke. Same pattern as companies.
  const initialSearch = searchParams.get("search") ?? "";
  const [search, setSearch] = useState(initialSearch);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // If the URL search changes externally (back/forward, link nav),
  // sync the local input.
  useEffect(() => {
    const fromUrl = searchParams.get("search") ?? "";
    setSearch((prev) => (prev === fromUrl ? prev : fromUrl));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  /**
   * Write a single key into the URL search params. Passing an empty
   * string or undefined removes the key. Resets `page` to 1 because a
   * filter change invalidates the previous page index.
   */
  function pushParam(key: string, value: string | undefined) {
    const params = new URLSearchParams(searchParams.toString());

    if (!value || value === ALL_VALUE) {
      params.delete(key);
    } else {
      params.set(key, value);
    }
    params.delete("page");

    const queryString = params.toString();
    const target = queryString ? `${pathname}?${queryString}` : pathname;

    startTransition(() => {
      router.push(target, { scroll: false });
    });
  }

  /**
   * Debounced search push. Fires 300ms after the last keystroke.
   */
  function handleSearchChange(next: string) {
    setSearch(next);

    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      pushParam("search", next.trim() || undefined);
    }, 300);
  }

  function clearSearch() {
    setSearch("");
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    pushParam("search", undefined);
  }

  // Clear up the timer on unmount.
  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);

  // Current values for the selects. Falls back to ALL_VALUE because
  // shadcn Select doesn't render any selection for empty string.
  const statusValue = searchParams.get("status") ?? ALL_VALUE;
  const sectorValue = searchParams.get("sector") ?? ALL_VALUE;
  const geographyValue = searchParams.get("geography") ?? ALL_VALUE;
  const msmeValue = searchParams.get("msmeOnly") ?? ALL_VALUE;

  const hasActiveFilters =
    search !== "" ||
    statusValue !== ALL_VALUE ||
    sectorValue !== ALL_VALUE ||
    geographyValue !== ALL_VALUE ||
    msmeValue !== ALL_VALUE;

  function clearAll() {
    setSearch("");
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    startTransition(() => {
      router.push(pathname, { scroll: false });
    });
  }

  return (
    <div
      className="flex flex-wrap items-center gap-3 border-b border-border bg-card p-4"
      aria-busy={isPending || undefined}
    >
      {/* Search */}
      <div className="relative min-w-[16rem] flex-1 sm:flex-none">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          type="search"
          value={search}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder="Search tenders..."
          aria-label="Search tenders"
          className="pl-9 pr-9"
        />
        {search && (
          <button
            type="button"
            onClick={clearSearch}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Status */}
      <Select
        value={statusValue}
        onValueChange={(v) => pushParam("status", v === ALL_VALUE ? undefined : v)}
      >
        <SelectTrigger className="w-[12rem]" aria-label="Filter by status">
          <SelectValue placeholder="All Statuses" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_VALUE}>All Statuses</SelectItem>
          {STATUS_OPTIONS.map((s) => (
            <SelectItem key={s.value} value={s.value}>
              {s.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Sector */}
      <Select
        value={sectorValue}
        onValueChange={(v) => pushParam("sector", v === ALL_VALUE ? undefined : v)}
      >
        <SelectTrigger className="w-[12rem]" aria-label="Filter by sector">
          <SelectValue placeholder="All Sectors" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_VALUE}>All Sectors</SelectItem>
          {SECTOR_OPTIONS.map((s) => (
            <SelectItem key={s} value={s}>
              {s}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Geography */}
      <Select
        value={geographyValue}
        onValueChange={(v) =>
          pushParam("geography", v === ALL_VALUE ? undefined : v)
        }
      >
        <SelectTrigger className="w-[12rem]" aria-label="Filter by geography">
          <SelectValue placeholder="All Geographies" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_VALUE}>All Geographies</SelectItem>
          {GEOGRAPHY_OPTIONS.map((g) => (
            <SelectItem key={g} value={g}>
              {g}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* MSME-only filter */}
      <Select
        value={msmeValue}
        onValueChange={(v) =>
          pushParam("msmeOnly", v === ALL_VALUE ? undefined : v)
        }
      >
        <SelectTrigger className="w-[12rem]" aria-label="Filter by MSME eligibility">
          <SelectValue placeholder="All Tenders" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_VALUE}>All Tenders</SelectItem>
          {MSME_OPTIONS.map((m) => (
            <SelectItem key={m.value} value={m.value}>
              {m.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Clear all — only when something is active */}
      {hasActiveFilters && (
        <Button
          variant="ghost"
          size="sm"
          onClick={clearAll}
          className="text-muted-foreground"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
          Clear filters
        </Button>
      )}
    </div>
  );
}
