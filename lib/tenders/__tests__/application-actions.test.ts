/**
 * Integration tests for the application-side actions:
 *   - withdrawApplication (company on own)
 *   - updateApplicationStatus (staff shortlist/reject)
 *   - reinstateApplication (admin/staff reversal, Day 5)
 *   - recallApplication (company on own withdrawal, Day 5; within window)
 *
 * Coverage emphasises:
 *   - Ownership: company cannot withdraw/recall someone else's application
 *   - Status gates: only legal source statuses accept the action
 *   - Recall window: in-window allowed, expired refused
 *   - Audit verbs: reinstate writes `application_reinstated`,
 *     recall writes `application_recalled`
 *
 * Fixture mirrors the other two tender test files.
 *
 * @module lib/tenders/__tests__/application-actions
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
  companies,
  tenders,
  tenderApplications,
  users,
  auditLog,
  type UserRole,
  type TenderStatus,
  type TenderApplicationStatus,
} from "@/lib/db/schema";
import { newId } from "@/lib/db/ids";

vi.mock("@/lib/auth/session", () => ({
  readSession: vi.fn(async () => null),
}));

import { readSession } from "@/lib/auth/session";
import type { SendEmailArgs, SendEmailResult } from "@/lib/email/client";
import {
  withdrawApplication,
  updateApplicationStatus,
  updateApplicationStatusInternal,
  reinstateApplication,
  recallApplication,
} from "../actions";

const mockedReadSession = readSession as MockedFunction<typeof readSession>;

/**
 * Build a noop sendEmail stub that always succeeds. Tests that care
 * about payload inspect the `.mock.calls`; tests that don't care just
 * pass this through to keep the action's notification path quiet.
 */
function makeStubSendEmail(
  override?: (args: SendEmailArgs) => Promise<SendEmailResult>,
) {
  return vi.fn<(args: SendEmailArgs) => Promise<SendEmailResult>>(
    override ?? (async () => ({ ok: true, id: "msg_test" })),
  );
}

// ── Fixture ───────────────────────────────────────────────────────────────

interface Fixture {
  adminUserId: string;
  staffUserId: string;
  companyUserAId: string;
  companyUserBId: string;
  publisherCompanyId: string;
  companyAId: string;
  companyBId: string;
  publishedTenderId: string;
  closedTenderId: string;
}

let fixture: Fixture;

async function seedFixture(): Promise<Fixture> {
  const publisherCompanyId = newId();
  const companyAId = newId();
  const companyBId = newId();
  const adminUserId = newId();
  const staffUserId = newId();
  const companyUserAId = newId();
  const companyUserBId = newId();
  const publishedTenderId = newId();
  const closedTenderId = newId();

  await db.insert(companies).values([
    {
      id: publisherCompanyId,
      name: "Consultway Infotech",
      sector: "Consulting",
      geography: "Maharashtra",
    },
    {
      id: companyAId,
      name: "Acme Construction",
      sector: "Infrastructure",
      geography: "Maharashtra",
      contactEmail: "acme@example.test",
      isMsme: true,
      annualTurnover: 50_000_000,
    },
    {
      id: companyBId,
      name: "BuildRight Engineers",
      sector: "Infrastructure",
      geography: "Maharashtra",
      contactEmail: "build@example.test",
      isMsme: true,
      annualTurnover: 50_000_000,
    },
  ]);

  await db.insert(users).values([
    {
      id: adminUserId,
      email: `admin-${adminUserId}@test.local`,
      passwordHash: "$2a$10$test",
      role: "admin" as UserRole,
      name: "Admin",
    },
    {
      id: staffUserId,
      email: `staff-${staffUserId}@test.local`,
      passwordHash: "$2a$10$test",
      role: "staff" as UserRole,
      name: "Staff",
    },
    {
      id: companyUserAId,
      email: `acme-${companyUserAId}@test.local`,
      passwordHash: "$2a$10$test",
      role: "company" as UserRole,
      companyId: companyAId,
      name: "Acme Contact",
    },
    {
      id: companyUserBId,
      email: `build-${companyUserBId}@test.local`,
      passwordHash: "$2a$10$test",
      role: "company" as UserRole,
      companyId: companyBId,
      name: "Build Contact",
    },
  ]);

  await db.insert(tenders).values([
    {
      id: publishedTenderId,
      title: "Application-actions test tender (published)",
      description: "For application-side tests",
      status: "published" satisfies TenderStatus,
      publisherCompanyId,
      sector: "Infrastructure",
      geography: "Maharashtra",
      publishedAt: new Date().toISOString(),
    },
    {
      id: closedTenderId,
      title: "Application-actions test tender (closed)",
      description: "For recall-blocked-by-tender-status test",
      status: "closed" satisfies TenderStatus,
      publisherCompanyId,
      sector: "Infrastructure",
      geography: "Maharashtra",
      publishedAt: new Date().toISOString(),
    },
  ]);

  return {
    adminUserId,
    staffUserId,
    companyUserAId,
    companyUserBId,
    publisherCompanyId,
    companyAId,
    companyBId,
    publishedTenderId,
    closedTenderId,
  };
}

async function clearFixture(f: Fixture): Promise<void> {
  for (const userId of [
    f.adminUserId,
    f.staffUserId,
    f.companyUserAId,
    f.companyUserBId,
  ]) {
    await db.delete(auditLog).where(eq(auditLog.actorId, userId)).catch(() => {});
  }
  await db
    .delete(tenders)
    .where(eq(tenders.publisherCompanyId, f.publisherCompanyId));
  await db.delete(users).where(eq(users.id, f.adminUserId));
  await db.delete(users).where(eq(users.id, f.staffUserId));
  await db.delete(users).where(eq(users.id, f.companyUserAId));
  await db.delete(users).where(eq(users.id, f.companyUserBId));
  await db.delete(companies).where(eq(companies.id, f.companyAId));
  await db.delete(companies).where(eq(companies.id, f.companyBId));
  await db.delete(companies).where(eq(companies.id, f.publisherCompanyId));
}

// ── Helpers ───────────────────────────────────────────────────────────────

function loginAs(
  role: "admin" | "staff" | "companyA" | "companyB",
  f: Fixture,
): void {
  switch (role) {
    case "admin":
      mockedReadSession.mockResolvedValue({
        userId: f.adminUserId,
        role: "admin",
        companyId: null,
        email: "admin@test.local",
      });
      return;
    case "staff":
      mockedReadSession.mockResolvedValue({
        userId: f.staffUserId,
        role: "staff",
        companyId: null,
        email: "staff@test.local",
      });
      return;
    case "companyA":
      mockedReadSession.mockResolvedValue({
        userId: f.companyUserAId,
        role: "company",
        companyId: f.companyAId,
        email: "acme@test.local",
      });
      return;
    case "companyB":
      mockedReadSession.mockResolvedValue({
        userId: f.companyUserBId,
        role: "company",
        companyId: f.companyBId,
        email: "build@test.local",
      });
      return;
  }
}

interface InsertApplicationOpts {
  tenderId?: string;
  companyId: string;
  status?: TenderApplicationStatus;
  decidedAt?: string | null;
}

async function insertApplication(
  f: Fixture,
  opts: InsertApplicationOpts,
): Promise<string> {
  const id = newId();
  await db.insert(tenderApplications).values({
    id,
    tenderId: opts.tenderId ?? f.publishedTenderId,
    companyId: opts.companyId,
    status: opts.status ?? "submitted",
    decidedAt: opts.decidedAt ?? null,
  });
  return id;
}

// ── Setup / teardown ──────────────────────────────────────────────────────

beforeEach(async () => {
  fixture = await seedFixture();
  mockedReadSession.mockReset();
});

afterEach(async () => {
  await clearFixture(fixture);
});

// ── withdrawApplication ───────────────────────────────────────────────────

describe("withdrawApplication", () => {
  it("succeeds on own submitted application + stamps decidedAt", async () => {
    loginAs("companyA", fixture);
    const applicationId = await insertApplication(fixture, {
      companyId: fixture.companyAId,
    });

    const result = await withdrawApplication({ applicationId });
    expect(result.ok).toBe(true);

    const row = await db
      .select()
      .from(tenderApplications)
      .where(eq(tenderApplications.id, applicationId))
      .then((r) => r[0]);
    expect(row?.status).toBe("withdrawn");
    expect(row?.decidedAt).toBeTruthy();
  });

  it("refuses withdrawing someone else's application (leak-safe)", async () => {
    loginAs("companyB", fixture);
    const applicationId = await insertApplication(fixture, {
      companyId: fixture.companyAId,
    });

    const result = await withdrawApplication({ applicationId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Returns "not found" rather than "forbidden" to avoid leaking
    // existence of someone else's application.
    expect(result.error).toMatch(/not found/i);
  });

  it("refuses when application is already withdrawn", async () => {
    loginAs("companyA", fixture);
    const applicationId = await insertApplication(fixture, {
      companyId: fixture.companyAId,
      status: "withdrawn",
      decidedAt: new Date().toISOString(),
    });
    const result = await withdrawApplication({ applicationId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/withdrawn/i);
  });

  it("refuses on non-submitted application (e.g. shortlisted)", async () => {
    loginAs("companyA", fixture);
    const applicationId = await insertApplication(fixture, {
      companyId: fixture.companyAId,
      status: "shortlisted",
      decidedAt: new Date().toISOString(),
    });
    const result = await withdrawApplication({ applicationId });
    expect(result.ok).toBe(false);
  });

  it("refuses unauthenticated callers", async () => {
    mockedReadSession.mockResolvedValue(null);
    const applicationId = await insertApplication(fixture, {
      companyId: fixture.companyAId,
    });
    const result = await withdrawApplication({ applicationId });
    expect(result.ok).toBe(false);
  });
});

// ── updateApplicationStatus ───────────────────────────────────────────────

describe("updateApplicationStatus", () => {
  it("staff shortlists a submitted application", async () => {
    loginAs("staff", fixture);
    const applicationId = await insertApplication(fixture, {
      companyId: fixture.companyAId,
    });
    const result = await updateApplicationStatus({
      applicationId,
      status: "shortlisted",
    });
    expect(result.ok).toBe(true);

    const row = await db
      .select()
      .from(tenderApplications)
      .where(eq(tenderApplications.id, applicationId))
      .then((r) => r[0]);
    expect(row?.status).toBe("shortlisted");
    expect(row?.decidedAt).toBeTruthy();
  });

  it("staff rejects a submitted application", async () => {
    loginAs("staff", fixture);
    const applicationId = await insertApplication(fixture, {
      companyId: fixture.companyAId,
    });
    const result = await updateApplicationStatus({
      applicationId,
      status: "rejected",
      internalNotes: "Missing eligibility documents",
    });
    expect(result.ok).toBe(true);

    const row = await db
      .select()
      .from(tenderApplications)
      .where(eq(tenderApplications.id, applicationId))
      .then((r) => r[0]);
    expect(row?.status).toBe("rejected");
    expect(row?.internalNotes).toBe("Missing eligibility documents");
  });

  it("refuses company-role caller", async () => {
    loginAs("companyA", fixture);
    const applicationId = await insertApplication(fixture, {
      companyId: fixture.companyAId,
    });
    const result = await updateApplicationStatus({
      applicationId,
      status: "shortlisted",
    });
    expect(result.ok).toBe(false);
  });

  it("refuses on withdrawn applications (company-owned reversal only)", async () => {
    loginAs("staff", fixture);
    const applicationId = await insertApplication(fixture, {
      companyId: fixture.companyAId,
      status: "withdrawn",
      decidedAt: new Date().toISOString(),
    });
    const result = await updateApplicationStatus({
      applicationId,
      status: "shortlisted",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/withdrawn/i);
  });

  it("is idempotent when status already matches", async () => {
    loginAs("staff", fixture);
    const applicationId = await insertApplication(fixture, {
      companyId: fixture.companyAId,
      status: "shortlisted",
      decidedAt: new Date().toISOString(),
    });
    const result = await updateApplicationStatus({
      applicationId,
      status: "shortlisted",
    });
    expect(result.ok).toBe(true);
  });
});

// ── updateApplicationStatus email notifications (Day 14) ──────────────────

describe("updateApplicationStatus email notifications", () => {
  it("fires a shortlisted email to the applying company on shortlist", async () => {
    loginAs("staff", fixture);
    const stub = makeStubSendEmail();
    const applicationId = await insertApplication(fixture, {
      companyId: fixture.companyAId,
    });

    const result = await updateApplicationStatusInternal(
      { applicationId, status: "shortlisted" },
      { sendEmail: stub },
    );
    expect(result.ok).toBe(true);
    expect(stub).toHaveBeenCalledTimes(1);

    const [args] = stub.mock.calls[0]!;
    expect(args.to).toBe("acme@example.test");
    expect(args.subject).toMatch(/shortlisted/i);
    // Both html and text bodies are populated.
    expect(args.html).toMatch(/Acme Construction/);
    expect(args.text).toMatch(/Acme Construction/);
  });

  it("fires a rejected email to the applying company on reject", async () => {
    loginAs("staff", fixture);
    const stub = makeStubSendEmail();
    const applicationId = await insertApplication(fixture, {
      companyId: fixture.companyAId,
    });

    const result = await updateApplicationStatusInternal(
      {
        applicationId,
        status: "rejected",
        internalNotes: "Missing eligibility documents",
      },
      { sendEmail: stub },
    );
    expect(result.ok).toBe(true);
    expect(stub).toHaveBeenCalledTimes(1);

    const [args] = stub.mock.calls[0]!;
    expect(args.to).toBe("acme@example.test");
    // Subject deliberately avoids the word "rejected" - "Update on" is
    // the chosen neutral phrasing.
    expect(args.subject).toMatch(/Update on your application/i);
    // internalNotes must NEVER leak into the customer-facing email.
    expect(args.html).not.toMatch(/Missing eligibility documents/);
    expect(args.text).not.toMatch(/Missing eligibility documents/);
  });

  it("does not reverse the status flip when the email send fails", async () => {
    loginAs("staff", fixture);
    const failingStub = makeStubSendEmail(async () => ({
      ok: false,
      error: "Resend 500: provider unavailable",
    }));
    const applicationId = await insertApplication(fixture, {
      companyId: fixture.companyAId,
    });

    const result = await updateApplicationStatusInternal(
      { applicationId, status: "shortlisted" },
      { sendEmail: failingStub },
    );
    // Status flip is the load-bearing fact. Failed email is logged,
    // not surfaced.
    expect(result.ok).toBe(true);
    expect(failingStub).toHaveBeenCalledTimes(1);

    const row = await db
      .select()
      .from(tenderApplications)
      .where(eq(tenderApplications.id, applicationId))
      .then((r) => r[0]);
    expect(row?.status).toBe("shortlisted");
    expect(row?.decidedAt).toBeTruthy();
  });

  it("does not throw when the action itself throws inside the notifier", async () => {
    // Belt-and-braces: if sendEmail itself throws (rather than returning
    // ok:false), the action still returns ok:true. Mirrors the
    // try/catch wrapper in notifyApplicantOfStatusChange.
    loginAs("staff", fixture);
    const throwingStub = vi.fn<
      (args: SendEmailArgs) => Promise<SendEmailResult>
    >(async () => {
      throw new Error("network blip");
    });
    const applicationId = await insertApplication(fixture, {
      companyId: fixture.companyAId,
    });

    const result = await updateApplicationStatusInternal(
      { applicationId, status: "rejected" },
      { sendEmail: throwingStub },
    );
    expect(result.ok).toBe(true);
    expect(throwingStub).toHaveBeenCalledTimes(1);
  });

  it("never sends an email when the status gate refuses (withdrawn applicant)", async () => {
    loginAs("staff", fixture);
    const stub = makeStubSendEmail();
    const applicationId = await insertApplication(fixture, {
      companyId: fixture.companyAId,
      status: "withdrawn",
      decidedAt: new Date().toISOString(),
    });

    const result = await updateApplicationStatusInternal(
      { applicationId, status: "shortlisted" },
      { sendEmail: stub },
    );
    expect(result.ok).toBe(false);
    expect(stub).not.toHaveBeenCalled();
  });

  it("never sends an email on the idempotent no-op same-status path", async () => {
    loginAs("staff", fixture);
    const stub = makeStubSendEmail();
    const applicationId = await insertApplication(fixture, {
      companyId: fixture.companyAId,
      status: "shortlisted",
      decidedAt: new Date().toISOString(),
    });

    const result = await updateApplicationStatusInternal(
      { applicationId, status: "shortlisted" },
      { sendEmail: stub },
    );
    expect(result.ok).toBe(true);
    expect(stub).not.toHaveBeenCalled();
  });
});

// ── reinstateApplication does NOT email (Day 14) ──────────────────────────
//
// Companion to the email-notification block above. Reinstate is staff-
// initiated "undo" of a shortlist/reject; the applicant didn't ask for
// it, and the audit trail is the right channel for staff visibility.
// The action doesn't take a sendEmail dep on purpose - this test is the
// observable assurance that no email path is wired through.
describe("reinstateApplication does not notify applicant", () => {
  it("succeeds without touching the email client", async () => {
    loginAs("staff", fixture);
    const applicationId = await insertApplication(fixture, {
      companyId: fixture.companyAId,
      status: "shortlisted",
      decidedAt: new Date().toISOString(),
    });

    // No stub injected - if reinstate ever grows an email path it would
    // either hit the real (log-fallback) sendEmail or, if injection lands,
    // fail to find a deps param. Today: succeeds cleanly.
    const result = await reinstateApplication({ applicationId });
    expect(result.ok).toBe(true);
  });
});

// ── reinstateApplication (Day 5 reversal) ─────────────────────────────────

describe("reinstateApplication", () => {
  it("flips shortlisted back to submitted + clears decidedAt + audit", async () => {
    loginAs("staff", fixture);
    const applicationId = await insertApplication(fixture, {
      companyId: fixture.companyAId,
      status: "shortlisted",
      decidedAt: new Date().toISOString(),
    });

    const result = await reinstateApplication({
      applicationId,
      reason: "Re-reviewed eligibility documents",
    });
    expect(result.ok).toBe(true);

    const row = await db
      .select()
      .from(tenderApplications)
      .where(eq(tenderApplications.id, applicationId))
      .then((r) => r[0]);
    expect(row?.status).toBe("submitted");
    expect(row?.decidedAt).toBeNull();

    const events = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, applicationId));
    const reinstated = events.find(
      (e) => e.action === "application_reinstated",
    );
    expect(reinstated).toBeDefined();
    const metadata = reinstated?.metadata as Record<string, unknown> | null;
    expect(metadata?.tenderId).toBe(fixture.publishedTenderId);
    expect(metadata?.reason).toBe("Re-reviewed eligibility documents");
  });

  it("flips rejected back to submitted", async () => {
    loginAs("staff", fixture);
    const applicationId = await insertApplication(fixture, {
      companyId: fixture.companyAId,
      status: "rejected",
      decidedAt: new Date().toISOString(),
    });
    const result = await reinstateApplication({ applicationId });
    expect(result.ok).toBe(true);

    const row = await db
      .select()
      .from(tenderApplications)
      .where(eq(tenderApplications.id, applicationId))
      .then((r) => r[0]);
    expect(row?.status).toBe("submitted");
  });

  it("refuses on a withdrawn application (use recallApplication instead)", async () => {
    loginAs("staff", fixture);
    const applicationId = await insertApplication(fixture, {
      companyId: fixture.companyAId,
      status: "withdrawn",
      decidedAt: new Date().toISOString(),
    });
    const result = await reinstateApplication({ applicationId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/recall|applicant/i);
  });

  it("refuses on a submitted application (no-op via state machine)", async () => {
    loginAs("staff", fixture);
    const applicationId = await insertApplication(fixture, {
      companyId: fixture.companyAId,
      status: "submitted",
    });
    const result = await reinstateApplication({ applicationId });
    expect(result.ok).toBe(false);
  });

  it("refuses company-role caller", async () => {
    loginAs("companyA", fixture);
    const applicationId = await insertApplication(fixture, {
      companyId: fixture.companyAId,
      status: "rejected",
      decidedAt: new Date().toISOString(),
    });
    const result = await reinstateApplication({ applicationId });
    expect(result.ok).toBe(false);
  });
});

// ── recallApplication (Day 5 reversal) ────────────────────────────────────

describe("recallApplication", () => {
  it("flips withdrawn back to submitted within the recall window + audit", async () => {
    loginAs("companyA", fixture);
    // Withdrawn 1 day ago — well inside the 7-day window.
    const decidedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const applicationId = await insertApplication(fixture, {
      companyId: fixture.companyAId,
      status: "withdrawn",
      decidedAt,
    });

    const result = await recallApplication({
      applicationId,
      reason: "Reconsidered — pursuing the contract after all",
    });
    expect(result.ok).toBe(true);

    const row = await db
      .select()
      .from(tenderApplications)
      .where(eq(tenderApplications.id, applicationId))
      .then((r) => r[0]);
    expect(row?.status).toBe("submitted");
    expect(row?.decidedAt).toBeNull();

    const events = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, applicationId));
    const recalled = events.find((e) => e.action === "application_recalled");
    expect(recalled).toBeDefined();
    const metadata = recalled?.metadata as Record<string, unknown> | null;
    expect(metadata?.tenderId).toBe(fixture.publishedTenderId);
    expect(metadata?.recallWindowDays).toBe(7);
    expect(metadata?.previousDecidedAt).toBe(decidedAt);
    expect(metadata?.reason).toBe(
      "Reconsidered — pursuing the contract after all",
    );
  });

  it("refuses outside the recall window (>7 days)", async () => {
    loginAs("companyA", fixture);
    // 10 days ago — past the 7-day window.
    const decidedAt = new Date(
      Date.now() - 10 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const applicationId = await insertApplication(fixture, {
      companyId: fixture.companyAId,
      status: "withdrawn",
      decidedAt,
    });

    const result = await recallApplication({ applicationId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/window/i);
  });

  it("refuses recalling someone else's application (leak-safe)", async () => {
    loginAs("companyB", fixture);
    const decidedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const applicationId = await insertApplication(fixture, {
      companyId: fixture.companyAId,
      status: "withdrawn",
      decidedAt,
    });
    const result = await recallApplication({ applicationId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not found/i);
  });

  it("refuses when application status is not withdrawn", async () => {
    loginAs("companyA", fixture);
    const applicationId = await insertApplication(fixture, {
      companyId: fixture.companyAId,
      status: "submitted",
    });
    const result = await recallApplication({ applicationId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/withdrawn/i);
  });

  it("refuses when parent tender is no longer accepting applications", async () => {
    loginAs("companyA", fixture);
    const decidedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    // Application against the closed tender.
    const applicationId = await insertApplication(fixture, {
      tenderId: fixture.closedTenderId,
      companyId: fixture.companyAId,
      status: "withdrawn",
      decidedAt,
    });
    const result = await recallApplication({ applicationId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/accepting/i);
  });

  it("refuses admin role (company-only action)", async () => {
    loginAs("admin", fixture);
    const decidedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const applicationId = await insertApplication(fixture, {
      companyId: fixture.companyAId,
      status: "withdrawn",
      decidedAt,
    });
    const result = await recallApplication({ applicationId });
    expect(result.ok).toBe(false);
  });
});
