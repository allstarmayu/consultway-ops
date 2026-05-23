/**
 * Transactions list page — admin-only.
 *
 * Server Component. Reads `searchParams` for filters/pagination, calls
 * the `listTransactions` action via `<TransactionsTableSection />`, and
 * renders the standard PageHeader + FiltersBar + Card+Table shell.
 *
 * Access control:
 *
 *   - Admin only. Staff and company-role users redirect to `/dashboard`
 *     with no leak about the surface's existence. The sidebar entry
 *     stays visible to everyone per the existing "render everything,
 *     let the page gate" pattern; clicking through as non-admin lands
 *     back at /dashboard.
 *
 *   - `listTransactions` action ALSO refuses non-admin callers
 *     (defence in depth — the page gate is the user-facing one; the
 *     action gate is the no-bypass one).
 *
 * @module app/dashboard/transactions/page
 */
import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { asc } from "drizzle-orm";
import { Download, Plus } from "lucide-react";
import { readSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { companies, projects } from "@/lib/db/schema";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/dashboard/page-header";
import { TableSectionLoading } from "@/components/dashboard/table-section-loading";
import { TransactionsFiltersBar } from "./_components/transactions-filters-bar";
import { TransactionsTableSection } from "./_components/transactions-table-section";

export const metadata: Metadata = {
  title: "Transactions",
  description: "Admin-only financial ledger",
};

interface TransactionsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function TransactionsPage({
  searchParams,
}: TransactionsPageProps) {
  // 1. Auth gate. Admin only — staff and company-role both bounce.
  const session = await readSession();
  if (!session) redirect("/login");
  if (session.role !== "admin") redirect("/dashboard");

  // 2. Fetch the filter dropdowns' option lists in parallel with the
  //    page params resolution.
  const [params, companyOptions, projectOptions] = await Promise.all([
    searchParams,
    db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .orderBy(asc(companies.name)),
    db
      .select({
        id: projects.id,
        name: projects.name,
        companyId: projects.companyId,
      })
      .from(projects)
      .orderBy(asc(projects.name)),
  ]);

  const exportHref = buildExportHref(params);
  const suspenseKey = JSON.stringify(params);

  return (
    <>
      <PageHeader
        title="Transactions"
        subtitle="Financial ledger across all companies"
        actions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline">
              <Link href={exportHref}>
                <Download className="h-4 w-4" aria-hidden />
                Export CSV
              </Link>
            </Button>
            <Button asChild>
              <Link href="/dashboard/transactions/new">
                <Plus className="h-4 w-4" aria-hidden />
                Add transaction
              </Link>
            </Button>
          </div>
        }
      />

      <Card className="overflow-hidden p-0">
        <TransactionsFiltersBar
          companyOptions={companyOptions}
          projectOptions={projectOptions}
        />
        <Suspense
          key={suspenseKey}
          fallback={<TableSectionLoading columns={7} />}
        >
          <TransactionsTableSection query={params} />
        </Suspense>
      </Card>
    </>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build the CSV export URL by copying through the current filter params.
 * Only the filter-relevant keys are forwarded — page / perPage / sort
 * aren't meaningful for a full export, so they're dropped.
 */
function buildExportHref(
  params: Record<string, string | string[] | undefined>,
): string {
  const search = new URLSearchParams();
  const forwarded = [
    "type",
    "companyId",
    "projectId",
    "occurredOnFrom",
    "occurredOnTo",
  ] as const;
  for (const key of forwarded) {
    const value = params[key];
    if (typeof value === "string" && value !== "") {
      search.set(key, value);
    }
  }
  const qs = search.toString();
  return qs
    ? `/dashboard/transactions/export?${qs}`
    : "/dashboard/transactions/export";
}
