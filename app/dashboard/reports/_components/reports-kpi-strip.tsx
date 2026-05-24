/**
 * ReportsKpiStrip — Day-25 KPI row at the top of the reports page.
 *
 * Server Component. Fetches three period-bounded aggregates in
 * parallel and renders the headline figures as KPI cards using the
 * same primitive the dashboard uses. Same visual vocabulary so the
 * two pages read as siblings.
 *
 * Layout:
 *   - admin: 4 cards (Projects created / Tenders published / Total
 *     transactions value / Transactions count)
 *   - staff: 2 cards (Projects created / Tenders published) —
 *     transactions are admin-only forever.
 *
 * @module app/dashboard/reports/_components/reports-kpi-strip
 */
import {
  Briefcase,
  FileText,
  Receipt,
  Wallet,
} from "lucide-react";

import {
  getProjectsByStatusForPeriod,
  getTendersByStatusForPeriod,
  getTransactionsSummaryForPeriod,
} from "@/lib/dashboard/aggregates";
import { formatInrCompact } from "@/lib/format/inr";

import { KpiStatCard } from "@/app/dashboard/_components/kpi-stat-card";

export interface ReportsKpiStripProps {
  start: string;
  end: string;
  companyId?: string;
  isAdmin: boolean;
}

export async function ReportsKpiStrip({
  start,
  end,
  companyId,
  isAdmin,
}: ReportsKpiStripProps) {
  // Period scope echoed to every aggregate. Each returns its own
  // shape; we defensively zero-fill on failure so a single broken
  // aggregate doesn't crash the strip.
  const scope = companyId ? { start, end, companyId } : { start, end };

  const [projectsRes, tendersRes, txRes] = await Promise.all([
    getProjectsByStatusForPeriod(scope),
    getTendersByStatusForPeriod(scope),
    isAdmin
      ? getTransactionsSummaryForPeriod(scope)
      : Promise.resolve(null),
  ]);

  const projectsCount = projectsRes.ok
    ? sumStatusBuckets(projectsRes.byStatus)
    : 0;
  const tendersCount = tendersRes.ok
    ? sumStatusBuckets(tendersRes.byStatus)
    : 0;
  const txTotalPaise = txRes && txRes.ok ? txRes.totalPaise : 0;
  const txTotalCount = txRes && txRes.ok ? txRes.totalCount : 0;

  return (
    <section
      aria-label="Period at-a-glance"
      className="stagger-children mb-6 grid grid-cols-2 gap-4 sm:mb-8 lg:grid-cols-4"
    >
      <KpiStatCard
        label="Projects created"
        value={String(projectsCount)}
        hint={projectsCount === 1 ? "in this period" : "in this period"}
        icon={Briefcase}
        accent="primary"
      />
      <KpiStatCard
        label="Tenders published"
        value={String(tendersCount)}
        hint="in this period"
        icon={FileText}
        accent="accent"
      />
      {isAdmin && (
        <KpiStatCard
          label="Transactions value"
          value={
            txTotalPaise > 0
              ? formatInrCompact(Math.floor(txTotalPaise / 100))
              : "—"
          }
          hint={`${txTotalCount} ${
            txTotalCount === 1 ? "entry" : "entries"
          }`}
          icon={Wallet}
        />
      )}
      {isAdmin && (
        <KpiStatCard
          label="Transactions count"
          value={String(txTotalCount)}
          hint={txTotalPaise > 0 ? "see breakdown below" : "no activity"}
          icon={Receipt}
          accent="primary"
        />
      )}
    </section>
  );
}

function sumStatusBuckets(byStatus: Record<string, number>): number {
  let total = 0;
  for (const v of Object.values(byStatus)) total += v;
  return total;
}
