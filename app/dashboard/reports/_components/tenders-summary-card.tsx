/**
 * TendersSummaryCard — per-status breakdown of tenders PUBLISHED inside
 * the report's selected period.
 *
 * Server Component. Reads from `getTendersByStatusForPeriod`. Note the
 * helper filters on `publishedAt`, not `createdAt` — drafts that never
 * publish don't belong to any period's "what went to market" view. See
 * the helper's docstring for the full rationale.
 *
 * Empty period: when no tenders were published in the window, the card
 * renders a friendly "No tenders published in this period." in place of
 * the rows.
 *
 * @module app/dashboard/reports/_components/tenders-summary-card
 */
import { FileText } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { getTendersByStatusForPeriod } from "@/lib/dashboard/aggregates";
import { TenderStatusBadge } from "@/app/dashboard/tenders/_components/badges";
import type { TenderStatus } from "@/lib/db/schema";

// Order of display — matches the dashboard's tender breakdown card.
const TENDER_STATUSES: TenderStatus[] = [
  "draft",
  "published",
  "closed",
  "awarded",
];

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
      <Card className="p-4">
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

  return (
    <Card className="overflow-hidden p-0">
      <header className="flex items-center justify-between border-b border-border bg-card p-4">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" aria-hidden />
          <h2 className="text-base font-semibold text-foreground">
            Tenders published
          </h2>
        </div>
        <span className="text-xs text-muted-foreground">{total} total</span>
      </header>

      {total === 0 ? (
        <p className="p-6 text-sm italic text-muted-foreground">
          No tenders published in this period.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {TENDER_STATUSES.map((status) => {
            const count = result.byStatus[status] ?? 0;
            return (
              <li
                key={status}
                className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
              >
                <span className="shrink-0">
                  <TenderStatusBadge status={status} iconless />
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
