/**
 * Edit-project page.
 *
 * Server Component shell. Two access modes share one form:
 *
 *   - admin / staff      → full edit (every field except companyId)
 *   - company role (own) → description-only edit; form disables every
 *                          other input, server-side action enforces too
 *
 * Company-role users on someone else's project are redirected back to
 * the projects list — the `getProject` row-scope already returned
 * "not found" for the listing query so they couldn't have arrived
 * here through normal navigation anyway.
 *
 * @module app/dashboard/projects/[id]/edit/page
 */
import type { Metadata } from "next";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { asc } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { getProject } from "@/lib/projects/actions";
import { readSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/dashboard/page-header";
import { ProjectForm } from "@/components/projects/project-form";

export const metadata: Metadata = {
  title: "Edit project",
  description: "Update project details",
};

interface EditProjectPageProps {
  params: Promise<{ id: string }>;
}

export default async function EditProjectPage({
  params,
}: EditProjectPageProps) {
  // 1. Auth gate.
  const [{ id }, session] = await Promise.all([params, readSession()]);
  if (!session) redirect("/login");

  // 2. Fetch the project. `getProject` enforces row-level scope so a
  //    company-role user reaching a foreign project gets "not found".
  const result = await getProject(id);
  if (!result.ok) {
    notFound();
  }
  const project = result.project;

  // 3. Determine field mode.
  //    - admin / staff           → "full"
  //    - company role on own row → "description-only" (the form gates
  //      every other input; the action enforces the same gate)
  const isStaff = session.role === "admin" || session.role === "staff";
  const isOwnProject =
    session.role === "company" && session.companyId === project.companyId;
  if (!isStaff && !isOwnProject) {
    // Shouldn't happen — getProject already gates. Defensive redirect.
    redirect(`/dashboard/projects/${id}`);
  }
  const fieldMode = isStaff ? "full" : "description-only";

  // 4. Companies list for the (disabled-in-edit-mode) owning-company
  //    select. Same shape the create page uses; passing [] would work
  //    but it makes the form's prop signature feel surprising.
  const companyOptions = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .orderBy(asc(companies.name));

  return (
    <>
      <PageHeader
        title="Edit project"
        subtitle={project.name}
        actions={
          <Button asChild variant="outline">
            <Link href={`/dashboard/projects/${project.id}`}>
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back to project
            </Link>
          </Button>
        }
      />

      <Card className="overflow-visible p-6 sm:p-8">
        <ProjectForm
          companyOptions={companyOptions}
          initialValues={project}
          fieldMode={fieldMode}
        />
      </Card>
    </>
  );
}
