/**
 * Homepage — placeholder until auth + routing lands.
 *
 * Currently displays a Consultway-branded "under construction" card.
 * Replaced in Day 2 by a redirect to /login (unauthenticated) or
 * /dashboard (authenticated), driven by middleware.
 */
import { Button } from "@/components/ui/button";
import { ArrowRight, Building2 } from "lucide-react";
import Link from "next/link";

export default function HomePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-12">
      <div className="w-full max-w-xl">
        {/* Logo + wordmark */}
        <div className="mb-10 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary">
            <Building2 className="h-6 w-6 text-primary-foreground" aria-hidden />
          </div>
          <div>
            <p className="text-sm font-medium text-muted-foreground">
              Consultway Infotech
            </p>
            <h1 className="text-xl font-semibold tracking-tight">
              Operations Portal
            </h1>
          </div>
        </div>

        {/* Status card */}
        <div className="rounded-xl border border-border bg-card p-8 shadow-sm">
          <span className="inline-flex items-center rounded-full bg-muted px-3 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Phase 0 · Day 1
          </span>

          <h2 className="mt-5 text-3xl font-semibold leading-tight tracking-tight">
            Scaffolding is live.
          </h2>

          <p className="mt-3 text-base leading-relaxed text-muted-foreground">
            Next.js 16, Tailwind 4, and shadcn/ui are wired up. Payload CMS,
            Drizzle ORM, and authentication land in the next session.
          </p>

          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild>
              <Link href="/login">
                Continue to login
                <ArrowRight className="ml-1 h-4 w-4" />
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <a href="https://github.com/allstarmayu/consultway-ops" target="_blank" rel="noreferrer">
                View repository
              </a>
            </Button>
          </div>
        </div>

        {/* Footer note */}
        <p className="mt-6 text-center text-xs text-muted-foreground">
          Internal portal · Not for public use
        </p>
      </div>
    </main>
  );
}
