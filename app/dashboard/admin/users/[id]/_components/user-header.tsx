/**
 * User detail page header.
 *
 * Title strip with the user's name + role/status chips + Back / Edit
 * actions (Edit shows for admins only). Server-Component-compatible
 * (pure render).
 *
 * @module app/dashboard/admin/users/[id]/_components/user-header
 */
import Link from "next/link";
import { ArrowLeft, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { UserWithCompany } from "@/lib/users/actions";
import { RoleBadge, AccountStatusBadge, InvitePendingBadge } from "../../_components/badges";

export interface UserHeaderProps {
  user: UserWithCompany;
  /** Whether to show the Edit action — admins only (edit is admin-only). */
  canEdit: boolean;
}

export function UserHeader({ user, canEdit }: UserHeaderProps) {
  return (
    <header className="mb-6 flex flex-col gap-4 sm:mb-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="break-words text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            {user.name}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{user.email}</p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <RoleBadge role={user.role} />
            <AccountStatusBadge isActive={user.isActive} />
            {!user.emailVerifiedAt && <InvitePendingBadge />}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button asChild variant="outline">
            <Link href="/dashboard/admin/users">
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back
            </Link>
          </Button>
          {canEdit && (
            <Button asChild variant="outline">
              <Link href={`/dashboard/admin/users/${user.id}/edit`}>
                <Pencil className="h-4 w-4" aria-hidden />
                Edit
              </Link>
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}
