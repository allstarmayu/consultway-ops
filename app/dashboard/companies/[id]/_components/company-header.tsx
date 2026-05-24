/**
 * Company detail page header.
 *
 * Title strip with company name + compliance badge + JV chip + action
 * buttons (Back, Edit, Delete). Role-gates each action via boolean
 * props from the parent page:
 *
 *   - Back: visible to everyone
 *   - Edit: admin and staff (also `company` role on their own row,
 *           but the column gating is what enforces that - the button
 *           shows regardless because we trust the upstream caller's
 *           `canEdit` prop)
 *   - Delete: admin only - destructive style, links to dedicated
 *             confirmation page rather than firing a Server Action
 *             directly
 *
 * Day 10 note: the Upload-document button used to live here as a
 * Day-9 entry point. It now sits inside the Documents section below
 * the overview card instead, so users find the upload affordance
 * adjacent to the documents list it produces.
 *
 * Server-Component-compatible (pure render, no hooks).
 *
 * @module app/dashboard/companies/[id]/_components/company-header
 */
import Link from "next/link";
import { ArrowLeft, Ban, Pencil, Trash2 } from "lucide-react";
import type { Company, UserRole } from "@/lib/db/schema";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ComplianceBadge, JvBadge } from "../../_components/badges";

// ── Props ──────────────────────────────────────────────────────────────────

export interface CompanyHeaderProps {
  /** Full company row - used for name, compliance, JV flag. */
  company: Company;

  /**
   * Viewer role. Used to gate the rejection-reason callout — only
   * admin / staff see WHY a company was rejected. Company-role users
   * never reach this branch because `getCompany` strips the field, but
   * we re-check here so a future refactor can't accidentally surface
   * internal moderation context to the company itself.
   */
  viewerRole: UserRole;

  /** Whether the viewer may edit. Controls Edit button visibility. */
  canEdit: boolean;

  /** Whether the viewer may delete. Controls Delete button visibility. */
  canDelete: boolean;
}

// ── Component ──────────────────────────────────────────────────────────────

export function CompanyHeader({
  company,
  viewerRole,
  canEdit,
  canDelete,
}: CompanyHeaderProps) {
  // Day 23: rejection-reason callout. Only shown to admin / staff,
  // only on rows that actually carry a reason. Defence in depth — the
  // company-role strip in `getCompany` already nulls the field, but the
  // role check here keeps the component honest if it's ever rendered
  // with an un-stripped row.
  const showRejectionCallout =
    (viewerRole === "admin" || viewerRole === "staff") &&
    company.complianceStatus === "rejected" &&
    typeof company.rejectionReason === "string" &&
    company.rejectionReason.trim().length > 0;

  return (
    <header className="mb-6 flex flex-col gap-4 sm:mb-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        {/* Left: title + chips. min-w-0 lets long names truncate. */}
        <div className="min-w-0">
          <h1 className="break-words text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            {company.name}
          </h1>

          {/* Chips row - compliance + optional JV. */}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <ComplianceBadge status={company.complianceStatus} />
            {company.isJv && <JvBadge />}
          </div>
        </div>

        {/* Right: action buttons. Back is always shown; Edit and Delete
            are role-gated by the parent page. Button order is left-to-
            right by destructiveness: navigation -> edit-in-place ->
            destructive. */}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button asChild variant="outline">
            <Link href="/dashboard/companies">
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back
            </Link>
          </Button>

          {canEdit && (
            <Button asChild variant="outline">
              <Link href={`/dashboard/companies/${company.id}/edit`}>
                <Pencil className="h-4 w-4" aria-hidden />
                Edit
              </Link>
            </Button>
          )}

          {canDelete && (
            <Button
              asChild
              variant="destructive"
            >
              <Link href={`/dashboard/companies/${company.id}/delete`}>
                <Trash2 className="h-4 w-4" aria-hidden />
                Delete
              </Link>
            </Button>
          )}
        </div>
      </div>

      {showRejectionCallout && (
        <Alert variant="destructive">
          <Ban aria-hidden />
          <AlertTitle>Rejection reason</AlertTitle>
          <AlertDescription>{company.rejectionReason}</AlertDescription>
        </Alert>
      )}
    </header>
  );
}
