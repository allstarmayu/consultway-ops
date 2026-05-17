/**
 * Edit-tender page.
 *
 * Server Component shell. Three responsibilities:
 *
 *   1. Auth gate: only admin and staff may reach this page. Company-role
 *      users get redirected to the detail page (they can never edit
 *      a tender — enforced again at the action level as defence in
 *      depth).
 *
 *   2. Fetch the existing tender row via `getTender`. If not found,
 *      delegate to `not-found.tsx`. The action also enforces row-level
 *      scope, so a draft someone else published won't reach here.
 *
 *   3. Fetch the publisher options list (same query as the create page
 *      uses). Even though the form hides the publisher section in edit
 *      mode, the form's prop signature requires the list — passing an
 *      empty array would work but feels wrong.
 *
 *   4. Render `<TenderForm initialValues={tender} ...>`. The form's
 *      edit-mode logic handles status-aware field gating, the locked-
 *      fields banner, the redirect on save, and the publisher section
 *      visibility.
 *
 * @module app/dashboard/tenders/[id]/edit/page
 */
import type { Metadata } from "next";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { asc } from "drizzle-orm";
import { getTender } from "@/lib/tenders/actions";
import { readSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/dashboard/page-header";
import {
  TenderForm,
  type PublisherOption,
} from "@/components/tenders/tender-form";

export const metadata: Metadata = {
  title: "Edit tender",
  description: "Update tender details",
};

/**
 * Name of the Consultway sentinel publisher. Same string as in the
 * create page and scripts/seed.ts — when these three call sites flip
 * to a shared constants module (likely Day 5), we centralise.
 */
const CONSULTWAY_PUBLISHER_NAME = "Consultway Infotech";

interface EditTenderPageProps {
  params: Promise<{ id: string }>;
}

export default async function EditTenderPage({
  params,
}: EditTenderPageProps) {
  // 1. Auth gate
  const [{ id }, session] = await Promise.all([params, readSession()]);
  if (!session) redirect("/login");
  if (session.role !== "admin" && session.role !== "staff") {
    redirect(`/dashboard/tenders/${id}`);
  }

  // 2. Fetch the tender. Not-found → render the route's not-found.tsx.
  const result = await getTender(id);
  if (!result.ok) {
    notFound();
  }
  const tender = result.tender;

  // 3. Publisher options list — same shape as the create page. In edit
  //    mode the form doesn't display this section, but the prop is
  //    required by the form's interface. We could pass `[]` and skip
  //    the DB hit; we run the query anyway because it's cheap and it
  //    keeps the page symmetric with /dashboard/tenders/new (easier
  //    to reason about, easier to refactor when we centralise this).
  const allCompanies = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .orderBy(asc(companies.name));

  const sentinel = allCompanies.find(
    (c) => c.name === CONSULTWAY_PUBLISHER_NAME,
  );
  const rest = allCompanies.filter(
    (c) => c.name !== CONSULTWAY_PUBLISHER_NAME,
  );
  const publisherOptions: PublisherOption[] = sentinel
    ? [{ ...sentinel, isDefault: true }, ...rest]
    : rest;

  return (
    <>
      <PageHeader
        title="Edit tender"
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
        <TenderForm
          publisherOptions={publisherOptions}
          initialValues={tender}
        />
      </Card>
    </>
  );
}
