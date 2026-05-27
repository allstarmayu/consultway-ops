/**
 * Reports PDF — STUB for the Cloudflare Worker build.
 *
 * This module previously imported `@react-pdf/renderer` and synthesised
 * branded report PDFs from the aggregate payload. Bundling
 * `@react-pdf/renderer` (~5-7 MiB minified) pushed the OpenNext Worker
 * over Cloudflare's 10 MiB Workers Paid ceiling on Layer A's first
 * deploys.
 *
 * Rather than ship a worker the platform refuses to accept, we stubbed
 * the module: the `renderReportPdf` function below throws a module-not-
 * found-shaped error so the route handler
 * (`app/dashboard/reports/pdf/route.ts`) catches it on the first branch
 * of its try/catch and returns a friendly 503 directing users to the
 * HTML report at `/dashboard/reports`.
 *
 * Trade-offs accepted to ship Layer A:
 *   - PDF generation is unavailable on the deployed worker (returns
 *     503 with a helpful message — see route handler).
 *   - PDF generation is ALSO unavailable on local dev right now, since
 *     this file no longer imports the renderer. Resurrecting it locally
 *     means restoring the original implementation from git history.
 *
 * The proper fix (deferred, tracked in `docs/DEPLOY_LAYER_A_STATUS.md`):
 * ship a sibling Cloudflare Worker (`consultway-ops-pdf`) that owns
 * `@react-pdf/renderer` in its own bundle. The main worker POSTs the
 * report payload to it; the PDF worker renders + returns bytes. That
 * keeps each worker under the size ceiling and follows the
 * single-responsibility shape we should have had from the start.
 *
 * Public types (`ReportPdfInput`) stay exported so other code that
 * imports them for type-only purposes continues to compile.
 *
 * @module lib/reports/pdf
 */
import type {
  ProjectStatus,
  TenderStatus,
  TransactionType,
} from "@/lib/db/schema";

// ── Public types ──────────────────────────────────────────────────────────

/**
 * Per-status / per-type rollup shape echoed from the aggregate helpers.
 * The renderer doesn't import the helpers' return types directly so the
 * builder stays consumable from anywhere without a sideways dependency.
 */
export interface ReportPdfInput {
  /** Inclusive period bounds, ISO date-only (`YYYY-MM-DD`). */
  start: string;
  end: string;
  /** Viewer role — gates the admin-only transactions section. */
  role: "admin" | "staff";
  /**
   * When the report is scoped to a single company, the company's display
   * name. Renders on the cover page; omitted line when the report covers
   * all companies.
   */
  companyName?: string;
  /** `getProjectsByStatusForPeriod` payload. */
  projects: {
    byStatus: Record<ProjectStatus, number>;
  };
  /** `getTendersByStatusForPeriod` payload. */
  tenders: {
    byStatus: Record<TenderStatus, number>;
  };
  /**
   * `getTransactionsSummaryForPeriod` payload. Omitted for staff role —
   * the transactions module is admin-only forever; staff PDFs render
   * everything except this section.
   */
  transactions?: {
    countByType: Record<TransactionType, number>;
    totalPaiseByType: Record<TransactionType, number>;
    totalPaise: number;
    totalCount: number;
  };
  /**
   * Generation timestamp echoed onto the cover. Defaults to the current
   * Date; override for deterministic tests.
   */
  generatedAt?: Date;
}

// ── Public API (stub) ─────────────────────────────────────────────────────

/**
 * Generate a branded PDF report — **stubbed for the Cloudflare deploy.**
 *
 * Throws a module-not-found-shaped error so the route handler's lazy-
 * import try/catch recognises it as the expected "renderer unavailable
 * on this runtime" branch and returns 503 to the caller.
 *
 * To restore real PDF generation, ship the dedicated PDF worker
 * (tracked in `docs/DEPLOY_LAYER_A_STATUS.md` — Layer A follow-ups).
 * The original implementation is in git history at commit
 * `679a642` and earlier.
 */
export async function renderReportPdf(
  _input: ReportPdfInput,
): Promise<Uint8Array<ArrayBuffer>> {
  // Shape the error so the route handler's `/module not found/i` regex
  // catches it on the 503 branch. The exact phrasing matters: keep the
  // word "module" so the matcher in
  // `app/dashboard/reports/pdf/route.ts` recognises it.
  throw new Error(
    "Cannot find module '@react-pdf/renderer' — PDF generation has " +
      "been moved to a dedicated worker for Cloudflare deploy. Use " +
      "the HTML report at /dashboard/reports until the PDF worker ships.",
  );
}
