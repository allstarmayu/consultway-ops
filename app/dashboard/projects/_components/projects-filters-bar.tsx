/**
 * Filters bar for the projects list.
 *
 * Search input (debounced) + status select + optional company select
 * (admin/staff only). Mirrors the tenders filters bar — same sentinel
 * `__all__` value pattern, same URL-state model, same debounce.
 *
 * Client Component because:
 *   - Select dropdowns need open/close interaction
 *   - Search input is debounced via setTimeout — needs state + effects
 *   - URL writes happen via useRouter().push()
 *
 * Company-role users never see the company select — they're already
 * scoped to their own projects. The parent page omits the
 * `companyOptions` prop in that case; this component skips rendering
 * the dropdown when the prop is absent.
 *
 * @module app/dashboard/projects/_components/projects-filters-bar
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
import { PROJECT_STATUS_OPTIONS } from "./badges";

const ALL_VALUE = "__all__";

// ── Props ─────────────────────────────────────────────────────────────────

export interface CompanyOption {
  id: string;
  name: string;
}

export interface ProjectsFiltersBarProps {
  /**
   * The full list of companies for the admin/staff "company" filter.
   * Omitted for company-role callers — they're already scoped.
   */
  companyOptions?: CompanyOption[];
}

// ── Component ─────────────────────────────────────────────────────────────

export function ProjectsFiltersBar({ companyOptions }: ProjectsFiltersBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const urlSearch = searchParams.get("search") ?? "";
  const [search, setSearch] = useState(urlSearch);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync the input when `?search=` changes externally (back/forward, link
  // nav). Track the last URL value and adjust `search` during render —
  // React's "adjusting state on a prop change" pattern. Avoids a
  // setState-in-effect cascade (react-hooks/set-state-in-effect).
  const [lastUrlSearch, setLastUrlSearch] = useState(urlSearch);
  if (urlSearch !== lastUrlSearch) {
    setLastUrlSearch(urlSearch);
    setSearch(urlSearch);
  }

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

  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);

  const statusValue = searchParams.get("status") ?? ALL_VALUE;
  const companyValue = searchParams.get("companyId") ?? ALL_VALUE;

  const hasActiveFilters =
    search !== "" ||
    statusValue !== ALL_VALUE ||
    companyValue !== ALL_VALUE;

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
          placeholder="Search projects..."
          aria-label="Search projects"
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
          {PROJECT_STATUS_OPTIONS.map((s) => (
            <SelectItem key={s.value} value={s.value}>
              {s.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Company — admin/staff only */}
      {companyOptions && (
        <Select
          value={companyValue}
          onValueChange={(v) =>
            pushParam("companyId", v === ALL_VALUE ? undefined : v)
          }
        >
          <SelectTrigger className="w-[14rem]" aria-label="Filter by company">
            <SelectValue placeholder="All Companies" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>All Companies</SelectItem>
            {companyOptions.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

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
