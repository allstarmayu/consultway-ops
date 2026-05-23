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
 * column is a plain integer, not the decimal-rupees form. Resist the
 * temptation to lift a shared `lib/csv.ts` helper at the two-occurrence
 * mark: the projects export has different columns, different formatting,
 * and a different cascade-style. The third occurrence is when the
 * abstraction earns its keep.
 *
 * UTF-8 BOM prefix + CRLF line endings, same conventions as the
 * transactions exporter.
 *
 * @module lib/projects/csv
 */
import type { Project } from "@/lib/db/schema";

export interface ProjectsCsvLookups {
  companyNames: Map<string, string>;
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
  const lines: string[] = [];
  lines.push(HEADER.map(csvCell).join(","));

  for (const row of rows) {
    const company = lookups.companyNames.get(row.companyId) ?? "";
    const cells = [
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

    lines.push(cells.map(csvCell).join(","));
  }

  // UTF-8 BOM so Excel-on-Windows opens the file as UTF-8.
  return "﻿" + lines.join("\r\n");
}

/**
 * YYYY-MM-DD date stamp for the export filename's `Content-Disposition`
 * header. Mirrors `lib/transactions/csv.ts::csvFilenameDateStamp` —
 * duplicated rather than shared at the two-occurrence mark.
 */
export function projectsCsvFilenameDateStamp(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
