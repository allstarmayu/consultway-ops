/**
 * CompanyRollupBanner — strip shown above the transactions table when
 * the list page is filtered to a single company.
 *
 * Server Component. Mounted only when the URL has `?companyId=<id>` —
 * the absence of a filter means there's no single rollup that the
 * banner could summarise, so the banner is omitted entirely.
 *
 * Pulls `getCompanyRollup(companyId)` and renders the grand total + the
 * 5 per-type figures as small mono cells. Gives an admin scoped to one
 * company a "you're looking at Acme's book" header without forcing
 * them to scroll to find the totals.
 *
 * @module app/dashboard/transactions/_components/company-rollup-banner
 */
import { getCompanyRollup } from "@/lib/transactions/rollups";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { formatRupeesFromPaise } from "@/lib/format/inr";
import { TransactionTypeBadge } from "./badges";
import type { TransactionType } from "@/lib/db/schema";

export interface CompanyRollupBannerProps {
  companyId: string;
  /**
   * The pre-resolved company name. The transactions page already loads
   * the company list for the filter dropdown — pass the matching name
   * here so the banner doesn't issue its own lookup.
   */
  companyName: string | null;
}

export async function CompanyRollupBanner({
  companyId,
  companyName,
}: CompanyRollupBannerProps) {
  const result = await getCompanyRollup(companyId);

  if (!result.ok) {
    return (
      <Card className="mb-4 p-4">
        <Alert variant="destructive">
          <AlertDescription>{result.error}</AlertDescription>
        </Alert>
      </Card>
    );
  }

  const rollup = result.rollup;
  const types = Object.keys(rollup.byType) as TransactionType[];

  return (
    <Card className="mb-4 overflow-hidden p-0">
      <header className="flex items-center justify-between border-b border-border bg-card p-3">
        <div className="flex items-baseline gap-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Filtered by company
          </p>
          <p className="text-sm font-medium text-foreground">
            {companyName ?? "Selected company"}
          </p>
        </div>
        <p className="font-mono text-sm tabular-nums text-foreground">
          {formatRupeesFromPaise(rollup.totalPaise)}{" "}
          <span className="text-xs text-muted-foreground">
            ({rollup.totalCount}{" "}
            {rollup.totalCount === 1 ? "entry" : "entries"} all-time)
          </span>
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3 lg:grid-cols-5">
        {types.map((t) => (
          <div key={t} className="space-y-1">
            <TransactionTypeBadge type={t} iconless />
            <p className="font-mono text-xs tabular-nums text-muted-foreground">
              {formatRupeesFromPaise(rollup.byType[t].totalPaise)}{" "}
              <span className="text-muted-foreground/70">
                · {rollup.byType[t].count}
              </span>
            </p>
          </div>
        ))}
      </div>
    </Card>
  );
}
