/**
 * App-level error boundary.
 *
 * The topmost catch-all for uncaught errors during server render -
 * fires when no segment-level `error.tsx` higher up the route tree
 * has handled the failure first. Segment boundaries (e.g.
 * `app/dashboard/companies/error.tsx`) cover their own sub-trees;
 * this file covers the gaps (`/login`, `/`, anything outside
 * `/dashboard/**`) plus serves as the final fallback if a segment
 * boundary itself throws.
 *
 * Must be a Client Component - Next.js needs `reset()` callable from
 * a button click. Expected failures (validation, not-found, unauthz)
 * are handled inside their pages and return Alerts there; only truly
 * unexpected errors reach this boundary.
 *
 * @module app/error
 */
"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface AppErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function AppError({ error, reset }: AppErrorProps) {
  // Forward to the browser console for dev visibility. `error.digest`
  // is a server-side hash Next.js attaches to its log lines, useful
  // when correlating a user-reported error to server logs.
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error("[app] uncaught error", error);
  }, [error]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
        <AlertTriangle
          className="h-8 w-8 text-destructive"
          aria-hidden
        />
      </div>

      <div className="space-y-2">
        <h1 className="text-2xl font-semibold text-foreground">
          Something went wrong
        </h1>
        <p className="max-w-md text-sm text-muted-foreground">
          We hit an unexpected error. Usually a transient issue — try
          again, or refresh the page. If it persists, share the
          reference below with support.
        </p>
        {error.digest && (
          <p className="font-mono text-xs text-muted-foreground">
            Reference: {error.digest}
          </p>
        )}
      </div>

      <Button onClick={() => reset()} variant="outline">
        <RefreshCw className="h-4 w-4" aria-hidden />
        Try again
      </Button>
    </main>
  );
}
