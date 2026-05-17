/**
 * Tender not-found page.
 *
 * Rendered when `getTender` returns "not found" — either the id doesn't
 * exist OR a company-role user is trying to view a draft they don't
 * own. We don't distinguish between those two cases on this page —
 * leaking the existence of an inaccessible draft via a different error
 * message would be a small information leak.
 *
 * @module app/dashboard/tenders/[id]/not-found
 */
import Link from "next/link";
import { ArrowLeft, FileQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export default function TenderNotFound() {
  return (
    <Card className="flex flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <FileQuestion
          className="h-6 w-6 text-muted-foreground"
          aria-hidden
        />
      </div>

      <div className="space-y-1">
        <p className="text-base font-medium text-foreground">
          Tender not found
        </p>
        <p className="text-sm text-muted-foreground">
          The tender you&apos;re looking for doesn&apos;t exist or you don&apos;t
          have access to it.
        </p>
      </div>

      <Button asChild variant="outline" className="mt-2">
        <Link href="/dashboard/tenders">
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to tenders
        </Link>
      </Button>
    </Card>
  );
}
