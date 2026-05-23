/**
 * Shared CSV primitives used by every per-domain `*ToCsv` exporter.
 *
 * Three CSV exporters now exist — transactions (Day 17), projects
 * (Day 18), tenders (Day 19) — and each previously redeclared the same
 * RFC-4180 cell-escape, the same UTF-8 BOM prefix, the same CRLF line
 * ending, and the same date-stamp filename helper. The third occurrence
 * is the right moment to lift these into one module; the per-domain
 * formatting differences (paise vs rupees, tender-ref truncation,
 * project-name escaping, etc.) stay in the per-domain modules where
 * they belong.
 *
 * Non-goals:
 *
 *   - There is NO `domainToCsv<T>(rows, opts)` generic. The cost of
 *     making one would be paid in obscurity for the small benefit of
 *     deduplicating four-line functions. Each `*ToCsv` stays its own
 *     function with its own column list and its own formatters; this
 *     module owns only the bits that are genuinely shared.
 *
 *   - No streaming. At Phase-1 scale (the route handlers cap exports at
 *     1000 rows) every CSV fits comfortably in memory. When a domain
 *     needs >50k rows, swap to a chunked write loop on its route
 *     handler — `serialiseCsvRows` would change shape, not contract.
 *
 * @module lib/csv
 */

/**
 * The UTF-8 BOM. Prefixed to every CSV body so Excel-on-Windows opens
 * the file in UTF-8 mode rather than guessing a legacy code page. Other
 * tools (`csv` Python module, Google Sheets, `cat`) strip or render the
 * BOM harmlessly.
 */
export const CSV_BOM = "﻿";

/**
 * RFC-4180 line terminator. Excel insists on CRLF; everything else
 * tolerates either.
 */
export const CSV_LINE_ENDING = "\r\n";

/**
 * Quote a single CSV field per RFC-4180.
 *
 *   - NULL / undefined / empty → empty cell (no quotes).
 *   - Contains comma, double quote, CR, or LF → wrapped in double quotes,
 *     internal double quotes doubled.
 *   - Otherwise → emitted verbatim.
 *
 * The "empty cell on null/undefined/empty" branch is deliberate: an
 * empty string and a NULL render identically in CSV (there is no NULL
 * sentinel in the format). The per-domain `*ToCsv` modules rely on
 * this — they pass `row.referenceNumber ?? ""` and get the same output
 * shape regardless of which empty-shaped value they had.
 */
export function csvCell(raw: string | null | undefined): string {
  if (raw === null || raw === undefined || raw === "") return "";
  const needsQuoting = /[",\r\n]/.test(raw);
  if (!needsQuoting) return raw;
  return `"${raw.replace(/"/g, '""')}"`;
}

/**
 * Compose a header row + a list of data rows into the final CSV body.
 *
 * Each cell is passed through `csvCell`. The header + every row are
 * joined with commas; rows are joined with CRLF; the whole body is
 * prefixed with the UTF-8 BOM.
 *
 * The per-domain modules build their own cell arrays (where they apply
 * their domain-specific formatters) and hand them to this function for
 * the boilerplate assembly.
 */
export function serialiseCsvRows(
  headerCells: string[],
  dataRows: Array<Array<string | null | undefined>>,
): string {
  const lines: string[] = [];
  lines.push(headerCells.map(csvCell).join(","));
  for (const row of dataRows) {
    lines.push(row.map(csvCell).join(","));
  }
  return CSV_BOM + lines.join(CSV_LINE_ENDING);
}

/**
 * Build the YYYY-MM-DD date stamp for use in a CSV filename's
 * `Content-Disposition` header. `now` is overridable for tests.
 */
export function csvFilenameDateStamp(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
