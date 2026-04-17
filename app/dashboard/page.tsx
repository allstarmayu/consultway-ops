/**
 * Dashboard — the authenticated landing page.
 *
 * Currently a stub: welcome message, user info, logout button. Replaced
 * in Phase 1 with the real dashboard (companies, tenders, KPI cards).
 *
 * Protected by middleware.ts — unauthenticated visitors get bounced to
 * /login before this component renders.
 *
 * @module app/dashboard
 */
import { redirect } from "next/navigation";
import { Building2, LogOut, UserCircle2 } from "lucide-react";
import { readSession } from "@/lib/auth/session";
import { logout } from "@/lib/auth/actions";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default async function DashboardPage() {
  /**
   * Middleware already verified there's a valid session cookie. We still
   * call readSession() here for two reasons:
   *   1. Belt-and-suspenders: if the cookie was deleted between the
   *      middleware check and this component render, we bounce safely.
   *   2. We need the payload (email, role) to personalize the UI.
   */
  const session = await readSession();
  if (!session) redirect("/login");

  return (
    <main className="min-h-screen bg-muted">
      {/* Top bar */}
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary">
              <Building2
                className="h-5 w-5 text-primary-foreground"
                aria-hidden
              />
            </div>
            <div>
              <p className="text-sm font-medium leading-none">Consultway Ops</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Operations portal
              </p>
            </div>
          </div>

          <form action={logout}>
            <Button type="submit" variant="outline" size="sm">
              <LogOut className="h-4 w-4" aria-hidden />
              Sign out
            </Button>
          </form>
        </div>
      </header>

      {/* Page content */}
      <div className="mx-auto max-w-6xl px-6 py-10">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <UserCircle2 className="h-5 w-5 text-muted-foreground" aria-hidden />
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
                Dashboard widgets, charts, and quick actions land in Phase 1.
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
      </div>
    </main>
  );
}
