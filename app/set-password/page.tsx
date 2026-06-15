/**
 * Set-password landing (admin invite acceptance).
 *
 * Server Component shell. Reads `?token=` from the invite link and renders
 * the client form with the token wired in. The form posts to `acceptInvite`
 * (lib/auth/actions), which sets the password + flips email-verified, then
 * redirects to `/login?invite=accepted`.
 *
 * Sibling of `/reset-password` — same shell shape, invite-flavoured copy.
 *
 * @module app/set-password/page
 */
import type { Metadata } from "next";
import Link from "next/link";
import { Building2 } from "lucide-react";
import { SetPasswordForm } from "./_components/set-password-form";
import { ThemePickerDropdown } from "@/components/theme-picker-dropdown";

export const metadata: Metadata = {
  title: "Set your password",
  description: "Activate your Consultway account by choosing a password.",
};

interface PageProps {
  searchParams: Promise<{ token?: string }>;
}

export default async function SetPasswordPage({ searchParams }: PageProps) {
  const { token } = await searchParams;

  return (
    <main
      className="relative flex min-h-screen items-center justify-center px-6 py-12"
      style={{
        background:
          "radial-gradient(ellipse at 50% 0%, color-mix(in oklab, var(--accent) 10%, var(--background)) 0%, var(--background) 60%)",
      }}
    >
      <ThemePickerDropdown />

      <div className="w-full max-w-md">
        <Link
          href="/"
          className="mb-8 flex items-center justify-center gap-3"
          aria-label="Consultway Infotech home"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary">
            <Building2 className="h-5 w-5 text-primary-foreground" aria-hidden />
          </div>
          <span className="text-lg font-semibold tracking-tight">
            Consultway Ops
          </span>
        </Link>

        <SetPasswordForm token={token ?? ""} />

        <p className="mt-6 text-center text-sm text-muted-foreground">
          Already activated?{" "}
          <Link
            href="/login"
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
