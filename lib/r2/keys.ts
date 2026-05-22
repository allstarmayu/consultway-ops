/**
 * R2 object-key construction and filename sanitisation.
 *
 * Pure helpers - no I/O, no env access, no side effects. Easy to test
 * and easy to reason about. The Server Action layer (Chunk 3) calls
 * `buildDocumentKey` when inserting a documents row, and the resulting
 * key is what `getPresignedPutUrl` / `getPresignedGetUrl` sign against.
 *
 * Key format:
 *   `companies/{companyId}/{documentId}/{sanitizedFilename}`
 *
 * Rationale (see also the `documents.fileKey` column doc in
 * `lib/db/schema.ts`):
 *   - `companies/` prefix lets R2 lifecycle rules target all document
 *     storage with one rule (vs. having to enumerate buckets).
 *   - `{companyId}` lets a per-company offboarding bulk-delete in R2
 *     be a single prefix scan, rather than walking the whole bucket.
 *   - `{documentId}` (the row's UUID) guarantees uniqueness even when
 *     two uploads share a filename. Two GST certs for two companies,
 *     both named `gst.pdf`, get distinct keys because their row ids
 *     differ.
 *   - The original filename is preserved at the tail so the R2 dashboard
 *     is debuggable - you can see what each object is without joining
 *     to the database.
 *
 * @module lib/r2/keys
 */

/**
 * Maximum length of the sanitised filename component. R2 keys can be
 * up to 1024 bytes total; we leave plenty of headroom for the
 * `companies/{uuid}/{uuid}/` prefix (which is ~80 bytes) by capping
 * the filename portion. 200 chars is generous for human-friendly names
 * while staying well under the limit even for multi-byte UTF-8.
 */
const MAX_SANITIZED_FILENAME_LENGTH = 200;

/**
 * Sanitise a user-supplied filename for safe use as an R2 object key
 * suffix.
 *
 * What we strip / replace:
 *   - Path separators (`/`, `\`) - these would break the key hierarchy
 *     and let a malicious upload escape its `{companyId}/{documentId}/`
 *     scope. Replaced with `-`.
 *   - Quotes (`'`, `"`) - sigv4 escaping is finicky; safer to disallow.
 *   - Control characters (U+0000 through U+001F, plus U+007F) - SQS/S3
 *     allow them but signing libraries handle them inconsistently.
 *   - Leading dots - prevents Unix-style "hidden" filenames from
 *     polluting the listing.
 *   - Whitespace runs - collapsed to a single underscore so R2 keys
 *     don't contain spaces (which signing libraries also handle
 *     inconsistently across versions).
 *
 * What we preserve:
 *   - Letters (including non-ASCII - R2 keys are UTF-8 capable)
 *   - Digits
 *   - The common safe punctuation: `.`, `-`, `_`, `(`, `)`, `+`, `,`
 *
 * If the input is empty or sanitises to empty, returns `"file"` as a
 * fallback rather than throwing - the call site has already validated
 * the upstream filename via Zod, this is defence-in-depth.
 *
 * @param filename - User-supplied filename (e.g. `"GST Certificate 2026.pdf"`)
 * @returns Sanitised string safe for use in an R2 key
 */
export function sanitizeFilename(filename: string): string {
  if (typeof filename !== "string" || filename.length === 0) {
    return "file";
  }

  // Step 1: strip leading/trailing whitespace, then strip leading dots.
  let cleaned = filename.trim().replace(/^\.+/, "");

  // Step 2: replace path separators and quotes with hyphens.
  cleaned = cleaned.replace(/[/\\'"]/g, "-");

  // Step 3: drop control characters (0x00-0x1F and 0x7F).
  // eslint-disable-next-line no-control-regex
  cleaned = cleaned.replace(/[\x00-\x1f\x7f]/g, "");

  // Step 4: collapse whitespace runs to a single underscore.
  cleaned = cleaned.replace(/\s+/g, "_");

  // Step 5: cap at MAX_SANITIZED_FILENAME_LENGTH. Truncating naively
  // could split a UTF-8 sequence; for our purposes (PDFs / images with
  // typical names well under 200 chars) this is overwhelmingly unlikely
  // to bite, but worth a comment for the future-reader.
  if (cleaned.length > MAX_SANITIZED_FILENAME_LENGTH) {
    cleaned = cleaned.slice(0, MAX_SANITIZED_FILENAME_LENGTH);
  }

  // Step 6: fallback if everything got stripped (e.g. input was just
  // whitespace and slashes).
  if (cleaned.length === 0) {
    return "file";
  }

  return cleaned;
}

/**
 * Compose the R2 object key for a document.
 *
 * Format: `companies/{companyId}/{documentId}/{sanitizedFilename}`
 *
 * Validates the UUID inputs only loosely (non-empty strings) - the
 * action layer has already validated them via Zod's `uuid()` matcher.
 * A defensive UUID check here would be redundant and would couple this
 * helper to a UUID format that's already enforced upstream.
 *
 * @param companyId - The owning company's UUID
 * @param documentId - The document row's UUID
 * @param filename - The original filename (will be sanitised)
 * @returns The full R2 object key
 *
 * @example
 *   buildDocumentKey(
 *     "01931a8c-...-...-...-...",
 *     "01931abc-...-...-...-...",
 *     "GST Certificate 2026.pdf"
 *   )
 *   // => "companies/01931a8c.../01931abc.../GST_Certificate_2026.pdf"
 */
export function buildDocumentKey(
  companyId: string,
  documentId: string,
  filename: string,
): string {
  if (!companyId || !documentId) {
    throw new Error(
      "buildDocumentKey: companyId and documentId are required",
    );
  }
  return `companies/${companyId}/${documentId}/${sanitizeFilename(filename)}`;
}
