/**
 * Create-company page.
 *
 * Server Component shell. Two responsibilities:
 *
 *   1. Auth gate: only admin and staff may reach this page. Company-role
 *      users get redirected to the list page (they can never create —
 *      enforced again at the action level as defence in depth).
 *
 *   2. Fetch the existing list of company names to feed the JV partner
 *      picker. Partners are existing companies, so the typeahead source
 *      lives on the server. We pass the minimal `{ id, name }` shape
 *      down to keep the client payload small.
 *
 * The form itself (validation, state, submission) lives in the
 * `<CompanyForm />` client component — Server Components can't host
 * react-hook-form.
 *
 * @module app/dashboard/companies/new/page
 */
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { asc } from "drizzle-orm";
import { readSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/dashboard/page-header";
import { CompanyForm } from "./_components/company-form";

export const metadata: Metadata = {
  title: "Add company",
  description: "Register a new company on the Consultway platform",
};

export default async function NewCompanyPage() {
  // 1. Auth gate. Layout already guards /dashboard/* against signed-out
  //    users, but role-level gating happens here. Company-role users
  //    aren't allowed to create — bounce them back to the list.
  const session = await readSession();
  if (!session) redirect("/login");
  if (session.role !== "admin" && session.role !== "staff") {
    redirect("/dashboard/companies");
  }

  // 2. Existing companies for the JV partner picker. We need id+name
  //    only — including the rest of the row would inflate the client
  //    bundle without benefit. Ordered alphabetically for the typeahead.
  const existingCompanies = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .orderBy(asc(companies.name));

  return (
    <>
      <PageHeader
        title="Add company"
        subtitle="Register a new company on the Consultway platform"
        actions={
          <Button asChild variant="outline">
            <Link href="/dashboard/companies">
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back to companies
            </Link>
          </Button>
        }
      />

      <Card className="overflow-visible p-6 sm:p-8">
        <CompanyForm existingCompanies={existingCompanies} />
      </Card>
    </>
  );
}
