/**
 * Documents module — runtime constants.
 *
 * Plain TS module (no `"use server"`, no DB imports). Importable from
 * Server Actions, Server Components, and Client Components alike.
 *
 * @module lib/documents/constants
 */

// ── Review-revert window ────────────────────────────────────────────────────

/**
 * How long after a verify/reject a reviewer can still "undo" the
 * outcome and bounce the row back to `pending_review`.
 *
 * 15 minutes mirrors iMessage's edit window — long enough to cover the
 * "I clicked wrong" and "wait, let me re-check" cases, short enough
 * that the audit trail stays meaningful (a stale undo days later
 * would mean a reviewer is silently rewriting history).
 *
 * Enforced in two places:
 *   - Server: `revertDocumentReview` action checks this against the
 *     row's `reviewedAt` and refuses outside the window. Authoritative.
 *   - Client: `DocumentRowActions` hides the inline Undo button once
 *     the window expires (setTimeout). Cosmetic — server check is the
 *     real gate.
 *
 * Tuning: increase if reviewers consistently want a longer window in
 * practice. Decrease if "wait, who reverted this?" investigations
 * surface stale undos as a class of confusion.
 */
export const REVIEW_REVERT_WINDOW_MINUTES = 15;

/** Window in milliseconds. */
const WINDOW_MS = REVIEW_REVERT_WINDOW_MINUTES * 60 * 1000;

/**
 * Result of an eligibility check. `msRemaining` is always >= 0 — when
 * outside the window it equals 0, never negative.
 */
export interface ReviewRevertEligibility {
  withinWindow: boolean;
  msRemaining: number;
}

/**
 * Compute whether a document with the given `reviewedAt` is still
 * within the revert window.
 *
 * Pure function, no I/O. Both server and client use this — server
 * for the authoritative gate, client for the inline button's
 * setTimeout auto-hide.
 *
 * @param reviewedAt ISO-8601 timestamp from the `documents.reviewed_at`
 *   column. `null` (row never reviewed) returns `withinWindow: false`.
 *   Unparseable strings also return `false` — defensive, but the
 *   schema's type-validation should catch those before they reach
 *   here.
 */
export function reviewRevertEligibility(
  reviewedAt: string | null,
): ReviewRevertEligibility {
  if (!reviewedAt) return { withinWindow: false, msRemaining: 0 };

  const reviewedMs = Date.parse(reviewedAt);
  if (Number.isNaN(reviewedMs)) {
    return { withinWindow: false, msRemaining: 0 };
  }

  const remaining = reviewedMs + WINDOW_MS - Date.now();
  return {
    withinWindow: remaining > 0,
    msRemaining: Math.max(0, remaining),
  };
}
