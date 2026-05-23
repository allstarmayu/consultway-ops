/**
 * Transaction not-found page.
 *
 * Rendered when `getTransaction` returns "not found" — either the id
 * doesn't exist, or (less commonly) the auth gate refused.
 *
 * @module app/dashboard/transactions/[id]/not-found
 */
import Link from "next/link";
import { ArrowLeft, FileQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export default function TransactionNotFound() {
  return (
    <Card className="flex flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <FileQuestion className="h-6 w-6 text-muted-foreground" aria-hidden />
      </div>

      <div className="space-y-1">
        <p className="text-base font-medium text-foreground">
          Transaction not found
        </p>
        <p className="text-sm text-muted-foreground">
          The transaction you&apos;re looking for doesn&apos;t exist or has
          been deleted.
        </p>
      </div>

      <Button asChild variant="outline" className="mt-2">
        <Link href="/dashboard/transactions">
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to transactions
        </Link>
      </Button>
    </Card>
  );
}
