/**
 * Theme cookie helpers — server + client side reads / writes.
 *
 * Why a cookie at all? `next-themes` ships with localStorage persistence,
 * which is invisible to Server Components. Without a cookie the layout
 * always renders the default palette on first paint, then `next-themes`'
 * inline script repaints once it reads localStorage. The flash is small
 * but noticeable on slow connections. A cookie lets the server know the
 * user's preferred palette before it sends the first byte of HTML.
 *
 * Strategy: parallel writes. When the user picks a theme, we write both
 * localStorage (handled by `next-themes` itself) AND a cookie (handled
 * by `<ThemeCookieSync>` in components/theme-cookie-sync.tsx). On the
 * next page render, the layout reads the cookie and emits `<html
 * data-theme="...">` with the right value — no flash. The cookie is also
 * read by middleware-style helpers if we want to render the right
 * palette in PDF exports or emails later.
 *
 * The cookie is non-httpOnly because the client also reads/writes it.
 * That's fine for a theme id — it's not security-sensitive.
 *
 * @module lib/themes-cookie
 */
import { DEFAULT_THEME, THEME_IDS } from "@/lib/themes";

/** Cookie name. Prefixed `cw-` to avoid collisions on shared domains. */
export const THEME_COOKIE = "cw-theme";

/** One year — palettes are sticky preferences, not session state. */
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Validate a raw cookie value against the known theme catalog. Returns
 * the default theme on any mismatch — covers a stale cookie from a
 * removed palette, garbage input, or undefined.
 */
export function resolveThemeFromCookie(raw: string | undefined): string {
  if (!raw) return DEFAULT_THEME;
  return THEME_IDS.includes(raw) ? raw : DEFAULT_THEME;
}

/**
 * Build the `Set-Cookie` value string written on the client. Centralised
 * here so the cookie's flags don't drift between writers.
 *
 * Flags:
 *   path=/        — every route reads it
 *   max-age=…     — 1 year sticky
 *   SameSite=Lax  — allow cross-site GETs (e.g. link from email) to
 *                   still see the right theme on first paint
 */
export function buildThemeCookieString(themeId: string): string {
  return `${THEME_COOKIE}=${themeId}; path=/; max-age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax`;
}
