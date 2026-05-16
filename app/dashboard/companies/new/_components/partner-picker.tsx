/**
 * PartnerPicker — typeahead multi-select for JV partner companies.
 *
 * Used in the company form when the "Is JV?" toggle is on. The user
 * must select at least 2 existing companies that form the joint
 * venture; the Zod superRefine in `createCompanySchema` enforces this
 * server-side too.
 *
 * UX shape:
 *   - Selected partners render as removable chips at the top
 *   - A search input filters the list of available companies as you
 *     type (substring match, case-insensitive)
 *   - The list shows up to 50 results — beyond that, the user needs
 *     to type more to narrow
 *   - Checking a row adds it to the selection; unchecking removes
 *
 * Why a custom component vs a generic combobox:
 *   - We need a permanent list view (not a dropdown that closes after
 *     each selection) so picking 3-4 partners doesn't require 4
 *     re-opens of a popover
 *   - The selection summary lives outside the list so the user can see
 *     what they've picked at all times without scrolling
 *
 * Controlled component — value and onChange managed by the parent
 * (typically a react-hook-form Controller). State lives entirely in
 * props; the only local state is the search query.
 *
 * @module app/dashboard/companies/new/_components/partner-picker
 */
"use client";

import { useMemo, useState } from "react";
import { Search, X, Check } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

// ── Props ───────────────────────────────────────────────────────────────────

export interface PartnerPickerProps {
  /** All existing companies, in display order. id+name only. */
  options: Array<{ id: string; name: string }>;

  /** Currently-selected partner IDs. */
  value: string[];

  /** Called with the new list whenever selection changes. */
  onChange: (next: string[]) => void;

  /** When true, the picker is read-only (during submission). */
  disabled?: boolean;
}

// ── Constants ───────────────────────────────────────────────────────────────

/**
 * Cap the visible-list size so very large company directories don't
 * render thousands of rows. If a user has 50+ companies and can't find
 * theirs in the first 50, they should type to narrow.
 */
const MAX_VISIBLE_ROWS = 50;

// ── Component ───────────────────────────────────────────────────────────────

export function PartnerPicker({
  options,
  value,
  onChange,
  disabled,
}: PartnerPickerProps) {
  const [query, setQuery] = useState("");

  // Pre-compute a Set of selected IDs for O(1) lookup during list render.
  const selectedSet = useMemo(() => new Set(value), [value]);

  // Filter + cap the list. Memo because `options` is stable and `query`
  // changes per keystroke — recompute only when one of those moves.
  const filteredOptions = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    const matches = trimmed
      ? options.filter((o) => o.name.toLowerCase().includes(trimmed))
      : options;
    return matches.slice(0, MAX_VISIBLE_ROWS);
  }, [options, query]);

  // Selected options as full objects, for the chips strip.
  const selectedOptions = useMemo(
    () => options.filter((o) => selectedSet.has(o.id)),
    [options, selectedSet],
  );

  // ── Handlers ──────────────────────────────────────────────────────────────

  function togglePartner(id: string) {
    if (disabled) return;
    if (selectedSet.has(id)) {
      onChange(value.filter((v) => v !== id));
    } else {
      onChange([...value, id]);
    }
  }

  function removePartner(id: string) {
    if (disabled) return;
    onChange(value.filter((v) => v !== id));
  }

  // Whether we're hiding rows due to the cap. Affects the helper line
  // at the bottom of the list.
  const trimmed = query.trim().toLowerCase();
  const allMatchCount = trimmed
    ? options.filter((o) => o.name.toLowerCase().includes(trimmed)).length
    : options.length;
  const isCapped = allMatchCount > MAX_VISIBLE_ROWS;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-3">
      {/* Selected partners — chips strip. Shown above the search so the
          current selection state is always visible. */}
      {selectedOptions.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-2"
          aria-label="Selected partners"
        >
          {selectedOptions.map((opt) => (
            <span
              key={opt.id}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
                "bg-accent/10 text-accent",
              )}
            >
              {opt.name}
              {!disabled && (
                <button
                  type="button"
                  onClick={() => removePartner(opt.id)}
                  aria-label={`Remove ${opt.name}`}
                  className="rounded-full hover:bg-accent/20"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {/* Search input */}
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search companies..."
          aria-label="Search partner companies"
          disabled={disabled}
          className="pl-9"
        />
      </div>

      {/* Options list. Bordered box, scrolls if it grows. The max-h-64
          keeps the picker from dominating the form's vertical space. */}
      <div
        role="listbox"
        aria-multiselectable
        aria-label="Available partner companies"
        className="max-h-64 overflow-y-auto rounded-md border border-border bg-card"
      >
        {options.length === 0 ? (
          <div className="px-3 py-4 text-center text-sm text-muted-foreground">
            No companies exist yet. Create at least two standalone
            companies before forming a JV.
          </div>
        ) : filteredOptions.length === 0 ? (
          <div className="px-3 py-4 text-center text-sm text-muted-foreground">
            No companies match &quot;{query}&quot;.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {filteredOptions.map((opt) => {
              const isSelected = selectedSet.has(opt.id);
              return (
                <li key={opt.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => togglePartner(opt.id)}
                    disabled={disabled}
                    className={cn(
                      "flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors",
                      "hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50",
                      isSelected && "bg-accent/5",
                    )}
                  >
                    <Checkbox
                      checked={isSelected}
                      tabIndex={-1}
                      aria-hidden
                      disabled={disabled}
                    />
                    <span className="flex-1 text-foreground">{opt.name}</span>
                    {isSelected && (
                      <Check
                        className="h-4 w-4 text-accent"
                        aria-hidden
                      />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {isCapped && (
          <div className="border-t border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            Showing {MAX_VISIBLE_ROWS} of {allMatchCount} matches. Refine
            your search to see more.
          </div>
        )}
      </div>

      {/* Selection summary — tells the user where they stand against the
          "2 partners minimum" rule. Color shifts to terracotta if they're
          short of the minimum, soft once they've satisfied it. */}
      <p
        className={cn(
          "text-xs",
          selectedOptions.length >= 2
            ? "text-muted-foreground"
            : "text-accent",
        )}
      >
        {selectedOptions.length === 0
          ? "No partners selected. Pick at least 2 to form a JV."
          : selectedOptions.length === 1
            ? "1 partner selected. Pick at least 1 more to form a JV."
            : `${selectedOptions.length} partners selected.`}
      </p>
    </div>
  );
}
