/**
 * TendersSummaryCard — per-status breakdown of tenders PUBLISHED inside
 * the report's selected period.
 *
 * Server Component. Reads from `getTendersByStatusForPeriod` (filters
 * on `publishedAt`, not `createdAt` — drafts that never publish don't
 * belong to any period's "what went to market" view, see the
 * helper's docstring). Renders via the shared `StatusBreakdownCard`
 * (with `donut={true}`) for visual parity with the dashboard.
 *
 * @module app/dashboard/reports/_components/tenders-summary-card
 */
import { FileText } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { getTendersByStatusForPeriod } from "@/lib/dashboard/aggregates";
import { TenderStatusBadge } from "@/app/dashboard/tenders/_components/badges";
import type { TenderStatus } from "@/lib/db/schema";

import {
  StatusBreakdownCard,
  type StatusBreakdownItem,
} from "@/app/dashboard/_components/status-breakdown-card";

// Order of display — matches the dashboard's tender breakdown card.
const TENDER_STATUSES: TenderStatus[] = [
  "draft",
  "published",
  "closed",
  "awarded",
];

const TENDER_STATUS_COLORS: Record<TenderStatus, string> = {
  draft: "var(--color-chart-5)",
  published: "var(--color-chart-1)",
  closed: "var(--color-chart-3)",
  awarded: "var(--color-chart-4)",
};

export interface TendersSummaryCardProps {
  start: string;
  end: string;
  companyId?: string;
}

export async function TendersSummaryCard({
  start,
  end,
  companyId,
}: TendersSummaryCardProps) {
  const result = await getTendersByStatusForPeriod({
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

  const total = TENDER_STATUSES.reduce(
    (sum, s) => sum + (result.byStatus[s] ?? 0),
    0,
  );

  const items: StatusBreakdownItem[] = TENDER_STATUSES.map((status) => ({
    key: status,
    badge: <TenderStatusBadge status={status} iconless />,
    count: result.byStatus[status] ?? 0,
    color: TENDER_STATUS_COLORS[status],
    donutLabel: status.charAt(0).toUpperCase() + status.slice(1),
    // No href — static rows on the reports page.
  }));

  return (
    <StatusBreakdownCard
      title="Tenders published"
      icon={FileText}
      totalLabel={`${total} total`}
      items={items}
      donut
    />
  );
}
