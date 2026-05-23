/**
 * App-level 404.
 *
 * Renders when Next.js can't match a request to any route segment, OR
 * when a non-dashboard page calls `notFound()`. Segment-level
 * `not-found.tsx` files (e.g. for company detail) take precedence
 * inside their own segment - this is the catch-all for everything else
 * (root, /login, unrecognised paths).
 *
 * Renders outside the dashboard layout, so it must stand on its own
 * visually - no sidebar/topbar assumptions. The link back points at
 * `/dashboard` for signed-in users; if the user isn't signed in the
 * dashboard route will bounce them through `/login` via the existing
 * auth middleware.
 *
 * @module app/not-found
 */
import Link from "next/link";
import { Compass, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
        <Compass
          className="h-8 w-8 text-muted-foreground"
          aria-hidden
        />
      </div>

      <div className="space-y-2">
        <p className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
          404
        </p>
        <h1 className="text-2xl font-semibold text-foreground">
          Page not found
        </h1>
        <p className="max-w-md text-sm text-muted-foreground">
          The page you&apos;re looking for doesn&apos;t exist or has been
          moved. Check the URL, or head back to the dashboard.
        </p>
      </div>

      <Button asChild variant="outline">
        <Link href="/dashboard">
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to dashboard
        </Link>
      </Button>
    </main>
  );
}
