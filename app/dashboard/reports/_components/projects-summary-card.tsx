/**
 * ProjectsSummaryCard — per-status breakdown of projects CREATED inside
 * the report's selected period.
 *
 * Server Component. Reads from `getProjectsByStatusForPeriod`. Same
 * visual chrome as the Day-18 `StatusBreakdownCard` but the rows are
 * static (no drill-through links) — the figures pivot the report, not a
 * deeper navigation, and a click that left the report and lost the
 * period would feel jarring.
 *
 * Empty period: when zero projects were created in the window, the card
 * renders a friendly "No projects created in this period." in place of
 * the rows.
 *
 * @module app/dashboard/reports/_components/projects-summary-card
 */
import { Briefcase } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { getProjectsByStatusForPeriod } from "@/lib/dashboard/aggregates";
import {
  PROJECT_STATUS_OPTIONS,
  ProjectStatusBadge,
} from "@/app/dashboard/projects/_components/badges";

export interface ProjectsSummaryCardProps {
  start: string;
  end: string;
  companyId?: string;
}

export async function ProjectsSummaryCard({
  start,
  end,
  companyId,
}: ProjectsSummaryCardProps) {
  const result = await getProjectsByStatusForPeriod({
    start,
    end,
    ...(companyId ? { companyId } : {}),
  });

  if (!result.ok) {
    return (
      <Card className="p-4">
        <Alert variant="destructive">
          <AlertDescription>{result.error}</AlertDescription>
        </Alert>
      </Card>
    );
  }

  const total = PROJECT_STATUS_OPTIONS.reduce(
    (sum, opt) => sum + (result.byStatus[opt.value] ?? 0),
    0,
  );

  return (
    <Card className="overflow-hidden p-0">
      <header className="flex items-center justify-between border-b border-border bg-card p-4">
        <div className="flex items-center gap-2">
          <Briefcase className="h-4 w-4 text-muted-foreground" aria-hidden />
          <h2 className="text-base font-semibold text-foreground">
            Projects created
          </h2>
        </div>
        <span className="text-xs text-muted-foreground">{total} total</span>
      </header>

      {total === 0 ? (
        <p className="p-6 text-sm italic text-muted-foreground">
          No projects created in this period.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {PROJECT_STATUS_OPTIONS.map((opt) => {
            const count = result.byStatus[opt.value] ?? 0;
            return (
              <li
                key={opt.value}
                className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
              >
                <span className="shrink-0">
                  <ProjectStatusBadge status={opt.value} iconless />
                </span>
                <span className="font-mono text-base tabular-nums text-foreground">
                  {count}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
