/**
 * Upload-document page.
 *
 * Server Component shell at /dashboard/companies/[id]/documents/new.
 * Two responsibilities, mirroring the new-company page:
 *
 *   1. Auth gate + row-level scope:
 *      - Signed-out -> redirected to /login
 *      - admin / staff -> may upload for any company
 *      - company role -> may upload only for their own companyId; trying
 *        to upload for someone else's company returns 404 (don't leak
 *        the existence of other companies' ids)
 *
 *   2. Fetch the company by id so the page header can say "Upload
 *      document for Acme Construction" rather than just dumping the
 *      uuid in the breadcrumb. id + name only - client form doesn't
 *      need anything else.
 *
 * The form itself lives in components/documents/upload-form.tsx so it's
 * reachable from future surfaces (Day 10's "Documents" tab on the
 * company detail page may render the same form in a dialog).
 *
 * Day 9 scope: this page is the proof-of-concept upload entry point.
 * Polish (drag-drop, progress bar, multi-file) is Day 10-11.
 *
 * @module app/dashboard/companies/[id]/documents/new/page
 */
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { readSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/dashboard/page-header";
import { UploadDocumentForm } from "@/components/documents/upload-form";

export const metadata: Metadata = {
  title: "Upload document",
  description: "Upload a document for a registered company",
};

/**
 * Next.js 15+ types route params as a Promise. Awaiting it inside the
 * component is the convention; mirrors what the company edit page does
 * (and the tender detail page).
 */
interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function UploadDocumentPage({ params }: PageProps) {
  const { id: companyId } = await params;

  // 1. Auth gate. Layout already guards /dashboard/* against signed-out
  //    users, but the per-route role + ownership check happens here.
  const session = await readSession();
  if (!session) redirect("/login");

  // 2. Fetch the company. id + name only - the form doesn't need more.
  const company = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1)
    .then((rows) => rows[0]);

  if (!company) {
    notFound();
  }

  // 3. Row-level scope. company-role users can only upload for their
  //    own company. notFound() rather than a "forbidden" page so we
  //    don't leak the existence of other companies' ids.
  if (session.role === "company") {
    if (!session.companyId || session.companyId !== company.id) {
      notFound();
    }
  }

  const backHref = `/dashboard/companies/${company.id}`;

  return (
    <>
      <PageHeader
        title="Upload document"
        subtitle={`Add a document for ${company.name}`}
        actions={
          <Button asChild variant="outline">
            <Link href={backHref}>
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back to {company.name}
            </Link>
          </Button>
        }
      />

      <Card className="overflow-visible p-6 sm:p-8">
        <UploadDocumentForm
          companyId={company.id}
          companyName={company.name}
        />
      </Card>
    </>
  );
}
