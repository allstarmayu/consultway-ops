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
 * Compact rupee formatter — collapses large figures into lakh/crore
 * units the way Indian financial UIs do. Designed for KPI cards and
 * other low-density surfaces where "₹ 18.5 Cr" beats "₹ 18,50,00,000".
 *
 *   formatInrCompact(185000000)  // "₹ 18.50 Cr"
 *   formatInrCompact(1250000)    // "₹ 12.50 L"
 *   formatInrCompact(8500)       // "₹ 8,500"
 *   formatInrCompact(0)          // "₹ 0"
 *   formatInrCompact(null)       // ""
 *
 * Uses two decimal places on the Cr/L bucket and zero on the base
 * bucket — the precision matches what a glance can absorb without
 * over-promising accuracy.
 *
 * @param rupees Whole rupees to format. NULL/undefined returns "".
 * @returns Compact rupee string like "₹ 18.50 Cr" / "₹ 8,500".
 */
export function formatInrCompact(
  rupees: number | null | undefined,
): string {
  if (rupees === null || rupees === undefined) return "";
  const abs = Math.abs(rupees);
  const sign = rupees < 0 ? "-" : "";
  if (abs >= 10_000_000) {
    return `${sign}₹ ${(abs / 10_000_000).toFixed(2)} Cr`;
  }
  if (abs >= 100_000) {
    return `${sign}₹ ${(abs / 100_000).toFixed(2)} L`;
  }
  return `${sign}₹ ${inrFormatter.format(abs)}`;
}

// ── Paise-grained formatters (Day 17) ───────────────────────────────────

/**
 * Cached formatter for the paise tail (always two digits, e.g. "07"
 * not "7"). Cheap to construct but cached for symmetry with
 * `inrFormatter`.
 */
const paiseTailFormatter = new Intl.NumberFormat("en-IN", {
  minimumIntegerDigits: 2,
  maximumFractionDigits: 0,
  useGrouping: false,
});

/**
 * Format an amount stored in paise as a UI rupees-and-paise string.
 * Used for the transactions module where actuals (50 paise matters
 * for invoice reconciliation) need full paise precision.
 *
 *   formatRupeesFromPaise(50000000_00) // "₹ 5,00,00,000.00"
 *   formatRupeesFromPaise(12345_67)    // "₹ 12,345.67"
 *   formatRupeesFromPaise(100)         // "₹ 1.00"
 *   formatRupeesFromPaise(7)           // "₹ 0.07"
 *
 * Always shows the `.NN` paise tail (two digits) even when the figure
 * is whole rupees — financial UIs benefit from the alignment, and the
 * trailing `.00` signals "yes, this is paise-exact, not rounded."
 *
 * @param paise Integer paise count. Must be a finite number; the
 *   transactions Zod schema rejects non-integers upstream.
 * @returns Formatted string like "₹ 12,345.67".
 */
export function formatRupeesFromPaise(paise: number): string {
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  const rupees = Math.trunc(abs / 100);
  const tail = abs % 100;
  return `${sign}₹ ${inrFormatter.format(rupees)}.${paiseTailFormatter.format(tail)}`;
}

/**
 * ASCII variant of `formatRupeesFromPaise` for CSV exports, audit logs,
 * and other ASCII-safe contexts. Same rationale as `formatInrAscii`.
 *
 *   formatRupeesFromPaiseAscii(50000000_00) // "Rs.5,00,00,000.00"
 *   formatRupeesFromPaiseAscii(12345_67)    // "Rs.12,345.67"
 */
export function formatRupeesFromPaiseAscii(paise: number): string {
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  const rupees = Math.trunc(abs / 100);
  const tail = abs % 100;
  return `${sign}Rs.${inrFormatter.format(rupees)}.${paiseTailFormatter.format(tail)}`;
}

/**
 * Parse a user-typed rupees-and-paise string into integer paise.
 * Accepts `"12345"`, `"12345.6"`, `"12345.67"`, `"12,345.67"`, or
 * `"₹ 12,345.67"`. Returns null for empty/invalid input.
 *
 *   parsePaiseFromRupees("12345.67")    // 1234567
 *   parsePaiseFromRupees("12,345")      // 1234500
 *   parsePaiseFromRupees("₹ 100.05")    // 10005
 *   parsePaiseFromRupees("0.5")         // 50
 *   parsePaiseFromRupees("")            // null
 *   parsePaiseFromRupees("not a num")   // null
 *
 * Caps the paise tail at two digits — `"1.234"` parses as `"1.23"`
 * paise (123 paise total), the third decimal silently dropped. Anything
 * more is sub-paise precision the platform doesn't model.
 *
 * Used by the transactions form's amount input to convert the
 * user-facing rupees-and-paise representation into the integer paise
 * the schema expects.
 */
export function parsePaiseFromRupees(input: string): number | null {
  const trimmed = input.trim().replace(/[₹,\s]/g, "");
  if (trimmed === "" || trimmed === "-") return null;

  const isNegative = trimmed.startsWith("-");
  const unsigned = isNegative ? trimmed.slice(1) : trimmed;

  if (!/^\d+(\.\d+)?$/.test(unsigned)) return null;

  const [whole, tailRaw = ""] = unsigned.split(".");
  // Truncate (NOT round) to 2 decimals — sub-paise precision isn't modelled.
  const tail = tailRaw.slice(0, 2).padEnd(2, "0");
  const rupees = Number.parseInt(whole, 10);
  const paiseTail = Number.parseInt(tail, 10);
  if (!Number.isFinite(rupees) || !Number.isFinite(paiseTail)) return null;

  const value = rupees * 100 + paiseTail;
  return isNegative ? -value : value;
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
