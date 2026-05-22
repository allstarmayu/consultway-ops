/**
 * Single row in an activity feed.
 *
 * Renders one audit event as: coloured icon disc on the left, sentence
 * + relative timestamp on the right. Pure presentation - resolved
 * target names and actor display strings come in as props. Doing the
 * resolution upstream (in the Server Component that fetches events)
 * means this row component stays a leaf with no database dependencies
 * and is easy to reason about.
 *
 * Sentence shape:
 *   "{actorLabel} {verb} {targetLabel}{optional metadata fragment}"
 *
 * Example:
 *   "admin@consultway.local  published tender  Acme Hospital Wiring"
 *   |    actor (bold)        | verb (muted)  | target (bold link)
 *
 * Dangling targets: when the upstream resolver can't find a name for a
 * target id (the target was hard-deleted; the row's a forensic
 * artefact), `targetLabel` arrives as `null` and we render the literal
 * "Deleted item" as muted text - same shape, less prominence, so the
 * row still reads cleanly.
 *
 * Unknown action verbs: the `audit_log.action` column is plain TEXT in
 * D1, with the narrow `AuditAction` union only enforced app-side at
 * write time. If a row somehow lands in the DB with an action value
 * that isn't in the current union (older code that's been retired, or
 * a future verb whose label hasn't been wired up yet), the row still
 * renders with a defensive neutral fallback rather than crashing the
 * whole feed. Defence in depth: the writer validates, the reader
 * tolerates.
 *
 * Server-Component-compatible: no hooks, no event handlers. Could be
 * a Client Component if a future iteration adds row-level interactivity
 * (e.g. expand-to-see-diff), but that's not Day 7.
 *
 * @module components/audit/activity-feed-row
 */
import Link from "next/link";
import { HelpCircle } from "lucide-react";

import type { AuditLogEntry } from "@/lib/db/schema";
import type { AuditAction } from "@/lib/audit/log";
import {
  getAuditLabel,
  type AuditLabel,
  type AuditTone,
} from "@/lib/audit/labels";
import { formatRelativeTime } from "@/lib/utils/format-relative-time";
import { cn } from "@/lib/utils";

// ── Props ───────────────────────────────────────────────────────────────────

export interface ActivityFeedRowProps {
  /**
   * The raw audit row from `listAuditEvents`. Action, target, and
   * timestamp come straight off this; the row component does not
   * reach back into the DB.
   */
  event: AuditLogEntry;

  /**
   * Human label for the actor. Typically an email address from the
   * upstream actor-resolution step. Pass the actor id as a fallback if
   * the email cannot be resolved (and let the truncate handle it).
   */
  actorLabel: string;

  /**
   * Human label for the target entity (e.g. "Acme Construction Pvt
   * Ltd"). `null` when the upstream resolver couldn't find a record
   * for the target id - typically because the target was hard-deleted.
   * The renderer falls back to "Deleted item" in that case.
   */
  targetLabel: string | null;

  /**
   * Optional href for the target. When provided, the target label
   * renders as a link to the entity's detail page. Skipped (rendered
   * as plain text) when null - useful for dangling targets and for
   * target types we don't have detail pages for yet (e.g. users).
   */
  targetHref?: string | null;
}

// ── Tone -> Tailwind class mapping ──────────────────────────────────────────

/**
 * Mapping from semantic tone to concrete Tailwind classes for the icon
 * disc. Lives in this component (not in `lib/audit/labels.ts`) to keep
 * the labels module presentation-free.
 *
 * All four use the same disc geometry; only the colours differ. The
 * neutral tone uses muted bg + foreground for the dialled-down "this
 * is an ordinary update" look. Destructive and reversal both pull from
 * the theme tokens (destructive = red, accent = Terracotta from the
 * warm-ambient palette).
 */
const TONE_CLASSES: Record<AuditTone, string> = {
  create: "bg-primary/10 text-primary",
  neutral: "bg-muted text-muted-foreground",
  destructive: "bg-destructive/10 text-destructive",
  // Terracotta accent from the warm-ambient palette - distinct enough
  // from primary that reversals stand out in a mixed feed but not so
  // alarming that they read as errors.
  reversal: "bg-accent/15 text-accent",
};

// ── Type narrowing ──────────────────────────────────────────────────────────

/**
 * The set of all known audit verbs, derived from the `AuditAction`
 * union. We compare against this set at runtime to narrow the DB's
 * untyped `string` action field into the union, with a defensive
 * fallback for the legitimately-rare case of a stale verb in the DB.
 *
 * Kept in lockstep with the `LABELS` record in `lib/audit/labels.ts`.
 * If you add a verb there, add it here too. (A future refactor could
 * derive both from a single source - a `readonly tuple` exported from
 * the labels module - but the current redundancy is small and obvious.)
 */
const KNOWN_ACTIONS = new Set<AuditAction>([
  "created",
  "updated",
  "deleted",
  "compliance_status_changed",
  "document_uploaded",
  "document_expired",
  "tender_published",
  "tender_applied",
  "tender_reopened",
  "tender_award_retracted",
  "application_reinstated",
  "application_recalled",
]);

/**
 * Fallback label used when a row's `action` value isn't in the known
 * union. Renders the raw verb string with a neutral tone and a
 * help-circle icon, so the row remains readable instead of erroring.
 */
function unknownActionLabel(raw: string): AuditLabel {
  return {
    verb: raw,
    icon: HelpCircle,
    tone: "neutral",
  };
}

/**
 * Resolve the row's label, narrowing the DB's `string` action to the
 * `AuditAction` union or returning a defensive fallback.
 */
function resolveLabel(rawAction: string): AuditLabel {
  if (KNOWN_ACTIONS.has(rawAction as AuditAction)) {
    return getAuditLabel(rawAction as AuditAction);
  }
  return unknownActionLabel(rawAction);
}

// ── Component ───────────────────────────────────────────────────────────────

export function ActivityFeedRow({
  event,
  actorLabel,
  targetLabel,
  targetHref,
}: ActivityFeedRowProps) {
  const label = resolveLabel(event.action);
  const Icon = label.icon;
  const toneClass = TONE_CLASSES[label.tone];

  // Resolve the target display string. Dangling targets (deleted
  // entities) render as muted "Deleted item" - same shape, less
  // prominence, keeps the row readable.
  const displayTarget = targetLabel ?? "Deleted item";
  const targetIsLink = Boolean(targetHref) && targetLabel !== null;

  // Reason metadata is captured for reversal verbs (Day 5's reason
  // capture on ConfirmDialog). Surface it as a subtle italic suffix
  // when present so the feed conveys "and here's why" without
  // requiring a click into the entity's history.
  const reason =
    event.metadata && typeof event.metadata === "object"
      ? (event.metadata as Record<string, unknown>).reason
      : undefined;
  const reasonText =
    typeof reason === "string" && reason.length > 0 ? reason : null;

  return (
    <li className="flex items-start gap-3 py-3">
      {/* Icon disc. Fixed-size so the sentence column aligns regardless
          of icon glyph. aria-hidden because the tone+verb in the sentence
          already convey the meaning to screen readers. */}
      <div
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
          toneClass,
        )}
        aria-hidden
      >
        <Icon className="h-4 w-4" />
      </div>

      {/* Sentence + timestamp column. min-w-0 lets the long target label
          truncate cleanly inside flexbox. */}
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-relaxed text-foreground">
          <span
            className="font-medium text-foreground"
            title={actorLabel}
          >
            {actorLabel}
          </span>{" "}
          <span className="text-muted-foreground">{label.verb}</span>{" "}
          {targetIsLink && targetHref ? (
            <Link
              href={targetHref}
              className="font-medium text-foreground underline-offset-2 hover:underline"
            >
              {displayTarget}
            </Link>
          ) : (
            <span
              className={cn(
                "font-medium",
                targetLabel === null
                  ? "italic text-muted-foreground"
                  : "text-foreground",
              )}
            >
              {displayTarget}
            </span>
          )}
        </p>

        {/* Optional reason suffix - reversal verbs typically have one. */}
        {reasonText && (
          <p className="mt-0.5 text-xs italic text-muted-foreground">
            &ldquo;{reasonText}&rdquo;
          </p>
        )}

        {/* Timestamp row. Always relative on the feed; the full ISO
            string lives in the `title` attribute for hover-reveal. */}
        <p
          className="mt-0.5 text-xs text-muted-foreground"
          title={event.createdAt}
        >
          {formatRelativeTime(event.createdAt)}
        </p>
      </div>
    </li>
  );
}
