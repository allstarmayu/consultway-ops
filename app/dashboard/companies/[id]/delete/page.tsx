/**
 * Delete company — confirmation page.
 *
 * Admin-only. The dedicated-page approach (vs a modal) is deliberate:
 *
 *   - Deletion is irreversible; the page-jump forces a deliberate
 *     "leave my flow and confirm" gesture
 *   - The type-to-confirm input adds a second safety against muscle
 *     memory clicks
 *   - Layout has room for context (what will be deleted, what gets
 *     orphaned) without cramming it into a modal
 *
 * Access:
 *   - non-admin users get redirected to the detail page (the delete
 *     button on the detail page is also admin-gated, so company/staff
 *     users shouldn't normally land here, but we re-enforce defensively)
 *   - missing row → notFound()
 *
 * The actual deletion happens in the client `<DeleteForm>` component,
 * which calls the deleteCompany Server Action and redirects to the
 * companies list on success.
 *
 * @module app/dashboard/companies/[id]/delete/page
 */
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, AlertTriangle } from "lucide-react";
import Link from "next/link";
import { readSession } from "@/lib/auth/session";
import { getCompany } from "@/lib/companies/actions";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PageHeader } from "@/components/dashboard/page-header";
import { DeleteForm } from "./_components/delete-form";

interface DeleteCompanyPageProps {
  params: Promise<{ id: string }>;
}

export const metadata: Metadata = {
  title: "Delete company",
  description: "Confirm permanent removal of a company",
};

export default async function DeleteCompanyPage({
  params,
}: DeleteCompanyPageProps) {
  const { id } = await params;

  // Auth + role gate. Layout already guards /dashboard/*; here we
  // additionally enforce admin-only access. Non-admins bounce back
  // to the detail page rather than hitting a 403, since they likely
  // followed a stale link or typed the URL directly.
  const session = await readSession();
  if (!session) redirect("/login");
  if (session.role !== "admin") {
    redirect(`/dashboard/companies/${id}`);
  }

  // Fetch the row to display its name in the confirmation prompt.
  const result = await getCompany(id);
  if (!result.ok) {
    notFound();
  }
  const company = result.company;

  return (
    <>
      <PageHeader
        title="Delete company"
        subtitle="Confirm permanent removal"
        actions={
          <Button asChild variant="outline">
            <Link href={`/dashboard/companies/${company.id}`}>
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back to company
            </Link>
          </Button>
        }
      />

      {/* Narrow centered card — destructive actions deserve a tight
          focal point rather than the wide multi-column form layout. */}
      <div className="mx-auto max-w-2xl">
        {/* Warning callout — explains what will happen + what won't.
            Linked users get orphaned (companyId set to NULL), they're
            not deleted. Worth surfacing so admins know what cleanup
            still needs doing. */}
        <Alert variant="destructive" className="mb-6">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>This action is permanent</AlertTitle>
          <AlertDescription>
            The company record will be removed immediately and cannot be
            recovered. Any users linked to this company will be unlinked
            (their accounts remain active but lose company association).
            Future modules (tenders, projects, documents) tied to this
            company would also need separate cleanup.
          </AlertDescription>
        </Alert>

        <Card className="overflow-hidden p-6 sm:p-8">
          {/* Company identity panel — confirms what's about to be
              deleted. Using a subtle bordered box rather than the
              full table style; the user is staring at a single row's
              worth of context, not browsing. */}
          <div className="mb-6 rounded-md border border-border bg-muted/40 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Company to delete
            </p>
            <p className="mt-1 text-lg font-semibold text-foreground">
              {company.name}
            </p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {company.sector} · {company.geography}
            </p>
          </div>

          <DeleteForm companyId={company.id} companyName={company.name} />
        </Card>
      </div>
    </>
  );
}
