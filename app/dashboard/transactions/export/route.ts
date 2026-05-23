/**
 * Transactions CSV export — admin-only Route Handler.
 *
 * GET /dashboard/transactions/export?<same filters as the list page>
 *
 * Accepts the same searchParams the list page does so a filtered list
 * can be exported as-is. The download button on the list page wraps
 * the current URL's filters through to this route.
 *
 * Pipeline:
 *   1. Auth gate — admin only. 403 on miss.
 *   2. Reuse `listTransactions(query)` (admin-gated) to fetch the rows.
 *      We override `perPage` to the hard cap (1000) so we get the
 *      first 1000 rows in one shot — at Phase-1 scale this covers the
 *      whole table; when the table grows past that, swap to a chunked
 *      cursor loop.
 *   3. Build the company/project name lookups in two IN-queries.
 *   4. Serialise to CSV with the BOM-prefixed RFC-4180 helper.
 *   5. Return as `text/csv` with a dated filename in
 *      `Content-Disposition`.
 *
 * @module app/dashboard/transactions/export/route
 */
import { inArray } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/lib/db";
import { companies, projects } from "@/lib/db/schema";
import { readSession } from "@/lib/auth/session";
import { listTransactions } from "@/lib/transactions/actions";
import {
  transactionsToCsv,
  csvFilenameDateStamp,
} from "@/lib/transactions/csv";

const FORWARDED_QUERY_KEYS = [
  "type",
  "companyId",
  "projectId",
  "occurredOnFrom",
  "occurredOnTo",
] as const;

/** Hard cap on rows exported in a single CSV at Phase-1 scale. */
const EXPORT_ROW_CAP = 1000;

export async function GET(request: NextRequest) {
  // 1. Auth gate — admin only.
  const session = await readSession();
  if (!session) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  if (session.role !== "admin") {
    return new NextResponse("Forbidden", { status: 403 });
  }

  // 2. Forward the filter params to the action.
  const { searchParams } = new URL(request.url);
  const query: Record<string, string> = {
    perPage: String(EXPORT_ROW_CAP),
    sortBy: "occurredOn",
    sortDir: "desc",
  };
  for (const key of FORWARDED_QUERY_KEYS) {
    const value = searchParams.get(key);
    if (value && value !== "") query[key] = value;
  }

  const result = await listTransactions(query);
  if (!result.ok) {
    return new NextResponse(result.error, { status: 400 });
  }

  // 3. Build company / project name lookups for the rendered rows.
  const companyNames = new Map<string, string>();
  const projectNames = new Map<string, string>();

  if (result.rows.length > 0) {
    const distinctCompanyIds = Array.from(
      new Set(result.rows.map((r) => r.companyId)),
    );
    const distinctProjectIds = Array.from(
      new Set(
        result.rows
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

  // 4. Serialise.
  const csv = transactionsToCsv(result.rows, { companyNames, projectNames });

  // 5. Respond.
  const filename = `transactions-${csvFilenameDateStamp()}.csv`;
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
