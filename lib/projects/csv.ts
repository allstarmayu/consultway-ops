/**
 * CSV export helpers for the projects module.
 *
 * `projectsToCsv` takes a list of project rows + the company-name lookup
 * map and returns a RFC-4180 CSV string. Columns:
 *
 *   Name, Status, Company, Start, End, Budget, Tender, Created at
 *
 * Shape parallel to `lib/transactions/csv.ts` but for projects' simpler
 * money regime — `budgetInr` is whole rupees (no paise), so the Budget
 * column is a plain integer, not the decimal-rupees form. The shared
 * RFC-4180 escape, BOM, CRLF, and date-stamp helper all come from
 * `@/lib/csv`; the only projects-specific formatter is
 * `formatTenderRef` (UUID truncation).
 *
 * @module lib/projects/csv
 */
import type { Project } from "@/lib/db/schema";
import { serialiseCsvRows } from "@/lib/csv";

// Re-export the shared filename-stamp helper under the historical
// `projectsCsvFilenameDateStamp` alias so the existing export route +
// tests keep working without an import-path edit.
export { csvFilenameDateStamp as projectsCsvFilenameDateStamp } from "@/lib/csv";

export interface ProjectsCsvLookups {
  companyNames: Map<string, string>;
}

/**
 * Truncate a tenderId UUID to its first 8 chars for display in the CSV.
 * Full UUIDs blow out the column width and rarely pivot a reader's
 * decision — the truncated form is enough to spot "this project came
 * from a tender" and to look up the row in the tenders list. NULL
 * `tenderId` renders as an empty cell.
 */
function formatTenderRef(tenderId: string | null): string {
  if (!tenderId) return "";
  return tenderId.length > 8 ? `${tenderId.slice(0, 8)}...` : tenderId;
}

const HEADER = [
  "Name",
  "Status",
  "Company",
  "Start",
  "End",
  "Budget",
  "Tender",
  "Created at",
];

/**
 * Build a CSV string from project rows + company-name lookup. Returns
 * the full CSV including a leading UTF-8 BOM and CRLF line endings
 * (RFC-4180 convention).
 *
 * Budget is rendered as a plain integer (whole rupees) with no
 * thousands separators and no currency glyph — spreadsheet apps can
 * apply locale-aware formatting on the column. NULL budgets render as
 * empty cells.
 */
export function projectsToCsv(
  rows: Project[],
  lookups: ProjectsCsvLookups,
): string {
  const dataRows = rows.map((row) => {
    const company = lookups.companyNames.get(row.companyId) ?? "";
    return [
      row.name,
      row.status,
      company,
      row.startDate ?? "",
      row.endDate ?? "",
      row.budgetInr === null || row.budgetInr === undefined
        ? ""
        : String(row.budgetInr),
      formatTenderRef(row.tenderId),
      row.createdAt,
    ];
  });

  return serialiseCsvRows(HEADER, dataRows);
}
