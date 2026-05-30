"use client";

/**
 * Print / Download-PDF control for the reports page.
 *
 * Replaces the old server-side PDF route. Clicking this opens the
 * browser's native print dialog, where the user picks "Save as PDF" (or
 * a physical printer). The page's `@media print` stylesheet
 * (`app/globals.css`) hides the app chrome and renders a branded,
 * paginated report — so the saved PDF matches what's on screen, scoped to
 * the active period + company filter.
 *
 * Why client-side print instead of a server renderer: `@react-pdf/renderer`
 * can't run on Cloudflare Workers (its Yoga layout engine needs runtime
 * WASM, which workerd forbids — see the Day-31 report). Browser
 * print-to-PDF is free, runs in the user's browser, and never breaks on a
 * platform change. The only thing it can't do is unattended/headless
 * generation, which the current spec doesn't require.
 *
 * The default "Save as PDF" filename comes from `document.title`, so we
 * swap in a dated, report-shaped title for the duration of the print and
 * restore the original afterwards.
 *
 * @module app/dashboard/reports/_components/print-report-button
 */
import { useCallback } from "react";
import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";

export interface PrintReportButtonProps {
  /** Period start (`YYYY-MM-DD`) — used for the saved-PDF filename. */
  from: string;
  /** Period end (`YYYY-MM-DD`) — used for the saved-PDF filename. */
  to: string;
}

/**
 * Outline button that triggers `window.print()` with a temporarily
 * report-shaped `document.title` so the saved PDF gets a meaningful
 * default filename (e.g. `consultway-report-2026-05-01_2026-05-31.pdf`).
 */
export function PrintReportButton({ from, to }: PrintReportButtonProps) {
  const handlePrint = useCallback(() => {
    const previousTitle = document.title;
    const restore = () => {
      document.title = previousTitle;
      window.removeEventListener("afterprint", restore);
    };
    // `afterprint` fires once the dialog closes (save or cancel) — restore
    // the title then. Belt-and-suspenders: most browsers run print()
    // synchronously, but the listener covers the async cases too.
    window.addEventListener("afterprint", restore);
    document.title = `consultway-report-${from}_${to}`;
    window.print();
  }, [from, to]);

  return (
    <Button type="button" variant="outline" onClick={handlePrint}>
      <Download className="h-4 w-4" aria-hidden />
      Download PDF
    </Button>
  );
}
