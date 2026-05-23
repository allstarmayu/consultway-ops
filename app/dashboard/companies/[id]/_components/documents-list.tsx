/**
 * Documents list - renders one row per document.
 *
 * Server Component. Pure presentation over an already-fetched array of
 * `Document` rows. The fetching + role-scoping happens upstream in
 * `documents-section.tsx`.
 *
 * Per-row layout (left to right):
 *   - filename (clickable later when a detail view lands; static for now)
 *   - type badge
 *   - status badge
 *   - uploaded "N days ago" / formatted date
 *   - expiry affordance ("expires in N days", "expired N days ago",
 *     "no expiry") - colored by urgency for verified rows
 *   - Download button (client component)
 *   - placeholder slot for staff Verify / Reject / Delete affordances
 *     (filled in Chunk 2)
 *
 * Why no Table component here:
 *   The companies list uses a sortable, paginated DataTable because the
 *   roster grows large. The per-company documents list is bounded (<20
 *   rows per company at Phase 1) and the row content is content-rich
 *   (status badge, expiry pill, action buttons) which doesn't fit a
 *   compact columnar layout well. A vertical-rhythm card list reads
 *   better at this density.
 *
 * @module app/dashboard/companies/[id]/_components/documents-list
 */
import type { Document, UserRole } from "@/lib/db/schema";
import { DocumentTypeBadge } from "@/components/documents/document-type-badge";
import { DocumentStatusBadge } from "@/components/documents/document-status-badge";
import { DocumentDownloadButton } from "@/components/documents/document-download-button";
import { DocumentRowActions } from "@/components/documents/document-row-actions";

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Days between two ISO date strings, treating both as UTC midnight.
 * Negative means `from` is after `to`. Used for the expiry affordance.
 *
 * Both inputs are "YYYY-MM-DD" - the expiresAt column is a date-only
 * string per the schema. Today is computed from the server's clock
 * (this is a Server Component); we deliberately use UTC to keep the
 * comparison timezone-stable.
 */
function daysBetween(from: string, to: string): number {
  // Date.UTC handles the YYYY-MM-DD shape natively because the missing
  // time defaults to 00:00:00 UTC.
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((toMs - fromMs) / (1000 * 60 * 60 * 24));
}

/**
 * Format an ISO-8601 UTC timestamp as a short human-readable date for
 * the "uploaded on" affordance. Server-side rendering, so we use a
 * fixed en-IN locale to keep output deterministic across deploys.
 */
function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * Format size in bytes as a short string. PDFs sit in the 50 KB - 5 MB
 * range typically; precision beyond one decimal place is noise.
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Expiry affordance ──────────────────────────────────────────────────────

/**
 * Coloured small-text affordance summarising a document's expiry.
 *
 * Variants:
 *   - null `expiresAt`             -> "No expiry" (muted)
 *   - already past `expiresAt`     -> "Expired N days ago" (destructive)
 *   - within 30 days of expiry     -> "Expires in N days" (accent / warning)
 *   - more than 30 days out        -> "Expires in N days" (muted)
 *
 * Day 10 cron will flip status -> expired once `expiresAt` passes, so
 * the "Expired N days ago" branch only fires while the cron hasn't
 * run yet (or for rows the cron explicitly skipped).
 */
function ExpiryAffordance({ expiresAt }: { expiresAt: string | null }) {
  if (!expiresAt) {
    return (
      <span className="text-xs text-muted-foreground">No expiry</span>
    );
  }

  // Today as YYYY-MM-DD in UTC. Matches the storage format.
  const today = new Date().toISOString().slice(0, 10);
  const delta = daysBetween(today, expiresAt);

  if (delta < 0) {
    const days = Math.abs(delta);
    return (
      <span className="text-xs font-medium text-destructive">
        Expired {days} {days === 1 ? "day" : "days"} ago
      </span>
    );
  }

  if (delta === 0) {
    return (
      <span className="text-xs font-medium text-destructive">
        Expires today
      </span>
    );
  }

  const urgent = delta <= 30;
  return (
    <span
      className={
        urgent
          ? "text-xs font-medium text-accent"
          : "text-xs text-muted-foreground"
      }
    >
      Expires in {delta} {delta === 1 ? "day" : "days"}
    </span>
  );
}

// ── Component ──────────────────────────────────────────────────────────────

export interface DocumentsListProps {
  documents: Document[];

  /**
   * Session role threaded down from the page. Drives visibility of
   * the verify / reject / delete affordances per the RBAC matrix.
   * Resolved once at the page level so each row doesn't re-read the
   * session.
   */
  viewerRole: UserRole;
}

export function DocumentsList({ documents, viewerRole }: DocumentsListProps) {
  return (
    <ul className="divide-y divide-border">
      {documents.map((doc) => (
        <li
          key={doc.id}
          className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
        >
          {/* Left: filename + meta */}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p
                className="truncate text-sm font-medium text-foreground"
                title={doc.fileName}
              >
                {doc.fileName}
              </p>
              <DocumentTypeBadge type={doc.documentType} />
              <DocumentStatusBadge status={doc.status} />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>Uploaded {formatDate(doc.uploadedAt)}</span>
              <span aria-hidden>·</span>
              <span>{formatSize(doc.sizeBytes)}</span>
              <span aria-hidden>·</span>
              <ExpiryAffordance expiresAt={doc.expiresAt} />
            </div>
          </div>

          {/* Right: actions. Download appears for any row whose bytes
              actually landed in R2 (status !== "pending"). The review
              cluster (verify / reject / delete) self-gates on role +
              status inside <DocumentRowActions> and renders nothing
              when neither affordance is allowed - so we don't need a
              wrapper conditional here. */}
          <div className="flex shrink-0 items-center gap-2">
            {doc.status !== "pending" && (
              <DocumentDownloadButton
                documentId={doc.id}
                fileName={doc.fileName}
              />
            )}
            <DocumentRowActions document={doc} viewerRole={viewerRole} />
          </div>
        </li>
      ))}
    </ul>
  );
}
