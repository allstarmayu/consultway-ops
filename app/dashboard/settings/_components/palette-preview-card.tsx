/**
 * PalettePreviewCard — single palette tile in the Appearance picker.
 *
 * Renders a stack of 5 swatches + name + description + "Dark" pill when
 * applicable, plus a framer-motion check overlay on the active card.
 * Whole thing is a `<button>` so keyboard nav / focus rings work out of
 * the box.
 *
 * The thumbnail composites the 5 swatches as horizontal slices —
 * positions match the index in `ThemeOption.swatches`:
 *   0 background, 1 card surface, 2 accent, 3 secondary text, 4 border.
 *
 * @module app/dashboard/settings/_components/palette-preview-card
 */
"use client";

import { motion } from "motion/react";
import { Check, MoonStar, Sun } from "lucide-react";
import type { ThemeOption } from "@/lib/themes";
import { cn } from "@/lib/utils";

export interface PalettePreviewCardProps {
  theme: ThemeOption;
  isActive: boolean;
  onSelect: (id: string) => void;
}

export function PalettePreviewCard({
  theme,
  isActive,
  onSelect,
}: PalettePreviewCardProps) {
  const ModeIcon = theme.mode === "dark" ? MoonStar : Sun;

  return (
    <motion.button
      type="button"
      onClick={() => onSelect(theme.id)}
      aria-pressed={isActive}
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.985 }}
      transition={{ type: "spring", stiffness: 350, damping: 22 }}
      className={cn(
        "group relative flex flex-col gap-3 rounded-xl border bg-card p-3 text-left transition-shadow",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        isActive
          ? "border-accent shadow-[0_0_0_1px_var(--accent)]"
          : "border-border hover:shadow-md",
      )}
    >
      {/* Active checkmark — animates in via framer-motion. */}
      {isActive && (
        <motion.span
          initial={{ scale: 0, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 380, damping: 18 }}
          className="absolute right-3 top-3 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-accent text-accent-foreground shadow"
          aria-hidden
        >
          <Check className="h-3.5 w-3.5" strokeWidth={3} />
        </motion.span>
      )}

      {/* Thumbnail — mini-render of the palette. */}
      <div
        className="relative h-20 w-full overflow-hidden rounded-lg ring-1 ring-border"
        style={{ background: theme.swatches[0] }}
      >
        {/* Faux card on the surface */}
        <div
          className="absolute left-2 top-2 h-[calc(100%-1rem)] w-[60%] rounded-md p-1.5"
          style={{ background: theme.swatches[1] }}
        >
          {/* Faux content rows */}
          <div
            className="h-1.5 w-2/3 rounded-full"
            style={{ background: theme.swatches[3], opacity: 0.7 }}
          />
          <div
            className="mt-1 h-1.5 w-1/2 rounded-full"
            style={{ background: theme.swatches[4] }}
          />
          <div
            className="mt-1 h-1.5 w-3/4 rounded-full"
            style={{ background: theme.swatches[4] }}
          />
          {/* Faux accent CTA */}
          <div
            className="mt-2 h-2.5 w-12 rounded"
            style={{ background: theme.swatches[2] }}
          />
        </div>
        {/* Sidebar shadow */}
        <div
          className="absolute right-2 top-2 h-[calc(100%-1rem)] w-[24%] rounded-md"
          style={{
            background: theme.swatches[3],
            opacity: 0.85,
          }}
        />
      </div>

      {/* Label row */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">
            {theme.name}
          </p>
          <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground">
            {theme.description}
          </p>
        </div>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground",
          )}
          aria-label={`${theme.mode} mode`}
        >
          <ModeIcon className="h-2.5 w-2.5" aria-hidden />
          {theme.mode === "dark" ? "Dark" : "Light"}
        </span>
      </div>
    </motion.button>
  );
}
