/**
 * Resend-verification button.
 *
 * Client Component. Posts to `resendVerificationEmail` on click. The
 * Server Action always returns ok regardless of whether the email exists
 * (enumeration defence — see action docstring), so this UI shows a
 * uniform success message on any response.
 *
 * @module app/register/check-email/_components/resend-button
 */
"use client";

import { useState, useTransition } from "react";
import { CheckCircle2 } from "lucide-react";
import { resendVerificationEmail } from "@/lib/auth/actions";
import { Button } from "@/components/ui/button";

interface Props {
  email: string;
}

export function ResendVerificationButton({ email }: Props) {
  const [sent, setSent] = useState(false);
  const [isPending, startTransition] = useTransition();

  function onClick() {
    startTransition(async () => {
      await resendVerificationEmail({ email });
      // Always show the same success message — the action returns ok
      // even for unknown emails.
      setSent(true);
    });
  }

  if (sent) {
    return (
      <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
        <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />
        If your account exists, we&apos;ve sent a fresh link.
      </p>
    );
  }

  return (
    <Button
      type="button"
      variant="outline"
      className="w-full"
      onClick={onClick}
      disabled={isPending}
      aria-busy={isPending}
    >
      {isPending ? "Sending..." : "Resend verification email"}
    </Button>
  );
}
