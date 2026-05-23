/**
 * Projects table section — the async-fetching half of the list page.
 *
 * Mirrors `TendersTableSection`. Extracted from
 * `app/dashboard/projects/page.tsx` so the table fetch streams behind
 * a Suspense boundary while the page header and filter bar paint at
 * first-byte time.
 *
 * Pre-fetches owning-company names alongside the projects page so the
 * Company column in the table doesn't N+1-fetch — one indexed lookup
 * for the small set of distinct companyIds on the rendered page.
 *
 * @module app/dashboard/projects/_components/projects-table-section
 */
import { inArray } from "drizzle-orm";
import { listProjects } from "@/lib/projects/actions";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ProjectsTable } from "./projects-table";

export interface ProjectsTableSectionProps {
  /**
   * Raw `searchParams` from the page. Passed through unchanged — the
   * action's Zod schema handles coercion, defaults, and validation.
   */
  query: Record<string, string | string[] | undefined>;

  /**
   * True when the viewer can reach the "Create project" surface. Used
   * to vary the empty-state copy.
   */
  canCreate: boolean;
}

export async function ProjectsTableSection({
  query,
  canCreate,
}: ProjectsTableSectionProps) {
  const result = await listProjects(query);

  if (!result.ok) {
    return (
      <Alert variant="destructive" className="m-4">
        <AlertTitle>Couldn&apos;t load projects</AlertTitle>
        <AlertDescription>{result.error}</AlertDescription>
      </Alert>
    );
  }

  const { rows, total, page, perPage } = result;

  // Resolve owning-company names in one indexed lookup. Empty-rows
  // case short-circuits to an empty map.
  const companyNames = new Map<string, string>();
  if (rows.length > 0) {
    const distinctIds = Array.from(new Set(rows.map((r) => r.companyId)));
    const companyRows = await db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(inArray(companies.id, distinctIds));
    for (const c of companyRows) {
      companyNames.set(c.id, c.name);
    }
  }

  return (
    <ProjectsTable
      rows={rows}
      companyNames={companyNames}
      total={total}
      page={page}
      perPage={perPage}
      canCreate={canCreate}
    />
  );
}
