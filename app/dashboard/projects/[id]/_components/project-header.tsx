/**
 * Project detail header — title, status badge, and the role-gated set
 * of action buttons (status transitions, edit).
 *
 * Client Component because each transition button calls a Server
 * Action via `useTransition` and shows pending UI. Errors surface in
 * an inline `<Alert>` below the header strip.
 *
 * Visible buttons (admin/staff):
 *   - planning → Activate, Cancel, Edit
 *   - active   → Pause, Complete, Cancel, Edit
 *   - on_hold  → Resume, Cancel, Edit
 *   - completed → Edit (notes/description only)
 *   - cancelled → Edit (notes only)
 *
 * Visible buttons (company role on own project):
 *   - Edit (description-only — the form is what enforces the field gate)
 *
 * `Cancel` is wrapped in a `<ConfirmDialog>` with an optional reason
 * textarea — it's the highest-stakes transition (terminal) so we ask
 * for one, but don't require it.
 *
 * `Complete` is also wrapped in a `<ConfirmDialog>` (no reason) — also
 * terminal and not normally reversed.
 *
 * `Activate`, `Pause`, `Resume` are one-click — recoverable by moving
 * back through their inverse.
 *
 * @module app/dashboard/projects/[id]/_components/project-header
 */
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  AlertCircle,
  CheckCircle2,
  Pencil,
  PauseCircle,
  Play,
  XCircle,
} from "lucide-react";
import { transitionProjectStatus } from "@/lib/projects/actions";
import type { Project, ProjectStatus } from "@/lib/db/schema";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ProjectStatusBadge } from "../../_components/badges";

// ── Props ─────────────────────────────────────────────────────────────────

export interface ProjectHeaderProps {
  project: Project;
  /** True when the viewer is admin or staff. Drives transition-button visibility. */
  canManage: boolean;
  /**
   * True when the viewer is allowed to reach the edit page. Staff/admin
   * always; a company-role viewer on their own project also gets the
   * link (the form enforces the description-only field gate).
   */
  canEdit: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────

export function ProjectHeader({
  project,
  canManage,
  canEdit,
}: ProjectHeaderProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function runTransition(label: string, toStatus: ProjectStatus, reason?: string) {
    setError(null);
    startTransition(async () => {
      const result = await transitionProjectStatus({
        projectId: project.id,
        toStatus,
        ...(reason ? { reason } : {}),
      });
      if (!result.ok) {
        setError(result.error ?? `Could not ${label.toLowerCase()}`);
        return;
      }
      router.refresh();
    });
  }

  // ── Computed flags — driven by the state machine table ─────────────────
  const canActivate =
    canManage && (project.status === "planning" || project.status === "on_hold");
  const canPause = canManage && project.status === "active";
  const canComplete = canManage && project.status === "active";
  // Cancel reachable from any non-terminal state.
  const canCancel =
    canManage &&
    project.status !== "completed" &&
    project.status !== "cancelled";

  // Activate vs Resume label depends on current status — same action,
  // different UX text.
  const activateLabel = project.status === "on_hold" ? "Resume" : "Activate";

  return (
    <>
      <header className="mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            {project.name}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <ProjectStatusBadge status={project.status} />
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {canActivate && (
            <Button
              onClick={() => runTransition(activateLabel, "active")}
              disabled={isPending}
              aria-label={`${activateLabel} project`}
            >
              <Play className="h-4 w-4" aria-hidden />
              {activateLabel}
            </Button>
          )}

          {canPause && (
            <Button
              variant="outline"
              onClick={() => runTransition("pause", "on_hold")}
              disabled={isPending}
              aria-label="Pause project"
            >
              <PauseCircle className="h-4 w-4" aria-hidden />
              Pause
            </Button>
          )}

          {canComplete && (
            <ConfirmDialog
              trigger={
                <Button
                  variant="outline"
                  disabled={isPending}
                  aria-label="Mark project as completed"
                >
                  <CheckCircle2 className="h-4 w-4" aria-hidden />
                  Complete
                </Button>
              }
              title={`Mark "${project.name}" as completed?`}
              description="Completed projects can't be reopened — they stay terminal. Edit notes / description afterwards if needed."
              confirmLabel="Mark completed"
              confirmVariant="default"
              onConfirm={() => runTransition("complete", "completed")}
              pending={isPending}
            />
          )}

          {canCancel && (
            <ConfirmDialog
              trigger={
                <Button
                  variant="outline"
                  disabled={isPending}
                  aria-label="Cancel project"
                  className="border-destructive/40 text-destructive hover:bg-destructive/10"
                >
                  <XCircle className="h-4 w-4" aria-hidden />
                  Cancel
                </Button>
              }
              title={`Cancel "${project.name}"?`}
              description="Cancelled projects are terminal. Provide a reason for the audit trail if helpful."
              confirmLabel="Cancel project"
              confirmVariant="destructive"
              reasonField="optional"
              reasonLabel="Reason (optional)"
              reasonPlaceholder="e.g. Client put the engagement on indefinite hold"
              onConfirm={(reason) => runTransition("cancel", "cancelled", reason)}
              pending={isPending}
            />
          )}

          {canEdit && (
            <Button
              asChild
              variant="outline"
              disabled={isPending}
              aria-label="Edit project"
            >
              <Link href={`/dashboard/projects/${project.id}/edit`}>
                <Pencil className="h-4 w-4" aria-hidden />
                Edit
              </Link>
            </Button>
          )}
        </div>
      </header>

      {error && (
        <Alert variant="destructive" className="mb-6">
          <AlertCircle className="h-4 w-4" aria-hidden />
          <AlertTitle>Action failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </>
  );
}
