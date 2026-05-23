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
 *   the wrapper lets us also share the inline error display surface
 *   and keep the row's right-side action cluster visually coherent.
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
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  verifyDocument,
  rejectDocument,
  deleteDocument,
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
  const [error, setError] = React.useState<string | null>(null);

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

  function runAction(
    action: () => Promise<
      { ok: true } | { ok: false; error: string; field?: string }
    >,
  ) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Success - refresh the route so the documents-section re-fetches
      // and the row updates.
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
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
                runAction(() =>
                  verifyDocument({
                    documentId: document.id,
                    notes,
                  }),
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
                runAction(() =>
                  rejectDocument({
                    documentId: document.id,
                    // reasonField="required" guarantees a non-empty string
                    reason: reason!,
                  }),
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
              runAction(() =>
                deleteDocument({
                  documentId: document.id,
                }),
              )
            }
          />
        )}
      </div>

      {/* Inline error surface - same pattern as document-download-button.
          A toast library would be a step up; deferred to Day-11 polish. */}
      {error && (
        <p
          className="max-w-[240px] text-right text-xs text-destructive"
          role="alert"
          aria-live="polite"
        >
          {error}
        </p>
      )}
    </div>
  );
}
