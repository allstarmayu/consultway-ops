/**
 * Indian-rupee number formatting helpers.
 *
 * Two exports, deliberately split by audience:
 *
 *   - `formatInr` for **UI** — uses the ₹ glyph and is what users see in
 *     forms, detail pages, and dashboards. en-IN locale grouping
 *     produces the familiar lakh/crore comma pattern
 *     (50000000 → "₹ 5,00,00,000") rather than the western thousands
 *     pattern.
 *
 *   - `formatInrAscii` for **errors and logs** — uses the "Rs." ASCII
 *     prefix. Server Actions return errors as plain JSON strings that
 *     flow through audit logs, structured loggers, and CI consumers;
 *     the rupee glyph is a multi-byte character that can mojibake in
 *     log-viewer pipelines that aren't fully UTF-8-clean. ASCII keeps
 *     the figure legible everywhere.
 *
 * Both functions are pure - no React, no Next-specific imports - so
 * the module is importable from "use server" files, Client Components,
 * Server Components, and edge-runtime route handlers alike.
 *
 * Locale note: `Intl.NumberFormat("en-IN")` is supported in Node 14+,
 * all evergreen browsers, and the V8 isolate that Cloudflare Workers
 * runs - the platforms we care about. No polyfill needed.
 *
 * @module lib/format/inr
 */

// ── Shared formatter instance ────────────────────────────────────────────

/**
 * Cached `Intl.NumberFormat` instance. Constructing a formatter is the
 * expensive part of locale-aware formatting; reusing the same instance
 * across calls is the standard optimisation. The en-IN locale produces
 * lakh/crore grouping (3-2-2 commas) which is what we want for every
 * call site - any caller wanting a different pattern can build their
 * own formatter.
 *
 * `maximumFractionDigits: 0` because all our turnover figures are whole
 * rupees (the DB column is INTEGER and the Zod schema rejects non-int
 * input). Fractional rupees would be paise, which Indian regulators
 * treat as a separate unit; we keep that out of the formatter's
 * concern.
 */
const inrFormatter = new Intl.NumberFormat("en-IN", {
  maximumFractionDigits: 0,
});

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Format a rupee integer for UI display with the ₹ glyph and en-IN
 * locale grouping.
 *
 *   formatInr(50000000)  // "₹ 5,00,00,000"
 *   formatInr(500)       // "₹ 500"
 *   formatInr(0)         // "₹ 0"
 *   formatInr(null)      // ""
 *   formatInr(undefined) // ""
 *
 * Returns the empty string for null / undefined so the caller can
 * decide what to show instead (typically an "Not stated" italic hint
 * via the Fact primitive's `emptyHint`, or simply hiding the helper
 * line on a form). This is friendlier than throwing - the "no figure"
 * case is a normal data shape for the `companies.annualTurnover`
 * column, not an error.
 *
 * The leading-space-after-glyph format (`"₹ 5,00,00,000"`) matches the
 * tender form's pre-existing inline formatter exactly - keeping the
 * lift behaviourally identical means no visual shift on the tender
 * form when the inline helper is removed.
 *
 * @param rupees Whole rupees to format. NULL/undefined returns "".
 * @returns Formatted string like "₹ 5,00,00,000", or "" for null input.
 */
export function formatInr(rupees: number | null | undefined): string {
  if (rupees === null || rupees === undefined) return "";
  return `₹ ${inrFormatter.format(rupees)}`;
}

/**
 * Format a rupee integer for error messages, audit logs, and any other
 * ASCII-safe context. Uses "Rs." prefix (no space) instead of the
 * rupee glyph so the figure survives non-UTF-8-clean log pipelines.
 *
 *   formatInrAscii(50000000) // "Rs.5,00,00,000"
 *   formatInrAscii(500)      // "Rs.500"
 *   formatInrAscii(0)        // "Rs.0"
 *
 * Unlike `formatInr`, this function does NOT accept null/undefined -
 * error messages and log lines should not contain "Rs.NaN" or empty
 * placeholders, so we make the call site handle the absence-case
 * explicitly. Rejecting null at the type level catches the mistake
 * at compile time.
 *
 * No space between prefix and digits because logs are often
 * grep'd / column-split on whitespace; keeping "Rs.5,00,00,000" as a
 * single token avoids surprises in CLI pipelines.
 *
 * @param rupees Whole rupees to format.
 * @returns Formatted string like "Rs.5,00,00,000".
 */
export function formatInrAscii(rupees: number): string {
  return `Rs.${inrFormatter.format(rupees)}`;
}
