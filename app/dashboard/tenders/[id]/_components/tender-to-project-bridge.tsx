/**
 * Tender → Project bridge.
 *
 * Renders one of two surfaces on an awarded tender:
 *
 *   - When no project is yet linked: a "Create project from this tender"
 *     button (admin/staff only). On click, calls
 *     `createProjectFromTender`, then redirects to the new project's
 *     detail page.
 *
 *   - When a project IS already linked: a "View linked project" link
 *     to that project's detail page.
 *
 * Both branches surface only inside the awarded-tender card; the
 * parent only mounts this component for `tender.status === "awarded"`.
 *
 * Client Component because the create branch uses a server-action
 * call + `useTransition`. Both branches could be plain anchor links
 * via Server Components, but the bridge action's success/error UX
 * benefits from inline feedback.
 *
 * @module app/dashboard/tenders/[id]/_components/tender-to-project-bridge
 */
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertCircle, ArrowRight, Briefcase } from "lucide-react";
import { createProjectFromTender } from "@/lib/projects/actions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export interface TenderToProjectBridgeProps {
  tenderId: string;
  /**
   * The existing project id when one is already linked, or null when
   * none is. Computed server-side via
   * `projectExistsByTenderId(tenderId)` and passed down.
   */
  existingProjectId: string | null;
  /**
   * Whether the current viewer is admin or staff. Only staff can
   * create projects from tenders; a company-role viewer on an
   * awarded tender they applied to sees nothing here (the bridge
   * is staff-driven).
   */
  canCreate: boolean;
}

export function TenderToProjectBridge({
  tenderId,
  existingProjectId,
  canCreate,
}: TenderToProjectBridgeProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Already linked → "View linked project" surface for everyone.
  if (existingProjectId) {
    return (
      <Card className="mt-4 flex flex-col items-start gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10">
            <Briefcase className="h-4 w-4 text-primary" aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              Project created from this tender
            </p>
            <p className="text-xs text-muted-foreground">
              Open the linked project for status, schedule, and budget.
            </p>
          </div>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href={`/dashboard/projects/${existingProjectId}`}>
            View linked project
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </Button>
      </Card>
    );
  }

  // Not linked yet → staff get the create button; everyone else sees
  // nothing (a company-role viewer doesn't drive project creation).
  if (!canCreate) {
    return null;
  }

  function handleCreate() {
    setError(null);
    startTransition(async () => {
      const result = await createProjectFromTender({ tenderId });
      if (!result.ok) {
        setError(result.error ?? "Could not create project");
        return;
      }
      router.push(`/dashboard/projects/${result.projectId}`);
    });
  }

  return (
    <Card className="mt-4 flex flex-col items-start gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
          <Briefcase className="h-4 w-4 text-muted-foreground" aria-hidden />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            Start the project
          </p>
          <p className="text-xs text-muted-foreground">
            Create a new project record tied to this awarded tender.
          </p>
        </div>
      </div>
      <div className="flex flex-col items-start gap-2 sm:items-end">
        <Button onClick={handleCreate} disabled={isPending} size="sm">
          {isPending ? "Creating..." : "Create project from this tender"}
        </Button>
        {error && (
          <Alert variant="destructive" className="w-full sm:max-w-sm">
            <AlertCircle className="h-4 w-4" aria-hidden />
            <AlertTitle>Could not create project</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
    </Card>
  );
}
