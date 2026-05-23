"use client"

import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
          // Explicit action-button styling. Without this, sonner's
          // default action-button colours (white-on-near-black via the
          // shadcn template's --normal-* overrides) become hard to
          // spot inside a `richColors` success toast (light green bg
          // with green text). Using the project's primary palette
          // forces a high-contrast pill button regardless of toast
          // type. `!important` overrides the inline style sonner
          // sets on the button element.
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
