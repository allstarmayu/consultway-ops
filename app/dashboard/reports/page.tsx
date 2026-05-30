/**
 * Reports landing — admin/staff-only.
 *
 * Server Component. Reads `?from=YYYY-MM-DD&to=YYYY-MM-DD&companyId=`
 * from the URL. Defaults to the current calendar month (UTC) when
 * `from` / `to` are unset — same window as the Day-18 dashboard's
 * per-month transactions card, so the no-arg landing feels like a
 * familiar entry point.
 *
 * Layout: a company picker + period picker sit at the top of the content
 * area (both URL-shaped, no client state); below them sit three summary
 * cards — Projects created, Tenders published, Transactions (admin-only)
 * — each a Server Component that takes the resolved
 * `(start, end, companyId)` triple and runs its own period-bounded
 * aggregate query in parallel.
 *
 * Access control: admin + staff only. Company-role redirects to
 * `/dashboard` (the report aggregates aren't designed for the company
 * slice; if it lands as a future need, it's a separate surface). The
 * admin-only transactions card additionally gates itself at the helper
 * level, so a staff viewer doesn't render that card.
 *
 * PDF export (admin/staff): the "Download PDF" action in the PageHeader
 * triggers the browser's print dialog (`PrintReportButton` →
 * `window.print()`), and the `@media print` stylesheet in
 * `app/globals.css` hides the app chrome + renders a branded, paginated
 * report. A print-only cover header (below) carries the brand, the
 * resolved period, the company scope, and the generation timestamp, so
 * the saved PDF stands alone. (Server-side rendering via
 * `@react-pdf/renderer` was abandoned — it can't run on Cloudflare
 * Workers; see the Day-31 report.)
 *
 * @module app/dashboard/reports/page
 */
import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { asc } from "drizzle-orm";

import { readSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/dashboard/page-header";
import { CompanyPicker } from "./_components/company-picker";
import { PeriodPicker } from "./_components/period-picker";
import { PrintReportButton } from "./_components/print-report-button";
import { ProjectsSummaryCard } from "./_components/projects-summary-card";
import { ReportsKpiStrip } from "./_components/reports-kpi-strip";
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

  const [params, companyOptions] = await Promise.all([
    searchParams,
    db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .orderBy(asc(companies.name)),
  ]);
  const { start, end, companyId } = resolvePeriod(params);
  const isAdmin = session.role === "admin";

  // Stable Suspense key — re-keying on (start, end, companyId) triggers
  // a fresh fallback when the user changes the period or company.
  const suspenseKey = `${start}_${end}_${companyId ?? ""}`;

  const companyName = companyId
    ? companyOptions.find((c) => c.id === companyId)?.name
    : undefined;
  // Server-render time, stamped onto the print cover. UTC to match the
  // period bounds (which are UTC calendar dates).
  const generatedAtUtc = new Date()
    .toISOString()
    .replace("T", " ")
    .slice(0, 16);

  return (
    <div data-print-region>
      {/* Print-only branded cover. Hidden on screen; the print stylesheet
          (`app/globals.css`) shows it and hides the interactive header +
          filters below, so the saved PDF reads as a standalone document. */}
      <div className="mb-6 hidden border-b border-border pb-4 print:block">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
          Consultway Infotech
        </p>
        <h1 className="mt-1 text-2xl font-bold text-foreground">
          Operations &amp; Financial Summary
        </h1>
        <p className="mt-2 text-xs text-muted-foreground">
          <span>
            Period: {start} &rarr; {end}
          </span>
          <span aria-hidden> &nbsp;&middot;&nbsp; </span>
          <span>Scope: {companyName ?? "All companies"}</span>
          <span aria-hidden> &nbsp;&middot;&nbsp; </span>
          <span>Generated: {generatedAtUtc} UTC</span>
        </p>
      </div>

      <PageHeader
        className="print:hidden"
        title="Reports"
        subtitle="Operations and financial summary, period-bounded"
        actions={<PrintReportButton from={start} to={end} />}
      />

      <div className="mb-6 flex flex-col gap-3 sm:mb-8 lg:flex-row lg:items-start print:hidden">
        <div className="lg:shrink-0">
          <CompanyPicker options={companyOptions} value={companyId} />
        </div>
        <div className="flex-1">
          <PeriodPicker from={start} to={end} />
        </div>
      </div>

      {/* Day-25: KPI strip at the top. Same vocabulary as the dashboard
          so the two pages read as siblings. Wrapped in its own Suspense
          so the strip streams independently of the breakdown cards
          below. */}
      <Suspense
        key={`kpi_${suspenseKey}`}
        fallback={<SummaryCardLoading />}
      >
        <ReportsKpiStrip
          start={start}
          end={end}
          companyId={companyId}
          isAdmin={isAdmin}
        />
      </Suspense>

      <section
        aria-label="Period summaries"
        className="stagger-children grid gap-4 lg:grid-cols-2"
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
    </div>
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
