/**
 * Users table — the data render for the users list.
 *
 * Pure presentation over pre-fetched rows. Mirrors the companies table:
 * header + body, empty state, pagination footer. Columns: user (name +
 * email), role, company, status (+ invite-pending), last login, actions.
 *
 * @module app/dashboard/admin/users/_components/users-table
 */
import Link from "next/link";
import { Eye, Pencil, Inbox, User as UserIcon } from "lucide-react";
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
import { formatRelativeTime } from "@/lib/utils/format-relative-time";
import type { UserWithCompany } from "@/lib/users/actions";
import { RoleBadge, AccountStatusBadge, InvitePendingBadge } from "./badges";

export interface UsersTableProps {
  rows: UserWithCompany[];
  total: number;
  page: number;
  perPage: number;
}

export function UsersTable({ rows, total, page, perPage }: UsersTableProps) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Inbox}
        title="No users found"
        description="Try adjusting your filters, or invite a new user to get started."
        className="px-6 py-16"
      />
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
              <TableHead className="min-w-[18rem]">User</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Company</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last login</TableHead>
              <TableHead className="w-[6rem] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            {rows.map((row) => {
              const lastLogin = formatRelativeTime(row.lastLoginAt);
              return (
                <TableRow key={row.id}>
                  {/* User — icon + name (link) + email */}
                  <TableCell className="align-top">
                    <div className="flex items-start gap-2">
                      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
                        <UserIcon
                          className="h-4 w-4 text-muted-foreground"
                          aria-hidden
                        />
                      </div>
                      <div className="min-w-0">
                        <Link
                          href={`/dashboard/admin/users/${row.id}`}
                          className="font-medium text-foreground hover:underline"
                        >
                          {row.name}
                        </Link>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {row.email}
                        </p>
                      </div>
                    </div>
                  </TableCell>

                  <TableCell className="align-top">
                    <RoleBadge role={row.role} />
                  </TableCell>

                  <TableCell className="align-top text-sm text-foreground">
                    {row.companyName ?? (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>

                  <TableCell className="align-top">
                    <div className="flex flex-col items-start gap-1">
                      <AccountStatusBadge isActive={row.isActive} />
                      {!row.emailVerifiedAt && <InvitePendingBadge />}
                    </div>
                  </TableCell>

                  <TableCell className="align-top text-sm text-muted-foreground">
                    {lastLogin || "Never"}
                  </TableCell>

                  {/* Actions — view + edit */}
                  <TableCell className="align-top">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        asChild
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`View ${row.name}`}
                      >
                        <Link href={`/dashboard/admin/users/${row.id}`}>
                          <Eye className="h-4 w-4" />
                        </Link>
                      </Button>
                      <Button
                        asChild
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Edit ${row.name}`}
                      >
                        <Link href={`/dashboard/admin/users/${row.id}/edit`}>
                          <Pencil className="h-4 w-4" />
                        </Link>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
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
            {total === 1 ? "user" : "users"}
          </p>

          {totalPages > 1 && <Pagination page={page} totalPages={totalPages} />}
        </div>
      )}
    </>
  );
}
