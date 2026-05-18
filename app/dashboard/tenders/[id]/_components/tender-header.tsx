/**
 * Tender detail header — title, status badge, and the role-gated set
 * of action buttons (status transitions, edit, delete, reversals).
 *
 * Client Component because each action button calls a Server Action via
 * `useTransition` and shows pending UI. Errors surface in an inline
 * `<Alert>` at the top of the header strip.
 *
 * Visible buttons are computed from `state-machine.isLegalTransition`
 * rather than hard-coded — single source of truth, can't drift from the
 * server-side gate.
 *
 * Button visibility rules (admin/staff):
 *   - draft     → Publish, Edit, Delete (admin only)
 *   - published → Unpublish (only when 0 applications — server enforces;
 *                 we show the button regardless and surface the error),
 *                 Close, Edit
 *   - closed    → Mark awarded, Reopen (admin only), Edit (only
 *                 internalNotes effectively)
 *   - awarded   → Retract award (admin only), Edit (only internalNotes)
 *
 * `markAwarded`, `reopenTender`, and `retractAward` are wrapped in
 * `<ConfirmDialog>` because each one transitions state in a way that
 * matters operationally:
 *   - Mark awarded → significant procurement decision
 *   - Reopen       → companies who saw the tender as "closed" will be
 *                    confused if it flips back to published
 *   - Retract award → reverses a contractual-weight decision; required
 *                    reason captured in audit log
 *
 * The other transitions (publish, unpublish, close) are one-click —
 * recoverable through their own reversal paths.
 *
 * Reopen / retract are **admin-only** (not staff). Staff who needs a
 * reversal escalates to an admin. Mirrors the deleteTender gate.
 *
 * @module app/dashboard/tenders/[id]/_components/tender-header
 */
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  AlertCircle,
  CheckCircle2,
  Lock,
  Pencil,
  RotateCcw,
  Trash2,
  Trophy,
  Undo2,
  XCircle,
} from "lucide-react";
import {
  publishTender,
  unpublishTender,
  closeTender,
  markAwarded,
  reopenTender,
  retractAward,
} from "@/lib/tenders/actions";
import type { Tender } from "@/lib/db/schema";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TenderStatusBadge } from "../../_components/badges";

// ── Props ─────────────────────────────────────────────────────────────────

export interface TenderHeaderProps {
  tender: Tender;
  /** True when the viewer is admin or staff. Drives transition-button visibility. */
  canManage: boolean;
  /**
   * True when the viewer is admin. Drives the Delete button and the
   * two reversal buttons (Reopen, Retract award) — all admin-only.
   * Renamed responsibility-wise as of Day 5, but kept the prop name to
   * avoid a ripple-edit through the parent page.
   */
  canDelete: boolean;
  /** True when the tender has at least one application — affects Unpublish copy. */
  hasApplications: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────

export function TenderHeader({
  tender,
  canManage,
  canDelete,
  hasApplications,
}: TenderHeaderProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  /**
   * Wrap a Server-Action call in a transition + error surface.
   * Callbacks render the same way regardless of which transition.
   */
  function runTransition(
    label: string,
    fn: () => Promise<{ ok: boolean; error?: string }>,
  ): void {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error ?? `Could not ${label.toLowerCase()}`);
        return;
      }
      // Refresh so the Server Component above re-renders with the new
      // status (badge, edit-form gating, applications visibility).
      router.refresh();
    });
  }

  function handlePublish() {
    runTransition("publish", () => publishTender(tender.id));
  }

  function handleUnpublish() {
    runTransition("unpublish", () => unpublishTender(tender.id));
  }

  function handleClose() {
    runTransition("close", () => closeTender(tender.id));
  }

  function handleAward() {
    // No window.confirm — the ConfirmDialog wrapping the Mark-awarded
    // button below gates this call. By the time we reach this handler,
    // the user has already confirmed.
    runTransition("mark awarded", () => markAwarded(tender.id));
  }

  /**
   * Reopen handler — receives an optional `reason` from the
   * ConfirmDialog (since reasonField="optional"). Passes through to the
   * Server Action which records it in the audit metadata.
   */
  function handleReopen(reason?: string) {
    runTransition("reopen", () =>
      reopenTender({
        tenderId: tender.id,
        // Schema accepts `reason` as optional — pass-through when
        // present, omit the key entirely when not (cleaner audit
        // metadata than `reason: undefined`).
        ...(reason ? { reason } : {}),
      }),
    );
  }

  /**
   * Retract-award handler — receives a `reason` from the ConfirmDialog.
   * ConfirmDialog enforces the 5-char minimum client-side, so by the
   * time this handler fires, `reason` is guaranteed to be a non-empty
   * trimmed string. The Server Action's schema double-checks; the `!`
   * here reflects the dialog contract.
   */
  function handleRetractAward(reason?: string) {
    runTransition("retract award", () =>
      retractAward({
        tenderId: tender.id,
        // ConfirmDialog with reasonField="required" always provides
        // reason; the assertion is defensive.
        reason: reason!,
      }),
    );
  }

  // ── Computed flags ──────────────────────────────────────────────────
  const canPublish = canManage && tender.status === "draft";
  const canUnpublish = canManage && tender.status === "published";
  const canClose = canManage && tender.status === "published";
  const canAward = canManage && tender.status === "closed";
  // Edit visible whenever any field is editable. State machine says
  // closed and awarded still allow internalNotes editing.
  const canEdit = canManage;
  // Delete visible only on drafts (action also enforces).
  const canShowDelete = canDelete && tender.status === "draft";
  // ── Day 5: reversal buttons ─────────────────────────────────────────
  // Both admin-only. The `canDelete` prop already gates on admin role,
  // so we reuse it as the admin signal here.
  const canReopen = canDelete && tender.status === "closed";
  const canRetractAward = canDelete && tender.status === "awarded";

  return (
    <>
      <header className="mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-start sm:justify-between">
        {/* Left — title + reference + status badge */}
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            {tender.title}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <TenderStatusBadge status={tender.status} />
            {tender.referenceNumber && (
              <span className="font-mono text-xs text-muted-foreground">
                {tender.referenceNumber}
              </span>
            )}
          </div>
        </div>

        {/* Right — action buttons. Wrap on narrow viewports. */}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {canPublish && (
            <Button
              onClick={handlePublish}
              disabled={isPending}
              aria-label="Publish tender"
            >
              <CheckCircle2 className="h-4 w-4" aria-hidden />
              Publish
            </Button>
          )}

          {canUnpublish && (
            <Button
              variant="outline"
              onClick={handleUnpublish}
              disabled={isPending}
              aria-label={
                hasApplications
                  ? "Unpublish — blocked while applications exist"
                  : "Unpublish tender"
              }
              // Visually mute the button when we know it'll fail, but
              // still let the click fire so the server-side error
              // reaches the user with a clear message.
              className={hasApplications ? "opacity-60" : undefined}
            >
              <Undo2 className="h-4 w-4" aria-hidden />
              Unpublish
            </Button>
          )}

          {canClose && (
            <Button
              variant="outline"
              onClick={handleClose}
              disabled={isPending}
              aria-label="Close tender"
            >
              <Lock className="h-4 w-4" aria-hidden />
              Close
            </Button>
          )}

          {canAward && (
            <ConfirmDialog
              trigger={
                <Button disabled={isPending} aria-label="Mark tender as awarded">
                  <Trophy className="h-4 w-4" aria-hidden />
                  Mark awarded
                </Button>
              }
              title={`Mark "${tender.title}" as awarded?`}
              description="This records the procurement decision. The tender can still be reverted to closed via Retract award if needed."
              confirmLabel="Mark awarded"
              confirmVariant="default"
              onConfirm={handleAward}
              pending={isPending}
            />
          )}

          {/* ── Day 5: Reopen (closed → published, admin only) ──────── */}
          {canReopen && (
            <ConfirmDialog
              trigger={
                <Button
                  variant="outline"
                  disabled={isPending}
                  aria-label="Reopen tender"
                >
                  <RotateCcw className="h-4 w-4" aria-hidden />
                  Reopen
                </Button>
              }
              title={`Reopen "${tender.title}"?`}
              description="This moves the tender back to published. Companies who saw it as closed may be surprised — consider notifying them. Any existing applications stay attached."
              confirmLabel="Reopen tender"
              confirmVariant="default"
              reasonField="optional"
              reasonLabel="Reason (optional)"
              reasonPlaceholder="e.g. Closed in error — extending the deadline by two weeks"
              onConfirm={handleReopen}
              pending={isPending}
            />
          )}

          {/* ── Day 5: Retract award (awarded → closed, admin only) ─── */}
          {canRetractAward && (
            <ConfirmDialog
              trigger={
                <Button
                  variant="outline"
                  disabled={isPending}
                  aria-label="Retract tender award"
                  className="border-destructive/40 text-destructive hover:bg-destructive/10"
                >
                  <XCircle className="h-4 w-4" aria-hidden />
                  Retract award
                </Button>
              }
              title={`Retract the award for "${tender.title}"?`}
              description="This moves the tender from awarded back to closed. The procurement decision is reversed and a reason is required for the audit log."
              confirmLabel="Retract award"
              confirmVariant="destructive"
              reasonField="required"
              reasonLabel="Reason (required)"
              reasonPlaceholder="e.g. Awarded company unable to fulfil contract — re-evaluating shortlist"
              onConfirm={handleRetractAward}
              pending={isPending}
            />
          )}

          {canEdit && (
            <Button
              asChild
              variant="outline"
              disabled={isPending}
              aria-label="Edit tender"
            >
              <Link href={`/dashboard/tenders/${tender.id}/edit`}>
                <Pencil className="h-4 w-4" aria-hidden />
                Edit
              </Link>
            </Button>
          )}

          {canShowDelete && (
            <Button
              asChild
              variant="outline"
              disabled={isPending}
              aria-label="Delete tender"
              className="border-destructive/40 text-destructive hover:bg-destructive/10"
            >
              <Link href={`/dashboard/tenders/${tender.id}/delete`}>
                <Trash2 className="h-4 w-4" aria-hidden />
                Delete
              </Link>
            </Button>
          )}
        </div>
      </header>

      {/* Inline error surface — full width, below the strip. */}
      {error && (
        <Alert variant="destructive" className="mb-6">
          <AlertCircle className="h-4 w-4" aria-hidden />
          <AlertTitle>Action failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </>
  );
}
