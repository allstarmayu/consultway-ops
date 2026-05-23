/**
 * Tenders table section — the async-fetching half of the list page.
 *
 * Mirrors `CompaniesTableSection`. Extracted from
 * `app/dashboard/tenders/page.tsx` so the table fetch streams behind
 * a Suspense boundary while the page header and filter bar paint at
 * first-byte time. Filter changes re-key the upstream Suspense, so
 * this component re-runs and the skeleton flickers during the
 * round-trip.
 *
 * @module app/dashboard/tenders/_components/tenders-table-section
 */
import { listTenders } from "@/lib/tenders/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { TendersTable } from "./tenders-table";

export interface TendersTableSectionProps {
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

export async function TendersTableSection({
  query,
  canEdit,
  canDelete,
}: TendersTableSectionProps) {
  const result = await listTenders(query);

  if (!result.ok) {
    return (
      <Alert variant="destructive" className="m-4">
        <AlertTitle>Couldn&apos;t load tenders</AlertTitle>
        <AlertDescription>{result.error}</AlertDescription>
      </Alert>
    );
  }

  const { rows, total, page, perPage } = result;

  return (
    <TendersTable
      rows={rows}
      total={total}
      page={page}
      perPage={perPage}
      canEdit={canEdit}
      canDelete={canDelete}
    />
  );
}
