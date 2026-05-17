/**
 * Tender + application status state machine.
 *
 * Centralises the legal transitions between `TenderStatus` and
 * `TenderApplicationStatus` values so every status-changing Server
 * Action shares one source of truth. Without this, each action would
 * re-implement its own "is this transition valid?" branch and the
 * rules would inevitably drift apart.
 *
 * ── Tender lifecycle ──────────────────────────────────────────────────
 *
 * Legal transitions (Day 5 relaxed model — reversal capability):
 *
 *     draft     ──────▶ published     (publishTender)
 *     published ──────▶ draft         (unpublishTender — guarded: no applications)
 *     published ──────▶ closed        (closeTender)
 *     closed    ──────▶ awarded       (markAwarded)
 *
 *     ── Reversals (Day 5, admin-initiated) ────────────────────────────
 *     closed    ──────▶ published     (reopenTender — admin only;
 *                                       UI warns about applicant
 *                                       confusion)
 *     awarded   ──────▶ closed        (retractAward — admin only;
 *                                       requires a reason captured in
 *                                       the audit log)
 *
 * Notable rejections:
 *   - `draft → closed / awarded`: drafts haven't been visible to anyone,
 *     so "closing" or "awarding" them is meaningless — delete instead.
 *   - `awarded → published / draft`: forcing the path through `closed`
 *     keeps every state visit auditable. Reopening an awarded tender
 *     directly to published would skip a checkpoint.
 *   - Anything from `draft` other than `published`.
 *
 * ── Application lifecycle ─────────────────────────────────────────────
 *
 *     submitted   ──────▶ shortlisted   (updateApplicationStatus, staff)
 *     submitted   ──────▶ rejected      (updateApplicationStatus, staff)
 *     submitted   ──────▶ withdrawn     (withdrawApplication, company)
 *
 *     ── Reversals (Day 5) ─────────────────────────────────────────────
 *     shortlisted ──────▶ submitted     (reinstateApplication, admin/staff)
 *     rejected    ──────▶ submitted     (reinstateApplication, admin/staff)
 *     withdrawn   ──────▶ submitted     (recallApplication, company on own,
 *                                         within RECALL_WINDOW_DAYS of
 *                                         `decidedAt`)
 *
 * Editability rules are also encoded here so `updateTender` consults
 * one place to decide what fields a row in a given status can mutate.
 * See `getEditableFieldsForStatus` below.
 *
 * @module lib/tenders/state-machine
 */
import type { TenderStatus, TenderApplicationStatus } from "@/lib/db/schema";

// ── Tender transition table ───────────────────────────────────────────────

/**
 * Map of `from → set of legal `to` values`. Reading
 * `LEGAL_TRANSITIONS[current].has(next)` is the single source of truth.
 *
 * Stored as `Record<TenderStatus, ReadonlySet<TenderStatus>>` so TypeScript
 * verifies every status has an entry (exhaustiveness) and we don't ship
 * a transition table missing a state.
 *
 * Day 5: `closed` gained `published` (reopen), `awarded` gained `closed`
 * (retract award). All other entries unchanged.
 */
const LEGAL_TRANSITIONS: Record<TenderStatus, ReadonlySet<TenderStatus>> = {
  draft: new Set<TenderStatus>(["published"]),
  published: new Set<TenderStatus>(["draft", "closed"]),
  closed: new Set<TenderStatus>(["awarded", "published"]),
  awarded: new Set<TenderStatus>(["closed"]),
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
  if (from === "awarded" && to !== "closed") {
    // Day 5: awarded → closed IS legal now (retractAward). Other
    // forward-from-awarded transitions remain illegal — force the
    // through-closed checkpoint so every state visit is auditable.
    return "Awarded tenders can only be reverted one step (to closed); further changes go through closed first";
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
 *   - `awarded`   — only `internalNotes` editable. Once-terminal-now-
 *                   reversible state; the notes channel stays open for
 *                   retrospective context (debriefs, lessons-learned).
 *
 * Day 5: editability rules are unchanged. A tender that's been
 * `closed → published` reopened goes back to the `published` field set
 * naturally because the rule is keyed on current status, not history.
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

// ── Application transition table (Day 5) ──────────────────────────────────

/**
 * Application status transitions, structured the same way as the tender
 * transitions above. Centralising here means `updateApplicationStatus`,
 * `withdrawApplication`, `reinstateApplication`, and `recallApplication`
 * all consult the same source of truth.
 *
 * Forward path:
 *     submitted ──▶ shortlisted (staff)
 *     submitted ──▶ rejected    (staff)
 *     submitted ──▶ withdrawn   (company on own)
 *
 * Reversals (Day 5):
 *     shortlisted ──▶ submitted (admin/staff; clears decidedAt)
 *     rejected    ──▶ submitted (admin/staff; clears decidedAt)
 *     withdrawn   ──▶ submitted (company on own; within recall window)
 *
 * Terminal forms: there are none. Even withdrawn is reversible inside
 * the recall window, and shortlisted / rejected can be reinstated any
 * time before delete.
 */
const LEGAL_APPLICATION_TRANSITIONS: Record<
  TenderApplicationStatus,
  ReadonlySet<TenderApplicationStatus>
> = {
  submitted: new Set<TenderApplicationStatus>([
    "shortlisted",
    "rejected",
    "withdrawn",
  ]),
  shortlisted: new Set<TenderApplicationStatus>(["submitted"]),
  rejected: new Set<TenderApplicationStatus>(["submitted"]),
  withdrawn: new Set<TenderApplicationStatus>(["submitted"]),
};

/**
 * Is the application transition `from → to` legal?
 *
 * Same semantics as `isLegalTransition` for tenders — `from === to` is
 * NOT legal here; callers short-circuit on no-op transitions before
 * consulting this function.
 */
export function isLegalApplicationTransition(
  from: TenderApplicationStatus,
  to: TenderApplicationStatus,
): boolean {
  return LEGAL_APPLICATION_TRANSITIONS[from].has(to);
}

/**
 * Human-friendly error string for an illegal application transition.
 * Mirrors `illegalTransitionMessage` for the tender side.
 */
export function illegalApplicationTransitionMessage(
  from: TenderApplicationStatus,
  to: TenderApplicationStatus,
): string {
  if (from === to) {
    return `Application is already ${from}`;
  }
  // Common cases get hand-tuned copy; everything else falls through to
  // the generic message.
  if (from === "withdrawn" && to !== "submitted") {
    return "Withdrawn applications can only be recalled (submitted again), not moved directly to another status";
  }
  if ((from === "shortlisted" || from === "rejected") && to === "withdrawn") {
    return "Staff cannot withdraw an application on a company's behalf";
  }
  return `Cannot transition application from ${from} to ${to}`;
}

// ── Recall window (Day 5) ─────────────────────────────────────────────────

/**
 * Number of days a company has, after withdrawing their own application,
 * to recall it back to submitted. After this window the withdrawal is
 * effectively permanent (the row remains for audit; the UI hides the
 * recall affordance).
 *
 * 7 days matches a typical business week — long enough for a Monday-
 * morning regret to be actioned, short enough that stale withdrawals
 * don't reappear weeks later and surprise staff.
 *
 * Hard-coded on purpose. If we later need per-tender configurability
 * (some procurements run on tighter cycles), lifting this to a column
 * on `tenders` is a small change — the call site becomes
 * `isWithinRecallWindow(decidedAt, tender.recallWindowDays ?? RECALL_WINDOW_DAYS)`.
 */
export const RECALL_WINDOW_DAYS = 7;

/**
 * Returns `true` when the elapsed time since `decidedAt` is within the
 * recall window.
 *
 * Accepts both ISO formats currently in the DB:
 *   - SQLite `datetime('now')` style:  "2026-05-16 22:14:33"
 *   - JS `toISOString()` style:        "2026-05-16T22:14:33.000Z"
 * (See Day-3 tech debt note about timestamp format inconsistency.)
 *
 * Returns `false` when `decidedAt` is null/empty — a record with no
 * decision time can't be inside any window. Also returns `false` if the
 * timestamp parses to NaN (malformed), failing closed.
 *
 * @example
 *   if (!isWithinRecallWindow(application.decidedAt)) {
 *     return { ok: false, error: "Recall window has passed" };
 *   }
 */
export function isWithinRecallWindow(decidedAt: string | null): boolean {
  if (!decidedAt) return false;

  // Normalise to a parseable ISO string. SQLite's space-separated form
  // is rejected by some date parsers; swap the space for T.
  const normalised = decidedAt.includes("T")
    ? decidedAt
    : decidedAt.replace(" ", "T") + "Z"; // assume UTC for the space form

  const decidedMs = Date.parse(normalised);
  if (Number.isNaN(decidedMs)) {
    // Defensive: malformed timestamps fail closed. The caller will
    // surface a friendly error; the audit log captures the bad value.
    return false;
  }

  const elapsedMs = Date.now() - decidedMs;
  const windowMs = RECALL_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return elapsedMs >= 0 && elapsedMs <= windowMs;
}

/**
 * Number of whole days elapsed since `decidedAt`, used by the UI to
 * show "Withdrawn 3 days ago — can recall for 4 more days" and by the
 * audit metadata on `application_recalled` events.
 *
 * Returns `null` for null / malformed input. Negative values (future
 * timestamps) are clamped to 0 — they shouldn't happen but if they do
 * we'd rather not surface "withdrawn -1 days ago" in the UI.
 */
export function daysSince(decidedAt: string | null): number | null {
  if (!decidedAt) return null;
  const normalised = decidedAt.includes("T")
    ? decidedAt
    : decidedAt.replace(" ", "T") + "Z";
  const ms = Date.parse(normalised);
  if (Number.isNaN(ms)) return null;
  const elapsedDays = Math.floor((Date.now() - ms) / (1000 * 60 * 60 * 24));
  return Math.max(0, elapsedDays);
}
