/**
 * Tenders list error boundary.
 *
 * Next.js App Router automatically wraps this route in an error
 * boundary that catches any unhandled exception during render or in
 * a Server Action. Caught errors land here so the user sees a styled
 * fallback instead of the default Next.js error overlay.
 *
 * Must be a Client Component — the `reset` callback is provided by the
 * App Router runtime to retry the failed render.
 *
 * @module app/dashboard/tenders/error
 */
"use client";

import { useEffect } from "react";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PageHeader } from "@/components/dashboard/page-header";
import { logger } from "@/lib/logger";

const log = logger.child({ module: "tenders-error-boundary" });

export interface TendersErrorProps {
  /** The thrown error. Includes a digest in production for server matching. */
  error: Error & { digest?: string };
  /** Reset the route — triggers a re-render of the segment. */
  reset: () => void;
}

export default function TendersError({ error, reset }: TendersErrorProps) {
  // Log on mount. In production the digest links this client log to
  // the corresponding server-side stack trace.
  useEffect(() => {
    log.error("tenders list render failed", {
      message: error.message,
      digest: error.digest,
    });
  }, [error]);

  return (
    <>
      <PageHeader
        title="Tenders"
        subtitle="Manage tender opportunities and applications"
      />
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" aria-hidden />
        <AlertTitle>Something went wrong loading tenders</AlertTitle>
        <AlertDescription className="space-y-3">
          <p className="text-sm">
            {error.message ||
              "An unexpected error occurred. Please try again."}
          </p>
          {error.digest && (
            <p className="font-mono text-xs text-muted-foreground">
              Error ID: {error.digest}
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={reset}
            className="border-destructive/40 text-destructive hover:bg-destructive/10"
          >
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    </>
  );
}
