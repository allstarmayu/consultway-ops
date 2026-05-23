/**
 * Upload-document form - shared between the dedicated upload page and
 * (later) any in-place upload surfaces.
 *
 * Client Component. Owns the three-stage upload state machine that
 * backs the two-step direct-to-R2 flow:
 *
 *   idle -> initiating -> uploading -> confirming -> success
 *                                                 -> error (with retry)
 *
 * Stage breakdown:
 *
 *   - initiating: call `initiateDocumentUpload` Server Action. Server
 *     validates input, inserts a pending DB row, returns
 *     { documentId, uploadUrl, mimeType, expiresInSeconds }.
 *   - uploading:  browser PUTs the file bytes directly to R2 using the
 *     presigned URL. We DO NOT proxy through our server - that's the
 *     whole point of this design.
 *   - confirming: call `confirmDocumentUpload` Server Action with the
 *     documentId we got back from initiate. Server flips the row from
 *     `pending` to `pending_review` and writes the `document_uploaded`
 *     audit event.
 *   - success:    show a brief success banner, then redirect back to
 *     the company detail page on a short delay so the user sees that
 *     bytes actually landed before navigation.
 *
 * Errors at any stage land in the `error` slot with enough context for
 * the user to retry without re-picking the file (cheap UX win - re-
 * picking a 5 MB PDF is annoying).
 *
 * Validation: same Zod schema (`initiateDocumentUploadSchema`) the
 * server uses, applied client-side via react-hook-form's resolver. The
 * file picker carries its own additional rules:
 *   - allowed MIME types (matches ALLOWED_MIME_TYPES from the schema)
 *   - size cap (matches MAX_UPLOAD_SIZE_BYTES from the schema)
 * Both are enforced pre-flight so the user doesn't wait through an
 * upload for the server to reject.
 *
 * Architecture mirrors company-form.tsx:
 *   - Inline Zod resolver (avoids @hookform/resolvers + Zod 4 friction)
 *   - On-blur validation per field
 *   - StickyActionBar at the bottom
 *   - Unsaved-changes guard while a file is picked and not yet uploaded
 *
 * @module components/documents/upload-form
 */
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { AlertCircle, CheckCircle2, Upload, X } from "lucide-react";
import {
  initiateDocumentUpload,
  confirmDocumentUpload,
} from "@/lib/documents/actions";
import {
  initiateDocumentUploadSchema,
  type InitiateDocumentUploadInput,
  ALLOWED_MIME_TYPES,
  MAX_UPLOAD_SIZE_BYTES,
} from "@/lib/documents/schemas";
import { DOCUMENT_TYPE_LABELS } from "@/lib/documents/labels";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { FormSection } from "@/components/forms/form-section";
import { FormField } from "@/components/forms/form-field";
import { StickyActionBar } from "@/components/forms/sticky-action-bar";
import { useUnsavedChangesGuard } from "@/components/forms/use-unsaved-changes-guard";

// ── Props ───────────────────────────────────────────────────────────────────

export interface UploadDocumentFormProps {
  /** Owning company. Server-fetched and authorised in the parent page. */
  companyId: string;
  /** Display name - used in the success message and the Cancel link copy. */
  companyName: string;
}

// ── Form value shape ────────────────────────────────────────────────────────

/**
 * The form manages a subset of `InitiateDocumentUploadInput`. Three
 * fields come from the picked File (fileName, mimeType, sizeBytes); the
 * companyId is fixed by the parent page. The user-driven fields here
 * are documentType, issuedOn, expiresAt - plus the File itself, which
 * RHF treats as a special-case via a `file` field.
 */
interface FormValues {
  documentType: InitiateDocumentUploadInput["documentType"];
  issuedOn: string;
  expiresAt: string;
  /**
   * The picked File. RHF doesn't natively understand File objects - we
   * register a hidden state slot and update it imperatively via the
   * file input's onChange. Not part of Zod validation; validated
   * separately via `validatePickedFile` below.
   */
  file: File | null;
}

const FORM_DEFAULTS: FormValues = {
  documentType: "gst_certificate",
  issuedOn: "",
  expiresAt: "",
  file: null,
};

// ── Upload stage state machine ──────────────────────────────────────────────

/**
 * The three-stage upload lifecycle. `idle` is the initial state and the
 * state we return to after a failed attempt (the user can retry without
 * re-picking the file). `success` is terminal - we redirect away from
 * it on a short delay.
 */
type UploadStage =
  | { kind: "idle" }
  | { kind: "initiating" }
  | { kind: "uploading"; documentId: string }
  | { kind: "confirming"; documentId: string }
  | { kind: "success"; documentId: string };

// ── Component ───────────────────────────────────────────────────────────────

export function UploadDocumentForm({
  companyId,
  companyName,
}: UploadDocumentFormProps) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [stage, setStage] = useState<UploadStage>({ kind: "idle" });
  const [isPending, startTransition] = useTransition();

  const {
    register,
    handleSubmit,
    setValue,
    setError,
    watch,
    clearErrors,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<FormValues>({
    defaultValues: FORM_DEFAULTS,
    mode: "onBlur",
    /**
     * Inline resolver. The dates + documentType go through the Zod
     * schema (re-using the server's `initiateDocumentUploadSchema`);
     * the picked File is validated separately via `validatePickedFile`
     * because Zod doesn't know about File objects.
     *
     * The schema also enforces the cross-field issuedOn <= expiresAt
     * rule, so we get that for free here.
     */
    resolver: async (raw) => {
      const errs: Record<string, { type: string; message: string }> = {};

      // 1. File validation (Zod can't handle File)
      const fileError = validatePickedFile(raw.file);
      if (fileError) {
        errs.file = { type: "client", message: fileError };
      }

      // 2. Schema validation (everything else)
      if (raw.file) {
        const schemaInput = {
          companyId,
          documentType: raw.documentType,
          fileName: raw.file.name,
          mimeType: raw.file.type,
          sizeBytes: raw.file.size,
          issuedOn: raw.issuedOn === "" ? null : raw.issuedOn,
          expiresAt: raw.expiresAt === "" ? null : raw.expiresAt,
        };
        const result = initiateDocumentUploadSchema.safeParse(schemaInput);
        if (!result.success) {
          for (const issue of result.error.issues) {
            // Map schema paths to form paths. fileName/mimeType/sizeBytes
            // all map to `file` since the user only sees the file slot.
            const schemaPath = issue.path.join(".");
            const formPath =
              schemaPath === "fileName" ||
              schemaPath === "mimeType" ||
              schemaPath === "sizeBytes"
                ? "file"
                : schemaPath;
            if (formPath && !errs[formPath]) {
              errs[formPath] = { type: issue.code, message: issue.message };
            }
          }
        }
      }

      if (Object.keys(errs).length > 0) {
        return { values: {}, errors: errs };
      }
      return { values: raw, errors: {} };
    },
  });

  // Watch the picked file for the file-name display below the input.
  const pickedFile = watch("file");

  // Block tab close / refresh while a file is picked and we haven't
  // succeeded yet. The success state is terminal, no point guarding it.
  useUnsavedChangesGuard(
    isDirty &&
      stage.kind !== "success" &&
      !isSubmitting &&
      !isPending,
  );

  // ── File picker handler ──────────────────────────────────────────────────

  /**
   * Manual onChange for the file input. RHF's `register` doesn't get
   * us the File object directly (it gets the FileList from the input's
   * value); we extract the first File and stuff it into the form state
   * via setValue. Also clears any prior file-related error so the user
   * sees a clean slate after re-picking.
   */
  function handleFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setValue("file", f, { shouldDirty: true, shouldValidate: true });
    clearErrors("file");
  }

  // ── Submit handler ───────────────────────────────────────────────────────
  //
  // Three async stages chained with explicit error handling at each
  // step. We can't use a single try/catch because the user benefits
  // from knowing WHICH stage failed (init vs upload vs confirm).

  async function onSubmit(values: FormValues) {
    setServerError(null);

    if (!values.file) {
      // Should have been caught by the resolver, but defensive.
      setError("file", { type: "client", message: "Please pick a file" });
      return;
    }

    const file = values.file;

    startTransition(async () => {
      // ── Stage 1: initiate ────────────────────────────────────────────
      setStage({ kind: "initiating" });
      const initResult = await initiateDocumentUpload({
        companyId,
        documentType: values.documentType,
        fileName: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        issuedOn: values.issuedOn === "" ? null : values.issuedOn,
        expiresAt: values.expiresAt === "" ? null : values.expiresAt,
      });

      if (!initResult.ok) {
        setStage({ kind: "idle" });
        if (initResult.field) {
          // Map server-side field names to form-field names. Same
          // mapping logic as the resolver.
          const formField =
            initResult.field === "fileName" ||
            initResult.field === "mimeType" ||
            initResult.field === "sizeBytes"
              ? "file"
              : initResult.field;
          setError(formField as keyof FormValues, {
            type: "server",
            message: initResult.error,
          });
        } else {
          setServerError(initResult.error);
        }
        return;
      }

      const { documentId, uploadUrl, mimeType } = initResult;

      // ── Stage 2: upload bytes to R2 ──────────────────────────────────
      // Direct browser-to-R2 PUT. The presigned URL embeds the signature;
      // the only header we need to set is Content-Type (must match what
      // sigv4 signed at init time, hence we use the server-returned
      // `mimeType` rather than the File's `type` - same value normally,
      // but defending against a stale File reference).
      setStage({ kind: "uploading", documentId });
      try {
        const putResp = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": mimeType },
          body: file,
        });
        if (!putResp.ok) {
          // R2 returned a structured error. Status + statusText is enough
          // detail for the user; the response body has XML we don't need
          // to surface verbatim.
          throw new Error(
            `R2 rejected the upload (${putResp.status} ${putResp.statusText})`,
          );
        }
      } catch (err) {
        setStage({ kind: "idle" });
        const msg =
          err instanceof Error
            ? err.message
            : "Upload to storage failed - please try again";
        setServerError(msg);
        return;
      }

      // ── Stage 3: confirm ─────────────────────────────────────────────
      setStage({ kind: "confirming", documentId });
      const confirmResult = await confirmDocumentUpload({ documentId });

      if (!confirmResult.ok) {
        setStage({ kind: "idle" });
        setServerError(confirmResult.error);
        return;
      }

      // ── Success ──────────────────────────────────────────────────────
      // Show the success state briefly so the user sees confirmation
      // before navigation. ~1.2s is long enough to register, short
      // enough not to feel like a stall.
      setStage({ kind: "success", documentId });
      setTimeout(() => {
        router.replace(`/dashboard/companies/${companyId}`);
        router.refresh();
      }, 1200);
    });
  }

  // ── Computed state for the render layer ─────────────────────────────────

  // Disabled whenever we're not in the user-input phase:
  //   - RHF says submitting (final synchronous tick before the action runs)
  //   - useTransition says pending (a server action is in flight)
  //   - we're past idle on the upload stage machine (initiating/uploading/
  //     confirming/success - even success keeps it disabled because we're
  //     about to redirect)
  const submitDisabled =
    isSubmitting || isPending || stage.kind !== "idle";

  const cancelHref = `/dashboard/companies/${companyId}`;

  // Stage-specific button label - tells the user where in the flow we are.
  const submitLabel = (() => {
    switch (stage.kind) {
      case "initiating":
        return "Preparing upload...";
      case "uploading":
        return "Uploading to storage...";
      case "confirming":
        return "Finalising...";
      case "success":
        return "Uploaded";
      case "idle":
      default:
        return "Upload document";
    }
  })();

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-8">
      {/* Success banner. Shown briefly before the redirect fires. */}
      {stage.kind === "success" && (
        <Alert>
          <CheckCircle2 className="h-4 w-4" />
          <AlertTitle>Document uploaded</AlertTitle>
          <AlertDescription>
            Awaiting review by Consultway staff. Returning to {companyName}...
          </AlertDescription>
        </Alert>
      )}

      {/* Top-of-form server error banner. Field errors render inline. */}
      {serverError && stage.kind === "idle" && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Could not upload document</AlertTitle>
          <AlertDescription>{serverError}</AlertDescription>
        </Alert>
      )}

      {/* Section 1: File ───────────────────────────────────────────────── */}
      <FormSection
        title="File"
        description="PDF, PNG, JPEG, or WEBP. Maximum 10 MB."
        layout="stack"
      >
        <FormField
          name="file"
          label="Document file"
          required
          error={errors.file?.message}
        >
          <div className="space-y-2">
            <Input
              id="file"
              type="file"
              accept={ALLOWED_MIME_TYPES.join(",")}
              disabled={submitDisabled}
              onChange={handleFilePicked}
              className="cursor-pointer"
            />
            {pickedFile && (
              <p className="text-xs text-muted-foreground">
                {pickedFile.name} ({formatBytes(pickedFile.size)})
              </p>
            )}
          </div>
        </FormField>
      </FormSection>

      {/* Section 2: Classification ─────────────────────────────────────── */}
      <FormSection
        title="Classification"
        description="What kind of document this is."
        layout="stack"
      >
        <FormField
          name="documentType"
          label="Document type"
          required
          error={errors.documentType?.message}
        >
          <Select
            defaultValue={FORM_DEFAULTS.documentType}
            disabled={submitDisabled}
            onValueChange={(v) =>
              setValue(
                "documentType",
                v as InitiateDocumentUploadInput["documentType"],
                { shouldDirty: true, shouldValidate: true },
              )
            }
          >
            <SelectTrigger id="documentType">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(
                Object.keys(DOCUMENT_TYPE_LABELS) as Array<
                  keyof typeof DOCUMENT_TYPE_LABELS
                >
              ).map((key) => (
                <SelectItem key={key} value={key}>
                  {DOCUMENT_TYPE_LABELS[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      </FormSection>

      {/* Section 3: Validity ──────────────────────────────────────────── */}
      <FormSection
        title="Validity"
        description="Optional. When the document was issued and when it expires. Used for expiry-reminder emails (coming soon)."
      >
        <FormField
          name="issuedOn"
          label="Issue date"
          description="Date format: YYYY-MM-DD"
          error={errors.issuedOn?.message}
        >
          <Input
            type="date"
            disabled={submitDisabled}
            {...register("issuedOn")}
          />
        </FormField>

        <FormField
          name="expiresAt"
          label="Expiry date"
          description="Leave blank if the document does not expire"
          error={errors.expiresAt?.message}
        >
          <Input
            type="date"
            disabled={submitDisabled}
            {...register("expiresAt")}
          />
        </FormField>
      </FormSection>

      {/* Sticky bottom action bar */}
      <StickyActionBar
        helper={
          <span>
            <span aria-hidden className="text-destructive">
              *
            </span>{" "}
            indicates a required field
          </span>
        }
      >
        <Button
          type="button"
          variant="outline"
          disabled={submitDisabled}
          onClick={() => router.push(cancelHref)}
        >
          <X className="h-4 w-4" aria-hidden />
          Cancel
        </Button>
        <Button type="submit" disabled={submitDisabled}>
          <Upload className="h-4 w-4" aria-hidden />
          {submitLabel}
        </Button>
      </StickyActionBar>
    </form>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Pre-flight file validation. Returns an error message string or null
 * if the file is OK. Mirrors the constraints in the Zod schema:
 *   - file must be present
 *   - MIME type must be in the allow-list
 *   - size must be positive and under MAX_UPLOAD_SIZE_BYTES
 *
 * Runs client-side only - the server applies the SAME checks via Zod
 * in `initiateDocumentUpload`. This is purely UX - tell the user
 * before they wait through an upload that we'd reject.
 */
function validatePickedFile(file: File | null): string | null {
  if (!file) {
    return "Please pick a file";
  }
  if (
    !(ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)
  ) {
    return `File type "${file.type || "unknown"}" is not allowed. Use PDF, PNG, JPEG, or WEBP.`;
  }
  if (file.size === 0) {
    return "File is empty";
  }
  if (file.size > MAX_UPLOAD_SIZE_BYTES) {
    return `File is too large (${formatBytes(file.size)}). Maximum is ${formatBytes(MAX_UPLOAD_SIZE_BYTES)}.`;
  }
  return null;
}

/**
 * Format a byte count in human-readable form. Used for the picked-file
 * size display and for error messages.
 *
 * Inline rather than imported from a shared util because no other
 * surface in the app needs this yet. If a second consumer appears,
 * lift to lib/format/bytes.ts at that point.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
