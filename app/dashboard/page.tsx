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
  FileText,
  ListChecks,
  Receipt,
  Wallet,
} from "lucide-react";

import { readSession } from "@/lib/auth/session";
import { PageHeader } from "@/components/dashboard/page-header";
import {
  getProjectsByStatus,
  getTendersByStatus,
  getTransactionsSummaryThisMonth,
} from "@/lib/dashboard/aggregates";
import { formatRupeesFromPaise } from "@/lib/format/inr";
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

export default async function DashboardPage() {
  const session = await readSession();
  if (!session) redirect("/login");

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

  // Admin pulls the per-month transactions summary too; staff and
  // company-role skip it (transactions are admin-only forever).
  const [projectsResult, tendersResult, txMonthResult] = await Promise.all([
    getProjectsByStatus(projectsScope),
    isCompany
      ? Promise.resolve({ ok: true as const, byStatus: emptyTendersByStatus() })
      : getTendersByStatus(tendersScope),
    isAdmin ? getTransactionsSummaryThisMonth() : Promise.resolve(null),
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

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={`Operations overview — signed in as ${session.email}`}
      />

      {/* KPI strip. Density per pixel decreases moving down the page; the
          single-figure cards sit on top. */}
      <section
        aria-label="At-a-glance metrics"
        className="mb-6 grid grid-cols-2 gap-4 sm:mb-8 lg:grid-cols-4"
      >
        <KpiStatCard
          label={isCompany ? "Your projects" : "Total projects"}
          value={String(totalProjects)}
          icon={Briefcase}
          accent="primary"
        />
        <KpiStatCard
          label="Active projects"
          value={String(activeProjects)}
          hint={`${completedProjects} completed`}
          icon={ListChecks}
        />
        {!isCompany && (
          <KpiStatCard
            label="Total tenders"
            value={String(totalTenders)}
            hint={`${tendersByStatus.published} live, ${tendersByStatus.draft} draft`}
            icon={FileText}
            accent="accent"
          />
        )}
        {isAdmin && txMonthResult && txMonthResult.ok && (
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
        {isCompany && (
          <KpiStatCard
            label="Completed"
            value={String(completedProjects)}
            icon={Wallet}
            accent="accent"
          />
        )}
      </section>

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
          />
          <StatusBreakdownCard
            title="Tenders by status"
            icon={FileText}
            totalLabel={`${totalTenders} total`}
            items={buildTenderItems(tendersByStatus)}
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
          />
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

function buildProjectItems(
  byStatus: Record<ProjectStatus, number>,
): StatusBreakdownItem[] {
  return PROJECT_STATUS_OPTIONS.map((opt) => ({
    key: opt.value,
    badge: <ProjectStatusBadge status={opt.value} iconless />,
    count: byStatus[opt.value] ?? 0,
    href: `/dashboard/projects?status=${opt.value}`,
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
  }));
}
