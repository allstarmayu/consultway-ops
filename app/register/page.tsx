/**
 * Public registration page.
 *
 * Server Component shell — owns the brand chrome and the unauthenticated
 * bounce. If a logged-in user lands here we send them back to the
 * dashboard rather than letting them create a second account.
 *
 * The form itself is a Client Component (`./_components/register-form`)
 * because it needs react-hook-form + transitions. Mirrors the login page
 * layout so the two unauthenticated entry points feel like siblings.
 *
 * @module app/register/page
 */
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Building2 } from "lucide-react";
import { readSession } from "@/lib/auth/session";
import { RegisterForm } from "./_components/register-form";

export const metadata: Metadata = {
  title: "Register your company",
  description: "Create a Consultway Ops account for your organisation.",
};

export default async function RegisterPage() {
  // Logged-in user landing on /register is almost certainly a misroute —
  // bounce to the dashboard rather than rendering a "create another
  // account" surface they have no reason to see.
  const session = await readSession();
  if (session) {
    redirect("/dashboard");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted px-6 py-12">
      <div className="w-full max-w-xl">
        <Link
          href="/"
          className="mb-8 flex items-center justify-center gap-3"
          aria-label="Consultway Infotech home"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary">
            <Building2
              className="h-5 w-5 text-primary-foreground"
              aria-hidden
            />
          </div>
          <span className="text-lg font-semibold tracking-tight">
            Consultway Ops
          </span>
        </Link>

        <RegisterForm />

        <p className="mt-6 text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link
            href="/login"
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
