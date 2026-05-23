/**
 * Transaction detail page — admin-only.
 *
 * Server Component. Loads the transaction + its counterparty company +
 * (optionally) the linked project, then composes:
 *
 *   - TransactionHeader   — title (type + amount + date), Edit + Delete
 *   - TransactionOverview — three cards (Identity, Counterparty, Notes)
 *   - EntityHistory       — audit-log feed scoped to this transaction
 *
 * @module app/dashboard/transactions/[id]/page
 */
import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { eq } from "drizzle-orm";
import { getTransaction } from "@/lib/transactions/actions";
import { readSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { companies, projects } from "@/lib/db/schema";
import { Button } from "@/components/ui/button";
import { EntityHistory } from "@/components/audit/entity-history";
import { EntityHistoryLoading } from "@/components/audit/entity-history-loading";
import { TransactionHeader } from "./_components/transaction-header";
import { TransactionOverview } from "./_components/transaction-overview";

export const metadata: Metadata = {
  title: "Transaction",
  description: "Transaction details and history",
};

interface TransactionDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function TransactionDetailPage({
  params,
}: TransactionDetailPageProps) {
  const [{ id }, session] = await Promise.all([params, readSession()]);
  if (!session) redirect("/login");
  if (session.role !== "admin") redirect("/dashboard");

  const result = await getTransaction(id);
  if (!result.ok) {
    notFound();
  }
  const transaction = result.transaction;

  const [companyRow, linkedProject] = await Promise.all([
    db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(eq(companies.id, transaction.companyId))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    transaction.projectId
      ? db
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(eq(projects.id, transaction.projectId))
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
  ]);

  // FK is NOT NULL — defensive notFound rather than crashing.
  if (!companyRow) notFound();

  return (
    <>
      <div className="mb-4">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/dashboard/transactions">
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Back to transactions
          </Link>
        </Button>
      </div>

      <TransactionHeader transaction={transaction} />

      <TransactionOverview
        transaction={transaction}
        company={companyRow}
        linkedProject={linkedProject}
      />

      <Suspense fallback={<EntityHistoryLoading />}>
        <EntityHistory
          targetType="transaction"
          targetId={transaction.id}
          emptyDescription="No activity recorded on this transaction yet."
        />
      </Suspense>
    </>
  );
}
