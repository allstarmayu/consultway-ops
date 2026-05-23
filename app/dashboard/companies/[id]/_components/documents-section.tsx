/**
 * Documents section on the company detail page.
 *
 * Server Component. Wraps the documents list in a section header that
 * shows the count + the Upload button (role-gated). Handles the three
 * branches the action can return:
 *
 *   - ok with rows         -> render <DocumentsList>
 *   - ok with empty array  -> empty state + primary Upload button (when
 *                              authorised)
 *   - !ok                  -> Alert with the error message
 *
 * Loading is handled by the parent page wrapping this component in
 * `<Suspense fallback={<DocumentsSectionLoading />}>`. The fetch happens
 * inside this component so Suspense streams it independently of the
 * overview card above.
 *
 * Why "section" and not "tab":
 *   Phase 1 has exactly one tab worth of content on the company detail
 *   page (the overview card already there). Promoting to a tabs layout
 *   means adding navigation state for a single peer - all cost, no
 *   benefit. When a second tab worth of content lands (Projects?
 *   Applications?), revisit.
 *
 * @module app/dashboard/companies/[id]/_components/documents-section
 */
import Link from "next/link";
import { FileText, Filter, Upload } from "lucide-react";
import { listDocumentsForCompany } from "@/lib/documents/reads";
import type {
  DocumentStatus,
  DocumentType,
  UserRole,
} from "@/lib/db/schema";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { DocumentsList } from "./documents-list";
import { DocumentsFiltersBar } from "./documents-filters-bar";

// ── Props ──────────────────────────────────────────────────────────────────

export interface DocumentsSectionProps {
  companyId: string;
  /**
   * Whether the viewer may upload a document for this company. Drives
   * the header Upload button and the empty-state CTA visibility.
   * Computed by the parent page from session role + companyId per the
   * RBAC matrix.
   */
  canUploadDocument: boolean;

  /**
   * Session role. Threaded down to per-row action clusters
   * (`DocumentRowActions`) which use it to decide which verify /
   * reject / delete affordances to render.
   */
  viewerRole: UserRole;

  /**
   * Optional status filter from `?documentStatus=...` in the URL.
   * Passed through to `listDocumentsForCompany`; that action's Zod
   * schema validates it against the `DocumentStatus` enum, so an
   * unknown value surfaces as a typed validation error rather than a
   * runtime crash.
   */
  statusFilter?: DocumentStatus;

  /**
   * Optional document-type filter from `?documentType=...` in the URL.
   * Same validation guarantees as `statusFilter`.
   */
  documentTypeFilter?: DocumentType;
}

// ── Component ──────────────────────────────────────────────────────────────

export async function DocumentsSection({
  companyId,
  canUploadDocument,
  viewerRole,
  statusFilter,
  documentTypeFilter,
}: DocumentsSectionProps) {
  const result = await listDocumentsForCompany({
    companyId,
    status: statusFilter,
    documentType: documentTypeFilter,
  });

  const filtersActive =
    statusFilter !== undefined || documentTypeFilter !== undefined;

  // Error branch. Includes "Company not found" for company-role users
  // hitting a row they're not entitled to - but the page-level
  // getCompany check upstream would have already redirected them, so
  // realistically this only fires on infrastructure errors.
  if (!result.ok) {
    return (
      <Card className="mt-4 overflow-hidden p-0">
        <SectionHeader
          count={null}
          companyId={companyId}
          canUploadDocument={canUploadDocument}
        />
        <div className="p-4">
          <Alert variant="destructive">
            <AlertTitle>Couldn&apos;t load documents</AlertTitle>
            <AlertDescription>{result.error}</AlertDescription>
          </Alert>
        </div>
      </Card>
    );
  }

  const { rows, total } = result;
  const uploadHref = `/dashboard/companies/${companyId}/documents/new`;

  return (
    <Card className="mt-4 overflow-hidden p-0">
      <SectionHeader
        count={total}
        companyId={companyId}
        canUploadDocument={canUploadDocument}
      />

      <DocumentsFiltersBar />

      {rows.length === 0 ? (
        // Empty state. Three flavours:
        //   - filters active + 0 matches  -> "no documents match" + clear hint
        //   - no docs + can upload        -> primary CTA
        //   - no docs + read-only         -> muted line only
        // Practically only company-role-without-link sees the read-only
        // no-docs flavour; admin/staff/own-company-user all can upload.
        <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
          <div className="rounded-full bg-muted p-3">
            {filtersActive ? (
              <Filter
                className="h-6 w-6 text-muted-foreground"
                aria-hidden
              />
            ) : (
              <FileText
                className="h-6 w-6 text-muted-foreground"
                aria-hidden
              />
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {filtersActive
              ? "No documents match the current filters."
              : "No documents uploaded yet."}
          </p>
          {!filtersActive && canUploadDocument && (
            <Button asChild variant="default" size="sm">
              <Link href={uploadHref}>
                <Upload className="h-3.5 w-3.5" aria-hidden />
                Upload document
              </Link>
            </Button>
          )}
        </div>
      ) : (
        <DocumentsList documents={rows} viewerRole={viewerRole} />
      )}
    </Card>
  );
}

// ── SectionHeader ──────────────────────────────────────────────────────────

/**
 * The header strip - "Documents (N)" on the left, Upload button on the
 * right. Mirrors `EntityHistoryLoading`'s header geometry so the two
 * sections feel related.
 *
 * `count = null` is used by the error branch to avoid showing a count
 * the row never fetched.
 */
function SectionHeader({
  count,
  companyId,
  canUploadDocument,
}: {
  count: number | null;
  companyId: string;
  canUploadDocument: boolean;
}) {
  const uploadHref = `/dashboard/companies/${companyId}/documents/new`;

  return (
    <div className="flex items-center justify-between border-b border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <FileText className="h-4 w-4 text-muted-foreground" aria-hidden />
        <h2 className="text-base font-semibold text-foreground">
          Documents
          {count !== null && (
            <span className="ml-1.5 text-sm font-normal text-muted-foreground">
              ({count})
            </span>
          )}
        </h2>
      </div>

      {canUploadDocument && (
        <Button asChild variant="outline" size="sm">
          <Link href={uploadHref}>
            <Upload className="h-3.5 w-3.5" aria-hidden />
            Upload document
          </Link>
        </Button>
      )}
    </div>
  );
}
