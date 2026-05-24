/**
 * ThemePickerList — shared swatch-row rendering for the 6-palette picker.
 *
 * Two surfaces consume this:
 *   - `components/dashboard/user-pill.tsx` — sidebar quick-switcher
 *     inside the user dropdown. Handler writes through to the DB via
 *     `updatePreferences`.
 *   - `components/theme-picker-dropdown.tsx` — unauthenticated picker
 *     on /login and /register. Handler only writes the cookie (no DB
 *     persist, since the user isn't signed in).
 *
 * The list itself is handler-agnostic: it takes `activeThemeId` +
 * `onSelect` and renders one `DropdownMenuItem` per palette with the
 * tiny swatch-trio fingerprint + active-checkmark. Consumers wrap the
 * list with their own DropdownMenuGroup / DropdownMenuLabel /
 * separators so the surrounding chrome stays under their control.
 *
 * Why a list-only component (not a full dropdown): the two surfaces
 * have different siblings inside their dropdown (user-pill has
 * Settings + Sign out; the login picker has nothing else). Extracting
 * the whole dropdown would force one of them into the other's shape.
 *
 * @module components/theme-picker-list
 */
"use client";

import { Check } from "lucide-react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { THEMES } from "@/lib/themes";

export interface ThemePickerListProps {
  /** The currently-active theme id, or undefined while next-themes
   * hasn't yet hydrated. The check icon hides when undefined. */
  activeThemeId: string | undefined;
  /** Fired with the picked theme's id when the user selects a row. */
  onSelect: (id: string) => void;
}

export function ThemePickerList({
  activeThemeId,
  onSelect,
}: ThemePickerListProps) {
  return (
    <>
      {THEMES.map((t) => {
        const isActive = activeThemeId === t.id;
        return (
          <DropdownMenuItem
            key={t.id}
            onSelect={(e) => {
              // onSelect closes the menu by default; we WANT that
              // here (it's a one-click action), but we also want to
              // run our handler before the dismiss.
              e.preventDefault();
              onSelect(t.id);
            }}
            className="gap-2"
          >
            {/* Tiny swatch trio — gives the dropdown a visual
                fingerprint per palette without ballooning the row.
                Indexes 0/2/3 chosen empirically for the most
                recognisable spread across all 6 palettes. */}
            <span
              className="flex h-4 w-7 shrink-0 overflow-hidden rounded-sm ring-1 ring-border"
              aria-hidden
            >
              <span
                className="h-full flex-1"
                style={{ background: t.swatches[0] }}
              />
              <span
                className="h-full flex-1"
                style={{ background: t.swatches[2] }}
              />
              <span
                className="h-full flex-1"
                style={{ background: t.swatches[3] }}
              />
            </span>
            <span className="flex-1 truncate">{t.name}</span>
            {isActive && (
              <Check
                className="h-3.5 w-3.5 text-accent"
                aria-hidden
                strokeWidth={3}
              />
            )}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}
