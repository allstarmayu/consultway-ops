/**
 * Project detail page.
 *
 * Server Component. Loads the project + its owning company + (when
 * applicable) the linked tender's title, then composes:
 *
 *   - ProjectHeader     — title, status badge, role-gated transition
 *                         buttons (Activate / Pause / Complete / Cancel)
 *                         and the Edit button.
 *   - ProjectOverview   — four cards (Identity, Schedule, Budget,
 *                         Internal Notes). Internal Notes hidden for
 *                         company-role viewers.
 *   - EntityHistory     — audit-log feed for this project. Wrapped in
 *                         <Suspense> so its DB queries don't block the
 *                         above content.
 *
 * Access control:
 *   - admin / staff    → full visibility
 *   - company role     → can see own projects only; foreign projects
 *                        return "not found" (action sanitises)
 *
 * @module app/dashboard/projects/[id]/page
 */
import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { eq } from "drizzle-orm";
import { getProject } from "@/lib/projects/actions";
import { readSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { companies, tenders } from "@/lib/db/schema";
import { Button } from "@/components/ui/button";
import { EntityHistory } from "@/components/audit/entity-history";
import { EntityHistoryLoading } from "@/components/audit/entity-history-loading";
import { ProjectHeader } from "./_components/project-header";
import { ProjectOverview } from "./_components/project-overview";
import { ProjectRollupCard } from "./_components/project-rollup-card";

export const metadata: Metadata = {
  title: "Project",
  description: "Project details and history",
};

interface ProjectDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function ProjectDetailPage({
  params,
}: ProjectDetailPageProps) {
  const [{ id }, session] = await Promise.all([params, readSession()]);
  if (!session) redirect("/login");

  // 1. Load the project (action handles row-scope + internalNotes strip).
  const result = await getProject(id);
  if (!result.ok) {
    notFound();
  }
  const project = result.project;

  // 2. Resolve the owning company + (optional) linked tender in parallel.
  const [companyRow, linkedTender] = await Promise.all([
    db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(eq(companies.id, project.companyId))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    project.tenderId
      ? db
          .select({ id: tenders.id, title: tenders.title })
          .from(tenders)
          .where(eq(tenders.id, project.tenderId))
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
  ]);

  // FK is NOT NULL so company must exist. Defensive — surface a 404
  // rather than crashing on a null deref.
  if (!companyRow) {
    notFound();
  }

  // 3. Role-derived flags.
  const canManage = session.role === "admin" || session.role === "staff";
  const canEdit =
    canManage ||
    (session.role === "company" && session.companyId === project.companyId);

  return (
    <>
      <div className="mb-4">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/dashboard/projects">
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Back to projects
          </Link>
        </Button>
      </div>

      <ProjectHeader project={project} canManage={canManage} canEdit={canEdit} />

      <ProjectOverview
        project={project}
        company={companyRow}
        linkedTender={linkedTender}
        showInternalNotes={canManage}
      />

      {/* Admin-only: financial rollup card. Staff and company-role
          viewers don't see it at all — transactions are admin-only. */}
      {session.role === "admin" && (
        <Suspense fallback={null}>
          <ProjectRollupCard projectId={project.id} />
        </Suspense>
      )}

      <Suspense fallback={<EntityHistoryLoading />}>
        <EntityHistory
          targetType="project"
          targetId={project.id}
          emptyDescription="No activity recorded on this project yet."
        />
      </Suspense>
    </>
  );
}
