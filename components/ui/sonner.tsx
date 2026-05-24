"use client"

/**
 * App-wide Toaster.
 *
 * Day 26: refactored so the visual styling lives entirely in
 * `app/globals.css` under the toast aesthetic block. Sonner's own
 * `--normal-*` CSS-var overrides are still passed here so the framework
 * can fall back to them where our attribute selectors don't reach (e.g.
 * legacy `richColors` consumers — which we don't use anymore — or future
 * plugins). The lucide icons keep the same glyph set; CSS wraps them in
 * a tinted circular badge per type so the appearance is consistent
 * across all 6 palettes.
 *
 * Theme prop: we forward the next-themes value verbatim so sonner picks
 * the right colour-scheme for its action button + outline defaults.
 *
 * @module components/ui/sonner
 */
import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import {
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
  Loader2Icon,
} from "lucide-react"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" strokeWidth={2.25} />,
        info: <InfoIcon className="size-4" strokeWidth={2.25} />,
        warning: <TriangleAlertIcon className="size-4" strokeWidth={2.25} />,
        error: <OctagonXIcon className="size-4" strokeWidth={2.25} />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          // Surface vars — left as theme-aware fallbacks for any sonner
          // internal that doesn't pass through our attribute-selector
          // rules in globals.css.
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius-lg)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          // Action buttons sit inside the toast body; force the project
          // primary colours so they stay legible across every palette.
          // `!important` is needed because sonner sets inline styles on
          // the button element that would otherwise win.
          actionButton:
            "!bg-primary !text-primary-foreground !font-medium hover:!opacity-90",
          cancelButton:
            "!bg-muted !text-muted-foreground hover:!opacity-90",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
