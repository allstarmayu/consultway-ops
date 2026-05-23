/**
 * Projects list page.
 *
 * Server Component — reads `searchParams` for filters/pagination, calls
 * the `listProjects` action via `<ProjectsTableSection />`, renders the
 * standard PageHeader + FiltersBar + Card+Table shell. Mirrors
 * `app/dashboard/tenders/page.tsx` line-for-line where the shape
 * matches.
 *
 * Access control:
 *   - `admin` / `staff` — see every project; can create
 *   - `company` role   — sees only their own projects (action handles
 *                        row-level scoping); cannot create
 *
 * @module app/dashboard/projects/page
 */
import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { asc } from "drizzle-orm";
import { Download, Plus } from "lucide-react";
import { readSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/dashboard/page-header";
import { TableSectionLoading } from "@/components/dashboard/table-section-loading";
import { ProjectsFiltersBar } from "./_components/projects-filters-bar";
import { ProjectsTableSection } from "./_components/projects-table-section";

export const metadata: Metadata = {
  title: "Projects",
  description: "Manage active and completed projects",
};

interface ProjectsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ProjectsPage({
  searchParams,
}: ProjectsPageProps) {
  const [params, session] = await Promise.all([searchParams, readSession()]);
  if (!session) return null;

  const canCreate = session.role === "admin" || session.role === "staff";

  // Admin/staff get the company filter; company-role users are already
  // scoped to their own projects and don't need it (also: the action
  // silently drops the companyId filter for company-role queries, so
  // it'd be a no-op even if we did surface it).
  const companyOptions = canCreate
    ? await db
        .select({ id: companies.id, name: companies.name })
        .from(companies)
        .orderBy(asc(companies.name))
    : undefined;

  const suspenseKey = JSON.stringify(params);
  const exportHref = canCreate ? buildExportHref(params) : null;

  return (
    <>
      <PageHeader
        title="Projects"
        subtitle="Project tracking across active engagements"
        actions={
          canCreate ? (
            <div className="flex items-center gap-2">
              {exportHref && (
                <Button asChild variant="outline">
                  <Link href={exportHref}>
                    <Download className="h-4 w-4" aria-hidden />
                    Export CSV
                  </Link>
                </Button>
              )}
              <Button asChild>
                <Link href="/dashboard/projects/new">
                  <Plus className="h-4 w-4" aria-hidden />
                  Add Project
                </Link>
              </Button>
            </div>
          ) : undefined
        }
      />

      <Card className="overflow-hidden p-0">
        <ProjectsFiltersBar companyOptions={companyOptions} />
        <Suspense
          key={suspenseKey}
          fallback={<TableSectionLoading columns={7} />}
        >
          <ProjectsTableSection query={params} canCreate={canCreate} />
        </Suspense>
      </Card>
    </>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build the CSV export URL by copying through the current filter params.
 * Only the filter-relevant keys are forwarded — page / perPage / sort
 * aren't meaningful for a full export, so they're dropped. Mirrors the
 * transactions list's `buildExportHref` shape.
 */
function buildExportHref(
  params: Record<string, string | string[] | undefined>,
): string {
  const search = new URLSearchParams();
  const forwarded = ["status", "companyId", "search"] as const;
  for (const key of forwarded) {
    const value = params[key];
    if (typeof value === "string" && value !== "") {
      search.set(key, value);
    }
  }
  const qs = search.toString();
  return qs
    ? `/dashboard/projects/export?${qs}`
    : "/dashboard/projects/export";
}
