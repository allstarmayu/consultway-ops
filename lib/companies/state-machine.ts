/**
 * Compliance state machine.
 *
 * Centralises the legal transitions between `ComplianceStatus` values so
 * `updateCompany` (and any future status-changing action) shares one
 * source of truth. Same pattern as `lib/projects/state-machine.ts` and
 * `lib/tenders/state-machine.ts`.
 *
 * Day 22 widened the union from `pending | compliant | non_compliant |
 * expired` to add `suspended` and `rejected`. Day 23 (this module)
 * encodes the legal transitions across all six states.
 *
 * Legal transitions:
 *
 *     pending        ──────▶ compliant         (review passed at intake)
 *     pending        ──────▶ non_compliant     (review found issues at intake)
 *     pending        ──────▶ rejected          (intake-time rejection)
 *
 *     compliant      ──────▶ non_compliant     (something lapsed)
 *     compliant      ──────▶ expired           (a doc expiry tipped them over)
 *     compliant      ──────▶ suspended         (admin paused the relationship)
 *
 *     non_compliant  ──────▶ compliant         (issue cleared)
 *     non_compliant  ──────▶ suspended         (escalated to suspension)
 *
 *     expired        ──────▶ compliant         (re-uploaded, re-reviewed)
 *     expired        ──────▶ non_compliant     (deeper review needed)
 *     expired        ──────▶ suspended         (escalated)
 *
 *     suspended      ──────▶ compliant         (resumed — Day 22 spec)
 *     suspended      ──────▶ non_compliant     (resumed but with open issues)
 *
 * Terminal states:
 *     rejected — no further transitions. A re-engagement is a NEW company
 *                row, not a reanimation of the rejected one.
 *
 * Notable rejections:
 *   - `pending → expired`: expired is doc-driven, not intake. A pending
 *     company hasn't operated yet — there's nothing to expire.
 *   - `pending → suspended`: same rationale. You can only suspend an
 *     operating relationship.
 *   - `compliant → pending` / `expired → pending`: once you've been
 *     reviewed, you don't revert to "never reviewed". Pending is a
 *     one-time intake state.
 *   - `compliant → rejected`: rejection is intake-time only. To remove a
 *     once-compliant company, route through `non_compliant` or
 *     `suspended` first (those reflect the actual reason); admin then
 *     `deleteCompany` if the relationship is truly over.
 *   - `rejected → anything`: terminal. The state machine refuses every
 *     transition out of rejected.
 *
 * @module lib/companies/state-machine
 */
import type { ComplianceStatus } from "@/lib/db/schema";

// ── Transition table ──────────────────────────────────────────────────────

/**
 * Map of `from → set of legal `to` values`. Same shape as the projects
 * and tenders state machines. TypeScript verifies every status has an
 * entry — adding a new ComplianceStatus value would surface a compile
 * error here.
 */
export const COMPLIANCE_STATUS_TRANSITIONS: Record<
  ComplianceStatus,
  ReadonlySet<ComplianceStatus>
> = {
  pending: new Set<ComplianceStatus>(["compliant", "non_compliant", "rejected"]),
  compliant: new Set<ComplianceStatus>([
    "non_compliant",
    "expired",
    "suspended",
  ]),
  non_compliant: new Set<ComplianceStatus>(["compliant", "suspended"]),
  expired: new Set<ComplianceStatus>(["compliant", "non_compliant", "suspended"]),
  suspended: new Set<ComplianceStatus>(["compliant", "non_compliant"]),
  // Terminal.
  rejected: new Set<ComplianceStatus>(),
};

// ── Error type ───────────────────────────────────────────────────────────

/**
 * Thrown by `assertTransitionCompliance` when called with an illegal
 * `from → to` pair. The error message names both states so log lines
 * stay grep-friendly ("compliance transition refused: compliant →
 * rejected"). Callers (notably `updateCompany`) catch this and surface
 * the message as a typed `ActionResult` error, never letting it bubble.
 */
export class ComplianceTransitionError extends Error {
  readonly from: ComplianceStatus;
  readonly to: ComplianceStatus;

  constructor(from: ComplianceStatus, to: ComplianceStatus) {
    super(
      `Illegal compliance status transition: ${from} → ${to}`,
    );
    this.name = "ComplianceTransitionError";
    this.from = from;
    this.to = to;
  }
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Predicate for `from → to` legality.
 *
 * Returns `true` only for explicit transitions in the table. A no-op
 * transition where `from === to` is treated as legal (a callsite passing
 * the same status twice is idempotent — no DB write actually happens,
 * but the helper shouldn't reject it). Same convention as
 * `lib/projects/state-machine.ts`.
 */
export function canTransitionCompliance(
  from: ComplianceStatus,
  to: ComplianceStatus,
): boolean {
  if (from === to) return true;
  return COMPLIANCE_STATUS_TRANSITIONS[from].has(to);
}

/**
 * Throws `ComplianceTransitionError` if the `from → to` transition is
 * illegal. Used by `updateCompany` before staging the patch — the action
 * catches the error and returns a typed `ActionResult` failure so the
 * UI sees a field-scoped error instead of a 500.
 *
 * Same-state "transition" (from === to) is a no-op and does not throw.
 */
export function assertTransitionCompliance(
  from: ComplianceStatus,
  to: ComplianceStatus,
): void {
  if (canTransitionCompliance(from, to)) return;
  throw new ComplianceTransitionError(from, to);
}

/**
 * Set of statuses the company can move to from its current status.
 * Used by the per-status transition panel on the detail page to decide
 * which buttons to render — only legal next states get a button.
 *
 * Mirrors `legalNextStatuses` in `lib/projects/state-machine.ts`. The
 * returned array excludes the same-state no-op (callers don't render a
 * "stay in current state" button). Terminal `rejected` returns `[]`,
 * which the UI uses to suppress the panel entirely.
 */
export function legalNextStatuses(
  from: ComplianceStatus,
): ReadonlyArray<ComplianceStatus> {
  return Array.from(COMPLIANCE_STATUS_TRANSITIONS[from]);
}

/**
 * Whether the status has any legal forward move. False only for the
 * terminal `rejected` state. Used by the UI to decide whether to render
 * the transition panel at all.
 */
export function hasAnyLegalComplianceTransition(
  status: ComplianceStatus,
): boolean {
  return COMPLIANCE_STATUS_TRANSITIONS[status].size > 0;
}
