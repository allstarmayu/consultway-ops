/**
 * Companies table — the actual data render.
 *
 * Pure presentation given pre-fetched data. The page Server Component
 * does the data fetching; this component just lays it out.
 *
 * Renders:
 *   - <table> with header + body rows
 *   - JV chip + partner count below the name when isJv=true
 *   - GST + PAN stacked in one cell (matching figma)
 *   - MSME Yes/No badge
 *   - Compliance status pill
 *   - Action icons per row (view / edit / delete — visibility role-gated)
 *
 * Plus:
 *   - Empty state when no rows match
 *   - Pagination footer (prev / 1 2 3 ... / next) when total > perPage
 *
 * Pagination is split into a tiny Client Component child so it can read
 * `useSearchParams()` and preserve filters when changing pages. The
 * table itself stays a Server Component.
 *
 * @module app/dashboard/companies/_components/companies-table
 */
import Link from "next/link";
import { Eye, Pencil, Trash2, Building, Inbox } from "lucide-react";
import type { Company } from "@/lib/db/schema";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ComplianceBadge, JvBadge, BooleanBadge } from "./badges";
import { Pagination } from "./pagination";

// ── Props ───────────────────────────────────────────────────────────────────

export interface CompaniesTableProps {
  rows: Company[];
  total: number;
  page: number;
  perPage: number;
  /** Show the edit pencil. Admin/staff get it; company-role wouldn't. */
  canEdit: boolean;
  /** Show the delete trash. Admin only. */
  canDelete: boolean;
}

// ── Component ───────────────────────────────────────────────────────────────

export function CompaniesTable({
  rows,
  total,
  page,
  perPage,
  canEdit,
  canDelete,
}: CompaniesTableProps) {
  // Empty state. Single generic message that works whether filters are
  // applied or the database is genuinely empty.
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 px-6 py-16 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Inbox className="h-6 w-6 text-muted-foreground" aria-hidden />
        </div>
        <div className="space-y-1">
          <p className="text-base font-medium text-foreground">
            No companies found
          </p>
          <p className="text-sm text-muted-foreground">
            Try adjusting your filters, or add a new company to get started.
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
              <TableHead className="min-w-[18rem]">Company Name</TableHead>
              <TableHead>Sector</TableHead>
              <TableHead>Geography</TableHead>
              <TableHead>GST / PAN</TableHead>
              <TableHead>MSME</TableHead>
              <TableHead>Compliance</TableHead>
              <TableHead className="w-[8rem] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                {/* Name column — stacks name + optional JV badge + partner count */}
                <TableCell className="align-top">
                  <div className="flex items-start gap-2">
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
                      <Building
                        className="h-4 w-4 text-muted-foreground"
                        aria-hidden
                      />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/dashboard/companies/${row.id}`}
                          className="font-medium text-foreground hover:underline"
                        >
                          {row.name}
                        </Link>
                        {row.isJv && <JvBadge />}
                      </div>
                      {row.isJv &&
                        Array.isArray(row.parentCompanyIds) &&
                        row.parentCompanyIds.length > 0 && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {row.parentCompanyIds.length}{" "}
                            partner{row.parentCompanyIds.length === 1 ? "" : "s"}
                          </p>
                        )}
                    </div>
                  </div>
                </TableCell>

                <TableCell className="align-top text-sm text-foreground">
                  {row.sector}
                </TableCell>

                <TableCell className="align-top text-sm text-foreground">
                  {row.geography}
                </TableCell>

                {/* GST/PAN stacked, monospace for readability */}
                <TableCell className="align-top">
                  <div className="space-y-0.5 font-mono text-xs">
                    {row.gstNumber ? (
                      <div className="text-foreground">{row.gstNumber}</div>
                    ) : (
                      <div className="italic text-muted-foreground">No GST</div>
                    )}
                    {row.panNumber ? (
                      <div className="text-muted-foreground">
                        {row.panNumber}
                      </div>
                    ) : (
                      <div className="italic text-muted-foreground/60">
                        No PAN
                      </div>
                    )}
                  </div>
                </TableCell>

                <TableCell className="align-top">
                  <BooleanBadge value={row.isMsme} />
                </TableCell>

                <TableCell className="align-top">
                  <ComplianceBadge status={row.complianceStatus} />
                </TableCell>

                {/* Actions — view always, edit + delete role-gated */}
                <TableCell className="align-top">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      asChild
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`View ${row.name}`}
                    >
                      <Link href={`/dashboard/companies/${row.id}`}>
                        <Eye className="h-4 w-4" />
                      </Link>
                    </Button>
                    {canEdit && (
                      <Button
                        asChild
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Edit ${row.name}`}
                      >
                        <Link href={`/dashboard/companies/${row.id}/edit`}>
                          <Pencil className="h-4 w-4" />
                        </Link>
                      </Button>
                    )}
                    {canDelete && (
                      <Button
                        asChild
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete ${row.name}`}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Link href={`/dashboard/companies/${row.id}/delete`}>
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
            {total === 1 ? "company" : "companies"}
          </p>

          {totalPages > 1 && (
            <Pagination page={page} totalPages={totalPages} />
          )}
        </div>
      )}
    </>
  );
}
