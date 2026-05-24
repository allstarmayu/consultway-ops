/**
 * Dashboard home — landing page for /dashboard.
 *
 * Day 18 replaced the Day-1 placeholder with role-aware widgets. Three
 * layouts:
 *
 *   - admin  — KPI strip (4 stat cards) + projects-by-status +
 *              tenders-by-status + per-month transactions summary +
 *              recent activity.
 *   - staff  — Same as admin minus the transactions summary (the
 *              transactions module is admin-only forever).
 *   - company — Slimmed strip (own projects only) + own-slice recent
 *              activity.
 *
 * The aggregates are fetched in parallel inside the page's render pass —
 * cheap indexed `groupBy` queries that don't need their own Suspense
 * boundaries at Phase-1 scale. The recent-activity card stays inside
 * its own Suspense so its actor / target name resolution doesn't block
 * the KPI strip.
 *
 * @module app/dashboard/page
 */
import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import {
  Briefcase,
  Building2,
  FileText,
  ListChecks,
  PiggyBank,
  Receipt,
  Wallet,
} from "lucide-react";

import { readSession } from "@/lib/auth/session";
import { PageHeader } from "@/components/dashboard/page-header";
import {
  getCompanyCount,
  getPaidAndDueTotals,
  getProjectsByStatus,
  getTendersByStatus,
  getTotalProjectValue,
  getTransactionsSummaryThisMonth,
} from "@/lib/dashboard/aggregates";
import {
  formatInrCompact,
  formatRupeesFromPaise,
} from "@/lib/format/inr";
import {
  PROJECT_STATUS_OPTIONS,
  ProjectStatusBadge,
} from "@/app/dashboard/projects/_components/badges";
import { TenderStatusBadge } from "@/app/dashboard/tenders/_components/badges";
import type { ProjectStatus, TenderStatus } from "@/lib/db/schema";

import { KpiStatCard } from "./_components/kpi-stat-card";
import {
  StatusBreakdownCard,
  type StatusBreakdownItem,
} from "./_components/status-breakdown-card";
import { RecentActivityCard } from "./_components/recent-activity-card";
import { MonthTransactionsSummaryCard } from "./_components/month-transactions-summary-card";
import { TransactionsTrendCard } from "./_components/transactions-trend-card";
import {
  resolveTrendMonths,
  resolveTrendType,
} from "./_components/trend-filters";
import { ActivityFeedLoading } from "./_components/activity-feed-loading";

export const metadata: Metadata = {
  title: "Dashboard",
  description: "Operations overview",
};

const TENDER_STATUSES: TenderStatus[] = [
  "draft",
  "published",
  "closed",
  "awarded",
];

interface DashboardPageProps {
  /**
   * Next.js App Router 15+ — `searchParams` is a Promise. We read
   * `?trendMonths` and `?trendType` here to drive the
   * `TransactionsTrendCard` filters (URL-driven so the page stays a
   * Server Component).
   */
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function singleParam(
  v: string | string[] | undefined,
): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export default async function DashboardPage({
  searchParams,
}: DashboardPageProps) {
  const session = await readSession();
  if (!session) redirect("/login");

  // Resolve the trend-chart filter pair from the URL. Both default to
  // sensible values when absent / bogus (see resolveTrend* helpers).
  const params = await searchParams;
  const trendMonths = resolveTrendMonths(singleParam(params.trendMonths));
  const trendType = resolveTrendType(singleParam(params.trendType));

  const isAdmin = session.role === "admin";
  const isCompany = session.role === "company";

  // Per-role scope for the projects + tenders aggregates. The helpers
  // treat scope as a free arg — the page decides what scope to pass
  // based on session.role.
  const projectsScope = isCompany
    ? { companyId: session.companyId ?? undefined }
    : {};
  const tendersScope = isCompany
    ? { companyId: session.companyId ?? undefined }
    : {};

  // Admin/staff pull the new Day-25 cross-platform aggregates (company
  // count + financial rollups) alongside the existing breakdowns. The
  // financial helpers (`getTotalProjectValue`, `getPaidAndDueTotals`)
  // are admin-only at the function level — staff and company-role skip
  // them entirely.
  const [
    projectsResult,
    tendersResult,
    txMonthResult,
    companyCountResult,
    projectValueResult,
    paidDueResult,
  ] = await Promise.all([
    getProjectsByStatus(projectsScope),
    isCompany
      ? Promise.resolve({ ok: true as const, byStatus: emptyTendersByStatus() })
      : getTendersByStatus(tendersScope),
    isAdmin ? getTransactionsSummaryThisMonth() : Promise.resolve(null),
    !isCompany ? getCompanyCount() : Promise.resolve(null),
    isAdmin ? getTotalProjectValue() : Promise.resolve(null),
    isAdmin ? getPaidAndDueTotals() : Promise.resolve(null),
  ]);

  const projectsByStatus = projectsResult.ok
    ? projectsResult.byStatus
    : emptyProjectsByStatus();
  const tendersByStatus =
    !isCompany && tendersResult.ok
      ? tendersResult.byStatus
      : emptyTendersByStatus();

  const totalProjects = sumValues(projectsByStatus);
  const activeProjects = projectsByStatus.active;
  const completedProjects = projectsByStatus.completed;
  const totalTenders = sumValues(tendersByStatus);

  // KPI-strip-relevant figures, defaulted defensively so a failed
  // aggregate becomes a "0" card rather than a render error. The
  // structured logger inside the helpers captures the actual failure.
  const totalCompanies =
    companyCountResult && companyCountResult.ok ? companyCountResult.total : 0;
  const recentlyAddedCompanies =
    companyCountResult && companyCountResult.ok
      ? companyCountResult.recentlyAdded
      : 0;
  const totalProjectValueRupees =
    projectValueResult && projectValueResult.ok
      ? projectValueResult.totalRupees
      : 0;
  const paidPaise =
    paidDueResult && paidDueResult.ok ? paidDueResult.paidPaise : 0;
  const duePaise =
    paidDueResult && paidDueResult.ok ? paidDueResult.duePaise : 0;

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={`Operations overview — signed in as ${session.email}`}
      />

      {/* KPI strip. Density per pixel decreases moving down the page; the
          single-figure cards sit on top. The Day-25 refresh aligns the
          admin layout with the Figma mockup (Total Companies / Total
          Projects / Total Project Value / Amount Paid + Due). Staff
          and company variants stay slimmer — staff loses the financial
          cards (admin-only data); company-role keeps its own-slice
          shape. */}
      <section
        aria-label="At-a-glance metrics"
        className="mb-6 grid grid-cols-2 gap-4 sm:mb-8 lg:grid-cols-4"
      >
        {/* Total Companies — admin/staff only. Hint surfaces "+N this
            month" when recent additions are non-zero so the card carries
            momentum signal not just a static count. */}
        {!isCompany && (
          <KpiStatCard
            label="Total companies"
            value={String(totalCompanies)}
            hint={
              recentlyAddedCompanies > 0
                ? `+${recentlyAddedCompanies} in last 30 days`
                : undefined
            }
            icon={Building2}
            accent="primary"
          />
        )}

        {/* Projects — total for admin/staff, "your projects" for company. */}
        <KpiStatCard
          label={isCompany ? "Your projects" : "Total projects"}
          value={String(totalProjects)}
          hint={`${activeProjects} active · ${completedProjects} completed`}
          icon={Briefcase}
          accent={isCompany ? "primary" : undefined}
        />

        {/* Total Project Value — admin only. Sum of `projects.budgetInr`
            formatted compactly (Cr / L / rupees per scale). */}
        {isAdmin && (
          <KpiStatCard
            label="Total project value"
            value={
              totalProjectValueRupees > 0
                ? formatInrCompact(totalProjectValueRupees)
                : "—"
            }
            hint="Across all projects with stated budget"
            icon={PiggyBank}
            accent="accent"
          />
        )}

        {/* Amount Paid — admin only. The financial pair from Figma:
            paid total as the big figure, due total as the hint line. */}
        {isAdmin && (
          <KpiStatCard
            label="Amount paid"
            value={
              paidPaise > 0
                ? formatInrCompact(Math.floor(paidPaise / 100))
                : "—"
            }
            hint={
              duePaise > 0
                ? `${formatInrCompact(Math.floor(duePaise / 100))} due`
                : "Nothing outstanding"
            }
            icon={Wallet}
          />
        )}

        {/* Staff (no financial KPIs) — fill the strip with the tenders
            count so the row doesn't collapse below 3 columns. */}
        {!isAdmin && !isCompany && (
          <KpiStatCard
            label="Total tenders"
            value={String(totalTenders)}
            hint={`${tendersByStatus.published} live · ${tendersByStatus.draft} draft`}
            icon={FileText}
            accent="accent"
          />
        )}

        {/* Company-role keeps its slimmer view: active count + completed. */}
        {isCompany && (
          <KpiStatCard
            label="Active"
            value={String(activeProjects)}
            hint={`${completedProjects} completed`}
            icon={ListChecks}
          />
        )}
        {isCompany && (
          <KpiStatCard
            label="Completed"
            value={String(completedProjects)}
            icon={Wallet}
            accent="accent"
          />
        )}

        {/* Transactions-this-month card moves to a second strip-row on
            wider screens for admin (since the first row is full at 4
            cards). For staff it slots into the dropped admin position. */}
        {!isAdmin && txMonthResult && txMonthResult.ok && (
          <KpiStatCard
            label="Transactions this month"
            value={formatRupeesFromPaise(txMonthResult.totalPaise)}
            hint={`${txMonthResult.totalCount} ${
              txMonthResult.totalCount === 1 ? "entry" : "entries"
            }`}
            icon={Receipt}
            accent="primary"
          />
        )}
      </section>

      {/* Admin gets a 5th KPI on its own line — Transactions this month
          sits below the main strip so the financial KPIs above stay
          legible at a 4-column width. */}
      {isAdmin && txMonthResult && txMonthResult.ok && (
        <section
          aria-label="This month's transactions"
          className="mb-6 grid grid-cols-1 gap-4 sm:mb-8 sm:grid-cols-2 lg:grid-cols-4"
        >
          <KpiStatCard
            label="Transactions this month"
            value={formatRupeesFromPaise(txMonthResult.totalPaise)}
            hint={`${txMonthResult.totalCount} ${
              txMonthResult.totalCount === 1 ? "entry" : "entries"
            }`}
            icon={Receipt}
            accent="primary"
          />
          <KpiStatCard
            label="Total tenders"
            value={String(totalTenders)}
            hint={`${tendersByStatus.published} live · ${tendersByStatus.draft} draft`}
            icon={FileText}
            accent="accent"
          />
        </section>
      )}

      {/* Status breakdown cards. Two side-by-side on lg+ for admin/staff;
          one solo card for company-role (no tenders publishing today). */}
      {!isCompany ? (
        <section
          aria-label="Status breakdowns"
          className="mb-6 grid gap-4 sm:mb-8 lg:grid-cols-2"
        >
          <StatusBreakdownCard
            title="Projects by status"
            icon={Briefcase}
            totalLabel={`${totalProjects} total`}
            items={buildProjectItems(projectsByStatus)}
            donut
          />
          <StatusBreakdownCard
            title="Tenders by status"
            icon={FileText}
            totalLabel={`${totalTenders} total`}
            items={buildTenderItems(tendersByStatus)}
            donut
          />
        </section>
      ) : (
        <section
          aria-label="Status breakdowns"
          className="mb-6 grid gap-4 sm:mb-8"
        >
          <StatusBreakdownCard
            title="Your projects by status"
            icon={Briefcase}
            totalLabel={`${totalProjects} total`}
            items={buildProjectItems(projectsByStatus)}
            donut
          />
        </section>
      )}

      {/* Admin-only 12-month transactions trend (Day 24). Sits above
          the per-month breakdown so the rolling chart sets the
          narrative ("here's what activity has looked like") before
          the current-month detail ("and here's what's happening now").
          Both are admin-only — transactions are admin-only forever. */}
      {isAdmin && (
        <section
          aria-label="Transactions trend"
          className="mb-6 sm:mb-8"
        >
          <TransactionsTrendCard months={trendMonths} type={trendType} />
        </section>
      )}

      {/* Admin-only per-month transactions summary card. */}
      {isAdmin && (
        <section
          aria-label="Transactions this month"
          className="mb-6 sm:mb-8"
        >
          <MonthTransactionsSummaryCard />
        </section>
      )}

      {/* Recent activity — wrapped in its own Suspense because the
          actor / target name resolution does its own batched lookups. */}
      <section aria-label="Recent activity">
        <Suspense fallback={<ActivityFeedLoading />}>
          <RecentActivityCard limit={10} />
        </Suspense>
      </section>
    </>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function sumValues(record: Record<string, number>): number {
  let total = 0;
  for (const v of Object.values(record)) total += v;
  return total;
}

function emptyProjectsByStatus(): Record<ProjectStatus, number> {
  return {
    planning: 0,
    active: 0,
    on_hold: 0,
    completed: 0,
    cancelled: 0,
  };
}

function emptyTendersByStatus(): Record<TenderStatus, number> {
  return { draft: 0, published: 0, closed: 0, awarded: 0 };
}

// Donut palette — pulls from the warm-ambient chart tokens defined in
// app/globals.css. Each status maps to one of `--chart-1..5` so the
// chart stays palette-aligned with any other recharts surface.
const PROJECT_STATUS_COLORS: Record<ProjectStatus, string> = {
  planning: "var(--color-chart-3)",   // Driftwood — neutral / not yet started
  active: "var(--color-chart-1)",     // Terracotta — primary, in motion
  on_hold: "var(--color-chart-2)",    // Walnut — paused
  completed: "var(--color-chart-4)",  // Espresso — done
  cancelled: "var(--color-destructive)",
};

const TENDER_STATUS_COLORS: Record<TenderStatus, string> = {
  draft: "var(--color-chart-5)",       // Linen — quietest, unpublished
  published: "var(--color-chart-1)",   // Terracotta — live
  closed: "var(--color-chart-3)",      // Driftwood — wrapped
  awarded: "var(--color-chart-4)",     // Espresso — concluded
};

function buildProjectItems(
  byStatus: Record<ProjectStatus, number>,
): StatusBreakdownItem[] {
  return PROJECT_STATUS_OPTIONS.map((opt) => ({
    key: opt.value,
    badge: <ProjectStatusBadge status={opt.value} iconless />,
    count: byStatus[opt.value] ?? 0,
    href: `/dashboard/projects?status=${opt.value}`,
    color: PROJECT_STATUS_COLORS[opt.value],
    donutLabel: opt.label,
  }));
}

function buildTenderItems(
  byStatus: Record<TenderStatus, number>,
): StatusBreakdownItem[] {
  return TENDER_STATUSES.map((status) => ({
    key: status,
    badge: <TenderStatusBadge status={status} iconless />,
    count: byStatus[status] ?? 0,
    href: `/dashboard/tenders?status=${status}`,
    color: TENDER_STATUS_COLORS[status],
    donutLabel: status.charAt(0).toUpperCase() + status.slice(1),
  }));
}
