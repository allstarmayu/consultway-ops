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
import { EmptyState } from "@/components/ui/empty-state";
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
      <EmptyState
        icon={Inbox}
        title="No transactions recorded"
        description="Adjust filters, or use “Add transaction” to record a new one."
        className="px-6 py-16"
      />
    );
  }

  const startIdx = (page - 1) * perPage + 1;
  const endIdx = Math.min(page * perPage, total);
  const totalPages = Math.max(1, Math.ceil(total / perPage));

  return (
    <>
      {/* Desktop: full data table. Hidden below `lg`, where 7 columns
          would overflow a phone viewport — the card list takes over. */}
      <div className="hidden overflow-x-auto lg:block">
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

      {/* Mobile: stacked card list (below `lg`). Same data + actions as
          the table, laid out vertically so nothing overflows the
          viewport. Mirrors the companies-list card pattern. */}
      <ul className="divide-y divide-border lg:hidden">
        {rows.map((row) => {
          const projectName = row.projectId
            ? projectNames.get(row.projectId) ?? null
            : null;

          return (
            <li key={row.id} className="px-4 py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  {/* Amount as the prominent figure + type badge */}
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-base font-semibold tabular-nums text-foreground">
                      {formatRupeesFromPaise(row.amountPaise)}
                    </span>
                    <TransactionTypeBadge type={row.type} />
                  </div>
                  {/* Meta: company · project · date · reference */}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {companyNames.get(row.companyId) ?? "—"}
                    {projectName && ` · ${projectName}`}
                    {` · ${row.occurredOn}`}
                    {row.referenceNumber && ` · ${row.referenceNumber}`}
                  </p>
                </div>

                {/* Actions — view + edit (matches the table row) */}
                <div className="flex shrink-0 items-center gap-1">
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
              </div>
            </li>
          );
        })}
      </ul>

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
