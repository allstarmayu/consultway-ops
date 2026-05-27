/**
 * Reset-password landing.
 *
 * Server Component shell. Reads `?token=` and renders the client form
 * with the token wired in as a hidden field. The form posts to
 * `resetPassword`, then redirects to `/login?reset=success` on success
 * (the login page picks up the query and shows a toast/banner).
 *
 * @module app/reset-password/page
 */
import type { Metadata } from "next";
import Link from "next/link";
import { Building2 } from "lucide-react";
import { ResetPasswordForm } from "./_components/reset-password-form";
import { ThemePickerDropdown } from "@/components/theme-picker-dropdown";

export const metadata: Metadata = {
  title: "Reset password",
  description: "Choose a new password for your Consultway account.",
};

interface PageProps {
  searchParams: Promise<{ token?: string }>;
}

export default async function ResetPasswordPage({ searchParams }: PageProps) {
  const { token } = await searchParams;

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
      {/* Theme preview picker — same rationale as /forgot-password and
          /login: lets first-time visitors preview the 6 palettes before
          signing in. Cookie-only persistence (no DB write); the gradient
          re-tints immediately. */}
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

        <ResetPasswordForm token={token ?? ""} />

        <p className="mt-6 text-center text-sm text-muted-foreground">
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
