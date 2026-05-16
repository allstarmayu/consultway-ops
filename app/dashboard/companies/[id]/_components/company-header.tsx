/**
 * Company detail page header.
 *
 * Title strip with company name + compliance badge + JV chip + action
 * buttons (Back, Edit, Delete). Role-gates the destructive actions:
 *
 *   - Back: visible to everyone
 *   - Edit: admin and staff (also `company` role on their own row,
 *           but the column gating is what enforces that — the button
 *           shows regardless because we trust the upstream caller's
 *           `canEdit` prop)
 *   - Delete: admin only — destructive style, links to dedicated
 *             confirmation page rather than firing a Server Action
 *             directly
 *
 * Server-Component-compatible (pure render, no hooks).
 *
 * @module app/dashboard/companies/[id]/_components/company-header
 */
import Link from "next/link";
import { ArrowLeft, Pencil, Trash2 } from "lucide-react";
import type { Company } from "@/lib/db/schema";
import { Button } from "@/components/ui/button";
import { ComplianceBadge, JvBadge } from "../../_components/badges";

// ── Props ───────────────────────────────────────────────────────────────────

export interface CompanyHeaderProps {
  /** Full company row — used for name, compliance, JV flag. */
  company: Company;

  /** Whether the viewer may edit. Controls Edit button visibility. */
  canEdit: boolean;

  /** Whether the viewer may delete. Controls Delete button visibility. */
  canDelete: boolean;
}

// ── Component ───────────────────────────────────────────────────────────────

export function CompanyHeader({
  company,
  canEdit,
  canDelete,
}: CompanyHeaderProps) {
  return (
    <header className="mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-start sm:justify-between">
      {/* Left: title + chips. min-w-0 lets long names truncate. */}
      <div className="min-w-0">
        <h1 className="break-words text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          {company.name}
        </h1>

        {/* Chips row — compliance + optional JV. */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <ComplianceBadge status={company.complianceStatus} />
          {company.isJv && <JvBadge />}
        </div>
      </div>

      {/* Right: action buttons. Back is always shown; Edit and Delete
          are role-gated by the parent page. */}
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
    </header>
  );
}
