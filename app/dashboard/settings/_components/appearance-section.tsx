/**
 * AppearanceSection — theme picker + density + motion preferences.
 *
 * Theme changes are LIVE — clicking a palette tile applies it instantly
 * via `next-themes`, with no save step. Persistence is dual:
 *   1. `<ThemeCookieSync>` (mounted at the root) writes the cookie so
 *      SSR paints the right palette on the next page load.
 *   2. The action layer below (`updatePreferences({ themeId })`) persists
 *      the choice to the `user_preferences` table so it survives a
 *      cookie clear / device switch.
 *
 * Density + reduced-motion changes write through to both the live DOM
 * (so the change takes effect immediately without a re-render) AND the
 * DB (so they persist). Database writes are non-blocking — we don't
 * spin the UI on the round-trip; failures surface via a toast and we
 * roll back the local state.
 *
 * @module app/dashboard/settings/_components/appearance-section
 */
"use client";

import { useEffect, useState, useTransition } from "react";
import { useTheme } from "next-themes";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Sparkles } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { THEMES, DEFAULT_THEME, getThemeById } from "@/lib/themes";
import { updatePreferences } from "@/lib/preferences/actions";
import {
  buildStaleSessionRedirectUrl,
  isStaleSessionError,
} from "@/lib/auth/stale-session";
import type { UserPreferences } from "@/lib/db/schema";
import { cn } from "@/lib/utils";
import { SectionCard } from "./section-card";
import { PalettePreviewCard } from "./palette-preview-card";

type Density = "comfortable" | "compact";

export interface AppearanceSectionProps {
  /** Persisted preferences row — drives initial form state. */
  initialPreferences: UserPreferences;
}

export function AppearanceSection({
  initialPreferences,
}: AppearanceSectionProps) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [density, setDensity] = useState<Density>(initialPreferences.density);
  const [reducedMotion, setReducedMotion] = useState(
    initialPreferences.reducedMotion,
  );
  const [, startTransition] = useTransition();

  // Apply the persisted density / motion preferences to <html> on mount
  // so the CSS hooks fire even before the user touches the toggles. The
  // theme is already applied by the root layout reading the cookie.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setMounted(true);
    document.documentElement.dataset.density = initialPreferences.density;
    if (initialPreferences.reducedMotion) {
      document.documentElement.dataset.reducedMotion = "true";
    } else {
      delete document.documentElement.dataset.reducedMotion;
    }
  }, [initialPreferences.density, initialPreferences.reducedMotion]);
  /* eslint-enable react-hooks/set-state-in-effect */

  function persist(
    patch: Parameters<typeof updatePreferences>[0],
    onError: () => void,
  ): void {
    startTransition(async () => {
      const result = await updatePreferences(patch);
      if (!result.ok) {
        toast.error("Couldn't save preference", {
          id: "appearance-save-error",
          description: result.error,
        });
        onError();
        // Stale-session: the JWT outlived the user row. Hard-nav to the
        // clear-session route so the bad cookie is deleted before the
        // browser lands on /login (otherwise proxy.ts bounces back to
        // /dashboard with the still-valid-looking cookie).
        if (isStaleSessionError(result.error)) {
          window.location.assign(
            buildStaleSessionRedirectUrl("/dashboard/settings"),
          );
        }
      }
    });
  }

  function handleSelectTheme(id: string) {
    const previous = theme;
    setTheme(id);
    const next = getThemeById(id);
    if (next) {
      // Shared id with the sidebar quick-switcher in user-pill.tsx so
      // cycling palettes from either surface refreshes one toast in
      // place rather than stacking a deck of "Theme set to …" cards.
      toast.success(`Theme set to ${next.name}`, {
        id: "theme-change",
        description: next.description,
      });
    }
    persist({ themeId: id }, () => {
      // Roll back the visual change if the DB write fails.
      if (previous) setTheme(previous);
    });
  }

  function applyDensity(value: Density) {
    const previous = density;
    setDensity(value);
    document.documentElement.dataset.density = value;
    persist({ density: value }, () => {
      setDensity(previous);
      document.documentElement.dataset.density = previous;
    });
  }

  function applyReducedMotion(value: boolean) {
    const previous = reducedMotion;
    setReducedMotion(value);
    if (value) {
      document.documentElement.dataset.reducedMotion = "true";
    } else {
      delete document.documentElement.dataset.reducedMotion;
    }
    persist({ reducedMotion: value }, () => {
      setReducedMotion(previous);
      if (previous) {
        document.documentElement.dataset.reducedMotion = "true";
      } else {
        delete document.documentElement.dataset.reducedMotion;
      }
    });
  }

  const activeThemeId = mounted ? (theme ?? DEFAULT_THEME) : DEFAULT_THEME;
  const activeTheme = getThemeById(activeThemeId);

  return (
    <div className="space-y-6">
      <SectionCard
        id="section-heading-appearance"
        title="Theme"
        description="Choose how the workspace looks. Changes apply instantly."
        headerAside={
          activeTheme ? (
            <motion.span
              key={activeTheme.id}
              initial={{ opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.25 }}
              className="inline-flex items-center gap-1.5 rounded-full bg-accent/10 px-3 py-1 text-xs font-medium text-accent"
            >
              <Sparkles className="h-3 w-3" aria-hidden />
              {activeTheme.name}
            </motion.span>
          ) : null
        }
      >
        <div
          className={cn(
            "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3",
            // mute the picker until next-themes hydrates so the wrong
            // tile doesn't pulse "active" for a single frame.
            !mounted && "pointer-events-none opacity-60",
          )}
        >
          {THEMES.map((t) => (
            <PalettePreviewCard
              key={t.id}
              theme={t}
              isActive={activeThemeId === t.id}
              onSelect={handleSelectTheme}
            />
          ))}
        </div>
      </SectionCard>

      <SectionCard
        title="Density"
        description="How much breathing room tables and cards get."
      >
        <RadioGroup
          value={density}
          onValueChange={(value) => applyDensity(value as Density)}
          className="grid grid-cols-1 gap-3 sm:grid-cols-2"
        >
          <DensityOption
            id="comfortable"
            label="Comfortable"
            description="Generous spacing. Easier to scan, fewer rows per page."
            checked={density === "comfortable"}
          />
          <DensityOption
            id="compact"
            label="Compact"
            description="Tighter padding. More rows visible without scrolling."
            checked={density === "compact"}
          />
        </RadioGroup>
      </SectionCard>

      <SectionCard
        title="Motion"
        description="Tone down animations across the dashboard."
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Label
              htmlFor="reduced-motion"
              className="text-sm font-medium text-foreground"
            >
              Reduce motion
            </Label>
            <p className="mt-1 text-sm text-muted-foreground">
              Disables non-essential transitions, parallax, and entry
              animations. Honoured even when your OS setting is off.
            </p>
          </div>
          <Switch
            id="reduced-motion"
            checked={reducedMotion}
            onCheckedChange={applyReducedMotion}
          />
        </div>
      </SectionCard>
    </div>
  );
}

// ── Local sub-component ────────────────────────────────────────────────────

interface DensityOptionProps {
  id: string;
  label: string;
  description: string;
  checked: boolean;
}

function DensityOption({ id, label, description, checked }: DensityOptionProps) {
  return (
    <Label
      htmlFor={id}
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors",
        checked
          ? "border-accent bg-accent/5"
          : "border-border hover:border-foreground/20 hover:bg-muted/50",
      )}
    >
      <RadioGroupItem id={id} value={id} className="mt-1" />
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
    </Label>
  );
}
