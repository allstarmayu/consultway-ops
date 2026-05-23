/**
 * Zod schemas for the documents module.
 *
 * Lives in a non-"use server" file so both client and server can import
 * these and call `.parse()` / `.safeParse()`. Server Actions in
 * `./actions.ts` re-validate every input with these same schemas - never
 * trust client validation alone.
 *
 * Schemas exported here:
 *   - initiateDocumentUploadSchema  - kick off the two-step upload flow
 *   - confirmDocumentUploadSchema   - flip status pending -> pending_review
 *   - documentTypeSchema            - mirrors the DocumentType union
 *   - documentStatusSchema          - mirrors the DocumentStatus union
 *
 * Two-step upload flow (see lib/db/schema.ts::documents for full
 * rationale): the client first calls `initiateDocumentUpload` which
 * inserts a row with status='pending' and returns a presigned PUT URL.
 * The client streams bytes directly to R2 with that URL, then calls
 * `confirmDocumentUpload` to flip the row to status='pending_review'
 * (the state docs/05-database-schema.md considers the initial state).
 *
 * @module lib/documents/schemas
 */
import { z } from "zod";

// ── Reusable primitive schemas ──────────────────────────────────────────────

/** UUID v7 looks just like v4 to a regex - both are 8-4-4-4-12 hex. */
const uuidSchema = z.string().uuid("Invalid identifier");

/**
 * ISO-8601 date (YYYY-MM-DD). Used for `issuedOn` and `expiresAt`.
 * Matches the date-only convention established in `tenders.openingDate`
 * and `tenders.closingDate` - server treats these as opaque strings,
 * sort/compare lexicographically.
 */
const isoDateSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}$/,
    "Enter a valid date in YYYY-MM-DD format",
  );

// ── Document type enum (mirrors lib/db/schema.ts DocumentType) ──────────────

/**
 * Reproduces the `DocumentType` union from the DB schema as a Zod enum.
 * Kept in sync manually - if a new value is added to the type in
 * lib/db/schema.ts, add it here too. Same convention as
 * `complianceStatusSchema` in the companies module.
 *
 * The seven values match `docs/05-database-schema.md`. If the brief's
 * MSME cert / balance sheet / bank statement need to land later, widen
 * here AND in the DocumentType union AND apply a migration.
 */
export const documentTypeSchema = z.enum([
  "gst_certificate",
  "pan_card",
  "incorporation_cert",
  "board_resolution",
  "cancelled_cheque",
  "trade_license",
  "other",
]);

// ── Document status enum (mirrors lib/db/schema.ts DocumentStatus) ──────────

/**
 * Reproduces the `DocumentStatus` union. Five values:
 *   - pending         - row inserted, R2 PUT not yet confirmed (Day 9)
 *   - pending_review  - upload confirmed, awaiting staff review
 *   - verified        - staff approved
 *   - rejected        - staff rejected, re-upload allowed
 *   - expired         - past expiresAt, set by cron (Day 10+)
 *
 * Not directly used by the Day 9 actions but exported for client-side
 * use (status badges, filters) once the Day 10 list/detail UI lands.
 */
export const documentStatusSchema = z.enum([
  "pending",
  "pending_review",
  "verified",
  "rejected",
  "expired",
]);

// ── Upload limits ───────────────────────────────────────────────────────────

/**
 * Maximum upload size in bytes. 10 MB is generous for the document
 * types we care about (PDFs of certificates, scanned images) without
 * being so large that a slow Indian-mobile-network upload times out
 * on R2's 5-minute presigned URL window.
 *
 * Enforced at two layers:
 *   1. Zod schema here - rejects oversize requests before we mint the
 *      presigned URL. Saves a round-trip.
 *   2. R2 itself - the presigned URL contains a content-length-range
 *      condition (not yet wired; see chunk-3 followup note in the day
 *      report). Worth doing when we add malicious-upload hardening.
 *
 * Exported so the client-side file picker (Chunk 4) can apply the same
 * limit pre-flight.
 */
export const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * Allowed MIME types for document uploads. PDF dominates real usage;
 * the image types cover photographed-paper-document edge cases (e.g.
 * a trade license that was never digitised, photographed from a wall).
 *
 * Conservative list on purpose: each new type widens our attack surface
 * (image bombs, malformed PDFs) so additions should be deliberate.
 * Excluded: SVG (script injection vector), HEIC (Apple-specific, would
 * need server-side conversion for cross-platform viewing), GIF (low
 * value for document scans), TIFF (browser support is patchy).
 *
 * Exported so the client-side file picker can show a sensible "accept"
 * attribute and reject early.
 */
export const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

/** Zod schema form of the MIME-type allow-list. */
const mimeTypeSchema = z.enum(ALLOWED_MIME_TYPES);

// ── initiateDocumentUpload ──────────────────────────────────────────────────

/**
 * Input schema for `initiateDocumentUpload`.
 *
 * Design notes:
 *   - `companyId` is provided by the caller (the upload is on behalf
 *     of a specific company). The action layer cross-checks the caller's
 *     authority over that companyId - admin/staff for any company,
 *     company-role only for own.
 *   - `fileName` is the original filename as supplied by the client.
 *     Sanitised before becoming part of the R2 key (see
 *     `lib/r2/keys.ts::sanitizeFilename`). The original is preserved
 *     in the `fileName` column for display + Content-Disposition.
 *   - `sizeBytes` is what the client claims the file is. The action
 *     uses this for the size cap; R2 enforces nothing at sign time
 *     (the presigned PUT just signs Content-Type, not Content-Length).
 *     A misbehaving client could upload a bigger file than declared;
 *     for Phase 1 we accept that risk. Long-term fix is signing a
 *     content-length-range condition into the URL (tracked).
 *   - `mimeType` is bound into the presigned URL. The client MUST send
 *     the same value on the actual PUT or R2 rejects with
 *     SignatureDoesNotMatch.
 *   - `issuedOn` / `expiresAt` are optional. Issuer-side dates - the
 *     UI may not know them at upload time and they can be filled in
 *     later via a Day 10+ edit flow.
 *   - Cross-field: if both are present, `expiresAt` must be on or
 *     after `issuedOn`. Same superRefine pattern as
 *     `tenders.openingDate` / `closingDate`.
 */
export const initiateDocumentUploadSchema = z
  .object({
    companyId: uuidSchema,

    documentType: documentTypeSchema,

    fileName: z
      .string()
      .trim()
      .min(1, "File name is required")
      .max(255, "File name must be 255 characters or fewer"),

    mimeType: mimeTypeSchema,

    sizeBytes: z.coerce
      .number()
      .int("File size must be a whole number of bytes")
      .positive("File size must be positive")
      .max(
        MAX_UPLOAD_SIZE_BYTES,
        `File must be ${MAX_UPLOAD_SIZE_BYTES / (1024 * 1024)} MB or smaller`,
      ),

    issuedOn: isoDateSchema.optional().nullable(),

    expiresAt: isoDateSchema.optional().nullable(),
  })
  .superRefine((data, ctx) => {
    if (data.issuedOn && data.expiresAt && data.issuedOn > data.expiresAt) {
      ctx.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Expiry date must be on or after the issue date",
      });
    }
  });

export type InitiateDocumentUploadInput = z.infer<
  typeof initiateDocumentUploadSchema
>;

// ── confirmDocumentUpload ───────────────────────────────────────────────────

/**
 * Input schema for `confirmDocumentUpload`.
 *
 * Minimal payload - the document id is all the client needs to send.
 * The action layer loads the row to verify ownership, current status
 * (must be `pending`), and to write the audit event with the right
 * before/after snapshots.
 *
 * Note: we do NOT take the R2 ETag or any "the upload definitely
 * succeeded" proof from the client. The contract is "client got a 200
 * back from R2, then calls this." If the client lies (calls confirm
 * without actually uploading), the row flips to pending_review but
 * the R2 key has no object - a subsequent download will 404. The
 * impact is bounded: the row is visible in the documents list but the
 * file can't be retrieved. Day 10+'s download UI surfaces this clearly.
 * Pursuing a HEAD-against-R2 verification step on confirm would cost
 * a round-trip per upload for marginal benefit.
 */
export const confirmDocumentUploadSchema = z.object({
  documentId: uuidSchema,
});

export type ConfirmDocumentUploadInput = z.infer<
  typeof confirmDocumentUploadSchema
>;

// ── ID param ────────────────────────────────────────────────────────────────

/**
 * Single-id schema for routes like
 * `/dashboard/companies/[id]/documents/[documentId]`. Tiny but reused.
 */
export const documentIdSchema = z.object({ id: uuidSchema });

// ── listDocumentsForCompany ─────────────────────────────────────────────────

/**
 * Sort key for `listDocumentsForCompany`. Limited to columns we actually
 * index or that are cheap to sort at Phase 1 scale (<20 docs per company).
 *
 *   - `uploadedAt`   - chronological, the default. Most recent uploads first.
 *   - `expiresAt`    - "what's expiring soon?" view. Nulls (never-expire docs)
 *                      sort last under SQLite's default NULLs-LAST behaviour
 *                      when ordering DESC, and first when ASC. Acceptable for
 *                      Phase 1; if a "never-expire shows first regardless of
 *                      direction" UX becomes desirable, swap to a CASE expr.
 *   - `documentType` - alphabetical by enum value. Groups same-type rows.
 *   - `status`       - groups by review state. Useful when a staff user wants
 *                      to see all `pending_review` rows first.
 */
export const documentSortBySchema = z.enum([
  "uploadedAt",
  "expiresAt",
  "documentType",
  "status",
]);

export type DocumentSortBy = z.infer<typeof documentSortBySchema>;

/**
 * Sort direction. Matches the companies module convention.
 */
export const documentSortDirSchema = z.enum(["asc", "desc"]);

export type DocumentSortDir = z.infer<typeof documentSortDirSchema>;

/**
 * Query schema for `listDocumentsForCompany`.
 *
 * Design notes:
 *   - `companyId` is required - the list is always company-scoped, even
 *     for admin/staff. There's no "all documents across the platform"
 *     view in Phase 1; the documents section lives on the company detail
 *     page and the URL already carries the companyId.
 *   - Filters compose with AND. Status + documentType are optional; both
 *     are mirrored from the DB enums via the existing
 *     `documentStatusSchema` / `documentTypeSchema`.
 *   - No pagination. Phase 1 companies have <20 docs each, so a single
 *     unfiltered LIST is cheap and the UX is "see everything at once."
 *     If volume grows past ~50 rows per company, add page/perPage at the
 *     same shape as `listCompaniesQuerySchema`.
 *   - Coerces nothing - this schema parses Server-Action input (a typed
 *     object), not URL search params. Filters bar in the UI translates
 *     query-string state into this object on the server side.
 */
export const listDocumentsForCompanyQuerySchema = z.object({
  companyId: uuidSchema,

  status: documentStatusSchema.optional(),

  documentType: documentTypeSchema.optional(),

  sortBy: documentSortBySchema.optional().default("uploadedAt"),

  sortDir: documentSortDirSchema.optional().default("desc"),
});

export type ListDocumentsForCompanyQuery = z.infer<
  typeof listDocumentsForCompanyQuerySchema
>;

// ── getDocumentDetail / generateDocumentDownloadUrl ─────────────────────────

/**
 * Both single-row actions (`getDocumentDetail`, `generateDocumentDownloadUrl`)
 * take the same shape: just a document id. Sharing one schema keeps the
 * Server-Action input parsing identical across the two and avoids the
 * "which of three near-identical schemas do I import" confusion.
 *
 * The id is the public-API surface (the URL the client knows about);
 * the action layer translates it into an authoritative row read.
 */
export const documentByIdInputSchema = z.object({
  documentId: uuidSchema,
});

export type DocumentByIdInput = z.infer<typeof documentByIdInputSchema>;

// ── Reason primitives ────────────────────────────────────────────────────────

/**
 * Reusable reason field. Same shape as `lib/tenders/schemas.ts`'s
 * reason primitives (kept duplicated rather than imported across module
 * boundaries because the tenders file declares them as non-exported).
 * If a third caller appears we should lift them to a shared module.
 *
 *   - optional: trim, 1-500 chars when present, otherwise undefined
 *   - required: trim, 5-500 chars, must be present
 *
 * 5-char floor on the required form matches the client-side gate baked
 * into `confirm-dialog.tsx`'s required-reason mode (kept in lockstep so
 * the two enforce the same minimum).
 */
const optionalReasonSchema = z
  .string()
  .trim()
  .min(1, "Reason cannot be empty if provided")
  .max(500, "Reason must be 500 characters or fewer")
  .optional()
  .nullable();

const requiredReasonSchema = z
  .string()
  .trim()
  .min(5, "Please give a brief reason (at least 5 characters)")
  .max(500, "Reason must be 500 characters or fewer");

// ── verifyDocument ──────────────────────────────────────────────────────────

/**
 * Input schema for `verifyDocument`. Admin/staff only - flips
 * `pending_review` -> `verified`, stamps reviewer + reviewedAt, and
 * captures optional reviewer notes (e.g. "scanned copy is legible,
 * issued by GST Maharashtra").
 *
 * Notes are optional because the common case is "looks good" with no
 * additional commentary worth storing.
 */
export const verifyDocumentSchema = z.object({
  documentId: uuidSchema,
  notes: optionalReasonSchema,
});

export type VerifyDocumentInput = z.infer<typeof verifyDocumentSchema>;

// ── rejectDocument ──────────────────────────────────────────────────────────

/**
 * Input schema for `rejectDocument`. Admin/staff only - flips
 * `pending_review` -> `rejected` and captures a REQUIRED reason in
 * `review_notes` so the uploader knows what to fix on re-upload.
 *
 * The reason floor is 5 chars (same as the tender reversal pattern).
 * Rejections without context are unhelpful and waste an upload cycle;
 * the schema enforces a brief explanation.
 */
export const rejectDocumentSchema = z.object({
  documentId: uuidSchema,
  reason: requiredReasonSchema,
});

export type RejectDocumentInput = z.infer<typeof rejectDocumentSchema>;

// ── deleteDocument ──────────────────────────────────────────────────────────

/**
 * Input schema for `deleteDocument`. Just an id - the action layer
 * reads the row to determine RBAC (admin always; company-role on own
 * `pending` or `rejected` only - see docs/08-rbac-matrix.md). No reason
 * field at the API surface; deletion is binary.
 *
 * Reuses `documentByIdInputSchema` indirectly via the same shape - we
 * declare it as a fresh schema so the type name is self-documenting at
 * call sites.
 */
export const deleteDocumentSchema = z.object({
  documentId: uuidSchema,
});

export type DeleteDocumentInput = z.infer<typeof deleteDocumentSchema>;
