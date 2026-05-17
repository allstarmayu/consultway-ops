/**
 * Create-tender page.
 *
 * Server Component shell. Three responsibilities:
 *
 *   1. Auth gate: only admin and staff may reach this page. Company-role
 *      users get redirected to the list page (they apply to tenders,
 *      they don't publish them — enforced again at the action level as
 *      defence in depth).
 *
 *   2. Fetch the list of companies eligible to be a tender publisher.
 *      The Consultway sentinel is pinned to the top of the list (the
 *      default publisher for internal tenders). The remaining options
 *      are real registered companies — used for subcontract tenders
 *      where one platform member is sub-contracting work to others.
 *
 *   3. Render the `<TenderForm />` client component.
 *
 * The form itself (validation, state, submission) lives in the
 * `<TenderForm />` client component — Server Components can't host
 * react-hook-form. The form is shared with the edit page so it lives
 * under `components/tenders/` rather than inside this route's
 * `_components/` folder.
 *
 * @module app/dashboard/tenders/new/page
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
import {
  TenderForm,
  type PublisherOption,
} from "@/components/tenders/tender-form";

export const metadata: Metadata = {
  title: "Add tender",
  description: "Publish a new tender opportunity",
};

/**
 * Name of the Consultway sentinel publisher company. Mirrors the
 * constants used in `scripts/seed.ts` and `lib/tenders/actions.ts` —
 * kept inline here because the page only needs it to pin the row in
 * the dropdown ordering. When we eventually centralise this in a
 * `lib/tenders/constants.ts` module, three call sites flip to it.
 */
const CONSULTWAY_PUBLISHER_NAME = "Consultway Infotech";

export default async function NewTenderPage() {
  // 1. Auth gate. Layout already guards /dashboard/* against signed-out
  //    users; role-level gating happens here.
  const session = await readSession();
  if (!session) redirect("/login");
  if (session.role !== "admin" && session.role !== "staff") {
    redirect("/dashboard/tenders");
  }

  // 2. Fetch publisher options.
  //
  //    Strategy:
  //      - All companies, ordered alphabetically.
  //      - We tag the sentinel row with `isDefault: true` so the form
  //        labels it "(default)" in the dropdown.
  //      - We do NOT exclude JVs — a JV is a valid publisher in
  //        subcontract scenarios (the JV body itself sub-contracts to
  //        a smaller company).
  //
  //    Performance note: at Phase 1 scale (<200 companies) sending the
  //    full list down is fine. When the roster grows we'll switch to
  //    a typeahead search action.
  const allCompanies = await db
    .select({
      id: companies.id,
      name: companies.name,
    })
    .from(companies)
    .orderBy(asc(companies.name));

  // Find the sentinel and split the list so the sentinel goes first.
  const sentinel = allCompanies.find(
    (c) => c.name === CONSULTWAY_PUBLISHER_NAME,
  );
  const rest = allCompanies.filter(
    (c) => c.name !== CONSULTWAY_PUBLISHER_NAME,
  );

  // Defensive fallback — sentinel should always exist after seed, but
  // if it's missing (e.g. fresh dev DB without seed) we still surface
  // the rest of the list. The action layer will catch the missing
  // sentinel at submit time with a clearer error.
  const publisherOptions: PublisherOption[] = sentinel
    ? [{ ...sentinel, isDefault: true }, ...rest]
    : rest;

  return (
    <>
      <PageHeader
        title="Add tender"
        subtitle="Publish a new tender opportunity"
        actions={
          <Button asChild variant="outline">
            <Link href="/dashboard/tenders">
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back to tenders
            </Link>
          </Button>
        }
      />

      <Card className="overflow-visible p-6 sm:p-8">
        <TenderForm publisherOptions={publisherOptions} />
      </Card>
    </>
  );
}
