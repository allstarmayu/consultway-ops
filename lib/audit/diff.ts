/**
 * Compute the field-by-field diff between an audit event's `before`
 * and `after` snapshots.
 *
 * Day 7 polish (Chunk 4): the activity-feed row is collapsible. When
 * a user expands it, this function produces the diff that gets
 * rendered inside the expanded panel.
 *
 * Filtering rules:
 *   - `updatedAt` / `createdAt` are skipped. They change on every
 *     mutation and add no signal.
 *   - Fields whose values are deeply-equal between before and after
 *     are skipped. (Defensive: per Day-2's snapshot-design principle
 *     partial snapshots should only contain changed fields, but be
 *     tolerant of full-snapshot inputs.)
 *   - Fields that exist on only one side are included with the
 *     missing side rendered as `undefined`.
 *
 * Returns rows sorted alphabetically by field name. Predictable
 * order avoids the diff visually reshuffling on each render.
 *
 * Failure mode: if either input is null/undefined or not a plain
 * object, returns an empty array. The renderer will hide the toggle
 * when this happens, so a deleted event with no `after` (or a
 * created event with no `before`) gracefully shows no diff panel.
 *
 * @module lib/audit/diff
 */

/**
 * One row in the diff. `from` and `to` are intentionally `unknown`
 * since audit snapshots can contain any primitive or null - the
 * renderer narrows at presentation time.
 */
export interface DiffRow {
  /** Field name from the snapshot key. */
  field: string;
  /** Value in the `before` snapshot. May be `undefined` if field is new. */
  from: unknown;
  /** Value in the `after` snapshot. May be `undefined` if field was removed. */
  to: unknown;
}

/** Field names that should never appear in a diff panel. */
const SKIPPED_FIELDS = new Set(["createdAt", "updatedAt"]);

/**
 * Shallow-equality check for diff filtering.
 *
 * For primitives (string, number, boolean, null), `===` is enough.
 * For objects / arrays we fall back to JSON-stringify equality, which
 * is good enough for audit snapshots - they're typed
 * `Record<string, unknown>` but in practice contain only primitives.
 * If we ever store nested objects (e.g. structured addresses), we'd
 * swap this for a proper deep-equal.
 *
 * `NaN === NaN` is false in JS, but `NaN` won't appear in JSON-mode
 * audit columns (it's not valid JSON), so we don't special-case it.
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a === "object") {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      // Circular reference or similar - fail closed (treat as
      // different so the row appears in the diff for forensic
      // visibility).
      return false;
    }
  }
  return false;
}

/**
 * Type guard: is the input a plain-object snapshot we can iterate?
 */
function isSnapshot(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Compute the diff.
 *
 * @param before  The `before` snapshot from an audit row. May be
 *                undefined / null / non-object - those produce an
 *                empty diff.
 * @param after   The `after` snapshot. Same tolerance.
 * @returns       Sorted array of `DiffRow`. Empty when there's
 *                nothing meaningful to show.
 */
export function computeDiff(before: unknown, after: unknown): DiffRow[] {
  const beforeObj = isSnapshot(before) ? before : null;
  const afterObj = isSnapshot(after) ? after : null;

  if (!beforeObj && !afterObj) return [];

  // Collect every field present in either snapshot. Set dedupes.
  const allFields = new Set<string>();
  if (beforeObj) {
    for (const k of Object.keys(beforeObj)) allFields.add(k);
  }
  if (afterObj) {
    for (const k of Object.keys(afterObj)) allFields.add(k);
  }

  const rows: DiffRow[] = [];

  for (const field of allFields) {
    if (SKIPPED_FIELDS.has(field)) continue;

    const from = beforeObj?.[field];
    const to = afterObj?.[field];

    // Filter out fields where both snapshots had the same value.
    // Partial snapshots shouldn't include these per Day-2's design,
    // but we tolerate full snapshots gracefully here.
    if (valuesEqual(from, to)) continue;

    rows.push({ field, from, to });
  }

  // Stable alphabetic order. Predictable rendering across re-renders.
  rows.sort((a, b) => a.field.localeCompare(b.field));

  return rows;
}

/**
 * Humanise a camelCase field name for display.
 *
 * "complianceStatus" -> "Compliance status"
 * "isMsme"           -> "Is msme"  (acronyms aren't handled - cosmetic)
 * "name"             -> "Name"
 *
 * Acronym handling (MSME, JV, GST) isn't done here on purpose -
 * doing it well requires a curated word list and the cost-benefit
 * isn't worth it. The slight ugliness is acceptable in a forensic
 * panel; the user is reading carefully when this is open.
 */
export function humaniseFieldName(field: string): string {
  // Split camelCase boundaries
  const spaced = field.replace(/([a-z])([A-Z])/g, "$1 $2");
  // Capitalise first letter, lowercase the rest
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/**
 * Render a snapshot value as a human-readable string for the diff
 * panel.
 *
 * Returns an object with the display string and a flag indicating
 * whether the original is "missing" (undefined/null), so the
 * renderer can apply muted styling for absent values without
 * needing to re-derive the semantic from the string.
 *
 * Truncation: strings over 80 chars get truncated with "..." - the
 * renderer can put the full string in a `title` attribute for
 * hover-reveal. We don't do truncation here; we return the full
 * string and the renderer decides.
 */
export interface RenderedValue {
  display: string;
  isMissing: boolean;
}

export function renderDiffValue(value: unknown): RenderedValue {
  if (value === undefined || value === null) {
    return { display: "—", isMissing: true };
  }
  if (typeof value === "boolean") {
    return { display: value ? "Yes" : "No", isMissing: false };
  }
  if (typeof value === "string") {
    if (value.length === 0) {
      return { display: "(empty)", isMissing: true };
    }
    return { display: value, isMissing: false };
  }
  if (typeof value === "number") {
    return { display: String(value), isMissing: false };
  }
  // Object / array / anything else - JSON-stringify as a fallback.
  // Snapshots aren't supposed to contain these per the audit design,
  // but we don't want a render crash if something slips through.
  try {
    return { display: JSON.stringify(value), isMissing: false };
  } catch {
    return { display: "(unrenderable)", isMissing: true };
  }
}
