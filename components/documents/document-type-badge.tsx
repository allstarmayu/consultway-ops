/**
 * Short pill displaying a document's type.
 *
 * Pure presentation - server-component compatible. Mirrors the
 * `JvBadge` / `BooleanBadge` patterns in
 * `app/dashboard/companies/_components/badges.tsx` (small, no icon,
 * neutral surface tones). We intentionally keep type pills visually
 * subtler than status pills - the type is informational, the status
 * carries the urgency.
 *
 * @module components/documents/document-type-badge
 */
import { cn } from "@/lib/utils";
import type { DocumentType } from "@/lib/db/schema";
import { DOCUMENT_TYPE_LABELS } from "@/lib/documents/labels";

export interface DocumentTypeBadgeProps {
  type: DocumentType;
  className?: string;
}

export function DocumentTypeBadge({ type, className }: DocumentTypeBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground",
        className,
      )}
    >
      {DOCUMENT_TYPE_LABELS[type]}
    </span>
  );
}
