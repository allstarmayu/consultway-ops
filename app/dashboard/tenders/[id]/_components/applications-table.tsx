/**
 * Applications table — the per-tender applications list rendered below
 * the overview cards on the detail page.
 *
 * Renders:
 *   - One row per application, ordered oldest-first (the action returns
 *     them that way so the timeline reads chronologically)
 *   - Company name (linked to the company detail page)
 *   - Application status badge
 *   - Submitted / decided timestamps
 *   - Cover note preview (truncated; full text on hover via title attr)
 *   - Internal notes (staff only, smaller text)
 *   - Inline action icons (staff only):
 *       - on `submitted` rows         → Shortlist + Reject
 *       - on `shortlisted`/`rejected` → Reinstate (Day 5)
 *       - on `withdrawn`              → no actions; the company can
 *                                       recall via apply-button within
 *                                       the recall window
 *
 * Empty state when no applications yet. Client Component because the
 * status-change icons call Server Actions via `useTransition`.
 *
 * Text-selection: dashboard root disables user-select by default. We
 * RE-ENABLE selection on the cover note and internal notes columns
 * via the Tailwind `select-text` utility — copy-paste of an applicant's
 * cover note into an email or evaluation doc is a legit staff workflow.
 *
 * @module app/dashboard/tenders/[id]/_components/applications-table
 */
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  AlertCircle,
  Building,
  Inbox,
  RotateCcw,
  UserCheck,
  UserX,
} from "lucide-react";
import {
  reinstateApplication,
  updateApplicationStatus,
} from "@/lib/tenders/actions";
import type { TenderApplicationRow } from "@/lib/tenders/actions";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ApplicationStatusBadge } from "../../_components/badges";

// ── Props ─────────────────────────────────────────────────────────────────

export interface ApplicationsTableProps {
  rows: TenderApplicationRow[];
  /** True when the viewer can change application status (admin/staff). */
  canManage: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────

export function ApplicationsTable({
  rows,
  canManage,
}: ApplicationsTableProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  /**
   * Track which application is currently being acted on so we can show
   * a focused spinner per row instead of disabling the whole table.
   */
  const [pendingApplicationId, setPendingApplicationId] = useState<
    string | null
  >(null);

  /** Shared transition wrapper for shortlist / reject. */
  function changeStatus(
    applicationId: string,
    target: "shortlisted" | "rejected",
  ): void {
    setError(null);
    setPendingApplicationId(applicationId);
    startTransition(async () => {
      const result = await updateApplicationStatus({
        applicationId,
        status: target,
      });
      setPendingApplicationId(null);
      if (!result.ok) {
        setError(result.error ?? "Could not update application");
        return;
      }
      router.refresh();
    });
  }

  /**
   * Day 5 — Reinstate handler.
   *
   * Flips a shortlisted/rejected application back to `submitted` and
   * clears `decidedAt` on the server. Optional reason from the
   * ConfirmDialog passes through to the audit log.
   *
   * After success, the next render shows the row's icons as the
   * original Shortlist/Reject pair again (status is back to submitted).
   */
  function handleReinstate(applicationId: string, reason?: string): void {
    setError(null);
    setPendingApplicationId(applicationId);
    startTransition(async () => {
      const result = await reinstateApplication({
        applicationId,
        ...(reason ? { reason } : {}),
      });
      setPendingApplicationId(null);
      if (!result.ok) {
        setError(result.error ?? "Could not reinstate application");
        return;
      }
      router.refresh();
    });
  }

  // Empty state — same shape as the companies/tenders empty states.
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 px-6 py-12 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Inbox className="h-6 w-6 text-muted-foreground" aria-hidden />
        </div>
        <div className="space-y-1">
          <p className="text-base font-medium text-foreground">
            No applications yet
          </p>
          <p className="text-sm text-muted-foreground">
            Companies that apply to this tender will appear here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      {error && (
        <div className="border-b border-border bg-card p-4">
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" aria-hidden />
            <AlertTitle>Could not update application</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </div>
      )}

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50 hover:bg-muted/50">
              <TableHead className="min-w-[16rem]">Company</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Submitted</TableHead>
              <TableHead>Cover note</TableHead>
              {canManage && (
                <TableHead className="w-[8rem] text-right">Actions</TableHead>
              )}
            </TableRow>
          </TableHeader>

          <TableBody>
            {rows.map((row) => {
              const rowPending =
                isPending && pendingApplicationId === row.id;
              // ── Per-row capability flags ─────────────────────────
              // canActOnRow → Shortlist/Reject (submitted only)
              // canReinstateRow → Reinstate (shortlisted/rejected)
              // Withdrawn rows show no staff actions.
              const canActOnRow =
                canManage && row.status === "submitted" && !rowPending;
              const canReinstateRow =
                canManage &&
                (row.status === "shortlisted" || row.status === "rejected") &&
                !rowPending;

              return (
                <TableRow key={row.id}>
                  {/* Company cell — name + sector + MSME indicator */}
                  <TableCell className="align-top">
                    <div className="flex items-start gap-2">
                      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
                        <Building
                          className="h-4 w-4 text-muted-foreground"
                          aria-hidden
                        />
                      </div>
                      <div className="min-w-0">
                        <Link
                          href={`/dashboard/companies/${row.company.id}`}
                          className="font-medium text-foreground hover:underline"
                        >
                          {row.company.name}
                        </Link>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {row.company.sector} · {row.company.geography}
                          {row.company.isMsme && " · MSME"}
                        </p>
                      </div>
                    </div>
                  </TableCell>

                  <TableCell className="align-top">
                    <ApplicationStatusBadge status={row.status} />
                  </TableCell>

                  <TableCell className="align-top">
                    <div className="text-sm text-foreground">
                      {formatTimestamp(row.submittedAt)}
                    </div>
                    {row.decidedAt && row.status !== "submitted" && (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Decided {formatTimestamp(row.decidedAt)}
                      </p>
                    )}
                  </TableCell>

                  <TableCell className="align-top">
                    {row.coverNote ? (
                      <p
                        title={row.coverNote}
                        className="max-w-xs select-text truncate text-sm text-foreground"
                      >
                        {row.coverNote}
                      </p>
                    ) : (
                      <p className="text-sm italic text-muted-foreground">
                        —
                      </p>
                    )}
                    {/* Staff-only internal notes preview — small font,
                        muted, only when present. Stripped to null on
                        company-role reads by the action so this block
                        only renders for admin/staff naturally. */}
                    {row.internalNotes && (
                      <p
                        title={row.internalNotes}
                        className="mt-1 max-w-xs select-text truncate text-xs italic text-muted-foreground"
                      >
                        Note: {row.internalNotes}
                      </p>
                    )}
                  </TableCell>

                  {canManage && (
                    <TableCell className="align-top">
                      <div className="flex items-center justify-end gap-1">
                        {canActOnRow ? (
                          <>
                            {/* Submitted row: Shortlist + Reject */}
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() =>
                                changeStatus(row.id, "shortlisted")
                              }
                              aria-label={`Shortlist ${row.company.name}`}
                              className="text-muted-foreground hover:text-primary"
                            >
                              <UserCheck className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => changeStatus(row.id, "rejected")}
                              aria-label={`Reject ${row.company.name}`}
                              className="text-muted-foreground hover:text-destructive"
                            >
                              <UserX className="h-4 w-4" />
                            </Button>
                          </>
                        ) : canReinstateRow ? (
                          /* Day 5 — Shortlisted or rejected row:
                             single Reinstate icon, ConfirmDialog with
                             optional reason. ConfirmDialog renders the
                             icon as its trigger; on confirm we call
                             handleReinstate with the (optional) reason. */
                          <ConfirmDialog
                            trigger={
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Reinstate ${row.company.name}'s application`}
                                className="text-muted-foreground hover:text-primary"
                              >
                                <RotateCcw className="h-4 w-4" />
                              </Button>
                            }
                            title={`Reinstate ${row.company.name}'s application?`}
                            description={`This moves the application from ${row.status} back to submitted. The original decision time is preserved in the audit log.`}
                            confirmLabel="Reinstate"
                            confirmVariant="default"
                            reasonField="optional"
                            reasonLabel="Reason (optional)"
                            reasonPlaceholder="e.g. Re-reviewed eligibility documents and the application qualifies"
                            onConfirm={(reason) =>
                              handleReinstate(row.id, reason)
                            }
                            pending={rowPending}
                          />
                        ) : (
                          /* Withdrawn rows and pending rows show no
                             staff actions; pending shows a small
                             "Updating…" label so the row doesn't look
                             dead while the transition is in flight. */
                          <span className="text-xs text-muted-foreground">
                            {rowPending ? "Updating…" : ""}
                          </span>
                        )}
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Compact ISO timestamp → "2026-05-16 04:23". Accepts both space- and
 * T-separated forms (Day-3 tech debt note about timestamp formats).
 */
function formatTimestamp(iso: string): string {
  const normalised = iso.includes("T") ? iso : iso.replace(" ", "T");
  return normalised.slice(0, 16).replace("T", " ");
}
