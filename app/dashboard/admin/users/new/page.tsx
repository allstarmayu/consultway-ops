/**
 * Invite-user page (admin-only).
 *
 * Server Component shell. Auth-gates to admin, fetches the company list for
 * the company-role picker, and renders the shared `<UserForm>` in create
 * mode. The form mints an invite + emails a set-password link on submit.
 *
 * @module app/dashboard/admin/users/new/page
 */
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { asc } from "drizzle-orm";
import { readSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/dashboard/page-header";
import { UserForm } from "@/components/users/user-form";

export const metadata: Metadata = {
  title: "Invite user",
  description: "Invite a new user to the Consultway platform",
};

export default async function NewUserPage() {
  const session = await readSession();
  if (!session) redirect("/login");
  if (session.role !== "admin") redirect("/dashboard");

  const companyOptions = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .orderBy(asc(companies.name));

  return (
    <>
      <PageHeader
        title="Invite user"
        subtitle="Send an invitation — the user sets their own password"
        actions={
          <Button asChild variant="outline">
            <Link href="/dashboard/admin/users">
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back to users
            </Link>
          </Button>
        }
      />

      <Card className="overflow-visible p-6 sm:p-8">
        <UserForm companies={companyOptions} />
      </Card>
    </>
  );
}
