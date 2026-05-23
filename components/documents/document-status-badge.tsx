/**
 * Colored pill displaying a document's lifecycle state.
 *
 * Pure presentation - server-component compatible. Mirrors
 * `ComplianceBadge` in `app/dashboard/companies/_components/badges.tsx`
 * for visual consistency (same shape, same icon-disc-then-label
 * structure). Colour mapping leans on the palette tokens already in
 * use for compliance:
 *
 *   pending         -> muted   (the row exists but no bytes yet; rare)
 *   pending_review  -> accent  (action required from staff)
 *   verified        -> primary (the happy path)
 *   rejected        -> destructive
 *   expired         -> muted with warning icon
 *
 * @module components/documents/document-status-badge
 */
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Loader2,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { DocumentStatus } from "@/lib/db/schema";
import { DOCUMENT_STATUS_LABELS } from "@/lib/documents/labels";

interface DocumentStatusStyle {
  classes: string;
  icon: LucideIcon;
}

/**
 * One config object per status. Adding a new status to `DocumentStatus`
 * surfaces here as a TypeScript error (the record is keyed by the union)
 * - can't ship a new state without picking a visual treatment.
 */
const DOCUMENT_STATUS_STYLES: Record<DocumentStatus, DocumentStatusStyle> = {
  pending: {
    classes: "bg-muted text-muted-foreground border-border",
    icon: Loader2,
  },
  pending_review: {
    classes: "bg-accent/10 text-accent border-accent/20",
    icon: Clock,
  },
  verified: {
    classes: "bg-primary text-primary-foreground border-transparent",
    icon: CheckCircle2,
  },
  rejected: {
    classes: "bg-destructive/10 text-destructive border-destructive/20",
    icon: XCircle,
  },
  expired: {
    classes: "bg-muted text-muted-foreground border-border",
    icon: AlertCircle,
  },
};

export interface DocumentStatusBadgeProps {
  status: DocumentStatus;
  className?: string;
}

export function DocumentStatusBadge({
  status,
  className,
}: DocumentStatusBadgeProps) {
  const style = DOCUMENT_STATUS_STYLES[status];
  const Icon = style.icon;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        style.classes,
        className,
      )}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {DOCUMENT_STATUS_LABELS[status]}
    </span>
  );
}
