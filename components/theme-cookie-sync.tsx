/**
 * ThemeCookieSync — keeps `next-themes`' localStorage value mirrored in
 * a cookie so Server Components can read the user's palette on the next
 * page render.
 *
 * Mounts once near the top of the tree (right after `<ThemeProvider>`).
 * Subscribes to `useTheme().theme` changes via a tiny effect; whenever
 * the value changes, writes the cookie via `document.cookie =`. No render
 * output — purely a side-effect.
 *
 * Why not handle this inside `ThemeProvider` itself? Two reasons:
 *   - ThemeProvider is a re-export of next-themes' provider; wrapping it
 *     in another effect would mean rendering the children twice.
 *   - Splitting the concern makes the cookie behaviour easy to delete or
 *     replace (e.g. swap for a DB write once user_preferences lands).
 *
 * @module components/theme-cookie-sync
 */
"use client";

import { useEffect } from "react";
import { useTheme } from "next-themes";
import { buildThemeCookieString } from "@/lib/themes-cookie";

export function ThemeCookieSync() {
  const { theme } = useTheme();

  useEffect(() => {
    // `theme` is `undefined` on the very first render (before next-themes'
    // inline script runs). Skip then — we already have the right cookie
    // from the previous page load, so no write is needed.
    if (!theme) return;
    document.cookie = buildThemeCookieString(theme);
  }, [theme]);

  return null;
}
