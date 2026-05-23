/**
 * Integration tests for the documents read-surface Server Actions.
 *
 * Strategy mirrors `./actions.test.ts`:
 *   - Mock the R2 client (no real network)
 *   - Mock the session reader (no real cookies)
 *   - Use the real db (in-memory SQLite via the dev `db` client)
 *
 * Coverage matrix per action:
 *
 *   listDocumentsForCompany
 *     happy: admin lists any company's docs
 *     happy: staff lists any company's docs
 *     happy: company-role lists own docs
 *     refusal: not signed in
 *     refusal: company-role cross-company (not found)
 *     filter: status
 *     filter: documentType
 *     filter: AND-composition (status + documentType)
 *     sort: default = uploadedAt DESC
 *     sort: expiresAt ASC respects direction
 *     edge: admin on non-existent company returns empty list (no leak,
 *           because there's nothing to leak)
 *
 *   getDocumentDetail
 *     happy: admin sees full row with joined uploader name
 *     happy: staff sees full row
 *     happy: company-role sees own doc; reviewNotes redacted
 *     refusal: not signed in
 *     refusal: invalid documentId
 *     refusal: document not found
 *     refusal: company-role cross-company -> not found
 *     joined: reviewer name populated when reviewedBy is set
 *
 *   generateDocumentDownloadUrl
 *     happy: admin downloads any doc (URL minted via R2 mock)
 *     happy: company-role downloads own doc
 *     refusal: not signed in
 *     refusal: invalid documentId
 *     refusal: document not found
 *     refusal: cross-company (company-role) -> not found
 *     refusal: pending row (upload not confirmed)
 *
 * @module lib/documents/__tests__/reads
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockedFunction,
} from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  documents,
  companies,
  users,
  auditLog,
  type DocumentStatus,
  type DocumentType,
  type UserRole,
} from "@/lib/db/schema";
import { newId } from "@/lib/db/ids";

// ── Mocks ─────────────────────────────────────────────────────────────────

vi.mock("@/lib/r2/client", () => ({
  getPresignedPutUrl: vi.fn(async (key: string, mimeType: string) => ({
    url: `https://mock-r2.invalid/${key}?ct=${encodeURIComponent(mimeType)}&signed=1`,
    expiresInSeconds: 300,
  })),
  getPresignedGetUrl: vi.fn(async (key: string) => ({
    url: `https://mock-r2.invalid/${key}?signed=1`,
    expiresInSeconds: 300,
  })),
}));

vi.mock("@/lib/auth/session", () => ({
  readSession: vi.fn(async () => null),
}));

// Import AFTER mocks.
import { readSession } from "@/lib/auth/session";
import { getPresignedGetUrl } from "@/lib/r2/client";
import {
  listDocumentsForCompany,
  getDocumentDetail,
  generateDocumentDownloadUrl,
} from "../reads";

const mockedReadSession = readSession as MockedFunction<typeof readSession>;
const mockedPresignGet = getPresignedGetUrl as MockedFunction<
  typeof getPresignedGetUrl
>;

// ── Fixtures ──────────────────────────────────────────────────────────────

interface Fixture {
  adminUserId: string;
  staffUserId: string;
  companyAUserId: string;
  companyAId: string;
  companyBId: string;
  /** Document on company A, status `pending_review`, uploaded ~2 days ago. */
  docAPendingReviewId: string;
  /** Document on company A, status `verified`, reviewed by staff. */
  docAVerifiedId: string;
  /** Document on company A, status `pending` (bytes not yet confirmed). */
  docAPendingId: string;
  /** Document on company A, different type (PAN), status `rejected`. */
  docAPanRejectedId: string;
  /** Document on company B, status `verified`. */
  docBVerifiedId: string;
}

let fixture: Fixture;

async function seedFixture(): Promise<Fixture> {
  const companyAId = newId();
  const companyBId = newId();
  const adminUserId = newId();
  const staffUserId = newId();
  const companyAUserId = newId();

  await db.insert(companies).values([
    {
      id: companyAId,
      name: "Acme Construction",
      sector: "Infrastructure",
      geography: "Maharashtra",
    },
    {
      id: companyBId,
      name: "BuildRight Engineers",
      sector: "Civil Works",
      geography: "Karnataka",
    },
  ]);

  await db.insert(users).values([
    {
      id: adminUserId,
      email: `admin-${adminUserId}@test.local`,
      passwordHash: "$2a$10$test",
      role: "admin" as UserRole,
      name: "Test Admin",
    },
    {
      id: staffUserId,
      email: `staff-${staffUserId}@test.local`,
      passwordHash: "$2a$10$test",
      role: "staff" as UserRole,
      name: "Test Staff",
    },
    {
      id: companyAUserId,
      email: `acme-${companyAUserId}@test.local`,
      passwordHash: "$2a$10$test",
      role: "company" as UserRole,
      companyId: companyAId,
      name: "Acme Contact",
    },
  ]);

  const docAPendingReviewId = newId();
  const docAVerifiedId = newId();
  const docAPendingId = newId();
  const docAPanRejectedId = newId();
  const docBVerifiedId = newId();

  await db.insert(documents).values([
    {
      id: docAPendingReviewId,
      companyId: companyAId,
      documentType: "gst_certificate" as DocumentType,
      fileKey: `companies/${companyAId}/${docAPendingReviewId}/gst.pdf`,
      fileName: "gst.pdf",
      mimeType: "application/pdf",
      sizeBytes: 100_000,
      status: "pending_review" as DocumentStatus,
      uploadedBy: companyAUserId,
      // Backdated so sort tests see ordering vs verified row below.
      uploadedAt: "2026-05-20T10:00:00.000Z",
    },
    {
      id: docAVerifiedId,
      companyId: companyAId,
      documentType: "incorporation_cert" as DocumentType,
      fileKey: `companies/${companyAId}/${docAVerifiedId}/inc.pdf`,
      fileName: "incorporation.pdf",
      mimeType: "application/pdf",
      sizeBytes: 150_000,
      status: "verified" as DocumentStatus,
      reviewNotes: "Looks good - issued by ROC Mumbai",
      reviewedBy: staffUserId,
      reviewedAt: "2026-05-21T11:00:00.000Z",
      expiresAt: "2027-05-21",
      uploadedBy: companyAUserId,
      uploadedAt: "2026-05-21T10:00:00.000Z",
    },
    {
      id: docAPendingId,
      companyId: companyAId,
      documentType: "trade_license" as DocumentType,
      fileKey: `companies/${companyAId}/${docAPendingId}/trade.pdf`,
      fileName: "trade.pdf",
      mimeType: "application/pdf",
      sizeBytes: 90_000,
      status: "pending" as DocumentStatus,
      uploadedBy: companyAUserId,
      uploadedAt: "2026-05-22T10:00:00.000Z",
    },
    {
      id: docAPanRejectedId,
      companyId: companyAId,
      documentType: "pan_card" as DocumentType,
      fileKey: `companies/${companyAId}/${docAPanRejectedId}/pan.pdf`,
      fileName: "pan.pdf",
      mimeType: "application/pdf",
      sizeBytes: 60_000,
      status: "rejected" as DocumentStatus,
      reviewNotes: "Illegible - please re-scan",
      reviewedBy: staffUserId,
      reviewedAt: "2026-05-22T11:00:00.000Z",
      uploadedBy: companyAUserId,
      uploadedAt: "2026-05-19T10:00:00.000Z",
    },
    {
      id: docBVerifiedId,
      companyId: companyBId,
      documentType: "gst_certificate" as DocumentType,
      fileKey: `companies/${companyBId}/${docBVerifiedId}/gst.pdf`,
      fileName: "gst.pdf",
      mimeType: "application/pdf",
      sizeBytes: 110_000,
      status: "verified" as DocumentStatus,
      reviewedBy: staffUserId,
      reviewedAt: "2026-05-22T10:00:00.000Z",
      uploadedBy: companyAUserId, // intentional - test cross-uploader scenarios
      uploadedAt: "2026-05-22T09:00:00.000Z",
    },
  ]);

  return {
    adminUserId,
    staffUserId,
    companyAUserId,
    companyAId,
    companyBId,
    docAPendingReviewId,
    docAVerifiedId,
    docAPendingId,
    docAPanRejectedId,
    docBVerifiedId,
  };
}

async function clearFixture(f: Fixture): Promise<void> {
  // Audit log first (no FK to documents but might exist from other tests
  // bleeding in - keep cleanup defensive).
  await db
    .delete(auditLog)
    .where(eq(auditLog.actorId, f.adminUserId))
    .catch(() => {});
  await db
    .delete(auditLog)
    .where(eq(auditLog.actorId, f.staffUserId))
    .catch(() => {});
  await db
    .delete(auditLog)
    .where(eq(auditLog.actorId, f.companyAUserId))
    .catch(() => {});
  await db.delete(documents).where(eq(documents.companyId, f.companyAId));
  await db.delete(documents).where(eq(documents.companyId, f.companyBId));
  await db.delete(users).where(eq(users.id, f.adminUserId));
  await db.delete(users).where(eq(users.id, f.staffUserId));
  await db.delete(users).where(eq(users.id, f.companyAUserId));
  await db.delete(companies).where(eq(companies.id, f.companyAId));
  await db.delete(companies).where(eq(companies.id, f.companyBId));
}

// ── Setup / teardown ──────────────────────────────────────────────────────

beforeEach(async () => {
  fixture = await seedFixture();
  mockedReadSession.mockReset();
  mockedPresignGet.mockClear();
});

afterEach(async () => {
  await clearFixture(fixture);
});

// ── listDocumentsForCompany ───────────────────────────────────────────────

describe("listDocumentsForCompany", () => {
  it("returns all company A docs for admin", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await listDocumentsForCompany({
      companyId: fixture.companyAId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 4 docs seeded on company A
    expect(result.rows).toHaveLength(4);
    expect(result.total).toBe(4);
    expect(result.rows.every((r) => r.companyId === fixture.companyAId)).toBe(
      true,
    );
  });

  it("returns all company A docs for staff", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.staffUserId,
      role: "staff",
      companyId: null,
      email: "staff@test.local",
    });

    const result = await listDocumentsForCompany({
      companyId: fixture.companyAId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(4);
  });

  it("returns own docs for company role", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.companyAUserId,
      role: "company",
      companyId: fixture.companyAId,
      email: "acme@test.local",
    });

    const result = await listDocumentsForCompany({
      companyId: fixture.companyAId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(4);
    expect(result.rows.every((r) => r.companyId === fixture.companyAId)).toBe(
      true,
    );
  });

  it("refuses when not signed in", async () => {
    mockedReadSession.mockResolvedValue(null);

    const result = await listDocumentsForCompany({
      companyId: fixture.companyAId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/sign/i);
    }
  });

  it("returns not-found for company role asking about ANOTHER company", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.companyAUserId,
      role: "company",
      companyId: fixture.companyAId,
      email: "acme@test.local",
    });

    const result = await listDocumentsForCompany({
      companyId: fixture.companyBId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not found/i);
    }
  });

  it("filters by status", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await listDocumentsForCompany({
      companyId: fixture.companyAId,
      status: "verified",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].id).toBe(fixture.docAVerifiedId);
  });

  it("filters by documentType", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await listDocumentsForCompany({
      companyId: fixture.companyAId,
      documentType: "pan_card",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].id).toBe(fixture.docAPanRejectedId);
  });

  it("AND-composes status + documentType filters", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    // GST + verified: no row matches (the GST is pending_review).
    const result = await listDocumentsForCompany({
      companyId: fixture.companyAId,
      documentType: "gst_certificate",
      status: "verified",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(0);
  });

  it("defaults to uploadedAt DESC sort", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await listDocumentsForCompany({
      companyId: fixture.companyAId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Seeded uploadedAt timestamps (ISO):
    //   pendingReview = 2026-05-20T10
    //   verified      = 2026-05-21T10
    //   pending       = 2026-05-22T10
    //   panRejected   = 2026-05-19T10
    // DESC order should be: pending, verified, pendingReview, panRejected.
    expect(result.rows.map((r) => r.id)).toEqual([
      fixture.docAPendingId,
      fixture.docAVerifiedId,
      fixture.docAPendingReviewId,
      fixture.docAPanRejectedId,
    ]);
  });

  it("honours sortDir=asc on expiresAt", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await listDocumentsForCompany({
      companyId: fixture.companyAId,
      sortBy: "expiresAt",
      sortDir: "asc",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only the verified doc has an expiresAt; the rest are null. With
    // SQLite's NULLS-FIRST default on ASC ordering, nulls come first
    // and the only non-null (2027-05-21) is last.
    expect(result.rows[result.rows.length - 1].id).toBe(
      fixture.docAVerifiedId,
    );
  });

  it("admin on non-existent company gets an empty list (not an error)", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await listDocumentsForCompany({
      companyId: newId(),
    });

    // Predicate returns true for admin regardless of whether the company
    // exists - this is fine because there are no docs to leak.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(0);
  });

  it("refuses zod-invalid input (bad uuid)", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await listDocumentsForCompany({ companyId: "not-a-uuid" });
    expect(result.ok).toBe(false);
  });
});

// ── getDocumentDetail ─────────────────────────────────────────────────────

describe("getDocumentDetail", () => {
  it("returns full row + uploader name for admin", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await getDocumentDetail({
      documentId: fixture.docAVerifiedId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.id).toBe(fixture.docAVerifiedId);
    expect(result.document.reviewNotes).toBe("Looks good - issued by ROC Mumbai");
    expect(result.uploaderName).toBe("Acme Contact");
    expect(result.reviewerName).toBe("Test Staff");
  });

  it("returns full row for staff", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.staffUserId,
      role: "staff",
      companyId: null,
      email: "staff@test.local",
    });

    const result = await getDocumentDetail({
      documentId: fixture.docAVerifiedId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.reviewNotes).not.toBeNull();
  });

  it("redacts reviewNotes for company role even on own doc", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.companyAUserId,
      role: "company",
      companyId: fixture.companyAId,
      email: "acme@test.local",
    });

    const result = await getDocumentDetail({
      documentId: fixture.docAPanRejectedId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Other staff-set fields still come through; only reviewNotes redacted.
    expect(result.document.id).toBe(fixture.docAPanRejectedId);
    expect(result.document.reviewNotes).toBeNull();
    expect(result.document.reviewedBy).toBe(fixture.staffUserId);
    expect(result.document.reviewedAt).not.toBeNull();
  });

  it("refuses when not signed in", async () => {
    mockedReadSession.mockResolvedValue(null);

    const result = await getDocumentDetail({
      documentId: fixture.docAVerifiedId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/sign/i);
    }
  });

  it("refuses invalid documentId", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await getDocumentDetail({ documentId: "not-a-uuid" });
    expect(result.ok).toBe(false);
  });

  it("refuses when document not found", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await getDocumentDetail({ documentId: newId() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not found/i);
    }
  });

  it("returns not-found for company role on another company's doc", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.companyAUserId,
      role: "company",
      companyId: fixture.companyAId,
      email: "acme@test.local",
    });

    const result = await getDocumentDetail({
      documentId: fixture.docBVerifiedId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not found/i);
    }
  });

  it("returns null reviewerName when reviewedBy is null", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await getDocumentDetail({
      documentId: fixture.docAPendingReviewId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reviewerName).toBeNull();
    expect(result.uploaderName).toBe("Acme Contact");
  });
});

// ── generateDocumentDownloadUrl ───────────────────────────────────────────

describe("generateDocumentDownloadUrl", () => {
  it("mints a presigned URL for admin", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await generateDocumentDownloadUrl({
      documentId: fixture.docAVerifiedId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.url).toContain("mock-r2.invalid");
    expect(result.fileName).toBe("incorporation.pdf");
    expect(result.mimeType).toBe("application/pdf");
    expect(result.expiresInSeconds).toBe(300);
    expect(mockedPresignGet).toHaveBeenCalledOnce();
  });

  it("mints for staff on any company's doc", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.staffUserId,
      role: "staff",
      companyId: null,
      email: "staff@test.local",
    });

    const result = await generateDocumentDownloadUrl({
      documentId: fixture.docBVerifiedId,
    });

    expect(result.ok).toBe(true);
  });

  it("mints for company role on own doc", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.companyAUserId,
      role: "company",
      companyId: fixture.companyAId,
      email: "acme@test.local",
    });

    const result = await generateDocumentDownloadUrl({
      documentId: fixture.docAVerifiedId,
    });

    expect(result.ok).toBe(true);
  });

  it("refuses when not signed in", async () => {
    mockedReadSession.mockResolvedValue(null);

    const result = await generateDocumentDownloadUrl({
      documentId: fixture.docAVerifiedId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/sign/i);
    }
    expect(mockedPresignGet).not.toHaveBeenCalled();
  });

  it("refuses invalid documentId", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await generateDocumentDownloadUrl({
      documentId: "not-a-uuid",
    });
    expect(result.ok).toBe(false);
    expect(mockedPresignGet).not.toHaveBeenCalled();
  });

  it("refuses when document not found", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await generateDocumentDownloadUrl({ documentId: newId() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not found/i);
    }
  });

  it("returns not-found for company-role on another company's doc", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.companyAUserId,
      role: "company",
      companyId: fixture.companyAId,
      email: "acme@test.local",
    });

    const result = await generateDocumentDownloadUrl({
      documentId: fixture.docBVerifiedId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not found/i);
    }
    expect(mockedPresignGet).not.toHaveBeenCalled();
  });

  it("refuses pending row (upload not yet confirmed)", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await generateDocumentDownloadUrl({
      documentId: fixture.docAPendingId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not yet completed/i);
    }
    expect(mockedPresignGet).not.toHaveBeenCalled();
  });
});
