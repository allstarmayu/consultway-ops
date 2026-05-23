/**
 * Per-row staff/admin/company affordances for a document: Verify,
 * Reject, Delete.
 *
 * Client Component. Owns three `confirm-dialog` instances (one per
 * action) plus a `useTransition` for the pending state. Calls
 * `router.refresh()` on success so the documents-section re-fetches
 * and the row's status badge updates.
 *
 * Visibility rules (mirror docs/08-rbac-matrix.md + the Server-side
 * gates in `lib/documents/actions.ts`):
 *
 *   Verify / Reject icons
 *     - Shown only on rows with `status === "pending_review"`
 *     - Visible only to admin/staff
 *
 *   Delete icon
 *     - admin: always visible (any status)
 *     - staff: never visible (admin-only delete per RBAC matrix)
 *     - company: visible on own rows with status `pending` or `rejected`
 *
 * Why one component for all three:
 *   Each action would otherwise need its own client-component file
 *   with the same useTransition + router.refresh boilerplate. Sharing
 *   the wrapper lets us also share one toast surface and keep the
 *   row's right-side action cluster visually coherent.
 *
 * Why router.refresh and not optimistic update:
 *   The status badge, the row's expiry affordance, the section's count,
 *   and the audit-log feed below all need to refresh. A targeted
 *   optimistic update would have to fan out across all four; a
 *   router.refresh() is one line and arguably faster to write than the
 *   optimistic path is to ship correctly.
 *
 * @module components/documents/document-row-actions
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, XCircle, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  verifyDocument,
  rejectDocument,
  deleteDocument,
  revertDocumentReview,
} from "@/lib/documents/actions";
import type { Document, UserRole } from "@/lib/db/schema";

// ── Props ──────────────────────────────────────────────────────────────────

export interface DocumentRowActionsProps {
  /** Row this action cluster belongs to. */
  document: Pick<Document, "id" | "status" | "fileName" | "documentType">;

  /**
   * Session role for visibility gating. The page resolves this once
   * and threads it down rather than each row re-reading the session.
   */
  viewerRole: UserRole;
}

// ── Component ──────────────────────────────────────────────────────────────

export function DocumentRowActions({
  document,
  viewerRole,
}: DocumentRowActionsProps) {
  const router = useRouter();
  const [isPending, startTransition] = React.useTransition();

  // ── Visibility booleans. Each affordance computed from role + status,
  //    matching the server-side gates exactly so a UI-shown button
  //    never produces a server-side refusal.
  const isReviewer = viewerRole === "admin" || viewerRole === "staff";
  const canVerifyOrReject =
    isReviewer && document.status === "pending_review";
  const canDelete =
    viewerRole === "admin" ||
    (viewerRole === "company" &&
      (document.status === "pending" || document.status === "rejected"));

  // Nothing to show? Render nothing - keeps the row's right-side
  // cluster from leaving an empty gap.
  if (!canVerifyOrReject && !canDelete) {
    return null;
  }

  /**
   * Fire `revertDocumentReview` and report. Used by the "Undo" toast
   * action on verify/reject. Server-side status guard catches a stale
   * undo (e.g. if a re-review happened between the toast appearing
   * and the undo click) and surfaces a clean error toast.
   */
  function handleUndo() {
    startTransition(async () => {
      const result = await revertDocumentReview({
        documentId: document.id,
      });
      if (!result.ok) {
        toast.error("Could not undo", { description: result.error });
        return;
      }
      toast.success(`Review reverted for ${document.fileName}`);
      router.refresh();
    });
  }

  /**
   * Run a server action, toast on the outcome, and refresh on success.
   * `successMessage` is required so every action gets confirmation
   * feedback; `errorTitle` headlines the toast.error description.
   * `undoable` (verify/reject) adds an Undo action button to the
   * success toast and extends its duration so the affordance is
   * genuinely visible.
   */
  function runAction(
    action: () => Promise<
      { ok: true } | { ok: false; error: string; field?: string }
    >,
    successMessage: string,
    errorTitle: string,
    options?: { undoable?: boolean },
  ) {
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        toast.error(errorTitle, { description: result.error });
        return;
      }
      if (options?.undoable) {
        // Extended duration (8s vs the 4s default) so the Undo
        // affordance has a realistic discovery window. The
        // server-side status guard prevents stale undos racing
        // against a re-review.
        toast.success(successMessage, {
          duration: 8000,
          action: {
            label: "Undo",
            onClick: handleUndo,
          },
        });
      } else {
        toast.success(successMessage);
      }
      // Refresh the route so the documents-section re-fetches and the
      // row updates (status badge, action visibility, section count).
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-1">
      {canVerifyOrReject && (
        <>
          {/* Verify - optional notes textarea */}
          <ConfirmDialog
            trigger={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={isPending}
                aria-label={`Verify ${document.fileName}`}
                className="text-primary hover:bg-primary/10 hover:text-primary"
              >
                <CheckCircle2 className="h-4 w-4" aria-hidden />
              </Button>
            }
            title="Verify this document?"
            description={
              <>
                Marking <strong>{document.fileName}</strong> as verified
                signals it has been reviewed and is accepted. The
                uploader will see the new status the next time they
                view their company.
              </>
            }
            confirmLabel="Verify"
            confirmVariant="default"
            reasonField="optional"
            reasonLabel="Reviewer notes"
            reasonPlaceholder="e.g. Issued by GST Maharashtra, scan is clear"
            pending={isPending}
            onConfirm={(notes) =>
              runAction(
                () =>
                  verifyDocument({
                    documentId: document.id,
                    notes,
                  }),
                `Verified ${document.fileName}`,
                "Could not verify document",
                { undoable: true },
              )
            }
          />

          {/* Reject - required reason */}
          <ConfirmDialog
            trigger={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={isPending}
                aria-label={`Reject ${document.fileName}`}
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                <XCircle className="h-4 w-4" aria-hidden />
              </Button>
            }
            title="Reject this document?"
            description={
              <>
                Tell the uploader what to fix on{" "}
                <strong>{document.fileName}</strong>. The reason is
                captured in the audit log and surfaced on the document
                row so the uploader can re-upload a corrected version.
              </>
            }
            confirmLabel="Reject"
            confirmVariant="destructive"
            reasonField="required"
            reasonLabel="Reason for rejection"
            reasonPlaceholder="e.g. Scan is illegible - please re-upload at higher DPI"
            pending={isPending}
            onConfirm={(reason) =>
              runAction(
                () =>
                  rejectDocument({
                    documentId: document.id,
                    // reasonField="required" guarantees a non-empty string
                    reason: reason!,
                  }),
                `Rejected ${document.fileName}`,
                "Could not reject document",
                { undoable: true },
              )
            }
          />
        </>
      )}

      {canDelete && (
        <ConfirmDialog
          trigger={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={isPending}
              aria-label={`Delete ${document.fileName}`}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </Button>
          }
          title="Delete this document?"
          description={
            <>
              This permanently removes <strong>{document.fileName}</strong>{" "}
              from the system, including the file in R2. This action
              cannot be undone.
            </>
          }
          confirmLabel="Delete"
          confirmVariant="destructive"
          pending={isPending}
          onConfirm={() =>
            runAction(
              () =>
                deleteDocument({
                  documentId: document.id,
                }),
              `Deleted ${document.fileName}`,
              "Could not delete document",
            )
          }
        />
      )}
    </div>
  );
}
