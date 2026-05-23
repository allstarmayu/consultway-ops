/**
 * Company detail page.
 *
 * Server Component shell. Responsibilities:
 *
 *   1. Auth: layout already guards /dashboard/* against signed-out
 *      users; here we additionally check that company-role users
 *      can only ever land on their own row.
 *
 *   2. Fetch the row via getCompany() - which performs the row-scope
 *      check itself and strips internalNotes for company-role users.
 *      Returns a typed ActionResult.
 *
 *   3. If row not found OR access denied: render `notFound()` so
 *      Next.js shows our not-found.tsx instead of an empty page.
 *
 *   4. If JV: also fetch the partner companies' names so we can
 *      display "Partners: Acme + BuildRight" instead of a row of UUIDs.
 *      Done with a single batched IN-query to avoid an N+1 pattern.
 *
 *   5. Render <CompanyHeader> + <CompanyOverview>, splitting the
 *      page into a header strip (title + actions) and a content card
 *      (the fact sheet).
 *
 *   6. EntityHistory card (Day 7) - audit-log feed for this company.
 *      Wrapped in <Suspense> so its DB queries don't block the
 *      overview render. Same component the tender detail page uses,
 *      with the company-only variant (no application fan-out).
 *
 * @module app/dashboard/companies/[id]/page
 */
import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { inArray } from "drizzle-orm";
import { readSession } from "@/lib/auth/session";
import { getCompany } from "@/lib/companies/actions";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { Card } from "@/components/ui/card";
import { EntityHistory } from "@/components/audit/entity-history";
import { EntityHistoryLoading } from "@/components/audit/entity-history-loading";
import { CompanyHeader } from "./_components/company-header";
import { CompanyOverview } from "./_components/company-overview";

/**
 * Next.js App Router types `params` as a Promise in 15+.
 */
interface CompanyDetailPageProps {
  params: Promise<{ id: string }>;
}

// ── Metadata ──────────────────────────────────────────────────────────────

/**
 * Dynamic page title. We fetch the company name server-side and inject
 * it into the document title - saves users tab-bar-scanning when they
 * have multiple companies open. Failures fall back to a generic title.
 */
export async function generateMetadata(
  { params }: CompanyDetailPageProps,
): Promise<Metadata> {
  const { id } = await params;
  const result = await getCompany(id);
  if (!result.ok) {
    return { title: "Company" };
  }
  return {
    title: result.company.name,
    description: `Company profile - ${result.company.name}`,
  };
}

// ── Page ──────────────────────────────────────────────────────────────────

export default async function CompanyDetailPage({
  params,
}: CompanyDetailPageProps) {
  const { id } = await params;

  // Session needed for role-gating the Edit / Delete / Upload buttons.
  // Layout guarantees a session exists (redirects otherwise), but
  // TypeScript can't see that, so we narrow defensively.
  const session = await readSession();
  if (!session) notFound();

  // Fetch the company. getCompany() handles row-scope (company-role
  // users only see their own row) and field-strip (no internalNotes
  // for company role).
  const result = await getCompany(id);
  if (!result.ok) {
    notFound();
  }
  const company = result.company;

  // Fetch partner names if this is a JV. Single IN-query, not N+1.
  // We pass labels (not full rows) to the overview because that's all
  // the UI needs - keeps the partner-pill render lean.
  let partnerLabels: Array<{ id: string; name: string }> = [];
  if (
    company.isJv &&
    Array.isArray(company.parentCompanyIds) &&
    company.parentCompanyIds.length > 0
  ) {
    partnerLabels = await db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(inArray(companies.id, company.parentCompanyIds));
  }

  // Role gates for the header action buttons. Same RBAC matrix as
  // documented in docs/08-rbac-matrix.md:
  //   - Edit: admin and staff
  //   - Delete: admin only
  //   - Upload document: admin/staff for any company, company-role for
  //     own row. We've already gated row-level access above via
  //     getCompany - if a company-role user reached this page, their
  //     companyId matches this row's id, so we can short-circuit to
  //     true rather than re-checking.
  const canEdit = session.role === "admin" || session.role === "staff";
  const canDelete = session.role === "admin";
  const canUploadDocument =
    session.role === "admin" ||
    session.role === "staff" ||
    (session.role === "company" && session.companyId === company.id);

  return (
    <>
      <CompanyHeader
        company={company}
        canEdit={canEdit}
        canDelete={canDelete}
        canUploadDocument={canUploadDocument}
      />

      <Card className="overflow-hidden p-0">
        <CompanyOverview
          company={company}
          partnerLabels={partnerLabels}
          viewerRole={session.role}
        />
      </Card>

      {/* History section (Day 7) - audit-log feed scoped to this
          company. Wrapped in Suspense so the DB query streams in
          independently of the overview render above. Company-only
          variant - no application fan-out, single listAuditEvents
          call inside EntityHistory.

          Visibility: admin/staff see every event on this company.
          Company-role users only reach this page for their own row
          (row-scope in getCompany), and listAuditEvents further
          scopes them to their own actions - so they see their own
          edits but not staff-actor events on their company. This
          matches the Phase-1 cross-actor visibility decision flagged
          in the Day-6 report. */}
      <Suspense fallback={<EntityHistoryLoading />}>
        <EntityHistory
          targetType="company"
          targetId={company.id}
          emptyDescription="No activity recorded on this company yet."
        />
      </Suspense>
    </>
  );
}
