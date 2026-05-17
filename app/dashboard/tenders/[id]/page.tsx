/**
 * Tender detail page.
 *
 * Server Component. Loads the tender + its publisher + the applications
 * list in parallel, then composes:
 *
 *   - TenderHeader      — title, status badge, role-gated action buttons.
 *                         For company-role users, the ApplyButton lives
 *                         in this spot instead.
 *   - TenderOverview    — four-card body (Identity, Categorisation+
 *                         Eligibility, Dates, Internal Notes).
 *   - ApplicationsTable — list of company applications. For staff this
 *                         shows everyone; for the publisher company
 *                         it shows everyone; for an applying company
 *                         it shows their own application (filtered by
 *                         the action's row-scope).
 *
 * Access control:
 *   - admin / staff   → full visibility
 *   - company role    → can see published / closed / awarded; can see
 *                       own drafts as publisher; cannot see others'
 *                       drafts (getTender returns "not found" — we
 *                       render not-found.tsx)
 *
 * The action returns sanitised data (e.g. internalNotes stripped for
 * company-role); we don't re-sanitise here.
 *
 * @module app/dashboard/tenders/[id]/page
 */
import type { Metadata } from "next";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { and, eq } from "drizzle-orm";
import {
  getTender,
  listApplicationsForTender,
} from "@/lib/tenders/actions";
import { readSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { companies, tenderApplications } from "@/lib/db/schema";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { TenderHeader } from "./_components/tender-header";
import { TenderOverview } from "./_components/tender-overview";
import { ApplicationsTable } from "./_components/applications-table";
import { ApplyButton } from "./_components/apply-button";
import { TenderStatusBadge } from "../_components/badges";
import type { TenderStatus } from "@/lib/db/schema";

export const metadata: Metadata = {
  title: "Tender",
  description: "Tender details and applications",
};

/**
 * Next.js App Router types `params` as a Promise in 15+.
 */
interface TenderDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function TenderDetailPage({
  params,
}: TenderDetailPageProps) {
  const [{ id }, session] = await Promise.all([params, readSession()]);
  if (!session) redirect("/login");

  // 1. Load the tender (action handles row-scope) and applications in
  //    parallel. Both can fail — handle each independently.
  const [tenderResult, applicationsResult] = await Promise.all([
    getTender(id),
    listApplicationsForTender(id),
  ]);

  // Tender not found → render the route's not-found.tsx. We don't
  // distinguish between "doesn't exist" and "you can't see this draft"
  // — leaking that distinction would be a minor info leak (see action).
  if (!tenderResult.ok) {
    notFound();
  }

  const tender = tenderResult.tender;

  // 2. Resolve the publisher company name in a single small query.
  //    The action returned the publisher *id* on the tender row; we
  //    fetch just `name` for the display.
  const publisherRow = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(eq(companies.id, tender.publisherCompanyId))
    .limit(1)
    .then((rows) => rows[0]);

  // FK is NOT NULL so publisher must exist. If it somehow doesn't,
  // surface a defensive error rather than crashing on a null deref.
  if (!publisherRow) {
    return (
      <>
        <PageBackLink />
        <Alert variant="destructive">
          <AlertTitle>Tender data is inconsistent</AlertTitle>
          <AlertDescription>
            The publisher company for this tender no longer exists. Contact
            an administrator.
          </AlertDescription>
        </Alert>
      </>
    );
  }

  // 3. Application list result. A failure here is non-fatal — we still
  //    render the rest of the page and surface the error in the
  //    applications card.
  const applications = applicationsResult.ok ? applicationsResult.rows : [];
  const applicationsError = applicationsResult.ok
    ? null
    : applicationsResult.error;

  // 4. Role-derived flags. These are passed down to child components so
  //    each one doesn't re-derive the same logic.
  const canManage =
    session.role === "admin" || session.role === "staff";
  const canDelete = session.role === "admin";
  const isCompanyRole = session.role === "company";
  const hasApplications = applications.length > 0;

  // 5. For company-role viewers: fetch their own row + their existing
  //    application on this tender (if any) to drive the ApplyButton.
  //    Skipped for admin/staff who never see the apply button.
  let viewingCompany: {
    id: string;
    sector: string;
    geography: string;
    isMsme: boolean;
  } | null = null;
  let existingApplication = null;

  if (isCompanyRole && session.companyId) {
    const [companyRow, existing] = await Promise.all([
      db
        .select({
          id: companies.id,
          sector: companies.sector,
          geography: companies.geography,
          isMsme: companies.isMsme,
        })
        .from(companies)
        .where(eq(companies.id, session.companyId))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select()
        .from(tenderApplications)
        .where(
          and(
            eq(tenderApplications.tenderId, tender.id),
            eq(tenderApplications.companyId, session.companyId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);

    viewingCompany = companyRow;
    existingApplication = existing;
  }

  return (
    <>
      <PageBackLink />

      {/* Header: status + actions for staff, or apply controls for company role */}
      {canManage ? (
        <TenderHeader
          tender={tender}
          canManage={canManage}
          canDelete={canDelete}
          hasApplications={hasApplications}
        />
      ) : (
        // Company role — still show the title + status, just with the
        // ApplyButton in place of the staff transition buttons.
        <header className="mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
              {tender.title}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              {/* Reusing TenderStatusBadge via TenderHeader's import is
                  fine but adds a Client boundary cost; for this branch
                  we render an inline status pill via the badges module
                  directly. */}
              <CompanyHeaderStatus status={tender.status} />
              {tender.referenceNumber && (
                <span className="font-mono text-xs text-muted-foreground">
                  {tender.referenceNumber}
                </span>
              )}
            </div>
          </div>

          {viewingCompany && (
            <ApplyButton
              tender={tender}
              company={viewingCompany}
              existingApplication={existingApplication}
            />
          )}
        </header>
      )}

      {/* Overview cards */}
      <TenderOverview
        tender={tender}
        publisher={publisherRow}
        showInternalNotes={canManage}
      />

      {/* Applications section */}
      <Card className="mt-4 overflow-hidden p-0">
        <div className="flex items-center justify-between border-b border-border bg-card p-4">
          <h2 className="text-base font-semibold text-foreground">
            Applications{" "}
            <span className="font-normal text-muted-foreground">
              ({applications.length})
            </span>
          </h2>
        </div>

        {applicationsError ? (
          <div className="p-4">
            <Alert variant="destructive">
              <AlertTitle>Could not load applications</AlertTitle>
              <AlertDescription>{applicationsError}</AlertDescription>
            </Alert>
          </div>
        ) : (
          <ApplicationsTable rows={applications} canManage={canManage} />
        )}
      </Card>
    </>
  );
}

// ── Small inline components ───────────────────────────────────────────────

/**
 * "Back to tenders" link rendered above the page header on every detail
 * variant. Extracted so the not-found fallback and the consistent-data
 * fallback can share it.
 */
function PageBackLink() {
  return (
    <div className="mb-4">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/dashboard/tenders">
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to tenders
        </Link>
      </Button>
    </div>
  );
}

/**
 * Inline status badge for the company-role header variant.
 *
 * Why this exists: the main TenderStatusBadge lives in a module also
 * imported by the staff-side TenderHeader (Client Component). Using
 * it directly here in the Server Component is fine — same module, no
 * extra boundary. Wrapped in a named function so the JSX above reads
 * as "company header status" rather than the raw badge import name.
 */
function CompanyHeaderStatus({ status }: { status: TenderStatus }) {
  return <TenderStatusBadge status={status} />;
}
