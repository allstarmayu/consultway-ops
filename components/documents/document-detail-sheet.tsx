/**
 * Side-sheet showing a single document's full detail.
 *
 * Client Component. Owns its open state and lazy-fetches enriched
 * detail (uploader + reviewer names) via `getDocumentDetail` the first
 * time it's opened for a given document. Subsequent opens of the same
 * document reuse the cached fetch.
 *
 * Why lazy fetch:
 *   The documents-list row already has the Document fields it needs
 *   for the row layout. The sheet adds uploader/reviewer human names,
 *   which requires two extra point reads against the users table.
 *   Fetching that for every row at list time would be wasteful — only
 *   a small fraction of rows ever get their detail opened.
 *
 * Why one sheet per row (vs. a single global sheet driven by a doc id):
 *   Co-locating the trigger and content keeps Radix's focus management
 *   simple (the close re-focuses the trigger automatically) and means
 *   each row's "View details" button is its own keyboard-discoverable
 *   affordance. The component is small enough that the per-row cost
 *   is negligible.
 *
 * Redaction: `getDocumentDetail` already strips `reviewNotes` to null
 * for company-role callers, so the "Review notes" section here just
 * conditionally renders on non-null without needing to know the role.
 *
 * @module components/documents/document-detail-sheet
 */
"use client";

import * as React from "react";
import { Eye, FileText, Loader2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { DocumentTypeBadge } from "@/components/documents/document-type-badge";
import { DocumentStatusBadge } from "@/components/documents/document-status-badge";
import { DocumentDownloadButton } from "@/components/documents/document-download-button";
import {
  getDocumentDetail,
  type DocumentDetail,
} from "@/lib/documents/reads";
import type { Document } from "@/lib/db/schema";

// ── Props ──────────────────────────────────────────────────────────────────

export interface DocumentDetailSheetProps {
  /**
   * Row this sheet is for. The fields here populate the sheet
   * immediately on open; uploader/reviewer names stream in from the
   * lazy `getDocumentDetail` call.
   */
  document: Document;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** ISO-8601 (any precision) → "5 Mar 2026" en-IN. */
function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Bytes → "1.2 MB" / "640 KB" / "942 B". */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Days between two YYYY-MM-DD strings, anchored at UTC midnight.
 * Negative ⇒ first arg is after second. Same shape as the list row's
 * helper but inlined here to avoid coupling the two components.
 */
function daysBetween(from: string, to: string): number {
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((toMs - fromMs) / (1000 * 60 * 60 * 24));
}

/**
 * Human "expires in N days" / "expired N days ago" affordance.
 * Same rules as the list-row variant.
 */
function expirySummary(expiresAt: string | null): {
  text: string;
  tone: "muted" | "warning" | "destructive";
} {
  if (!expiresAt) return { text: "No expiry date", tone: "muted" };

  const today = new Date().toISOString().slice(0, 10);
  const delta = daysBetween(today, expiresAt);

  if (delta < 0) {
    const days = Math.abs(delta);
    return {
      text: `Expired ${days} ${days === 1 ? "day" : "days"} ago`,
      tone: "destructive",
    };
  }
  if (delta === 0) {
    return { text: "Expires today", tone: "destructive" };
  }
  if (delta <= 30) {
    return {
      text: `Expires in ${delta} ${delta === 1 ? "day" : "days"}`,
      tone: "warning",
    };
  }
  return {
    text: `Expires in ${delta} days`,
    tone: "muted",
  };
}

// ── Component ──────────────────────────────────────────────────────────────

export function DocumentDetailSheet({ document }: DocumentDetailSheetProps) {
  const [open, setOpen] = React.useState(false);
  const [detail, setDetail] = React.useState<DocumentDetail | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Lazy-fetch the enriched detail the first time the sheet opens.
  // Re-opening reuses the cached result; if the parent ever passes
  // a different document into this sheet instance (we don't today,
  // since each row owns its sheet), the cached detail's id wouldn't
  // match - the check below catches that.
  React.useEffect(() => {
    if (!open) return;
    if (detail && detail.document.id === document.id) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    getDocumentDetail({ documentId: document.id })
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setDetail({
          document: result.document,
          uploaderName: result.uploaderName,
          reviewerName: result.reviewerName,
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, document.id, detail]);

  // The sheet renders fields from the live detail when loaded, falling
  // back to the row data we already have (so the layout is populated
  // immediately on open and only the "Uploaded by / Reviewed by" lines
  // wait on the network).
  const liveDocument = detail?.document ?? document;
  const expiry = expirySummary(liveDocument.expiresAt);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`View details for ${document.fileName}`}
        >
          <Eye className="h-4 w-4" aria-hidden />
        </Button>
      </SheetTrigger>

      <SheetContent
        side="right"
        className="w-full overflow-y-auto sm:max-w-md"
      >
        <SheetHeader>
          <SheetTitle className="flex items-start gap-2 pr-8">
            <FileText
              className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <span className="break-words">{document.fileName}</span>
          </SheetTitle>
          <SheetDescription>
            Document details and review history.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-5 px-4 pb-4">
          {/* Type + status badges */}
          <div className="flex flex-wrap items-center gap-2">
            <DocumentTypeBadge type={liveDocument.documentType} />
            <DocumentStatusBadge status={liveDocument.status} />
          </div>

          {/* File facts */}
          <DetailGroup title="File">
            <DetailRow label="Size" value={formatSize(liveDocument.sizeBytes)} />
            <DetailRow label="Type" value={liveDocument.mimeType} mono />
          </DetailGroup>

          {/* Validity dates */}
          <DetailGroup title="Validity">
            <DetailRow
              label="Issued on"
              value={formatDate(liveDocument.issuedOn) ?? "—"}
            />
            <DetailRow
              label="Expires"
              value={
                <span
                  className={
                    expiry.tone === "destructive"
                      ? "font-medium text-destructive"
                      : expiry.tone === "warning"
                        ? "font-medium text-accent"
                        : "text-muted-foreground"
                  }
                >
                  {expiry.text}
                </span>
              }
            />
          </DetailGroup>

          {/* Uploader + reviewer */}
          <DetailGroup title="Audit">
            <DetailRow
              label="Uploaded"
              value={
                <span>
                  {loading && !detail ? (
                    <Loader2
                      className="inline h-3 w-3 animate-spin text-muted-foreground"
                      aria-label="Loading uploader"
                    />
                  ) : (
                    <>
                      {detail?.uploaderName ?? "Unknown user"} ·{" "}
                      {formatDate(liveDocument.uploadedAt)}
                    </>
                  )}
                </span>
              }
            />
            {liveDocument.reviewedAt && (
              <DetailRow
                label="Reviewed"
                value={
                  <span>
                    {loading && !detail ? (
                      <Loader2
                        className="inline h-3 w-3 animate-spin text-muted-foreground"
                        aria-label="Loading reviewer"
                      />
                    ) : (
                      <>
                        {detail?.reviewerName ?? "Unknown user"} ·{" "}
                        {formatDate(liveDocument.reviewedAt)}
                      </>
                    )}
                  </span>
                }
              />
            )}
          </DetailGroup>

          {/* Review notes - only shown when present. Server-side
              redaction in `getDocumentDetail` ensures company-role
              callers see this as null. */}
          {liveDocument.reviewNotes && (
            <DetailGroup title="Review notes">
              <p className="whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 text-sm text-foreground">
                {liveDocument.reviewNotes}
              </p>
            </DetailGroup>
          )}

          {error && (
            <Alert variant="destructive">
              <AlertTitle>Couldn&apos;t load full details</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Download CTA. Only shown when bytes are actually in R2 -
              same `pending` guard as the row's download button. */}
          {liveDocument.status !== "pending" && (
            <div className="pt-2">
              <DocumentDownloadButton
                documentId={liveDocument.id}
                fileName={liveDocument.fileName}
              />
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── Internal layout primitives ─────────────────────────────────────────────

/** Section wrapper with a small uppercase label and stacked rows. */
function DetailGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <div className="flex flex-col gap-1.5">{children}</div>
    </section>
  );
}

/** Single key/value row inside a DetailGroup. */
function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span
        className={
          mono
            ? "break-all text-right font-mono text-xs text-foreground"
            : "break-words text-right text-foreground"
        }
      >
        {value}
      </span>
    </div>
  );
}
