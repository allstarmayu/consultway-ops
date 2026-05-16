/**
 * Error boundary for the companies route.
 *
 * Next.js catches any uncaught error during server render and renders
 * THIS file instead of the page. The `reset()` prop is a re-render
 * trigger — useful when the error was transient (DB blip, etc.).
 *
 * Must be a Client Component — Next.js needs it on the client side
 * so the `reset()` callback can fire from a button click.
 *
 * Expected failures (validation, not-found, unauthorized) are handled
 * inside `page.tsx` and return alerts there. Only truly unexpected
 * errors reach this boundary.
 *
 * @module app/dashboard/companies/error
 */
"use client";

import { useEffect } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/dashboard/page-header";

interface CompaniesErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function CompaniesError({ error, reset }: CompaniesErrorProps) {
  // Forward to the browser console so a developer can dig further.
  // `error.digest` is a server-side hash Next.js attaches to log lines,
  // useful when correlating a user-reported error to server logs.
  useEffect(() => {
    console.error("[companies] page error", error);
  }, [error]);

  return (
    <>
      <PageHeader
        title="Companies"
        subtitle="Manage company profiles and compliance"
      />
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Something went wrong</AlertTitle>
        <AlertDescription>
          The companies list couldn&apos;t be loaded. This is usually a
          transient issue — try again, or refresh the page.
          {error.digest && (
            <div className="mt-2 font-mono text-xs opacity-60">
              Reference: {error.digest}
            </div>
          )}
        </AlertDescription>
      </Alert>

      <div className="mt-4">
        <Button onClick={() => reset()} variant="outline">
          <RefreshCw className="h-4 w-4" aria-hidden />
          Try again
        </Button>
      </div>
    </>
  );
}
