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
 * UTF-8 BOM prefix is included so Excel on Windows opens the file in
 * UTF-8 mode rather than guessing legacy code pages. Other tools
 * (`csv` Python module, Google Sheets, `cat`) strip or render the BOM
 * harmlessly.
 *
 * No streaming — at Phase-1 scale (single-digit thousands of rows)
 * the export fits in memory comfortably. When the table grows past
 * ~50k rows, swap to a chunked write loop on the route handler.
 *
 * @module lib/transactions/csv
 */
import type { Transaction } from "@/lib/db/schema";

/**
 * Lookup maps the caller provides — same shape the list page builds
 * for the table render (companyId → name, projectId → name).
 */
export interface CsvLookups {
  companyNames: Map<string, string>;
  projectNames: Map<string, string>;
}

/**
 * Quote a single CSV field per RFC-4180. Wraps in double quotes when
 * the value contains a comma, double quote, CR, or LF, and escapes
 * internal double quotes by doubling them.
 */
function csvCell(raw: string | null | undefined): string {
  if (raw === null || raw === undefined || raw === "") return "";
  const needsQuoting = /[",\r\n]/.test(raw);
  if (!needsQuoting) return raw;
  return `"${raw.replace(/"/g, '""')}"`;
}

/**
 * Format a paise integer as `"NNNN.NN"` for the CSV's Amount column.
 * Plain decimal, no thousands separators (spreadsheet apps re-format
 * based on the user's locale).
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
  const lines: string[] = [];
  lines.push(HEADER.map(csvCell).join(","));

  for (const row of rows) {
    const company = lookups.companyNames.get(row.companyId) ?? "";
    const project = row.projectId
      ? (lookups.projectNames.get(row.projectId) ?? "")
      : "";

    const cells = [
      row.occurredOn,
      row.type,
      formatPaiseForCsv(row.amountPaise),
      row.currency,
      company,
      project,
      row.referenceNumber ?? "",
      row.notes ?? "",
    ];

    lines.push(cells.map(csvCell).join(","));
  }

  // UTF-8 BOM so Excel-on-Windows opens the file as UTF-8.
  return "﻿" + lines.join("\r\n");
}

/**
 * Build the YYYY-MM-DD date stamp for use in the CSV filename's
 * `Content-Disposition` header.
 */
export function csvFilenameDateStamp(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
