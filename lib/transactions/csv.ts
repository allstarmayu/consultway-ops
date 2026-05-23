/**
 * CSV export helpers for the transactions module.
 *
 * `transactionsToCsv` takes a list of transaction rows + the
 * company-name and project-name lookup maps and returns a RFC-4180
 * CSV string. Columns:
 *
 *   Date, Type, Amount, Currency, Company, Project, Reference, Notes
 *
 * Amount is the rupees-with-paise decimal form (e.g. `"12345.67"`) —
 * spreadsheet apps can parse this as a number when the column is
 * formatted as currency. We deliberately don't include the ₹ glyph
 * in the CSV cell because:
 *
 *   - Excel often treats prefixed-currency cells as TEXT, breaking
 *     SUM / AVG formulas.
 *   - The Currency column carries the currency code explicitly.
 *
 * UTF-8 BOM + CRLF line endings are inherited from `@/lib/csv`.
 *
 * No streaming — at Phase-1 scale (single-digit thousands of rows)
 * the export fits in memory comfortably. When the table grows past
 * ~50k rows, swap to a chunked write loop on the route handler.
 *
 * @module lib/transactions/csv
 */
import type { Transaction } from "@/lib/db/schema";
import { serialiseCsvRows } from "@/lib/csv";

// Re-export the shared filename-stamp helper so existing call sites
// (notably `app/dashboard/transactions/export/route.ts`) keep working
// without an import-path edit.
export { csvFilenameDateStamp } from "@/lib/csv";

/**
 * Lookup maps the caller provides — same shape the list page builds
 * for the table render (companyId → name, projectId → name).
 */
export interface CsvLookups {
  companyNames: Map<string, string>;
  projectNames: Map<string, string>;
}

/**
 * Format a paise integer as `"NNNN.NN"` for the CSV's Amount column.
 * Plain decimal, no thousands separators (spreadsheet apps re-format
 * based on the user's locale). Transactions-specific — the rupees-only
 * domains (projects) use a different formatter.
 */
function formatPaiseForCsv(paise: number): string {
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  const rupees = Math.trunc(abs / 100);
  const tail = abs % 100;
  const tailStr = tail < 10 ? `0${tail}` : `${tail}`;
  return `${sign}${rupees}.${tailStr}`;
}

const HEADER = [
  "Date",
  "Type",
  "Amount",
  "Currency",
  "Company",
  "Project",
  "Reference",
  "Notes",
];

/**
 * Build a CSV string from transaction rows + name lookups.
 *
 * Returns the full CSV including a leading UTF-8 BOM and CRLF line
 * endings (RFC-4180 convention).
 */
export function transactionsToCsv(
  rows: Transaction[],
  lookups: CsvLookups,
): string {
  const dataRows = rows.map((row) => {
    const company = lookups.companyNames.get(row.companyId) ?? "";
    const project = row.projectId
      ? (lookups.projectNames.get(row.projectId) ?? "")
      : "";
    return [
      row.occurredOn,
      row.type,
      formatPaiseForCsv(row.amountPaise),
      row.currency,
      company,
      project,
      row.referenceNumber ?? "",
      row.notes ?? "",
    ];
  });

  return serialiseCsvRows(HEADER, dataRows);
}
