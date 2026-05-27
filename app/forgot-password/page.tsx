/**
 * Forgot-password landing.
 *
 * Server Component shell. The client form posts to `requestPasswordReset`
 * (always returns ok — see action docstring) and shows a uniform "if
 * your account exists, we sent a link" message regardless of outcome.
 *
 * @module app/forgot-password/page
 */
import type { Metadata } from "next";
import Link from "next/link";
import { Building2 } from "lucide-react";
import { ForgotPasswordForm } from "./_components/forgot-password-form";
import { ThemePickerDropdown } from "@/components/theme-picker-dropdown";

export const metadata: Metadata = {
  title: "Forgot password",
  description: "Request a password reset link for your Consultway account.",
};

export default function ForgotPasswordPage() {
  return (
    <main
      className="relative flex min-h-screen items-center justify-center px-6 py-12"
      style={{
        // Sibling-parity with /login + /register: subtle radial backdrop
        // using the active theme's accent. Tracks every palette via
        // `--accent` and `--background` — terracotta glow on Warm
        // Ambient, cyan glow on Ocean Depth, etc.
        background:
          "radial-gradient(ellipse at 50% 0%, color-mix(in oklab, var(--accent) 10%, var(--background)) 0%, var(--background) 60%)",
      }}
    >
      {/* Theme preview picker — lets first-time visitors browse the 6
          palettes before signing in. Cookie-only persistence (no DB
          write) since the visitor isn't authenticated yet; the gradient
          re-tints immediately and the choice carries through to first
          paint after sign-in via the `cw-theme` cookie. */}
      <ThemePickerDropdown />

      <div className="w-full max-w-md">
        <Link
          href="/"
          className="mb-8 flex items-center justify-center gap-3"
          aria-label="Consultway Infotech home"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary">
            <Building2
              className="h-5 w-5 text-primary-foreground"
              aria-hidden
            />
          </div>
          <span className="text-lg font-semibold tracking-tight">
            Consultway Ops
          </span>
        </Link>

        <ForgotPasswordForm />

        <p className="mt-6 text-center text-sm text-muted-foreground">
          Remembered it?{" "}
          <Link
            href="/login"
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            Back to sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
