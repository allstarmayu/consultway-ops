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
import { DocumentsSection } from "./_components/documents-section";
import { DocumentsSectionLoading } from "./_components/documents-section-loading";

/**
 * Next.js App Router types `params` and `searchParams` as Promises
 * in 15+. The documents section reads `documentStatus` and
 * `documentType` from the URL to drive its filter dropdowns; future
 * filters on other sections of this page can be added under their own
 * namespaced keys without collision.
 */
interface CompanyDetailPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
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

/**
 * Closed set of document statuses, mirrored from the schema's
 * `DocumentStatus` union. Used for runtime narrowing of URL params -
 * `listDocumentsForCompany` validates again on the server, but
 * narrowing here keeps the page prop strongly typed without an
 * `as DocumentStatus` cast.
 */
const DOCUMENT_STATUS_VALUES = [
  "pending",
  "pending_review",
  "verified",
  "rejected",
  "expired",
] as const;
type DocumentStatusValue = (typeof DOCUMENT_STATUS_VALUES)[number];

const DOCUMENT_TYPE_VALUES = [
  "gst_certificate",
  "pan_card",
  "incorporation_cert",
  "board_resolution",
  "cancelled_cheque",
  "trade_license",
  "other",
] as const;
type DocumentTypeValue = (typeof DOCUMENT_TYPE_VALUES)[number];

/**
 * Pull a single string out of a Next.js searchParams record, ignoring
 * arrays (`?key=a&key=b`) and undefined.
 */
function singleParam(
  v: string | string[] | undefined,
): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function parseStatus(
  raw: string | undefined,
): DocumentStatusValue | undefined {
  return raw && (DOCUMENT_STATUS_VALUES as readonly string[]).includes(raw)
    ? (raw as DocumentStatusValue)
    : undefined;
}

function parseType(raw: string | undefined): DocumentTypeValue | undefined {
  return raw && (DOCUMENT_TYPE_VALUES as readonly string[]).includes(raw)
    ? (raw as DocumentTypeValue)
    : undefined;
}

// ── Page ──────────────────────────────────────────────────────────────────

export default async function CompanyDetailPage({
  params,
  searchParams,
}: CompanyDetailPageProps) {
  const [{ id }, urlQuery] = await Promise.all([params, searchParams]);

  // Filter values for the documents section. Narrowed against the
  // canonical enum tuples - an unknown value silently drops to
  // `undefined` (same effect as removing the param), which is the
  // right UX for a tampered URL.
  const statusFilter = parseStatus(singleParam(urlQuery.documentStatus));
  const documentTypeFilter = parseType(singleParam(urlQuery.documentType));

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
  //     true rather than re-checking. Upload now sits inside the
  //     Documents section (Day 10) rather than the page header - so
  //     the boolean flows to that component instead of CompanyHeader.
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
      />

      <Card className="overflow-hidden p-0">
        <CompanyOverview
          company={company}
          partnerLabels={partnerLabels}
          viewerRole={session.role}
        />
      </Card>

      {/* Documents section (Day 10). Lists the company's uploaded
          documents with type / status badges and per-row download.
          Wrapped in Suspense so the DB query streams in independently
          of the overview render above. Role-scope (company-role only
          sees own docs) is enforced inside the action layer. */}
      <Suspense
        // Key on the filter values so a filter change triggers the
        // fallback skeleton instead of holding the previous list while
        // the new query resolves. Both undefined → stable key
        // ("|"); typical use shifts the key only on filter input.
        key={`${statusFilter ?? ""}|${documentTypeFilter ?? ""}`}
        fallback={<DocumentsSectionLoading />}
      >
        <DocumentsSection
          companyId={company.id}
          canUploadDocument={canUploadDocument}
          viewerRole={session.role}
          statusFilter={statusFilter}
          documentTypeFilter={documentTypeFilter}
        />
      </Suspense>

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
