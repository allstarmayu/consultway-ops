/**
 * Suspense fallback for `<DocumentsSection />`.
 *
 * Matches the populated card geometry so the surrounding page doesn't
 * jump when the documents list streams in. Same skeleton shape as
 * `EntityHistoryLoading` for visual consistency across the per-entity
 * sections.
 *
 * @module app/dashboard/companies/[id]/_components/documents-section-loading
 */
import { FileText } from "lucide-react";
import { Card } from "@/components/ui/card";

export function DocumentsSectionLoading() {
  return (
    <Card className="mt-4 overflow-hidden p-0">
      <div className="flex items-center justify-between border-b border-border bg-card p-4">
        <div className="flex items-center gap-2">
          <FileText
            className="h-4 w-4 text-muted-foreground"
            aria-hidden
          />
          <h2 className="text-base font-semibold text-foreground">
            Documents
          </h2>
        </div>
      </div>

      <ul className="divide-y divide-border px-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <li key={i} className="flex items-start gap-3 py-4">
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <div className="h-4 w-40 animate-pulse rounded bg-muted" />
                <div className="h-4 w-20 animate-pulse rounded-full bg-muted" />
                <div className="h-4 w-24 animate-pulse rounded-full bg-muted" />
              </div>
              <div className="h-3 w-56 animate-pulse rounded bg-muted" />
            </div>
            <div className="h-8 w-24 shrink-0 animate-pulse rounded-md bg-muted" />
          </li>
        ))}
      </ul>
    </Card>
  );
}
