/**
 * Companies list page.
 *
 * Server Component — reads `searchParams` for filters/pagination, calls
 * the `listCompanies` action, hands the rows to `<CompaniesTable />`
 * for rendering. Filter inputs (search, sector, geography, compliance)
 * live in a Client `<FiltersBar />` that writes back to the URL, so
 * the next render of this page picks up the new query.
 *
 * Why URL state instead of React state:
 *   - Filters survive page refresh and browser back/forward
 *   - Shareable links ("send me the URL of all non-compliant companies
 *     in Maharashtra")
 *   - Server Component can read them directly with zero client JS
 *   - Plays nicely with browser native form submission as a fallback
 *
 * Access control:
 *   - `admin` and `staff` see every company
 *   - `company` role would see only their own row (the listCompanies
 *     action handles row-level scoping)
 *
 * @module app/dashboard/companies/page
 */
import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { Plus, Link2 } from "lucide-react";
import { readSession } from "@/lib/auth/session";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/dashboard/page-header";
import { TableSectionLoading } from "@/components/dashboard/table-section-loading";
import { FiltersBar } from "./_components/filters-bar";
import { CompaniesTableSection } from "./_components/companies-table-section";

export const metadata: Metadata = {
  title: "Companies",
  description: "Manage company profiles and compliance",
};

/**
 * Next.js App Router types `searchParams` as a Promise in 15+.
 * We `await` it like any other promise.
 */
interface CompaniesPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function CompaniesPage({
  searchParams,
}: CompaniesPageProps) {
  // 1. Resolve search params and session in parallel. Both are cheap;
  //    the heavier work (listCompanies) is now deferred into a child
  //    Server Component behind a Suspense boundary so the page header
  //    + filter bar paint at first-byte time.
  const [params, session] = await Promise.all([searchParams, readSession()]);

  // Session is guaranteed by the dashboard layout's auth guard, but
  // TypeScript can't see that without an assert. Belt + suspenders.
  if (!session) {
    return null;
  }

  // 2. Action buttons differ by role. Admin/staff can add companies;
  //    `company` role users only ever see their own row and can't
  //    register others.
  const canCreate = session.role === "admin" || session.role === "staff";

  // Stable key for the Suspense boundary - re-keying on a serialised
  // form of `params` forces a re-render (and a fresh fallback) every
  // time a filter or page changes, matching what the user expects
  // visually.
  const suspenseKey = JSON.stringify(params);

  return (
    <>
      <PageHeader
        title="Companies"
        subtitle="Manage company profiles and compliance"
        actions={
          canCreate ? (
            <>
              {/* Registration-link generation is a Phase-1 sub-feature.
                  Stubbed for now; click does nothing, but the button is
                  here so the surface matches the figma + signals the
                  upcoming capability. */}
              <Button variant="outline" disabled aria-disabled>
                <Link2 className="h-4 w-4" aria-hidden />
                Generate Registration Link
              </Button>
              <Button asChild>
                <Link href="/dashboard/companies/new">
                  <Plus className="h-4 w-4" aria-hidden />
                  Add Company
                </Link>
              </Button>
            </>
          ) : undefined
        }
      />

      {/* Single card wraps filters + table for the figma's "one panel"
          look. Filters separate from table by an internal border so
          they read as a coherent toolbar. The table itself streams
          behind a Suspense boundary - filter changes re-key the
          boundary so the skeleton flickers during re-fetch. */}
      <Card className="overflow-hidden p-0">
        <FiltersBar />
        <Suspense
          key={suspenseKey}
          fallback={<TableSectionLoading columns={7} />}
        >
          <CompaniesTableSection
            query={params}
            canEdit={canCreate}
            canDelete={session.role === "admin"}
          />
        </Suspense>
      </Card>
    </>
  );
}
