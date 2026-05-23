/**
 * Company detail page header.
 *
 * Title strip with company name + compliance badge + JV chip + action
 * buttons (Back, Upload document, Edit, Delete). Role-gates each action
 * via boolean props from the parent page:
 *
 *   - Back: visible to everyone
 *   - Upload document: admin/staff for any company; company-role for own row.
 *     Day 9 - the company detail page does not yet show a list of uploaded
 *     documents (Day 10), but the upload button is the entry point so the
 *     feature is discoverable. Once the list lands, this button likely
 *     moves into the Documents-section header rather than the page header.
 *   - Edit: admin and staff (also `company` role on their own row,
 *           but the column gating is what enforces that - the button
 *           shows regardless because we trust the upstream caller's
 *           `canEdit` prop)
 *   - Delete: admin only - destructive style, links to dedicated
 *             confirmation page rather than firing a Server Action
 *             directly
 *
 * Server-Component-compatible (pure render, no hooks).
 *
 * @module app/dashboard/companies/[id]/_components/company-header
 */
import Link from "next/link";
import { ArrowLeft, Pencil, Trash2, Upload } from "lucide-react";
import type { Company } from "@/lib/db/schema";
import { Button } from "@/components/ui/button";
import { ComplianceBadge, JvBadge } from "../../_components/badges";

// ── Props ──────────────────────────────────────────────────────────────────

export interface CompanyHeaderProps {
  /** Full company row - used for name, compliance, JV flag. */
  company: Company;

  /** Whether the viewer may edit. Controls Edit button visibility. */
  canEdit: boolean;

  /** Whether the viewer may delete. Controls Delete button visibility. */
  canDelete: boolean;

  /**
   * Whether the viewer may upload a document for this company. Controls
   * Upload-document button visibility.
   *
   * Day 9: defaults to false so any existing call sites that haven't
   * been updated yet don't accidentally surface the button. New call
   * sites should compute this from the session role + companyId per
   * the RBAC matrix.
   */
  canUploadDocument?: boolean;
}

// ── Component ──────────────────────────────────────────────────────────────

export function CompanyHeader({
  company,
  canEdit,
  canDelete,
  canUploadDocument = false,
}: CompanyHeaderProps) {
  return (
    <header className="mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-start sm:justify-between">
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

      {/* Right: action buttons. Back is always shown; Upload, Edit, and
          Delete are role-gated by the parent page. Button order is
          left-to-right by destructiveness: navigation -> additive ->
          edit-in-place -> destructive. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Button asChild variant="outline">
          <Link href="/dashboard/companies">
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Back
          </Link>
        </Button>

        {canUploadDocument && (
          <Button asChild variant="outline">
            <Link href={`/dashboard/companies/${company.id}/documents/new`}>
              <Upload className="h-4 w-4" aria-hidden />
              Upload document
            </Link>
          </Button>
        )}

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
    </header>
  );
}
