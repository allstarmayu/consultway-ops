/**
 * ThemePickerDropdown — small standalone palette switcher for the
 * unauthenticated entry points (/login and /register).
 *
 * Why this exists: Day 26's gradient backdrop on the auth pages tracks
 * the `cw-theme` cookie SSR-side, so returning visitors land on their
 * picked palette automatically. But a first-time visitor sees the
 * default (Warm Ambient) and has no way to preview the alternatives
 * before signing in. This picker closes that gap.
 *
 * What it does:
 *   - Renders a small Palette-icon button in the corner of the page.
 *   - Opens a dropdown with the 6-palette swatch list (shared with
 *     the in-app user-pill picker via `ThemePickerList`).
 *   - On select: calls `setTheme(id)` so next-themes flips the live
 *     palette, and writes the `cw-theme` cookie directly so a full
 *     page reload (or the next render after sign-in) picks up the
 *     new value SSR-side. No DB write — the user isn't signed in.
 *
 * What it does NOT do: it does NOT call `updatePreferences` (the
 * Server Action would reject an unauthenticated caller anyway). The
 * cookie is enough for the gradient and for first-paint after sign-in.
 * Once the user signs in, AppearanceSection writes the same cookie
 * value through to the DB on their next theme change — so the choice
 * eventually durably persists without us forcing it here.
 *
 * @module components/theme-picker-dropdown
 */
"use client";

import { useTheme } from "next-themes";
import { Palette } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ThemePickerList } from "@/components/theme-picker-list";
import { buildThemeCookieString } from "@/lib/themes-cookie";
import { cn } from "@/lib/utils";

export interface ThemePickerDropdownProps {
  /** Override the trigger's positioning if the default `absolute
   * top-4 right-4` doesn't fit the host page's layout. */
  className?: string;
}

export function ThemePickerDropdown({ className }: ThemePickerDropdownProps) {
  const { theme, setTheme } = useTheme();

  function handleSelectTheme(id: string) {
    if (id === theme) return;
    setTheme(id);
    // Write the cookie directly. ThemeCookieSync (mounted at the root)
    // would do this on the next render too, but writing here means a
    // full page reload immediately after the click also sees the new
    // value — defends against the "race between client write and full
    // navigation" footgun that bit us in the stale-session work.
    document.cookie = buildThemeCookieString(id);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          // Default position: absolute top-right. Hosts can override
          // via `className` to drop into their own layout if needed.
          "absolute right-4 top-4 z-10 flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors",
          "hover:bg-muted hover:text-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          className,
        )}
        aria-label="Choose a theme"
      >
        <Palette className="h-4 w-4" aria-hidden />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" sideOffset={8} className="w-56">
        <DropdownMenuLabel className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
          <Palette className="h-3.5 w-3.5" aria-hidden />
          Theme
        </DropdownMenuLabel>
        <DropdownMenuGroup>
          <ThemePickerList
            activeThemeId={theme}
            onSelect={handleSelectTheme}
          />
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
