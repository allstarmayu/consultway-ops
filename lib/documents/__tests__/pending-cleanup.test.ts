/**
 * Integration tests for the pending-row cleanup cron handler.
 *
 * Strategy: real DB; inject `now` + `ageCutoffMinutes` to drive the
 * sweep deterministically without manipulating system time.
 *
 * Coverage:
 *   - `pending` rows older than the cutoff are deleted
 *   - `pending` rows newer than the cutoff are kept
 *   - rows in other statuses are untouched regardless of age
 *   - empty table is a no-op
 *   - ageCutoffMinutes=0 with a `now` after every row deletes everything pending
 *   - rejects malformed `now`
 *
 * @module lib/documents/__tests__/pending-cleanup
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  documents,
  companies,
  users,
  type DocumentStatus,
  type DocumentType,
  type UserRole,
} from "@/lib/db/schema";
import { newId } from "@/lib/db/ids";
import { logger } from "@/lib/logger";
import { runPendingCleanup } from "../crons/pending-cleanup";

// ── Fixture ───────────────────────────────────────────────────────────────

interface Fixture {
  uploaderUserId: string;
  companyAId: string;

  /** pending, created 2 hours ago - should be swept at default cutoff. */
  oldPendingId: string;
  /** pending, created just now - should be kept. */
  freshPendingId: string;
  /** pending_review, created 2 hours ago - untouched (wrong status). */
  oldPendingReviewId: string;
  /** verified, created 2 hours ago - untouched. */
  oldVerifiedId: string;
}

let fixture: Fixture;

/**
 * "Now" for the test scenario. Captured fresh in beforeEach against the
 * real clock so cross-test contamination is impossible: rows from
 * parallel tests in other files have `createdAt ≈ real now`, which is
 * NEWER than our `now - 60min` default cutoff, so they don't qualify
 * for the sweep we're testing. A hardcoded NOW timestamp (e.g.
 * 2026-05-23T12:00Z) would put our cutoff somewhere in the past
 * relative to real-time test rows, sweeping all of them and producing
 * non-deterministic counts.
 */
let NOW: string;

/** Compute timestamps relative to NOW. */
function isoMinutesBefore(now: string, minutes: number): string {
  return new Date(Date.parse(now) - minutes * 60 * 1000).toISOString();
}

async function seedFixture(): Promise<Fixture> {
  const companyAId = newId();
  const uploaderUserId = newId();

  await db.insert(companies).values({
    id: companyAId,
    name: "Acme Construction",
    sector: "Infrastructure",
    geography: "Maharashtra",
  });

  await db.insert(users).values({
    id: uploaderUserId,
    email: `u-${uploaderUserId}@test.local`,
    passwordHash: "$2a$10$test",
    role: "company" as UserRole,
    companyId: companyAId,
    name: "Uploader",
  });

  const oldPendingId = newId();
  const freshPendingId = newId();
  const oldPendingReviewId = newId();
  const oldVerifiedId = newId();

  const twoHoursAgo = isoMinutesBefore(NOW, 120);
  const justNow = isoMinutesBefore(NOW, 1);

  await db.insert(documents).values([
    {
      id: oldPendingId,
      companyId: companyAId,
      documentType: "gst_certificate" as DocumentType,
      fileKey: `companies/${companyAId}/${oldPendingId}/gst.pdf`,
      fileName: "old-pending.pdf",
      mimeType: "application/pdf",
      sizeBytes: 100_000,
      status: "pending" as DocumentStatus,
      uploadedBy: uploaderUserId,
      createdAt: twoHoursAgo,
    },
    {
      id: freshPendingId,
      companyId: companyAId,
      documentType: "trade_license" as DocumentType,
      fileKey: `companies/${companyAId}/${freshPendingId}/trade.pdf`,
      fileName: "fresh-pending.pdf",
      mimeType: "application/pdf",
      sizeBytes: 80_000,
      status: "pending" as DocumentStatus,
      uploadedBy: uploaderUserId,
      createdAt: justNow,
    },
    {
      id: oldPendingReviewId,
      companyId: companyAId,
      documentType: "pan_card" as DocumentType,
      fileKey: `companies/${companyAId}/${oldPendingReviewId}/pan.pdf`,
      fileName: "old-pending-review.pdf",
      mimeType: "application/pdf",
      sizeBytes: 60_000,
      status: "pending_review" as DocumentStatus,
      uploadedBy: uploaderUserId,
      createdAt: twoHoursAgo,
    },
    {
      id: oldVerifiedId,
      companyId: companyAId,
      documentType: "incorporation_cert" as DocumentType,
      fileKey: `companies/${companyAId}/${oldVerifiedId}/inc.pdf`,
      fileName: "old-verified.pdf",
      mimeType: "application/pdf",
      sizeBytes: 150_000,
      status: "verified" as DocumentStatus,
      uploadedBy: uploaderUserId,
      createdAt: twoHoursAgo,
    },
  ]);

  return {
    uploaderUserId,
    companyAId,
    oldPendingId,
    freshPendingId,
    oldPendingReviewId,
    oldVerifiedId,
  };
}

async function clearFixture(f: Fixture): Promise<void> {
  await db.delete(documents).where(eq(documents.companyId, f.companyAId));
  await db.delete(users).where(eq(users.id, f.uploaderUserId));
  await db.delete(companies).where(eq(companies.id, f.companyAId));
}

function buildDeps(now: string = NOW, ageCutoffMinutes?: number) {
  return {
    db,
    logger: logger.child({ module: "test-pending-cleanup" }),
    now,
    ...(ageCutoffMinutes !== undefined ? { ageCutoffMinutes } : {}),
  };
}

// ── Setup / teardown ──────────────────────────────────────────────────────

beforeEach(async () => {
  NOW = new Date().toISOString();
  fixture = await seedFixture();
});

afterEach(async () => {
  await clearFixture(fixture);
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe("runPendingCleanup", () => {
  it("deletes pending rows older than the default 60-minute cutoff", async () => {
    // Asserting row presence rather than `deletedCount` because
    // parallel test files may seed their own pending rows; we only
    // care that OUR old row was swept.
    const result = await runPendingCleanup(buildDeps());
    expect(result.deletedCount).toBeGreaterThanOrEqual(1);

    const oldRow = await db
      .select()
      .from(documents)
      .where(eq(documents.id, fixture.oldPendingId))
      .then((rows) => rows[0]);
    expect(oldRow).toBeUndefined();
  });

  it("keeps pending rows newer than the cutoff", async () => {
    await runPendingCleanup(buildDeps());

    const freshRow = await db
      .select()
      .from(documents)
      .where(eq(documents.id, fixture.freshPendingId))
      .then((rows) => rows[0]);
    expect(freshRow?.status).toBe("pending");
  });

  it("leaves non-pending rows alone regardless of age", async () => {
    await runPendingCleanup(buildDeps());

    const oldPendingReview = await db
      .select()
      .from(documents)
      .where(eq(documents.id, fixture.oldPendingReviewId))
      .then((rows) => rows[0]);
    expect(oldPendingReview?.status).toBe("pending_review");

    const oldVerified = await db
      .select()
      .from(documents)
      .where(eq(documents.id, fixture.oldVerifiedId))
      .then((rows) => rows[0]);
    expect(oldVerified?.status).toBe("verified");
  });

  it("returns deletedCount=0 when only our fixture's qualifying row is removed", async () => {
    // Delete our qualifying row up front. Parallel test files may have
    // their own pending rows but those were created at real-now which
    // is newer than our (NOW - 60min) cutoff, so they don't match.
    await db
      .delete(documents)
      .where(eq(documents.id, fixture.oldPendingId));

    const result = await runPendingCleanup(buildDeps());
    expect(result.deletedCount).toBe(0);
  });

  it("respects custom ageCutoffMinutes (0 sweeps every pending row at-or-before now)", async () => {
    // With cutoff=0, the WHERE becomes `created_at < now`. Both of our
    // pending rows (created at NOW-120min and NOW-1min) qualify. We
    // assert row-by-row rather than count because parallel tests may
    // be holding fresh pending rows that would also match.
    await runPendingCleanup(buildDeps(NOW, 0));

    const oldRow = await db
      .select()
      .from(documents)
      .where(eq(documents.id, fixture.oldPendingId))
      .then((rows) => rows[0]);
    expect(oldRow).toBeUndefined();

    const freshRow = await db
      .select()
      .from(documents)
      .where(eq(documents.id, fixture.freshPendingId))
      .then((rows) => rows[0]);
    expect(freshRow).toBeUndefined();
  });

  it("idempotent: second run on the same now deletes nothing further", async () => {
    const first = await runPendingCleanup(buildDeps());
    expect(first.deletedCount).toBeGreaterThanOrEqual(1);

    // Second run with the same NOW captures the same cutoff. Any row
    // the first run swept is gone; any row newer than the cutoff was
    // skipped both times. Therefore zero deletions on the second pass.
    const second = await runPendingCleanup(buildDeps());
    expect(second.deletedCount).toBe(0);
  });

  it("rejects a malformed `now` string", async () => {
    await expect(
      runPendingCleanup(buildDeps("not-a-timestamp")),
    ).rejects.toThrow(/invalid 'now'/);
  });
});
