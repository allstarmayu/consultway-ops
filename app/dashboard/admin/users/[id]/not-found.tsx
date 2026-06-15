/**
 * Not-found state for the user detail route. Rendered when the page calls
 * `notFound()` — unknown id, or a non-admin slipping past (treated as
 * not-found to avoid leaking existence).
 *
 * @module app/dashboard/admin/users/[id]/not-found
 */
import Link from "next/link";
import { Users, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function UserNotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-6 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
        <Users className="h-8 w-8 text-muted-foreground" aria-hidden />
      </div>

      <div className="space-y-2">
        <h1 className="text-2xl font-semibold text-foreground">User not found</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          The user you&apos;re looking for doesn&apos;t exist, has been removed,
          or you don&apos;t have permission to view it.
        </p>
      </div>

      <Button asChild variant="outline">
        <Link href="/dashboard/admin/users">
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to users
        </Link>
      </Button>
    </div>
  );
}
