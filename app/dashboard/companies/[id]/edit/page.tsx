/**
 * Edit company page.
 *
 * Server Component shell. Fetches the row, performs auth + scope checks,
 * filters the JV-partner options to exclude the company being edited,
 * and renders the shared `<CompanyForm>` in edit mode by passing
 * `initialValues`.
 *
 * Access rules:
 *   - admin / staff: may edit any company
 *   - company role: may edit only their own row (getCompany enforces
 *     row-scope; we additionally hide internalNotes from the form
 *     just by relying on the action to strip it server-side on save)
 *
 * Why filter the partner options? A company can't list itself as its
 * own JV partner — would be a nonsense reference. The Zod schema
 * doesn't catch this case explicitly but the UI removes the ambiguity
 * up-front.
 *
 * @module app/dashboard/companies/[id]/edit/page
 */
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { asc } from "drizzle-orm";
import { readSession } from "@/lib/auth/session";
import { getCompany } from "@/lib/companies/actions";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/dashboard/page-header";
import { CompanyForm } from "@/components/companies/company-form";

interface EditCompanyPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata(
  { params }: EditCompanyPageProps,
): Promise<Metadata> {
  const { id } = await params;
  const result = await getCompany(id);
  if (!result.ok) {
    return { title: "Edit company" };
  }
  return {
    title: `Edit · ${result.company.name}`,
    description: `Update company profile — ${result.company.name}`,
  };
}

export default async function EditCompanyPage({
  params,
}: EditCompanyPageProps) {
  const { id } = await params;

  // Auth gate. Layout already guards /dashboard/*; we additionally
  // confirm the session here for the role check.
  const session = await readSession();
  if (!session) redirect("/login");

  // Fetch the row. getCompany handles row-scope (company role only
  // gets their own row) and 404s for missing rows.
  const result = await getCompany(id);
  if (!result.ok) {
    notFound();
  }
  const company = result.company;

  // Existing companies for the JV partner picker. Filter out the
  // company being edited so it can't pick itself as its own partner.
  // ID + name only — same minimal payload as the create page.
  const partnerOptions = (
    await db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .orderBy(asc(companies.name))
  ).filter((c) => c.id !== company.id);

  return (
    <>
      <PageHeader
        title={`Edit ${company.name}`}
        subtitle="Update company profile and compliance details"
        actions={
          <Button asChild variant="outline">
            <Link href={`/dashboard/companies/${company.id}`}>
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back to company
            </Link>
          </Button>
        }
      />

      <Card className="overflow-visible p-6 sm:p-8">
        <CompanyForm
          existingCompanies={partnerOptions}
          initialValues={company}
        />
      </Card>
    </>
  );
}
