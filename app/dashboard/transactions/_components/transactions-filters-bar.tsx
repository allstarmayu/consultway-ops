/**
 * Filters bar for the transactions list (admin-only surface).
 *
 * Type select (5 values) + company select + project select (dependent
 * on company) + occurredOn-from / occurredOn-to date inputs.
 *
 * Dependent project select: when no company is selected, the dropdown
 * lists every project in the system. When a company IS selected, the
 * list narrows to that company's projects only. Selecting a project
 * that doesn't belong to the chosen company is the only invalid combo
 * we explicitly defend against — switching the company clears the
 * project filter to avoid leaving the URL in an inconsistent state.
 *
 * Same `__all__` sentinel + URL-state model + Suspense-friendly
 * `useTransition` pattern as the projects filter bar.
 *
 * @module app/dashboard/transactions/_components/transactions-filters-bar
 */
"use client";

import { useEffect, useMemo, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { TRANSACTION_TYPE_OPTIONS } from "./badges";

const ALL_VALUE = "__all__";

/**
 * Styling for the two native date inputs.
 *
 * `<Input>` is `text-base md:text-sm` — 16px below `md` to stop iOS Safari
 * auto-zooming when a text field takes focus. A `type="date"` field opens a
 * native picker instead of a keyboard, so that guard buys nothing here and
 * only leaves the dates rendering a size larger than the `text-sm` selects
 * beside them. Pin them to `text-sm` so the bar reads as one type scale
 * (matching the raw date inputs in reports/_components/period-picker.tsx),
 * use tabular figures so the digits don't jitter as the value changes, and
 * soften the native calendar icon to sit with the muted chevrons.
 */
const DATE_INPUT_CLASS =
  "min-w-0 flex-1 text-sm tabular-nums sm:w-[10rem] sm:flex-none " +
  "[&::-webkit-calendar-picker-indicator]:cursor-pointer " +
  "[&::-webkit-calendar-picker-indicator]:opacity-60 " +
  "[&::-webkit-calendar-picker-indicator]:transition-opacity " +
  "[&::-webkit-calendar-picker-indicator]:hover:opacity-100";

// ── Props ─────────────────────────────────────────────────────────────────

export interface CompanyOption {
  id: string;
  name: string;
}

export interface ProjectOption {
  id: string;
  name: string;
  companyId: string;
}

export interface TransactionsFiltersBarProps {
  companyOptions: CompanyOption[];
  projectOptions: ProjectOption[];
}

// ── Component ─────────────────────────────────────────────────────────────

export function TransactionsFiltersBar({
  companyOptions,
  projectOptions,
}: TransactionsFiltersBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const typeValue = searchParams.get("type") ?? ALL_VALUE;
  const companyValue = searchParams.get("companyId") ?? ALL_VALUE;
  const projectValue = searchParams.get("projectId") ?? ALL_VALUE;
  const fromValue = searchParams.get("occurredOnFrom") ?? "";
  const toValue = searchParams.get("occurredOnTo") ?? "";

  // Narrow the project list when a company is selected. When no company
  // filter is active, show every project.
  const filteredProjects = useMemo(() => {
    if (companyValue === ALL_VALUE) return projectOptions;
    return projectOptions.filter((p) => p.companyId === companyValue);
  }, [companyValue, projectOptions]);

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

  function pushMultiple(updates: Array<[string, string | undefined]>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of updates) {
      if (!value || value === ALL_VALUE) {
        params.delete(key);
      } else {
        params.set(key, value);
      }
    }
    params.delete("page");
    const queryString = params.toString();
    const target = queryString ? `${pathname}?${queryString}` : pathname;
    startTransition(() => {
      router.push(target, { scroll: false });
    });
  }

  function onCompanyChange(next: string) {
    // Changing company clears any incompatible project filter — the
    // URL stays internally consistent without the user having to do
    // two clicks.
    const currentProject = projectValue;
    const stillValid =
      next === ALL_VALUE ||
      projectOptions.find(
        (p) => p.id === currentProject && p.companyId === next,
      ) !== undefined;
    pushMultiple([
      ["companyId", next === ALL_VALUE ? undefined : next],
      ["projectId", stillValid ? currentProject : undefined],
    ]);
  }

  // If the URL arrives in an already-inconsistent state (project from a
  // different company than companyId), trim the project quietly. Runs
  // once per change of either search param.
  useEffect(() => {
    if (
      projectValue !== ALL_VALUE &&
      companyValue !== ALL_VALUE &&
      !filteredProjects.find((p) => p.id === projectValue)
    ) {
      pushParam("projectId", undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectValue, companyValue, filteredProjects]);

  const hasActiveFilters =
    typeValue !== ALL_VALUE ||
    companyValue !== ALL_VALUE ||
    projectValue !== ALL_VALUE ||
    fromValue !== "" ||
    toValue !== "";

  function clearAll() {
    startTransition(() => {
      router.push(pathname, { scroll: false });
    });
  }

  return (
    <div
      className="flex flex-wrap items-center gap-3 border-b border-border bg-card p-4"
      aria-busy={isPending || undefined}
    >
      {/* Type */}
      <Select
        value={typeValue}
        onValueChange={(v) =>
          pushParam("type", v === ALL_VALUE ? undefined : v)
        }
      >
        <SelectTrigger className="w-full sm:w-[10rem]" aria-label="Filter by type">
          <SelectValue placeholder="All Types" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_VALUE}>All Types</SelectItem>
          {TRANSACTION_TYPE_OPTIONS.map((t) => (
            <SelectItem key={t.value} value={t.value}>
              {t.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Company */}
      <Select value={companyValue} onValueChange={onCompanyChange}>
        <SelectTrigger className="w-full sm:w-[14rem]" aria-label="Filter by company">
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

      {/* Project — dependent on company */}
      <Select
        value={projectValue}
        onValueChange={(v) =>
          pushParam("projectId", v === ALL_VALUE ? undefined : v)
        }
      >
        <SelectTrigger className="w-full sm:w-[14rem]" aria-label="Filter by project">
          <SelectValue placeholder="All Projects" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_VALUE}>All Projects</SelectItem>
          {filteredProjects.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Date range */}
      <div className="flex w-full items-center gap-2 sm:w-auto">
        <Input
          type="date"
          aria-label="From date"
          className={DATE_INPUT_CLASS}
          value={fromValue}
          onChange={(e) =>
            pushParam("occurredOnFrom", e.target.value || undefined)
          }
        />
        <span className="text-sm text-muted-foreground" aria-hidden>
          →
        </span>
        <Input
          type="date"
          aria-label="To date"
          className={DATE_INPUT_CLASS}
          value={toValue}
          onChange={(e) =>
            pushParam("occurredOnTo", e.target.value || undefined)
          }
        />
      </div>

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
