/**
 * Tenders list page.
 *
 * Server Component — reads `searchParams` for filters/pagination, calls
 * the `listTenders` action, hands the rows to `<TendersTable />` for
 * rendering. Filter inputs (search, status, sector, geography, MSME-only)
 * live in a Client `<FiltersBar />` that writes back to the URL, so the
 * next render of this page picks up the new query.
 *
 * Mirrors `app/dashboard/companies/page.tsx` line-for-line where the
 * shape matches; departures from that template are the action name
 * (listTenders), the action button label (Add Tender), and the absence
 * of a "Generate Registration Link" button (that's a companies-onboarding
 * concept that doesn't apply here).
 *
 * Why URL state instead of React state:
 *   - Filters survive page refresh and browser back/forward
 *   - Shareable links ("send me the URL of all published infrastructure
 *     tenders closing this month")
 *   - Server Component reads them directly with zero client JS
 *   - Plays nicely with browser native form submission as a fallback
 *
 * Access control:
 *   - `admin` and `staff` see every tender (including drafts)
 *   - `company` role sees published/closed/awarded tenders + own drafts
 *     as publisher (the listTenders action handles row-level scoping)
 *
 * @module app/dashboard/tenders/page
 */
import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { listTenders } from "@/lib/tenders/actions";
import { readSession } from "@/lib/auth/session";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PageHeader } from "@/components/dashboard/page-header";
import { FiltersBar } from "./_components/filters-bar";
import { TendersTable } from "./_components/tenders-table";

export const metadata: Metadata = {
  title: "Tenders",
  description: "Manage tender opportunities and applications",
};

/**
 * Next.js App Router types `searchParams` as a Promise in 15+.
 * We `await` it like any other promise.
 */
interface TendersPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function TendersPage({
  searchParams,
}: TendersPageProps) {
  // 1. Resolve search params and session in parallel. The Zod schema
  //    in listTenders handles coercion + defaults, so we pass the raw
  //    object through unchanged.
  const [params, session] = await Promise.all([searchParams, readSession()]);

  // Session is guaranteed by the dashboard layout's auth guard, but
  // TypeScript can't see that without an assert. Belt + suspenders.
  if (!session) {
    return null;
  }

  // 2. Fetch the page. The action handles validation, scope, sorting,
  //    pagination, and returns a typed `ActionResult`.
  const result = await listTenders(params);

  // 3. Hard failure mode — bad query, DB hiccup, etc.
  if (!result.ok) {
    return (
      <>
        <PageHeader
          title="Tenders"
          subtitle="Manage tender opportunities and applications"
        />
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t load tenders</AlertTitle>
          <AlertDescription>{result.error}</AlertDescription>
        </Alert>
      </>
    );
  }

  const { rows, total, page, perPage } = result;

  // 4. Action buttons differ by role. Admin/staff can create tenders;
  //    `company` role users don't see the create surface (they apply,
  //    they don't publish — that's the next chunk's UI).
  const canCreate = session.role === "admin" || session.role === "staff";

  return (
    <>
      <PageHeader
        title="Tenders"
        subtitle="Manage tender opportunities and applications"
        actions={
          canCreate ? (
            <Button asChild>
              <Link href="/dashboard/tenders/new">
                <Plus className="h-4 w-4" aria-hidden />
                Add Tender
              </Link>
            </Button>
          ) : undefined
        }
      />

      {/* Single card wraps filters + table for the figma's "one panel"
          look — same shell as the companies list. */}
      <Card className="overflow-hidden p-0">
        <FiltersBar />
        <TendersTable
          rows={rows}
          total={total}
          page={page}
          perPage={perPage}
          canEdit={canCreate}
          canDelete={session.role === "admin"}
        />
      </Card>
    </>
  );
}
