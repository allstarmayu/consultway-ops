/**
 * Email verification landing.
 *
 * Server Component. Reads `?token=` from the URL, calls
 * `consumeEmailVerificationToken`, and renders one of three outcomes:
 *
 *   - success       → "Verified, sign in"
 *   - expired       → "Link expired" + Resend prompt
 *   - already_used  → "Already verified" + Sign-in prompt
 *   - not_found     → "Link invalid" + Resend prompt
 *
 * The consume helper returns a discriminated union and NEVER throws,
 * so this page handles every branch in pure-server-render style.
 *
 * @module app/auth/verify/page
 */
import type { Metadata } from "next";
import Link from "next/link";
import { Building2, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import { consumeEmailVerificationToken } from "@/lib/auth/tokens";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Verify your email",
  description: "Confirm your Consultway Ops account.",
};

interface PageProps {
  searchParams: Promise<{ token?: string }>;
}

export default async function VerifyEmailPage({ searchParams }: PageProps) {
  const { token } = await searchParams;

  // Missing/empty token → render the same "not found" state. No reveal.
  const outcome = token
    ? await consumeEmailVerificationToken(token)
    : ({ ok: false, reason: "not_found" } as const);

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted px-6 py-12">
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

        {outcome.ok ? <VerifiedCard /> : <FailureCard reason={outcome.reason} />}
      </div>
    </main>
  );
}

function VerifiedCard() {
  return (
    <Card>
      <CardHeader className="space-y-2 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50">
          <CheckCircle2 className="h-6 w-6 text-emerald-600" aria-hidden />
        </div>
        <CardTitle className="text-xl">Email verified</CardTitle>
        <CardDescription>
          Your account is ready. Sign in to access your Consultway dashboard.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild className="w-full">
          <Link href="/login">Sign in</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

interface FailureCardProps {
  reason: "not_found" | "expired" | "already_used";
}

function FailureCard({ reason }: FailureCardProps) {
  const copy = {
    not_found: {
      icon: <XCircle className="h-6 w-6 text-destructive" aria-hidden />,
      title: "Link no longer valid",
      description:
        "We couldn't find this verification link. It may have already been used or never existed. Request a fresh one to continue.",
      cta: { href: "/register/check-email", label: "Resend verification" },
    },
    expired: {
      icon: <AlertTriangle className="h-6 w-6 text-amber-500" aria-hidden />,
      title: "Link expired",
      description:
        "This verification link has expired. Request a fresh one and we'll send a new email.",
      cta: { href: "/register/check-email", label: "Resend verification" },
    },
    already_used: {
      icon: <CheckCircle2 className="h-6 w-6 text-emerald-600" aria-hidden />,
      title: "Already verified",
      description:
        "This link has already been used. You can sign in directly.",
      cta: { href: "/login", label: "Sign in" },
    },
  }[reason];

  return (
    <Card>
      <CardHeader className="space-y-2 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted/60">
          {copy.icon}
        </div>
        <CardTitle className="text-xl">{copy.title}</CardTitle>
        <CardDescription>{copy.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild className="w-full">
          <Link href={copy.cta.href}>{copy.cta.label}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
