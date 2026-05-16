/**
 * Filters bar for the companies list.
 *
 * Search input (debounced) + three select dropdowns (sector, geography,
 * compliance). Filter values live in the URL — clicking a select pushes
 * the new state into `?key=value` and Next.js re-renders the page with
 * the updated query. URL state means filters survive refresh, are
 * shareable, and work without React in-memory state.
 *
 * Client Component because:
 *   - Select dropdowns need open/close interaction
 *   - Search input is debounced via setTimeout — needs state and effects
 *   - URL writes happen via useRouter().push()
 *
 * Sector and geography options are hard-coded for now. Once we have
 * real seed data, we can either populate from a distinct query against
 * the DB, or maintain a curated list per docs/05-database-schema.md.
 * Hard-coded for Phase 1 because the seed companies use a small set
 * anyway, and a dynamic SELECT DISTINCT every render is overkill.
 *
 * @module app/dashboard/companies/_components/filters-bar
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

// ── Filter option lists ─────────────────────────────────────────────────────

/**
 * Sentinel value for "no filter" inside the Select. shadcn/Radix Select
 * cannot have an empty-string value, so we use `__all__` as a stand-in
 * and treat it specially when writing to the URL.
 */
const ALL_VALUE = "__all__";

/**
 * Sector options. Mirrors the spread used in the figma + the Indian
 * project landscape Consultway works in. Add or remove items here as
 * the real data starts populating.
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
 * Geography options. India-wide + the most active states/regions for
 * government infrastructure projects. Same maintenance note as sectors.
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
 * Compliance options — keep in sync with `ComplianceStatus` in
 * lib/db/schema.ts. Order is by likely-most-useful for filtering.
 */
const COMPLIANCE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "pending", label: "Pending" },
  { value: "compliant", label: "Compliant" },
  { value: "non_compliant", label: "Non-compliant" },
  { value: "expired", label: "Expired" },
];

// ── Component ───────────────────────────────────────────────────────────────

export function FiltersBar() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  // Local search state — debounced before pushing to URL so we don't
  // hammer the server on every keystroke.
  const initialSearch = searchParams.get("search") ?? "";
  const [search, setSearch] = useState(initialSearch);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // If the URL search changes externally (back/forward, link nav),
  // sync the local input. The string comparison is necessary because
  // every render produces a new `searchParams` object.
  useEffect(() => {
    const fromUrl = searchParams.get("search") ?? "";
    setSearch((prev) => (prev === fromUrl ? prev : fromUrl));
    // We intentionally don't list `search` as a dep — we want the URL
    // to win, not the local state.
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
    // Any filter change resets to page 1.
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
  const sectorValue = searchParams.get("sector") ?? ALL_VALUE;
  const geographyValue = searchParams.get("geography") ?? ALL_VALUE;
  const complianceValue = searchParams.get("complianceStatus") ?? ALL_VALUE;

  // Is anything currently filtering? Used to show a "clear all" affordance.
  const hasActiveFilters =
    search !== "" ||
    sectorValue !== ALL_VALUE ||
    geographyValue !== ALL_VALUE ||
    complianceValue !== ALL_VALUE;

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
          placeholder="Search companies..."
          aria-label="Search companies"
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
        <SelectTrigger
          className="w-[12rem]"
          aria-label="Filter by geography"
        >
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

      {/* Compliance */}
      <Select
        value={complianceValue}
        onValueChange={(v) =>
          pushParam("complianceStatus", v === ALL_VALUE ? undefined : v)
        }
      >
        <SelectTrigger
          className="w-[12rem]"
          aria-label="Filter by compliance status"
        >
          <SelectValue placeholder="All Compliance" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_VALUE}>All Compliance</SelectItem>
          {COMPLIANCE_OPTIONS.map((c) => (
            <SelectItem key={c.value} value={c.value}>
              {c.label}
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
