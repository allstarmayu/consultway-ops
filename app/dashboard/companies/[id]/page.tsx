/**
 * Company detail page.
 *
 * Server Component shell. Responsibilities:
 *
 *   1. Auth: layout already guards /dashboard/* against signed-out
 *      users; here we additionally check that company-role users
 *      can only ever land on their own row.
 *
 *   2. Fetch the row via getCompany() — which performs the row-scope
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
 * @module app/dashboard/companies/[id]/page
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { inArray } from "drizzle-orm";
import { readSession } from "@/lib/auth/session";
import { getCompany } from "@/lib/companies/actions";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { Card } from "@/components/ui/card";
import { CompanyHeader } from "./_components/company-header";
import { CompanyOverview } from "./_components/company-overview";

/**
 * Next.js App Router types `params` as a Promise in 15+.
 */
interface CompanyDetailPageProps {
  params: Promise<{ id: string }>;
}

// ── Metadata ────────────────────────────────────────────────────────────────

/**
 * Dynamic page title. We fetch the company name server-side and inject
 * it into the document title — saves users tab-bar-scanning when they
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
    description: `Company profile — ${result.company.name}`,
  };
}

// ── Page ────────────────────────────────────────────────────────────────────

export default async function CompanyDetailPage({
  params,
}: CompanyDetailPageProps) {
  const { id } = await params;

  // Session needed for role-gating the Edit / Delete buttons.
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
  // the UI needs — keeps the partner-pill render lean.
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

  const canEdit = session.role === "admin" || session.role === "staff";
  const canDelete = session.role === "admin";

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
    </>
  );
}
