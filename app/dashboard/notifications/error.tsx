/**
 * Error boundary for the notifications route. Next.js renders this on any
 * uncaught server-render error. Expected failures (unauthenticated) are
 * handled in the page/actions; only truly unexpected errors land here.
 *
 * @module app/dashboard/notifications/error
 */
"use client";

import { useEffect } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/dashboard/page-header";

interface NotificationsErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function NotificationsError({
  error,
  reset,
}: NotificationsErrorProps) {
  useEffect(() => {
    console.error("[notifications] page error", error);
  }, [error]);

  return (
    <>
      <PageHeader
        title="Notifications"
        subtitle="Updates on companies, tenders, and your account"
      />
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Something went wrong</AlertTitle>
        <AlertDescription>
          Your notifications couldn&apos;t be loaded. This is usually a
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
