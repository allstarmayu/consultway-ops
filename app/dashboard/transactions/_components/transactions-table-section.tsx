/**
 * Transactions table section — the async-fetching half of the list page.
 *
 * Mirrors `ProjectsTableSection`. Pre-fetches owning-company AND linked-
 * project names for the rendered page in two indexed IN-queries so the
 * table doesn't N+1-fetch.
 *
 * @module app/dashboard/transactions/_components/transactions-table-section
 */
import { inArray } from "drizzle-orm";
import { listTransactions } from "@/lib/transactions/actions";
import { db } from "@/lib/db";
import { companies, projects } from "@/lib/db/schema";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { TransactionsTable } from "./transactions-table";

export interface TransactionsTableSectionProps {
  /**
   * Raw `searchParams` from the page. Passed through unchanged — the
   * action's Zod schema handles coercion, defaults, and validation.
   */
  query: Record<string, string | string[] | undefined>;
}

export async function TransactionsTableSection({
  query,
}: TransactionsTableSectionProps) {
  const result = await listTransactions(query);

  if (!result.ok) {
    return (
      <Alert variant="destructive" className="m-4">
        <AlertTitle>Couldn&apos;t load transactions</AlertTitle>
        <AlertDescription>{result.error}</AlertDescription>
      </Alert>
    );
  }

  const { rows, total, page, perPage } = result;

  const companyNames = new Map<string, string>();
  const projectNames = new Map<string, string>();

  if (rows.length > 0) {
    const distinctCompanyIds = Array.from(
      new Set(rows.map((r) => r.companyId)),
    );
    const distinctProjectIds = Array.from(
      new Set(
        rows
          .map((r) => r.projectId)
          .filter((id): id is string => id !== null),
      ),
    );

    const [companyRows, projectRows] = await Promise.all([
      distinctCompanyIds.length > 0
        ? db
            .select({ id: companies.id, name: companies.name })
            .from(companies)
            .where(inArray(companies.id, distinctCompanyIds))
        : Promise.resolve([]),
      distinctProjectIds.length > 0
        ? db
            .select({ id: projects.id, name: projects.name })
            .from(projects)
            .where(inArray(projects.id, distinctProjectIds))
        : Promise.resolve([]),
    ]);

    for (const c of companyRows) companyNames.set(c.id, c.name);
    for (const p of projectRows) projectNames.set(p.id, p.name);
  }

  return (
    <TransactionsTable
      rows={rows}
      companyNames={companyNames}
      projectNames={projectNames}
      total={total}
      page={page}
      perPage={perPage}
    />
  );
}
