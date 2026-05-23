/**
 * CSV export helpers for the tenders module.
 *
 * `tendersToCsv` takes a list of tender rows + a company-name lookup
 * map (covering both `publisherCompanyId` and `awardedCompanyId`) and
 * returns a RFC-4180 CSV string. Columns:
 *
 *   Title, Status, Reference, Publisher, Sector, Geography,
 *   Opening, Closing, Awarded company, Published at
 *
 * Shape parallel to `lib/projects/csv.ts` and `lib/transactions/csv.ts`
 * but with the tender-specific column list. NULL semantics on every
 * nullable column (`referenceNumber`, `openingDate`, `closingDate`,
 * `awardedCompanyId`, `publishedAt`) → empty cells. The
 * `publisherCompanyId` column is NOT NULL on the schema, so its lookup
 * always resolves (pinned by a test).
 *
 * Shared cell escape, BOM, CRLF, and filename-stamp come from
 * `@/lib/csv` — see that module's docstring for the rationale.
 *
 * @module lib/tenders/csv
 */
import type { Tender } from "@/lib/db/schema";
import { serialiseCsvRows } from "@/lib/csv";

// Re-export the shared filename-stamp helper so route handlers can
// import everything CSV-related from one module.
export { csvFilenameDateStamp } from "@/lib/csv";

/**
 * Lookup the caller provides — same Map shape the existing per-domain
 * CSV exporters use. Both `publisherCompanyId` and `awardedCompanyId`
 * resolve through this single map.
 */
export interface TendersCsvLookups {
  companyNames: Map<string, string>;
}

const HEADER = [
  "Title",
  "Status",
  "Reference",
  "Publisher",
  "Sector",
  "Geography",
  "Opening",
  "Closing",
  "Awarded company",
  "Published at",
];

/**
 * Build a CSV string from tender rows + company-name lookup. Returns
 * the full CSV including a leading UTF-8 BOM and CRLF line endings.
 *
 * `publisherCompanyId` is NOT NULL on the schema; if the lookup misses
 * (the company was deleted out from under the row — which the ON DELETE
 * RESTRICT cascade should prevent), the cell renders empty rather than
 * blocking the export.
 */
export function tendersToCsv(
  rows: Tender[],
  lookups: TendersCsvLookups,
): string {
  const dataRows = rows.map((row) => {
    const publisher = lookups.companyNames.get(row.publisherCompanyId) ?? "";
    const awardedCompany = row.awardedCompanyId
      ? (lookups.companyNames.get(row.awardedCompanyId) ?? "")
      : "";
    return [
      row.title,
      row.status,
      row.referenceNumber ?? "",
      publisher,
      row.sector,
      row.geography,
      row.openingDate ?? "",
      row.closingDate ?? "",
      awardedCompany,
      row.publishedAt ?? "",
    ];
  });

  return serialiseCsvRows(HEADER, dataRows);
}
