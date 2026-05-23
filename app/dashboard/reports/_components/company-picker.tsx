/**
 * CompanyPicker — narrow the report to a single company, or "All
 * companies" for the cross-platform aggregate.
 *
 * Client Component. URL-shaped state: every change rewrites `?companyId=`
 * via `router.replace` and the parent Server Component re-renders with
 * the new value. Same pattern as the period-picker — no client-side
 * mirror, deep-linkable, browser-back/forward-compatible.
 *
 * Layout: sits next to the period picker. At Phase-1 scale (<30
 * companies in the seed) the native `<select>` is plenty — no
 * typeahead. If the roster grows past a few hundred, swap to the
 * search-enabled combobox the tenders / projects filter bars use.
 *
 * @module app/dashboard/reports/_components/company-picker
 */
"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useId, type ChangeEvent } from "react";

export interface CompanyPickerOption {
  id: string;
  name: string;
}

export interface CompanyPickerProps {
  /** All companies the viewer can scope the report to. */
  options: CompanyPickerOption[];
  /** Currently selected companyId, or `undefined` for "All companies". */
  value: string | undefined;
}

export function CompanyPicker({ options, value }: CompanyPickerProps) {
  const router = useRouter();
  const params = useSearchParams();
  const selectId = useId();

  function handleChange(event: ChangeEvent<HTMLSelectElement>): void {
    const next = event.target.value;
    const query = new URLSearchParams(params?.toString() ?? "");
    if (next === "") {
      query.delete("companyId");
    } else {
      query.set("companyId", next);
    }
    router.replace(`/dashboard/reports?${query.toString()}`, { scroll: false });
  }

  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={selectId}
        className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        Company
      </label>
      <select
        id={selectId}
        value={value ?? ""}
        onChange={handleChange}
        className="h-9 min-w-[14rem] rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <option value="">All companies</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
    </div>
  );
}
