/**
 * Integration tests for the expiry-sweep cron handler.
 *
 * Strategy: real DB + real audit log; mock sendEmail to capture
 * payloads without hitting Resend. The handler accepts dependencies
 * explicitly, so we don't need `vi.mock` for db/audit/logger - we just
 * inject them.
 *
 * Coverage:
 *   - past-expiry rows flip status verified -> expired
 *   - past-expiry flip writes a `document_expired` audit event with
 *     actorRole=system + actorId=SYSTEM_ACTOR_ID
 *   - upcoming-expiry rows (≤30 days) trigger one email each
 *   - rows >30 days out are untouched (no flip, no email)
 *   - non-verified rows (pending_review, rejected, expired, pending)
 *     are untouched
 *   - rows with null expires_at are untouched
 *   - rows whose company has null contactEmail are skipped + counted
 *   - idempotent: re-running the same day flips nothing on the second
 *     pass but RE-SENDS reminders (no dedup table yet - documented)
 *   - per-row email failures don't abort the sweep
 *
 * @module lib/documents/__tests__/expiry-sweep
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
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
import { logger } from "@/lib/logger";
import { SYSTEM_ACTOR_ID } from "@/lib/audit/log";
import type { SendEmailArgs, SendEmailResult } from "@/lib/email/client";
import { runExpirySweep } from "../crons/expiry-sweep";

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Add N days to a YYYY-MM-DD string. Mirrors the helper in the
 * cron module - duplicated here rather than imported because exposing
 * it as a module-level export would bloat the public API surface
 * for a 5-line internal utility.
 */
function addDays(isoDate: string, days: number): string {
  const ms = Date.parse(`${isoDate}T00:00:00.000Z`);
  return new Date(ms + days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

// ── Fixture ───────────────────────────────────────────────────────────────

interface Fixture {
  uploaderUserId: string;
  staffUserId: string;
  companyAId: string;
  companyBId: string;
  companyNoEmailId: string;

  /** Verified, expires 5 days from "today" - in reminder window. */
  docInWindowId: string;
  /** Verified, expires today - PAST-expiry (gets flipped). */
  docExpiringTodayId: string;
  /** Verified, expires 10 days ago - PAST-expiry (gets flipped). */
  docAlreadyPastId: string;
  /** Verified, expires 60 days out - outside reminder window. */
  docFarFutureId: string;
  /** Verified, no expiresAt - untouched. */
  docNoExpiryId: string;
  /** pending_review, expires today - non-verified, untouched. */
  docPendingReviewExpiringId: string;
  /** Verified on companyNoEmail (no contactEmail) - reminder skipped. */
  docNoEmailId: string;
}

let fixture: Fixture;
const TODAY = "2026-05-23";

async function seedFixture(): Promise<Fixture> {
  const companyAId = newId();
  const companyBId = newId();
  const companyNoEmailId = newId();
  const uploaderUserId = newId();
  const staffUserId = newId();

  await db.insert(companies).values([
    {
      id: companyAId,
      name: "Acme Construction",
      sector: "Infrastructure",
      geography: "Maharashtra",
      contactEmail: "acme@example.test",
    },
    {
      id: companyBId,
      name: "BuildRight Engineers",
      sector: "Civil Works",
      geography: "Karnataka",
      contactEmail: "build@example.test",
    },
    {
      id: companyNoEmailId,
      name: "No Email Co",
      sector: "Misc",
      geography: "Goa",
      contactEmail: null,
    },
  ]);

  await db.insert(users).values([
    {
      id: uploaderUserId,
      email: `u-${uploaderUserId}@test.local`,
      passwordHash: "$2a$10$test",
      role: "company" as UserRole,
      companyId: companyAId,
      name: "Uploader",
    },
    {
      id: staffUserId,
      email: `s-${staffUserId}@test.local`,
      passwordHash: "$2a$10$test",
      role: "staff" as UserRole,
      name: "Staff",
    },
  ]);

  const docInWindowId = newId();
  const docExpiringTodayId = newId();
  const docAlreadyPastId = newId();
  const docFarFutureId = newId();
  const docNoExpiryId = newId();
  const docPendingReviewExpiringId = newId();
  const docNoEmailId = newId();

  await db.insert(documents).values([
    {
      id: docInWindowId,
      companyId: companyAId,
      documentType: "gst_certificate" as DocumentType,
      fileKey: `companies/${companyAId}/${docInWindowId}/gst.pdf`,
      fileName: "gst.pdf",
      mimeType: "application/pdf",
      sizeBytes: 100_000,
      status: "verified" as DocumentStatus,
      expiresAt: addDays(TODAY, 5),
      uploadedBy: uploaderUserId,
    },
    {
      id: docExpiringTodayId,
      companyId: companyAId,
      documentType: "trade_license" as DocumentType,
      fileKey: `companies/${companyAId}/${docExpiringTodayId}/trade.pdf`,
      fileName: "trade.pdf",
      mimeType: "application/pdf",
      sizeBytes: 80_000,
      status: "verified" as DocumentStatus,
      expiresAt: TODAY,
      uploadedBy: uploaderUserId,
    },
    {
      id: docAlreadyPastId,
      companyId: companyAId,
      documentType: "pan_card" as DocumentType,
      fileKey: `companies/${companyAId}/${docAlreadyPastId}/pan.pdf`,
      fileName: "pan.pdf",
      mimeType: "application/pdf",
      sizeBytes: 60_000,
      status: "verified" as DocumentStatus,
      expiresAt: addDays(TODAY, -10),
      uploadedBy: uploaderUserId,
    },
    {
      id: docFarFutureId,
      companyId: companyBId,
      documentType: "incorporation_cert" as DocumentType,
      fileKey: `companies/${companyBId}/${docFarFutureId}/inc.pdf`,
      fileName: "inc.pdf",
      mimeType: "application/pdf",
      sizeBytes: 150_000,
      status: "verified" as DocumentStatus,
      expiresAt: addDays(TODAY, 60),
      uploadedBy: uploaderUserId,
    },
    {
      id: docNoExpiryId,
      companyId: companyAId,
      documentType: "board_resolution" as DocumentType,
      fileKey: `companies/${companyAId}/${docNoExpiryId}/board.pdf`,
      fileName: "board.pdf",
      mimeType: "application/pdf",
      sizeBytes: 50_000,
      status: "verified" as DocumentStatus,
      expiresAt: null,
      uploadedBy: uploaderUserId,
    },
    {
      id: docPendingReviewExpiringId,
      companyId: companyAId,
      documentType: "cancelled_cheque" as DocumentType,
      fileKey: `companies/${companyAId}/${docPendingReviewExpiringId}/cheque.pdf`,
      fileName: "cheque.pdf",
      mimeType: "application/pdf",
      sizeBytes: 40_000,
      status: "pending_review" as DocumentStatus,
      expiresAt: TODAY,
      uploadedBy: uploaderUserId,
    },
    {
      id: docNoEmailId,
      companyId: companyNoEmailId,
      documentType: "gst_certificate" as DocumentType,
      fileKey: `companies/${companyNoEmailId}/${docNoEmailId}/gst.pdf`,
      fileName: "noemail-gst.pdf",
      mimeType: "application/pdf",
      sizeBytes: 70_000,
      status: "verified" as DocumentStatus,
      expiresAt: addDays(TODAY, 10),
      uploadedBy: uploaderUserId,
    },
  ]);

  return {
    uploaderUserId,
    staffUserId,
    companyAId,
    companyBId,
    companyNoEmailId,
    docInWindowId,
    docExpiringTodayId,
    docAlreadyPastId,
    docFarFutureId,
    docNoExpiryId,
    docPendingReviewExpiringId,
    docNoEmailId,
  };
}

async function clearFixture(f: Fixture): Promise<void> {
  // Audit cleanup: system-actor rows are the ones we write, so target
  // them by SYSTEM_ACTOR_ID rather than by user.
  await db
    .delete(auditLog)
    .where(eq(auditLog.actorId, SYSTEM_ACTOR_ID))
    .catch(() => {});
  await db.delete(documents).where(eq(documents.companyId, f.companyAId));
  await db.delete(documents).where(eq(documents.companyId, f.companyBId));
  await db
    .delete(documents)
    .where(eq(documents.companyId, f.companyNoEmailId));
  await db.delete(users).where(eq(users.id, f.uploaderUserId));
  await db.delete(users).where(eq(users.id, f.staffUserId));
  await db.delete(companies).where(eq(companies.id, f.companyAId));
  await db.delete(companies).where(eq(companies.id, f.companyBId));
  await db.delete(companies).where(eq(companies.id, f.companyNoEmailId));
}

// ── Build deps ────────────────────────────────────────────────────────────

interface BuildDepsOpts {
  sendEmail?: (args: SendEmailArgs) => Promise<SendEmailResult>;
  today?: string;
}

function buildDeps(opts: BuildDepsOpts = {}) {
  const sendEmail =
    opts.sendEmail ??
    vi.fn<(args: SendEmailArgs) => Promise<SendEmailResult>>(async () => ({
      ok: true,
      id: "msg_test",
    }));
  return {
    db,
    logger: logger.child({ module: "test-expiry-sweep" }),
    sendEmail,
    appUrl: "http://localhost:3000",
    today: opts.today ?? TODAY,
    // Use the production audit writer - we want to assert real rows.
  };
}

// ── Setup / teardown ──────────────────────────────────────────────────────

beforeEach(async () => {
  fixture = await seedFixture();
});

afterEach(async () => {
  await clearFixture(fixture);
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe("runExpirySweep - past-expiry flip", () => {
  it("flips status verified -> expired for rows with expires_at <= today", async () => {
    const deps = buildDeps();
    const result = await runExpirySweep(deps);

    // docExpiringTodayId + docAlreadyPastId both qualify.
    expect(result.expiredCount).toBe(2);

    const expiringToday = await db
      .select()
      .from(documents)
      .where(eq(documents.id, fixture.docExpiringTodayId))
      .then((rows) => rows[0]);
    expect(expiringToday?.status).toBe("expired");

    const alreadyPast = await db
      .select()
      .from(documents)
      .where(eq(documents.id, fixture.docAlreadyPastId))
      .then((rows) => rows[0]);
    expect(alreadyPast?.status).toBe("expired");
  });

  it("writes a document_expired audit event with system actor", async () => {
    const deps = buildDeps();
    await runExpirySweep(deps);

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, fixture.docExpiringTodayId));
    const expiredEvent = auditRows.find(
      (r) => r.action === "document_expired",
    );
    expect(expiredEvent).toBeDefined();
    expect(expiredEvent?.actorId).toBe(SYSTEM_ACTOR_ID);
    expect(expiredEvent?.actorRole).toBe("system");
    expect(expiredEvent?.targetType).toBe("document");
    const metadata = expiredEvent?.metadata as Record<string, unknown>;
    expect(metadata?.companyId).toBe(fixture.companyAId);
    expect(metadata?.expiresAt).toBe(TODAY);
  });

  it("leaves non-verified rows untouched even if they have past expires_at", async () => {
    const deps = buildDeps();
    await runExpirySweep(deps);

    const pendingReview = await db
      .select()
      .from(documents)
      .where(eq(documents.id, fixture.docPendingReviewExpiringId))
      .then((rows) => rows[0]);
    expect(pendingReview?.status).toBe("pending_review");
  });

  it("leaves rows with null expires_at untouched", async () => {
    const deps = buildDeps();
    await runExpirySweep(deps);

    const noExpiry = await db
      .select()
      .from(documents)
      .where(eq(documents.id, fixture.docNoExpiryId))
      .then((rows) => rows[0]);
    expect(noExpiry?.status).toBe("verified");
  });
});

describe("runExpirySweep - upcoming-expiry reminders", () => {
  it("sends one email for each row in the 30-day window", async () => {
    const sendEmail = vi.fn<(args: SendEmailArgs) => Promise<SendEmailResult>>(
      async () => ({ ok: true, id: "msg_test" }),
    );
    const deps = buildDeps({ sendEmail });

    const result = await runExpirySweep(deps);

    // docInWindowId (5 days) + docNoEmailId (10 days, but skipped no email).
    // Only docInWindowId hits sendEmail.
    expect(result.remindersAttempted).toBe(1);
    expect(result.remindersSucceeded).toBe(1);
    expect(result.remindersSkippedNoEmail).toBe(1);
    expect(sendEmail).toHaveBeenCalledOnce();

    const [args] = sendEmail.mock.calls[0];
    expect(args.to).toBe("acme@example.test");
    expect(args.subject).toContain("GST Certificate");
    expect(args.subject).toContain("Acme Construction");
    expect(args.html).toContain("gst.pdf");
    expect(args.text).toBeDefined();
  });

  it("skips rows >30 days out", async () => {
    const sendEmail = vi.fn<(args: SendEmailArgs) => Promise<SendEmailResult>>(
      async () => ({ ok: true, id: "msg_test" }),
    );
    await runExpirySweep(buildDeps({ sendEmail }));

    const sentTo = sendEmail.mock.calls.map((c) => c[0].to);
    // docFarFutureId on companyB (build@example.test) should NOT appear.
    expect(sentTo).not.toContain("build@example.test");
  });

  it("does not send reminders for past-expiry rows (those got flipped)", async () => {
    const sendEmail = vi.fn<(args: SendEmailArgs) => Promise<SendEmailResult>>(
      async () => ({ ok: true, id: "msg_test" }),
    );
    await runExpirySweep(buildDeps({ sendEmail }));

    // Only docInWindowId qualifies; past-expiry rows are above the
    // upcoming-window filter.
    expect(sendEmail).toHaveBeenCalledOnce();
  });

  it("skips and counts rows whose company has null contactEmail", async () => {
    const sendEmail = vi.fn<(args: SendEmailArgs) => Promise<SendEmailResult>>(
      async () => ({ ok: true, id: "msg_test" }),
    );
    const result = await runExpirySweep(buildDeps({ sendEmail }));

    expect(result.remindersSkippedNoEmail).toBe(1);
  });

  it("counts failed sends without aborting the sweep", async () => {
    // First call succeeds, second would fail - but we only have one
    // in-window row with a valid email, so simulate a failure on that.
    const sendEmail = vi.fn<(args: SendEmailArgs) => Promise<SendEmailResult>>(
      async () => ({ ok: false, error: "Resend down" }),
    );

    const result = await runExpirySweep(buildDeps({ sendEmail }));

    expect(result.remindersAttempted).toBe(1);
    expect(result.remindersFailed).toBe(1);
    expect(result.remindersSucceeded).toBe(0);
    // Past-expiry flips still happened despite send failures.
    expect(result.expiredCount).toBe(2);
  });
});

describe("runExpirySweep - idempotency", () => {
  it("second run with same today flips nothing further (already expired)", async () => {
    const sendEmail = vi.fn<(args: SendEmailArgs) => Promise<SendEmailResult>>(
      async () => ({ ok: true, id: "msg_test" }),
    );

    const first = await runExpirySweep(buildDeps({ sendEmail }));
    expect(first.expiredCount).toBe(2);

    const second = await runExpirySweep(buildDeps({ sendEmail }));
    expect(second.expiredCount).toBe(0);
  });

  it("second run RE-SENDS reminders (no dedup table yet)", async () => {
    const sendEmail = vi.fn<(args: SendEmailArgs) => Promise<SendEmailResult>>(
      async () => ({ ok: true, id: "msg_test" }),
    );

    await runExpirySweep(buildDeps({ sendEmail }));
    await runExpirySweep(buildDeps({ sendEmail }));

    // 2 runs * 1 in-window email each = 2 sends.
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });
});
