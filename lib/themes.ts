/**
 * Theme catalog — single source of truth for the 6 palettes the app ships.
 *
 * Each entry pairs the next-themes `id` (the class name applied to <html>)
 * with display metadata + a 5-swatch preview the Settings palette picker
 * uses to render thumbnail cards. Swatches are plain hex strings so the
 * picker can use them in `style={{ background }}` without depending on the
 * runtime CSS variables being set yet (the active theme's vars are live
 * everywhere, but the *other* themes' vars aren't).
 *
 * Hex values are approximate sRGB conversions of the oklch values defined
 * in app/globals.css. They drift slightly under wide-gamut rendering but
 * are accurate enough for a 28px swatch.
 *
 * Adding a theme:
 *   1. Define the `.theme-<id>` block in app/globals.css with all vars.
 *   2. Add an entry here.
 *   3. The themes array passed to <ThemeProvider> (lib/themes.ts -> THEME_IDS)
 *      auto-includes it, so no other wiring is needed.
 *
 * @module lib/themes
 */

export type ThemeMode = "light" | "dark";

/** One palette entry. */
export interface ThemeOption {
  /** Class name applied to <html> via next-themes. Must match the CSS selector. */
  id: string;
  /** Short display label shown on the picker card. */
  name: string;
  /** One-line description shown under the name on the picker card. */
  description: string;
  /** Whether this palette is light or dark. Drives the "Dark" pill on cards. */
  mode: ThemeMode;
  /**
   * 5 hex swatches used as the preview thumbnail (left → right):
   * [background, card/surface, accent, secondary text, border].
   * Order matters; the picker reads positionally.
   */
  swatches: [string, string, string, string, string];
}

/**
 * The catalog. Order here is the order shown in the picker grid.
 * "warm-ambient" stays first so the default is always the first card.
 */
export const THEMES: readonly ThemeOption[] = [
  {
    id: "warm-ambient",
    name: "Warm Ambient",
    description: "Espresso, parchment, and a quiet terracotta accent.",
    mode: "light",
    swatches: ["#FDFAF6", "#FFFFFF", "#B85C38", "#7A6652", "#EDE5D8"],
  },
  {
    id: "midnight-espresso",
    name: "Midnight Espresso",
    description: "The warm-ambient palette inverted into a dark mode.",
    mode: "dark",
    swatches: ["#1E170D", "#2A1F12", "#D17A4F", "#B0A18A", "#3A2C1B"],
  },
  {
    id: "slate-pro",
    name: "Slate Pro",
    description: "Cool slate neutrals with a precise blue accent.",
    mode: "light",
    swatches: ["#FBFCFE", "#FFFFFF", "#3B6FE0", "#5B6577", "#E2E5EC"],
  },
  {
    id: "forest-calm",
    name: "Forest Calm",
    description: "Sage cream surfaces, deep forest text, emerald accent.",
    mode: "light",
    swatches: ["#F8F6EE", "#FFFFFF", "#2EA875", "#5C6D58", "#E1DDC9"],
  },
  {
    id: "ocean-depth",
    name: "Ocean Depth",
    description: "Deep navy, soft fog text, a bright cyan accent.",
    mode: "dark",
    swatches: ["#0E1C2E", "#192A3F", "#41B5D8", "#7A93B3", "#2D3F58"],
  },
  {
    id: "sunset-glow",
    name: "Sunset Glow",
    description: "Soft peach surfaces, plum text, warm coral accent.",
    mode: "light",
    swatches: ["#FBEFE5", "#FFFFFF", "#D86846", "#8E5B4A", "#ECDDD0"],
  },
] as const;

/** Stable list of theme ids — passed to <ThemeProvider themes={...}>. */
export const THEME_IDS: readonly string[] = THEMES.map((t) => t.id);

/** Default theme used when nothing is stored yet. */
export const DEFAULT_THEME = "warm-ambient" as const;

/** Lookup helper — returns undefined for unknown ids (defensive). */
export function getThemeById(id: string | undefined): ThemeOption | undefined {
  return THEMES.find((t) => t.id === id);
}
