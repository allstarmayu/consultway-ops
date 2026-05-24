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
 * PDF download (admin/staff) lives in the PageHeader action slot —
 * forwards the resolved `(start, end, companyId)` to
 * `/dashboard/reports/pdf` so the file matches what's on screen even
 * when defaults were filled in.
 *
 * @module app/dashboard/reports/page
 */
import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { asc } from "drizzle-orm";
import { Download } from "lucide-react";

import { readSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/dashboard/page-header";
import { CompanyPicker } from "./_components/company-picker";
import { PeriodPicker } from "./_components/period-picker";
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

  const pdfHref = buildPdfHref({ start, end, companyId });

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle="Operations and financial summary, period-bounded"
        actions={
          <Button asChild variant="outline">
            <Link href={pdfHref}>
              <Download className="h-4 w-4" aria-hidden />
              Download PDF
            </Link>
          </Button>
        }
      />

      <div className="mb-6 flex flex-col gap-3 sm:mb-8 lg:flex-row lg:items-start">
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

/**
 * Build the PDF download URL by forwarding the resolved `(start, end,
 * companyId)` triple. The PDF route re-resolves its own period from the
 * URL (same fallback to current-month), so forwarding the resolved
 * values keeps the downloaded report aligned with what the user is
 * looking at on screen — including when the user didn't pass any
 * `?from` / `?to` and the page filled in defaults.
 */
function buildPdfHref({
  start,
  end,
  companyId,
}: ResolvedPeriod): string {
  const search = new URLSearchParams();
  search.set("from", start);
  search.set("to", end);
  if (companyId) search.set("companyId", companyId);
  return `/dashboard/reports/pdf?${search.toString()}`;
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
