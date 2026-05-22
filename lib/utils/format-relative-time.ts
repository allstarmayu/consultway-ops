/**
 * Relative-time formatting for activity feeds and audit timelines.
 *
 * "When did this happen?" needs to be answerable at a glance. Absolute
 * timestamps like "2026-05-22T14:33:21.000Z" are precise but force the
 * reader to do arithmetic. The convention we follow:
 *
 *   - Under a minute     -> "just now"
 *   - Under an hour      -> "N minutes ago"
 *   - Under a day        -> "N hours ago"
 *   - Yesterday          -> "yesterday"
 *   - Under a week       -> "N days ago"
 *   - This calendar year -> "Apr 12"
 *   - Older              -> "Apr 12, 2025"
 *
 * Once a feed entry crosses the week boundary, exact-day-counting stops
 * adding signal ("12 days ago" vs "13 days ago" is noise) and we switch
 * to an absolute date. The year is dropped when it matches the current
 * year - reduces clutter on the common case.
 *
 * Timestamp parsing handles both formats currently in the DB (see the
 * Day-3 tech-debt note about timestamp inconsistency):
 *   - SQLite `datetime('now')`:  "2026-05-22 14:33:21"
 *   - JS `toISOString()`:        "2026-05-22T14:33:21.000Z"
 * Same normalisation pattern as `isWithinRecallWindow` in the tenders
 * state-machine module - swap the space for "T" and append "Z" when the
 * SQLite form is encountered (treat naive timestamps as UTC, matching
 * what `datetime('now')` actually returns).
 *
 * Failure mode: malformed / null / undefined input returns an empty
 * string. Callers can render a dash or "unknown" placeholder when they
 * see that - we don't pick a fallback string here because it depends on
 * context (table cell vs prose).
 *
 * @module lib/utils/format-relative-time
 */

/** One minute in milliseconds. */
const MINUTE_MS = 60 * 1000;
/** One hour in milliseconds. */
const HOUR_MS = 60 * MINUTE_MS;
/** One day in milliseconds. */
const DAY_MS = 24 * HOUR_MS;
/** One week in milliseconds - the threshold for switching to absolute dates. */
const WEEK_MS = 7 * DAY_MS;

/**
 * Parse a timestamp coming from either D1 (`datetime('now')` form) or
 * the JS layer (`Date.toISOString()` form) into a numeric ms value.
 *
 * Returns `NaN` for null, undefined, or unparseable input. Callers
 * MUST check `Number.isNaN(result)` before using the value.
 *
 * Centralised here because three call sites in this module need it and
 * keeping the normalisation rule in one place means future debt-paydown
 * (the timestamp format inconsistency from Day 3) only touches one
 * function.
 */
function parseTimestamp(raw: string | null | undefined): number {
  if (!raw) return Number.NaN;

  // SQLite's datetime('now') yields "2026-05-22 14:33:21" - a format
  // Date.parse handles inconsistently across runtimes. Normalise to ISO
  // by swapping the space for "T" and appending "Z" (treat as UTC,
  // matching what datetime('now') actually produces). When already in
  // ISO form, leave alone.
  const normalised = raw.includes("T") ? raw : raw.replace(" ", "T") + "Z";
  return Date.parse(normalised);
}

/**
 * Format an absolute timestamp as "Apr 12" or "Apr 12, 2025".
 *
 * Year is dropped when the timestamp falls within the current calendar
 * year - reduces visual clutter on the common case of "this year's
 * older entries". This is computed from `Date.now()` at call time so
 * the boundary moves correctly as we cross into January.
 *
 * Locale fixed to "en-US" so the output is stable regardless of where
 * the dashboard is being viewed. We can revisit if Consultway adds
 * localisation; for now the audit log is internal-staff-only and the
 * stable format is more valuable than locale-aware formatting.
 */
function formatAbsoluteDate(ms: number): string {
  const date = new Date(ms);
  const currentYear = new Date().getUTCFullYear();
  const sameYear = date.getUTCFullYear() === currentYear;

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
}

/**
 * Render a timestamp as a human-friendly relative phrase.
 *
 * @param raw  ISO-8601 or SQLite-form timestamp string. Tolerates null
 *             / undefined so callers don't have to guard.
 * @returns    Phrase like "5 minutes ago" / "yesterday" / "Apr 12".
 *             Empty string when the input is unparseable - callers
 *             render their own placeholder for that case.
 *
 * @example
 *   formatRelativeTime("2026-05-22T14:30:00Z");  // "just now" (when current)
 *   formatRelativeTime("2026-05-22 14:30:00");   // SQLite form, same result
 *   formatRelativeTime(null);                    // ""
 */
export function formatRelativeTime(raw: string | null | undefined): string {
  const then = parseTimestamp(raw);
  if (Number.isNaN(then)) return "";

  const now = Date.now();
  const elapsedMs = now - then;

  // Defensive: future timestamps. Shouldn't happen for audit events
  // (the DB stamps created_at server-side) but if a clock skew or a
  // freshly-inserted-and-immediately-read row produces a slightly-future
  // value, prefer "just now" over "in 2 seconds" which reads as a bug.
  if (elapsedMs < 0) return "just now";

  // Under one minute. The audit feed wouldn't normally show events this
  // fresh (no real-time polling in Phase 1), but Server Component renders
  // sometimes catch their own writes - covers the case cleanly.
  if (elapsedMs < MINUTE_MS) return "just now";

  // Under one hour - minute granularity.
  if (elapsedMs < HOUR_MS) {
    const minutes = Math.floor(elapsedMs / MINUTE_MS);
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }

  // Under one day - hour granularity.
  if (elapsedMs < DAY_MS) {
    const hours = Math.floor(elapsedMs / HOUR_MS);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }

  // Between 24 and 48 hours - "yesterday". Note this is a duration check
  // (>= 1 day elapsed), not a calendar-day check. A 25-hour-old event at
  // 1am reads as "yesterday" which is what a user expects, even if it
  // crossed two calendar boundaries.
  if (elapsedMs < 2 * DAY_MS) return "yesterday";

  // Under a week - day granularity.
  if (elapsedMs < WEEK_MS) {
    const days = Math.floor(elapsedMs / DAY_MS);
    return `${days} days ago`;
  }

  // A week or more - absolute date.
  return formatAbsoluteDate(then);
}
