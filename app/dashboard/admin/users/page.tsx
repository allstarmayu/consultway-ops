/**
 * Users list page (admin-only).
 *
 * Server Component — reads `searchParams` for filters/pagination, defers the
 * `listUsers` fetch into a child behind Suspense so the header + filter bar
 * paint immediately. Mirrors the companies list page structure exactly.
 *
 * Access control: admin + staff. The dashboard layout guards signed-out
 * users; here we redirect company-role users to /dashboard (the `listUsers`
 * action also re-checks server-side — defence in depth). Staff see only
 * company-user accounts (scoped in `listUsers`); the role filter is hidden
 * for them since every row is a company user.
 *
 * @module app/dashboard/admin/users/page
 */
import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { UserPlus } from "lucide-react";
import { readSession } from "@/lib/auth/session";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/dashboard/page-header";
import { TableSectionLoading } from "@/components/dashboard/table-section-loading";
import { FiltersBar } from "./_components/filters-bar";
import { UsersTableSection } from "./_components/users-table-section";

export const metadata: Metadata = {
  title: "Users",
  description: "Manage platform users and invitations",
};

interface UsersPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function UsersPage({ searchParams }: UsersPageProps) {
  const [params, session] = await Promise.all([searchParams, readSession()]);

  if (!session) redirect("/login");
  // Admin + staff only. Company-role users are bounced to the dashboard home.
  if (session.role !== "admin" && session.role !== "staff") {
    redirect("/dashboard");
  }

  const suspenseKey = JSON.stringify(params);

  return (
    <>
      <PageHeader
        title="Users"
        subtitle="Manage platform users, roles, and invitations"
        actions={
          <Button asChild>
            <Link href="/dashboard/admin/users/new">
              <UserPlus className="h-4 w-4" aria-hidden />
              Invite user
            </Link>
          </Button>
        }
      />

      <Card className="overflow-hidden p-0">
        <FiltersBar showRoleFilter={session.role === "admin"} />
        <Suspense key={suspenseKey} fallback={<TableSectionLoading columns={6} />}>
          <UsersTableSection query={params} viewerRole={session.role} />
        </Suspense>
      </Card>
    </>
  );
}
