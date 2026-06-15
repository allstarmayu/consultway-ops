/**
 * Edit-user page (admin-only).
 *
 * Server Component shell. Fetches the user via `getUser`, auth-gates to
 * admin, fetches the company list for the picker, and renders the shared
 * `<UserForm>` in edit mode.
 *
 * @module app/dashboard/admin/users/[id]/edit/page
 */
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { asc } from "drizzle-orm";
import { readSession } from "@/lib/auth/session";
import { getUser } from "@/lib/users/actions";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/dashboard/page-header";
import { UserForm } from "@/components/users/user-form";

interface EditUserPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({
  params,
}: EditUserPageProps): Promise<Metadata> {
  const { id } = await params;
  const result = await getUser(id);
  if (!result.ok) return { title: "Edit user" };
  return { title: `Edit · ${result.user.name}` };
}

export default async function EditUserPage({ params }: EditUserPageProps) {
  const { id } = await params;

  const session = await readSession();
  if (!session) redirect("/login");
  if (session.role !== "admin") redirect("/dashboard");

  const result = await getUser(id);
  if (!result.ok) notFound();
  const user = result.user;

  const companyOptions = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .orderBy(asc(companies.name));

  return (
    <>
      <PageHeader
        title={`Edit ${user.name}`}
        subtitle="Update role, company link, and profile details"
        actions={
          <Button asChild variant="outline">
            <Link href={`/dashboard/admin/users/${user.id}`}>
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back to user
            </Link>
          </Button>
        }
      />

      <Card className="overflow-visible p-6 sm:p-8">
        <UserForm companies={companyOptions} initialValues={user} />
      </Card>
    </>
  );
}
