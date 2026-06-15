/**
 * Users table section — the async-fetching half of the list page.
 *
 * Extracted so the table fetch streams behind a Suspense boundary while
 * the page header + filter bar render immediately. Calls `listUsers(query)`
 * with the raw URL search params (the action's Zod schema handles coercion,
 * defaults, and validation) and renders the error or the table.
 *
 * @module app/dashboard/admin/users/_components/users-table-section
 */
import type { UserRole } from "@/lib/db/schema";
import { listUsers } from "@/lib/users/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { UsersTable } from "./users-table";

export interface UsersTableSectionProps {
  /** Raw `searchParams` from the page — passed through unchanged. */
  query: Record<string, string | string[] | undefined>;
  /** Viewer's role — controls whether the per-row Edit action shows. */
  viewerRole: UserRole;
}

export async function UsersTableSection({
  query,
  viewerRole,
}: UsersTableSectionProps) {
  const result = await listUsers(query);

  if (!result.ok) {
    return (
      <Alert variant="destructive" className="m-4">
        <AlertTitle>Couldn&apos;t load users</AlertTitle>
        <AlertDescription>{result.error}</AlertDescription>
      </Alert>
    );
  }

  const { rows, total, page, perPage } = result;

  return (
    <UsersTable
      rows={rows}
      total={total}
      page={page}
      perPage={perPage}
      viewerRole={viewerRole}
    />
  );
}
