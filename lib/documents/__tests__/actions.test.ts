/**
 * Integration tests for the documents module Server Actions.
 *
 * Strategy:
 *   - Mock the R2 client (no real network)
 *   - Mock the session reader (no real cookies)
 *   - Use the real db + audit log + schema (so insert/update behaviour
 *     is genuinely exercised against the in-memory SQLite that the dev
 *     `db` client opens)
 *
 * The mock surface is deliberately small - just `getPresignedPutUrl`
 * and `readSession`. Everything else (Drizzle queries, audit-log
 * persistence, FK constraints) runs against the real implementation.
 *
 * Coverage:
 *   - initiateDocumentUpload
 *       happy path: admin uploading for any company
 *       happy path: company-role uploading for own company
 *       refusal:    not signed in
 *       refusal:    company-role uploading for OTHER company
 *       refusal:    company-role with no linked companyId
 *       refusal:    target company does not exist
 *       refusal:    invalid input (zod rejects size, mime, etc.)
 *   - confirmDocumentUpload
 *       happy path: pending -> pending_review (audit event written)
 *       happy path: company-role confirming own pending row
 *       refusal:    not signed in
 *       refusal:    document not found
 *       refusal:    cross-company confirm (company-role on someone else's row)
 *       idempotent: already pending_review -> ok with no second audit
 *       refusal:    document in verified state
 *       refusal:    document in rejected state
 *
 * Day-9 note: these tests depend on the dev `db` client pointing at the
 * local SQLite file. They'll mutate that file. We seed a clean state in
 * beforeEach and clean up in afterEach so reruns are deterministic.
 *
 * @module lib/documents/__tests__/actions
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
  type UserRole,
} from "@/lib/db/schema";
import { newId } from "@/lib/db/ids";

// ── Mocks ─────────────────────────────────────────────────────────────────

// Mock the R2 client BEFORE importing actions, so the import inside
// actions.ts picks up the mock. Vitest hoists `vi.mock` to the top.
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

// Mock the session reader so each test can set the role/companyId it
// wants. The mocked function is reset between tests.
vi.mock("@/lib/auth/session", () => ({
  readSession: vi.fn(async () => null),
}));

// Import AFTER the mocks are declared.
import { readSession } from "@/lib/auth/session";
import { getPresignedPutUrl } from "@/lib/r2/client";
import {
  initiateDocumentUpload,
  confirmDocumentUpload,
  getDocumentById,
} from "../actions";

const mockedReadSession = readSession as MockedFunction<typeof readSession>;
const mockedPresign = getPresignedPutUrl as MockedFunction<
  typeof getPresignedPutUrl
>;

// ── Test fixtures ─────────────────────────────────────────────────────────

/**
 * Seed data we set up before each test and tear down after. Each test
 * gets fresh rows so order independence is preserved.
 */
interface Fixture {
  adminUserId: string;
  staffUserId: string;
  companyAUserId: string;
  companyAId: string;
  companyBId: string;
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

  return { adminUserId, staffUserId, companyAUserId, companyAId, companyBId };
}

async function clearFixture(f: Fixture): Promise<void> {
  // Order matters - delete dependents first. Documents cascade-delete
  // with company, so deleting companies handles documents too, but we
  // delete documents explicitly for the cross-fixture-isolation tests
  // that might insert against arbitrary companies.
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

/**
 * Standard input shape for initiate happy-path. Each test that calls
 * initiate spreads this and overrides as needed.
 */
function validInitInput(companyId: string) {
  return {
    companyId,
    documentType: "gst_certificate" as const,
    fileName: "gst.pdf",
    mimeType: "application/pdf" as const,
    sizeBytes: 100_000,
  };
}

// ── Setup / teardown ──────────────────────────────────────────────────────

beforeEach(async () => {
  fixture = await seedFixture();
  mockedReadSession.mockReset();
  mockedPresign.mockClear();
});

afterEach(async () => {
  await clearFixture(fixture);
});

// ── initiateDocumentUpload ────────────────────────────────────────────────

describe("initiateDocumentUpload", () => {
  it("succeeds when admin uploads for any company", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await initiateDocumentUpload(
      validInitInput(fixture.companyBId),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return; // narrows for TS
    expect(result.documentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.uploadUrl).toContain("mock-r2.invalid");
    expect(result.mimeType).toBe("application/pdf");
    expect(result.expiresInSeconds).toBe(300);

    // Confirm row landed in pending state
    const row = await getDocumentById(result.documentId);
    expect(row).not.toBeNull();
    expect(row?.status).toBe("pending");
    expect(row?.companyId).toBe(fixture.companyBId);
    expect(row?.uploadedBy).toBe(fixture.adminUserId);
    expect(row?.fileName).toBe("gst.pdf");

    // Confirm presign was called with the constructed key
    expect(mockedPresign).toHaveBeenCalledOnce();
    const [key] = mockedPresign.mock.calls[0];
    expect(key).toBe(
      `companies/${fixture.companyBId}/${result.documentId}/gst.pdf`,
    );
  });

  it("succeeds when staff uploads for any company", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.staffUserId,
      role: "staff",
      companyId: null,
      email: "staff@test.local",
    });

    const result = await initiateDocumentUpload(
      validInitInput(fixture.companyAId),
    );
    expect(result.ok).toBe(true);
  });

  it("succeeds when company user uploads for own company", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.companyAUserId,
      role: "company",
      companyId: fixture.companyAId,
      email: "acme@test.local",
    });

    const result = await initiateDocumentUpload(
      validInitInput(fixture.companyAId),
    );
    expect(result.ok).toBe(true);
  });

  it("refuses when not signed in", async () => {
    mockedReadSession.mockResolvedValue(null);

    const result = await initiateDocumentUpload(
      validInitInput(fixture.companyAId),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/sign/i);
    }
    expect(mockedPresign).not.toHaveBeenCalled();
  });

  it("refuses when company user tries to upload for OTHER company", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.companyAUserId,
      role: "company",
      companyId: fixture.companyAId,
      email: "acme@test.local",
    });

    // Trying to upload for company B
    const result = await initiateDocumentUpload(
      validInitInput(fixture.companyBId),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // "Company not found" - we deliberately don't leak the cross-company
      // attempt to prevent ID enumeration.
      expect(result.error).toMatch(/not found/i);
    }

    // No row should have been inserted
    const rowsForB = await db
      .select()
      .from(documents)
      .where(eq(documents.companyId, fixture.companyBId));
    expect(rowsForB).toHaveLength(0);

    // No presign should have been attempted
    expect(mockedPresign).not.toHaveBeenCalled();
  });

  it("refuses when company-role session has no companyId", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.companyAUserId,
      role: "company",
      companyId: null, // misconfigured
      email: "orphan@test.local",
    });

    const result = await initiateDocumentUpload(
      validInitInput(fixture.companyAId),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not linked/i);
    }
  });

  it("refuses when target company does not exist", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const ghostCompanyId = newId();
    const result = await initiateDocumentUpload(
      validInitInput(ghostCompanyId),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not found/i);
    }
  });

  it("refuses zod-invalid input (oversize file)", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await initiateDocumentUpload({
      ...validInitInput(fixture.companyAId),
      sizeBytes: 50 * 1024 * 1024, // 50 MB, way over the 10 MB cap
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/MB or smaller/);
      expect(result.field).toBe("sizeBytes");
    }
  });

  it("refuses zod-invalid input (disallowed mime type)", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await initiateDocumentUpload({
      ...validInitInput(fixture.companyAId),
      mimeType: "application/x-msdownload", // .exe
    });

    expect(result.ok).toBe(false);
  });
});

// ── confirmDocumentUpload ─────────────────────────────────────────────────

describe("confirmDocumentUpload", () => {
  /**
   * Helper - drive a pending row into existence and return its id. Uses
   * the real initiateDocumentUpload to make sure the rows we test
   * confirm against look exactly like prod-produced rows.
   */
  async function initPending(companyId: string, actorUserId: string): Promise<string> {
    mockedReadSession.mockResolvedValueOnce({
      userId: actorUserId,
      role: "admin",
      companyId: null,
      email: "test@test.local",
    });
    const result = await initiateDocumentUpload(validInitInput(companyId));
    if (!result.ok) {
      throw new Error("init failed in helper: " + result.error);
    }
    return result.documentId;
  }

  it("flips pending -> pending_review and writes audit on happy path", async () => {
    const documentId = await initPending(
      fixture.companyAId,
      fixture.adminUserId,
    );

    // Confirm as admin
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await confirmDocumentUpload({ documentId });
    expect(result.ok).toBe(true);

    // Row should now be pending_review
    const row = await getDocumentById(documentId);
    expect(row?.status).toBe("pending_review");

    // Audit event written
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, documentId));
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    const docUploadedRow = auditRows.find(
      (r) => r.action === "document_uploaded",
    );
    expect(docUploadedRow).toBeDefined();
    expect(docUploadedRow?.targetType).toBe("document");
    expect(docUploadedRow?.actorId).toBe(fixture.adminUserId);
  });

  it("succeeds when company user confirms own pending row", async () => {
    // Init the row as the company user (own company)
    mockedReadSession.mockResolvedValueOnce({
      userId: fixture.companyAUserId,
      role: "company",
      companyId: fixture.companyAId,
      email: "acme@test.local",
    });
    const initResult = await initiateDocumentUpload(
      validInitInput(fixture.companyAId),
    );
    if (!initResult.ok) throw new Error("init failed: " + initResult.error);

    // Confirm as the same company user
    mockedReadSession.mockResolvedValue({
      userId: fixture.companyAUserId,
      role: "company",
      companyId: fixture.companyAId,
      email: "acme@test.local",
    });

    const result = await confirmDocumentUpload({
      documentId: initResult.documentId,
    });
    expect(result.ok).toBe(true);

    const row = await getDocumentById(initResult.documentId);
    expect(row?.status).toBe("pending_review");
  });

  it("refuses when not signed in", async () => {
    const documentId = await initPending(
      fixture.companyAId,
      fixture.adminUserId,
    );
    mockedReadSession.mockResolvedValue(null);

    const result = await confirmDocumentUpload({ documentId });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/sign/i);
    }
  });

  it("refuses when document not found", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await confirmDocumentUpload({ documentId: newId() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not found/i);
    }
  });

  it("refuses cross-company confirm by company role", async () => {
    // Admin creates a pending row on company B
    const documentId = await initPending(
      fixture.companyBId,
      fixture.adminUserId,
    );

    // Company A's user tries to confirm it
    mockedReadSession.mockResolvedValue({
      userId: fixture.companyAUserId,
      role: "company",
      companyId: fixture.companyAId,
      email: "acme@test.local",
    });

    const result = await confirmDocumentUpload({ documentId });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Uniform "not found" - don't leak existence of other companies' docs.
      expect(result.error).toMatch(/not found/i);
    }

    // Row should still be in pending state (no mutation)
    const row = await getDocumentById(documentId);
    expect(row?.status).toBe("pending");
  });

  it("is idempotent on already pending_review", async () => {
    const documentId = await initPending(
      fixture.companyAId,
      fixture.adminUserId,
    );

    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    // First confirm
    const first = await confirmDocumentUpload({ documentId });
    expect(first.ok).toBe(true);

    // Capture the audit row count after first confirm
    const auditAfterFirst = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, documentId));

    // Second confirm
    const second = await confirmDocumentUpload({ documentId });
    expect(second.ok).toBe(true);

    // Audit row count must NOT have grown
    const auditAfterSecond = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, documentId));
    expect(auditAfterSecond.length).toBe(auditAfterFirst.length);

    // Status still pending_review
    const row = await getDocumentById(documentId);
    expect(row?.status).toBe("pending_review");
  });

  it("refuses when document is in verified state", async () => {
    const documentId = await initPending(
      fixture.companyAId,
      fixture.adminUserId,
    );
    // Manually flip to verified
    await db
      .update(documents)
      .set({ status: "verified" })
      .where(eq(documents.id, documentId));

    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await confirmDocumentUpload({ documentId });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/verified/);
    }
  });

  it("refuses when document is in rejected state", async () => {
    const documentId = await initPending(
      fixture.companyAId,
      fixture.adminUserId,
    );
    await db
      .update(documents)
      .set({ status: "rejected" })
      .where(eq(documents.id, documentId));

    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await confirmDocumentUpload({ documentId });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/rejected/);
    }
  });

  it("refuses invalid documentId", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });

    const result = await confirmDocumentUpload({ documentId: "not-a-uuid" });
    expect(result.ok).toBe(false);
  });
});
