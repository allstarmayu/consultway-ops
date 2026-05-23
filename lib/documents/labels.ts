/**
 * Human-readable labels for document types and statuses.
 *
 * Single source of truth so the upload form, list view, detail view,
 * filter dropdowns, and any future surface all render the same phrasing.
 * Adding a value to `DocumentType` / `DocumentStatus` in
 * `lib/db/schema.ts` produces a TypeScript error here (the records are
 * keyed by the union itself), so a new enum value can't ship without
 * deciding how it should render.
 *
 * Pattern mirrors `lib/audit/labels.ts`.
 *
 * @module lib/documents/labels
 */
import type { DocumentStatus, DocumentType } from "@/lib/db/schema";

/**
 * Short display labels for each document type, in title case. Used in
 * the type column of the list, the type badge, the upload form's type
 * selector, and the detail page.
 *
 * Ordering note: the upload form historically listed types most-common
 * first (GST and PAN dominate real uploads). The labels here are just a
 * lookup - any UI that needs a specific order should sort the
 * `DocumentType` enum array itself.
 */
export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  gst_certificate: "GST Certificate",
  pan_card: "PAN Card",
  incorporation_cert: "Certificate of Incorporation",
  board_resolution: "Board Resolution",
  cancelled_cheque: "Cancelled Cheque",
  trade_license: "Trade License",
  other: "Other",
};

/**
 * Short display labels for each document lifecycle state. Used in the
 * status badge and the status filter dropdown.
 *
 * Phrasing intentionally avoids developer-y terms - "pending_review"
 * becomes "Awaiting review" because that's what the user wants to know
 * (not the schema's internal state name).
 */
export const DOCUMENT_STATUS_LABELS: Record<DocumentStatus, string> = {
  pending: "Uploading",
  pending_review: "Awaiting review",
  verified: "Verified",
  rejected: "Rejected",
  expired: "Expired",
};
