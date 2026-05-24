/**
 * Suspense fallback for `<EntityHistory />`.
 *
 * Matches the populated card geometry so the surrounding page doesn't
 * jump when the history streams in. Same skeleton shape as the
 * dashboard widget's loading state - intentional, so the two surfaces
 * feel related.
 *
 * @module components/audit/entity-history-loading
 */
import { History } from "lucide-react";

import { Card } from "@/components/ui/card";

export function EntityHistoryLoading() {
  return (
    <Card className="mt-4 overflow-hidden p-0">
      <div className="flex items-center justify-between border-b border-border bg-card p-4">
        <div className="flex items-center gap-2">
          <History
            className="h-4 w-4 text-muted-foreground"
            aria-hidden
          />
          <h2 className="text-base font-semibold text-foreground">History</h2>
        </div>
      </div>

      <ul className="divide-y divide-border px-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <li key={i} className="flex items-start gap-3 py-3">
            <div className="h-9 w-9 shrink-0 skeleton rounded-full" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="h-4 w-3/4 skeleton" />
              <div className="h-3 w-24 skeleton" />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
