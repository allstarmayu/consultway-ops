/**
 * Post-registration "check your email" landing.
 *
 * Server Component. Reads `?email=` from search params and shows a
 * confirmation message — Chunk 1 lands a static placeholder; Chunk 2
 * fills in the verification-link copy and adds the resend button once
 * the email-verification flow is live.
 *
 * @module app/register/check-email/page
 */
import type { Metadata } from "next";
import Link from "next/link";
import { Building2, MailCheck } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Check your email",
  description: "Confirm your Consultway Ops registration.",
};

interface PageProps {
  searchParams: Promise<{ email?: string }>;
}

export default async function CheckEmailPage({ searchParams }: PageProps) {
  const { email } = await searchParams;

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

        <Card>
          <CardHeader className="space-y-2 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <MailCheck className="h-6 w-6 text-primary" aria-hidden />
            </div>
            <CardTitle className="text-xl">Account created</CardTitle>
            <CardDescription>
              {email
                ? `We've created your account for ${email}.`
                : "We've created your account."}{" "}
              Email verification is coming next — once it lands you&apos;ll
              need to confirm your inbox before signing in.
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            <Button asChild className="w-full">
              <Link href="/login">Continue to sign in</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
