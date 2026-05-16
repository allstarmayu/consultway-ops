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
import Link from "next/link";
import { Plus, Link2 } from "lucide-react";
import { listCompanies } from "@/lib/companies/actions";
import { readSession } from "@/lib/auth/session";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PageHeader } from "@/components/dashboard/page-header";
import { FiltersBar } from "./_components/filters-bar";
import { CompaniesTable } from "./_components/companies-table";

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
  // 1. Resolve search params and session in parallel.
  //    The Zod schema in listCompanies handles coercion + defaults, so
  //    we pass the raw object through unchanged.
  const [params, session] = await Promise.all([searchParams, readSession()]);

  // Session is guaranteed by the dashboard layout's auth guard, but
  // TypeScript can't see that without an assert. Belt + suspenders.
  if (!session) {
    return null;
  }

  // 2. Fetch the page. The action handles validation, scope, sorting,
  //    pagination, and returns a typed `ActionResult`.
  const result = await listCompanies(params);

  // 3. Hard failure mode — bad query, DB hiccup, etc.
  if (!result.ok) {
    return (
      <>
        <PageHeader
          title="Companies"
          subtitle="Manage company profiles and compliance"
        />
        <Alert variant="destructive">
          <AlertTitle>Couldn't load companies</AlertTitle>
          <AlertDescription>{result.error}</AlertDescription>
        </Alert>
      </>
    );
  }

  const { rows, total, page, perPage } = result;

  // 4. Action buttons differ by role. Admin/staff can add companies;
  //    `company` role users only ever see their own row and can't
  //    register others.
  const canCreate = session.role === "admin" || session.role === "staff";

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
          they read as a coherent toolbar. */}
      <Card className="overflow-hidden p-0">
        <FiltersBar />
        <CompaniesTable
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
