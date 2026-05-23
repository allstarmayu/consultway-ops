/**
 * Project lifecycle state machine.
 *
 * Centralises the legal transitions between `ProjectStatus` values so
 * `transitionProjectStatus` (and any future status-changing actions)
 * share one source of truth. Same pattern as
 * `lib/tenders/state-machine.ts`.
 *
 * Legal transitions:
 *
 *     planning  ──────▶ active        (kick-off)
 *     planning  ──────▶ cancelled     (decline before starting)
 *     active    ──────▶ on_hold       (temporary pause)
 *     active    ──────▶ completed     (successful close)
 *     active    ──────▶ cancelled     (terminate mid-flight)
 *     on_hold   ──────▶ active        (resume)
 *     on_hold   ──────▶ cancelled     (give up after a pause)
 *
 * Terminal states:
 *     completed — no further transitions
 *     cancelled — no further transitions
 *
 * Notable rejections:
 *   - `planning → on_hold`: there's nothing in motion to pause. If a
 *     project isn't ready to start, it can just stay in planning;
 *     `on_hold` is reserved for paused execution.
 *   - `planning → completed`: a project that hasn't actively run
 *     cannot be "completed". Must go through `active` first.
 *   - `completed → anything`: terminal. If a completed project needs
 *     post-mortem edits, those go via `updateProject` on the
 *     `description` / `internalNotes` fields, not via a state flip.
 *   - `cancelled → anything`: terminal. A re-engagement is a new
 *     project, not a reanimation.
 *
 * @module lib/projects/state-machine
 */
import type { ProjectStatus } from "@/lib/db/schema";

// ── Transition table ──────────────────────────────────────────────────────

/**
 * Map of `from → set of legal `to` values`. Same shape as the tender
 * state machine. TypeScript verifies every status has an entry.
 */
const LEGAL_TRANSITIONS: Record<ProjectStatus, ReadonlySet<ProjectStatus>> = {
  planning: new Set<ProjectStatus>(["active", "cancelled"]),
  active: new Set<ProjectStatus>(["on_hold", "completed", "cancelled"]),
  on_hold: new Set<ProjectStatus>(["active", "cancelled"]),
  // Terminal states.
  completed: new Set<ProjectStatus>(),
  cancelled: new Set<ProjectStatus>(),
};

/**
 * Is the transition `from → to` legal?
 *
 * Returns `true` only for explicit transitions in the table. A no-op
 * transition where `from === to` is NOT legal here — callers should
 * short-circuit before consulting this function.
 */
export function isLegalProjectTransition(
  from: ProjectStatus,
  to: ProjectStatus,
): boolean {
  return LEGAL_TRANSITIONS[from].has(to);
}

/**
 * Human-friendly error string for an illegal transition. Used directly
 * as the `error` field in `ActionResult` returns so the UI can surface
 * a useful message instead of a generic refusal.
 */
export function illegalProjectTransitionMessage(
  from: ProjectStatus,
  to: ProjectStatus,
): string {
  if (from === to) {
    return `Project is already ${humanLabel(from)}`;
  }
  if (from === "completed" || from === "cancelled") {
    return `Cannot move from ${humanLabel(from)} — that's a final state`;
  }
  if (from === "planning" && to === "completed") {
    return "A planning project must move to active before it can be completed";
  }
  if (from === "planning" && to === "on_hold") {
    return "Planning projects don't move to on hold — keep them in planning until ready to start";
  }
  return `Cannot move from ${humanLabel(from)} to ${humanLabel(to)}`;
}

/**
 * Set of statuses the project can move to from its current status.
 * Useful for the detail-page action UI — only render buttons for
 * legal next states.
 */
export function legalNextStatuses(
  from: ProjectStatus,
): ReadonlyArray<ProjectStatus> {
  return Array.from(LEGAL_TRANSITIONS[from]);
}

/**
 * Whether the status has any legal forward move. False only for the
 * two terminal states. Used by the UI to decide whether to render the
 * status-action panel at all on a project detail page.
 */
export function hasAnyLegalTransition(status: ProjectStatus): boolean {
  return LEGAL_TRANSITIONS[status].size > 0;
}

// ── Display helpers ──────────────────────────────────────────────────────

/**
 * Human-readable label for the underscored `on_hold` status — used in
 * error messages so they read as "Cannot move from on hold to ..."
 * rather than "Cannot move from on_hold to ...".
 */
function humanLabel(status: ProjectStatus): string {
  return status === "on_hold" ? "on hold" : status;
}
