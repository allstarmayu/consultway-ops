/**
 * Create-project page.
 *
 * Server Component shell. Three responsibilities:
 *
 *   1. Auth gate: admin and staff only. Company-role users are
 *      redirected to the projects list (they don't create projects;
 *      Consultway runs the project list on their behalf).
 *
 *   2. Fetch the list of companies eligible to own a project. All
 *      registered companies are eligible.
 *
 *   3. Render the `<ProjectForm />` in create mode.
 *
 * @module app/dashboard/projects/new/page
 */
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { asc } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { readSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/dashboard/page-header";
import { ProjectForm } from "@/components/projects/project-form";

export const metadata: Metadata = {
  title: "Add project",
  description: "Create a new project record",
};

export default async function NewProjectPage() {
  // 1. Auth gate.
  const session = await readSession();
  if (!session) redirect("/login");
  if (session.role !== "admin" && session.role !== "staff") {
    redirect("/dashboard/projects");
  }

  // 2. Fetch companies for the owning-company dropdown.
  const companyOptions = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .orderBy(asc(companies.name));

  return (
    <>
      <PageHeader
        title="Add project"
        subtitle="Create a new project record"
        actions={
          <Button asChild variant="outline">
            <Link href="/dashboard/projects">
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back to projects
            </Link>
          </Button>
        }
      />

      <Card className="overflow-visible p-6 sm:p-8">
        <ProjectForm companyOptions={companyOptions} fieldMode="full" />
      </Card>
    </>
  );
}
