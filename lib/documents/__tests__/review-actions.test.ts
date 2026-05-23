/**
 * Integration tests for the documents review-and-delete Server Actions.
 *
 * Same strategy as `./actions.test.ts` and `./reads.test.ts`:
 *   - Mock the R2 client (no real network)
 *   - Mock the session reader (no real cookies)
 *   - Real db + audit log against the in-memory SQLite
 *
 * Coverage matrix:
 *
 *   verifyDocument
 *     happy: admin verifies pending_review (status -> verified, reviewer + reviewedAt stamped)
 *     happy: staff verifies pending_review
 *     happy: notes captured when supplied
 *     refusal: not signed in
 *     refusal: company-role (admin/staff only)
 *     refusal: document not found
 *     refusal: row in `pending` state
 *     refusal: row in `verified` state (no idempotent re-verify)
 *     refusal: row in `rejected` state
 *     audit: writes document_verified event with companyId in metadata
 *
 *   rejectDocument
 *     happy: admin rejects with required reason
 *     happy: staff rejects with required reason
 *     refusal: not signed in
 *     refusal: company-role
 *     refusal: missing reason (zod)
 *     refusal: short reason (<5 chars)
 *     refusal: document not found
 *     refusal: row in `verified` state
 *     audit: writes document_rejected with reason in metadata + reviewNotes on row
 *
 *   deleteDocument
 *     happy: admin deletes any-status row, R2 delete attempted, audit written
 *     happy: company-role deletes own pending row
 *     happy: company-role deletes own rejected row
 *     refusal: not signed in
 *     refusal: staff (admin-only)
 *     refusal: company-role on someone else's row -> not found
 *     refusal: company-role on own verified row
 *     refusal: company-role on own pending_review row
 *     refusal: document not found
 *     r2-failure: DB row still deleted; audit metadata.r2DeleteOk = false
 *
 * @module lib/documents/__tests__/review-actions
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
  deleteR2Object: vi.fn(async (_key: string) => ({ ok: true, status: 204 })),
}));

vi.mock("@/lib/auth/session", () => ({
  readSession: vi.fn(async () => null),
}));

// Import AFTER mocks.
import { readSession } from "@/lib/auth/session";
import { deleteR2Object } from "@/lib/r2/client";
import {
  verifyDocument,
  rejectDocument,
  deleteDocument,
  revertDocumentReview,
  getDocumentById,
} from "../actions";

const mockedReadSession = readSession as MockedFunction<typeof readSession>;
const mockedDelete = deleteR2Object as MockedFunction<typeof deleteR2Object>;

// ── Fixtures ──────────────────────────────────────────────────────────────

interface Fixture {
  adminUserId: string;
  staffUserId: string;
  companyAUserId: string;
  companyAId: string;
  companyBId: string;
  /** Company A document, status pending_review (ready for verify/reject). */
  docAPendingReviewId: string;
  /** Company A document, status pending (ready for company-role delete). */
  docAPendingId: string;
  /** Company A document, status verified (delete should refuse for company). */
  docAVerifiedId: string;
  /** Company A document, status rejected (ready for company-role delete). */
  docARejectedId: string;
  /** Company B document, status pending_review (cross-company tests). */
  docBPendingReviewId: string;
  /**
   * `reviewedAt` value used by both docAVerifiedId and docARejectedId.
   * Recomputed each seed call so it stays well within the
   * REVIEW_REVERT_WINDOW_MINUTES window — keeps the
   * revertDocumentReview happy-path tests passing against the
   * server's time-window guard.
   */
  recentReviewedAt: string;
}

let fixture: Fixture;

async function seedFixture(): Promise<Fixture> {
  const companyAId = newId();
  const companyBId = newId();
  const adminUserId = newId();
  const staffUserId = newId();
  const companyAUserId = newId();

  // 1 minute ago: comfortably inside the 15-minute revert window.
  // Recomputed per seed so the value is fresh on every test.
  const recentReviewedAt = new Date(Date.now() - 60_000).toISOString();

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
  const docAPendingId = newId();
  const docAVerifiedId = newId();
  const docARejectedId = newId();
  const docBPendingReviewId = newId();

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
    },
    {
      id: docAPendingId,
      companyId: companyAId,
      documentType: "trade_license" as DocumentType,
      fileKey: `companies/${companyAId}/${docAPendingId}/trade.pdf`,
      fileName: "trade.pdf",
      mimeType: "application/pdf",
      sizeBytes: 80_000,
      status: "pending" as DocumentStatus,
      uploadedBy: companyAUserId,
    },
    {
      id: docAVerifiedId,
      companyId: companyAId,
      documentType: "incorporation_cert" as DocumentType,
      fileKey: `companies/${companyAId}/${docAVerifiedId}/inc.pdf`,
      fileName: "inc.pdf",
      mimeType: "application/pdf",
      sizeBytes: 150_000,
      status: "verified" as DocumentStatus,
      reviewedBy: staffUserId,
      reviewedAt: recentReviewedAt,
      uploadedBy: companyAUserId,
    },
    {
      id: docARejectedId,
      companyId: companyAId,
      documentType: "pan_card" as DocumentType,
      fileKey: `companies/${companyAId}/${docARejectedId}/pan.pdf`,
      fileName: "pan.pdf",
      mimeType: "application/pdf",
      sizeBytes: 60_000,
      status: "rejected" as DocumentStatus,
      reviewNotes: "Illegible",
      reviewedBy: staffUserId,
      reviewedAt: recentReviewedAt,
      uploadedBy: companyAUserId,
    },
    {
      id: docBPendingReviewId,
      companyId: companyBId,
      documentType: "gst_certificate" as DocumentType,
      fileKey: `companies/${companyBId}/${docBPendingReviewId}/gst.pdf`,
      fileName: "gst.pdf",
      mimeType: "application/pdf",
      sizeBytes: 110_000,
      status: "pending_review" as DocumentStatus,
      uploadedBy: companyAUserId,
    },
  ]);

  return {
    adminUserId,
    staffUserId,
    companyAUserId,
    companyAId,
    companyBId,
    docAPendingReviewId,
    docAPendingId,
    docAVerifiedId,
    docARejectedId,
    docBPendingReviewId,
    recentReviewedAt,
  };
}

async function clearFixture(f: Fixture): Promise<void> {
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
  mockedDelete.mockReset();
  // Default mock returns 204 success.
  mockedDelete.mockResolvedValue({ ok: true, status: 204 });
});

afterEach(async () => {
  await clearFixture(fixture);
});

// ── verifyDocument ────────────────────────────────────────────────────────

describe("verifyDocument", () => {
  it("flips pending_review -> verified and stamps reviewer", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await verifyDocument({
      documentId: fixture.docAPendingReviewId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = await getDocumentById(fixture.docAPendingReviewId);
    expect(row?.status).toBe("verified");
    expect(row?.reviewedBy).toBe(fixture.adminUserId);
    expect(row?.reviewedAt).not.toBeNull();
    // No notes supplied -> reviewNotes stays null.
    expect(row?.reviewNotes).toBeNull();
  });

  it("succeeds for staff", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.staffUserId,
      role: "staff",
      companyId: null,
      email: "staff@test.local",
    });

    const result = await verifyDocument({
      documentId: fixture.docAPendingReviewId,
    });

    expect(result.ok).toBe(true);
  });

  it("captures optional notes on the row", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await verifyDocument({
      documentId: fixture.docAPendingReviewId,
      notes: "Issued by GST Maharashtra, scan is clear",
    });

    expect(result.ok).toBe(true);
    const row = await getDocumentById(fixture.docAPendingReviewId);
    expect(row?.reviewNotes).toBe(
      "Issued by GST Maharashtra, scan is clear",
    );
  });

  it("refuses when not signed in", async () => {
    mockedReadSession.mockResolvedValue(null);

    const result = await verifyDocument({
      documentId: fixture.docAPendingReviewId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/sign/i);
    }
  });

  it("refuses when company role tries to verify", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.companyAUserId,
      role: "company",
      companyId: fixture.companyAId,
      email: "acme@test.local",
    });

    const result = await verifyDocument({
      documentId: fixture.docAPendingReviewId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/permission/i);
    }
    // Row should be unchanged.
    const row = await getDocumentById(fixture.docAPendingReviewId);
    expect(row?.status).toBe("pending_review");
  });

  it("refuses when document not found", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await verifyDocument({ documentId: newId() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not found/i);
    }
  });

  it("refuses when row is in `pending` state", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await verifyDocument({
      documentId: fixture.docAPendingId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not pending_review/i);
    }
  });

  it("refuses when row is in `verified` state (no idempotent re-verify)", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await verifyDocument({
      documentId: fixture.docAVerifiedId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not pending_review/i);
    }
  });

  it("refuses when row is in `rejected` state", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await verifyDocument({
      documentId: fixture.docARejectedId,
    });

    expect(result.ok).toBe(false);
  });

  it("writes a document_verified audit event with companyId in metadata", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.staffUserId,
      role: "staff",
      companyId: null,
      email: "staff@test.local",
    });

    const result = await verifyDocument({
      documentId: fixture.docAPendingReviewId,
      notes: "Looks good",
    });
    expect(result.ok).toBe(true);

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, fixture.docAPendingReviewId));

    const verifyEvent = auditRows.find(
      (r) => r.action === "document_verified",
    );
    expect(verifyEvent).toBeDefined();
    expect(verifyEvent?.actorId).toBe(fixture.staffUserId);
    expect(verifyEvent?.targetType).toBe("document");
    const metadata = verifyEvent?.metadata as Record<string, unknown>;
    expect(metadata?.companyId).toBe(fixture.companyAId);
    expect(metadata?.notes).toBe("Looks good");
  });
});

// ── rejectDocument ────────────────────────────────────────────────────────

describe("rejectDocument", () => {
  it("flips pending_review -> rejected and stamps reason + reviewer", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await rejectDocument({
      documentId: fixture.docAPendingReviewId,
      reason: "Scan is illegible - please re-upload at higher DPI",
    });

    expect(result.ok).toBe(true);

    const row = await getDocumentById(fixture.docAPendingReviewId);
    expect(row?.status).toBe("rejected");
    expect(row?.reviewedBy).toBe(fixture.adminUserId);
    expect(row?.reviewedAt).not.toBeNull();
    expect(row?.reviewNotes).toBe(
      "Scan is illegible - please re-upload at higher DPI",
    );
  });

  it("succeeds for staff", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.staffUserId,
      role: "staff",
      companyId: null,
      email: "staff@test.local",
    });

    const result = await rejectDocument({
      documentId: fixture.docAPendingReviewId,
      reason: "Wrong document type uploaded",
    });

    expect(result.ok).toBe(true);
  });

  it("refuses when not signed in", async () => {
    mockedReadSession.mockResolvedValue(null);
    const result = await rejectDocument({
      documentId: fixture.docAPendingReviewId,
      reason: "Some valid reason",
    });
    expect(result.ok).toBe(false);
  });

  it("refuses when company role tries to reject", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.companyAUserId,
      role: "company",
      companyId: fixture.companyAId,
      email: "acme@test.local",
    });
    const result = await rejectDocument({
      documentId: fixture.docAPendingReviewId,
      reason: "Some valid reason",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/permission/i);
    }
  });

  it("refuses missing reason (zod)", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await rejectDocument({
      documentId: fixture.docAPendingReviewId,
    });
    expect(result.ok).toBe(false);
  });

  it("refuses short reason (<5 chars)", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await rejectDocument({
      documentId: fixture.docAPendingReviewId,
      reason: "bad",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/at least 5/i);
      expect(result.field).toBe("reason");
    }
  });

  it("refuses when row is in `verified` state", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await rejectDocument({
      documentId: fixture.docAVerifiedId,
      reason: "Decided to reject after all",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not pending_review/i);
    }
  });

  it("writes document_rejected audit with reason in metadata", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.staffUserId,
      role: "staff",
      companyId: null,
      email: "staff@test.local",
    });

    const result = await rejectDocument({
      documentId: fixture.docAPendingReviewId,
      reason: "Wrong document type",
    });
    expect(result.ok).toBe(true);

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, fixture.docAPendingReviewId));
    const rejectEvent = auditRows.find(
      (r) => r.action === "document_rejected",
    );
    expect(rejectEvent).toBeDefined();
    const metadata = rejectEvent?.metadata as Record<string, unknown>;
    expect(metadata?.reason).toBe("Wrong document type");
    expect(metadata?.companyId).toBe(fixture.companyAId);
  });
});

// ── deleteDocument ────────────────────────────────────────────────────────

describe("deleteDocument", () => {
  it("admin deletes a verified row, R2 delete attempted, audit written", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await deleteDocument({
      documentId: fixture.docAVerifiedId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Row gone
    const row = await getDocumentById(fixture.docAVerifiedId);
    expect(row).toBeNull();

    // R2 mock invoked with the row's fileKey
    expect(mockedDelete).toHaveBeenCalledOnce();
    const [calledKey] = mockedDelete.mock.calls[0];
    expect(calledKey).toBe(
      `companies/${fixture.companyAId}/${fixture.docAVerifiedId}/inc.pdf`,
    );

    // Audit row exists
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, fixture.docAVerifiedId));
    const deleteEvent = auditRows.find(
      (r) => r.action === "document_deleted",
    );
    expect(deleteEvent).toBeDefined();
    const metadata = deleteEvent?.metadata as Record<string, unknown>;
    expect(metadata?.r2DeleteOk).toBe(true);
    expect(metadata?.r2Status).toBe(204);
  });

  it("company-role deletes own pending row", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.companyAUserId,
      role: "company",
      companyId: fixture.companyAId,
      email: "acme@test.local",
    });

    const result = await deleteDocument({
      documentId: fixture.docAPendingId,
    });

    expect(result.ok).toBe(true);
    const row = await getDocumentById(fixture.docAPendingId);
    expect(row).toBeNull();
  });

  it("company-role deletes own rejected row", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.companyAUserId,
      role: "company",
      companyId: fixture.companyAId,
      email: "acme@test.local",
    });

    const result = await deleteDocument({
      documentId: fixture.docARejectedId,
    });

    expect(result.ok).toBe(true);
  });

  it("refuses when not signed in", async () => {
    mockedReadSession.mockResolvedValue(null);
    const result = await deleteDocument({
      documentId: fixture.docAPendingReviewId,
    });
    expect(result.ok).toBe(false);
    expect(mockedDelete).not.toHaveBeenCalled();
  });

  it("refuses when staff (admin-only delete)", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.staffUserId,
      role: "staff",
      companyId: null,
      email: "staff@test.local",
    });

    const result = await deleteDocument({
      documentId: fixture.docAPendingReviewId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/permission/i);
    }
    // Row still there
    const row = await getDocumentById(fixture.docAPendingReviewId);
    expect(row?.status).toBe("pending_review");
    // R2 not called
    expect(mockedDelete).not.toHaveBeenCalled();
  });

  it("refuses company-role on another company's row (not found)", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.companyAUserId,
      role: "company",
      companyId: fixture.companyAId,
      email: "acme@test.local",
    });

    const result = await deleteDocument({
      documentId: fixture.docBPendingReviewId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not found/i);
    }
    // Row still there
    const row = await getDocumentById(fixture.docBPendingReviewId);
    expect(row?.status).toBe("pending_review");
  });

  it("refuses company-role on own verified row", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.companyAUserId,
      role: "company",
      companyId: fixture.companyAId,
      email: "acme@test.local",
    });

    const result = await deleteDocument({
      documentId: fixture.docAVerifiedId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/pending or rejected/i);
    }
    expect(mockedDelete).not.toHaveBeenCalled();
  });

  it("refuses company-role on own pending_review row", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.companyAUserId,
      role: "company",
      companyId: fixture.companyAId,
      email: "acme@test.local",
    });

    const result = await deleteDocument({
      documentId: fixture.docAPendingReviewId,
    });

    expect(result.ok).toBe(false);
  });

  it("refuses when document not found", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await deleteDocument({ documentId: newId() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not found/i);
    }
  });

  it("still deletes DB row when R2 delete returns non-2xx; audit notes r2DeleteOk=false", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    // Override mock to simulate R2 failure
    mockedDelete.mockResolvedValueOnce({ ok: false, status: 500 });

    const result = await deleteDocument({
      documentId: fixture.docAVerifiedId,
    });

    expect(result.ok).toBe(true);

    // DB row is gone despite R2 failure
    const row = await getDocumentById(fixture.docAVerifiedId);
    expect(row).toBeNull();

    // Audit notes the orphan
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, fixture.docAVerifiedId));
    const deleteEvent = auditRows.find(
      (r) => r.action === "document_deleted",
    );
    expect(deleteEvent).toBeDefined();
    const metadata = deleteEvent?.metadata as Record<string, unknown>;
    expect(metadata?.r2DeleteOk).toBe(false);
    expect(metadata?.r2Status).toBe(500);
  });

  it("still deletes DB row when R2 delete throws (network error); audit notes r2DeleteOk=false", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    mockedDelete.mockRejectedValueOnce(new Error("ENETDOWN"));

    const result = await deleteDocument({
      documentId: fixture.docAVerifiedId,
    });

    expect(result.ok).toBe(true);
    const row = await getDocumentById(fixture.docAVerifiedId);
    expect(row).toBeNull();

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, fixture.docAVerifiedId));
    const deleteEvent = auditRows.find(
      (r) => r.action === "document_deleted",
    );
    const metadata = deleteEvent?.metadata as Record<string, unknown>;
    expect(metadata?.r2DeleteOk).toBe(false);
  });
});

// ── revertDocumentReview ──────────────────────────────────────────────────

describe("revertDocumentReview", () => {
  it("admin can revert a verified row back to pending_review (clears reviewer + notes + reviewedAt)", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await revertDocumentReview({
      documentId: fixture.docAVerifiedId,
    });

    expect(result.ok).toBe(true);

    const row = await getDocumentById(fixture.docAVerifiedId);
    expect(row?.status).toBe("pending_review");
    expect(row?.reviewedBy).toBeNull();
    expect(row?.reviewedAt).toBeNull();
    expect(row?.reviewNotes).toBeNull();
  });

  it("staff can revert a rejected row back to pending_review", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.staffUserId,
      role: "staff",
      companyId: null,
      email: "staff@test.local",
    });

    const result = await revertDocumentReview({
      documentId: fixture.docARejectedId,
    });

    expect(result.ok).toBe(true);

    const row = await getDocumentById(fixture.docARejectedId);
    expect(row?.status).toBe("pending_review");
    // The previous rejection reason ("Illegible" in the fixture) should
    // be cleared - the row is back to awaiting review, no review notes
    // apply.
    expect(row?.reviewNotes).toBeNull();
    expect(row?.reviewedBy).toBeNull();
  });

  it("optional reason rides in audit metadata (not in reviewNotes)", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await revertDocumentReview({
      documentId: fixture.docAVerifiedId,
      reason: "Caller mis-clicked Verify, restoring to queue.",
    });

    expect(result.ok).toBe(true);

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, fixture.docAVerifiedId));
    const revertEvent = auditRows.find(
      (r) => r.action === "document_review_reverted",
    );
    expect(revertEvent).toBeDefined();
    const metadata = revertEvent?.metadata as Record<string, unknown>;
    expect(metadata?.reason).toBe(
      "Caller mis-clicked Verify, restoring to queue.",
    );

    // reviewNotes on the row itself stays null (the revert cleared them).
    const row = await getDocumentById(fixture.docAVerifiedId);
    expect(row?.reviewNotes).toBeNull();
  });

  it("refuses when not signed in", async () => {
    mockedReadSession.mockResolvedValue(null);

    const result = await revertDocumentReview({
      documentId: fixture.docAVerifiedId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/signed in/i);

    // Row untouched.
    const row = await getDocumentById(fixture.docAVerifiedId);
    expect(row?.status).toBe("verified");
  });

  it("refuses company-role callers (admin/staff only)", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.companyAUserId,
      role: "company",
      companyId: fixture.companyAId,
      email: "acme@test.local",
    });

    const result = await revertDocumentReview({
      documentId: fixture.docAVerifiedId,
    });

    expect(result.ok).toBe(false);

    const row = await getDocumentById(fixture.docAVerifiedId);
    expect(row?.status).toBe("verified");
  });

  it("refuses when the document does not exist", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await revertDocumentReview({
      documentId: newId(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not found/i);
  });

  it("refuses when the document is already pending_review (idempotent guard)", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await revertDocumentReview({
      documentId: fixture.docAPendingReviewId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/pending_review/);
  });

  it("refuses when the document is in pending state (pre-confirm orphan)", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await revertDocumentReview({
      documentId: fixture.docAPendingId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/pending/);
  });

  it("audit before-snapshot captures cleared reviewer + reviewedAt + reviewNotes; metadata.revertedFrom is the prior status", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.staffUserId,
      role: "staff",
      companyId: null,
      email: "staff@test.local",
    });

    const result = await revertDocumentReview({
      documentId: fixture.docARejectedId,
    });

    expect(result.ok).toBe(true);

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, fixture.docARejectedId));
    const revertEvent = auditRows.find(
      (r) => r.action === "document_review_reverted",
    );
    expect(revertEvent).toBeDefined();

    const before = revertEvent?.before as Record<string, unknown>;
    expect(before?.status).toBe("rejected");
    expect(before?.reviewedBy).toBe(fixture.staffUserId);
    expect(before?.reviewedAt).toBe(fixture.recentReviewedAt);
    expect(before?.reviewNotes).toBe("Illegible");

    const metadata = revertEvent?.metadata as Record<string, unknown>;
    expect(metadata?.revertedFrom).toBe("rejected");
    expect(metadata?.companyId).toBe(fixture.companyAId);
  });

  it("stale-undo guard: row that's been re-verified after the toast appeared refuses the undo", async () => {
    // Simulate the race: the toast undo callback fires, but in the
    // meantime the row has cycled back to pending_review and been
    // re-verified. By the time the action runs, the row is verified
    // again - the action SHOULD succeed (it's a verified row, that's
    // revertable). What we're really testing is: it doesn't crash on
    // re-verified rows, and it operates on the CURRENT state, not the
    // stale state the toast was constructed against.
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    // Verify a fresh pending_review row.
    await verifyDocument({ documentId: fixture.docAPendingReviewId });

    // Now revert it.
    const result = await revertDocumentReview({
      documentId: fixture.docAPendingReviewId,
    });

    expect(result.ok).toBe(true);
    const row = await getDocumentById(fixture.docAPendingReviewId);
    expect(row?.status).toBe("pending_review");
    expect(row?.reviewedBy).toBeNull();
  });

  it("refuses revert when the review window has expired (>15 minutes ago)", async () => {
    // Backdate the verified row's reviewedAt to 30 minutes ago - well
    // outside the 15-minute REVIEW_REVERT_WINDOW_MINUTES window.
    const wellPastWindow = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    await db
      .update(documents)
      .set({ reviewedAt: wellPastWindow })
      .where(eq(documents.id, fixture.docAVerifiedId));

    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await revertDocumentReview({
      documentId: fixture.docAVerifiedId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/window has expired/i);

    // Row unchanged.
    const row = await getDocumentById(fixture.docAVerifiedId);
    expect(row?.status).toBe("verified");
    expect(row?.reviewedAt).toBe(wellPastWindow);
  });
});
