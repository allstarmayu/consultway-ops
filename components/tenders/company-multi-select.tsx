/**
 * Company multi-select — a searchable checkbox list for picking the companies
 * invited to an `invited`-visibility tender.
 *
 * Deliberately lightweight: no combobox/popover primitive exists in the kit,
 * and at Phase-1 roster scale (<200 companies) an inline, searchable checkbox
 * list is clearer than a typeahead. Controlled component — the parent (the
 * tender form's `invitedCompanyIds` Controller) owns the selected-id array.
 *
 * @module components/tenders/company-multi-select
 */
"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface CompanyMultiSelectOption {
  id: string;
  name: string;
}

export interface CompanyMultiSelectProps {
  /** Companies that may be invited (id + name). Parent fetches this list. */
  options: CompanyMultiSelectOption[];
  /** Currently-selected company ids. */
  value: string[];
  /** Called with the next selected-id array on every toggle. */
  onChange: (ids: string[]) => void;
  /** Disables search + all checkboxes (e.g. a locked, published tender). */
  disabled?: boolean;
  /** id for the search input — lets the surrounding FormField label wire up. */
  id?: string;
}

export function CompanyMultiSelect({
  options,
  value,
  onChange,
  disabled,
  id,
}: CompanyMultiSelectProps) {
  const [query, setQuery] = useState("");
  const selected = useMemo(() => new Set(value), [value]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.name.toLowerCase().includes(q));
  }, [options, query]);

  function toggle(companyId: string): void {
    if (disabled) return;
    if (selected.has(companyId)) {
      onChange(value.filter((v) => v !== companyId));
    } else {
      onChange([...value, companyId]);
    }
  }

  return (
    <div
      className={cn(
        "rounded-lg border border-input bg-background",
        disabled && "opacity-60",
      )}
    >
      {/* Search */}
      <div className="relative border-b border-border p-2">
        <Search
          className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          id={id}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search companies..."
          className="pl-8"
          disabled={disabled}
        />
      </div>

      {/* List */}
      <div
        className="max-h-64 overflow-y-auto p-1"
        role="group"
        aria-label="Invited companies"
      >
        {options.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            No companies available to invite.
          </p>
        ) : filtered.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            No companies match “{query}”.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {filtered.map((o) => (
              <li key={o.id}>
                <label
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-muted/50",
                    disabled ? "cursor-not-allowed" : "cursor-pointer",
                  )}
                >
                  <Checkbox
                    checked={selected.has(o.id)}
                    onCheckedChange={() => toggle(o.id)}
                    disabled={disabled}
                  />
                  <span className="flex-1 text-foreground">{o.name}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Selected-count footer */}
      <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
        {value.length === 0
          ? "No companies selected"
          : `${value.length} ${value.length === 1 ? "company" : "companies"} selected`}
      </div>
    </div>
  );
}
