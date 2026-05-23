/**
 * Reports landing — admin/staff-only.
 *
 * Server Component. Reads `?from=YYYY-MM-DD&to=YYYY-MM-DD&companyId=`
 * from the URL. Defaults to the current calendar month (UTC) when
 * `from` / `to` are unset — same window as the Day-18 dashboard's
 * per-month transactions card, so the no-arg landing feels like a
 * familiar entry point.
 *
 * Layout: the period picker sits at the top of the content area
 * (URL-shaped, no client state); below it sit three summary cards —
 * Projects created, Tenders published, Transactions (admin-only) — each
 * a Server Component that takes the resolved `(start, end)` pair and
 * runs its own period-bounded aggregate query in parallel.
 *
 * Access control: admin + staff only. Company-role redirects to
 * `/dashboard` (the report aggregates aren't designed for the company
 * slice; if it lands as a future need, it's a separate surface). The
 * admin-only transactions card additionally gates itself at the helper
 * level, so a staff viewer doesn't render that card.
 *
 * PDF export of the report is Day 20 (Phase 3). This session lands the
 * HTML surface so the data layer is stable before printing.
 *
 * @module app/dashboard/reports/page
 */
import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";

import { readSession } from "@/lib/auth/session";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/dashboard/page-header";
import { PeriodPicker } from "./_components/period-picker";
import { ProjectsSummaryCard } from "./_components/projects-summary-card";
import { TendersSummaryCard } from "./_components/tenders-summary-card";
import { TransactionsSummaryCard } from "./_components/transactions-summary-card";

export const metadata: Metadata = {
  title: "Reports",
  description: "Period-bounded operations and financial summary",
};

interface ReportsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ReportsPage({ searchParams }: ReportsPageProps) {
  const session = await readSession();
  if (!session) redirect("/login");
  if (session.role !== "admin" && session.role !== "staff") {
    redirect("/dashboard");
  }

  const params = await searchParams;
  const { start, end, companyId } = resolvePeriod(params);
  const isAdmin = session.role === "admin";

  // Stable Suspense key — re-keying on (start, end, companyId) triggers
  // a fresh fallback when the user changes the period or company.
  const suspenseKey = `${start}_${end}_${companyId ?? ""}`;

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle="Operations and financial summary, period-bounded"
      />

      <div className="mb-6 sm:mb-8">
        <PeriodPicker from={start} to={end} />
      </div>

      <section
        aria-label="Period summaries"
        className="grid gap-4 lg:grid-cols-2"
      >
        <Suspense
          key={`projects_${suspenseKey}`}
          fallback={<SummaryCardLoading />}
        >
          <ProjectsSummaryCard
            start={start}
            end={end}
            companyId={companyId}
          />
        </Suspense>
        <Suspense
          key={`tenders_${suspenseKey}`}
          fallback={<SummaryCardLoading />}
        >
          <TendersSummaryCard
            start={start}
            end={end}
            companyId={companyId}
          />
        </Suspense>
      </section>

      {isAdmin && (
        <section
          aria-label="Period transactions"
          className="mt-6 sm:mt-8"
        >
          <Suspense
            key={`tx_${suspenseKey}`}
            fallback={<SummaryCardLoading />}
          >
            <TransactionsSummaryCard
              start={start}
              end={end}
              companyId={companyId}
            />
          </Suspense>
        </section>
      )}
    </>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

interface ResolvedPeriod {
  start: string;
  end: string;
  companyId?: string;
}

/**
 * Pull (start, end, companyId) out of the URL searchParams. Falls back
 * to the current calendar month (UTC) when from/to are missing or
 * malformed. The aggregates' Zod schemas re-validate the strings at
 * query time, so a bad shape here surfaces as a card-level error rather
 * than crashing the page render.
 */
function resolvePeriod(
  params: Record<string, string | string[] | undefined>,
): ResolvedPeriod {
  const rawFrom = stringOf(params.from);
  const rawTo = stringOf(params.to);
  const validFrom = rawFrom && /^\d{4}-\d{2}-\d{2}$/.test(rawFrom);
  const validTo = rawTo && /^\d{4}-\d{2}-\d{2}$/.test(rawTo);

  if (validFrom && validTo) {
    return {
      start: rawFrom!,
      end: rawTo!,
      companyId: stringOf(params.companyId) || undefined,
    };
  }

  const defaults = currentMonthBoundsUtc();
  return {
    start: defaults.start,
    end: defaults.end,
    companyId: stringOf(params.companyId) || undefined,
  };
}

function stringOf(v: string | string[] | undefined): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return "";
}

function currentMonthBoundsUtc(now = new Date()): {
  start: string;
  end: string;
} {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 0));
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

/**
 * Lightweight skeleton shown inside each Suspense boundary while its
 * card resolves. Same visual envelope as the loaded card so the layout
 * doesn't shift.
 */
function SummaryCardLoading() {
  return (
    <Card className="p-4">
      <div className="h-32 animate-pulse rounded-md bg-muted/50" />
    </Card>
  );
}
