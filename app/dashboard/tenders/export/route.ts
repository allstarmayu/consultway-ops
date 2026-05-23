/**
 * Tenders CSV export — admin/staff-only Route Handler.
 *
 * GET /dashboard/tenders/export?<same filters as the list page>
 *
 * Accepts the same searchParams the list page does (`status`,
 * `publisherCompanyId`, `sector`, `geography`, `search`) so a filtered
 * list can be exported as-is. The download button on the list page
 * forwards the current URL's filters through.
 *
 * Pipeline mirrors the transactions / projects exporters line-for-line:
 *
 *   1. Auth gate — admin/staff only. Company-role users get 403 (their
 *      own listing is for triage, not bulk sharing).
 *   2. Reuse `listTenders(query)` to fetch the rows. Overrides
 *      `perPage` to the hard cap so we get up to 1000 rows in one
 *      shot — at Phase-1 scale this covers the whole table.
 *   3. Build the company-name lookup in one IN-query (the map covers
 *      both `publisherCompanyId` and `awardedCompanyId`).
 *   4. Serialise to CSV with the BOM-prefixed RFC-4180 helper from
 *      `@/lib/csv`.
 *   5. Return as `text/csv` with a dated filename in
 *      `Content-Disposition`.
 *
 * @module app/dashboard/tenders/export/route
 */
import { inArray } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { readSession } from "@/lib/auth/session";
import { listTendersForExport } from "@/lib/tenders/actions";
import { tendersToCsv, csvFilenameDateStamp } from "@/lib/tenders/csv";

const FORWARDED_QUERY_KEYS = [
  "status",
  "publisherCompanyId",
  "sector",
  "geography",
  "search",
] as const;

/** Hard cap on rows exported in a single CSV at Phase-1 scale. */
const EXPORT_ROW_CAP = 1000;

export async function GET(request: NextRequest) {
  // 1. Auth gate — admin/staff only.
  const session = await readSession();
  if (!session) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  if (session.role !== "admin" && session.role !== "staff") {
    return new NextResponse("Forbidden", { status: 403 });
  }

  // 2. Forward the filter params to the action.
  const { searchParams } = new URL(request.url);
  const query: Record<string, string> = {
    perPage: String(EXPORT_ROW_CAP),
    sortBy: "createdAt",
    sortDir: "desc",
  };
  for (const key of FORWARDED_QUERY_KEYS) {
    const value = searchParams.get(key);
    if (value && value !== "") query[key] = value;
  }

  const result = await listTendersForExport(query);
  if (!result.ok) {
    return new NextResponse(result.error, { status: 400 });
  }

  // 3. Build the company-name lookup. Both publisherCompanyId and
  //    awardedCompanyId resolve through this single map.
  const companyNames = new Map<string, string>();
  if (result.rows.length > 0) {
    const distinctCompanyIds = new Set<string>();
    for (const row of result.rows) {
      distinctCompanyIds.add(row.publisherCompanyId);
      if (row.awardedCompanyId) distinctCompanyIds.add(row.awardedCompanyId);
    }
    if (distinctCompanyIds.size > 0) {
      const companyRows = await db
        .select({ id: companies.id, name: companies.name })
        .from(companies)
        .where(inArray(companies.id, Array.from(distinctCompanyIds)));
      for (const c of companyRows) companyNames.set(c.id, c.name);
    }
  }

  // 4. Serialise.
  const csv = tendersToCsv(result.rows, { companyNames });

  // 5. Respond.
  const filename = `tenders-${csvFilenameDateStamp()}.csv`;
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
