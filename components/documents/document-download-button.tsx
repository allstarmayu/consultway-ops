/**
 * Inline "Download" button for a document row.
 *
 * Client Component. Tiny state machine:
 *
 *   idle -> minting -> success (open URL in new tab, success toast,
 *                                return to idle)
 *                   -> error  (error toast, return to idle on retry)
 *
 * Calls `generateDocumentDownloadUrl` Server Action which RBAC-gates
 * the request and returns a 5-minute presigned R2 GET URL. We open the
 * URL in a new tab via `window.open(..., "_blank")` so the user stays
 * on the documents list - same UX a typical "Download" button gives
 * elsewhere (Drive, GitHub release assets).
 *
 * Status gating belongs to the parent: this component renders the
 * button assuming the row is downloadable. The server action also
 * refuses `pending` rows defensively, but the UI shouldn't show a
 * download button on a row that has no bytes in R2 anyway.
 *
 * @module components/documents/document-download-button
 */
"use client";

import { useTransition } from "react";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { generateDocumentDownloadUrl } from "@/lib/documents/reads";

export interface DocumentDownloadButtonProps {
  documentId: string;
  /** Display name shown via aria-label so screen readers know which file. */
  fileName: string;
}

export function DocumentDownloadButton({
  documentId,
  fileName,
}: DocumentDownloadButtonProps) {
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    startTransition(async () => {
      const result = await generateDocumentDownloadUrl({ documentId });
      if (!result.ok) {
        toast.error("Could not prepare download", {
          description: result.error,
        });
        return;
      }

      // Open in a new tab. R2 streams the bytes with the stored
      // Content-Type so PDFs render inline; the browser falls back to
      // download for non-previewable types. We deliberately don't
      // synthesize an <a download="..."> click - presigned URLs already
      // carry the bucket-side filename via the key and most browsers
      // honour that.
      window.open(result.url, "_blank", "noopener,noreferrer");

      toast.success("Download ready", {
        description: `Opening ${fileName} in a new tab.`,
      });
    });
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={handleClick}
      disabled={isPending}
      aria-label={`Download ${fileName}`}
    >
      {isPending ? (
        <>
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          Preparing...
        </>
      ) : (
        <>
          <Download className="h-3.5 w-3.5" aria-hidden />
          Download
        </>
      )}
    </Button>
  );
}
