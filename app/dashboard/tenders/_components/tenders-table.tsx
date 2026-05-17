/**
 * Tenders table — the actual data render for the list page.
 *
 * Pure presentation given pre-fetched rows. The page Server Component
 * does the data fetching; this component just lays it out. Same shape
 * as the companies table:
 *
 *   - <table> with header + body rows
 *   - Title + reference number stacked
 *   - Status pill
 *   - Sector / Geography columns
 *   - "Closing in N days" / "Closed N days ago" relative date column
 *   - MSME-only chip on the title's secondary line when set
 *   - Action icons per row (view / edit / delete — visibility role-gated)
 *
 * Plus:
 *   - Empty state when no rows match
 *   - Pagination footer (prev / 1 2 3 ... / next) when total > perPage
 *
 * Pagination is the shared `<Pagination>` from
 * `components/dashboard/pagination` (extracted from the companies module
 * in this same chunk so a third list page can use it without copy-paste).
 *
 * Delete column visibility rule: admins can delete, BUT only drafts can
 * be deleted (action layer enforces). The button shows for any row to an
 * admin so they have a consistent surface; the action returns a friendly
 * error if they click on a non-draft. Cleaner than mid-row conditional
 * rendering at this scale.
 *
 * @module app/dashboard/tenders/_components/tenders-table
 */
import Link from "next/link";
import { Eye, Pencil, Trash2, FileText, Inbox } from "lucide-react";
import type { Tender } from "@/lib/db/schema";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Pagination } from "@/components/dashboard/pagination";
import { TenderStatusBadge, EligibilityChip } from "./badges";

// ── Props ─────────────────────────────────────────────────────────────────

export interface TendersTableProps {
  rows: Tender[];
  total: number;
  page: number;
  perPage: number;
  /** Show the edit pencil. Admin/staff get it; company-role wouldn't. */
  canEdit: boolean;
  /**
   * Show the delete trash. Admin only — note that the action also
   * gates on `status === 'draft'`, but we show the button on every row
   * for admins so the surface stays consistent. Clicking on a
   * non-draft returns a friendly error.
   */
  canDelete: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────

export function TendersTable({
  rows,
  total,
  page,
  perPage,
  canEdit,
  canDelete,
}: TendersTableProps) {
  // Empty state — same generic copy as companies, works for both
  // "filters yielded nothing" and "DB genuinely empty."
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 px-6 py-16 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Inbox className="h-6 w-6 text-muted-foreground" aria-hidden />
        </div>
        <div className="space-y-1">
          <p className="text-base font-medium text-foreground">
            No tenders found
          </p>
          <p className="text-sm text-muted-foreground">
            Try adjusting your filters, or create a new tender to get started.
          </p>
        </div>
      </div>
    );
  }

  const startIdx = (page - 1) * perPage + 1;
  const endIdx = Math.min(page * perPage, total);
  const totalPages = Math.max(1, Math.ceil(total / perPage));

  return (
    <>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50 hover:bg-muted/50">
              <TableHead className="min-w-[22rem]">Tender</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Sector</TableHead>
              <TableHead>Geography</TableHead>
              <TableHead>Closing</TableHead>
              <TableHead className="w-[8rem] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                {/* Title column — title + reference number + eligibility chips */}
                <TableCell className="align-top">
                  <div className="flex items-start gap-2">
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
                      <FileText
                        className="h-4 w-4 text-muted-foreground"
                        aria-hidden
                      />
                    </div>
                    <div className="min-w-0">
                      <Link
                        href={`/dashboard/tenders/${row.id}`}
                        className="font-medium text-foreground hover:underline"
                      >
                        {row.title}
                      </Link>
                      {/* Reference number subtitle when present */}
                      {row.referenceNumber && (
                        <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                          {row.referenceNumber}
                        </p>
                      )}
                      {/* Compact eligibility chips — only show the
                          most-discriminating ones on the table row.
                          Sector and geography are already their own
                          columns; MSME-only is the surprise filter
                          worth flagging inline. */}
                      {row.msmeOnly && (
                        <div className="mt-1.5">
                          <EligibilityChip label="MSME only" emphasis="strong" />
                        </div>
                      )}
                    </div>
                  </div>
                </TableCell>

                <TableCell className="align-top">
                  <TenderStatusBadge status={row.status} />
                </TableCell>

                <TableCell className="align-top text-sm text-foreground">
                  {row.sector}
                </TableCell>

                <TableCell className="align-top text-sm text-foreground">
                  {row.geography}
                </TableCell>

                {/* Relative closing date — "in 14 days" / "5 days ago" /
                    "today" / "no closing date". The function below
                    returns a structured result so we can color-code. */}
                <TableCell className="align-top text-sm">
                  <ClosingDateCell
                    closingDate={row.closingDate}
                    status={row.status}
                  />
                </TableCell>

                {/* Actions — view always, edit + delete role-gated */}
                <TableCell className="align-top">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      asChild
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`View ${row.title}`}
                    >
                      <Link href={`/dashboard/tenders/${row.id}`}>
                        <Eye className="h-4 w-4" />
                      </Link>
                    </Button>
                    {canEdit && (
                      <Button
                        asChild
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Edit ${row.title}`}
                      >
                        <Link href={`/dashboard/tenders/${row.id}/edit`}>
                          <Pencil className="h-4 w-4" />
                        </Link>
                      </Button>
                    )}
                    {canDelete && (
                      <Button
                        asChild
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete ${row.title}`}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Link href={`/dashboard/tenders/${row.id}/delete`}>
                          <Trash2 className="h-4 w-4" />
                        </Link>
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Footer with row count + pagination controls */}
      {total > 0 && (
        <div className="flex flex-col items-center justify-between gap-3 border-t border-border bg-card px-4 py-3 text-sm sm:flex-row">
          <p className="text-muted-foreground">
            Showing <span className="font-medium text-foreground">{startIdx}</span>
            {"–"}
            <span className="font-medium text-foreground">{endIdx}</span> of{" "}
            <span className="font-medium text-foreground">{total}</span>{" "}
            {total === 1 ? "tender" : "tenders"}
          </p>

          {totalPages > 1 && (
            <Pagination page={page} totalPages={totalPages} />
          )}
        </div>
      )}
    </>
  );
}

// ── ClosingDateCell ───────────────────────────────────────────────────────

/**
 * Render a tender's closing date as a relative phrase plus the absolute
 * date in a muted line below. Server-Component-rendered, so "today"
 * means UTC-today, not the user's local today — at Phase 1 scale and
 * for Indian ops this is fine (the +5:30 offset doesn't matter for
 * day-granularity dates outside the midnight boundary).
 *
 * Visual logic:
 *   - status === awarded     → "Awarded" (closing date irrelevant)
 *   - status === closed      → "Closed N days ago" (muted)
 *   - no closing date set    → "No closing date" (muted, italic)
 *   - upcoming, > 7 days     → "in N days" (default)
 *   - upcoming, ≤ 7 days     → "in N days" (accent — call attention)
 *   - upcoming, today/tmrw   → "today" / "tomorrow" (destructive — urgent)
 *   - past, not yet closed   → "N days overdue" (destructive — staff
 *                              should run closeTender)
 */
function ClosingDateCell({
  closingDate,
  status,
}: {
  closingDate: string | null;
  status: Tender["status"];
}) {
  // Terminal states render without computing dates.
  if (status === "awarded") {
    return <span className="text-muted-foreground">—</span>;
  }

  if (!closingDate) {
    return (
      <span className="italic text-muted-foreground">No closing date</span>
    );
  }

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const diffDays = daysBetweenIso(today, closingDate);

  // Compose the absolute-date footer line — same for every variant.
  const absoluteLine = (
    <p className="mt-0.5 text-xs text-muted-foreground">{closingDate}</p>
  );

  // status === closed — past tense regardless of date sign
  if (status === "closed") {
    return (
      <div>
        <p className="text-muted-foreground">
          Closed{" "}
          {diffDays === 0
            ? "today"
            : diffDays < 0
              ? `${Math.abs(diffDays)} ${absDays(diffDays) === 1 ? "day" : "days"} ago`
              : `in ${diffDays} ${diffDays === 1 ? "day" : "days"}`}
        </p>
        {absoluteLine}
      </div>
    );
  }

  // status === draft or published — present/future tense
  let label: string;
  let toneClass = "text-foreground";

  if (diffDays < 0) {
    // Past closing date but not yet closed — staff should close it
    label = `${Math.abs(diffDays)} ${absDays(diffDays) === 1 ? "day" : "days"} overdue`;
    toneClass = "text-destructive font-medium";
  } else if (diffDays === 0) {
    label = "Closes today";
    toneClass = "text-destructive font-medium";
  } else if (diffDays === 1) {
    label = "Closes tomorrow";
    toneClass = "text-destructive font-medium";
  } else if (diffDays <= 7) {
    label = `Closes in ${diffDays} days`;
    toneClass = "text-accent font-medium";
  } else {
    label = `Closes in ${diffDays} days`;
  }

  return (
    <div>
      <p className={toneClass}>{label}</p>
      {absoluteLine}
    </div>
  );
}

// ── Date helpers ──────────────────────────────────────────────────────────

/**
 * Days between two YYYY-MM-DD strings. Positive if `to` is after `from`,
 * negative if before, zero if same day. No timezone math — both inputs
 * are date-only strings, treated as the same calendar.
 *
 * Implementation: parse via Date.UTC to skirt local-timezone DST shifts,
 * then divide by ms-per-day.
 */
function daysBetweenIso(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const fromMs = Date.UTC(fy, fm - 1, fd);
  const toMs = Date.UTC(ty, tm - 1, td);
  return Math.round((toMs - fromMs) / (1000 * 60 * 60 * 24));
}

/**
 * Absolute value of a day diff — kept tiny because the pluralisation
 * checks (`absDays(diffDays) === 1`) read more naturally than
 * `Math.abs(diffDays) === 1` in two places.
 */
function absDays(n: number): number {
  return Math.abs(n);
}
