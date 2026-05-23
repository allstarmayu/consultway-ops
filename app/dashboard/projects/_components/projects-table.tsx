/**
 * Projects table — the actual data render for the list page.
 *
 * Pure presentation given pre-fetched rows. Same shape as
 * `tenders-table.tsx`:
 *
 *   - <table> with header + body rows
 *   - Name + linked company
 *   - Status pill
 *   - Start / End date columns
 *   - "Updated N days ago" relative column
 *   - View action icon per row (edit is reached via the detail page)
 *
 * Plus:
 *   - Empty state when no rows match — copy varies by `canCreate`
 *   - Pagination footer when total > perPage
 *
 * @module app/dashboard/projects/_components/projects-table
 */
import Link from "next/link";
import { Briefcase, Eye, Inbox } from "lucide-react";
import type { Project } from "@/lib/db/schema";
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
import { ProjectStatusBadge } from "./badges";

// ── Props ─────────────────────────────────────────────────────────────────

export interface ProjectsTableProps {
  rows: Project[];
  /**
   * Map of companyId → company name. The list page pre-fetches the
   * minimal companies row (id + name) so the table can render the
   * owning-company column without an N+1 fetch.
   */
  companyNames: Map<string, string>;
  total: number;
  page: number;
  perPage: number;
  /**
   * True when the viewer can reach the "Create project" surface. Used
   * to vary the empty-state copy.
   */
  canCreate: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────

export function ProjectsTable({
  rows,
  companyNames,
  total,
  page,
  perPage,
  canCreate,
}: ProjectsTableProps) {
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 px-6 py-16 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Inbox className="h-6 w-6 text-muted-foreground" aria-hidden />
        </div>
        <div className="space-y-1">
          <p className="text-base font-medium text-foreground">
            No projects yet
          </p>
          <p className="text-sm text-muted-foreground">
            {canCreate
              ? "Adjust filters, or create a new project to get started."
              : "Adjust your filters — there are no projects in this view."}
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
              <TableHead className="min-w-[22rem]">Project</TableHead>
              <TableHead>Company</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Start</TableHead>
              <TableHead>End</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead className="w-[4rem] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="align-top">
                  <div className="flex items-start gap-2">
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
                      <Briefcase
                        className="h-4 w-4 text-muted-foreground"
                        aria-hidden
                      />
                    </div>
                    <div className="min-w-0">
                      <Link
                        href={`/dashboard/projects/${row.id}`}
                        className="font-medium text-foreground hover:underline"
                      >
                        {row.name}
                      </Link>
                      {row.tenderId && (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          Linked to tender
                        </p>
                      )}
                    </div>
                  </div>
                </TableCell>

                <TableCell className="align-top text-sm text-foreground">
                  {companyNames.get(row.companyId) ?? "—"}
                </TableCell>

                <TableCell className="align-top">
                  <ProjectStatusBadge status={row.status} />
                </TableCell>

                <TableCell className="align-top text-sm text-foreground">
                  {row.startDate ?? (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>

                <TableCell className="align-top text-sm text-foreground">
                  {row.endDate ?? (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>

                <TableCell className="align-top text-sm text-muted-foreground">
                  {row.updatedAt.slice(0, 10)}
                </TableCell>

                <TableCell className="align-top">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      asChild
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`View ${row.name}`}
                    >
                      <Link href={`/dashboard/projects/${row.id}`}>
                        <Eye className="h-4 w-4" />
                      </Link>
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {total > 0 && (
        <div className="flex flex-col items-center justify-between gap-3 border-t border-border bg-card px-4 py-3 text-sm sm:flex-row">
          <p className="text-muted-foreground">
            Showing <span className="font-medium text-foreground">{startIdx}</span>
            {"–"}
            <span className="font-medium text-foreground">{endIdx}</span> of{" "}
            <span className="font-medium text-foreground">{total}</span>{" "}
            {total === 1 ? "project" : "projects"}
          </p>
          {totalPages > 1 && (
            <Pagination page={page} totalPages={totalPages} />
          )}
        </div>
      )}
    </>
  );
}
