/**
 * Dashboard home — landing page for /dashboard.
 *
 * The persistent sidebar (in `app/dashboard/layout.tsx`) now provides
 * the brand badge and the sign-out trigger, so this page no longer
 * renders its own top bar. It uses the shared `<PageHeader>` for the
 * title strip, matching every other dashboard page for consistency.
 *
 * Current content:
 *   - Welcome card confirming auth (Day 1 stub - intentionally still
 *     here, will be replaced by real KPI tiles per the figma in a
 *     later chunk)
 *   - Recent-activity widget (Day 7) - first UI consumer of the
 *     `listAuditEvents` read API. Wrapped in <Suspense> so its
 *     server-side fetch doesn't block the welcome card's render.
 *
 * Future Phase-1 widgets (KPI tiles, charts, quick-action buttons
 * matching the figma) land in a later chunk.
 *
 * @module app/dashboard/page
 */
import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { UserCircle2 } from "lucide-react";
import { readSession } from "@/lib/auth/session";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PageHeader } from "@/components/dashboard/page-header";
import { ActivityFeed } from "./_components/activity-feed";
import { ActivityFeedLoading } from "./_components/activity-feed-loading";

export const metadata: Metadata = {
  title: "Dashboard",
  description: "Operations overview",
};

export default async function DashboardPage() {
  /**
   * Layout-level guard also runs, but reading session here gives us
   * the typed payload for personalising the welcome card without an
   * extra DB lookup.
   */
  const session = await readSession();
  if (!session) redirect("/login");

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle="Overview of tenders, projects, and financials"
      />

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <UserCircle2
              className="h-5 w-5 text-muted-foreground"
              aria-hidden
            />
            <CardTitle className="text-xl">
              Welcome, {session.email}
            </CardTitle>
          </div>
          <CardDescription>
            You&apos;re signed in as{" "}
            <span className="font-medium capitalize">{session.role}</span>.
          </CardDescription>
        </CardHeader>

        <CardContent>
          <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            <p>
              Dashboard widgets, charts, and quick actions land in a later
              chunk.
            </p>
            <p className="mt-1">
              For now, this page just proves authentication works end-to-end.
            </p>
          </div>

          {/* Dev-only session payload dump for debugging */}
          {process.env.NODE_ENV === "development" && (
            <details className="mt-6">
              <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                Show session payload (dev only)
              </summary>
              <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-4 text-xs">
                {JSON.stringify(session, null, 2)}
              </pre>
            </details>
          )}
        </CardContent>
      </Card>

      {/* Activity feed - wrapped in Suspense so its DB queries don't
          block the welcome card. The page streams: header + welcome
          render immediately; activity feed streams in when ready. */}
      <div className="mt-6">
        <Suspense fallback={<ActivityFeedLoading />}>
          <ActivityFeed />
        </Suspense>
      </div>
    </>
  );
}
