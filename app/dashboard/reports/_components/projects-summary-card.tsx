/**
 * ProjectsSummaryCard — per-status breakdown of projects CREATED inside
 * the report's selected period.
 *
 * Server Component. Reads from `getProjectsByStatusForPeriod` and
 * renders via the shared `StatusBreakdownCard` (with `donut={true}`)
 * so the reports page picks up the same chart vocabulary the
 * dashboard's breakdown cards use. Rows are static — no drill-through
 * `href` per item — because a click that left the report would lose
 * the period context.
 *
 * Empty period: when zero projects were created in the window, the
 * `StatusBreakdownCard` collapses to a "no slices" donut (returns
 * null) and the rows just show 0 / 0 / 0 / 0 / 0.
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
import type { ProjectStatus } from "@/lib/db/schema";

import {
  StatusBreakdownCard,
  type StatusBreakdownItem,
} from "@/app/dashboard/_components/status-breakdown-card";

/**
 * Status → donut colour map. Same palette as the dashboard so the two
 * cards stay visually aligned. Pulls from the warm-ambient chart
 * tokens defined in app/globals.css.
 */
const PROJECT_STATUS_COLORS: Record<ProjectStatus, string> = {
  planning: "var(--color-chart-3)",
  active: "var(--color-chart-1)",
  on_hold: "var(--color-chart-2)",
  completed: "var(--color-chart-4)",
  cancelled: "var(--color-destructive)",
};

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
      <Card className="interactive-card p-4">
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

  const items: StatusBreakdownItem[] = PROJECT_STATUS_OPTIONS.map((opt) => ({
    key: opt.value,
    badge: <ProjectStatusBadge status={opt.value} iconless />,
    count: result.byStatus[opt.value] ?? 0,
    color: PROJECT_STATUS_COLORS[opt.value],
    donutLabel: opt.label,
    // No href — static rows on the reports page.
  }));

  return (
    <StatusBreakdownCard
      title="Projects created"
      icon={Briefcase}
      totalLabel={`${total} total`}
      items={items}
      donut
    />
  );
}
