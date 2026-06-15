/**
 * User detail page (admin-only).
 *
 * Server Component shell:
 *   1. Auth: signed-in + admin (the layout guards signed-out; non-admins
 *      are redirected — `getUser` also re-checks admin server-side).
 *   2. Fetch the row via `getUser` (password hash stripped, company joined).
 *      notFound() on miss.
 *   3. Render header + overview fact-sheet + the account-actions panel +
 *      the audit history feed (targetType "user").
 *
 * @module app/dashboard/admin/users/[id]/page
 */
import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { readSession } from "@/lib/auth/session";
import { getUser } from "@/lib/users/actions";
import { Card } from "@/components/ui/card";
import { EntityHistory } from "@/components/audit/entity-history";
import { EntityHistoryLoading } from "@/components/audit/entity-history-loading";
import { UserHeader } from "./_components/user-header";
import { UserOverview } from "./_components/user-overview";
import { UserActions } from "./_components/user-actions";

interface UserDetailPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({
  params,
}: UserDetailPageProps): Promise<Metadata> {
  const { id } = await params;
  const result = await getUser(id);
  if (!result.ok) return { title: "User" };
  return {
    title: result.user.name,
    description: `User profile — ${result.user.name}`,
  };
}

export default async function UserDetailPage({ params }: UserDetailPageProps) {
  const { id } = await params;

  const session = await readSession();
  if (!session) redirect("/login");
  if (session.role !== "admin") redirect("/dashboard");

  const result = await getUser(id);
  if (!result.ok) notFound();
  const user = result.user;

  return (
    <>
      <UserHeader user={user} />

      <Card className="overflow-hidden p-0">
        <UserOverview user={user} />
      </Card>

      <div className="mt-6">
        <UserActions
          userId={user.id}
          isActive={user.isActive}
          isPendingInvite={!user.emailVerifiedAt}
          isSelf={session.userId === user.id}
        />
      </div>

      <div className="mt-6">
        <Suspense fallback={<EntityHistoryLoading />}>
          <EntityHistory
            targetType="user"
            targetId={user.id}
            emptyDescription="No activity recorded on this user yet."
          />
        </Suspense>
      </div>
    </>
  );
}
