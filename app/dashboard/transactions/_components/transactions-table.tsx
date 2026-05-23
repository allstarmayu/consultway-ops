/**
 * Transactions table — the actual data render for the admin list page.
 *
 * Pure presentation given pre-fetched rows + the company/project lookup
 * maps. Columns:
 *
 *   - Date (occurredOn)
 *   - Type (badge)
 *   - Amount (rupees + paise formatted via formatRupeesFromPaise)
 *   - Company (text)
 *   - Project (link when set, em-dash when null)
 *   - Reference (mono font, when set)
 *   - Actions (view + edit icons; delete is on the detail page)
 *
 * @module app/dashboard/transactions/_components/transactions-table
 */
import Link from "next/link";
import { Eye, Inbox, Pencil } from "lucide-react";
import type { Transaction } from "@/lib/db/schema";
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
import { formatRupeesFromPaise } from "@/lib/format/inr";
import { TransactionTypeBadge } from "./badges";

// ── Props ─────────────────────────────────────────────────────────────────

export interface TransactionsTableProps {
  rows: Transaction[];
  /** Map of companyId → company name. */
  companyNames: Map<string, string>;
  /** Map of projectId → project name. */
  projectNames: Map<string, string>;
  total: number;
  page: number;
  perPage: number;
}

// ── Component ─────────────────────────────────────────────────────────────

export function TransactionsTable({
  rows,
  companyNames,
  projectNames,
  total,
  page,
  perPage,
}: TransactionsTableProps) {
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 px-6 py-16 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Inbox className="h-6 w-6 text-muted-foreground" aria-hidden />
        </div>
        <div className="space-y-1">
          <p className="text-base font-medium text-foreground">
            No transactions recorded
          </p>
          <p className="text-sm text-muted-foreground">
            Adjust filters, or use “Add transaction” to record a new one.
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
              <TableHead className="w-[7rem]">Date</TableHead>
              <TableHead className="w-[7rem]">Type</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Company</TableHead>
              <TableHead>Project</TableHead>
              <TableHead>Reference</TableHead>
              <TableHead className="w-[6rem] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="align-top text-sm text-foreground">
                  {row.occurredOn}
                </TableCell>

                <TableCell className="align-top">
                  <TransactionTypeBadge type={row.type} />
                </TableCell>

                <TableCell className="align-top text-right font-mono text-sm tabular-nums text-foreground">
                  {formatRupeesFromPaise(row.amountPaise)}
                </TableCell>

                <TableCell className="align-top text-sm text-foreground">
                  {companyNames.get(row.companyId) ?? "—"}
                </TableCell>

                <TableCell className="align-top text-sm text-foreground">
                  {row.projectId ? (
                    <Link
                      href={`/dashboard/projects/${row.projectId}`}
                      className="text-foreground hover:underline"
                    >
                      {projectNames.get(row.projectId) ?? "—"}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>

                <TableCell className="align-top font-mono text-xs text-muted-foreground">
                  {row.referenceNumber ?? (
                    <span className="text-muted-foreground/60">—</span>
                  )}
                </TableCell>

                <TableCell className="align-top">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      asChild
                      variant="ghost"
                      size="icon-sm"
                      aria-label="View transaction"
                    >
                      <Link href={`/dashboard/transactions/${row.id}`}>
                        <Eye className="h-4 w-4" />
                      </Link>
                    </Button>
                    <Button
                      asChild
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Edit transaction"
                    >
                      <Link href={`/dashboard/transactions/${row.id}/edit`}>
                        <Pencil className="h-4 w-4" />
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
            {total === 1 ? "transaction" : "transactions"}
          </p>
          {totalPages > 1 && <Pagination page={page} totalPages={totalPages} />}
        </div>
      )}
    </>
  );
}
