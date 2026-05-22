/**
 * Schema unit tests for the documents module.
 *
 * Pure Zod-validator tests - no DB, no R2, no session. Fast.
 *
 * Coverage target (from docs/12-testing.md "Always" list):
 *   - At least one happy-path test per exported schema
 *   - At least one failure-mode test per validation rule that matters
 *
 * @module lib/documents/__tests__/schemas
 */
import { describe, it, expect } from "vitest";
import {
  initiateDocumentUploadSchema,
  confirmDocumentUploadSchema,
  documentTypeSchema,
  documentStatusSchema,
  MAX_UPLOAD_SIZE_BYTES,
} from "../schemas";

// Canonical valid input. Each negative test below mutates a single field.
const VALID_INIT_INPUT = {
  companyId: "01931a8c-0000-7000-8000-000000000001",
  documentType: "gst_certificate",
  fileName: "GST Certificate.pdf",
  mimeType: "application/pdf",
  sizeBytes: 100_000,
  issuedOn: "2026-01-15",
  expiresAt: "2027-01-14",
} as const;

describe("documentTypeSchema", () => {
  it.each([
    "gst_certificate",
    "pan_card",
    "incorporation_cert",
    "board_resolution",
    "cancelled_cheque",
    "trade_license",
    "other",
  ] as const)("accepts %s", (value) => {
    expect(documentTypeSchema.safeParse(value).success).toBe(true);
  });

  it("rejects an unknown type", () => {
    expect(documentTypeSchema.safeParse("msme_cert").success).toBe(false);
  });

  it("rejects empty string", () => {
    expect(documentTypeSchema.safeParse("").success).toBe(false);
  });
});

describe("documentStatusSchema", () => {
  it.each([
    "pending",
    "pending_review",
    "verified",
    "rejected",
    "expired",
  ] as const)("accepts %s", (value) => {
    expect(documentStatusSchema.safeParse(value).success).toBe(true);
  });

  it("rejects unknown status", () => {
    expect(documentStatusSchema.safeParse("uploaded").success).toBe(false);
  });
});

describe("initiateDocumentUploadSchema", () => {
  it("accepts the canonical valid input", () => {
    const result = initiateDocumentUploadSchema.safeParse(VALID_INIT_INPUT);
    expect(result.success).toBe(true);
  });

  it("accepts input without optional dates", () => {
    const { issuedOn: _issuedOn, expiresAt: _expiresAt, ...minimal } =
      VALID_INIT_INPUT;
    const result = initiateDocumentUploadSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it("accepts null for optional dates explicitly", () => {
    const result = initiateDocumentUploadSchema.safeParse({
      ...VALID_INIT_INPUT,
      issuedOn: null,
      expiresAt: null,
    });
    expect(result.success).toBe(true);
  });

  // ── companyId ────────────────────────────────────────────────────────────

  it("rejects a non-uuid companyId", () => {
    const result = initiateDocumentUploadSchema.safeParse({
      ...VALID_INIT_INPUT,
      companyId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  // ── documentType ─────────────────────────────────────────────────────────

  it("rejects an unknown documentType", () => {
    const result = initiateDocumentUploadSchema.safeParse({
      ...VALID_INIT_INPUT,
      documentType: "passport",
    });
    expect(result.success).toBe(false);
  });

  // ── fileName ─────────────────────────────────────────────────────────────

  it("rejects an empty fileName", () => {
    const result = initiateDocumentUploadSchema.safeParse({
      ...VALID_INIT_INPUT,
      fileName: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a fileName longer than 255 chars", () => {
    const result = initiateDocumentUploadSchema.safeParse({
      ...VALID_INIT_INPUT,
      fileName: "x".repeat(256) + ".pdf",
    });
    expect(result.success).toBe(false);
  });

  it("trims whitespace from fileName", () => {
    const result = initiateDocumentUploadSchema.safeParse({
      ...VALID_INIT_INPUT,
      fileName: "   trimmed.pdf   ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fileName).toBe("trimmed.pdf");
    }
  });

  // ── mimeType ─────────────────────────────────────────────────────────────

  it.each([
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/webp",
  ])("accepts allowed mime type %s", (mimeType) => {
    const result = initiateDocumentUploadSchema.safeParse({
      ...VALID_INIT_INPUT,
      mimeType,
    });
    expect(result.success).toBe(true);
  });

  it.each([
    "image/gif",
    "image/svg+xml",
    "application/zip",
    "text/plain",
    "image/heic",
  ])("rejects disallowed mime type %s", (mimeType) => {
    const result = initiateDocumentUploadSchema.safeParse({
      ...VALID_INIT_INPUT,
      mimeType,
    });
    expect(result.success).toBe(false);
  });

  // ── sizeBytes ────────────────────────────────────────────────────────────

  it("rejects zero size", () => {
    const result = initiateDocumentUploadSchema.safeParse({
      ...VALID_INIT_INPUT,
      sizeBytes: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative size", () => {
    const result = initiateDocumentUploadSchema.safeParse({
      ...VALID_INIT_INPUT,
      sizeBytes: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects size above the max (10 MB)", () => {
    const result = initiateDocumentUploadSchema.safeParse({
      ...VALID_INIT_INPUT,
      sizeBytes: MAX_UPLOAD_SIZE_BYTES + 1,
    });
    expect(result.success).toBe(false);
  });

  it("accepts size exactly at the max", () => {
    const result = initiateDocumentUploadSchema.safeParse({
      ...VALID_INIT_INPUT,
      sizeBytes: MAX_UPLOAD_SIZE_BYTES,
    });
    expect(result.success).toBe(true);
  });

  it("rejects fractional sizes", () => {
    const result = initiateDocumentUploadSchema.safeParse({
      ...VALID_INIT_INPUT,
      sizeBytes: 1024.5,
    });
    expect(result.success).toBe(false);
  });

  // ── date validation ──────────────────────────────────────────────────────

  it("rejects a malformed issuedOn date", () => {
    const result = initiateDocumentUploadSchema.safeParse({
      ...VALID_INIT_INPUT,
      issuedOn: "15-01-2026", // DD-MM-YYYY, wrong shape
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed expiresAt date", () => {
    const result = initiateDocumentUploadSchema.safeParse({
      ...VALID_INIT_INPUT,
      expiresAt: "2026/01/15", // slashes, wrong separator
    });
    expect(result.success).toBe(false);
  });

  // ── cross-field date ordering ────────────────────────────────────────────

  it("rejects expiresAt before issuedOn", () => {
    const result = initiateDocumentUploadSchema.safeParse({
      ...VALID_INIT_INPUT,
      issuedOn: "2026-01-15",
      expiresAt: "2026-01-14", // one day before
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["expiresAt"]);
    }
  });

  it("accepts expiresAt equal to issuedOn", () => {
    // Edge case: a single-day permit. Same date both sides should pass.
    const result = initiateDocumentUploadSchema.safeParse({
      ...VALID_INIT_INPUT,
      issuedOn: "2026-01-15",
      expiresAt: "2026-01-15",
    });
    expect(result.success).toBe(true);
  });

  it("does not enforce date ordering when one is missing", () => {
    // If only issuedOn is set, expiresAt being undefined shouldn't trip.
    const result = initiateDocumentUploadSchema.safeParse({
      ...VALID_INIT_INPUT,
      issuedOn: "2026-01-15",
      expiresAt: null,
    });
    expect(result.success).toBe(true);
  });
});

describe("confirmDocumentUploadSchema", () => {
  it("accepts a valid uuid", () => {
    const result = confirmDocumentUploadSchema.safeParse({
      documentId: "01931a8c-0000-7000-8000-000000000001",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-uuid", () => {
    const result = confirmDocumentUploadSchema.safeParse({
      documentId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing documentId", () => {
    const result = confirmDocumentUploadSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
