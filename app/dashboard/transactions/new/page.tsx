/**
 * Create-transaction page — admin-only.
 *
 * Server Component shell. Auth-gates admin only, fetches companies +
 * projects for the form's selects, and mounts `<TransactionForm />` in
 * create mode.
 *
 * @module app/dashboard/transactions/new/page
 */
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { asc } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { readSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { companies, projects } from "@/lib/db/schema";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/dashboard/page-header";
import { TransactionForm } from "@/components/transactions/transaction-form";

export const metadata: Metadata = {
  title: "Add transaction",
  description: "Record a new transaction in the ledger",
};

export default async function NewTransactionPage() {
  const session = await readSession();
  if (!session) redirect("/login");
  if (session.role !== "admin") redirect("/dashboard");

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
        title="Add transaction"
        subtitle="Record a new transaction in the ledger"
        actions={
          <Button asChild variant="outline">
            <Link href="/dashboard/transactions">
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back to transactions
            </Link>
          </Button>
        }
      />

      <Card className="overflow-visible p-6 sm:p-8">
        <TransactionForm
          companyOptions={companyOptions}
          projectOptions={projectOptions}
        />
      </Card>
    </>
  );
}
