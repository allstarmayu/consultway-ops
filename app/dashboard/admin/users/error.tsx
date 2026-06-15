/**
 * Error boundary for the users route. Next.js renders this on any uncaught
 * server-render error. Expected failures (validation, not-found, forbidden)
 * are handled inside the pages/actions; only truly unexpected errors land here.
 *
 * @module app/dashboard/admin/users/error
 */
"use client";

import { useEffect } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/dashboard/page-header";

interface UsersErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function UsersError({ error, reset }: UsersErrorProps) {
  useEffect(() => {
    console.error("[users] page error", error);
  }, [error]);

  return (
    <>
      <PageHeader title="Users" subtitle="Manage platform users and invitations" />
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Something went wrong</AlertTitle>
        <AlertDescription>
          The users list couldn&apos;t be loaded. This is usually a transient
          issue — try again, or refresh the page.
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
