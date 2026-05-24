/**
 * User pill — bottom-of-sidebar identity widget + quick-action dropdown.
 *
 * Day 25: grew from a static "email + role + sign-out" strip into a
 * dropdown trigger. The trigger still shows the same identity row, but
 * clicking it opens a menu with:
 *   - A theme submenu (palette quick-switcher, mirrors the picker in
 *     /dashboard/settings — same `setTheme` + `updatePreferences` flow,
 *     just compressed into menu rows).
 *   - A "Settings" link to /dashboard/settings.
 *   - The "Sign out" button (kept as a `form action={logout}` so the
 *     progressive-enhancement contract survives JS-disabled environments).
 *
 * Why a flat dropdown (not a sub-menu) for themes: 6 palettes is short
 * enough to inline. A sub-menu would add a click + a hover-intent delay
 * for no real value at this size.
 *
 * Theme writes are dual: `setTheme(id)` triggers the visual swap +
 * cookie sync via the existing `ThemeCookieSync` watcher, and the
 * `updatePreferences({ themeId })` action persists to the DB so the
 * choice survives a cookie clear. Failures roll back the visual state.
 *
 * @module components/dashboard/user-pill
 */
"use client";

import { useTransition } from "react";
import { useTheme } from "next-themes";
import Link from "next/link";
import { LogOut, Palette, Settings, UserCircle2 } from "lucide-react";
import { toast } from "sonner";
import { logout } from "@/lib/auth/actions";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ThemePickerList } from "@/components/theme-picker-list";
import { updatePreferences } from "@/lib/preferences/actions";
import {
  buildStaleSessionRedirectUrl,
  isStaleSessionError,
} from "@/lib/auth/stale-session";
import { getThemeById } from "@/lib/themes";
import { cn } from "@/lib/utils";
import type { UserRole } from "@/lib/db/schema";

export interface UserPillProps {
  /** Email shown as the primary identity label. */
  email: string;
  /** Role badge text below the email. */
  role: UserRole;
}

export function UserPill({ email, role }: UserPillProps) {
  const { theme, setTheme } = useTheme();
  const [, startTransition] = useTransition();

  function handleSelectTheme(id: string) {
    if (id === theme) return;
    const previous = theme;
    setTheme(id);
    const next = getThemeById(id);
    if (next) {
      // Shared id with the Appearance section's theme picker — cycling
      // palettes from either surface refreshes one toast in place
      // rather than stacking a deck of "Theme set to …" cards.
      toast.success(`Theme set to ${next.name}`, { id: "theme-change" });
    }
    startTransition(async () => {
      const result = await updatePreferences({ themeId: id });
      if (!result.ok) {
        toast.error("Couldn't save theme", {
          id: "theme-save-error",
          description: result.error,
        });
        if (previous) setTheme(previous);
        if (isStaleSessionError(result.error)) {
          // Hard-nav so proxy.ts sees the deleted cookie on the next
          // request instead of bouncing the user back to /dashboard.
          window.location.assign(buildStaleSessionRedirectUrl());
        }
      }
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "group flex w-full items-center gap-3 rounded-md p-1 text-left transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar",
          "hover:bg-sidebar-accent data-[state=open]:bg-sidebar-accent",
        )}
      >
        {/* Avatar circle. No image upload yet; renders a generic icon. */}
        <div
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
            "bg-sidebar-accent text-sidebar-accent-foreground group-hover:bg-sidebar/40",
          )}
          aria-hidden
        >
          <UserCircle2 className="h-5 w-5" />
        </div>

        {/* Identity labels. `min-w-0` allows the truncate to actually
            take effect — without it, the flex item refuses to shrink. */}
        <div className="min-w-0 flex-1">
          <p
            className="truncate text-sm font-medium text-sidebar-foreground"
            title={email}
          >
            {email}
          </p>
          <p className="mt-0.5 text-xs capitalize text-sidebar-foreground/60">
            {role}
          </p>
        </div>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-64"
      >
        {/* ── Quick links ───────────────────────────────────────────── */}
        <DropdownMenuGroup>
          <DropdownMenuItem asChild>
            <Link href="/dashboard/settings">
              <Settings className="h-4 w-4" aria-hidden />
              <span>Settings</span>
            </Link>
          </DropdownMenuItem>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        {/* ── Theme picker ─────────────────────────────────────────── */}
        <DropdownMenuLabel className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
          <Palette className="h-3.5 w-3.5" aria-hidden />
          Theme
        </DropdownMenuLabel>
        <DropdownMenuGroup>
          {/* Shared swatch-list rendering. Kept here as a group so the
              dropdown's structure (Settings → separator → Theme →
              separator → Sign out) stays under user-pill's control. */}
          <ThemePickerList
            activeThemeId={theme}
            onSelect={handleSelectTheme}
          />
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        {/* ── Sign out ─────────────────────────────────────────────── */}
        <DropdownMenuItem asChild variant="destructive">
          <form action={logout} className="w-full">
            <button
              type="submit"
              className="flex w-full items-center gap-2 text-left"
            >
              <LogOut className="h-4 w-4" aria-hidden />
              <span>Sign out</span>
            </button>
          </form>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
