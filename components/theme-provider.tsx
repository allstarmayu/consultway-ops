/**
 * ThemeProvider — wraps the app in `next-themes` with our 6-palette setup.
 *
 * Why a thin wrapper:
 *   - Keeps the `"use client"` boundary out of `app/layout.tsx` (which
 *     stays a Server Component).
 *   - Centralises the themes array + attribute strategy so every consumer
 *     gets the same configuration without duplicating constants.
 *
 * Strategy: `attribute="data-theme"` writes the active theme id onto
 * <html data-theme="..."> on every change. Combined with the per-theme
 * `[data-theme="<id>"] { ... }` blocks in app/globals.css that gives
 * instantaneous swaps without a reflow. The two dark palettes also fire
 * shadcn's `dark:` utility variants — handled by the `@custom-variant
 * dark (...)` rule in globals.css, no extra class mirroring needed here.
 *
 * `enableSystem={false}` because our themes aren't a simple light/dark
 * pair — there's no single "best dark" to map system preference to.
 *
 * @module components/theme-provider
 */
"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";
import { DEFAULT_THEME, THEME_IDS } from "@/lib/themes";

type NextThemesProviderProps = ComponentProps<typeof NextThemesProvider>;

export interface ThemeProviderOwnProps {
  /**
   * Initial theme id, read from the `cw-theme` cookie in
   * `app/layout.tsx` and passed in so SSR and client agree on first
   * paint. Falls back to {@link DEFAULT_THEME} when omitted.
   */
  initialTheme?: string;
}

export function ThemeProvider({
  children,
  initialTheme,
  ...props
}: Omit<NextThemesProviderProps, "themes" | "attribute" | "defaultTheme"> &
  ThemeProviderOwnProps) {
  return (
    <NextThemesProvider
      attribute="data-theme"
      defaultTheme={initialTheme ?? DEFAULT_THEME}
      themes={[...THEME_IDS]}
      enableSystem={false}
      disableTransitionOnChange={false}
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}
