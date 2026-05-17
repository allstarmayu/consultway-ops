/**
 * Delete-tender confirmation page.
 *
 * Server Component shell. Three responsibilities:
 *
 *   1. Auth gate: admin only. Staff and company-role users are
 *      redirected back to the detail page (deletion is admin-only by
 *      policy; the action also enforces this).
 *
 *   2. Fetch the tender via `getTender`. If not found, render the
 *      route's not-found.tsx (delegated via `notFound()`).
 *
 *   3. Status gate: only `draft` tenders can be deleted. The action
 *      enforces this too, but we surface a friendly explanation here
 *      so the admin doesn't have to click Delete and read an error.
 *      For non-drafts, we replace the confirmation form with an
 *      explanation card.
 *
 * @module app/dashboard/tenders/[id]/delete/page
 */
import type { Metadata } from "next";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { getTender } from "@/lib/tenders/actions";
import { readSession } from "@/lib/auth/session";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PageHeader } from "@/components/dashboard/page-header";
import { DeleteForm } from "./_components/delete-form";

export const metadata: Metadata = {
  title: "Delete tender",
  description: "Confirm tender deletion",
};

interface DeleteTenderPageProps {
  params: Promise<{ id: string }>;
}

export default async function DeleteTenderPage({
  params,
}: DeleteTenderPageProps) {
  // 1. Auth gate — admin only.
  const [{ id }, session] = await Promise.all([params, readSession()]);
  if (!session) redirect("/login");
  if (session.role !== "admin") {
    redirect(`/dashboard/tenders/${id}`);
  }

  // 2. Fetch the tender.
  const result = await getTender(id);
  if (!result.ok) {
    notFound();
  }
  const tender = result.tender;

  // 3. Status gate. Render an explainer instead of the form when the
  //    tender is past draft.
  const isDraft = tender.status === "draft";

  return (
    <>
      <PageHeader
        title="Delete tender"
        subtitle={tender.title}
        actions={
          <Button asChild variant="outline">
            <Link href={`/dashboard/tenders/${tender.id}`}>
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back to tender
            </Link>
          </Button>
        }
      />

      <Card className="overflow-visible p-6 sm:p-8">
        {isDraft ? (
          <>
            <Alert variant="destructive" className="mb-6">
              <AlertTriangle className="h-4 w-4" aria-hidden />
              <AlertTitle>This action cannot be undone</AlertTitle>
              <AlertDescription>
                The tender will be permanently removed. Any applications on
                it (drafts shouldn&apos;t have any, but if they do) will be
                deleted via cascade.
              </AlertDescription>
            </Alert>

            <DeleteForm tenderId={tender.id} tenderTitle={tender.title} />
          </>
        ) : (
          <Alert>
            <AlertTriangle className="h-4 w-4" aria-hidden />
            <AlertTitle>This tender cannot be deleted</AlertTitle>
            <AlertDescription className="space-y-3">
              <p>
                Only draft tenders can be deleted. This tender is{" "}
                <span className="font-medium">{tender.status}</span>.
              </p>
              <p>
                To retire a published tender, close it and (if applicable)
                mark it awarded. The audit trail then preserves the full
                history.
              </p>
              <Button asChild variant="outline" size="sm">
                <Link href={`/dashboard/tenders/${tender.id}`}>
                  Back to tender
                </Link>
              </Button>
            </AlertDescription>
          </Alert>
        )}
      </Card>
    </>
  );
}
