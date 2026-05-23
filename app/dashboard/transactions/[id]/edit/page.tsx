/**
 * Edit-transaction page — admin-only.
 *
 * Server Component shell. Auth-gates admin only, loads the transaction
 * via `getTransaction`, fetches companies + projects for the form's
 * selects, and mounts `<TransactionForm initialValues={...} />` in
 * edit mode.
 *
 * @module app/dashboard/transactions/[id]/edit/page
 */
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { asc } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { readSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { companies, projects } from "@/lib/db/schema";
import { getTransaction } from "@/lib/transactions/actions";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/dashboard/page-header";
import { TransactionForm } from "@/components/transactions/transaction-form";

export const metadata: Metadata = {
  title: "Edit transaction",
  description: "Edit a recorded transaction",
};

interface EditTransactionPageProps {
  params: Promise<{ id: string }>;
}

export default async function EditTransactionPage({
  params,
}: EditTransactionPageProps) {
  const [{ id }, session] = await Promise.all([params, readSession()]);
  if (!session) redirect("/login");
  if (session.role !== "admin") redirect("/dashboard");

  const result = await getTransaction(id);
  if (!result.ok) notFound();

  const [companyOptions, projectOptions] = await Promise.all([
    db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .orderBy(asc(companies.name)),
    db
      .select({
        id: projects.id,
        name: projects.name,
        companyId: projects.companyId,
      })
      .from(projects)
      .orderBy(asc(projects.name)),
  ]);

  return (
    <>
      <PageHeader
        title="Edit transaction"
        subtitle="Update a recorded transaction"
        actions={
          <Button asChild variant="outline">
            <Link href={`/dashboard/transactions/${id}`}>
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back to transaction
            </Link>
          </Button>
        }
      />

      <Card className="overflow-visible p-6 sm:p-8">
        <TransactionForm
          companyOptions={companyOptions}
          projectOptions={projectOptions}
          initialValues={result.transaction}
        />
      </Card>
    </>
  );
}
