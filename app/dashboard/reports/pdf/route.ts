/**
 * Reports PDF download — admin/staff-only Route Handler.
 *
 * GET /dashboard/reports/pdf?from=YYYY-MM-DD&to=YYYY-MM-DD&companyId=
 *
 * Reads the same period + companyId triple the HTML report does, runs
 * the same three period-bounded aggregates in parallel, renders the
 * payload via `renderReportPdf` (`lib/reports/pdf.tsx`), and streams the
 * bytes back as a downloadable PDF.
 *
 * Auth gates:
 *   - Unauthenticated → 401
 *   - Company role    → 403  (the reports surface is admin/staff-only;
 *                             same shape as the HTML page's redirect)
 *
 * The admin-only transactions section is dropped from the PDF when the
 * caller is staff — `renderReportPdf` skips that section when the
 * `role` input is `"staff"`.
 *
 * Defaults: when `?from=` / `?to=` are missing or malformed, falls back
 * to the current calendar month (UTC), matching the HTML page's default
 * exactly. The `companyId` lookup re-runs against the `companies` table
 * to resolve the display name for the PDF cover; an unknown id silently
 * degrades to "All companies" rather than crashing the PDF generation.
 *
 * @module app/dashboard/reports/pdf/route
 */
import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { readSession } from "@/lib/auth/session";
import {
  getProjectsByStatusForPeriod,
  getTendersByStatusForPeriod,
  getTransactionsSummaryForPeriod,
} from "@/lib/dashboard/aggregates";
// NOTE: `lib/reports/pdf` is loaded via dynamic import inside the
// handler below, NOT statically here. Reason: `@react-pdf/renderer`
// (the renderer's dependency) is ~5-7 MiB minified and bundling it
// into the worker pushed us over the 10 MiB Cloudflare Worker ceiling.
// next.config.ts marks it `serverExternalPackages`, and this route
// catches the load failure on Workers (where the lib isn't available
// at runtime) and degrades gracefully to a 503.
import { logger } from "@/lib/logger";

const log = logger.child({ module: "reports-pdf-route" });

export async function GET(request: NextRequest) {
  // 1. Auth gate.
  const session = await readSession();
  if (!session) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  if (session.role !== "admin" && session.role !== "staff") {
    return new NextResponse("Forbidden", { status: 403 });
  }

  // 2. Resolve the (start, end, companyId) triple from the URL.
  const { searchParams } = new URL(request.url);
  const { start, end, companyId } = resolvePeriodFromParams(searchParams);

  // 3. Run the three aggregates in parallel. Staff get `null` for
  //    transactions — the transactions section is admin-only.
  const scope = { start, end, ...(companyId ? { companyId } : {}) };
  const [projectsResult, tendersResult, transactionsResult, companyName] =
    await Promise.all([
      getProjectsByStatusForPeriod(scope),
      getTendersByStatusForPeriod(scope),
      session.role === "admin"
        ? getTransactionsSummaryForPeriod(scope)
        : Promise.resolve(null),
      companyId ? resolveCompanyName(companyId) : Promise.resolve(undefined),
    ]);

  if (!projectsResult.ok) {
    log.error("projects aggregate failed", { error: projectsResult.error });
    return new NextResponse(projectsResult.error, { status: 400 });
  }
  if (!tendersResult.ok) {
    log.error("tenders aggregate failed", { error: tendersResult.error });
    return new NextResponse(tendersResult.error, { status: 400 });
  }
  if (transactionsResult && !transactionsResult.ok) {
    log.error("transactions aggregate failed", {
      error: transactionsResult.error,
    });
    return new NextResponse(transactionsResult.error, { status: 400 });
  }

  // 4. Render — lazy-load the PDF renderer module. On Cloudflare
  //    Workers the dynamic import fails because `@react-pdf/renderer`
  //    is marked external (see next.config.ts `serverExternalPackages`)
  //    and Workers don't resolve npm packages at runtime. On local dev
  //    (node_modules present) it loads normally and PDFs work.
  let pdfBytes: Uint8Array<ArrayBuffer>;
  try {
    const { renderReportPdf } = await import("@/lib/reports/pdf");
    pdfBytes = await renderReportPdf({
      start,
      end,
      role: session.role,
      companyName,
      projects: { byStatus: projectsResult.byStatus },
      tenders: { byStatus: tendersResult.byStatus },
      transactions:
        transactionsResult && transactionsResult.ok
          ? {
              countByType: transactionsResult.countByType,
              totalPaiseByType: transactionsResult.totalPaiseByType,
              totalPaise: transactionsResult.totalPaise,
              totalCount: transactionsResult.totalCount,
            }
          : undefined,
    });
  } catch (err) {
    // Distinguish the two failure modes:
    //   - Module load failure (the lib is externalized + missing at
    //     runtime) → 503 with a helpful message. Expected on Workers.
    //   - Anything else → 500 (genuine render error). Indicates a bug
    //     to investigate in the next dedicated PDF-worker session.
    const message = err instanceof Error ? err.message : String(err);
    const isModuleNotFound =
      /(cannot find module|module not found|failed to resolve)/i.test(
        message,
      );
    if (isModuleNotFound) {
      log.warn("PDF renderer unavailable in this runtime", { err });
      return new NextResponse(
        "PDF reports are temporarily unavailable in this environment. " +
          "They'll be re-enabled once the dedicated PDF worker lands. " +
          "For now, use the HTML report view at /dashboard/reports.",
        { status: 503 },
      );
    }
    log.error("renderReportPdf threw", { err });
    return new NextResponse("Failed to render report", { status: 500 });
  }

  // 5. Respond. Dated filename mirrors the CSV exporters' convention.
  const filename = `consultway-report-${todayUtc()}.pdf`;
  return new NextResponse(pdfBytes, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────

interface ResolvedPeriod {
  start: string;
  end: string;
  companyId?: string;
}

/**
 * Parse `?from=&to=&companyId=` out of the request URL. Falls back to
 * the current calendar month (UTC) when from/to are missing or
 * malformed — matches `resolvePeriod` in `app/dashboard/reports/page.tsx`
 * line-for-line so the HTML page and the PDF share the same default.
 */
function resolvePeriodFromParams(
  searchParams: URLSearchParams,
): ResolvedPeriod {
  const rawFrom = searchParams.get("from");
  const rawTo = searchParams.get("to");
  const validFrom = rawFrom && /^\d{4}-\d{2}-\d{2}$/.test(rawFrom);
  const validTo = rawTo && /^\d{4}-\d{2}-\d{2}$/.test(rawTo);

  const companyId = searchParams.get("companyId") || undefined;

  if (validFrom && validTo) {
    return { start: rawFrom!, end: rawTo!, companyId };
  }

  const defaults = currentMonthBoundsUtc();
  return { start: defaults.start, end: defaults.end, companyId };
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

function todayUtc(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Resolve a `companyId` to its display name for the PDF cover. An
 * unknown id resolves to `undefined`, which the cover handles
 * gracefully (renders "All companies" instead of crashing). We don't
 * 404 here because the aggregates would still run cleanly against an
 * unknown id (they'd just return empty per-status rows); a 404 would
 * be a more confusing failure than a PDF with "All companies".
 */
async function resolveCompanyName(
  companyId: string,
): Promise<string | undefined> {
  const rows = await db
    .select({ name: companies.name })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  return rows[0]?.name;
}
