/**
 * Not-found state for the company detail route.
 *
 * Next.js calls this when the page Server Component invokes `notFound()`,
 * which happens when:
 *   - The requested id doesn't exist in the database
 *   - The current user is `company` role and the id is not their own row
 *     (we treat "forbidden" as "not found" to avoid leaking row existence
 *      via differentiated error messages)
 *
 * Renders inside the dashboard layout, so the sidebar is still visible.
 *
 * @module app/dashboard/companies/[id]/not-found
 */
import Link from "next/link";
import { Building2, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function CompanyNotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-6 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
        <Building2
          className="h-8 w-8 text-muted-foreground"
          aria-hidden
        />
      </div>

      <div className="space-y-2">
        <h1 className="text-2xl font-semibold text-foreground">
          Company not found
        </h1>
        <p className="max-w-md text-sm text-muted-foreground">
          The company you&apos;re looking for doesn&apos;t exist, has been
          removed, or you don&apos;t have permission to view it.
        </p>
      </div>

      <Button asChild variant="outline">
        <Link href="/dashboard/companies">
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to companies
        </Link>
      </Button>
    </div>
  );
}
