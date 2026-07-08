/**
 * Filters bar for the users list.
 *
 * Debounced search + two select dropdowns (role, status). Filter values live
 * in the URL so they survive refresh, are shareable, and the Server Component
 * page reads them directly. Same pattern + sentinel-value handling as the
 * companies filters bar.
 *
 * @module app/dashboard/admin/users/_components/filters-bar
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

/** Sentinel "no filter" value — shadcn/Radix Select can't use empty string. */
const ALL_VALUE = "__all__";

const ROLE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "admin", label: "Admin" },
  { value: "staff", label: "Staff" },
  { value: "company", label: "Company" },
];

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "active", label: "Active" },
  { value: "inactive", label: "Disabled" },
];

export interface FiltersBarProps {
  /** Show the role filter. Hidden for staff, who only ever see company users. */
  showRoleFilter?: boolean;
}

export function FiltersBar({ showRoleFilter = true }: FiltersBarProps) {
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

  const roleValue = searchParams.get("role") ?? ALL_VALUE;
  const statusValue = searchParams.get("status") ?? ALL_VALUE;

  const hasActiveFilters =
    search !== "" || roleValue !== ALL_VALUE || statusValue !== ALL_VALUE;

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
          placeholder="Search by name or email..."
          aria-label="Search users"
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

      {/* Role — hidden for staff (every visible row is a company user) */}
      {showRoleFilter && (
        <Select
          value={roleValue}
          onValueChange={(v) =>
            pushParam("role", v === ALL_VALUE ? undefined : v)
          }
        >
          <SelectTrigger className="w-[11rem]" aria-label="Filter by role">
            <SelectValue placeholder="All roles" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>All roles</SelectItem>
            {ROLE_OPTIONS.map((r) => (
              <SelectItem key={r.value} value={r.value}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {/* Status */}
      <Select
        value={statusValue}
        onValueChange={(v) =>
          pushParam("status", v === ALL_VALUE ? undefined : v)
        }
      >
        <SelectTrigger className="w-[11rem]" aria-label="Filter by status">
          <SelectValue placeholder="All statuses" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_VALUE}>All statuses</SelectItem>
          {STATUS_OPTIONS.map((s) => (
            <SelectItem key={s.value} value={s.value}>
              {s.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

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
