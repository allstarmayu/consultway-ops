/**
 * Tender status state machine.
 *
 * Centralises the legal transitions between `TenderStatus` values so the
 * four status-transition Server Actions (`publishTender`, `unpublishTender`,
 * `closeTender`, `markAwarded`) share one source of truth. Without this,
 * each action would re-implement its own "is this transition valid?"
 * branch and the rules would inevitably drift apart.
 *
 * The legal transitions are:
 *
 *     draft     ─────▶ published   (publishTender)
 *     published ─────▶ draft       (unpublishTender — guarded: no applications)
 *     published ─────▶ closed      (closeTender)
 *     closed    ─────▶ awarded     (markAwarded)
 *
 * Everything else is illegal. Notable rejections:
 *   - `closed → published`: re-opening a closed tender would confuse the
 *     companies who saw it close. If staff need to extend a window, they
 *     should do that BEFORE closing, or create a fresh draft.
 *   - `awarded → *`: terminal state. The audit log captures the award
 *     event; reversing it should be an explicit admin DB intervention,
 *     not a one-click action.
 *   - `draft → closed/awarded`: drafts haven't been visible to anyone, so
 *     "closing" or "awarding" them is meaningless — delete instead.
 *
 * Editability rules are also encoded here so `updateTender` consults
 * one place to decide what fields a row in a given status can mutate.
 * See `getEditableFieldsForStatus` below.
 *
 * @module lib/tenders/state-machine
 */
import type { TenderStatus } from "@/lib/db/schema";

// ── Transition table ──────────────────────────────────────────────────────

/**
 * Map of `from → set of legal `to` values`. Reading
 * `LEGAL_TRANSITIONS[current].has(next)` is the single source of truth.
 *
 * Stored as `Record<TenderStatus, ReadonlySet<TenderStatus>>` so TypeScript
 * verifies every status has an entry (exhaustiveness) and we don't ship
 * a transition table missing a state.
 */
const LEGAL_TRANSITIONS: Record<TenderStatus, ReadonlySet<TenderStatus>> = {
  draft: new Set<TenderStatus>(["published"]),
  published: new Set<TenderStatus>(["draft", "closed"]),
  closed: new Set<TenderStatus>(["awarded"]),
  awarded: new Set<TenderStatus>(), // terminal
};

/**
 * Is the transition `from → to` legal?
 *
 * Returns `true` only for explicit transitions in the table. A "no-op"
 * transition where `from === to` is NOT legal here — the caller should
 * short-circuit before consulting this function (an idempotent re-publish
 * is a different code path than a transition).
 */
export function isLegalTransition(
  from: TenderStatus,
  to: TenderStatus,
): boolean {
  return LEGAL_TRANSITIONS[from].has(to);
}

/**
 * Human-friendly error string for an illegal transition. Used directly
 * as the `error` field in `ActionResult` returns so the UI can surface
 * a useful message instead of "invalid".
 */
export function illegalTransitionMessage(
  from: TenderStatus,
  to: TenderStatus,
): string {
  if (from === to) {
    return `Tender is already ${from}`;
  }
  // Hand-tuned messages for the common cases — clearer than a generic
  // "can't transition" string. Falls back to a generic message for any
  // illegal pair not in the explicit list.
  if (from === "awarded") {
    return "Awarded tenders are final and cannot change status";
  }
  if (from === "closed" && to === "published") {
    return "Closed tenders cannot be re-opened; create a new draft instead";
  }
  if (from === "draft" && (to === "closed" || to === "awarded")) {
    return `A draft tender must be published before it can be ${to}`;
  }
  return `Cannot transition tender from ${from} to ${to}`;
}

// ── Editability per status ────────────────────────────────────────────────

/**
 * Fields on a tender row that may be edited via `updateTender`. The set
 * depends on the row's current status:
 *
 *   - `draft`     — everything editable. The tender hasn't been visible
 *                   to companies yet, so any change is safe.
 *   - `published` — most fields editable, EXCEPT the four eligibility
 *                   filters (`eligibleSector`, `eligibleGeography`,
 *                   `minAnnualTurnoverInr`, `msmeOnly`). Changing those
 *                   after publish would silently invalidate existing
 *                   applications — companies who applied under one
 *                   eligibility set would suddenly be looking at a
 *                   different one. Cleaner: lock them, force a draft
 *                   revision via `unpublishTender` (only if no apps yet)
 *                   or a fresh draft.
 *   - `closed`    — only `internalNotes` editable. Staff still need to
 *                   record evaluation notes while reviewing applications.
 *   - `awarded`   — only `internalNotes` editable. Terminal state; the
 *                   notes channel stays open for retrospective context
 *                   (debriefs, lessons-learned, etc.).
 *
 * The arrays here are field names matching the keys in `tenders.$inferInsert`.
 * `updateTender` consults this list and silently drops any field outside
 * it when applying a patch — same "drop on write" pattern the companies
 * module uses for staff-only fields on company-role updates.
 */
export type TenderEditableField =
  | "title"
  | "description"
  | "referenceNumber"
  | "sector"
  | "geography"
  | "eligibleSector"
  | "eligibleGeography"
  | "minAnnualTurnoverInr"
  | "msmeOnly"
  | "openingDate"
  | "closingDate"
  | "internalNotes";

/**
 * Every editable field across all statuses. Used by `draft` (all of
 * them) and as the master list `updateTender` iterates over.
 */
const ALL_EDITABLE_FIELDS: readonly TenderEditableField[] = [
  "title",
  "description",
  "referenceNumber",
  "sector",
  "geography",
  "eligibleSector",
  "eligibleGeography",
  "minAnnualTurnoverInr",
  "msmeOnly",
  "openingDate",
  "closingDate",
  "internalNotes",
] as const;

/**
 * Eligibility fields locked once a tender is published. Used to compute
 * the `published`-status editable set.
 */
const ELIGIBILITY_FIELDS: ReadonlySet<TenderEditableField> = new Set<TenderEditableField>([
  "eligibleSector",
  "eligibleGeography",
  "minAnnualTurnoverInr",
  "msmeOnly",
]);

/**
 * Returns the set of fields that may be edited on a row in the given
 * status. Always returns a Set so the caller can do
 * `editable.has(fieldName)` in a tight loop without allocating.
 */
export function getEditableFieldsForStatus(
  status: TenderStatus,
): ReadonlySet<TenderEditableField> {
  switch (status) {
    case "draft":
      return new Set(ALL_EDITABLE_FIELDS);

    case "published":
      // Everything except the four locked eligibility fields.
      return new Set(
        ALL_EDITABLE_FIELDS.filter((f) => !ELIGIBILITY_FIELDS.has(f)),
      );

    case "closed":
    case "awarded":
      // Only internal notes — staff still need to track evaluations and
      // post-award context.
      return new Set<TenderEditableField>(["internalNotes"]);
  }
}

/**
 * True when the tender row at this status accepts at least one editable
 * field. Used by the UI to decide whether to show the "Edit" button at
 * all. (`awarded` and `closed` return `true` because internalNotes is
 * still editable — the edit form will just present a single field.)
 */
export function isAnyFieldEditable(status: TenderStatus): boolean {
  return getEditableFieldsForStatus(status).size > 0;
}

// ── Apply gate ────────────────────────────────────────────────────────────

/**
 * Whether applications are currently being accepted on a tender. Only
 * `published` tenders accept applications — `draft` is invisible, and
 * `closed` / `awarded` are past the window.
 *
 * Date checks (closingDate) live separately in `applyToTender` because
 * they need the row's actual date values; this function only handles
 * the status-level gate.
 */
export function acceptsApplications(status: TenderStatus): boolean {
  return status === "published";
}
