/**
 * Companies table section — the async-fetching half of the list page.
 *
 * Extracted from `app/dashboard/companies/page.tsx` so the table fetch
 * can stream behind a Suspense boundary while the page header and
 * filter bar render immediately. Filter changes re-key the Suspense
 * boundary upstream, so this component re-runs against the new query
 * and the skeleton flickers during the round-trip.
 *
 * Responsibilities:
 *   - Call `listCompanies(query)` with the raw URL search params
 *   - Render the alert branch if the action returns `ok: false`
 *   - Render `<CompaniesTable>` with the page of rows on success
 *
 * Why not handle the error branch upstream (in the page):
 *   The error branch reads the same fetch's result, so co-locating
 *   it here means the page Server Component has no awaits at all -
 *   header + filter bar render at first-byte time, no waiting on the
 *   DB query.
 *
 * @module app/dashboard/companies/_components/companies-table-section
 */
import { listCompanies } from "@/lib/companies/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CompaniesTable } from "./companies-table";

export interface CompaniesTableSectionProps {
  /**
   * Raw `searchParams` from the page. Passed through unchanged - the
   * action's Zod schema handles coercion, defaults, and validation.
   */
  query: Record<string, string | string[] | undefined>;

  /** Show the edit pencil on rows. Admin/staff get it. */
  canEdit: boolean;

  /** Show the delete trash. Admin only. */
  canDelete: boolean;
}

export async function CompaniesTableSection({
  query,
  canEdit,
  canDelete,
}: CompaniesTableSectionProps) {
  const result = await listCompanies(query);

  if (!result.ok) {
    return (
      <Alert variant="destructive" className="m-4">
        <AlertTitle>Couldn&apos;t load companies</AlertTitle>
        <AlertDescription>{result.error}</AlertDescription>
      </Alert>
    );
  }

  const { rows, total, page, perPage } = result;

  return (
    <CompaniesTable
      rows={rows}
      total={total}
      page={page}
      perPage={perPage}
      canEdit={canEdit}
      canDelete={canDelete}
    />
  );
}
