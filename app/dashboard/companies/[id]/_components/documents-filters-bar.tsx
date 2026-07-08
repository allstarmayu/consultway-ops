/**
 * Filter bar for the documents section on the company detail page.
 *
 * Two select dropdowns - status + document type. Values live in the URL
 * under namespaced keys (`?documentStatus=...&documentType=...`) so
 * future filter sets on other sections of this page (e.g. an activity
 * filter) won't collide.
 *
 * Same pattern as `app/dashboard/companies/_components/filters-bar.tsx`:
 *   - Radix Select doesn't accept empty-string values, so we use an
 *     `__all__` sentinel for the "no filter" entry and treat it
 *     specially when writing to the URL.
 *   - URL writes happen inside `useTransition` so the Server Component
 *     re-fetch streams without blocking the click.
 *   - `router.push({ scroll: false })` keeps the user at the documents
 *     section instead of jumping to the top of the page.
 *
 * Why a Client Component:
 *   - Select dropdowns need open/close state
 *   - URL writes use `useRouter().push()`
 *
 * The actual filtering happens server-side: `DocumentsSection` reads
 * the URL params and passes them to `listDocumentsForCompany`, which
 * validates them against the existing `documentStatusSchema` /
 * `documentTypeSchema` enums.
 *
 * @module app/dashboard/companies/[id]/_components/documents-filters-bar
 */
"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { X } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import {
  DOCUMENT_STATUS_LABELS,
  DOCUMENT_TYPE_LABELS,
} from "@/lib/documents/labels";
import type { DocumentStatus, DocumentType } from "@/lib/db/schema";

// ── Constants ───────────────────────────────────────────────────────────────

/**
 * Sentinel for "no filter selected" in Radix Select (which refuses
 * empty-string values). Mirrors the companies filter-bar convention.
 */
const ALL_VALUE = "__all__";

/**
 * URL search-param keys. Namespaced (`documentStatus`, not `status`) so
 * future filter sets on this page can coexist without collision.
 */
const STATUS_PARAM = "documentStatus";
const TYPE_PARAM = "documentType";

// Static option arrays. Cast through the typed labels keys so adding a
// new DocumentStatus / DocumentType value to the schema produces a TS
// error if it's missed here (the labels object key would be missing).
const STATUS_OPTIONS = Object.entries(DOCUMENT_STATUS_LABELS) as Array<
  [DocumentStatus, string]
>;

const TYPE_OPTIONS = Object.entries(DOCUMENT_TYPE_LABELS) as Array<
  [DocumentType, string]
>;

// ── Component ───────────────────────────────────────────────────────────────

export function DocumentsFiltersBar() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const statusValue = searchParams.get(STATUS_PARAM) ?? ALL_VALUE;
  const typeValue = searchParams.get(TYPE_PARAM) ?? ALL_VALUE;

  const hasActiveFilters =
    statusValue !== ALL_VALUE || typeValue !== ALL_VALUE;

  /**
   * Write a single key into the URL. Empty/`ALL_VALUE` removes the key.
   * The companies filters-bar also resets the page index on filter
   * change; the documents section has no pagination, so nothing to
   * reset here.
   */
  function pushParam(key: string, value: string | undefined) {
    const next = new URLSearchParams(searchParams.toString());
    if (!value || value === ALL_VALUE) {
      next.delete(key);
    } else {
      next.set(key, value);
    }
    const qs = next.toString();
    const target = qs ? `${pathname}?${qs}` : pathname;

    startTransition(() => {
      router.push(target, { scroll: false });
    });
  }

  function clearAll() {
    const next = new URLSearchParams(searchParams.toString());
    next.delete(STATUS_PARAM);
    next.delete(TYPE_PARAM);
    const qs = next.toString();
    const target = qs ? `${pathname}?${qs}` : pathname;

    startTransition(() => {
      router.push(target, { scroll: false });
    });
  }

  return (
    <div
      className="flex flex-wrap items-center gap-3 border-b border-border bg-card px-4 py-3"
      aria-busy={isPending || undefined}
    >
      {/* Status */}
      <Select
        value={statusValue}
        onValueChange={(v) =>
          pushParam(STATUS_PARAM, v === ALL_VALUE ? undefined : v)
        }
      >
        <SelectTrigger
          className="w-full sm:w-[12rem]"
          aria-label="Filter documents by status"
        >
          <SelectValue placeholder="All statuses" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_VALUE}>All statuses</SelectItem>
          {STATUS_OPTIONS.map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Document type */}
      <Select
        value={typeValue}
        onValueChange={(v) =>
          pushParam(TYPE_PARAM, v === ALL_VALUE ? undefined : v)
        }
      >
        <SelectTrigger
          className="w-full sm:w-[14rem]"
          aria-label="Filter documents by type"
        >
          <SelectValue placeholder="All types" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_VALUE}>All types</SelectItem>
          {TYPE_OPTIONS.map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
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
          Clear
        </Button>
      )}
    </div>
  );
}
